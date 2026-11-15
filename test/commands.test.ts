/**
 * `log:tail`, `log:list` and `log:clear` (ADR-0022 §8): pure functions and the command adapters.
 * Per-process files written by real child processes are merged by timestamp; clearing never
 * deletes a live file; output is always safe, one line per record.
 */
import { spawn } from 'node:child_process'
import { readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  clearLogs,
  formatLogList,
  formatTailEntry,
  humanSize,
  LogSourceError,
  listLogs,
  logClearCommand,
  logCommands,
  logListCommand,
  logTailCommand,
  matchesTail,
  mergeByTime,
  sourcesFor,
  type TailEntry,
  tailLogs,
} from '../src/commands/index.ts'
import { resolveLoggingConfig } from '../src/config.ts'
import { createFormatter } from '../src/format/formatter.ts'
import { captureStream, sleep, tempDir, waitFor } from './helpers.ts'

const writerChild = fileURLToPath(new URL('./fixtures/child-writer.ts', import.meta.url))
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})
function dir(): string {
  const t = tempDir()
  cleanups.push(t.cleanup)
  return t.dir
}
const ESC = String.fromCharCode(0x1b)
const json = createFormatter('json')
const line = createFormatter('line', { env: 'local' })
const rec = (time: string, level: string, msg: string, fields?: Record<string, unknown>) => ({
  time: `2026-11-15T${time}Z`,
  level,
  msg,
  ...(fields ? { fields } : {}),
})
const src = (d: string, ...bases: string[]) => [
  { dir: d, bases: new Set(bases.length ? bases : ['strutvane']) },
]
const collect = async (it: AsyncIterable<TailEntry>) => {
  const out: TailEntry[] = []
  for await (const e of it) out.push(e)
  return out
}

function io(extra: Record<string, unknown> = {}) {
  const stdout = captureStream()
  const stderr = captureStream()
  return { stdout, stderr, io: { stdout: stdout.stream, stderr: stderr.stream, ...extra } }
}

function run(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: 'ignore' })
    p.once('exit', (code) => resolve(code))
  })
}

describe('tail: pure parts', () => {
  test('matchesTail: minimum level (aliases too) and case-insensitive text', () => {
    const r = { level: 'error', msg: 'Payment FAILED', fields: { orderId: 7 } }
    expect(matchesTail(r, {})).toBe(true)
    expect(matchesTail(r, { level: 'warning' })).toBe(true)
    expect(matchesTail(r, { level: 'critical' })).toBe(false)
    expect(matchesTail({ ...r, level: 'warn' }, { level: 'warning' })).toBe(true)
    expect(matchesTail({ ...r, level: 'odd' }, { level: 'debug' })).toBe(false)
    expect(matchesTail(r, { text: 'payment failed' })).toBe(true)
    expect(matchesTail(r, { text: 'orderid' })).toBe(true)
    expect(matchesTail(r, { text: 'refund' })).toBe(false)
    expect(matchesTail({ n: 1n } as never, { text: 'x' })).toBe(false) // unserialisable: skipped
  })

  test('mergeByTime is stable and puts records without a time last', () => {
    const e = (file: string, time?: string): TailEntry => ({
      dir: 'd',
      file,
      record: time === undefined ? { msg: file } : { time, msg: file },
    })
    const merged = mergeByTime([
      e('a1', '2026-11-15T10:00:02.000Z'),
      e('a2', '2026-11-15T10:00:03.000Z'),
      e('b1', '2026-11-15T10:00:01.000Z'),
      e('b2', '2026-11-15T10:00:03.000Z'),
      e('none'),
    ])
    expect(merged.map((x) => x.file)).toEqual(['none', 'b1', 'a1', 'a2', 'b2'])
  })

  test('formatTailEntry prints one safe line, re-sanitised', () => {
    const entry: TailEntry = {
      dir: 'd',
      file: 'f',
      record: {
        time: '2026-11-15T10:00:00.000Z',
        level: 'error',
        msg: `evil${ESC}[2J\nforged`,
        env: 'local',
        fields: { password: 'hunter2' },
      },
    }
    const out = formatTailEntry(entry)
    expect(out).toBe(
      '[2026-11-15 10:00:00.000] local.ERROR: evil\\u001b[2J\\nforged {"password":"[REDACTED]"}',
    )
    expect(formatTailEntry({ ...entry, record: { msg: 'm' } })).toContain('production.INFO: m {}')
  })
})

