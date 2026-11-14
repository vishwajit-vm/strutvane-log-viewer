/**
 * The logger front end (RFC-0004, ADR-0015, ADR-0022):
 *
 * ```
 * call → record (base context + bindings + request context + fields) → sanitise/redact ONCE
 *      → for every sink whose level accepts it: format (once per format) → that sink's queue
 * ```
 *
 * A logger fans out to one sink (a channel) or several (a stack). Redaction happens once, before
 * any sink sees the record, so it can't be skipped or weakened for a single channel.
 *
 * Contract with application code:
 * - **A log call is synchronous, cheap and NEVER throws,** whatever it is given.
 * - **Every RFC 5424 level has a method** (`emergency` … `debug`), plus `log(level, …)` and the v1
 *   aliases `trace`, `warn` and `fatal`, so the `Logger` contract keeps working.
 *
 * @module
 */
import type { LogFields, Logger } from '@strutvane/contracts'
import { type ContextGetter, getLogContext } from './context.ts'
import { createFormatter, type Formatter, type LogFormat } from './format/formatter.ts'
import { LEVEL_PRIORITY, LEVELS, type Level, type LevelName, toLevel } from './levels.ts'
import type { QueueLimits } from './queue.ts'
import { buildRecord } from './record.ts'
import { createSanitizer, type SanitizeOptions, type Sanitizer } from './redact.ts'
import type { SerializableRecord } from './serialize.ts'
import { createSink, type FlushResult, type LoggerStats, type Sink } from './sink.ts'
import type { Transport } from './transports/types.ts'

export type { FlushResult, LoggerStats } from './sink.ts'

/** A log method: a message plus optional structured fields. */
export type LogMethod = (msg: string, fields?: LogFields) => void

/** One method per RFC 5424 level, plus the v1 aliases. */
export interface LevelMethods {
  emergency: LogMethod
  alert: LogMethod
  critical: LogMethod
  error: LogMethod
  warning: LogMethod
  notice: LogMethod
  info: LogMethod
  debug: LogMethod
  /** Alias of `debug` (v1 `Logger` contract). */
  trace: LogMethod
  /** Alias of `warning` (v1 `Logger` contract). */
  warn: LogMethod
  /** Alias of `critical` (v1 `Logger` contract). */
  fatal: LogMethod
  /**
   * Log at a level chosen at runtime. An unknown level name is logged at `error` with the name kept
   * in `fields.invalidLevel`, so a typo never loses the record.
   */
  log(level: LevelName, msg: string, fields?: LogFields): void
}

/** A Strutvane logger: the contracts' `Logger`, every RFC 5424 level, lifecycle and stats. */
export interface StrutvaneLogger extends Logger, LevelMethods {
  /** The lowest level any of its channels writes (`emergency` when it writes nowhere). */
  readonly level: Level
  child(bindings: LogFields): StrutvaneLogger
  /** Would a record at this level be written by at least one channel? */
  isLevelEnabled(level: LevelName): boolean
  /** Wait (bounded) until everything queued is written. */
  flush(timeoutMs?: number): Promise<void>
  /** Like `flush`, but reports whether everything was written before the deadline. */
  drain(timeoutMs?: number): Promise<FlushResult>
  /** Drain (bounded) and close the channels' transports. Later log calls are ignored. */
  close(timeoutMs?: number): Promise<FlushResult>
  stats(): LoggerStats
}

/** What a logger front end shares with its children. */
export interface EmitterOptions {
  /** The channels (sinks) records fan out to. Empty: the logger discards everything. */
  readonly sinks: readonly Sink[]
  /** The one sanitiser every record passes through. */
  readonly sanitize: Sanitizer
  /** Where request context comes from. Default: this package's AsyncLocalStorage store. */
  readonly context?: ContextGetter
  /** Context shared by every channel (lowest precedence), read at each call. */
  readonly base?: () => LogFields | undefined
  /** Injectable clock (epoch ms), for tests. */
  readonly now?: () => number
}

