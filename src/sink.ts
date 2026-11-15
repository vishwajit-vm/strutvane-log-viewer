/**
 * A sink: the delivery half of one channel (ADR-0015's pipeline, per channel).
 *
 * ```
 * formatted line → bounded priority queue → batched, non-blocking writes (setImmediate)
 *                → transport, with the stderr fallback
 * ```
 *
 * Every leaf channel (`single`, `daily`, `stderr`, `slack`, a custom one…) owns one sink, so
 * channels are isolated: a slow or broken Slack webhook fills only the Slack queue and falls back
 * on its own, while the daily file keeps being written.
 *
 * Guarantees (proven in spike 09 and kept by the tests):
 * - **Off the hot path:** `push` only queues; at most one batch per sink is in flight.
 * - **Bounded memory:** the queue caps records and bytes; `debug`, `info` and `notice` are dropped
 *   before `warning` and up, and the drop count is reported in a later `warning` record.
 * - **Fallback on failure:** while the transport fails, batches go to the fallback (stderr) with
 *   exactly ONE warning per outage; the transport is retried later and recovers by itself.
 * - **A batch never mixes UTC days,** so daily files roll over exactly once at midnight.
 *
 * @module
 */
import { dayKeyOf } from './files.ts'
import type { Formatter } from './format/formatter.ts'
import { LEVEL_PRIORITY, type Level, type LevelName, toLevel } from './levels.ts'
import { BoundedQueue, DEFAULT_QUEUE_LIMITS, type QueueItem, type QueueLimits } from './queue.ts'
import { redactString } from './redact.ts'
import { DEFAULT_MAX_RECORD_BYTES, MIN_RECORD_BYTES, serializeRecord } from './serialize.ts'
import { stderrTransport } from './transports/console.ts'
import type { Batch, Transport } from './transports/types.ts'

/** Result of a bounded flush. */
export interface FlushResult {
  /** `true` if everything queued at the time was written before the deadline. */
  readonly flushed: boolean
  /** Records still queued when the call returned. */
  readonly pending: number
}

/** Counters for monitoring and tests. */
export interface LoggerStats {
  readonly written: number
  readonly dropped: number
  readonly droppedByLevel: Readonly<Partial<Record<Level, number>>>
  readonly fallbackActive: boolean
  readonly primaryFailures: number
  readonly fallbackWarnings: number
  readonly internalErrors: number
  readonly queued: number
  readonly queuePeak: number
  readonly queuePeakBytes: number
}

/** Options for {@link createSink}. */
export interface SinkOptions {
  /** The channel name, used in fallback warnings. Default: the transport's name. */
  readonly name?: string
  /** Where records go. */
  readonly transport: Transport
  /** Used while the transport fails. Default: stderr. */
  readonly fallback?: Transport
  /** Minimum level this sink accepts. Default: `debug`. */
  readonly level?: LevelName
  /** How records become lines. Default: JSON (NDJSON). */
  readonly format?: Formatter
  /** Maximum size of one line. Larger records become a truncation marker. Default: 32 KB. */
  readonly maxRecordBytes?: number
  /** Queue limits. Default: 10,000 records / 16 MB. */
  readonly queue?: Partial<QueueLimits>
  /** Maximum size of one write. Default: 256 KB. */
  readonly maxBatchBytes?: number
  /** Retry the transport this long after a failure. Default: 30 s. */
  readonly retryPrimaryMs?: number
  /** Injectable clock (epoch ms), for tests. */
  readonly now?: () => number
}

/** One channel's delivery pipeline. */
export interface Sink {
  readonly name: string
  readonly level: Level
  /** Priority of {@link level}: records below it are not accepted. */
  readonly minPriority: number
  readonly format: Formatter
  readonly maxRecordBytes: number
  /** `true` once {@link close} was called; later pushes are ignored. */
  readonly closed: boolean
  /** Queue one formatted line (with its `\n`). Never throws. */
  push(line: string, priority: number, level: Level, time: number): void
  /** Wait until everything queued now is written, or the deadline passes. */
  drain(timeoutMs?: number): Promise<FlushResult>
  /** Drain (bounded) and close the transport. */
  close(timeoutMs?: number): Promise<FlushResult>
  stats(): LoggerStats
}

