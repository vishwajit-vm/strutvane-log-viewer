/**
 * The zero-config `Log` facade, plus Laravel's `logger()` and `report()` helpers (ADR-0022 §7).
 *
 * `Log` is created lazily on first use (importing the package has no side effects): it reads
 * `.env`, uses the built-in channels, and drains on shutdown. In a Strutvane app the provider
 * replaces it, through {@link setLogManager}, with one built from `config/logging`.
 *
 * `log` is the same object under its v1 name.
 *
 * @module
 */
import type { LogFields } from '@strutvane/contracts'
import type {
  BuiltInChannel,
  LoggingConfig,
  LoggingIssue,
  ResolvedLoggingConfig,
} from './config.ts'
import type { Level, LevelName } from './levels.ts'
import type { FlushResult, LoggerStats } from './logger.ts'
import { createLogManager, type LogManager } from './manager.ts'

/** Channel names the default facade accepts: the built-ins, plus any name your config adds. */
export type AnyChannel = BuiltInChannel | (string & {})

let instance: LogManager<AnyChannel> | undefined

function current(): LogManager<AnyChannel> {
  instance ??= createLogManager<LoggingConfig>({ handleShutdown: true })
  return instance
}

/**
 * Replace the manager behind `Log` (the app provider does this with `config/logging`; tests use it
 * too). Pass `undefined` to go back to the lazy default.
 *
 * @example
 * setLogManager(createLogManager({ config: appConfig.logging }))
 */
export function setLogManager(manager: LogManager<string> | undefined): void {
  instance = manager
}

/** The manager currently behind `Log` (created on first use). */
export function getLogManager(): LogManager<AnyChannel> {
  return current()
}

/**
 * The `Log` facade: log to the default channel, pick a channel or a stack, add context.
 *
 * @example
 * import { Log } from '@strutvane/logs'
 * Log.info('Invoice sent', { invoiceId })
 * Log.channel('payments').warning('Card declined')
 * Log.withContext({ orderId })
 */
export const Log: LogManager<AnyChannel> = {
  get config(): ResolvedLoggingConfig {
    return current().config
  },
  get issues(): readonly LoggingIssue[] {
    return current().issues
  },
  get level(): Level {
    return current().level
  },
  emergency: (m: string, f?: LogFields) => current().emergency(m, f),
  alert: (m: string, f?: LogFields) => current().alert(m, f),
  critical: (m: string, f?: LogFields) => current().critical(m, f),
  error: (m: string, f?: LogFields) => current().error(m, f),
  warning: (m: string, f?: LogFields) => current().warning(m, f),
  notice: (m: string, f?: LogFields) => current().notice(m, f),
  info: (m: string, f?: LogFields) => current().info(m, f),
  debug: (m: string, f?: LogFields) => current().debug(m, f),
  trace: (m: string, f?: LogFields) => current().trace(m, f),
  warn: (m: string, f?: LogFields) => current().warn(m, f),
  fatal: (m: string, f?: LogFields) => current().fatal(m, f),
  log: (level: LevelName, m: string, f?: LogFields) => current().log(level, m, f),
  child: (bindings: LogFields) => current().child(bindings),
  isLevelEnabled: (level: LevelName) => current().isLevelEnabled(level),
  channel: (name?: AnyChannel) => current().channel(name),
  stack: (channels: readonly AnyChannel[]) => current().stack(channels),
  build: (config) => current().build(config),
  withContext(values: LogFields) {
    current().withContext(values)
    return Log
  },
  withoutContext(keys?: readonly string[]) {
    current().withoutContext(keys)
    return Log
  },
  shareContext(values: LogFields) {
    current().shareContext(values)
    return Log
  },
  sharedContext: () => current().sharedContext(),
  flushSharedContext() {
    current().flushSharedContext()
    return Log
  },
  deprecation: (m: string, f?: LogFields) => current().deprecation(m, f),
  report: (error: unknown, f?: LogFields) => current().report(error, f),
  flush: (timeoutMs?: number) => current().flush(timeoutMs),
  drain: (timeoutMs?: number): Promise<FlushResult> => current().drain(timeoutMs),
  close: (timeoutMs?: number): Promise<FlushResult> => current().close(timeoutMs),
  stats: (): LoggerStats => current().stats(),
}

/** The v1 name of {@link Log} (a `StrutvaneLogger` for the default channel, and more). */
export const log: LogManager<AnyChannel> = Log

/**
 * Laravel's `logger()` helper: with no arguments it returns `Log`; with a message it logs it at
 * `debug` on the default channel.
 *
 * @example
 * logger('Cache warmed', { keys: 120 })
 * logger().channel('payments').info('Paid')
 */
export function logger(): LogManager<AnyChannel>
export function logger(msg: string, fields?: LogFields): void
export function logger(msg?: string, fields?: LogFields): LogManager<AnyChannel> | undefined {
  if (msg === undefined) return Log
  Log.debug(msg, fields)
  return undefined
}

/**
 * Laravel's `report()` helper: log an error (with its stack and cause chain) at `error` on the
 * default channel, and carry on. Never throws.
 *
 * @example
 * try { await sync() } catch (error) { report(error, { job: 'sync' }) }
 */
export function report(error: unknown, fields?: LogFields): void {
  Log.report(error, fields)
}
