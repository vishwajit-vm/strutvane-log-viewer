/**
 * The log manager: Laravel's `Log` facade for Strutvane (ADR-0022 §7). It owns the channels from
 * `config/logging`, creates each one the first time it is used, and routes calls to them.
 *
 * ```ts
 * Log.info('Invoice sent', { invoiceId })                 // the default channel (LOG_CHANNEL)
 * Log.channel('payments').warning('Card declined')        // one channel
 * Log.stack(['daily', 'slack']).critical('Ledger out of balance')
 * Log.build({ driver: 'single', path: 'storage/logs/imports' }).info('Import done')
 * Log.withContext({ orderId })                            // this request only
 * Log.shareContext({ release: '2026.11.15' })             // every channel, every request
 * ```
 *
 * Why it is built this way:
 * - **Channels are isolated.** Every leaf channel has its own sink (queue, writer, fallback), so a
 *   slow Slack webhook can't delay the daily file, and one failing channel falls back on its own.
 * - **Redaction happens once, before fan-out,** with one sanitiser for every channel; no channel
 *   option can turn it off (ADR-0022 §7).
 * - **Stacks write each record once per channel**, even when stacks overlap (`leaves` are unique).
 * - **A wrong channel name never loses a record or crashes the app:** it is written to the default
 *   channel, and a friendly error naming the defined channels is logged once.
 * - **Request id, user (`actorId`) and tenant** come from the AsyncLocalStorage context
 *   automatically.
 *
 * @module
 */
import cluster from 'node:cluster'
import { isMainThread, threadId } from 'node:worker_threads'
import type { LogFields } from '@strutvane/contracts'
import {
  type BuiltInChannel,
  type ChannelConfig,
  type ChannelName,
  type CustomChannelContext,
  type Env,
  type LoggingConfig,
  type LoggingIssue,
  type ResolvedChannel,
  type ResolvedLoggingConfig,
  resolveChannelConfig,
  resolveLoggingConfig,
} from './config.ts'
import { addToLogContext, type ContextGetter, removeFromLogContext } from './context.ts'
import { isWorkerId } from './files.ts'
import { createFormatter, type Formatter, type LogFormat } from './format/formatter.ts'
import type { Level } from './levels.ts'
import {
  createEmitter,
  type FlushResult,
  type LoggerStats,
  type StrutvaneLogger,
} from './logger.ts'
import type { QueueLimits } from './queue.ts'
import { createSanitizer, type SanitizeOptions, type Sanitizer } from './redact.ts'
import { registerShutdownFlush } from './shutdown.ts'
import { createSink, describeTransportError, type Sink } from './sink.ts'
import { stderrTransport, stdoutTransport } from './transports/console.ts'
import { fileTransport } from './transports/file.ts'
import { slackTransport, type WebhookPost } from './transports/slack.ts'
import type { Transport, WritableLike } from './transports/types.ts'

