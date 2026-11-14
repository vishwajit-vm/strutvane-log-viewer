/**
 * `config/logging` and `.env` resolution (ADR-0022 §2–§3): the env matrix, defaults, friendly
 * errors (unknown channels, bad sizes and levels, stack recursion), v1 names, plus the default
 * `Log` facade and the console transports.
 */
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  defineLoggingConfig,
  LoggingConfigError,
  parseSize,
  resolveChannelConfig,
  resolveLoggingConfig,
  resolveLogPath,
} from '../src/config.ts'
import { getLogManager, Log, log, logger, report, setLogManager } from '../src/default.ts'
import { automaticWorkerId, createLogManager } from '../src/manager.ts'
import { createNoopLogger } from '../src/noop.ts'
import { stderrTransport, stdoutTransport, streamTransport } from '../src/transports/console.ts'
import { captureStream, memoryTransport } from './helpers.ts'

const ROOT = resolve('/srv/app')
const cfg = (env: Record<string, string>, input = {}) =>
  resolveLoggingConfig(input, { env, root: ROOT })

afterEach(() => {
  setLogManager(undefined)
})

describe('env resolution matrix', () => {
  test('defaults with an empty environment (production)', () => {
    const { config, issues } = cfg({})
    expect(issues).toEqual([])
    expect(config).toMatchObject({
      default: 'stack',
      deprecations: 'null',
      level: 'info',
      format: 'line',
      env: 'production',
      path: join(ROOT, 'storage/logs'),
    })
    expect(config.channels['stack']).toEqual({
      driver: 'stack',
      channels: ['daily'],
      leaves: ['daily'],
    })
    expect(config.channels['daily']).toEqual({
      driver: 'daily',
      level: 'info',
      format: 'line',
      dir: join(ROOT, 'storage/logs'),
      base: 'strutvane',
      maxFileBytes: 100 * 1024 * 1024,
      days: 14,
    })
    expect(config.channels['single']).toMatchObject({ driver: 'single', days: 0 })
    expect(config.channels['slack']).toMatchObject({
      driver: 'slack',
      level: 'critical',
      url: undefined,
      minIntervalMs: 10_000,
    })
    expect(Object.keys(config.channels).sort()).toEqual(
      ['daily', 'null', 'single', 'slack', 'stack', 'stderr', 'stdout'].sort(),
    )
  })

  test.each([
    [{ APP_ENV: 'local' }, 'debug'],
    [{ APP_ENV: 'LOCAL' }, 'debug'],
    [{ APP_ENV: 'staging' }, 'info'],
    [{ APP_ENV: 'local', LOG_LEVEL: 'error' }, 'error'],
    [{ LOG_LEVEL: 'Warning' }, 'warning'],
    [{ LOG_LEVEL: 'warn' }, 'warning'],
    [{ LOG_LEVEL: 'fatal' }, 'critical'],
    [{ LOG_LEVEL: 'trace' }, 'debug'],
    [{ LOG_LEVEL: ' notice ' }, 'notice'],
  ])('LOG_LEVEL: %o → %s', (env, level) => {
    const { config, issues } = cfg(env)
    expect(config.level).toBe(level)
    expect(config.channels['daily']).toMatchObject({ level })
    expect(config.channels['slack']).toMatchObject({ level: 'critical' })
    expect(issues).toEqual([])
  })

  test('every key is read', () => {
    const { config, issues } = cfg({
      APP_ENV: 'staging',
      LOG_CHANNEL: 'single',
      LOG_STACK: 'single, stderr',
      LOG_LEVEL: 'notice',
      LOG_DAILY_DAYS: '30',
      LOG_FORMAT: 'json',
      LOG_MAX_FILE_SIZE: '5mb',
      LOG_PATH: 'var/log',
      LOG_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
      LOG_DEPRECATIONS_CHANNEL: 'stderr',
    })
    expect(issues).toEqual([])
    expect(config).toMatchObject({
      default: 'single',
      deprecations: 'stderr',
      env: 'staging',
      level: 'notice',
      format: 'json',
      path: join(ROOT, 'var/log'),
    })
    expect(config.channels['stack']).toMatchObject({ channels: ['single', 'stderr'] })
    expect(config.channels['daily']).toMatchObject({
      days: 30,
      maxFileBytes: 5 * 1024 * 1024,
      format: 'json',
      dir: join(ROOT, 'var/log'),
    })
    expect(config.channels['slack']).toMatchObject({
      url: 'https://hooks.slack.com/services/T/B/x',
    })
  })

  test('the production Dockerfile settings: LOG_CHANNEL=stderr, LOG_FORMAT=json', () => {
    const { config } = cfg({ LOG_CHANNEL: 'stderr', LOG_FORMAT: 'json' })
    expect(config.default).toBe('stderr')
    expect(config.channels['stderr']).toEqual({ driver: 'stderr', level: 'info', format: 'json' })
  })

  test('invalid .env values never throw: defaults plus a friendly issue per key', () => {
    const { config, issues } = cfg({
      LOG_LEVEL: 'loud',
      LOG_FORMAT: 'xml',
      LOG_DAILY_DAYS: '-3',
      LOG_MAX_FILE_SIZE: 'huge',
      LOG_CHANNEL: 'papertrail',
      LOG_STACK: 'daily,nope',
      LOG_SLACK_WEBHOOK_URL: 'http://hooks.slack.com/x',
      LOG_DEPRECATIONS_CHANNEL: 'gone',
    })
    expect(config).toMatchObject({
      level: 'info',
      format: 'line',
      default: 'stack',
      deprecations: 'null',
    })
    expect(config.channels['daily']).toMatchObject({ days: 14, maxFileBytes: 100 * 1024 ** 2 })
    expect(config.channels['stack']).toMatchObject({ channels: ['daily'] })
    expect(config.channels['slack']).toMatchObject({ url: undefined })
    const keys = issues.map((i) => i.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'LOG_LEVEL',
        'LOG_FORMAT',
        'LOG_DAILY_DAYS',
        'LOG_MAX_FILE_SIZE',
        'LOG_CHANNEL',
        'LOG_STACK',
        'LOG_SLACK_WEBHOOK_URL',
        'LOG_DEPRECATIONS_CHANNEL',
      ]),
    )
    const text = issues.map((i) => i.message).join('\n')
    expect(text).toContain('LOG_LEVEL="loud" is not valid (use one of debug, info')
    expect(text).toContain('LOG_MAX_FILE_SIZE="huge" is not valid (use a size like 100mb')
    expect(text).toContain('LOG_CHANNEL="papertrail" is not a channel; using stack')
    expect(text).toContain('LOG_STACK names "nope", which is not a channel')
  })

  test('LOG_STACK that would contain itself is refused, and an empty result falls back to daily', () => {
    const { config, issues } = cfg({ LOG_STACK: 'stack' })
    expect(config.channels['stack']).toMatchObject({ channels: ['daily'] })
    expect(issues.map((i) => i.message)).toEqual([
      `LOG_STACK can't include "stack": the stack would contain itself`,
      'LOG_STACK has no usable channel; using daily',
    ])
    // Indirectly, through a stack of the config file that includes the env stack.
    const indirect = cfg(
      { LOG_STACK: 'audit,single' },
      { channels: { audit: { driver: 'stack', channels: ['stack', 'daily'] } } },
    )
    expect(indirect.config.channels['stack']).toMatchObject({ channels: ['single'] })
    expect(indirect.issues[0]?.message).toContain(`can't include "audit"`)
  })

  test('v1 names still work once, with a rename hint', () => {
    const { config, issues } = cfg({
      LOGS_PATH: 'old/logs',
      LOGS_RETENTION_DAYS: '7',
      LOGS_MAX_DAILY_SIZE: '2mb',
      LOG_FORMAT: 'pretty',
      LOGS_ENABLED: 'false',
    })
    expect(config.path).toBe(join(ROOT, 'old/logs'))
    expect(config.channels['daily']).toMatchObject({ days: 7, maxFileBytes: 2 * 1024 ** 2 })
    expect(config.format).toBe('line')
    expect(config.default).toBe('null')
    expect(issues.map((i) => i.key)).toEqual([
      'LOG_FORMAT',
      'LOGS_RETENTION_DAYS',
      'LOGS_MAX_DAILY_SIZE',
      'LOGS_PATH',
      'LOGS_ENABLED',
    ])
    expect(cfg({ LOGS_DRIVER: 'stdout' }).config.default).toBe('stdout')
    // The new name wins over the old one.
    expect(cfg({ LOGS_PATH: 'old', LOG_PATH: 'new' }).config.path).toBe(join(ROOT, 'new'))
  })

  test('resolveLogPath reads LOG_PATH (or the v1 LOGS_PATH)', () => {
    expect(resolveLogPath({}, ROOT)).toBe(join(ROOT, 'storage/logs'))
    expect(resolveLogPath({ LOG_PATH: 'x' }, ROOT)).toBe(join(ROOT, 'x'))
    expect(resolveLogPath({ LOGS_PATH: 'y' }, ROOT)).toBe(join(ROOT, 'y'))
  })
})

