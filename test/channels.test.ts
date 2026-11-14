/**
 * Channels through the log manager (ADR-0022 §2, §6, §7): stack fan-out and recursion refusal,
 * channel isolation, unknown channels, `Log.build`, context, `report`, daily rollover at midnight
 * with exactly-once delivery, size parts, retention that never touches the live file, and secrets
 * that never reach any channel in any format.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { LoggingConfigError } from '../src/config.ts'
import { runWithLogContext } from '../src/context.ts'
import { createLogManager, type LogManagerOptions } from '../src/manager.ts'
import type { Batch, Transport } from '../src/transports/types.ts'
import { captureStream, memoryTransport, readLogDir, sleep, tempDir } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})
function dir(): string {
  const t = tempDir()
  cleanups.push(t.cleanup)
  return t.dir
}
const T0 = Date.parse('2026-11-15T10:00:00.000Z')
const lines = (text: string) => text.split('\n').filter((l) => l.length > 0)

/** A manager whose stdout/stderr are captured and whose `.env` is empty unless given. */
function manager<const T extends NonNullable<LogManagerOptions['config']>>(
  config: T,
  extra: Omit<LogManagerOptions<T>, 'config'> = {},
) {
  const stdout = captureStream()
  const stderr = captureStream()
  const log = createLogManager({
    config,
    env: {},
    streams: { stdout: stdout.stream, stderr: stderr.stream },
    workerId: false,
    ...extra,
  })
  return { log, stdout, stderr }
}

describe('stacks', () => {
  test('one call fans out to every channel of the stack, once each, in its own format', async () => {
    const a = memoryTransport()
    const b = memoryTransport()
    const { log } = manager(
      {
        default: 'both',
        channels: {
          a: { driver: 'custom', via: () => a, format: 'json' },
          b: { driver: 'custom', via: () => b, format: 'line' },
          both: { driver: 'stack', channels: ['a', 'b'] },
          // Overlapping stacks still write each record once per channel.
          wide: { driver: 'stack', channels: ['a', 'both', 'b', 'null'] },
        },
      },
      { now: () => T0, env: { APP_ENV: 'local' } },
    )
    log.info('to both', { n: 1 })
    log.channel('wide').warning('to wide')
    await log.flush()
    expect(a.records().map((r) => r.msg)).toEqual(['to both', 'to wide'])
    expect(lines(b.text())).toEqual([
      '[2026-11-15 10:00:00.000] local.INFO: to both {"n":1}',
      '[2026-11-15 10:00:00.000] local.WARNING: to wide {}',
    ])
    expect(log.config.channels['wide']).toMatchObject({ leaves: ['a', 'b', 'null'] })
  })

  test('Log.stack builds an on-the-fly stack; unknown names are reported, not fatal', async () => {
    const a = memoryTransport()
    const b = memoryTransport()
    const { log } = manager({
      default: 'a',
      channels: {
        a: { driver: 'custom', via: () => a, format: 'json' },
        b: { driver: 'custom', via: () => b, format: 'json' },
      },
    })
    log.stack(['a', 'b']).critical('both')
    // Untyped names (e.g. from user input) are checked at runtime too.
    log.stack(['b', 'typo' as never]).error('b only')
    log.stack(['nope' as never]).error('falls back to the default')
    log.stack([]).info('empty stack: default')
    expect(log.stack(['a', 'b'])).toBe(log.stack(['a', 'b'])) // cached
    await log.flush()
    expect(a.records().map((r) => r.msg)).toEqual([
      'both',
      expect.stringContaining('channel "typo" is not defined in config/logging'),
      expect.stringContaining('channel "nope" is not defined'),
      'falls back to the default',
      'empty stack: default',
    ])
    expect(b.records().map((r) => r.msg)).toEqual(['both', 'b only'])
  })

  test('a stack that contains itself is refused when the manager is created', () => {
    expect(() =>
      createLogManager({
        config: { channels: { loop: { driver: 'stack', channels: ['daily', 'loop'] } } },
        env: {},
      }),
    ).toThrow(LoggingConfigError)
  })
})