/** The `Log` facade: the default channel's logger plus channel selection and context. */
export interface LogManager<C extends string = string> extends StrutvaneLogger {
  /** The resolved `config/logging`. */
  readonly config: ResolvedLoggingConfig
  /** Problems found in `.env` (the defaults were used; each was also logged once). */
  readonly issues: readonly LoggingIssue[]
  /**
   * A channel by name (the default channel when omitted). A name that isn't configured writes to
   * the default channel and logs a friendly error once.
   *
   * @example
   * Log.channel('payments').warning('Card declined', { orderId })
   */
  channel(name?: C): StrutvaneLogger
  /**
   * An on-the-fly stack: every record goes to each channel once.
   *
   * @example
   * Log.stack(['daily', 'slack']).critical('Ledger out of balance')
   */
  stack(channels: readonly C[]): StrutvaneLogger
  /**
   * A channel from a config object, without adding it to `config/logging` (Laravel's
   * `Log::build`). Built channels are cached by their config, so building the same one again
   * reuses its file. Throws a `LoggingConfigError` for an invalid config.
   *
   * @example
   * Log.build({ driver: 'single', path: 'storage/logs/imports', name: 'imports' }).info('Done')
   */
  build(config: ChannelConfig): StrutvaneLogger
  /**
   * Add context to every record written during this request (or, outside a request, during the
   * rest of this process). Like Laravel's `Log::withContext()`.
   *
   * @example
   * Log.withContext({ orderId: order.id })
   */
  withContext(values: LogFields): LogManager<C>
  /**
   * Remove context added with {@link withContext}: the given keys, or all of it. The request's own
   * ids (request, trace, tenant, user) stay.
   */
  withoutContext(keys?: readonly string[]): LogManager<C>
  /**
   * Add context to every record on every channel, in every request, for the rest of the process
   * (Laravel's `Log::shareContext()`).
   *
   * @example
   * Log.shareContext({ release: process.env.RELEASE })
   */
  shareContext(values: LogFields): LogManager<C>
  /** The context added with {@link shareContext}. */
  sharedContext(): Readonly<Record<string, unknown>>
  /** Remove everything added with {@link shareContext}. */
  flushSharedContext(): LogManager<C>
  /**
   * Log a deprecation warning to the deprecations channel (`LOG_DEPRECATIONS_CHANNEL`, `null` by
   * default, so it costs nothing until switched on).
   */
  deprecation(msg: string, fields?: LogFields): void
  /**
   * Report an error at `error` level on the default channel, with its stack and cause chain. Never
   * throws, whatever is passed (thrown strings and objects too).
   *
   * @example
   * try { await charge() } catch (error) { Log.report(error, { orderId }) }
   */
  report(error: unknown, fields?: LogFields): void
}

/** Options for {@link createLogManager}. Everything is optional. */
export interface LogManagerOptions<T extends LoggingConfig = LoggingConfig> {
  /** `config/logging`. Default: the built-in channels, filled in from `.env`. */
  readonly config?: T
  /** Environment to read. Default: `process.env`. */
  readonly env?: Env
  /** Project root for relative paths. Default: the working directory. */
  readonly root?: string
  /**
   * The worker id of an additional process, which then writes its own files
   * (`…worker-<id>.log`). Default: automatic (cluster workers use their id, worker threads
   * `t<threadId>`), else `LOG_WORKER_ID` (set by the process manager), else none. `false`: none.
   */
  readonly workerId?: string | false
  /** Extra redaction keys and patterns (added to the built-in rules; they can't be turned off). */
  readonly sanitize?: Partial<Pick<SanitizeOptions, 'extraKeys' | 'extraPatterns'>>
  /** Bindings added to every record. */
  readonly bindings?: LogFields
  /** Maximum size of one record, per line. Default: 32 KB. */
  readonly maxRecordBytes?: number
  /** Queue limits per channel. Default: 10,000 records / 16 MB. */
  readonly queue?: Partial<QueueLimits>
  /** Maximum size of one write. Default: 256 KB. */
  readonly maxBatchBytes?: number
  /** Retry a failing channel this long after a failure. Default: 30 s. */
  readonly retryPrimaryMs?: number
  /** Where request context comes from. Default: this package's AsyncLocalStorage store. */
  readonly context?: ContextGetter
  /** Drain on SIGTERM/SIGINT/beforeExit. Default: `false` (the default `Log` turns it on). */
  readonly handleShutdown?: boolean
  /** Deadline for the shutdown drain. Default: 2,000 ms. */
  readonly shutdownTimeoutMs?: number
  /** Streams for the `stdout`/`stderr` channels and the fallback (tests). */
  readonly streams?: { readonly stdout?: WritableLike; readonly stderr?: WritableLike }
  /** How the slack channel sends (tests). Default: the SSRF-safe HTTPS client. */
  readonly slackPost?: WebhookPost
  /** Injectable clock (epoch ms), for tests. */
  readonly now?: () => number
}

/**
 * The automatic worker id of this process or thread, if it needs its own files: cluster workers
 * use their worker id and worker threads `t<threadId>`; the main process needs none.
 */
export function automaticWorkerId(env: Env = process.env): string | undefined {
  if (cluster.isWorker && cluster.worker) return String(cluster.worker.id)
  if (!isMainThread) return `t${threadId}`
  const fromEnv = env['LOG_WORKER_ID']?.trim()
  return fromEnv && isWorkerId(fromEnv) ? fromEnv : undefined
}

