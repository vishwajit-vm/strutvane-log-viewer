/**
 * `config/logging`: channels, and how `.env` fills them in (ADR-0022 §2–§3). The shape follows
 * Laravel's `config/logging.php`.
 *
 * ```ts
 * // config/logging.ts
 * export default defineLoggingConfig({
 *   default: 'stack',
 *   channels: {
 *     payments: { driver: 'daily', name: 'payments', level: 'info', days: 90 },
 *     audit: { driver: 'stack', channels: ['daily', 'payments'] },
 *   },
 * })
 * ```
 *
 * Built-in channels (each can be replaced by one with the same name): `stack`, `single`, `daily`,
 * `slack`, `stderr`, `stdout` and `null`.
 *
 * | `.env` key | Default | Used for |
 * |---|---|---|
 * | `LOG_CHANNEL` | `stack` | the default channel |
 * | `LOG_STACK` | `daily` | the channels of the built-in `stack`, comma-separated |
 * | `LOG_LEVEL` | `debug` when `APP_ENV=local`, else `info` | every channel without its own `level` (Slack: `critical`) |
 * | `LOG_DAILY_DAYS` | `14` | days a `daily` channel keeps (0 = forever) |
 * | `LOG_FORMAT` | `line` | `line` or `json` for file and console channels |
 * | `LOG_MAX_FILE_SIZE` | `100mb` | size of one file before the next part starts |
 * | `LOG_PATH` | `storage/logs` | the log directory, relative to the project root |
 * | `LOG_SLACK_WEBHOOK_URL` | none | the `slack` channel's webhook (https only) |
 * | `LOG_DEPRECATIONS_CHANNEL` | `null` | where `Log.deprecation()` writes |
 *
 * Two kinds of mistakes, two behaviours (as in v1):
 * - **A mistake in the config file throws** a {@link LoggingConfigError} at startup, listing every
 *   problem with a hint. It's code, so it should fail fast and loudly.
 * - **A mistake in `.env` never crashes the app.** The default is used and a friendly warning is
 *   reported (and logged once), telling you which key to fix. Logging must not take an app down
 *   because of a typo in an environment variable.
 *
 * @module
 */
import { isAbsolute, resolve } from 'node:path'
import { DEFAULT_LOG_BASE, isLogBaseName } from './files.ts'
import { isLogFormat, LOG_FORMATS, type LogFormat } from './format/formatter.ts'
import { LEVELS, type Level, type LevelName, toLevel } from './levels.ts'
import type { Transport } from './transports/types.ts'

/** Environment variables as read from `process.env` (only strings matter). */
export type Env = Readonly<Record<string, string | undefined>>

/** The channel drivers (ADR-0022 §2). */
export const DRIVERS = [
  'single',
  'daily',
  'stack',
  'stderr',
  'stdout',
  'slack',
  'null',
  'custom',
] as const

/** A channel driver. */
export type Driver = (typeof DRIVERS)[number]

/** The channels every app has, unless the config replaces them. */
export const BUILT_IN_CHANNELS = [
  'stack',
  'single',
  'daily',
  'slack',
  'stderr',
  'stdout',
  'null',
] as const

/** A built-in channel name. */
export type BuiltInChannel = (typeof BUILT_IN_CHANNELS)[number]

interface LevelOption {
  /** Minimum level this channel writes. Default: `LOG_LEVEL`. Aliases are accepted. */
  readonly level?: LevelName
}

interface FormatOption {
  /** `line` or `json`. Default: `LOG_FORMAT`. */
  readonly format?: LogFormat
}

