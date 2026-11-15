/**
 * `log:tail`: the newest records, then (with `follow`) new ones as they are written, from every
 * process's files merged by timestamp (ADR-0022 §8).
 *
 * - **Both formats** are read (`line` and `json`, even mixed).
 * - **Per-process files are merged by time.** The main process and each worker write their own
 *   file (ADR-0015); reading them one after the other would show worker records out of order. The
 *   backlog is merged by timestamp, and so is everything that arrives within one poll.
 * - **Filters:** a minimum level (`--level=warning` shows warning and above; aliases work), a
 *   channel (its files, see `sourcesFor`), case-insensitive text (`--grep`), and a start time
 *   (`--since=15m` or a date).
 * - **Safe output:** each record is re-sanitised and printed in the `line` format, which escapes
 *   every control character, so a hostile log line can't drive the terminal.
 * - **Bounded:** the backlog reads files backwards in chunks; each poll reads at most
 *   `maxReadBytes` per file; torn last lines wait for the next poll.
 *
 * @module
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { compareLogFiles, listLogFiles, parseLogFileName, streamKey } from '../files.ts'
import { envLabel, formatLine } from '../format/line.ts'
import { type ParsedRecord, parseLogLine } from '../format/parse.ts'
import { LEVEL_PRIORITY, type Level, toLevel } from '../levels.ts'
import { readLinesBackward, readRange } from '../read.ts'
import { createSanitizer, type Sanitizer } from '../redact.ts'
import type { SerializableRecord } from '../serialize.ts'
import type { LogSource } from './sources.ts'

/** What to show. */
export interface TailFilter {
  /** Minimum level. */
  readonly level?: Level
  /** Case-insensitive text that must appear in the record. */
  readonly text?: string
  /** Only records at or after this time (ISO 8601, UTC, as written in the files). */
  readonly since?: string
}

const SINCE_UNITS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Parse a `--since` value: a duration back from `now` (`30s`, `15m`, `2h`, `7d`) or a date or
 * time (`2026-11-15`, `2026-11-15T10:00:00Z`). Returns the ISO instant, or `undefined` when the
 * text is neither.
 *
 * @example
 * parseSince('15m', Date.parse('2026-11-15T10:00:00Z')) // '2026-11-15T09:45:00.000Z'
 */
export function parseSince(text: string, now: number = Date.now()): string | undefined {
  const duration = /^(\d{1,6})([smhd])$/.exec(text.trim())
  if (duration?.[1] && duration[2]) {
    const unit = SINCE_UNITS[duration[2]] ?? 0
    return new Date(now - Number(duration[1]) * unit).toISOString()
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(text.trim())) return undefined
  const ms = Date.parse(text.trim())
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

/** One record found by the tail. */
export interface TailEntry {
  readonly dir: string
  readonly file: string
  readonly record: ParsedRecord
}

/** Options for {@link tailLogs}. */
export interface TailLogsOptions extends TailFilter {
  readonly sources: readonly LogSource[]
  /** Records to show from what already exists. Default: 20. */
  readonly lines?: number
  /** Keep waiting for new records. Default: `false`. */
  readonly follow?: boolean
  /** How often to look for new bytes when following. Default: 500 ms. */
  readonly pollMs?: number
  /** Maximum bytes read from one file per poll. Default: 1 MiB. */
  readonly maxReadBytes?: number
  /** Stops a follow. */
  readonly signal?: AbortSignal
}

/**
 * Does a record pass the filter? `text` is matched against the record's message and its JSON.
 *
 * @example
 * matchesTail({ level: 'error', msg: 'Payment failed' }, { level: 'warning', text: 'payment' }) // true
 */
export function matchesTail(record: ParsedRecord, filter: TailFilter): boolean {
  if (filter.level !== undefined) {
    const level = toLevel(record.level)
    if (level === undefined || LEVEL_PRIORITY[level] < LEVEL_PRIORITY[filter.level]) return false
  }
  if (filter.since !== undefined) {
    if (typeof record.time !== 'string' || record.time < filter.since) return false
  }
  if (filter.text !== undefined && filter.text !== '') {
    let haystack: string
    try {
      haystack = JSON.stringify(record).toLowerCase()
    } catch {
      return false
    }
    if (!haystack.includes(filter.text.toLowerCase())) return false
  }
  return true
}

function timeOf(entry: TailEntry): string {
  return typeof entry.record.time === 'string' ? entry.record.time : ''
}

/**
 * Merge entries from several files by timestamp, oldest first. Stable: entries with the same time
 * (or none) keep their order, so one file's own order is never changed.
 *
 * @example
 * mergeByTime([...mainProcessEntries, ...workerEntries])
 */
export function mergeByTime(entries: readonly TailEntry[]): TailEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, time: timeOf(entry) }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.index - b.index))
    .map((x) => x.entry)
}