/** A transport that always fails with `error` (a custom channel whose factory threw). */
function failingTransport(name: string, error: unknown): Transport {
  return {
    name,
    write: () => Promise.reject(error),
    close: () => Promise.resolve(),
  }
}

/**
 * Create a log manager (the object behind `Log`).
 *
 * @throws LoggingConfigError when `config` is invalid (mistakes in `.env` only warn)
 *
 * @example
 * const Log = createLogManager({ config: defineLoggingConfig({ channels: { payments: { driver: 'daily', name: 'payments' } } }) })
 * Log.channel('payments').info('Paid', { invoiceId: 42 })
 */
export function createLogManager<const T extends LoggingConfig = LoggingConfig>(
  options: LogManagerOptions<T> = {},
): LogManager<ChannelName<T>> {
  const env = options.env ?? process.env
  const root = options.root ?? process.cwd()
  const { config, issues } = resolveLoggingConfig(options.config ?? {}, { env, root })
  const workerId =
    options.workerId === false ? undefined : (options.workerId ?? automaticWorkerId(env))
  if (workerId !== undefined && !isWorkerId(workerId))
    throw new RangeError(`invalid workerId "${workerId}": use letters, digits and _ only`)
  const now = options.now ?? Date.now
  const sanitize: Sanitizer = createSanitizer({
    ...(options.sanitize?.extraKeys ? { extraKeys: options.sanitize.extraKeys } : {}),
    ...(options.sanitize?.extraPatterns ? { extraPatterns: options.sanitize.extraPatterns } : {}),
  })
  const stderr = options.streams?.stderr ?? process.stderr
  const formatters = new Map<LogFormat, Formatter>()
  const formatter = (format: LogFormat): Formatter => {
    let f = formatters.get(format)
    if (!f) {
      f = createFormatter(format, { env: config.env })
      formatters.set(format, f)
    }
    return f
  }

  // Context shared by every channel: Log.shareContext (shared) and process-wide Log.withContext
  // (ambient). Merged lazily, and only re-merged after a change.
  const shared: Record<string, unknown> = {}
  const ambient: Record<string, unknown> = {}
  let merged: LogFields | undefined
  let dirty = false
  const base = (): LogFields | undefined => {
    if (dirty) {
      merged =
        Object.keys(shared).length + Object.keys(ambient).length > 0
          ? { ...shared, ...ambient }
          : undefined
      dirty = false
    }
    return merged
  }

  const sinks = new Map<string, Sink | null>()
  const allSinks: Sink[] = []
  const loggers = new Map<string, StrutvaneLogger>()
  const built = new Map<string, StrutvaneLogger>()
  const reportedUnknown = new Set<string>()

  const makeSink = (name: string | undefined, channel: ResolvedChannel): Sink | null => {
    const common = {
      fallback: stderrTransport(stderr),
      ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
      ...(options.queue ? { queue: options.queue } : {}),
      ...(options.maxBatchBytes === undefined ? {} : { maxBatchBytes: options.maxBatchBytes }),
      ...(options.retryPrimaryMs === undefined ? {} : { retryPrimaryMs: options.retryPrimaryMs }),
      now,
    }
    const label = name ?? 'build'
    switch (channel.driver) {
      case 'null':
      case 'stack':
        return null
      case 'single':
      case 'daily':
        return createSink({
          ...common,
          name: label,
          level: channel.level,
          format: formatter(channel.format),
          transport: fileTransport({
            dir: channel.dir,
            base: channel.base,
            mode: channel.driver,
            maxFileBytes: channel.maxFileBytes,
            days: channel.days,
            ...(workerId === undefined ? {} : { worker: workerId }),
            now,
          }),
        })
      case 'stderr':
      case 'stdout':
        return createSink({
          ...common,
          name: label,
          level: channel.level,
          format: formatter(channel.format),
          transport:
            channel.driver === 'stdout'
              ? stdoutTransport(options.streams?.stdout ?? process.stdout)
              : stderrTransport(stderr),
        })
      case 'slack':
        return createSink({
          ...common,
          name: label,
          level: channel.level,
          // The Slack transport reads records back, so its lines are always JSON.
          format: formatter('json'),
          transport: slackTransport({
            url: channel.url,
            channel: label,
            env: config.env,
            username: channel.username,
            emoji: channel.emoji,
            minIntervalMs: channel.minIntervalMs,
            ...(options.slackPost ? { post: options.slackPost } : {}),
            onError: (error) => {
              // Quoted outside the sanitiser: redacted and capped like a fallback warning.
              const text = describeTransportError(error)['message']
              const line = formatter(config.format)(
                {
                  time: new Date(now()).toISOString(),
                  level: 'warning',
                  msg: `logs: channel "${label}" could not send a summary to Slack`,
                  fields: { error: text },
                },
                4096,
              )
              stderrTransport(stderr)
                .write({ text: line, bytes: Buffer.byteLength(line), records: 1, dayKey: '' })
                .catch(() => undefined)
            },
            now,
          }),
        })
      case 'custom': {
        const context: CustomChannelContext = {
          name,
          level: channel.level,
          format: channel.format,
          env: config.env,
          path: config.path,
        }
        let transport: Transport
        try {
          transport = channel.via(context)
        } catch (error) {
          transport = failingTransport(label, error)
        }
        return createSink({
          ...common,
          name: label,
          level: channel.level,
          format: formatter(channel.format),
          transport,
        })
      }
    }
  }

  /** A declared channel, never an inherited property (`toString`, `__proto__`, …). */
  const declared = (name: string): ResolvedChannel | undefined =>
    Object.hasOwn(config.channels, name) ? config.channels[name] : undefined

  const sinkFor = (name: string): Sink | null => {
    if (sinks.has(name)) return sinks.get(name) ?? null
    const channel = declared(name)
    const sink = channel ? makeSink(name, channel) : null
    sinks.set(name, sink)
    if (sink) allSinks.push(sink)
    return sink
  }

  const leavesOf = (name: string): readonly string[] => {
    const channel = declared(name)
    if (!channel) return []
    return channel.driver === 'stack' ? channel.leaves : [name]
  }

  const emitterFor = (key: string, leafNames: readonly string[]): StrutvaneLogger => {
    let logger = loggers.get(key)
    if (!logger) {
      const unique = [...new Set(leafNames)]
      const list = unique.map(sinkFor).filter((s): s is Sink => s !== null)
      logger = createEmitter(
        {
          sinks: list,
          sanitize,
          ...(options.context ? { context: options.context } : {}),
          base,
          now,
        },
        options.bindings ?? {},
      )
      loggers.set(key, logger)
    }
    return logger
  }

  const defaultLogger = (): StrutvaneLogger =>
    emitterFor(`channel:${config.default}`, leavesOf(config.default))

  const unknownChannel = (name: string): void => {
    // Bounded: names may come from input, and the reminder only needs to be said once each.
    if (reportedUnknown.has(name) || reportedUnknown.size >= 100) return
    reportedUnknown.add(name)
    defaultLogger().error(
      `logs: channel "${name}" is not defined in config/logging; writing to "${config.default}" instead. Defined channels: ${Object.keys(config.channels).join(', ')}`,
      { component: 'logs.config' },
    )
  }

  const channel = (name?: string): StrutvaneLogger => {
    const wanted = name ?? config.default
    if (!Object.hasOwn(config.channels, wanted)) {
      unknownChannel(wanted)
      return defaultLogger()
    }
    return emitterFor(`channel:${wanted}`, leavesOf(wanted))
  }

  const stack = (names: readonly string[]): StrutvaneLogger => {
    const leaves: string[] = []
    for (const name of names) {
      if (Object.hasOwn(config.channels, name)) leaves.push(...leavesOf(name))
      else unknownChannel(name)
    }
    if (leaves.length === 0 && names.every((n) => !Object.hasOwn(config.channels, n)))
      return defaultLogger()
    // Keyed by the leaves it writes to, so the cache stays bounded by the configured channels.
    return emitterFor(`stack:${[...new Set(leaves)].join(',')}`, leaves)
  }

  const build = (channelConfig: ChannelConfig): StrutvaneLogger => {
    const resolved = resolveChannelConfig(channelConfig, config, { root, env })
    const key = cacheKey(resolved)
    const cached = key === undefined ? undefined : built.get(key)
    if (cached) return cached
    const sink = makeSink(undefined, resolved)
    if (sink) allSinks.push(sink)
    const logger = createEmitter(
      {
        sinks: sink ? [sink] : [],
        sanitize,
        ...(options.context ? { context: options.context } : {}),
        base,
        now,
      },
      options.bindings ?? {},
    )
    if (key !== undefined) built.set(key, logger)
    return logger
  }

  const forAll = async (fn: (sink: Sink) => Promise<FlushResult>): Promise<FlushResult> => {
    const results = await Promise.all(allSinks.map(fn))
    return {
      flushed: results.every((r) => r.flushed),
      pending: results.reduce((n, r) => n + r.pending, 0),
    }
  }

  let unregister: (() => void) | undefined
  const manager: LogManager<string> = {
    config,
    issues,
    get level(): Level {
      return defaultLogger().level
    },
    emergency: (m, f) => defaultLogger().emergency(m, f),
    alert: (m, f) => defaultLogger().alert(m, f),
    critical: (m, f) => defaultLogger().critical(m, f),
    error: (m, f) => defaultLogger().error(m, f),
    warning: (m, f) => defaultLogger().warning(m, f),
    notice: (m, f) => defaultLogger().notice(m, f),
    info: (m, f) => defaultLogger().info(m, f),
    debug: (m, f) => defaultLogger().debug(m, f),
    trace: (m, f) => defaultLogger().trace(m, f),
    warn: (m, f) => defaultLogger().warn(m, f),
    fatal: (m, f) => defaultLogger().fatal(m, f),
    log: (level, m, f) => defaultLogger().log(level, m, f),
    child: (bindings) => defaultLogger().child(bindings),
    isLevelEnabled: (level) => defaultLogger().isLevelEnabled(level),
    channel,
    stack,
    build,
    withContext(values) {
      if (!addToLogContext(values)) {
        Object.assign(ambient, values)
        dirty = true
      }
      return manager
    },
    withoutContext(keys) {
      if (!removeFromLogContext(keys)) {
        for (const key of keys ?? Object.keys(ambient)) delete ambient[key]
        dirty = true
      }
      return manager
    },
    shareContext(values) {
      Object.assign(shared, values)
      dirty = true
      return manager
    },
    sharedContext: () => ({ ...shared }),
    flushSharedContext() {
      for (const key of Object.keys(shared)) delete shared[key]
      dirty = true
      return manager
    },
    deprecation: (m, f) => channel(config.deprecations).warning(m, f),
    report(error, fields) {
      try {
        const message =
          error instanceof Error
            ? error.message || error.name
            : typeof error === 'string'
              ? error
              : 'Unhandled non-error value'
        const extra: LogFields =
          error instanceof Error
            ? { err: error }
            : typeof error === 'string'
              ? {}
              : { thrown: error }
        defaultLogger().error(message, { ...fields, ...extra })
      } catch {
        // report() must never throw, even for a hostile value.
      }
    },
    flush: async (timeoutMs = 5_000) => {
      await forAll((s) => s.drain(timeoutMs))
    },
    drain: (timeoutMs = 5_000) => forAll((s) => s.drain(timeoutMs)),
    close: async (timeoutMs = 5_000) => {
      unregister?.()
      return forAll((s) => s.close(timeoutMs))
    },
    stats: () => sumStats(allSinks),
  }

  for (const issue of issues)
    defaultLogger().warning(`logs: ${issue.message}`, { component: 'logs.config', key: issue.key })
  if (options.handleShutdown)
    unregister = registerShutdownFlush(manager, { timeoutMs: options.shutdownTimeoutMs ?? 2_000 })
  return manager as LogManager<ChannelName<T>>
}

/** A stable cache key for a built channel, or `undefined` when it holds a function. */
function cacheKey(channel: ResolvedChannel): string | undefined {
  if (channel.driver === 'custom') return undefined
  return JSON.stringify(Object.entries(channel).sort(([a], [b]) => (a < b ? -1 : 1)))
}

function sumStats(sinks: readonly Sink[]): LoggerStats {
  return createEmitter({ sinks, sanitize: (v) => v }).stats()
}

/** Built-in channel names, re-exported for typed helpers. */
export type { BuiltInChannel }
