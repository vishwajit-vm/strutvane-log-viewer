/**
 * Log file naming, ordering, retention and clearing (ADR-0022 §6, keeping ADR-0015's rules).
 *
 * ```
 * strutvane.log                       single channel
 * strutvane-2.log                     … its second size part (parts start at -2; never renamed)
 * strutvane-2026-11-15.log            daily channel, one file per UTC day
 * strutvane-2026-11-15-2.log          … its second size part
 * strutvane-2026-11-15.worker-2.log   an additional process (queue worker, cluster worker 2, …)
 * strutvane-2026-11-15.worker-2-3.log … that process's third part
 * payments-2026-11-15.log             a channel with its own base name
 * ```
 *
 * Why these rules:
 * - **Every process writes its own files** (spike 09: one shared file with a size cap broke the cap
 *   in 24 of 28 files). The main process keeps the plain, Laravel-like name.
 * - **Files are never renamed or truncated.** A size part or a new day is a new file, so a reader
 *   tailing a file never sees it change underneath it.
 * - **Base names have no `-` or `.`**, so every name parses one way only.
 * - **Ordering uses {@link compareLogFiles}, never a string sort.** A string sort puts `-10` before
 *   `-2` and `worker-10` before `worker-2` (RFC-0004's original bug class).
 *
 * @module
 */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** The base name of the default channels' files (`strutvane.log`, `strutvane-YYYY-MM-DD.log`). */
export const DEFAULT_LOG_BASE = 'strutvane'

/** Matches a Strutvane log file name: base, optional day, optional worker, optional part ≥ 2. */
export const LOG_FILE_PATTERN: RegExp =
  /^([A-Za-z0-9_]{1,64})(?:-(\d{4}-\d{2}-\d{2}))?(?:\.worker-([A-Za-z0-9_]{1,32}))?(?:-([2-9]|[1-9]\d{1,5}))?\.log$/

const BASE = /^[A-Za-z0-9_]{1,64}$/
const WORKER = /^[A-Za-z0-9_]{1,32}$/

/** `single` files have no day in their name; `daily` files have one. */
export type LogFileKind = 'single' | 'daily'

/** A parsed log file name. */
export interface LogFileName {
  /** The channel's base name, e.g. `strutvane` or `payments`. */
  readonly base: string
  readonly kind: LogFileKind
  /** The UTC day (`YYYY-MM-DD`) of a daily file. */
  readonly day?: string
  /** The additional process that writes this file; `undefined` for the main process. */
  readonly worker?: string
  /** Size part, starting at 1 (the file without a `-N` suffix). */
  readonly part: number
}

/** What {@link logFileName} needs to build a name. */
export interface LogFileNameParts {
  readonly base: string
  readonly day?: string | undefined
  readonly worker?: string | undefined
  /** Size part, 1 or more. Default: 1. */
  readonly part?: number | undefined
}

/**
 * Is `value` usable as a file base name (letters, digits and `_`, at most 64)?
 *
 * @example
 * isLogBaseName('payments') // true
 * isLogBaseName('my-app')   // false: a dash would make names ambiguous
 */
export function isLogBaseName(value: string): boolean {
  return BASE.test(value)
}

/**
 * Is `value` usable as a worker id (letters, digits and `_`, at most 32)?
 *
 * @example
 * isWorkerId('2') // true
 */
export function isWorkerId(value: string): boolean {
  return WORKER.test(value)
}

/**
 * UTC day key `YYYY-MM-DD` of an epoch-millisecond timestamp.
 *
 * @example
 * dayKeyOf(Date.parse('2026-11-15T23:59:59Z')) // '2026-11-15'
 */
export function dayKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Is `value` a valid `YYYY-MM-DD` day key (a real calendar date)?
 *
 * @example
 * isDayKey('2026-02-30') // false
 */
export function isDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(ms) && dayKeyOf(ms) === value
}

/**
 * The day key `days` days before `day` (negative values go forward).
 *
 * @example
 * shiftDay('2026-11-01', 1) // '2026-10-31'
 */
export function shiftDay(day: string, days: number): string {
  return dayKeyOf(Date.parse(`${day}T00:00:00.000Z`) - days * 86_400_000)
}

/**
 * Build a log file name. Throws a `RangeError` with a hint for an invalid base, day or worker id:
 * those come from configuration, so a mistake should surface at startup.
 *
 * @example
 * logFileName({ base: 'strutvane', day: '2026-11-15', worker: '2', part: 3 })
 * // 'strutvane-2026-11-15.worker-2-3.log'
 */
