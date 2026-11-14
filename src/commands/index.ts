/**
 * `@strutvane/logs/commands`: `log:tail`, `log:list` and `log:clear` (ADR-0022 §8), as thin
 * adapters over pure functions. The `node strut` command registry wires them up later; until then
 * any CLI can call `command.run(argv, io)`.
 *
 * ```
 * node strut log:tail [--level=warning] [--channel=payments] [--filter=text] [-n 50] [-f]
 * node strut log:list [--channel=payments]
 * node strut log:clear [--days=N] [--channel=payments]
 * ```
 *
 * Each command reads `config/logging` (passed in `io.config`) and `.env`, prints to `io.stdout`,
 * reports mistakes on `io.stderr` with a hint, and returns an exit code (0 ok, 1 error). Nothing
 * here writes to the console directly.
 *
 * @module
 */
import { parseArgs } from 'node:util'
import { type Env, type LoggingConfig, resolveLoggingConfig } from '../config.ts'
import { toLevel } from '../levels.ts'
import type { WritableLike } from '../transports/types.ts'
import { clearLogs, formatLogList, listLogs } from './list.ts'
import { type LogSource, sourcesFor } from './sources.ts'
import { formatTailEntry, tailLogs } from './tail.ts'

export type { ClearLogsOptions, ClearLogsResult, ListedFile, LogListing } from './list.ts'
export { clearLogs, formatLogList, humanSize, listLogs } from './list.ts'
export type { LogSource } from './sources.ts'
export { LogSourceError, sourcesFor } from './sources.ts'
export type { TailEntry, TailFilter, TailLogsOptions } from './tail.ts'
export { formatTailEntry, matchesTail, mergeByTime, tailLogs } from './tail.ts'

/** What a command needs from its host. */
export interface CommandIO {
  readonly stdout: WritableLike
  readonly stderr: WritableLike
  /** `config/logging`. Default: the built-in channels. */
  readonly config?: LoggingConfig
  /** Environment. Default: `process.env`. */
  readonly env?: Env
  /** Project root. Default: the working directory. */
  readonly root?: string
  /** Stops `log:tail --follow` (Ctrl+C). */
  readonly signal?: AbortSignal
  /** Poll interval for `--follow` (tests). Default: 500 ms. */
  readonly pollMs?: number
}

/** A command the CLI registry can mount. */
export interface LogCommand {
  readonly name: 'log:tail' | 'log:list' | 'log:clear'
  /** One line for `node strut list`. */
  readonly summary: string
  /** Usage text for `--help`. */
  readonly usage: string
  /** Run with the arguments after the command name. Resolves to the exit code. */
  run(argv: readonly string[], io: CommandIO): Promise<number>
}

/** A usage mistake: printed with the command's usage, exit code 1. */
class UsageError extends Error {}

function sources(io: CommandIO, channel: string | undefined): LogSource[] {
  const { config } = resolveLoggingConfig(io.config ?? {}, {
    env: io.env ?? process.env,
    root: io.root ?? process.cwd(),
  })
  return sourcesFor(config, channel)
}

async function guarded(
  command: Pick<LogCommand, 'name' | 'usage'>,
  io: CommandIO,
  body: () => Promise<number>,
): Promise<number> {
  try {
    return await body()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr.write(`${command.name}: ${message}\n`)
    if (
      error instanceof UsageError ||
      String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')
    )
      io.stderr.write(`\n${command.usage}\n`)
    return 1
  }
}

function wholeNumber(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d{1,6}$/.test(value)) throw new UsageError(`--${name} must be a whole number`)
  return Number(value)
}

/**
 * `log:tail`: the last records and, with `--follow`, new ones as they arrive, merged across
 * processes by timestamp.
 *
 * @example
 * await logTailCommand.run(['--level=error', '-n', '50'], { stdout: process.stdout, stderr: process.stderr })
 */
export const logTailCommand: LogCommand = {
  name: 'log:tail',
  summary: 'Show the latest log records, and follow new ones',
  usage: [
    'Usage: node strut log:tail [options]',
    '  --level=<level>     only this level and above (debug … emergency; warn/fatal/trace work)',
    '  --channel=<name>    only the files of this channel (a stack: all of its file channels)',
    '  --filter=<text>     only records containing this text (case-insensitive)',
    '  -n, --lines=<n>     records to show first (default 20)',
    '  -f, --follow        keep showing new records until Ctrl+C',
  ].join('\n'),
  run(argv, io) {
    return guarded(this, io, async () => {
      const { values } = parseArgs({
        args: [...argv],
        strict: true,
        options: {
          level: { type: 'string' },
          channel: { type: 'string' },
          filter: { type: 'string' },
          lines: { type: 'string', short: 'n' },
          follow: { type: 'boolean', short: 'f' },
        },
      })
      const level = values.level === undefined ? undefined : toLevel(values.level)
      if (values.level !== undefined && level === undefined)
        throw new UsageError(
          `"${values.level}" is not a level; use debug, info, notice, warning, error, critical, alert or emergency`,
        )
      const entries = tailLogs({
        sources: sources(io, values.channel),
        lines: wholeNumber(values.lines, 'lines', 20),
        follow: values.follow === true,
        ...(level === undefined ? {} : { level }),
        ...(values.filter === undefined ? {} : { text: values.filter }),
        ...(io.signal ? { signal: io.signal } : {}),
        ...(io.pollMs === undefined ? {} : { pollMs: io.pollMs }),
      })
      for await (const entry of entries) io.stdout.write(`${formatTailEntry(entry)}\n`)
      return 0
    })
  },
}

/**
 * `log:list`: every log file with its size and day, then totals per day.
 *
 * @example
 * await logListCommand.run([], { stdout: process.stdout, stderr: process.stderr })
 */
export const logListCommand: LogCommand = {
  name: 'log:list',
  summary: 'List log files with their sizes and days',
  usage: [
    'Usage: node strut log:list [options]',
    '  --channel=<name>    only the files of this channel',
  ].join('\n'),
  run(argv, io) {
    return guarded(this, io, async () => {
      const { values } = parseArgs({
        args: [...argv],
        strict: true,
        options: { channel: { type: 'string' } },
      })
      const listing = await listLogs(sources(io, values.channel))
      io.stdout.write(`${formatLogList(listing).join('\n')}\n`)
      return 0
    })
  },
}

/**
 * `log:clear`: delete log files, keeping the last `--days` days if given. The file a running
 * process is writing is never deleted.
 *
 * @example
 * await logClearCommand.run(['--days=7'], { stdout: process.stdout, stderr: process.stderr })
 */
export const logClearCommand: LogCommand = {
  name: 'log:clear',
  summary: 'Delete log files (never the file a running process writes)',
  usage: [
    'Usage: node strut log:clear [options]',
    '  --days=<n>          keep the last n days (today included); default: clear every day',
    '  --channel=<name>    only the files of this channel',
  ].join('\n'),
  run(argv, io) {
    return guarded(this, io, async () => {
      const { values } = parseArgs({
        args: [...argv],
        strict: true,
        options: { days: { type: 'string' }, channel: { type: 'string' } },
      })
      const days = wholeNumber(values.days, 'days', 0)
      const result = await clearLogs(sources(io, values.channel), { days })
      io.stdout.write(
        `Deleted ${result.deleted.length} file(s).${result.live.length > 0 ? ` Kept ${result.live.length} file(s) still being written: ${result.live.join(', ')}.` : ''}\n`,
      )
      return 0
    })
  },
}

/** Every log command, for the CLI registry. */
export const logCommands: readonly LogCommand[] = Object.freeze([
  logTailCommand,
  logListCommand,
  logClearCommand,
])