/** `single` (one file) or `daily` (one file per UTC day). */
export interface FileChannelConfig extends LevelOption, FormatOption {
  readonly driver: 'single' | 'daily'
  /** Directory, relative to the project root. Default: `LOG_PATH`. */
  readonly path?: string
  /** File base name (letters, digits, `_`): `payments` → `payments-2026-11-15.log`. Default: `strutvane`. */
  readonly name?: string
  /** Size of one file before the next part starts, e.g. `'50mb'` or a byte count. Default: `LOG_MAX_FILE_SIZE`. */
  readonly maxFileSize?: string | number
  /** `daily` only: days to keep, today included; 0 keeps everything. Default: `LOG_DAILY_DAYS`. */
  readonly days?: number
}

/** `stderr` / `stdout`, for containers. */
export interface StreamChannelConfig extends LevelOption, FormatOption {
  readonly driver: 'stderr' | 'stdout'
}

/** `stack`: sends every record to several channels. */
export interface StackChannelConfig {
  readonly driver: 'stack'
  /** Channel names; stacks may include stacks, but never themselves (directly or not). */
  readonly channels: readonly string[]
}

/** `slack`: important records to an incoming webhook, rate-limited. */
export interface SlackChannelConfig extends LevelOption {
  readonly driver: 'slack'
  /** The webhook URL (https only). Default: `LOG_SLACK_WEBHOOK_URL`. */
  readonly url?: string
  /** Display name of the message sender. Default: `Strutvane Log`. */
  readonly username?: string
  /** Emoji of the message sender. Default: `:boom:`. */
  readonly emoji?: string
  /** At most one message per this many milliseconds; the rest is counted. Default: 10,000. */
  readonly minIntervalMs?: number
}

/** `null`: discards every record. */
export interface NullChannelConfig {
  readonly driver: 'null'
}

/** What a custom channel's factory receives. */
export interface CustomChannelContext {
  /** The channel name (`undefined` for `Log.build`). */
  readonly name: string | undefined
  readonly level: Level
  readonly format: LogFormat
  /** `APP_ENV`, as shown in `line` headers. */
  readonly env: string
  /** The resolved log directory (`LOG_PATH`). */
  readonly path: string
}

/** `custom`: your own transport (a log shipper, a database, …). */
export interface CustomChannelConfig extends LevelOption, FormatOption {
  readonly driver: 'custom'
  /** Returns the transport. Called once, the first time the channel is used. */
  readonly via: (context: CustomChannelContext) => Transport
}

/** One channel in `config/logging`. */
export type ChannelConfig =
  | FileChannelConfig
  | StreamChannelConfig
  | StackChannelConfig
  | SlackChannelConfig
  | NullChannelConfig
  | CustomChannelConfig

/** `config/logging`, as written by the app. Everything is optional. */
export interface LoggingConfig {
  /** The default channel. Default: `LOG_CHANNEL`, else `stack`. */
  readonly default?: string
  /** Channels, merged over the built-ins (same name replaces). */
  readonly channels?: Readonly<Record<string, ChannelConfig>>
  /** The channel for `Log.deprecation()`. Default: `LOG_DEPRECATIONS_CHANNEL`, else `null`. */
  readonly deprecations?: string
  /** The default log directory. Default: `LOG_PATH`, else `storage/logs`. */
  readonly path?: string
}

/** A resolved `single`/`daily` channel. */
export interface ResolvedFileChannel {
  readonly driver: 'single' | 'daily'
  readonly level: Level
  readonly format: LogFormat
  /** Absolute directory. */
  readonly dir: string
  readonly base: string
  readonly maxFileBytes: number
  /** Days kept (`daily`); 0 for `single` and for "keep forever". */
  readonly days: number
}

/** A resolved channel: every default applied. */
export type ResolvedChannel =
  | ResolvedFileChannel
  | { readonly driver: 'stderr' | 'stdout'; readonly level: Level; readonly format: LogFormat }
  | {
      readonly driver: 'stack'
      readonly channels: readonly string[]
      /** The non-stack channels it ends up writing to, in order, each once. */
      readonly leaves: readonly string[]
    }
  | {
      readonly driver: 'slack'
      readonly level: Level
      readonly url: string | undefined
      readonly username: string
      readonly emoji: string
      readonly minIntervalMs: number
    }
  | { readonly driver: 'null' }
  | {
      readonly driver: 'custom'
      readonly level: Level
      readonly format: LogFormat
      readonly via: (context: CustomChannelContext) => Transport
    }