export function logFileName(parts: LogFileNameParts): string {
  const part = parts.part ?? 1
  if (!isLogBaseName(parts.base)) {
    throw new RangeError(
      `invalid log file base name "${parts.base}": use letters, digits and _ only (e.g. "payments")`,
    )
  }
  if (parts.day !== undefined && !isDayKey(parts.day))
    throw new RangeError(`invalid day "${parts.day}": use YYYY-MM-DD`)
  if (parts.worker !== undefined && !isWorkerId(parts.worker)) {
    throw new RangeError(
      `invalid worker id "${parts.worker}": use letters, digits and _ only (e.g. "2")`,
    )
  }
  if (!Number.isInteger(part) || part < 1 || part > 999_999)
    throw new RangeError(`invalid part ${part}: use a whole number from 1`)
  return `${parts.base}${parts.day ? `-${parts.day}` : ''}${parts.worker ? `.worker-${parts.worker}` : ''}${part > 1 ? `-${part}` : ''}.log`
}

/**
 * Parse a log file name, or return `undefined` if it isn't one (so foreign files, and names such
 * as `../x.log`, are never touched).
 *
 * @example
 * parseLogFileName('strutvane-2026-11-15.worker-2.log')
 * // { base: 'strutvane', kind: 'daily', day: '2026-11-15', worker: '2', part: 1 }
 */
export function parseLogFileName(name: string): LogFileName | undefined {
  const m = LOG_FILE_PATTERN.exec(name)
  const base = m?.[1]
  if (!m || base === undefined) return undefined
  const [, , day, worker, part] = m
  if (day !== undefined && !isDayKey(day)) return undefined
  return {
    base,
    kind: day === undefined ? 'single' : 'daily',
    ...(day === undefined ? {} : { day }),
    ...(worker === undefined ? {} : { worker }),
    part: part === undefined ? 1 : Number(part),
  }
}

// Numeric-aware comparison for worker ids: "worker-2" before "worker-10".
const WORKER_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' })

/**
 * Order log files: by base, single before daily, then by day, then the main process before
 * workers (worker ids compared numerically), then part NUMBER. Non-log names sort after log names,
 * alphabetically.
 *
 * Why not a string sort: `.` (0x2E) sorts after `-` (0x2D) and digits sort as text, so a plain
 * sort puts `strutvane-2026-11-15-10.log` before `…-2.log`, and `worker-10` before `worker-2`.
 *
 * @example
 * ['a-2026-11-15-10.log', 'a-2026-11-15-2.log'].sort(compareLogFiles)
 * // ['a-2026-11-15-2.log', 'a-2026-11-15-10.log']
 */
export function compareLogFiles(a: string, b: string): number {
  const pa = parseLogFileName(a)
  const pb = parseLogFileName(b)
  if (!pa || !pb) {
    if (pa) return -1
    if (pb) return 1
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (pa.base !== pb.base) return pa.base < pb.base ? -1 : 1
  if (pa.kind !== pb.kind) return pa.kind === 'single' ? -1 : 1
  const da = pa.day ?? ''
  const db = pb.day ?? ''
  if (da !== db) return da < db ? -1 : 1
  if (pa.worker !== pb.worker) {
    if (pa.worker === undefined) return -1
    if (pb.worker === undefined) return 1
    return WORKER_ORDER.compare(pa.worker, pb.worker) || (pa.worker < pb.worker ? -1 : 1)
  }
  return pa.part - pb.part
}

/**
 * The writer stream a file belongs to: one base, one kind, one process. Each stream has at most
 * one live file (its newest), see {@link newestPerStream}.
 */
export function streamKey(name: LogFileName): string {
  return `${name.base}|${name.kind}|${name.worker ?? ''}`
}

/** The base names readers and cleaners touch when none are given: the default channels' files. */
export const DEFAULT_BASES: ReadonlySet<string> = new Set([DEFAULT_LOG_BASE])

/**
 * List the log files in `dir`, in {@link compareLogFiles} order. A missing directory yields an
 * empty list.
 *
 * @param bases only files with these base names. Readers and cleaners always pass this: names
 *   like `auth.log` are valid log names too, and a log directory pointed at a shared folder
 *   (`/var/log`) must never expose or delete another program's files.
 */
export async function listLogFiles(dir: string, bases?: ReadonlySet<string>): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => {
      const parsed = parseLogFileName(n)
      return parsed !== undefined && (bases === undefined || bases.has(parsed.base))
    })
    .sort(compareLogFiles)
}

/**
 * The newest file of every writer stream: the file a running process may still be appending to.
 * Clearing never deletes these (on Linux an unlinked file keeps receiving writes that nobody can
 * read; on Windows the delete fails anyway).
 *
 * @param names log file names, in any order
 */
