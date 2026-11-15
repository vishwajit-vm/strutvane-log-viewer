/**
 * Reading log files safely while they are being written: backwards in bounded chunks (newest
 * records first, flat memory however large the file), and byte ranges for tails. Shared by the
 * viewer and the `log:*` commands.
 *
 * - **Partial last lines are ignored:** a writer may be mid-append, so whatever follows the last
 *   newline is never returned.
 * - **Bounded:** a line longer than 1 MiB (far above any record this logger writes) is skipped
 *   without being buffered.
 * - **Never throws:** a file that disappears or can't be read just yields nothing more.
 *
 * @module
 */
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_BASES, dayKeyOf, listLogFiles, parseLogFileName } from './files.ts'

/** One log file, as listed by the viewer and `log:list`. */
export interface LogFileInfo {
  readonly name: string
  /** The day in the name, or for a `single` file the UTC day it was last written. */
  readonly day: string
  /** The channel's file base name (`strutvane`, `payments`, …). */
  readonly base: string
  readonly kind: 'single' | 'daily'
  /** The additional process that writes it, if any. */
  readonly worker?: string
  readonly part: number
  readonly size: number
  /** Last modification time (ISO 8601). */
  readonly modified: string
}

/**
 * Describe the log files in `dir` with one of `bases` (default: `strutvane`), newest first. Files
 * that vanish meanwhile are skipped.
 */
export async function describeFiles(
  dir: string,
  bases: ReadonlySet<string> = DEFAULT_BASES,
): Promise<LogFileInfo[]> {
  const out: LogFileInfo[] = []
  for (const name of (await listLogFiles(dir, bases)).reverse()) {
    const parsed = parseLogFileName(name)
    if (!parsed) continue
    try {
      const s = await stat(join(dir, name))
      if (s.isFile())
        out.push({
          name,
          day: parsed.day ?? dayKeyOf(s.mtimeMs),
          base: parsed.base,
          kind: parsed.kind,
          ...(parsed.worker === undefined ? {} : { worker: parsed.worker }),
          part: parsed.part,
          size: s.size,
          modified: s.mtime.toISOString(),
        })
    } catch {
      // Deleted between listing and stat (retention or clear): skip it.
    }
  }
  return out
}

/** Bytes read per step when scanning a file backwards. */
const CHUNK_BYTES = 64 * 1024
/** Lines longer than this are not records this logger wrote (they are capped far lower): skipped. */
const MAX_LINE_BYTES = 1024 * 1024

/** One complete line and the byte offset where it starts. */
export interface FileLine {
  readonly text: string
  readonly start: number
  /**
   * Byte offset of the line's terminating newline (its exclusive end). Reading the file below
   * `end + 1` yields this line again: the exact resume point, even when the bytes were not valid
   * UTF-8 and `text` has a different byte length.
   */
  readonly end: number
}

/**
 * Yield the complete lines of a file that start before byte `end` (default: the file size),
 * newest first, reading backwards in chunks of `chunkBytes`. Whatever follows the last newline
 * before `end` is dropped: at the end of the file it is a line still being written. Lines longer
 * than 1 MiB are skipped without being buffered. A file that disappears or can't be read yields
 * nothing more.
 */
export async function* readLinesBackward(
  path: string,
  end?: number,
  chunkBytes: number = CHUNK_BYTES,
): AsyncGenerator<FileLine> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const size = (await handle.stat()).size
    let pos = Math.min(end ?? size, size)
    let tail = Buffer.alloc(0) // bytes of a line whose start hasn't been read yet
    let oversized = false
    let first = true // the segment after the last newline is incomplete: drop it
    while (pos > 0) {
      const from = Math.max(0, pos - chunkBytes)
      const chunk = Buffer.alloc(pos - from)
      let got = 0
      while (got < chunk.length) {
        const { bytesRead } = await handle.read(chunk, got, chunk.length - got, from + got)
        if (bytesRead === 0) return // truncated meanwhile
        got += bytesRead
      }
      const data = tail.length > 0 ? Buffer.concat([chunk, tail]) : chunk
      let lineEnd = data.length
      let nl = data.lastIndexOf(0x0a, lineEnd - 1)
      while (nl !== -1) {
        if (!first && !oversized && lineEnd - nl - 1 <= MAX_LINE_BYTES)
          yield {
            text: data.subarray(nl + 1, lineEnd).toString('utf8'),
            start: from + nl + 1,
            end: from + lineEnd,
          }
        first = false
        oversized = false
        lineEnd = nl
        nl = lineEnd > 0 ? data.lastIndexOf(0x0a, lineEnd - 1) : -1
      }
      tail = Buffer.from(data.subarray(0, lineEnd))
      if (tail.length > MAX_LINE_BYTES) {
        oversized = true
        tail = Buffer.alloc(0)
      }
      pos = from
    }
    if (!first && !oversized && tail.length > 0)
      yield { text: tail.toString('utf8'), start: 0, end: tail.length }
  } catch {
    // Deleted or unreadable meanwhile: nothing more from this file.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Read bytes `[start, end)` of a file. Returns an empty buffer if the file is gone. */
export async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(end - start)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        start + offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } catch {
    return Buffer.alloc(0)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