describe('channel isolation', () => {
  test('a hung channel does not delay the others; each channel has its own level', async () => {
    const fast = memoryTransport()
    const hung: Transport = {
      name: 'hung',
      write: () => new Promise<void>(() => {}),
      close: () => Promise.resolve(),
    }
    const { log } = manager({
      default: 'all',
      channels: {
        fast: { driver: 'custom', via: () => fast, format: 'json', level: 'debug' },
        slow: { driver: 'custom', via: () => hung, format: 'json', level: 'error' },
        all: { driver: 'stack', channels: ['slow', 'fast'] },
      },
    })
    for (let i = 0; i < 5; i++) log.debug('d', { i })
    log.error('e')
    await log.channel('fast').flush(1_000)
    expect(fast.records().map((r) => r.msg)).toEqual(['d', 'd', 'd', 'd', 'd', 'e'])
    expect((await log.drain(50)).flushed).toBe(false) // the hung one is still pending
    expect(log.channel('slow').isLevelEnabled('warning')).toBe(false)
    expect(log.channel('fast').isLevelEnabled('debug')).toBe(true)
  })

  test('a failing channel falls back to stderr (one warning), the others are untouched', async () => {
    const good = memoryTransport()
    const bad: Transport = {
      name: 'webhook',
      write: () => Promise.reject(new Error('ECONNREFUSED')),
      close: () => Promise.resolve(),
    }
    const { log, stderr } = manager({
      default: 'all',
      channels: {
        good: { driver: 'custom', via: () => good, format: 'json' },
        bad: { driver: 'custom', via: () => bad, format: 'json' },
        all: { driver: 'stack', channels: ['bad', 'good'] },
      },
    })
    for (let i = 0; i < 3; i++) {
      log.error('outage', { i })
      await log.flush()
    }
    expect(good.records()).toHaveLength(3)
    const fallback = stderr.lines()
    expect(
      fallback.filter((r) => String(r.msg).includes('channel "bad" (webhook) failed')),
    ).toHaveLength(1)
    expect(fallback.filter((r) => r.msg === 'outage')).toHaveLength(3) // nothing lost
    expect(log.stats()).toMatchObject({ fallbackActive: true, fallbackWarnings: 1 })
  })

  test('a custom channel whose factory throws degrades to the fallback, never crashes', async () => {
    const { log, stderr } = manager({
      default: 'broken',
      channels: {
        broken: {
          driver: 'custom',
          format: 'json',
          via: () => {
            throw new Error('missing API key for the shipper')
          },
        },
      },
    })
    log.critical('still logged')
    await log.flush()
    expect(stderr.text()).toContain('missing API key for the shipper')
    expect(stderr.text()).toContain('still logged')
  })

  test('the null channel discards everything', async () => {
    const { log, stdout, stderr } = manager({ default: 'null' })
    log.emergency('gone')
    await log.flush()
    expect(log.isLevelEnabled('emergency')).toBe(false)
    expect(log.level).toBe('emergency')
    expect(stdout.text() + stderr.text()).toBe('')
  })
})

