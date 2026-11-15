/**
 * Read one log line back into a record, whichever format wrote it. The viewer, its live tail and
 * the `log:tail` command all use this, so a directory that mixes `line` and `json` files (for
 * example after changing `LOG_FORMAT`) reads as one stream.
 *
 * - A line starting with `{` is a JSON record (NDJSON).
 * - A line starting with `[YYYY-MM-DD HH:mm:ss.SSS] env.LEVEL: ` is a `line` record. The context
 *   starts at the first ` {` (the writer escapes that sequence in messages, so the split is
 *   exact), and the reserved keys (`requestId`, `traceId`, `tenantId`, `actorId`, `err`) go back to
 *   the top level, as in a JSON record.
 * - Anything else is not a record (`undefined`): foreign files and torn lines are skipped.
 * - Level aliases (`warn`, `fatal`, `trace`) found in older JSON records read as their canonical
 *   level, so filters see one vocabulary.
 *
 * The parser never throws, and its cost is linear in the line length (no backtracking search for
 * the context), so a hostile line can't slow the viewer down.
 *
 * @module
 */
import { toLevel } from '../levels.ts'
import { setOwn } from '../own.ts'
import { LINE_RESERVED_KEYS, unescapeMessage } from './line.ts'

/** A parsed record. Unknown keys are kept; nothing is trusted to have a particular type. */
export interface ParsedRecord {
  readonly time?: unknown
  readonly level?: unknown
  readonly msg?: unknown
  readonly env?: unknown
  readonly requestId?: unknown
  readonly traceId?: unknown
  readonly tenantId?: unknown
  readonly actorId?: unknown
  readonly fields?: unknown
  readonly err?: unknown
  readonly [key: string]: unknown
}

const HEADER =
  /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\] ([A-Za-z0-9_-]{1,32})\.([A-Za-z]{4,9}): /
const RESERVED: ReadonlySet<string> = new Set(LINE_RESERVED_KEYS)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a JSON line into a record, normalising a level alias. */
function parseJsonLine(line: string): ParsedRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(value)) return undefined
  const level = value['level']
  const canonical = toLevel(level)
  if (canonical !== undefined && canonical !== level) return { ...value, level: canonical }
  return value
}

/** Parse a `line`-format line. */
function parseTextLine(line: string): ParsedRecord | undefined {
  const head = HEADER.exec(line)
  if (!head) return undefined
  const [prefix, day, clock, env, label] = head
  const rest = line.slice(prefix.length)
  const split = rest.indexOf(' {')
  let msgText = rest
  let ctx: Record<string, unknown> = {}
  if (split !== -1) {
    try {
      const parsed: unknown = JSON.parse(rest.slice(split + 1))
      if (isObject(parsed)) {
        ctx = parsed
        msgText = rest.slice(0, split)
      }
    } catch {
      // Not our context object (a hand-written line): keep the whole rest as the message.
    }
  }
  const record: Record<string, unknown> = {
    time: `${day}T${clock}Z`,
    level: toLevel(label) ?? (label ?? '').toLowerCase(),
    msg: unescapeMessage(msgText),
    env,
  }
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(ctx)) {
    if (RESERVED.has(key)) record[key] = value
    else if (key.startsWith('fields.') && RESERVED.has(key.slice(7))) fields[key.slice(7)] = value
    else setOwn(fields, key, value)
  }
  if (Object.keys(fields).length > 0) record['fields'] = fields
  return record
}

/**
 * Parse one log line written in either format, or return `undefined` if it isn't a record.
 *
 * @example
 * parseLogLine('[2026-11-15 10:22:01.123] local.ERROR: Payment failed {"invoice":42}')
 * // { time: '2026-11-15T10:22:01.123Z', level: 'error', msg: 'Payment failed', env: 'local',
 * //   fields: { invoice: 42 } }
 * parseLogLine('{"time":"…","level":"warn","msg":"x"}')?.level // 'warning'
 */
export function parseLogLine(line: string): ParsedRecord | undefined {
  const first = line.charCodeAt(0)
  if (first === 0x7b) return parseJsonLine(line) // {
  if (first === 0x5b) return parseTextLine(line) // [
  return undefined
}