interface State {
  readonly opts: Required<Omit<SinkOptions, 'name' | 'queue' | 'level'>> & { name: string }
  readonly queue: BoundedQueue
  seq: number
  scheduled: boolean
  writing: boolean
  closed: boolean
  fallbackActive: boolean
  retryAt: number
  written: number
  dropped: number
  droppedByLevel: Partial<Record<Level, number>>
  primaryFailures: number
  fallbackWarnings: number
  internalErrors: number
  waiters: Array<() => void>
  dayStart: number
  dayEnd: number
  dayKey: string
}

/**
 * Validate a numeric option: a programming mistake throws a `RangeError` naming the option.
 *
 * @example
 * positive(undefined, 30_000, 'retryPrimaryMs') // 30000
 */
export function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive number`)
  return value
}

/** The record cap: a truncation marker must fit it, so it is at least {@link MIN_RECORD_BYTES}. */
function recordCap(value: number | undefined): number {
  const cap = positive(value, DEFAULT_MAX_RECORD_BYTES, 'maxRecordBytes')
  if (cap < MIN_RECORD_BYTES)
    throw new RangeError(
      `maxRecordBytes must be at least ${MIN_RECORD_BYTES} (a truncation marker must fit)`,
    )
  return cap
}

/**
 * Create a sink over a transport.
 *
 * @example
 * const sink = createSink({ name: 'daily', transport: fileTransport({ dir: 'storage/logs' }) })
 */
export function createSink(options: SinkOptions): Sink {
  const level = toLevel(options.level ?? 'debug')
  if (level === undefined) throw new TypeError(`invalid level "${String(options.level)}"`)
  const state: State = {
    opts: {
      name: options.name ?? options.transport.name,
      transport: options.transport,
      fallback: options.fallback ?? stderrTransport(),
      format: options.format ?? serializeRecord,
      maxRecordBytes: recordCap(options.maxRecordBytes),
      maxBatchBytes: positive(options.maxBatchBytes, 256 * 1024, 'maxBatchBytes'),
      retryPrimaryMs: positive(options.retryPrimaryMs, 30_000, 'retryPrimaryMs'),
      now: options.now ?? Date.now,
    },
    queue: new BoundedQueue({ ...DEFAULT_QUEUE_LIMITS, ...options.queue }),
    seq: 0,
    scheduled: false,
    writing: false,
    closed: false,
    fallbackActive: false,
    retryAt: 0,
    written: 0,
    dropped: 0,
    droppedByLevel: {},
    primaryFailures: 0,
    fallbackWarnings: 0,
    internalErrors: 0,
    waiters: [],
    dayStart: 0,
    dayEnd: -1,
    dayKey: '',
  }
  return {
    name: state.opts.name,
    level,
    minPriority: LEVEL_PRIORITY[level],
    format: state.opts.format,
    maxRecordBytes: state.opts.maxRecordBytes,
    get closed(): boolean {
      return state.closed
    },
    push(line, priority, lvl, time) {
      if (state.closed) return
      try {
        enqueue(state, line, priority, lvl, time)
      } catch {
        state.internalErrors++
      }
    },
    drain: (timeoutMs = 5_000) => drain(state, timeoutMs),
    async close(timeoutMs = 5_000) {
      const result = await drain(state, timeoutMs)
      state.closed = true
      await Promise.race([state.opts.transport.close().catch(() => undefined), delay(timeoutMs)])
      return result
    },
    stats: () => ({
      written: state.written,
      dropped: state.dropped,
      droppedByLevel: { ...state.droppedByLevel },
      fallbackActive: state.fallbackActive,
      primaryFailures: state.primaryFailures,
      fallbackWarnings: state.fallbackWarnings,
      internalErrors: state.internalErrors,
      queued: state.queue.size,
      queuePeak: state.queue.peakRecords,
      queuePeakBytes: state.queue.peakBytes,
    }),
  }
}

function dayKeyFor(state: State, time: number): string {
  if (time >= state.dayStart && time < state.dayEnd) return state.dayKey
  state.dayKey = dayKeyOf(time)
  state.dayStart = Date.parse(`${state.dayKey}T00:00:00.000Z`)
  state.dayEnd = state.dayStart + 86_400_000
  return state.dayKey
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false
  return true
}

function byteLength(s: string): number {
  return isAscii(s) ? s.length : Buffer.byteLength(s)
}

function enqueue(state: State, line: string, priority: number, level: Level, time: number): void {
  const item: QueueItem = {
    seq: state.seq++,
    line,
    bytes: byteLength(line),
    priority,
    level,
    dayKey: dayKeyFor(state, time),
  }
  state.queue.push(item)
  schedule(state)
}

function schedule(state: State): void {
  if (state.scheduled || state.writing) return
  state.scheduled = true
  setImmediate(() => {
    state.scheduled = false
    void pump(state)
  })
}

/**
 * A pipeline-generated record (drop report, fallback warning), in the sink's own format so a
 * `line` file stays all lines. It skips the sanitiser, so anything quoted in it from outside (a
 * transport's error) goes through {@link describeTransportError} first.
 */
function internalLine(state: State, msg: string, fields: Record<string, unknown>): string {
  return state.opts.format(
    { time: new Date(state.opts.now()).toISOString(), level: 'warning', msg, fields },
    state.opts.maxRecordBytes,
  )
}

async function pump(state: State): Promise<void> {
  if (state.writing) return
  state.writing = true
  try {
    for (;;) {
      const items = state.queue.takeBatch(state.opts.maxBatchBytes)
      const first = items[0]
      if (!first) break
      let text = ''
      let bytes = 0
      const droppedNow = state.queue.takeDropped()
      if (droppedNow) {
        let total = 0
        for (const [lvl, n] of Object.entries(droppedNow)) {
          const level = lvl as Level
          total += n ?? 0
          state.droppedByLevel[level] = (state.droppedByLevel[level] ?? 0) + (n ?? 0)
        }
        state.dropped += total
        const meta = internalLine(state, `logs: dropped ${total} records (queue full)`, {
          dropped: droppedNow,
        })
        text += meta
        bytes += byteLength(meta)
      }
      for (const it of items) {
        text += it.line
        bytes += it.bytes
      }
      await deliver(state, { text, bytes, records: items.length, dayKey: first.dayKey })
      state.written += items.length
    }
  } catch {
    state.internalErrors++
  } finally {
    state.writing = false
    if (state.queue.size > 0) schedule(state)
    else {
      const waiters = state.waiters
      state.waiters = []
      for (const w of waiters) w()
    }
  }
}

async function deliver(state: State, batch: Batch): Promise<void> {
  const { transport, fallback } = state.opts
  const usePrimary = !state.fallbackActive || state.opts.now() >= state.retryAt
  if (usePrimary) {
    try {
      await callTransport(transport, batch)
      state.fallbackActive = false // (recovered, if it was failing)
      return
    } catch (error) {
      state.primaryFailures++
      state.retryAt = state.opts.now() + state.opts.retryPrimaryMs
      if (!state.fallbackActive) {
        state.fallbackActive = true
        state.fallbackWarnings++
        const warning = internalLine(
          state,
          `logs: channel "${state.opts.name}" (${transport.name}) failed; writing to ${fallback.name} until it recovers`,
          { error: describeTransportError(error) },
        )
        await callTransport(fallback, {
          text: warning,
          bytes: byteLength(warning),
          records: 1,
          dayKey: batch.dayKey,
        }).catch(() => undefined)
      }
    }
  }
  await callTransport(fallback, batch).catch(() => {
    state.internalErrors++
  })
}

/** Call a transport so that a synchronous throw becomes a rejection. */
function callTransport(t: Transport, batch: Batch): Promise<void> {
  try {
    return Promise.resolve(t.write(batch))
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * A transport's error, safe to write. Its text comes from a driver, a custom shipper or the
 * network, and often names the target with its credentials (`connect failed
 * postgres://app:secret@db`), so it is redacted and capped like any logged string. Pipeline
 * records skip the sanitiser, so this is the only place that can do it.
 */
export function describeTransportError(error: unknown): Record<string, unknown> {
  try {
    if (error instanceof Error) {
      const code = (error as { code?: unknown }).code
      return {
        name: safeText(error.name),
        message: safeText(error.message),
        ...(code ? { code: safeText(code) } : {}),
      }
    }
    return { message: safeText(error) }
  } catch {
    return { message: '[unreadable error]' }
  }
}

const MAX_ERROR_TEXT = 1_024

function safeText(value: unknown): string {
  const text = String(value)
  return redactString(text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text)
}

function drain(state: State, timeoutMs: number): Promise<FlushResult> {
  if (!state.writing && !state.scheduled && state.queue.size === 0) {
    return Promise.resolve({ flushed: true, pending: 0 })
  }
  return new Promise<FlushResult>((resolve) => {
    let done = false
    const finish = (flushed: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ flushed, pending: state.queue.size })
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    state.waiters.push(() => finish(true))
    schedule(state)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}
