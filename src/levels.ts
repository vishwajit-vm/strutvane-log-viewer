/**
 * Log levels: the eight RFC 5424 severities, as in Laravel (ADR-0022), plus three aliases so code
 * written against the v1 `Logger` contract (`trace`, `warn`, `fatal`) keeps working.
 *
 * | Level | RFC 5424 code | Priority | Alias |
 * |---|---|---|---|
 * | `emergency` | 0 | 600 | |
 * | `alert` | 1 | 550 | |
 * | `critical` | 2 | 500 | `fatal` |
 * | `error` | 3 | 400 | |
 * | `warning` | 4 | 300 | `warn` |
 * | `notice` | 5 | 250 | |
 * | `info` | 6 | 200 | |
 * | `debug` | 7 | 100 | `trace` |
 *
 * Priorities use Monolog's numbering (higher is more severe), so they compare naturally and
 * Laravel users recognise them. Records are always written with the canonical name: an alias
 * only changes how a level is *asked for*, never what is stored.
 *
 * @module
 */

/** The eight RFC 5424 levels, from least to most severe. */
export const LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const

/** One of the eight canonical level names. */
export type Level = (typeof LEVELS)[number]

/**
 * Aliases for v1 callers (the `Logger` contract's `trace`, `warn` and `fatal`). They resolve to
 * canonical levels, so `log.warn()` writes a `warning` record.
 */
export const LEVEL_ALIASES: Readonly<{ trace: 'debug'; warn: 'warning'; fatal: 'critical' }> =
  Object.freeze({ trace: 'debug', warn: 'warning', fatal: 'critical' })

/** An alias accepted wherever a level is. */
export type LevelAlias = keyof typeof LEVEL_ALIASES

/** Anything accepted as a level: a canonical name or an alias. */
export type LevelName = Level | LevelAlias

/**
 * Priority of each level (Monolog numbering: higher is more severe).
 *
 * @example
 * LEVEL_PRIORITY.error > LEVEL_PRIORITY.warning // true
 */
export const LEVEL_PRIORITY: Readonly<Record<Level, number>> = Object.freeze({
  debug: 100,
  info: 200,
  notice: 250,
  warning: 300,
  error: 400,
  critical: 500,
  alert: 550,
  emergency: 600,
})

/** The numeric RFC 5424 severity code of each level (0 is the most severe), for syslog-style sinks. */
export const RFC5424_CODE: Readonly<Record<Level, number>> = Object.freeze({
  emergency: 0,
  alert: 1,
  critical: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7,
})

/**
 * Records at or above this priority (`warning` and up) are "important": when a channel's queue is
 * full, `debug`, `info` and `notice` records are dropped first (ADR-0015).
 */
export const IMPORTANT_PRIORITY: number = LEVEL_PRIORITY.warning

const CANONICAL: ReadonlySet<string> = new Set(LEVELS)

/**
 * Is `value` one of the eight canonical level names (not an alias)?
 *
 * @example
 * isLevel('warning') // true
 * isLevel('warn')    // false: an alias, see isLevelName
 */
export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && CANONICAL.has(value)
}

/**
 * Is `value` a canonical level name or an alias?
 *
 * @example
 * isLevelName('fatal') // true
 */
export function isLevelName(value: unknown): value is LevelName {
  return isLevel(value) || (typeof value === 'string' && Object.hasOwn(LEVEL_ALIASES, value))
}

/**
 * Resolve a level name or alias, case-insensitively and ignoring surrounding spaces, to its
 * canonical level. Returns `undefined` for anything else, so callers decide how to report it.
 *
 * Why case-insensitive: `.env` files are hand-written, and `LOG_LEVEL=Warning` should just work.
 *
 * @example
 * toLevel('WARN')  // 'warning'
 * toLevel('loud')  // undefined
 */
export function toLevel(value: unknown): Level | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim().toLowerCase()
  if (CANONICAL.has(name)) return name as Level
  return Object.hasOwn(LEVEL_ALIASES, name) ? LEVEL_ALIASES[name as LevelAlias] : undefined
}

/**
 * Priority of a level or alias (higher is more severe). Unknown names get `-1`, which is below
 * every real level, so a mistake can never make a record look more important than it is.
 *
 * @example
 * priorityOf('fatal') === priorityOf('critical') // true
 */
export function priorityOf(level: LevelName): number {
  const canonical = toLevel(level)
  return canonical === undefined ? -1 : LEVEL_PRIORITY[canonical]
}
