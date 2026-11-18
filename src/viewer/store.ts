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
 * - **Processes are merged by time** (ADR-0022 §6): within a day, the main process's and every
 *   worker's files are read side by side and the newest record wins, so a page is in true time
 *   order across processes. The opaque cursor remembers where each process stopped.
 *
 * @module
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  compareLogFiles,
  createSanitizer,
  DEFAULT_BASES,
  describeFiles,
  escapeLineSeparators,
  type FileLine,
  isDayKey,
  type LogFileInfo,
  type LogFileName,
  listLogFiles,
  parseLogFileName,
  parseLogLine,
  readLinesBackward,
  readRange,
  type Sanitizer,
  streamKey,
} from '@strutvane/framework/log'
import {
  dayRange,
  matchesQuery,
  type RecordFilter,
  type RecordQuery,
  type ViewerRecord,
} from './filters.ts'

export type { FileLine, LogFileInfo }
export { describeFiles, readLinesBackward, readRange }

/**
 * Where to continue paging. Records are read one group at a time, newest group first (each UTC
 * day, then the `single` files, which span days), and inside a group every writer stream (the
 * main process and each worker, ADR-0015) is merged by timestamp. The cursor names the group and,
 * for each stream that still has records, the file and byte offset to continue at: the lines of
 * `file` that start before `before`. A stream of that group the cursor doesn't name is done (or
 * started after the page was read, so it only holds newer records).
 */
export interface Cursor {
  /** `YYYY-MM-DD` for daily files, `single` for single files. */
  readonly group: string
  /** `[file, before]` for each stream of the group that still has records. */
  readonly positions: ReadonlyArray<readonly [file: string, before: number]>
}

const CURSOR_VERSION = 1
/** Bounds for a decoded cursor: enough for any real directory, small enough to parse cheaply. */
const MAX_CURSOR_CHARS = 16_384
const MAX_CURSOR_POSITIONS = 512
const SINGLE_GROUP = 'single'

/** The group a log file belongs to: its day, or `single`. */
function groupOf(name: LogFileName): string {
  return name.day ?? SINGLE_GROUP
}

/** Encode a cursor as an opaque URL-safe string. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, cursor.group, cursor.positions])).toString(
    'base64url',
  )
}

/**
 * Decode a cursor, or `undefined` if it is malformed: wrong shape or version, a group that is
 * neither a day nor `single`, a name that isn't a log file of that group, two positions for one
 * stream, or a negative or fractional offset.
 */
