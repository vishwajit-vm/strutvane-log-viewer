/**
 * `@strutvane/logs`: Laravel-style logging for TypeScript apps (RFC-0004, ADR-0015, ADR-0022).
 *
 * ```ts
 * import { Log } from '@strutvane/logs'
 * Log.info('Invoice sent', { invoiceId: invoice.id })
 * Log.channel('payments').warning('Card declined')
 * ```
 *
 * - **Channels** (`single`, `daily`, `stack`, `stderr`, `stdout`, `slack`, `null`, `custom`) come
 *   from `config/logging` and `.env` (`LOG_CHANNEL`, `LOG_STACK`, `LOG_LEVEL`, …).
 * - **Request logging:** `@strutvane/logs/http`, with adapters `/node`, `/hono` and `/express`.
 * - **The viewer:** `@strutvane/logs/viewer`. **Commands:** `@strutvane/logs/commands`.
 *
 * @packageDocumentation
 */
export type { LogError, LogFields, Logger, LogRecord } from '@strutvane/contracts'
export type {
  BuiltInChannel,
  ChannelConfig,
  ChannelName,
  CustomChannelConfig,
  CustomChannelContext,
  Driver,
  Env,
  FileChannelConfig,
  LoggingConfig,
  LoggingConfigResult,
  LoggingIssue,
  NullChannelConfig,
  ResolvedChannel,
  ResolvedFileChannel,
  ResolvedLoggingConfig,
  ResolveOptions,
  SlackChannelConfig,
  StackChannelConfig,
  StreamChannelConfig,
} from './config.ts'
export {
  BUILT_IN_CHANNELS,
  DRIVERS,
  defineLoggingConfig,
  LoggingConfigError,
  MIN_FILE_BYTES,
  parseSize,
  resolveChannelConfig,
  resolveLoggingConfig,
  resolveLogPath,
} from './config.ts'
export type { ContextGetter, LogContext } from './context.ts'
export {
  addToLogContext,
  getLogContext,
  removeFromLogContext,
  runWithLogContext,
} from './context.ts'
export type { AnyChannel } from './default.ts'
export { getLogManager, Log, log, logger, report, setLogManager } from './default.ts'
export type {
  ClearOptions,
  ClearResult,
  LogFileKind,
  LogFileName,
  LogFileNameParts,
  RetentionOptions,
} from './files.ts'
export {
  applyRetention,
  clearLogFiles,
  compareLogFiles,
  DEFAULT_BASES,
  DEFAULT_LOG_BASE,
  dayKeyOf,
  fileDay,
  isDayKey,
  isLogBaseName,
  isWorkerId,
  LOG_FILE_PATTERN,
  listLogFiles,
  logFileName,
  newestPerStream,
  parseLogFileName,
  shiftDay,
  streamKey,
} from './files.ts'
export type { Formatter, LogFormat } from './format/formatter.ts'
export { createFormatter, isLogFormat, LOG_FORMATS } from './format/formatter.ts'
export {
  envLabel,
  escapeMessage,
  formatLine,
  LINE_RESERVED_KEYS,
  unescapeMessage,
} from './format/line.ts'
export type { ParsedRecord } from './format/parse.ts'
export { parseLogLine } from './format/parse.ts'
export type { Level, LevelAlias, LevelName } from './levels.ts'
export {
  IMPORTANT_PRIORITY,
  isLevel,
  isLevelName,
  LEVEL_ALIASES,
  LEVEL_PRIORITY,
  LEVELS,
  priorityOf,
  RFC5424_CODE,
  toLevel,
} from './levels.ts'
export type {
  EmitterOptions,
  FlushResult,
  LevelMethods,
  LoggerStats,
  LogMethod,
  PipelineOptions,
  StrutvaneLogger,
} from './logger.ts'
export { createEmitter, createPipelineLogger } from './logger.ts'
export type { LogManager, LogManagerOptions } from './manager.ts'
export { automaticWorkerId, createLogManager } from './manager.ts'
export type { LookupAll, SafePostOptions, VettedTarget } from './net/safe-http.ts'
export { isBlockedAddress, safePost, UnsafeUrlError, vetUrl } from './net/safe-http.ts'
export { createNoopLogger } from './noop.ts'
export type { PushResult, QueueItem, QueueLimits } from './queue.ts'
export { BoundedQueue, DEFAULT_QUEUE_LIMITS } from './queue.ts'
export type { FileLine, LogFileInfo } from './read.ts'
export { describeFiles, readLinesBackward, readRange } from './read.ts'
export type { PatternRule, SanitizeOptions, Sanitizer } from './redact.ts'
export {
  createSanitizer,
  DEFAULT_SANITIZE,
  looksLikeCardNumber,
  luhnValid,
  normaliseKey,
  REDACTED,
  redactString,
  registerSensitiveKeys,
} from './redact.ts'
export { DEFAULT_MAX_RECORD_BYTES, serializeRecord } from './serialize.ts'
export type { ShutdownOptions } from './shutdown.ts'
export { registerShutdownFlush } from './shutdown.ts'
export type { Sink, SinkOptions } from './sink.ts'
export { createSink } from './sink.ts'
export { stderrTransport, stdoutTransport, streamTransport } from './transports/console.ts'
export type { FileTransport, FileTransportOptions } from './transports/file.ts'
export { appendFileWriter, DEFAULT_MAX_FILE_BYTES, fileTransport } from './transports/file.ts'
export type { SlackTransportOptions, WebhookPost } from './transports/slack.ts'
export { slackEscape, slackTransport } from './transports/slack.ts'
export type {
  Batch,
  FileWriter,
  FileWriterFactory,
  Transport,
  WritableLike,
} from './transports/types.ts'