/** The resolved configuration. */
export interface ResolvedLoggingConfig {
  readonly default: string
  readonly deprecations: string
  readonly channels: Readonly<Record<string, ResolvedChannel>>
  /** Absolute default log directory. */
  readonly path: string
  /** `APP_ENV` (raw; `line` headers clean it up). */
  readonly env: string
  /** `LOG_LEVEL`, resolved. */
  readonly level: Level
  /** `LOG_FORMAT`, resolved. */
  readonly format: LogFormat
}

/** A non-fatal problem in `.env`, with the fallback that was used. */
export interface LoggingIssue {
  /** The environment variable to fix. */
  readonly key: string
  readonly message: string
}

/** Resolution result. */
export interface LoggingConfigResult {
  readonly config: ResolvedLoggingConfig
  /** Problems found in `.env` (the defaults were used instead). */
  readonly issues: readonly LoggingIssue[]
}

/** Options for {@link resolveLoggingConfig}. */
export interface ResolveOptions {
  /** Environment to read. Default: `process.env`. */
  readonly env?: Env
  /** Project root that relative paths start from. Default: the working directory. */
  readonly root?: string
}

/**
 * The config file is wrong. The message lists every problem with a hint, e.g.
 *
 * ```
 * config/logging is invalid:
 *   - channels.audit: stack "audit" → "payments" → "audit" loops; a stack can't contain itself
 *   - channels.payments.level: "loud" is not a level; use one of debug, info, …
 * ```
 */