const tailSanitizer: Sanitizer = createSanitizer()

/**
 * Render an entry as one safe `line`-format line (no trailing newline), re-sanitised first.
 *
 * @example
 * formatTailEntry(entry) // '[2026-11-15 10:22:01.123] local.ERROR: Payment failed {"invoice":42}'
 */
export function formatTailEntry(entry: TailEntry, sanitize: Sanitizer = tailSanitizer): string {
  const safe = sanitize(entry.record) as SerializableRecord
  const env = typeof entry.record.env === 'string' ? entry.record.env : 'production'
  const { env: _env, ...rest } = safe as Record<string, unknown>
  return formatLine(rest, envLabel(env), 64 * 1024).slice(0, -1)
}

/** The backlog: the last `count` matching records across every stream, oldest first. */
async function backlog(
  sources: readonly LogSource[],
  count: number,
  filter: TailFilter,
): Promise<TailEntry[]> {
  if (count <= 0) return []
  const found: TailEntry[] = []
  for (const source of sources) {
    const byStream = new Map<string, string[]>()
    for (const name of await listLogFiles(source.dir, source.bases)) {
      const parsed = parseLogFileName(name)
      if (!parsed) continue
      const key = streamKey(parsed)
      byStream.set(key, [...(byStream.get(key) ?? []), name])
    }
    for (const files of byStream.values()) {
      // Newest file first; stop once this stream gave `count` matches.
      const fromStream: TailEntry[] = []
      for (const file of [...files].sort(compareLogFiles).reverse()) {
        for await (const line of readLinesBackward(join(source.dir, file))) {
          const record = parseLogLine(line.text)
          if (record && matchesTail(record, filter))
            fromStream.push({ dir: source.dir, file, record })
          if (fromStream.length >= count) break
        }
        if (fromStream.length >= count) break
      }
      found.push(...fromStream.reverse())
    }
  }
  const merged = mergeByTime(found)
  return merged.slice(Math.max(0, merged.length - count))
}

interface Followed {
  offset: number
  pending: Buffer
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

/**
 * Tail log files: yield the backlog, then (with `follow`) new records until `signal` aborts.
 *
 * @example
 * for await (const entry of tailLogs({ sources, level: 'warning', follow: true, signal })) {
 *   process.stdout.write(`${formatTailEntry(entry)}\n`)
 * }
 */
export async function* tailLogs(options: TailLogsOptions): AsyncGenerator<TailEntry> {
  const filter: TailFilter = {
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.since === undefined ? {} : { since: options.since }),
  }
  // Note every file's size first, so records written while the backlog is read are not lost.
  const followed = new Map<string, Followed>()
  const sizes = async (): Promise<Array<{ dir: string; file: string; size: number }>> => {
    const out: Array<{ dir: string; file: string; size: number }> = []
    for (const source of options.sources) {
      for (const file of await listLogFiles(source.dir, source.bases)) {
        try {
          out.push({ dir: source.dir, file, size: (await stat(join(source.dir, file))).size })
        } catch {
          // Gone meanwhile.
        }
      }
    }
    return out
  }
  if (options.follow) {
    for (const f of await sizes())
      followed.set(join(f.dir, f.file), { offset: f.size, pending: Buffer.alloc(0) })
  }
  for (const entry of await backlog(options.sources, options.lines ?? 20, filter)) yield entry
  if (!options.follow) return

  const pollMs = options.pollMs ?? 500
  const maxRead = options.maxReadBytes ?? 1024 * 1024
  while (!options.signal?.aborted) {
    await sleep(pollMs, options.signal)
    if (options.signal?.aborted) break
    const fresh: TailEntry[] = []
    for (const f of await sizes()) {
      const path = join(f.dir, f.file)
      let state = followed.get(path)
      if (!state || f.size < state.offset) {
        state = { offset: 0, pending: Buffer.alloc(0) }
        followed.set(path, state)
      }
      if (f.size === state.offset) continue
      const chunk = await readRange(path, state.offset, Math.min(f.size, state.offset + maxRead))
      state.offset += chunk.length
      const data = state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk
      const lastNewline = data.lastIndexOf(0x0a)
      if (lastNewline === -1) {
        state.pending = data
        continue
      }
      state.pending = Buffer.from(data.subarray(lastNewline + 1))
      for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
        const record = parseLogLine(line)
        if (record && matchesTail(record, filter)) fresh.push({ dir: f.dir, file: f.file, record })
      }
    }
    for (const entry of mergeByTime(fresh)) yield entry
  }
}