describe('tail: files', () => {
  test('backlog: the last N matching records across processes and formats, merged by time', async () => {
    const d = dir()
    writeFileSync(
      join(d, 'strutvane-2026-11-15.log'),
      line(rec('10:00:01.000', 'info', 'main 1'), 4096) +
        line(rec('10:00:04.000', 'error', 'main 4'), 4096) +
        line(rec('10:00:06.000', 'debug', 'main 6'), 4096),
    )
    writeFileSync(
      join(d, 'strutvane-2026-11-15.worker-2.log'),
      json(rec('10:00:02.000', 'warning', 'w2 2'), 4096) +
        json(rec('10:00:05.000', 'info', 'w2 5'), 4096) +
        '{"time":"2026-11-15T10:00:07.000Z","level":"info","msg":"torn',
    )
    writeFileSync(
      join(d, 'strutvane-2026-11-14.log'),
      line(rec('09:00:00.000', 'info', 'yesterday'), 4096),
    )
    writeFileSync(
      join(d, 'other-2026-11-15.log'),
      line(rec('10:00:03.000', 'info', 'other base'), 4096),
    )
    writeFileSync(join(d, 'notes.txt'), 'not a log\n')
    const msgs = async (opts: Record<string, unknown>) =>
      (await collect(tailLogs({ sources: src(d), ...opts }))).map((e) => e.record.msg)
    expect(await msgs({ lines: 4 })).toEqual(['w2 2', 'main 4', 'w2 5', 'main 6'])
    expect(await msgs({ lines: 100 })).toEqual([
      'yesterday',
      'main 1',
      'w2 2',
      'main 4',
      'w2 5',
      'main 6',
    ])
    expect(await msgs({ lines: 10, level: 'warning' })).toEqual(['w2 2', 'main 4'])
    expect(await msgs({ lines: 10, text: 'W2' })).toEqual(['w2 2', 'w2 5'])
    expect(await msgs({ lines: 0 })).toEqual([])
    expect(
      (await collect(tailLogs({ sources: src(d, 'other'), lines: 5 }))).map((e) => e.record.msg),
    ).toEqual(['other base'])
  })

  test('follow: new records from every file, torn lines held back, merged per poll, stops on abort', async () => {
    const d = dir()
    const main = join(d, 'strutvane-2026-11-15.log')
    writeFileSync(main, line(rec('10:00:00.000', 'info', 'old'), 4096))
    const controller = new AbortController()
    const seen: string[] = []
    const done = (async () => {
      for await (const e of tailLogs({
        sources: src(d),
        lines: 0,
        follow: true,
        pollMs: 20,
        maxReadBytes: 64,
        signal: controller.signal,
      }))
        seen.push(String(e.record.msg))
    })()
    await sleep(50)
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      main,
      `${line(rec('10:00:03.000', 'info', 'main new'), 4096)}[2026-11-15 10:00:09.000] local.INFO: ha`,
    )
    writeFileSync(
      join(d, 'strutvane-2026-11-15.worker-1.log'),
      json(rec('10:00:02.000', 'info', 'worker new'), 4096),
    )
    await waitFor(() => seen.length >= 2, 3_000)
    appendFileSync(main, 'lf done {}\n')
    await waitFor(() => seen.length >= 3, 3_000)
    // A cleared and recreated file is read from the start.
    writeFileSync(main, line(rec('10:00:10.000', 'info', 'after clear'), 4096))
    await waitFor(() => seen.includes('after clear'), 3_000)
    controller.abort()
    await done
    expect(seen.slice(0, 3).sort()).toEqual(['main new', 'worker new', 'half done'].sort())
    expect(seen).not.toContain('old')
  })

  test('real child processes: per-process files (mixed formats) merge into one ordered stream', async () => {
    const d = dir()
    const count = 400
    const codes = await Promise.all(
      [0, 1, 2].map((id) =>
        run([
          writerChild,
          d,
          String(id),
          String(count),
          String(64 * 1024),
          id === 1 ? 'line' : 'json',
        ]),
      ),
    )
    expect(codes).toEqual([0, 0, 0])
    const names = readdirSync(d)
    expect(names.some((n) => n.includes('.worker-1'))).toBe(true)
    expect(names.some((n) => n.includes('.worker-2'))).toBe(true)
    expect(names.some((n) => /^strutvane-\d{4}-\d{2}-\d{2}(-\d+)?\.log$/.test(n))).toBe(true)
    const all = await collect(tailLogs({ sources: src(d), lines: 10_000 }))
    expect(all).toHaveLength(3 * count)
    const times = all.map((e) => String(e.record.time))
    expect(times).toEqual([...times].sort())
    for (const id of [0, 1, 2]) {
      const mine = all
        .map((e) => e.record.fields as { proc: number; i: number })
        .filter((f) => f.proc === id)
        .map((f) => f.i)
      expect(mine).toEqual([...Array(count).keys()]) // each process's own order is kept
    }
  })
})