describe('the facade API', () => {
  test('channel(): known names, the default, unknown names (reported once), stdout/stderr', async () => {
    const { log, stdout, stderr } = manager(
      { default: 'stdout' },
      { env: { LOG_FORMAT: 'json', LOG_LEVEL: 'debug' } },
    )
    expect(log.channel()).toBe(log.channel('stdout'))
    log.channel('stderr').warning('to stderr')
    log.channel('paymnets' as never).info('typo 1')
    log.channel('paymnets' as never).info('typo 2')
    await log.flush()
    const out = stdout.lines().map((r) => r.msg)
    expect(out.filter((m) => String(m).includes('"paymnets" is not defined'))).toHaveLength(1)
    expect(out).toEqual(expect.arrayContaining(['typo 1', 'typo 2']))
    expect(stderr.lines().map((r) => r.msg)).toEqual(['to stderr'])
  })

  test('build(): an ad-hoc file channel, cached by its config; invalid configs throw', async () => {
    const d = dir()
    const { log } = manager({}, { root: d, now: () => T0, env: { LOG_FORMAT: 'json' } })
    const imports = log.build({ driver: 'single', path: 'imports', name: 'imports' })
    expect(log.build({ driver: 'single', path: 'imports', name: 'imports' })).toBe(imports)
    imports.info('Import done', { rows: 3 })
    const t = memoryTransport()
    const custom = log.build({ driver: 'custom', via: () => t, format: 'json' })
    expect(log.build({ driver: 'custom', via: () => t })).not.toBe(custom) // functions: not cached
    custom.info('custom built')
    log.build({ driver: 'null' }).info('nowhere')
    await log.close()
    expect(readdirSync(join(d, 'imports'))).toEqual(['imports.log'])
    expect(readLogDir(join(d, 'imports'))[0]?.records[0]).toMatchObject({
      msg: 'Import done',
      fields: { rows: 3 },
    })
    expect(t.records().map((r) => r.msg)).toEqual(['custom built'])
    expect(() => log.build({ driver: 'single', name: 'bad-name' })).toThrow(LoggingConfigError)
  })

  test('context: request scope, process scope, shared; ids from AsyncLocalStorage', async () => {
    const t = memoryTransport()
    const { log } = manager({
      default: 'mem',
      channels: { mem: { driver: 'custom', via: () => t, format: 'json' } },
    })
    log.shareContext({ release: 'r1' })
    log.withContext({ process: 'cli' }) // outside a request: the rest of the process
    await runWithLogContext({ requestId: 'req-1', actorId: 'u-7', tenantId: 'acme' }, async () => {
      log.withContext({ orderId: 42 })
      await sleep(1)
      log.info('in request')
      log.withoutContext(['orderId'])
      log.info('order removed')
      log.withContext({ step: 'pay' }).withoutContext()
      log.info('all added removed')
    })
    log.info('after request')
    log.withoutContext()
    log.info('process context cleared')
    log.flushSharedContext()
    log.info('shared cleared')
    await log.flush()
    const by = (msg: string) => t.records().find((r) => r.msg === msg)
    expect(by('in request')).toMatchObject({
      requestId: 'req-1',
      actorId: 'u-7',
      tenantId: 'acme',
      fields: { release: 'r1', process: 'cli', orderId: 42 },
    })
    expect(by('order removed')?.fields).toEqual({ release: 'r1', process: 'cli' })
    expect(by('all added removed')).toMatchObject({ requestId: 'req-1' })
    expect(by('after request')?.fields).toEqual({ release: 'r1', process: 'cli' })
    expect(by('after request')?.requestId).toBeUndefined()
    expect(by('process context cleared')?.fields).toEqual({ release: 'r1' })
    expect(by('shared cleared')?.fields).toBeUndefined()
    expect(log.sharedContext()).toEqual({})
  })

  test('report(): errors with their cause chain; strings, objects and hostile values never throw', async () => {
    const t = memoryTransport()
    const { log } = manager({
      default: 'mem',
      channels: { mem: { driver: 'custom', via: () => t, format: 'json' } },
    })
    log.report(new Error('charge failed', { cause: new Error('timeout') }), { orderId: 1 })
    log.report('plain string')
    log.report({ code: 'E1' })
    log.report(Object.assign(new Error(''), { name: 'EmptyError' }))
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap')
        },
        ownKeys() {
          throw new Error('trap')
        },
      },
    )
    expect(() => log.report(hostile)).not.toThrow()
    await log.flush()
    const recs = t.records()
    expect(recs[0]).toMatchObject({
      level: 'error',
      msg: 'charge failed',
      fields: { orderId: 1 },
      err: { message: 'charge failed', cause: { message: 'timeout' } },
    })
    expect(recs[1]).toMatchObject({ level: 'error', msg: 'plain string' })
    expect(recs[2]).toMatchObject({
      msg: 'Unhandled non-error value',
      fields: { thrown: { code: 'E1' } },
    })
    expect(recs[3]).toMatchObject({ msg: 'EmptyError' })
  })

  test('deprecation() writes to LOG_DEPRECATIONS_CHANNEL', async () => {
    const t = memoryTransport()
    const { log } = manager(
      { channels: { deps: { driver: 'custom', via: () => t, format: 'json' } } },
      { env: { LOG_DEPRECATIONS_CHANNEL: 'deps' } },
    )
    log.deprecation('config key "x" is deprecated', { since: '0.2' })
    await log.flush()
    expect(t.records()).toEqual([
      expect.objectContaining({ level: 'warning', msg: 'config key "x" is deprecated' }),
    ])
  })

  test('.env issues are logged once, at warning, on the default channel', async () => {
    const { log, stdout } = manager({}, { env: { LOG_CHANNEL: 'stdout', LOG_LEVEL: 'loud' } })
    await log.flush()
    expect(log.issues).toHaveLength(1)
    expect(lines(stdout.text())).toEqual([
      expect.stringMatching(
        /production\.WARNING: logs: LOG_LEVEL="loud" is not valid .* \{"component":"logs\.config","key":"LOG_LEVEL"\}$/,
      ),
    ])
  })

  test('handleShutdown registers listeners and close() removes them', async () => {
    const before = process.listenerCount('beforeExit')
    const { log } = manager({ default: 'null' }, { handleShutdown: true, shutdownTimeoutMs: 50 })
    expect(process.listenerCount('beforeExit')).toBe(before + 1)
    await log.close()
    expect(process.listenerCount('beforeExit')).toBe(before)
  })
})