export function decodeCursor(value: string): Cursor | undefined {
  if (value.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== CURSOR_VERSION)
      return undefined
    const [, group, list] = parsed as [unknown, unknown, unknown]
    if (typeof group !== 'string' || (group !== SINGLE_GROUP && !isDayKey(group))) return undefined
    if (!Array.isArray(list) || list.length > MAX_CURSOR_POSITIONS) return undefined
    const positions: Array<readonly [string, number]> = []
    const streams = new Set<string>()
    for (const item of list) {
      if (!Array.isArray(item) || item.length !== 2) return undefined
      const [file, before] = item as [unknown, unknown]
      if (typeof file !== 'string') return undefined
      const name = parseLogFileName(file)
      if (name === undefined || groupOf(name) !== group) return undefined
      if (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0)
        return undefined
      const stream = streamKey(name)
      if (streams.has(stream)) return undefined
      streams.add(stream)
      positions.push([file, before])
    }
    return { group, positions }
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

/**
 * One writer stream inside a group: its files newest first, read backwards one line at a time,
 * with the next record ready (`head`) so streams can be merged by time.
 */
interface StreamReader {
  readonly dir: string
  /** The stream's files in this group, newest first. */
  readonly files: readonly string[]
  /** Index of the file being read. */
  index: number
  /** Read the current file only below this offset (from the cursor); `undefined`: all of it. */
  end: number | undefined
  lines: AsyncGenerator<FileLine> | undefined
  /** The next record, read but not yet consumed. */
  head: { readonly line: FileLine; readonly clean: CleanRecord; readonly time: string } | undefined
  /** Offset in the current file below which nothing is consumed yet; `undefined`: nothing read. */
  resume: number | undefined
  done: boolean
}

/** Byte offset just after a line (past its newline): reading below it yields that line again. */
const after = (line: FileLine): number => line.end + 1

/** Close a reader's open file. */
async function closeReader(r: StreamReader): Promise<void> {
  const lines = r.lines
  r.lines = undefined
  await lines?.return(undefined)
}

/**
 * The work budget of one page. `progress` turns true once the page has consumed something (a
 * record, or an unparseable line it skipped): only then may the budget stop the page. Before that,
 * every stream must be primed with its next record so the merge picks the true newest one, even
 * when there are more streams than the budget allows lines; otherwise a small budget would
 * re-read the same heads on every page and never move on.
 */
interface Budget {
  scanned: number
  readonly max: number
  progress: boolean
}

/**
 * Advance a reader to its next parseable record (unparseable lines are skipped). Every line read
 * counts against the budget; returns `false` when the budget ran out before a record was found.
 */
async function fill(r: StreamReader, sanitize: Sanitizer, budget: Budget): Promise<boolean> {
  while (!r.done && r.head === undefined) {
    if (budget.scanned >= budget.max && budget.progress) return false
    const file = r.files[r.index]
    if (file === undefined) {
      r.done = true
      break
    }
    r.lines ??= readLinesBackward(join(r.dir, file), r.end)
    const next = await r.lines.next()
    if (next.done) {
      await closeReader(r)
      r.index++
      r.end = undefined
      r.resume = undefined
      continue
    }
    budget.scanned++
    const clean = cleanLine(next.value.text, sanitize)
    if (clean === undefined) {
      r.resume = next.value.start
      budget.progress = true
      continue
    }
    const time = typeof clean.record.time === 'string' ? clean.record.time : ''
    r.head = { line: next.value, clean, time }
  }
  return true
}

/** The reader whose next record is the newest (ties: the later file, then the first reader). */
function newest(readers: readonly StreamReader[]): StreamReader | undefined {
  let best: StreamReader | undefined
  for (const r of readers) {
    if (!r.head) continue
    if (!best?.head) {
      best = r
      continue
    }
    if (r.head.time > best.head.time) best = r
    else if (r.head.time === best.head.time) {
      const a = r.files[r.index] ?? ''
      const b = best.files[best.index] ?? ''
      if (compareLogFiles(a, b) > 0) best = r
    }
  }
  return best
}

/** Where a reader continues: its current file and the offset below which nothing is consumed. */
async function positionOf(r: StreamReader): Promise<readonly [string, number] | undefined> {
  if (r.done) return undefined
  const file = r.files[r.index]
  if (file === undefined) return undefined
  if (r.head) return [file, after(r.head.line)]
  if (r.resume !== undefined) return [file, r.resume]
  if (r.end !== undefined) return [file, r.end]
  // Not opened yet: everything it holds now (later appends are newer than this page).
  try {
    return [file, (await stat(join(r.dir, file))).size]
  } catch {
    return [file, 0]
  }
}

/**
 * Read one page of matching records, newest first, merged across every writer stream by
 * timestamp (ADR-0022 §6): the main process and each worker write their own files, and a page
 * shows their records interleaved in time order, not one process after another.
 *
 * Groups are read newest first (each UTC day, then the `single` files). Inside a group, each
 * stream's files are read backwards from the newest and the newest head record wins, so the
 * order is exact whenever each stream's own records are in time order (they are: one process
 * appends them in order).
 */
export async function readPage(options: PageOptions): Promise<Page> {
  const { dir, query, scope, limit, cursor } = options
  const sanitize = options.sanitize ?? viewerSanitizer
  const budget: Budget = { scanned: 0, max: options.maxScanLines ?? 100_000, progress: false }
  const range = dayRange(query)

  // group → stream → files (newest first)
  const groups = new Map<string, Map<string, string[]>>()
  for (const name of await listLogFiles(dir, options.bases ?? DEFAULT_BASES)) {
    const parsed = parseLogFileName(name)
    if (!parsed) continue
    const day = parsed.day
    if (day !== undefined) {
      if (range.from !== undefined && day < range.from) continue
      if (range.to !== undefined && day > range.to) continue
    }
    const group = groupOf(parsed)
    let streams = groups.get(group)
    if (!streams) {
      streams = new Map()
      groups.set(group, streams)
    }
    const key = streamKey(parsed)
    streams.set(key, [name, ...(streams.get(key) ?? [])]) // listed oldest first → newest first
  }
  // Newest group first: days descending, then the single files.
  const rank = (g: string): string => (g === SINGLE_GROUP ? '' : g)
  let order = [...groups.keys()].sort((a, b) =>
    rank(a) < rank(b) ? 1 : rank(a) > rank(b) ? -1 : 0,
  )
  if (cursor) order = order.filter((g) => rank(g) <= rank(cursor.group))

  const records: ViewerRecord[] = []
  for (const [gi, group] of order.entries()) {
    const resumeHere = cursor !== undefined && group === cursor.group
    const readers: StreamReader[] = []
    for (const files of groups.get(group)?.values() ?? []) {
      let index = 0
      let end: number | undefined
      if (resumeHere) {
        const at = cursor.positions.find(([file]) => files.includes(file))
        if (!at) continue // that stream was finished on an earlier page
        index = files.indexOf(at[0])
        end = at[1]
      }
      readers.push({
        dir,
        files,
        index,
        end,
        lines: undefined,
        head: undefined,
        resume: undefined,
        done: false,
      })
    }
    try {
      let stopped = false
      for (const r of readers) {
        if (!(await fill(r, sanitize, budget))) {
          stopped = true
          break
        }
      }
      while (!stopped) {
        const r = newest(readers)
        if (!r?.head) break
        const { clean, line } = r.head
        r.head = undefined
        r.resume = line.start
        budget.progress = true
        if (accept(clean, query, scope)) records.push(clean.record)
        if (!(await fill(r, sanitize, budget))) stopped = true
        else if (records.length >= limit) {
          const more = readers.some((x) => x.head !== undefined) || gi < order.length - 1
          if (!more) return { records, scanned: budget.scanned }
          stopped = true
        }
      }
      if (stopped) {
        const positions: Array<readonly [string, number]> = []
        for (const x of readers) {
          const p = await positionOf(x)
          if (p) positions.push(p)
        }
        return {
          records,
          scanned: budget.scanned,
          nextCursor: encodeCursor({ group, positions }),
        }
      }
    } finally {
      for (const r of readers) await closeReader(r)
    }
  }
  return { records, scanned: budget.scanned }
}

/** Lines longer than this are skipped unread (far above any record the framework writes). */
export const MAX_LINE_BYTES: number = 1024 * 1024

/** Bytes read per chunk when reading forward. */
const CHUNK_BYTES = 64 * 1024

/**
 * Read the complete lines of one file from the start, in bounded memory: at most one chunk plus
 * one pending line (capped at `maxLineBytes`) is held at a time. A longer line is skipped without
 * being buffered, and a last line without a newline is ignored (a writer may be mid-append). A
 * file that vanishes or can't be read ends the generator quietly.
 *
 * @example
 * for await (const line of readLinesForward('/srv/app/storage/logs/strutvane.log')) count++
 */
export async function* readLinesForward(
  path: string,
  maxLineBytes: number = MAX_LINE_BYTES,
): AsyncGenerator<string> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch {
    return
  }
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES)
    let parts: Buffer[] = []
    let size = 0
    let skipping = false
    let position = 0
    for (;;) {
      let read: number
      try {
        read = (await handle.read(buffer, 0, CHUNK_BYTES, position)).bytesRead
      } catch {
        return
      }
      if (read === 0) return
      position += read
      let from = 0
      for (;;) {
        const nl = buffer.indexOf(10, from)
        if (nl === -1 || nl >= read) break
        const piece = buffer.subarray(from, nl)
        if (!skipping && size + piece.length <= maxLineBytes) {
          const line = Buffer.concat([...parts, piece]).toString('utf8')
          const text = line.endsWith('\r') ? line.slice(0, -1) : line
          if (text !== '') yield text
        }
        parts = []
        size = 0
        skipping = false
        from = nl + 1
      }
      if (from < read && !skipping) {
        const rest = buffer.subarray(from, read)
        if (size + rest.length > maxLineBytes) {
          // Too long to be a record: drop what was kept and skip to the next newline.
          parts = []
          size = 0
          skipping = true
        } else {
          parts.push(Buffer.from(rest))
          size += rest.length
        }
      }
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** One writer stream of a day, read forward, with its next line ready for the merge. */
interface ForwardStream {
  readonly dir: string
  /** The stream's files for the day, oldest first. */
  readonly files: readonly string[]
  /** Single files span days: only lines stamped with this day are kept. */
  readonly filterDay: string | undefined
  index: number
  lines: AsyncGenerator<string> | undefined
  head: { readonly text: string; readonly time: string; readonly file: string } | undefined
}

/** Advance a stream to its next line (of the day). */
async function advance(s: ForwardStream, maxLineBytes: number): Promise<void> {
  s.head = undefined
  for (;;) {
    const file = s.files[s.index]
    if (file === undefined) return
    s.lines ??= readLinesForward(join(s.dir, file), maxLineBytes)
    const next = await s.lines.next()
    if (next.done) {
      s.lines = undefined
      s.index++
      continue
    }
    const time = parseLogLine(next.value)?.time
    const stamp = typeof time === 'string' ? time : ''
    if (s.filterDay !== undefined && !stamp.startsWith(s.filterDay)) continue
    s.head = { text: next.value, time: stamp, file }
    return
  }
}

/** The stream whose next line is the oldest (ties: the earlier file in log order). */
function oldest(streams: readonly ForwardStream[]): ForwardStream | undefined {
  let best: ForwardStream | undefined
  for (const s of streams) {
    if (!s.head) continue
    if (
      !best?.head ||
      s.head.time < best.head.time ||
      (s.head.time === best.head.time && compareLogFiles(s.head.file, best.head.file) < 0)
    )
      best = s
  }
  return best
}

/**
 * Stream the complete lines of every file for `day`, **oldest first and merged across writer
 * streams by timestamp** (ADR-0022 §6): the main process and every worker write their own files,
 * and a download shows their records interleaved in time order, not one process after another.
 * Single files span days, so only their lines whose timestamp falls on `day` are included.
 *
 * Memory stays bounded however large the files are: one open file and one pending line per
 * stream, each line capped at `maxLineBytes`.
 *
 * @example
 * for await (const line of readDayLines(dir, '2026-11-15')) out.write(`${line}\n`)
 */
export async function* readDayLines(
  dir: string,
  day: string,
  bases: ReadonlySet<string> = DEFAULT_BASES,
  maxLineBytes: number = MAX_LINE_BYTES,
): AsyncGenerator<string> {
  const byStream = new Map<string, { readonly files: string[]; readonly single: boolean }>()
  for (const name of await listLogFiles(dir, bases)) {
    const parsed = parseLogFileName(name)
    if (!parsed || (parsed.day !== undefined && parsed.day !== day)) continue
    const key = streamKey(parsed)
    const entry = byStream.get(key) ?? { files: [], single: parsed.day === undefined }
    entry.files.push(name) // listed oldest first (compareLogFiles order)
    byStream.set(key, entry)
  }
  const streams: ForwardStream[] = [...byStream.values()].map((entry) => ({
    dir,
    files: entry.files,
    filterDay: entry.single ? day : undefined,
    index: 0,
    lines: undefined,
    head: undefined,
  }))
  try {
    for (const s of streams) await advance(s, maxLineBytes)
    for (;;) {
      const best = oldest(streams)
      if (!best?.head) return
      const text = best.head.text
      await advance(best, maxLineBytes)
      yield text
    }
  } finally {
    for (const s of streams) await s.lines?.return(undefined)
  }
}
