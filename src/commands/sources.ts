/**
 * Where the log commands look: the file channels of the resolved `config/logging`, as
 * `(directory, base names)` pairs. A command reads or deletes only files whose base name a
 * configured channel writes, never other `*.log` files that happen to share the directory.
 *
 * @module
 */
import type { ResolvedLoggingConfig } from '../config.ts'

/** One directory and the file base names written into it. */
export interface LogSource {
  readonly dir: string
  readonly bases: ReadonlySet<string>
}

/** Thrown when a channel can't be read from files; the message says why and what to do. */
export class LogSourceError extends Error {
  override readonly name = 'LogSourceError'
}

function group(pairs: Iterable<readonly [string, string]>): LogSource[] {
  const byDir = new Map<string, Set<string>>()
  for (const [dir, base] of pairs) {
    let bases = byDir.get(dir)
    if (!bases) {
      bases = new Set()
      byDir.set(dir, bases)
    }
    bases.add(base)
  }
  return [...byDir].map(([dir, bases]) => ({ dir, bases }))
}

/**
 * The file sources of one channel (a stack: of every file channel it reaches), or of every file
 * channel when `channel` is omitted.
 *
 * @throws LogSourceError for an unknown channel, or one that writes no files (stderr, slack…)
 *
 * @example
 * sourcesFor(config, 'payments') // [{ dir: '/app/storage/logs', bases: Set { 'payments' } }]
 */
export function sourcesFor(config: ResolvedLoggingConfig, channel?: string): LogSource[] {
  const names = (() => {
    if (channel === undefined) return Object.keys(config.channels)
    // Own entries only: an inherited name (`toString`, `__proto__`) is not a channel.
    const resolved = Object.hasOwn(config.channels, channel) ? config.channels[channel] : undefined
    if (!resolved) {
      throw new LogSourceError(
        `channel "${channel}" is not defined in config/logging; defined channels: ${Object.keys(config.channels).join(', ')}`,
      )
    }
    return resolved.driver === 'stack' ? resolved.leaves : [channel]
  })()
  const pairs: Array<readonly [string, string]> = []
  for (const name of names) {
    const c = Object.hasOwn(config.channels, name) ? config.channels[name] : undefined
    if (c && (c.driver === 'single' || c.driver === 'daily')) pairs.push([c.dir, c.base])
  }
  if (pairs.length === 0 && channel !== undefined) {
    throw new LogSourceError(
      `channel "${channel}" writes no files (it isn't single or daily); the log commands read files`,
    )
  }
  if (pairs.length === 0) pairs.push([config.path, 'strutvane'])
  return group(pairs)
}