describe('config file (code) mistakes throw one friendly error', () => {
  const problems = (input: object): string[] => {
    try {
      resolveLoggingConfig(input, { env: {}, root: ROOT })
    } catch (error) {
      expect(error).toBeInstanceOf(LoggingConfigError)
      expect((error as LoggingConfigError).code).toBe('LOGGING_CONFIG_INVALID')
      return [...(error as LoggingConfigError).problems]
    }
    throw new Error('expected a LoggingConfigError')
  }

  test('stack recursion, direct and indirect', () => {
    expect(problems({ channels: { a: { driver: 'stack', channels: ['a'] } } })).toEqual([
      `channels.a: stack "a" → "a" loops; a stack can't contain itself`,
    ])
    const loop = problems({
      channels: {
        a: { driver: 'stack', channels: ['daily', 'b'] },
        b: { driver: 'stack', channels: ['c'] },
        c: { driver: 'stack', channels: ['a'] },
      },
    })
    expect(loop).toContain(
      `channels.a: stack "a" → "b" → "c" → "a" loops; a stack can't contain itself`,
    )
  })

  test('unknown channels, drivers, levels, formats, sizes, names, days', () => {
    const list = problems({
      default: 'nope',
      deprecations: 'gone',
      channels: {
        s: { driver: 'stack', channels: ['missing'] },
        e: { driver: 'stack', channels: [] },
        k: { driver: 'kafka' },
        lv: { driver: 'daily', level: 'loud' },
        fm: { driver: 'stderr', format: 'xml' },
        sz: { driver: 'single', maxFileSize: '12 parsecs' },
        tiny: { driver: 'single', maxFileSize: 10 },
        nm: { driver: 'daily', name: 'my-app' },
        dy: { driver: 'daily', days: 1.5 },
        sd: { driver: 'single', days: 3 },
        pt: { driver: 'single', path: ' ' },
        cu: { driver: 'custom' },
        sl: { driver: 'slack', url: 'http://x.test/hook', minIntervalMs: -1 },
        'bad name!': { driver: 'null' },
      },
    })
    const text = list.join('\n')
    for (const fragment of [
      'default: "nope" is not defined; defined channels: stack, single',
      'deprecations: "gone" is not defined',
      'channels.s.channels: "missing" is not defined',
      `channels.e.channels: list at least one channel, e.g. ['daily']`,
      'channels.k.driver: "kafka" is unknown; use one of single, daily, stack',
      'channels.lv.level: "loud" is not a level; use one of debug',
      'channels.fm.format: "xml" is not a format; use line or json',
      'channels.sz.maxFileSize: "12 parsecs" is not a size',
      'channels.tiny.maxFileSize: "10" is not a size',
      `channels.nm.name: "my-app" can't be a file name`,
      'channels.dy.days: use a whole number of days',
      'channels.sd.days: only daily channels keep days',
      'channels.pt.path: must be a directory',
      'channels.cu.via: a custom channel needs via',
      'channels.sl.url: the Slack webhook must be an https:// URL',
      'channels.sl.minIntervalMs: use a number of milliseconds',
      'channels.bad name!: channel names use letters',
    ]) {
      expect(text).toContain(fragment)
    }
    expect(() => resolveLoggingConfig({ path: '' }, { env: {} })).toThrow(/path: must be/)
  })

  test('the error message lists every problem', () => {
    const error = new LoggingConfigError(['a', 'b'])
    expect(error.message).toBe('config/logging is invalid:\n  - a\n  - b')
    expect(error.name).toBe('LoggingConfigError')
  })

  test('explicit channels override built-ins and add new ones', () => {
    const { config } = resolveLoggingConfig(
      defineLoggingConfig({
        default: 'audit',
        path: resolve('/var/app-logs'),
        channels: {
          payments: {
            driver: 'daily',
            name: 'payments',
            days: 90,
            maxFileSize: 2048,
            level: 'warn',
          },
          audit: { driver: 'stack', channels: ['payments', 'stack', 'payments'] },
          stack: { driver: 'stack', channels: ['single'] },
          single: { driver: 'single', path: 'other', format: 'json' },
        },
      }),
      { env: { LOG_STACK: 'stderr' }, root: ROOT },
    )
    expect(config.default).toBe('audit')
    expect(config.channels['payments']).toMatchObject({
      dir: resolve('/var/app-logs'),
      base: 'payments',
      days: 90,
      maxFileBytes: 2048,
      level: 'warning',
    })
    expect(config.channels['single']).toMatchObject({ dir: join(ROOT, 'other'), format: 'json' })
    // Explicit stack wins over LOG_STACK; leaves are unique and in order.
    expect(config.channels['stack']).toMatchObject({ channels: ['single'] })
    expect(config.channels['audit']).toMatchObject({ leaves: ['payments', 'single'] })
  })

  test('resolveChannelConfig (Log.build) validates one channel', () => {
    const { config } = cfg({})
    expect(
      resolveChannelConfig({ driver: 'single', path: 'imports', name: 'imports' }, config, {
        root: ROOT,
      }),
    ).toMatchObject({ driver: 'single', base: 'imports', dir: join(ROOT, 'imports') })
    expect(() => resolveChannelConfig({ driver: 'stack', channels: ['daily'] }, config)).toThrow(
      /Log.stack/,
    )
    expect(() => resolveChannelConfig({ driver: 'kafka' } as never, config)).toThrow(
      /driver "kafka" is unknown/,
    )
    expect(() =>
      resolveChannelConfig({ driver: 'daily', level: 'loud' as 'info' }, config),
    ).toThrow(LoggingConfigError)
  })

  test('parseSize', () => {
    expect(parseSize('100mb')).toBe(100 * 1024 * 1024)
    expect(parseSize('30MB')).toBe(30 * 1024 * 1024)
    expect(parseSize('1.5 kb')).toBe(1536)
    expect(parseSize('2k')).toBe(2048)
    expect(parseSize('1g')).toBe(1024 ** 3)
    expect(parseSize('2048')).toBe(2048)
    expect(parseSize('100')).toBeUndefined()
    expect(parseSize('ten')).toBeUndefined()
    expect(parseSize('1e9')).toBeUndefined()
  })
})