export class LoggingConfigError extends Error {
  override readonly name = 'LoggingConfigError'
  /** Stable code for tooling. */
  readonly code = 'LOGGING_CONFIG_INVALID'
  /** One entry per problem. */
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`config/logging is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.problems = problems
  }
}

const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
}

/** The smallest accepted file size: smaller caps would rotate on almost every write. */
export const MIN_FILE_BYTES = 1024

/**
 * Parse a size such as `100mb`, `512KB`, `1.5g` or `1048576` into bytes. Returns `undefined` when
 * the text isn't a size, or is below 1 KB.
 *
 * @example
 * parseSize('100mb') // 104857600
 * parseSize('ten')   // undefined
 */
export function parseSize(value: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb?|mb?|gb?)?\s*$/i.exec(value)
  if (!m?.[1]) return undefined
  const bytes = Math.floor(Number(m[1]) * (UNITS[(m[2] ?? 'b').toLowerCase()] ?? 1))
  return bytes >= MIN_FILE_BYTES && Number.isSafeInteger(bytes) ? bytes : undefined
}

/**
 * Keep the literal channel names of a config, so `Log.channel()` only accepts names that exist.
 *
 * @example
 * export default defineLoggingConfig({ channels: { payments: { driver: 'daily', name: 'payments' } } })
 */
export function defineLoggingConfig<const T extends LoggingConfig>(config: T): T {
  return config
}

/** Channel names of a config: the built-ins plus its own (for typed `Log.channel()`). */
export type ChannelName<T extends LoggingConfig> =
  | BuiltInChannel
  | (T['channels'] extends Readonly<Record<string, ChannelConfig>>
      ? Extract<keyof T['channels'], string>
      : never)

const CHANNEL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const LEVEL_HINT = `use one of ${LEVELS.join(', ')} (or the aliases trace, warn, fatal)`
const FORMAT_HINT = `use ${LOG_FORMATS.join(' or ')}`

/** Reads `.env` values, collecting friendly issues instead of throwing. */
class EnvReader {
  readonly issues: LoggingIssue[] = []
  private readonly env: Env

  constructor(env: Env) {
    this.env = env
  }

  raw(key: string): string | undefined {
    const value = this.env[key]
    return value === undefined || value.trim() === '' ? undefined : value.trim()
  }

  read<T>(key: string, parse: (v: string) => T | undefined, fallback: T, hint: string): T {
    const value = this.raw(key)
    if (value === undefined) return fallback
    const parsed = parse(value)
    if (parsed !== undefined) return parsed
    this.warn(key, `${key}="${value}" is not valid (${hint}); using ${String(fallback)}`)
    return fallback
  }

  warn(key: string, message: string): void {
    this.issues.push({ key, message })
  }

  /** A v1 name (`LOGS_*`) still set: use it once, and say what it's called now. */
  legacy(oldKey: string, newKey: string): string | undefined {
    const value = this.raw(oldKey)
    if (value === undefined || this.raw(newKey) !== undefined) return undefined
    this.warn(oldKey, `${oldKey} is the v1 name; rename it to ${newKey}`)
    return value
  }
}

function parseDays(v: string): number | undefined {
  return /^\d{1,5}$/.test(v) ? Number(v) : undefined
}

function httpsUrl(v: string): string | undefined {
  try {
    const url = new URL(v)
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? v : undefined
  } catch {
    return undefined
  }
}

/** The environment-driven defaults every channel starts from. */
interface Defaults {
  readonly local: boolean
  readonly appEnv: string
  readonly level: Level
  readonly format: LogFormat
  readonly days: number
  readonly maxFileBytes: number
  readonly path: string
  readonly channel: string | undefined
  readonly stack: readonly string[]
  readonly slackUrl: string | undefined
  readonly deprecations: string
}

function readDefaults(reader: EnvReader, root: string): Defaults {
  const appEnv = reader.raw('APP_ENV') ?? 'production'
  const local = appEnv.toLowerCase() === 'local'
  const level = reader.read('LOG_LEVEL', toLevel, local ? 'debug' : 'info', LEVEL_HINT)
  const format = reader.read<LogFormat>(
    'LOG_FORMAT',
    (v) => {
      const f = v.toLowerCase()
      if (f === 'pretty') {
        reader.warn('LOG_FORMAT', 'LOG_FORMAT=pretty is the v1 name; use line')
        return 'line'
      }
      return isLogFormat(f) ? f : undefined
    },
    'line',
    FORMAT_HINT,
  )
  const legacyDays = reader.legacy('LOGS_RETENTION_DAYS', 'LOG_DAILY_DAYS')
  const days =
    legacyDays === undefined
      ? reader.read('LOG_DAILY_DAYS', parseDays, 14, 'use a whole number of days, 0 keeps all')
      : (parseDays(legacyDays) ?? 14)
  const legacySize = reader.legacy('LOGS_MAX_DAILY_SIZE', 'LOG_MAX_FILE_SIZE')
  const maxFileBytes =
    legacySize === undefined
      ? reader.read(
          'LOG_MAX_FILE_SIZE',
          parseSize,
          100 * 1024 ** 2,
          'use a size like 100mb, 1kb or more',
        )
      : (parseSize(legacySize) ?? 100 * 1024 ** 2)
  const legacyPath = reader.legacy('LOGS_PATH', 'LOG_PATH')
  const path = resolve(root, legacyPath ?? reader.raw('LOG_PATH') ?? 'storage/logs')
  let channel = reader.raw('LOG_CHANNEL')
  if (channel === undefined) {
    if ((reader.raw('LOGS_ENABLED') ?? '').toLowerCase() === 'false') {
      reader.warn('LOGS_ENABLED', 'LOGS_ENABLED=false is the v1 switch; use LOG_CHANNEL=null')
      channel = 'null'
    } else if ((reader.raw('LOGS_DRIVER') ?? '').toLowerCase() === 'stdout') {
      reader.warn('LOGS_DRIVER', 'LOGS_DRIVER=stdout is the v1 switch; use LOG_CHANNEL=stdout')
      channel = 'stdout'
    }
  }
  const stackText = reader.raw('LOG_STACK')
  const stack = stackText
    ? stackText
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    : ['daily']
  const slackText = reader.raw('LOG_SLACK_WEBHOOK_URL')
  const slackUrl = slackText === undefined ? undefined : httpsUrl(slackText)
  if (slackText !== undefined && slackUrl === undefined) {
    reader.warn(
      'LOG_SLACK_WEBHOOK_URL',
      'LOG_SLACK_WEBHOOK_URL must be an https:// URL without credentials; the slack channel stays off',
    )
  }
  return {
    local,
    appEnv,
    level,
    format,
    days,
    maxFileBytes,
    path,
    channel,
    stack: stack.length > 0 ? stack : ['daily'],
    slackUrl,
    deprecations: reader.raw('LOG_DEPRECATIONS_CHANNEL') ?? 'null',
  }
}

function builtIns(d: Defaults): Record<BuiltInChannel, ChannelConfig> {
  return {
    stack: { driver: 'stack', channels: d.stack },
    single: { driver: 'single' },
    daily: { driver: 'daily' },
    slack: { driver: 'slack', level: 'critical' },
    stderr: { driver: 'stderr' },
    stdout: { driver: 'stdout' },
    null: { driver: 'null' },
  }
}

/** Collects config-file problems; thrown together as one {@link LoggingConfigError}. */
type Problems = string[]

function levelOf(
  problems: Problems,
  where: string,
  value: LevelName | undefined,
  fallback: Level,
): Level {
  if (value === undefined) return fallback
  const level = toLevel(value)
  if (level === undefined)
    problems.push(`${where}.level: "${String(value)}" is not a level; ${LEVEL_HINT}`)
  return level ?? fallback
}

function formatOf(
  problems: Problems,
  where: string,
  value: LogFormat | undefined,
  fallback: LogFormat,
): LogFormat {
  if (value === undefined) return fallback
  if (!isLogFormat(value))
    problems.push(`${where}.format: "${String(value)}" is not a format; ${FORMAT_HINT}`)
  return isLogFormat(value) ? value : fallback
}

function resolveFile(
  problems: Problems,
  where: string,
  c: FileChannelConfig,
  d: Defaults,
  root: string,
): ResolvedFileChannel {
  let dir = d.path
  if (c.path !== undefined) {
    if (typeof c.path !== 'string' || c.path.trim() === '')
      problems.push(`${where}.path: must be a directory such as "storage/logs"`)
    else dir = isAbsolute(c.path) ? c.path : resolve(root, c.path)
  }
  const base = c.name ?? DEFAULT_LOG_BASE
  if (typeof base !== 'string' || !isLogBaseName(base))
    problems.push(
      `${where}.name: "${String(base)}" can't be a file name; use letters, digits and _ (e.g. "payments")`,
    )
  let maxFileBytes = d.maxFileBytes
  if (c.maxFileSize !== undefined) {
    const bytes =
      typeof c.maxFileSize === 'number'
        ? Number.isSafeInteger(c.maxFileSize) && c.maxFileSize >= MIN_FILE_BYTES
          ? c.maxFileSize
          : undefined
        : parseSize(String(c.maxFileSize))
    if (bytes === undefined)
      problems.push(
        `${where}.maxFileSize: "${String(c.maxFileSize)}" is not a size; use e.g. "100mb" (1kb or more)`,
      )
    else maxFileBytes = bytes
  }
  let days = c.driver === 'daily' ? d.days : 0
  if (c.days !== undefined) {
    if (c.driver !== 'daily') problems.push(`${where}.days: only daily channels keep days`)
    else if (!Number.isInteger(c.days) || c.days < 0)
      problems.push(`${where}.days: use a whole number of days (0 keeps everything)`)
    else days = c.days
  }
  return {
    driver: c.driver,
    level: levelOf(problems, where, c.level, d.level),
    format: formatOf(problems, where, c.format, d.format),
    dir,
    base: typeof base === 'string' ? base : DEFAULT_LOG_BASE,
    maxFileBytes,
    days,
  }
}