interface Emitter {
  readonly sinks: readonly Sink[]
  readonly sanitize: Sanitizer
  readonly context: ContextGetter
  readonly base: () => LogFields | undefined
  readonly now: () => number
  readonly minPriority: number
  readonly level: Level
  internalErrors: number
}

const NO_BASE = (): undefined => undefined

/**
 * Create a logger that fans out to `sinks`. Most code uses the `Log` facade or
 * `createLogManager`; this is the building block they share.
 *
 * @example
 * const logger = createEmitter({ sinks: [daily, slack], sanitize: createSanitizer() })
 */
export function createEmitter(options: EmitterOptions, bindings: LogFields = {}): StrutvaneLogger {
  let minPriority = Number.POSITIVE_INFINITY
  let level: Level = 'emergency'
  for (const sink of options.sinks) {
    if (sink.minPriority < minPriority) {
      minPriority = sink.minPriority
      level = sink.level
    }
  }
  const emitter: Emitter = {
    sinks: options.sinks,
    sanitize: options.sanitize,
    context: options.context ?? getLogContext,
    base: options.base ?? NO_BASE,
    now: options.now ?? Date.now,
    minPriority,
    level,
    internalErrors: 0,
  }
  return makeLogger(emitter, bindings)
}

function write(
  e: Emitter,
  bindings: LogFields,
  level: Level,
  msg: unknown,
  fields: LogFields | undefined,
): void {
  try {
    const priority = LEVEL_PRIORITY[level]
    if (priority < e.minPriority) return
    const time = e.now()
    let context: ReturnType<ContextGetter>
    try {
      context = e.context()
    } catch {
      context = undefined
    }
    let base: LogFields | undefined
    try {
      base = e.base()
    } catch {
      base = undefined
    }
    const record = buildRecord(level, msg, bindings, context, fields, time, base)
    const safe = e.sanitize(record) as SerializableRecord
    // Format once per distinct formatter: a stack of two `line` files formats one line.
    let lastFormat: Formatter | undefined
    let lastBytes = 0
    let line = ''
    for (const sink of e.sinks) {
      if (priority < sink.minPriority || sink.closed) continue
      if (sink.format !== lastFormat || sink.maxRecordBytes !== lastBytes) {
        lastFormat = sink.format
        lastBytes = sink.maxRecordBytes
        line = sink.format(safe, sink.maxRecordBytes)
      }
      sink.push(line, priority, level, time)
    }
  } catch {
    e.internalErrors++
  }
}

function makeLogger(e: Emitter, bindings: LogFields): StrutvaneLogger {
  const at =
    (level: Level): LogMethod =>
    (msg, fields) =>
      write(e, bindings, level, msg, fields)
  const all = <T>(fn: (sink: Sink) => Promise<T>): Promise<T[]> => Promise.all(e.sinks.map(fn))
  const merge = (results: FlushResult[]): FlushResult => ({
    flushed: results.every((r) => r.flushed),
    pending: results.reduce((n, r) => n + r.pending, 0),
  })
  return {
    level: e.level,
    emergency: at('emergency'),
    alert: at('alert'),
    critical: at('critical'),
    error: at('error'),
    warning: at('warning'),
    notice: at('notice'),
    info: at('info'),
    debug: at('debug'),
    trace: at('debug'),
    warn: at('warning'),
    fatal: at('critical'),
    log(level, msg, fields) {
      const canonical = toLevel(level)
      if (canonical !== undefined) write(e, bindings, canonical, msg, fields)
      else write(e, bindings, 'error', msg, { ...fields, invalidLevel: String(level) })
    },
    child: (more) => makeLogger(e, { ...bindings, ...more }),
    isLevelEnabled(level) {
      const canonical = toLevel(level)
      if (canonical === undefined) return false
      const priority = LEVEL_PRIORITY[canonical]
      return e.sinks.some((s) => !s.closed && priority >= s.minPriority)
    },
    flush: async (timeoutMs = 5_000) => {
      await all((s) => s.drain(timeoutMs))
    },
    drain: async (timeoutMs = 5_000) => merge(await all((s) => s.drain(timeoutMs))),
    close: async (timeoutMs = 5_000) => merge(await all((s) => s.close(timeoutMs))),
    stats: () => sumStats(e),
  }
}