describe('list and clear', () => {
  test('listLogs: files, sizes, days; formatLogList prints them', async () => {
    const d = dir()
    writeFileSync(join(d, 'strutvane-2026-11-14.log'), 'x'.repeat(2048))
    writeFileSync(join(d, 'strutvane-2026-11-15.log'), 'y\n')
    writeFileSync(join(d, 'strutvane-2026-11-15.worker-3.log'), 'z\n')
    writeFileSync(join(d, 'auth.log'), 'foreign\n')
    const listing = await listLogs(src(d))
    expect(listing.files.map((f) => f.name)).toEqual([
      'strutvane-2026-11-15.worker-3.log',
      'strutvane-2026-11-15.log',
      'strutvane-2026-11-14.log',
    ])
    expect(listing.files[0]).toMatchObject({
      dir: d,
      base: 'strutvane',
      kind: 'daily',
      worker: '3',
      part: 1,
    })
    expect(listing.days).toEqual([
      { day: '2026-11-15', files: 2, bytes: 4 },
      { day: '2026-11-14', files: 1, bytes: 2048 },
    ])
    expect(listing.totalBytes).toBe(2052)
    const text = formatLogList(listing).join('\n')
    expect(text).toContain('strutvane-2026-11-14.log')
    expect(text).toContain('2.0 KB')
    expect(text).toContain('Total: 3 file(s), 2.0 KB')
    expect(formatLogList(await listLogs(src(join(d, 'missing'))))).toEqual(['No log files yet.'])
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(100 * 1024 ** 2)).toBe('100.0 MB')
    expect(humanSize(3 * 1024 ** 4)).toBe('3.0 TB')
  })

  test('clearLogs: keeps the last N days, never a live file', async () => {
    const d = dir()
    for (const n of [
      'strutvane-2026-11-01.log',
      'strutvane-2026-11-13.log',
      'strutvane-2026-11-15.log',
      'strutvane-2026-11-01.worker-2.log', // the newest file of worker 2: maybe still running
      'strutvane.log',
    ])
      writeFileSync(join(d, n), 'x\n')
    utimesSync(join(d, 'strutvane.log'), new Date('2026-10-01'), new Date('2026-10-01'))
    const now = Date.parse('2026-11-15T12:00:00Z')
    const kept = await clearLogs(src(d), { confirm: true, days: 3, now })
    expect(kept.deleted).toEqual(['strutvane-2026-11-01.log'])
    expect(kept.live).toEqual(['strutvane.log', 'strutvane-2026-11-01.worker-2.log'])
    const all = await clearLogs(src(d), { confirm: true, now })
    expect(all.deleted).toEqual(['strutvane-2026-11-13.log'])
    expect(readdirSync(d).sort()).toEqual(
      ['strutvane-2026-11-01.worker-2.log', 'strutvane-2026-11-15.log', 'strutvane.log'].sort(),
    )
    await expect(clearLogs(src(d), { confirm: true, days: -1 })).rejects.toThrow(RangeError)
  })

  test('sourcesFor: a channel (or a stack) maps to its file bases; non-file channels are explained', () => {
    const { config } = resolveLoggingConfig(
      {
        path: '/logs',
        channels: {
          payments: { driver: 'daily', name: 'payments' },
          elsewhere: { driver: 'single', path: '/other', name: 'audit' },
          audit: { driver: 'stack', channels: ['payments', 'elsewhere', 'stderr'] },
        },
      },
      { env: { LOG_STACK: 'single,daily' }, root: '/' },
    )
    const view = (list: ReturnType<typeof sourcesFor>) => list.map((s) => [s.dir, [...s.bases]])
    const base = config.path
    expect(view(sourcesFor(config, 'payments'))).toEqual([[base, ['payments']]])
    expect(view(sourcesFor(config, 'stack'))).toEqual([[base, ['strutvane']]])
    expect(view(sourcesFor(config, 'audit'))).toEqual([
      [base, ['payments']],
      ['/other', ['audit']],
    ])
    expect(view(sourcesFor(config))).toEqual([
      [base, ['strutvane', 'payments']],
      ['/other', ['audit']],
    ])
    expect(() => sourcesFor(config, 'stderr')).toThrow(LogSourceError)
    expect(() => sourcesFor(config, 'stderr')).toThrow(/writes no files/)
    expect(() => sourcesFor(config, 'nope')).toThrow(/not defined in config\/logging/)
    const none = resolveLoggingConfig(
      { channels: { single: { driver: 'stderr' }, daily: { driver: 'stdout' } } },
      { env: {} },
    )
    expect(view(sourcesFor(none.config))).toEqual([[none.config.path, ['strutvane']]])
  })
})