function resolveLeaf(
  problems: Problems,
  where: string,
  c: ChannelConfig,
  d: Defaults,
  root: string,
): ResolvedChannel | undefined {
  switch (c.driver) {
    case 'single':
    case 'daily':
      return resolveFile(problems, where, c, d, root)
    case 'stderr':
    case 'stdout':
      return {
        driver: c.driver,
        level: levelOf(problems, where, c.level, d.level),
        format: formatOf(problems, where, c.format, d.format),
      }
    case 'slack': {
      let url = d.slackUrl
      if (c.url !== undefined) {
        url = typeof c.url === 'string' ? httpsUrl(c.url) : undefined
        if (url === undefined)
          problems.push(
            `${where}.url: the Slack webhook must be an https:// URL without credentials`,
          )
      }
      const interval = c.minIntervalMs ?? 10_000
      if (!Number.isFinite(interval) || interval < 0)
        problems.push(`${where}.minIntervalMs: use a number of milliseconds (0 or more)`)
      return {
        driver: 'slack',
        level: levelOf(problems, where, c.level, 'critical'),
        url,
        username: c.username ?? 'Strutvane Log',
        emoji: c.emoji ?? ':boom:',
        minIntervalMs: Number.isFinite(interval) && interval >= 0 ? interval : 10_000,
      }
    }
    case 'null':
      return { driver: 'null' }
    case 'custom':
      if (typeof c.via !== 'function') {
        problems.push(`${where}.via: a custom channel needs via: (context) => transport`)
        return undefined
      }
      return {
        driver: 'custom',
        level: levelOf(problems, where, c.level, d.level),
        format: formatOf(problems, where, c.format, d.format),
        via: c.via,
      }
    default:
      return undefined
  }
}