function sumStats(e: Emitter): LoggerStats {
  const out = {
    written: 0,
    dropped: 0,
    droppedByLevel: {} as Partial<Record<Level, number>>,
    fallbackActive: false,
    primaryFailures: 0,
    fallbackWarnings: 0,
    internalErrors: e.internalErrors,
    queued: 0,
    queuePeak: 0,
    queuePeakBytes: 0,
  }
  for (const sink of e.sinks) {
    const s = sink.stats()
    out.written += s.written
    out.dropped += s.dropped
    for (const lvl of LEVELS) {
      const n = s.droppedByLevel[lvl]
      if (n) out.droppedByLevel[lvl] = (out.droppedByLevel[lvl] ?? 0) + n
    }
    out.fallbackActive ||= s.fallbackActive
    out.primaryFailures += s.primaryFailures
    out.fallbackWarnings += s.fallbackWarnings
    out.internalErrors += s.internalErrors
    out.queued += s.queued
    out.queuePeak = Math.max(out.queuePeak, s.queuePeak)
    out.queuePeakBytes = Math.max(out.queuePeakBytes, s.queuePeakBytes)
  }
  return out
}

/** Low-level options: one explicit transport plus pipeline tuning. */
export interface PipelineOptions {
  /** Where records go. */
  readonly transport: Transport
  /** Used while the primary transport fails. Default: stderr. */
  readonly fallback?: Transport
  /** Minimum level written. Default: `info`. Aliases are accepted. */
  readonly level?: LevelName
  /** `json` (the default here) or `line`, or your own formatter. */
  readonly format?: LogFormat | Formatter
  /** `APP_ENV` shown in `line` headers. Default: `production`. */
  readonly env?: string
  /**
   * Redaction and safety settings. `{ redact: false }` keeps only the safety transformations; the
   * channel configuration (`config/logging`) offers no such switch (ADR-0022).
   */
  readonly sanitize?: Partial<SanitizeOptions>
  /** Maximum size of one record. Larger records become a truncation marker. Default: 32 KB. */
  readonly maxRecordBytes?: number
  /** Queue limits. Default: 10,000 records / 16 MB. */
  readonly queue?: Partial<QueueLimits>
  /** Maximum size of one write. Default: 256 KB. */
  readonly maxBatchBytes?: number
  /** Retry the primary transport this long after a failure. Default: 30 s. */
  readonly retryPrimaryMs?: number
  /** Bindings added to every record, e.g. `{ service: 'api' }`. */
  readonly bindings?: LogFields
  /** Where request context comes from. Default: this package's AsyncLocalStorage store. */
  readonly context?: ContextGetter
  /** Injectable clock (epoch ms), for tests. */
  readonly now?: () => number
}

/**
 * Create a one-channel logger over an explicit transport (tests, custom setups). Apps use the
 * `Log` facade, whose channels come from `config/logging`.
 *
 * @example
 * const logger = createPipelineLogger({ transport: stdoutTransport(), level: 'debug' })
 */
export function createPipelineLogger(options: PipelineOptions): StrutvaneLogger {
  const format =
    typeof options.format === 'function'
      ? options.format
      : createFormatter(
          options.format ?? 'json',
          options.env === undefined ? {} : { env: options.env },
        )
  const level = options.level ?? 'info'
  if (toLevel(level) === undefined) throw new TypeError(`invalid level "${String(level)}"`)
  const sink = createSink({
    transport: options.transport,
    level,
    format,
    ...(options.fallback ? { fallback: options.fallback } : {}),
    ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.maxBatchBytes === undefined ? {} : { maxBatchBytes: options.maxBatchBytes }),
    ...(options.retryPrimaryMs === undefined ? {} : { retryPrimaryMs: options.retryPrimaryMs }),
    ...(options.now ? { now: options.now } : {}),
  })
  return createEmitter(
    {
      sinks: [sink],
      sanitize: createSanitizer(options.sanitize),
      ...(options.context ? { context: options.context } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
    options.bindings ?? {},
  )
}
