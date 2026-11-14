/**
 * The file transport behind the `single` and `daily` channels: a size cap per file, daily files
 * and retention (ADR-0015, ADR-0022). File names are described in `files.ts`.
 *
 * Rotation never renames or truncates a file: a new day or a new part is a NEW file. A reader that
 * is tailing the old file never sees it change underneath it, and never reads a torn line as long
 * as it only consumes up to the last `\n`.
 *
 * @module
 */
import { mkdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyRetention,
  DEFAULT_LOG_BASE,
  dayKeyOf,
  type LogFileKind,
  listLogFiles,
  logFileName,
  parseLogFileName,
} from '../files.ts'
import type { Batch, FileWriter, FileWriterFactory, Transport } from './types.ts'

/**
 * Strutvane's own append-only writer (ADR-0015: as fast as sonic-boom or faster, no dependency).
 * It opens with flag `a` (O_APPEND). Each batch is ONE logical write of whole lines, and partial
 * writes are completed in a loop, so we never leave a line half-written.
 */
export const appendFileWriter: FileWriterFactory = async (path) => {
  const handle = await open(path, 'a')
  return {
    async append(text: string): Promise<void> {
      // The buffer's own length is the exact byte count (the caller's `bytes` is only used for
      // rotation accounting).
      const buf = Buffer.from(text, 'utf8')
      const length = buf.length
      let offset = 0
      while (offset < length) {
        const { bytesWritten } = await handle.write(buf, offset, length - offset, null)
        if (bytesWritten <= 0) throw new Error('write returned 0 bytes')
        offset += bytesWritten
      }
    },
    async close(): Promise<void> {
      await handle.close()
    },
  }
}

/** Options for {@link fileTransport}. */
export interface FileTransportOptions {
  /** Directory for log files (created if missing). */
  readonly dir: string
  /** File base name (letters, digits, `_`). Default: `strutvane`. */
  readonly base?: string
  /** `daily` (one file per UTC day, the default) or `single` (one file, split only by size). */
  readonly mode?: LogFileKind
  /** Size cap per file in bytes; a full file continues in the next part. Default: 100 MB. */
  readonly maxFileBytes?: number
  /** Daily mode: keep this many days, today included. `0` keeps everything. Default: 14. */
  readonly days?: number
  /**
   * Worker id of an additional process (queue worker, scheduler, cluster worker). Each process
   * writes its own files, which keeps the size cap correct (ADR-0015). `undefined` for the main
   * process.
   */
  readonly worker?: string
  /** Injectable writer factory. Default: {@link appendFileWriter}. */
  readonly writer?: FileWriterFactory
  /** Injectable clock, used for retention. */
  readonly now?: () => number
}

/** A file transport that can report the file it's currently writing. */
export interface FileTransport extends Transport {
  readonly currentFile: () => string | undefined
}

/** Default size cap per file (`LOG_MAX_FILE_SIZE=100mb`). */
export const DEFAULT_MAX_FILE_BYTES: number = 100 * 1024 * 1024

/**
 * Create a file transport for a `single` or `daily` channel.
 *
 * - **Daily rollover follows the records, not the wall clock:** a batch never mixes UTC days (the
 *   queue guarantees it), and a batch for a new day opens that day's file. Every record therefore
 *   lands in the file of its own day, exactly once, even across midnight.
 * - **Size parts:** when the next batch would push a file past `maxFileBytes`, the next part
 *   (`-2`, `-3`, …) starts. A batch is never split, so no line is ever torn across files.
 * - **Restarts resume** the newest existing part of the day if it still has room.
 * - **Retention** runs when a new day starts and deletes whole expired days, never the day being
 *   written.
 *
 * @example
 * const transport = fileTransport({ dir: 'storage/logs', mode: 'daily', days: 14 })
 */
export function fileTransport(options: FileTransportOptions): FileTransport {
  const base = options.base ?? DEFAULT_LOG_BASE
  const mode = options.mode ?? 'daily'
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const days = options.days ?? 14
  const openWriter = options.writer ?? appendFileWriter
  const now = options.now ?? Date.now
  // Validate the name parts now (a configuration mistake), not at the first write.
  logFileName({ base, worker: options.worker })
  let dayKey: string | undefined
  let part = 1
  let size = 0
  let writer: FileWriter | undefined
  let path: string | undefined

  const nameFor = (day: string | undefined, p: number): string =>
    logFileName({ base, day, worker: options.worker, part: p })

  /** Open the newest existing part of `day` if it has room, otherwise the next one. */
  const openLatest = async (day: string | undefined): Promise<void> => {
    await mkdir(options.dir, { recursive: true })
    let newest = 1
    for (const name of await listLogFiles(options.dir, new Set([base]))) {
      const parsed = parseLogFileName(name)
      if (
        parsed?.base === base &&
        parsed.day === day &&
        parsed.worker === options.worker &&
        parsed.part > newest
      )
        newest = parsed.part
    }
    part = newest
    const existing = await stat(join(options.dir, nameFor(day, part))).catch(() => undefined)
    if (existing && existing.size >= maxFileBytes) part++
    await openPart(day, existing && existing.size < maxFileBytes ? existing.size : 0)
  }

  const openPart = async (day: string | undefined, startSize: number): Promise<void> => {
    await mkdir(options.dir, { recursive: true })
    const candidate = join(options.dir, nameFor(day, part))
    size = startSize
    path = candidate
    writer = await openWriter(candidate)
  }

  const close = async (): Promise<void> => {
    const w = writer
    writer = undefined
    if (w) await w.close()
  }

  return {
    name: 'file',
    currentFile: () => path,
    async write(batch: Batch): Promise<void> {
      const day = mode === 'daily' ? batch.dayKey : undefined
      if (mode === 'daily' && day !== dayKey) {
        await close()
        dayKey = day
        if (days > 0) {
          await applyRetention(options.dir, {
            base,
            days,
            now: now(),
            writingDay: batch.dayKey,
          }).catch(() => undefined)
        }
        await openLatest(day)
      } else if (!writer) {
        await openLatest(day)
      } else if (size > 0 && size + batch.bytes > maxFileBytes) {
        await close()
        part++
        await openPart(day, 0)
      }
      const w = writer
      if (!w) throw new Error('log file is not open')
      try {
        await w.append(batch.text, batch.bytes)
      } catch (error) {
        // Force a reopen on the next write: the directory may come back.
        await close().catch(() => undefined)
        throw error
      }
      size += batch.bytes
    },
    close,
  }
}

/** Today's UTC day key (exported for tooling that needs to skip the active day). */
export function today(now: () => number = Date.now): string {
  return dayKeyOf(now())
}