describe('the default Log facade and helpers', () => {
  test('delegates every call to the current manager', async () => {
    const out = captureStream()
    const manager = createLogManager({
      env: { LOG_CHANNEL: 'stdout', LOG_FORMAT: 'json', LOG_LEVEL: 'debug' },
      streams: { stdout: out.stream },
    })
    setLogManager(manager)
    expect(getLogManager()).toBe(manager)
    expect(log).toBe(Log)
    for (const m of [
      'emergency',
      'alert',
      'critical',
      'error',
      'warning',
      'notice',
      'info',
      'debug',
      'trace',
      'warn',
      'fatal',
    ] as const)
      Log[m](m)
    Log.log('notice', 'by-name')
    Log.child({ c: 1 }).info('child')
    Log.channel('stdout').info('channel')
    Log.stack(['stdout']).info('stack')
    Log.build({ driver: 'stdout', format: 'json' }).info('built')
    Log.withContext({ w: 1 }).shareContext({ s: 2 })
    expect(Log.sharedContext()).toEqual({ s: 2 })
    Log.info('with context')
    Log.withoutContext().flushSharedContext().info('without context')
    Log.deprecation('ignored by the null channel')
    Log.report(new Error('boom'))
    logger('helper')
    expect(logger()).toBe(Log)
    report('string thrown')
    expect(Log.level).toBe('debug')
    expect(Log.isLevelEnabled('debug')).toBe(true)
    expect(Log.config.default).toBe('stdout')
    expect(Log.issues).toEqual([])
    await Log.flush()
    await Log.drain()
    expect(Log.stats().written).toBeGreaterThan(10)
    await Log.close()
    const records = out.lines()
    expect(records.map((r) => r.level).slice(0, 11)).toEqual([
      'emergency',
      'alert',
      'critical',
      'error',
      'warning',
      'notice',
      'info',
      'debug',
      'debug',
      'warning',
      'critical',
    ])
    const by = (msg: string) => records.find((r) => r.msg === msg)
    expect(by('with context')?.fields).toEqual({ s: 2, w: 1 })
    expect(by('without context')?.fields).toBeUndefined()
    expect(by('boom')).toMatchObject({ level: 'error', err: { name: 'Error', message: 'boom' } })
    expect(by('helper')).toMatchObject({ level: 'debug' })
    expect(by('string thrown')).toMatchObject({ level: 'error' })
    expect(by('ignored by the null channel')).toBeUndefined()
  })

  test('creates a default manager lazily, from process.env', async () => {
    setLogManager(undefined)
    const m = getLogManager()
    expect(m.config.channels['stack']).toBeDefined()
    expect(getLogManager()).toBe(m)
    await m.close(100)
  })
})

