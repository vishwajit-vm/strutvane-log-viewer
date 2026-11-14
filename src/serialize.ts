/**
 * Record → exactly ONE line of NDJSON. Never throws.
 *
 * - **Escaping:** `JSON.stringify` escapes CR, LF and every control character, including ESC (ANSI
 *   colour codes) and NUL. A message can therefore never forge extra log lines or colour a
 *   terminal, which makes it safe against log injection.
 * - **U+2028 / U+2029** are not escaped by `JSON.stringify`, and some viewers treat them as line
 *   breaks, so they are escaped explicitly.
 * - **Size cap:** a record larger than `maxBytes` is replaced by a small, well-formed marker record.
 *   One huge log call can never blow up memory, the disk or the viewer.
 *
 * @module
 */

/** U+2028 / U+2029, built from char codes so this file never contains a literal line separator. */
export const LINE_SEPARATOR: string = String.fromCharCode(0x2028)
export const PARAGRAPH_SEPARATOR: string = String.fromCharCode(0x2029)
const BACKSLASH = String.fromCharCode(0x5c)

/** Default maximum size of one record, in bytes (RFC-0004 §6). */
export const DEFAULT_MAX_RECORD_BYTES: number = 32 * 1024

function safeSlice(msg: unknown): string {
  return typeof msg === 'string' ? msg.slice(0, 1024) : '[non-string message]'
}

// Built from escape sequences in a string, never literal characters (CLAUDE.md "Gotchas").
const UNSAFE_CLASS = '[\\u007f-\\u009f\\u2028\\u2029]'
const UNSAFE_TEST = new RegExp(UNSAFE_CLASS)
const UNSAFE_ALL = new RegExp(UNSAFE_CLASS, 'g')

/**
 * `\uXXXX` for one UTF-16 code unit: the escape both formats use for characters that must never
 * reach a file or a terminal raw.
 *
 * @example
 * unicodeEscape(String.fromCharCode(0x1b)) // the six characters \u001b
 */
export function unicodeEscape(char: string): string {
  return `${BACKSLASH}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
}

/**
 * Escape U+2028/U+2029, DEL and the C1 control characters (U+007F to U+009F) inside an
 * already-serialised JSON string. `JSON.stringify` leaves them raw, but some viewers treat the
 * first two as line breaks, and U+009B is a one-character ANSI "CSI" in terminals that honour
 * 8-bit controls. They can only occur inside JSON string values (JSON's own syntax is ASCII), so
 * the result is still valid JSON that parses back to the same value.
 *
 * @example
 * escapeLineSeparators(JSON.stringify({ msg: `a${LINE_SEPARATOR}` })) // the separator becomes a 6-character escape
 */
export function escapeLineSeparators(json: string): string {
  if (!UNSAFE_TEST.test(json)) return json
  return json.replace(UNSAFE_ALL, unicodeEscape)
}

/** What the serialiser needs to know about a record (the rest is serialised as-is). */
export interface SerializableRecord {
  readonly time?: unknown
  readonly level?: unknown
  readonly msg?: unknown
  readonly [key: string]: unknown
}

/**
 * Serialise a (sanitised) record to one NDJSON line, including the trailing `\n`.
 *
 * @param record a JSON-safe object (output of the sanitiser)
 * @param maxBytes the size cap; larger records become a `truncated: true` marker
 */
export function serializeRecord(
  record: SerializableRecord,
  maxBytes: number = DEFAULT_MAX_RECORD_BYTES,
): string {
  let json: string
  try {
    json = JSON.stringify(record)
  } catch (error) {
    json = JSON.stringify({
      time: record.time,
      level: record.level,
      msg: safeSlice(record.msg),
      fields: { serializationError: error instanceof Error ? error.message : 'unknown' },
    })
  }
  json = escapeLineSeparators(json)
  // Byte length only matters near the limit: JSON is at most 3 bytes per UTF-16 unit.
  if (json.length * 3 > maxBytes) {
    const bytes = Buffer.byteLength(json)
    if (bytes > maxBytes) {
      json = escapeLineSeparators(
        JSON.stringify({
          time: record.time,
          level: record.level,
          msg: safeSlice(record.msg),
          fields: { truncated: true, originalBytes: bytes },
        }),
      )
    }
  }
  return `${json}\n`
}
