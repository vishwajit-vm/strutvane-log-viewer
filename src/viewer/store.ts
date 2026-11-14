/**
 * Read access to the log directory for the viewer: list files, page through records newest first,
 * stream a day for download, and read appended bytes for the live tail.
 *
 * Safety rules:
 *
 * - **Only Strutvane log files are read.** Names come from the directory listing and must match
 *   `LOG_FILE_PATTERN`; a client-supplied name is never joined into a path unchecked, so path
 *   traversal (`../../etc/passwd`) is impossible.
 * - **Both formats are read** (`line` and `json`, even mixed in one directory) through
 *   `parseLogLine`.
 * - **Every record is re-sanitised before it leaves the server,** in case a file was written by
 *   something other than this logger (defence in depth). Searches match the sanitised text, so a
 *   search can't be used to guess a secret character by character.
 * - **Work per request is bounded** (`maxScanLines`), so a search can't pin the CPU, and files are
 *   read backwards in fixed-size chunks from the cursor, never whole, so memory stays flat however
 *   large a file grows. A line longer than any record this logger writes is skipped unread.
 * - **Partial last lines are ignored** (a writer may be mid-append).
 *
 * @module
 */
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { compareLogFiles, DEFAULT_BASES, listLogFiles, parseLogFileName } from '../files.ts'
import { parseLogLine } from '../format/parse.ts'
import {
  describeFiles,
  type FileLine,
  type LogFileInfo,
  readLinesBackward,
  readRange,
} from '../read.ts'

export type { FileLine, LogFileInfo }
export { describeFiles, readLinesBackward, readRange }

import { createSanitizer, type Sanitizer } from '../redact.ts'
import { escapeLineSeparators } from '../serialize.ts'
import {
  dayRange,
  matchesQuery,
  type RecordFilter,
  type RecordQuery,
  type ViewerRecord,
} from './filters.ts'

/** Where to continue paging: the lines of `file` that start before byte offset `before`. */
export interface Cursor {
  readonly file: string
  readonly before: number
}

/** Encode a cursor as an opaque URL-safe string. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.file, cursor.before])).toString('base64url')
}

/** Decode a cursor, or `undefined` if it is malformed or names something that isn't a log file. */
export function decodeCursor(value: string): Cursor | undefined {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
    const [file, before] = parsed as [unknown, unknown]
    if (typeof file !== 'string' || parseLogFileName(file) === undefined) return undefined
    if (typeof before !== 'number' || !Number.isInteger(before) || before < 0) return undefined
    return { file, before }
  } catch {
    return undefined
  }
}

/**
 * Parse one log line, in either format (`line` or `json`), into a record, or `undefined` if it
 * isn't one. A directory may mix both formats (after a `LOG_FORMAT` change).
 */
export function parseLine(line: string): ViewerRecord | undefined {
  return parseLogLine(line)
}

/** A record re-sanitised for output, with its one-line JSON form. */
export interface CleanRecord {
  readonly record: ViewerRecord
  readonly json: string
}

/** Parse and re-sanitise a line. */
export function cleanLine(line: string, sanitize: Sanitizer): CleanRecord | undefined {
  const parsed = parseLine(line)
  if (!parsed) return undefined
  const record = sanitize(parsed) as ViewerRecord
  return { record, json: escapeLineSeparators(JSON.stringify(record)) }
}

/** Shared default sanitizer for viewer output. */
export const viewerSanitizer: Sanitizer = createSanitizer()

/** Does a cleaned record pass the query and the caller's scope? A throwing scope hides the record. */
export function accept(
  clean: CleanRecord,
  query: RecordQuery,
  scope: RecordFilter | undefined,
): boolean {
  if (!matchesQuery(clean.record, clean.json, query)) return false
  if (!scope) return true
  try {
    return scope(clean.record) === true
  } catch {
    return false
  }
}

/** Options for {@link readPage}. */
export interface PageOptions {
  readonly dir: string
  /** File base names to read. Default: `strutvane`. */
  readonly bases?: ReadonlySet<string>
  readonly query: RecordQuery
  readonly scope?: RecordFilter | undefined
  readonly limit: number
  readonly cursor?: Cursor | undefined
  /** Stop after examining this many lines and return a cursor. Default: 100,000. */
  readonly maxScanLines?: number
  readonly sanitize?: Sanitizer
}

/** One page of records, newest first. */
export interface Page {
  readonly records: ViewerRecord[]
  /** Present when more records may follow. */
  readonly nextCursor?: string
  /** Lines examined for this page. */
  readonly scanned: number
}

/** Read one page of matching records, newest first. */
export async function readPage(options: PageOptions): Promise<Page> {
  const { dir, query, scope, limit, cursor } = options
  const maxScan = options.maxScanLines ?? 100_000
  const sanitize = options.sanitize ?? viewerSanitizer
  const range = dayRange(query)
  const files = (await listLogFiles(dir, options.bases ?? DEFAULT_BASES))
    .reverse()
    .filter((name) => {
      const day = parseLogFileName(name)?.day
      // A single file spans days, so the range can't skip it.
      if (day === undefined) return cursor === undefined || compareLogFiles(name, cursor.file) <= 0
      if (range.from !== undefined && day < range.from) return false
      if (range.to !== undefined && day > range.to) return false
      // Continue at the cursor's file, or the next older one if it was deleted.
      return cursor === undefined || compareLogFiles(name, cursor.file) <= 0
    })

  const records: ViewerRecord[] = []
  let scanned = 0
  for (const name of files) {
    const end = cursor && name === cursor.file ? cursor.before : undefined
    const lines = readLinesBackward(join(dir, name), end)
    // Start of the line examined last: everything before it is still to do.
    let resumeAt = end
    try {
      for await (const line of lines) {
        if (scanned >= maxScan) {
          const before = resumeAt ?? line.start + Buffer.byteLength(line.text) + 1
          return { records, scanned, nextCursor: encodeCursor({ file: name, before }) }
        }
        scanned++
        resumeAt = line.start
        const clean = cleanLine(line.text, sanitize)
        if (!clean || !accept(clean, query, scope)) continue
        records.push(clean.record)
        if (records.length >= limit) {
          const more = line.start > 0 || name !== files[files.length - 1]
          return more
            ? { records, scanned, nextCursor: encodeCursor({ file: name, before: line.start }) }
            : { records, scanned }
        }
      }
    } finally {
      await lines.return(undefined)
    }
  }
  return { records, scanned }
}

/**
 * Stream the complete lines of every file for `day`, oldest file first. Single files span days, so
 * only their lines whose timestamp falls on `day` are included.
 */
export async function* readDayLines(
  dir: string,
  day: string,
  bases: ReadonlySet<string> = DEFAULT_BASES,
): AsyncGenerator<string> {
  for (const name of await listLogFiles(dir, bases)) {
    const parsed = parseLogFileName(name)
    if (!parsed || (parsed.day !== undefined && parsed.day !== day)) continue
    const stream = createReadStream(join(dir, name), { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
    try {
      for await (const line of lines) {
        if (!line) continue
        if (parsed.day === undefined && !onDay(line, day)) continue
        yield line
      }
    } catch {
      // Deleted while reading: move on.
    } finally {
      lines.close()
      stream.destroy()
    }
  }
}

function onDay(line: string, day: string): boolean {
  const time = parseLogLine(line)?.time
  return typeof time === 'string' && time.startsWith(day)
}