/**
 * Resolve one channel config outside `config/logging` (for `Log.build`). Throws a
 * {@link LoggingConfigError} when it is invalid. A `stack` can't be built this way (use
 * `Log.stack`).
 *
 * @example
 * resolveChannelConfig({ driver: 'single', path: 'storage/logs/imports' }, resolved)
 */
export function resolveChannelConfig(
  channel: ChannelConfig,
  config: Pick<ResolvedLoggingConfig, 'path' | 'env' | 'level' | 'format'>,
  options: { readonly root?: string; readonly env?: Env } = {},
): ResolvedChannel {
  const problems: Problems = []
  const reader = new EnvReader(options.env ?? {})
  const d: Defaults = {
    ...readDefaults(reader, options.root ?? process.cwd()),
    level: config.level,
    format: config.format,
    path: config.path,
    appEnv: config.env,
  }
  if (!isObject(channel) || !(DRIVERS as readonly string[]).includes(String(channel.driver)))
    problems.push(
      `build: driver "${isObject(channel) ? String(channel.driver) : ''}" is unknown; use one of ${DRIVERS.join(', ')}`,
    )
  else if (channel.driver === 'stack') problems.push('build: use Log.stack([...]) for a stack')
  const resolved =
    problems.length === 0
      ? resolveLeaf(problems, 'build', channel, d, options.root ?? process.cwd())
      : undefined
  if (problems.length > 0 || resolved === undefined) throw new LoggingConfigError(problems)
  return resolved
}

/**
 * A null-prototype record holding the own enumerable entries of `sources` (later wins). Lookups
 * in it can never hit `Object.prototype` (`toString`, `constructor`, `__proto__`), and with no
 * prototype there is no `__proto__` setter, so that key stays an ordinary entry.
 */
function ownRecord<V>(
  ...sources: ReadonlyArray<Readonly<Record<string, V>> | undefined>
): Record<string, V> {
  const out = Object.create(null) as Record<string, V>
  for (const source of sources) {
    if (source === undefined) continue
    for (const [key, value] of Object.entries(source)) out[key] = value
  }
  return out
}

