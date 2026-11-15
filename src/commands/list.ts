/**
 * `log:list` and `log:clear` (ADR-0022 §8) as pure functions over log sources; the command
 * adapter only parses arguments and prints.
 *
 * @module
 */
import { clearLogFiles, dayKeyOf, shiftDay } from '../files.ts'
import { describeFiles, type LogFileInfo } from '../read.ts'
import type { LogSource } from './sources.ts'

/** One listed file, with the directory it lives in. */
export interface ListedFile extends LogFileInfo {
  readonly dir: string
}

/** The result of {@link listLogs}. */
export interface LogListing {
  /** Every file, newest first within each directory. */
  readonly files: readonly ListedFile[]
  /** Total bytes per day, newest day first. */
  readonly days: ReadonlyArray<{
    readonly day: string
    readonly files: number
    readonly bytes: number
  }>
  readonly totalBytes: number
}

/**
 * List the log files of `sources` with sizes and days.
 *
 * @example
 * const { files, days, totalBytes } = await listLogs(sourcesFor(config))
 */
export async function listLogs(sources: readonly LogSource[]): Promise<LogListing> {
  const files: ListedFile[] = []
  for (const source of sources) {
    for (const info of await describeFiles(source.dir, source.bases))
      files.push({ ...info, dir: source.dir })
  }
  const byDay = new Map<string, { files: number; bytes: number }>()
  for (const f of files) {
    const day = byDay.get(f.day) ?? { files: 0, bytes: 0 }
    day.files++
    day.bytes += f.size
    byDay.set(f.day, day)
  }
  const days = [...byDay]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, v]) => ({ day, ...v }))
  return { files, days, totalBytes: files.reduce((n, f) => n + f.size, 0) }
}

/**
 * Human-readable size: `512 B`, `1.5 KB`, `100.0 MB`.
 *
 * @example
 * humanSize(1536) // '1.5 KB'
 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/**
 * Render a listing as text lines (what `log:list` prints).
 *
 * @example
 * formatLogList(await listLogs(sources)).join('\n')
 */
export function formatLogList(listing: LogListing): string[] {
  if (listing.files.length === 0) return ['No log files yet.']
  const width = Math.max(...listing.files.map((f) => f.name.length))
  const lines = listing.files.map(
    (f) => `${f.name.padEnd(width)}  ${humanSize(f.size).padStart(9)}  ${f.day}  ${f.modified}`,
  )
  lines.push('')
  for (const d of listing.days)
    lines.push(
      `${d.day}  ${String(d.files).padStart(3)} file(s)  ${humanSize(d.bytes).padStart(9)}`,
    )
  lines.push(`Total: ${listing.files.length} file(s), ${humanSize(listing.totalBytes)}`)
  return lines
}

/** Options for {@link clearLogs}. */
export interface ClearLogsOptions {
  /**
   * Must be `true`. Deleting logs can't be undone, so every caller says so explicitly: the
   * `log:clear` command asks in a terminal, or needs `--force` when there is none.
   */
  readonly confirm: true
  /** Keep the last `days` days (today included). Omitted or 0: clear every day. */
  readonly days?: number
  /** The clock (epoch ms). Default: now. */
  readonly now?: number
}

/** The result of {@link clearLogs}. */
export interface ClearLogsResult {
  readonly deleted: readonly string[]
  /** Kept because a running process may still write them. */
  readonly live: readonly string[]
}

/** {@link clearLogs} was called without `confirm: true`. Nothing was deleted. */
export class ClearNotConfirmedError extends Error {
  override readonly name = 'ClearNotConfirmedError'
  /** Stable code for tooling. */
  readonly code = 'LOG_CLEAR_NOT_CONFIRMED'
}

/**
 * Delete log files of `sources` (`log:clear`). The newest file of each process's stream and every
 * daily file dated today or later are never deleted, since a running process may be appending to
 * them.
 *
 * @throws ClearNotConfirmedError without `confirm: true` (nothing is deleted)
 *
 * @example
 * await clearLogs(sourcesFor(config), { confirm: true, days: 7 }) // keep the last week
 */
export async function clearLogs(
  sources: readonly LogSource[],
  options: ClearLogsOptions,
): Promise<ClearLogsResult> {
  // Checked at runtime too: JavaScript callers and `as` casts skip the type.
  if ((options as { readonly confirm?: unknown } | undefined)?.confirm !== true)
    throw new ClearNotConfirmedError(
      "clearLogs deletes log files and can't be undone; pass { confirm: true }",
    )
  const days = options.days ?? 0
  if (!Number.isInteger(days) || days < 0) throw new RangeError('days must be a whole number ≥ 0')
  const now = options.now ?? Date.now()
  const before = days > 0 ? shiftDay(dayKeyOf(now), days - 1) : undefined
  const deleted: string[] = []
  const live: string[] = []
  for (const source of sources) {
    const result = await clearLogFiles(source.dir, {
      bases: source.bases,
      now,
      ...(before === undefined ? {} : { before }),
    })
    deleted.push(...result.deleted)
    live.push(...result.live)
  }
  return { deleted, live }
}
