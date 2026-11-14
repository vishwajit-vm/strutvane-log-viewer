/**
 * Choosing a file/console format (`LOG_FORMAT`, ADR-0022): `line` (readable, the default) or
 * `json` (NDJSON, for log shippers). Both write exactly one line per record and share the same
 * size cap and escaping guarantees.
 *
 * @module
 */
import { type SerializableRecord, serializeRecord } from '../serialize.ts'
import { envLabel, formatLine } from './line.ts'

/** The formats a channel can write. */
export const LOG_FORMATS = ['line', 'json'] as const

/** `line` (Laravel-style, readable) or `json` (one JSON object per line). */
export type LogFormat = (typeof LOG_FORMATS)[number]

/**
 * Turns one sanitised record into exactly one line (with its `\n`). Never throws.
 *
 * @param record the sanitiser's output
 * @param maxBytes the size cap for the line
 */
export type Formatter = (record: SerializableRecord, maxBytes: number) => string

/** Is `value` one of the supported formats? */
export function isLogFormat(value: unknown): value is LogFormat {
  return value === 'line' || value === 'json'
}

/**
 * Create the formatter for a format.
 *
 * @param options.env the `APP_ENV` shown in `line` headers (`local.ERROR`); default `production`
 *
 * @example
 * const format = createFormatter('line', { env: 'local' })
 * format({ time: '2026-11-15T10:22:01.123Z', level: 'info', msg: 'Hi' }, 32_768)
 * // '[2026-11-15 10:22:01.123] local.INFO: Hi {}\n'
 */
export function createFormatter(format: LogFormat, options: { env?: string } = {}): Formatter {
  if (format === 'json') return serializeRecord
  const env = envLabel(options.env)
  return (record, maxBytes) => formatLine(record, env, maxBytes)
}