function isObject(value: unknown): value is Record<string, unknown> & { driver?: unknown } {
  return typeof value === 'object' && value !== null
}

/** Find a loop in the explicit stacks, e.g. `['a', 'b', 'a']`. */
function findLoop(
  start: string,
  edges: ReadonlyMap<string, readonly string[]>,
): string[] | undefined {
  const path: string[] = []
  const onPath = new Set<string>()
  const done = new Set<string>()
  const visit = (name: string): string[] | undefined => {
    if (onPath.has(name)) return [...path.slice(path.indexOf(name)), name]
    if (done.has(name)) return undefined
    const next = edges.get(name)
    if (!next) return undefined
    path.push(name)
    onPath.add(name)
    for (const child of next) {
      const loop = visit(child)
      if (loop) return loop
    }
    path.pop()
    onPath.delete(name)
    done.add(name)
    return undefined
  }
  return visit(start)
}

/** The non-stack channels a stack reaches, in order, each once. */
function leavesOf(name: string, edges: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (n: string): void => {
    if (seen.has(n)) return
    seen.add(n)
    const next = edges.get(n)
    if (next === undefined) out.push(n)
    else for (const child of next) walk(child)
  }
  walk(name)
  return out
}

/**
 * Resolve `config/logging` against `.env`.
 *
 * @throws LoggingConfigError when the config file itself is invalid (unknown driver or channel,
 *   bad level, format, size or file name, a stack that contains itself, …)
 *
 * @example
 * const { config, issues } = resolveLoggingConfig({}, { env: { APP_ENV: 'local' } })
 * config.default                    // 'stack'
 * config.channels.stack             // { driver: 'stack', channels: ['daily'], leaves: ['daily'] }
 * config.level                      // 'debug'
 */