describe('command adapters', () => {
  test('the registry lists three commands with usage', () => {
    expect(logCommands.map((c) => c.name)).toEqual(['log:tail', 'log:list', 'log:clear'])
    for (const c of logCommands) {
      expect(c.summary.length).toBeGreaterThan(10)
      expect(c.usage).toContain(`node strut ${c.name}`)
    }
  })

  test('log:tail prints safe lines; bad options exit 1 with the usage', async () => {
    const d = dir()
    writeFileSync(
      join(d, 'strutvane-2026-11-15.log'),
      line(rec('10:00:01.000', 'info', 'hello'), 4096) +
        json(rec('10:00:02.000', 'error', `bad${ESC}[31m`), 4096),
    )
    const env = { LOG_PATH: d }
    const a = io({ env })
    expect(await logTailCommand.run(['-n', '5', '--level=warn', '--no-follow'], a.io)).toBe(0)
    expect(a.stdout.text()).toBe('[2026-11-15 10:00:02.000] production.ERROR: bad\\u001b[31m {}\n')
    const b = io({ env })
    expect(
      await logTailCommand.run(['--grep', 'HELLO', '--channel', 'daily', '--no-follow'], b.io),
    ).toBe(0)
    expect(b.stdout.text()).toContain('local.INFO: hello')
    const c = io({ env })
    expect(await logTailCommand.run(['--level=loud'], c.io)).toBe(1)
    expect(c.stderr.text()).toContain('"loud" is not a level')
    expect(c.stderr.text()).toContain('Usage: node strut log:tail')
    const e = io({ env })
    expect(await logTailCommand.run(['--nope'], e.io)).toBe(1)
    expect(e.stderr.text()).toContain('Usage: node strut log:tail')
    const f = io({ env })
    expect(await logTailCommand.run(['--channel=stderr'], f.io)).toBe(1)
    expect(f.stderr.text()).toBe(
      'log:tail: channel "stderr" writes no files (it isn\'t single or daily); the log commands read files\n',
    )
    const g = io({ env })
    expect(await logTailCommand.run(['-n', 'many'], g.io)).toBe(1)
    expect(g.stderr.text()).toContain('--lines must be a whole number')
  })

  test('log:tail --follow stops when the signal aborts', async () => {
    const d = dir()
    const controller = new AbortController()
    const a = io({ env: { LOG_PATH: d }, signal: controller.signal, pollMs: 10 })
    const running = logTailCommand.run(['-f', '-n', '0'], a.io)
    await sleep(30)
    writeFileSync(
      join(d, 'strutvane-2026-11-15.log'),
      line(rec('10:00:00.000', 'notice', 'live'), 4096),
    )
    await waitFor(() => a.stdout.text().includes('live'), 3_000)
    controller.abort()
    expect(await running).toBe(0)
  })

  test('log:list and log:clear', async () => {
    const d = dir()
    writeFileSync(join(d, 'strutvane-2026-11-01.log'), 'x\n')
    writeFileSync(join(d, 'strutvane-2026-11-02.log'), 'x\n')
    const env = { LOG_PATH: d }
    const a = io({ env })
    expect(await logListCommand.run([], a.io)).toBe(0)
    expect(a.stdout.text()).toContain('strutvane-2026-11-02.log')
    const b = io({ env, config: {} })
    expect(await logClearCommand.run(['--days=1', '--force'], b.io)).toBe(0)
    expect(b.stdout.text()).toBe(
      'Deleted 1 file(s). Kept 1 file(s) still being written: strutvane-2026-11-02.log.\n',
    )
    const c = io({ env })
    expect(await logClearCommand.run(['--force'], c.io)).toBe(0)
    expect(c.stdout.text()).toBe(
      'Deleted 0 file(s). Kept 1 file(s) still being written: strutvane-2026-11-02.log.\n',
    )
    const e = io({ env })
    expect(await logClearCommand.run(['--days=x', '--force'], e.io)).toBe(1)
    const f = io({ env })
    expect(await logListCommand.run(['--channel=nope'], f.io)).toBe(1)
    expect(f.stderr.text()).toContain('channel "nope" is not defined')
    const g = io({ env: { LOG_PATH: join(d, 'empty') } })
    expect(await logClearCommand.run(['--force'], g.io)).toBe(0)
    expect(g.stdout.text()).toBe('Deleted 0 file(s).\n')
  })
})