describe('daily and single files through channels', () => {
  test('daily rollover at midnight: every record in its own day file, exactly once', async () => {
    const d = dir()
    let now = Date.parse('2026-11-14T23:59:59.000Z')
    const { log } = manager(
      { default: 'daily', path: d },
      { now: () => now, maxBatchBytes: 600, env: { APP_ENV: 'local' } },
    )
    const n = 400
    for (let i = 0; i < n; i++) {
      log.info('tick', { i })
      now += 5 // crosses midnight half-way
      if (i % 37 === 0) await sleep(0)
    }
    await log.close()
    const files = readLogDir(d)
    expect(files.map((f) => f.file)).toEqual([
      'strutvane-2026-11-14.log',
      'strutvane-2026-11-15.log',
    ])
    const seen = files.flatMap((f) =>
      f.records.map((r) => {
        expect(String(r.time).slice(0, 10)).toBe(f.file.slice(10, 20)) // right day file
        return (r.fields as { i: number }).i
      }),
    )
    expect(seen).toEqual([...Array(n).keys()]) // in order, none lost, none duplicated
    // The line format is what was written.
    expect(readFileSync(join(d, 'strutvane-2026-11-15.log'), 'utf8')).toMatch(/^\[2026-11-15 /)
  })

  test('size parts: -2, -3 … never over the cap, no torn line, never renamed', async () => {
    const d = dir()
    const cap = 4 * 1024
    const { log } = manager(
      { default: 'single', channels: { single: { driver: 'single', path: d, maxFileSize: cap } } },
      { maxBatchBytes: 512, now: () => T0 },
    )
    for (let i = 0; i < 300; i++) log.info('grow', { i, pad: 'p'.repeat(30) })
    await log.close()
    const files = readLogDir(d)
    expect(files.length).toBeGreaterThan(3)
    expect(files.map((f) => f.file)).toEqual(
      files.map((_, i) => (i === 0 ? 'strutvane.log' : `strutvane-${i + 1}.log`)),
    )
    for (const f of files) expect(statSync(join(d, f.file)).size).toBeLessThanOrEqual(cap)
    expect(files.flatMap((f) => f.records).length).toBe(300)
  })

  test('retention keeps LOG_DAILY_DAYS days and never touches the live file', async () => {
    const d = dir()
    for (const day of ['2026-11-01', '2026-11-10', '2026-11-13', '2026-11-14'])
      writeFileSync(join(d, `strutvane-${day}.log`), 'old\n')
    writeFileSync(join(d, 'strutvane-2026-11-01.worker-3.log'), 'old worker\n')
    writeFileSync(join(d, 'payments-2026-11-01.log'), 'other channel\n')
    mkdirSync(join(d, 'sub'))
    let now = Date.parse('2026-11-15T12:00:00Z')
    const { log } = manager(
      { default: 'daily', path: d },
      { env: { LOG_DAILY_DAYS: '2' }, now: () => now },
    )
    log.info('today')
    await log.flush()
    expect(readdirSync(d).sort()).toEqual(
      [
        'payments-2026-11-01.log',
        'strutvane-2026-11-14.log',
        'strutvane-2026-11-15.log',
        'sub',
      ].sort(),
    )
    // The clock jumps back a day: that day's file is being written again, so it survives.
    now = Date.parse('2026-11-14T12:00:00Z')
    log.info('clock went back')
    now = Date.parse('2026-11-15T12:00:01Z')
    log.info('clock is back')
    await log.close()
    expect(readdirSync(d)).toContain('strutvane-2026-11-14.log')
    expect(readFileSync(join(d, 'strutvane-2026-11-14.log'), 'utf8')).toContain('clock went back')
    expect(readFileSync(join(d, 'strutvane-2026-11-15.log'), 'utf8')).toContain('clock is back')
  })

  test('an additional process writes its own files (workerId)', async () => {
    const d = dir()
    const { log } = manager({ default: 'daily', path: d }, { workerId: '2', now: () => T0 })
    log.info('from worker 2')
    await log.close()
    expect(readdirSync(d)).toEqual(['strutvane-2026-11-15.worker-2.log'])
  })
})

describe('secrets never reach any channel, in any format', () => {
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  const SECRETS = [
    'hunter2-password',
    'sk_live_51HxQ2bExampleKey000',
    JWT,
    '4111111111111111',
    'BearerTokenValue123',
    'p4ss-in-url',
    'cookie-secret-value',
  ]

  test('files (line + json), stdout, stderr, a custom channel and the fallback', async () => {
    const d = dir()
    const custom = memoryTransport()
    const failing: Transport = {
      name: 'failing',
      write: (_b: Batch) => Promise.reject(new Error('down')),
      close: () => Promise.resolve(),
    }
    const { log, stdout, stderr } = manager(
      {
        default: 'everything',
        path: d,
        channels: {
          lineFile: { driver: 'daily', name: 'linefile', format: 'line' },
          jsonFile: { driver: 'single', name: 'jsonfile', format: 'json' },
          out: { driver: 'stdout', format: 'json' },
          err: { driver: 'stderr', format: 'line' },
          mem: { driver: 'custom', via: () => custom, format: 'line' },
          broken: { driver: 'custom', via: () => failing, format: 'json' },
          everything: {
            driver: 'stack',
            channels: ['lineFile', 'jsonFile', 'out', 'err', 'mem', 'broken'],
          },
        },
      },
      { now: () => T0 },
    )
    log.withContext({ apiKey: SECRETS[1] }).shareContext({ cookie: SECRETS[6] })
    await runWithLogContext({ requestId: 'r', password: SECRETS[0] }, async () => {
      log.error(`login with Bearer ${SECRETS[4]} and https://user:${SECRETS[5]}@db.internal/x`, {
        password: SECRETS[0],
        nested: { token: JWT, card: SECRETS[3], list: [{ secret: SECRETS[1] }] },
        cardNumber: 4111111111111111,
      })
      log.report(new Error(`failed for ${JWT}`))
      log.channel('lineFile').info(`key ${SECRETS[1]}`)
    })
    await log.close()
    const outputs = [
      ...readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')),
      stdout.text(),
      stderr.text(),
      custom.text(),
    ]
    expect(outputs.join('').length).toBeGreaterThan(0)
    for (const text of outputs) {
      for (const secret of SECRETS) expect(text).not.toContain(secret)
      expect(text).toContain('[REDACTED')
    }
    expect(stderr.text()).toContain('(failing) failed; writing to stderr')
  })
})