export function resolveLoggingConfig(
  input: LoggingConfig = {},
  options: ResolveOptions = {},
): LoggingConfigResult {
  const root = options.root ?? process.cwd()
  const reader = new EnvReader(options.env ?? process.env)
  const base = readDefaults(reader, root)
  const problems: Problems = []
  let d = base
  if (input.path !== undefined) {
    if (typeof input.path !== 'string' || input.path.trim() === '')
      problems.push('path: must be a directory such as "storage/logs"')
    else d = { ...base, path: isAbsolute(input.path) ? input.path : resolve(root, input.path) }
  }

  // Null-prototype maps, and `Object.hasOwn` for every membership test: channel names come from
  // `.env` and from application input, and an inherited name (`toString`, `constructor`,
  // `__proto__`) must never pass for a channel.
  const declared = ownRecord<ChannelConfig>(builtIns(d), input.channels)
  const isDeclared = (name: string): boolean => Object.hasOwn(declared, name)
  const envStack =
    input.channels === undefined ||
    !Object.hasOwn(input.channels, 'stack') ||
    input.channels['stack'] === undefined
  const channels = ownRecord<ResolvedChannel>()
  const edges = new Map<string, readonly string[]>()

  for (const [name, channel] of Object.entries(declared)) {
    const where = `channels.${name}`
    if (!CHANNEL_NAME.test(name)) {
      problems.push(`${where}: channel names use letters, digits, _ and - (at most 64)`)
      continue
    }
    if (!isObject(channel) || !(DRIVERS as readonly string[]).includes(String(channel.driver))) {
      problems.push(
        `${where}.driver: "${isObject(channel) ? String(channel.driver) : ''}" is unknown; use one of ${DRIVERS.join(', ')}`,
      )
      continue
    }
    if (channel.driver === 'stack') {
      if (name === 'stack' && envStack) continue // from LOG_STACK: checked below, never fatal
      if (!Array.isArray(channel.channels) || channel.channels.length === 0) {
        problems.push(`${where}.channels: list at least one channel, e.g. ['daily']`)
        continue
      }
      for (const child of channel.channels) {
        if (!isDeclared(child))
          problems.push(
            `${where}.channels: "${child}" is not defined; defined channels: ${Object.keys(declared).join(', ')}`,
          )
      }
      edges.set(name, channel.channels.filter(isDeclared))
      continue
    }
    const resolved = resolveLeaf(problems, where, channel, d, root)
    if (resolved) channels[name] = resolved
  }

  for (const name of edges.keys()) {
    const loop = findLoop(name, edges)
    if (loop && loop[0] === name)
      problems.push(
        `channels.${name}: stack ${loop.map((n) => `"${n}"`).join(' → ')} loops; a stack can't contain itself`,
      )
  }

  if (envStack) {
    // LOG_STACK names may be wrong; drop those (and any that would loop back) with a warning.
    const kept: string[] = []
    for (const child of d.stack) {
      if (!isDeclared(child)) {
        reader.warn(
          'LOG_STACK',
          `LOG_STACK names "${child}", which is not a channel; defined channels: ${Object.keys(declared).join(', ')}`,
        )
      } else if (child === 'stack' || leavesOrSelf(child, edges).has('stack')) {
        reader.warn(
          'LOG_STACK',
          `LOG_STACK can't include "${child}": the stack would contain itself`,
        )
      } else kept.push(child)
    }
    if (kept.length === 0) {
      reader.warn('LOG_STACK', 'LOG_STACK has no usable channel; using daily')
      kept.push('daily')
    }
    edges.set('stack', kept)
  }

  if (problems.length === 0) {
    for (const [name, children] of edges)
      channels[name] = { driver: 'stack', channels: children, leaves: leavesOf(name, edges) }
  }

  let def = input.default
  if (def !== undefined) {
    if (!isDeclared(def))
      problems.push(
        `default: "${def}" is not defined; defined channels: ${Object.keys(declared).join(', ')}`,
      )
  } else {
    def = d.channel ?? 'stack'
    if (!isDeclared(def)) {
      reader.warn(
        'LOG_CHANNEL',
        `LOG_CHANNEL="${def}" is not a channel; using stack (defined channels: ${Object.keys(declared).join(', ')})`,
      )
      def = 'stack'
    }
  }
  let deprecations = input.deprecations
  if (deprecations !== undefined) {
    if (!isDeclared(deprecations))
      problems.push(
        `deprecations: "${deprecations}" is not defined; defined channels: ${Object.keys(declared).join(', ')}`,
      )
  } else {
    deprecations = d.deprecations
    if (!isDeclared(deprecations)) {
      reader.warn(
        'LOG_DEPRECATIONS_CHANNEL',
        `LOG_DEPRECATIONS_CHANNEL="${deprecations}" is not a channel; using null`,
      )
      deprecations = 'null'
    }
  }

  if (problems.length > 0) throw new LoggingConfigError(problems)
  return {
    config: {
      default: def,
      deprecations,
      channels,
      path: d.path,
      env: d.appEnv,
      level: d.level,
      format: d.format,
    },
    issues: reader.issues,
  }
}

/** The stacks reachable from `name` (including itself if it is a stack). */
function leavesOrSelf(name: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>()
  const walk = (n: string): void => {
    if (seen.has(n)) return
    seen.add(n)
    for (const child of edges.get(n) ?? []) walk(child)
  }
  walk(name)
  return seen
}

/**
 * The log directory from `.env` alone (`LOG_PATH`, else `storage/logs`), for tools that only read
 * files (the viewer, `log:list`).
 *
 * @example
 * resolveLogPath({ LOG_PATH: 'var/log' }, '/srv/app') // '/srv/app/var/log'
 */
export function resolveLogPath(env: Env = process.env, root: string = process.cwd()): string {
  const value = env['LOG_PATH']?.trim() || env['LOGS_PATH']?.trim() || 'storage/logs'
  return resolve(root, value)
}