export function newestPerStream(names: readonly string[]): Set<string> {
  const newest = new Map<string, string>()
  for (const name of names) {
    const parsed = parseLogFileName(name)
    if (!parsed) continue
    const key = streamKey(parsed)
    const current = newest.get(key)
    if (current === undefined || compareLogFiles(name, current) > 0) newest.set(key, name)
  }
  return new Set(newest.values())
}

/** Options for {@link applyRetention}. */
export interface RetentionOptions {
  /** Only files with this base name (one channel). */
  readonly base: string
  /** Days to keep, today included. `0` keeps everything. */
  readonly days: number
  /** The clock (epoch ms). */
  readonly now: number
  /**
   * The day the caller is writing. That day and later are never deleted, even if the clock says
   * it is old, so the live file survives a clock that jumped backwards.
   */
  readonly writingDay?: string
}

/**
 * Daily-channel retention (`LOG_DAILY_DAYS`): delete the daily files of one base whose day is
 * older than the last `days` days (today included, as in Laravel). Whole days only: every part
 * and every process's file of an expired day goes. Single files, other bases and foreign files
 * are never touched. A file that can't be deleted (in use, already gone) is skipped and retried at
 * the next rotation.
 *
 * @returns the deleted file names
 *
 * @example
 * await applyRetention('storage/logs', { base: 'strutvane', days: 14, now: Date.now() })
 */
export async function applyRetention(dir: string, options: RetentionOptions): Promise<string[]> {
  if (options.days <= 0) return []
  let cutoff = shiftDay(dayKeyOf(options.now), options.days - 1)
  if (options.writingDay !== undefined && options.writingDay < cutoff) cutoff = options.writingDay
  const deleted: string[] = []
  for (const name of await listLogFiles(dir, new Set([options.base]))) {
    const parsed = parseLogFileName(name)
    if (parsed?.base !== options.base || parsed.day === undefined || parsed.day >= cutoff) continue
    if (await removeFile(join(dir, name))) deleted.push(name)
  }
  return deleted
}

/** Options for {@link clearLogFiles}. */
export interface ClearOptions {
  /** Delete only files whose day is before this day key. Default: no day limit. */
  readonly before?: string
  /** Only files with these base names. Default: `strutvane` (the built-in channels' files). */
  readonly bases?: ReadonlySet<string>
  /** The clock (epoch ms) that decides what "today" is. Default: now. */
  readonly now?: number
}

/** The outcome of {@link clearLogFiles}. */
export interface ClearResult {
  readonly deleted: readonly string[]
  /** Files kept because a running process may still be writing them. */
  readonly live: readonly string[]
}

/**
 * Delete log files (`log:clear`, the viewer's "clear"). Two rules keep live files:
 * - the newest file of every writer stream is never deleted: it may be the live file of a running
 *   process;
 * - a daily file dated today or later is never deleted, whatever `before` says. A file dated in the
 *   future (a clock that was ahead, another host sharing the directory) would otherwise make
 *   today's live file look old to the first rule.
 *
 * A single file's day is its last modification day, since its name has none.
 *
 * @example
 * await clearLogFiles('storage/logs', { before: '2026-11-01' })
 */
export async function clearLogFiles(dir: string, options: ClearOptions = {}): Promise<ClearResult> {
  const names = await listLogFiles(dir, options.bases ?? DEFAULT_BASES)
  const live = newestPerStream(names)
  const today = dayKeyOf(options.now ?? Date.now())
  const deleted: string[] = []
  const kept: string[] = []
  for (const name of names) {
    const day = await fileDay(dir, name)
    if (day === undefined) continue
    if (options.before !== undefined && day >= options.before) continue
    const dated = parseLogFileName(name)?.day
    if (live.has(name) || (dated !== undefined && dated >= today)) {
      kept.push(name)
      continue
    }
    if (await removeFile(join(dir, name))) deleted.push(name)
  }
  return { deleted, live: kept }
}

/**
 * The day a log file belongs to: the day in its name, or for a single file the UTC day it was
 * last modified. `undefined` if it isn't a log file or has vanished.
 */
export async function fileDay(dir: string, name: string): Promise<string | undefined> {
  const parsed = parseLogFileName(name)
  if (!parsed) return undefined
  if (parsed.day !== undefined) return parsed.day
  try {
    return dayKeyOf((await stat(join(dir, name))).mtimeMs)
  } catch {
    return undefined
  }
}

async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch {
    // In use, a directory, or already gone: skip it.
    return false
  }
}