describe('worker ids and the no-op logger', () => {
  test('the main thread of a non-cluster process needs no worker id; LOG_WORKER_ID is honoured', () => {
    expect(automaticWorkerId({})).toBeUndefined()
    expect(automaticWorkerId({ LOG_WORKER_ID: 'queue_1' })).toBe('queue_1')
    expect(automaticWorkerId({ LOG_WORKER_ID: '../x' })).toBeUndefined()
    expect(() => createLogManager({ env: {}, workerId: 'bad id' })).toThrow(/invalid workerId/)
  })

  test('the no-op logger accepts everything and writes nothing', async () => {
    const l = createNoopLogger()
    l.error('nothing')
    l.log('emergency', 'nothing')
    expect(l.level).toBe('emergency')
    expect(l.isLevelEnabled('emergency')).toBe(false)
    expect(l.child({}).stats().written).toBe(0)
    await expect(l.flush()).resolves.toBeUndefined()
    await expect(l.drain()).resolves.toEqual({ flushed: true, pending: 0 })
    await expect(l.close()).resolves.toEqual({ flushed: true, pending: 0 })
  })
})

describe('console transports', () => {
  const batch = (text: string) => ({ text, bytes: text.length, records: 1, dayKey: '2026-11-14' })

  test('stdout, stream and stderr transports write to their stream', async () => {
    const out = captureStream()
    await stdoutTransport(out.stream).write(batch('a\n'))
    await streamTransport('custom', out.stream).write(batch('b\n'))
    await stderrTransport(out.stream).write(batch('c\n'))
    expect(out.text()).toBe('a\nb\nc\n')
    for (const t of [stdoutTransport(out.stream), stderrTransport(out.stream)])
      await expect(t.close()).resolves.toBeUndefined()
    expect(memoryTransport().name).toBe('memory')
  })

  test('the stderr fallback never throws, even if its stream does', async () => {
    const t = stderrTransport({
      write() {
        throw new Error('EPIPE')
      },
    })
    await expect(t.write(batch('x'))).resolves.toBeUndefined()
  })
})
