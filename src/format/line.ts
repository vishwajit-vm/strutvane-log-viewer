/**
 * The `line` format (ADR-0022): readable like Laravel's log files, and still exactly one record
 * per line.
 *
 * ```
 * [2026-11-15 10:22:01.123] local.ERROR: Payment failed {"invoice":42,"requestId":"…"}
 * ```
 *
 * - **Timestamp** in UTC with milliseconds (files are split by UTC day, so the two always agree).
 * - **`<env>.<LEVEL>`**: `APP_ENV` and the canonical level in capitals, as in Laravel.
 * - **The message** is escaped so it can never break the line or the parse: backslash, CR, LF, tab,
 *   every other C0/C1 control character (ANSI colour codes start with ESC, U+001B), DEL and
 *   U+2028/U+2029 become escape sequences, and a space followed by `{` becomes ` \{`. That last rule
 *   is what makes the line unambiguous: the first ` {` on the line always starts the context.
 * - **The context** is one compact JSON object at the end (always present, `{}` when empty, like
 *   Laravel's `[]`): the record's fields plus `requestId`, `traceId`, `tenantId`, `actorId` and
 *   `err`. A field whose name collides with one of those is written as `fields.<name>`, so nothing
 *   is lost or overwritten.
 * - **Size cap:** a line over `maxBytes` becomes a short marker line with
 *   `{"truncated":true,"originalBytes":N}`, the same rule as the JSON format.
 *
 * @module
 */
import { type Level, toLevel } from '../levels.ts'
import { setOwn } from '../own.ts'
import { escapeLineSeparators, type SerializableRecord, unicodeEscape } from '../serialize.ts'

/** Keys lifted out of `fields` into the context object (and back again by the parser). */
export const LINE_RESERVED_KEYS: readonly string[] = Object.freeze([
  'requestId',
  'traceId',
  'tenantId',
  'actorId',
  'err',
])

const RESERVED: ReadonlySet<string> = new Set(LINE_RESERVED_KEYS)
const BACKSLASH = String.fromCharCode(0x5c)
// Backslash, C0 controls, DEL, C1 controls, U+2028/U+2029 (written as escapes, see CLAUDE.md),
// or a space before `{`. Matching control characters is the point of this pattern.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters to escape
const NEEDS_ESCAPE = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]| \{/g
const NAMED_ESCAPES: Readonly<Record<string, string>> = { '\n': 'n', '\r': 'r', '\t': 't' }

/**
 * Escape a message for the line format (see the module notes). The result contains no line
 * break, no control character and no ` {`.
 *
 * @example
 * escapeMessage('a\nb {c}') // a\nb \{c}   (with a literal backslash before n and {)
 */
export function escapeMessage(text: string): string {
  return text.replace(NEEDS_ESCAPE, (match) => {
    if (match.endsWith('{')) return `${match.slice(0, -1)}${BACKSLASH}{`
    if (match === BACKSLASH) return `${BACKSLASH}${BACKSLASH}`
    const named = NAMED_ESCAPES[match]
    return named === undefined ? unicodeEscape(match) : `${BACKSLASH}${named}`
  })
}

const UNESCAPE = /\\(\\|n|r|t|\{|u[0-9a-fA-F]{4})/g

/**
 * Reverse {@link escapeMessage}. Unknown escape sequences are left as they are, so a hand-written
 * line never fails to parse.
 *
 * @example
 * unescapeMessage(escapeMessage('a\nb {c}')) === 'a\nb {c}' // true
 */
export function unescapeMessage(text: string): string {
  if (!text.includes(BACKSLASH)) return text
  return text.replace(UNESCAPE, (_, code: string) => {
    if (code === 'n') return '\n'
    if (code === 'r') return '\r'
    if (code === 't') return '\t'
    if (code.startsWith('u')) return String.fromCharCode(Number.parseInt(code.slice(1), 16))
    return code // '\\' or '{'
  })
}

/**
 * Make `APP_ENV` safe to print in the header: letters, digits, `_` and `-` only, at most 32
 * characters, `production` when empty. The header must stay parseable whatever the environment
 * says.
 *
 * @example
 * envLabel('staging eu') // 'staging_eu'
 */
export function envLabel(env: string | undefined): string {
  const cleaned = (env ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 32)
  return cleaned === '' ? 'production' : cleaned
}

const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}\.\d{3})Z$/

/** `2026-11-15T10:22:01.123Z` → `2026-11-15 10:22:01.123` (any other value: from epoch 0). */
function stamp(time: unknown): string {
  const match = typeof time === 'string' ? ISO.exec(time) : null
  if (match?.[1] && match[2]) return `${match[1]} ${match[2]}`
  const ms = typeof time === 'string' ? Date.parse(time) : Number.NaN
  const iso = new Date(Number.isFinite(ms) ? ms : 0).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
}

/** The context object written at the end of the line. */
function contextOf(record: SerializableRecord): Record<string, unknown> {
  const ctx: Record<string, unknown> = {}
  const fields = record['fields']
  if (typeof fields === 'object' && fields !== null && !Array.isArray(fields)) {
    for (const [key, value] of Object.entries(fields)) {
      setOwn(ctx, RESERVED.has(key) ? `fields.${key}` : key, value)
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'time' || key === 'level' || key === 'msg' || key === 'fields') continue
    if (value !== undefined) ctx[key] = value
  }
  return ctx
}

function levelLabel(level: unknown): string {
  const canonical: Level = toLevel(level) ?? 'info'
  return canonical.toUpperCase()
}

/**
 * Format one sanitised record as a line, including the trailing `\n`. Never throws.
 *
 * @param record a JSON-safe record (the sanitiser's output)
 * @param env the environment label (pass it through {@link envLabel})
 * @param maxBytes the size cap; a longer line becomes a truncation marker
 *
 * @example
 * formatLine({ time: '2026-11-15T10:22:01.123Z', level: 'error', msg: 'Payment failed',
 *   fields: { invoice: 42 } }, 'local', 32_768)
 * // '[2026-11-15 10:22:01.123] local.ERROR: Payment failed {"invoice":42}\n'
 */
export function formatLine(record: SerializableRecord, env: string, maxBytes: number): string {
  const head = `[${stamp(record.time)}] ${env}.${levelLabel(record.level)}: `
  const msg = typeof record.msg === 'string' ? record.msg : String(record.msg ?? '')
  let ctx: string
  try {
    ctx = escapeLineSeparators(JSON.stringify(contextOf(record)))
  } catch (error) {
    ctx = JSON.stringify({
      serializationError: error instanceof Error ? error.message : 'unknown',
    })
  }
  const line = `${head}${escapeMessage(msg)} ${ctx}\n`
  // Byte length only matters near the limit: a UTF-16 unit is at most 3 bytes.
  if (line.length * 3 <= maxBytes) return line
  const bytes = Buffer.byteLength(line)
  if (bytes <= maxBytes) return line
  const marker = JSON.stringify({ truncated: true, originalBytes: bytes })
  return `${head}${escapeMessage(msg.slice(0, 1024))} ${marker}\n`
}
