/**
 * `log:tail` takes the blueprint's flags (CONSISTENCY-2026-11-15 #39): `--level=`, `--channel=`,
 * `--grep=`, `--since=` and `--follow`, which is the default (`--no-follow` exits after the
 * backlog).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { logTailCommand, parseSince } from '../src/commands/index.ts'
import { formatLine } from '../src/format/line.ts'
import { captureStream, tempDir, waitFor } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const NOW = Date.parse('2026-11-15T10:00:00.000Z')

function setup(signal?: AbortSignal) {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const records = [
    { time: '2026-11-15T08:00:00.000Z', level: 'info', msg: 'early payment ok' },
    { time: '2026-11-15T09:50:00.000Z', level: 'error', msg: 'payment failed' },
    { time: '2026-11-15T09:55:00.000Z', level: 'info', msg: 'invoice sent' },
  ]
  writeFileSync(
    join(t.dir, 'strutvane-2026-11-15.log'),
    records.map((r) => formatLine(r, 'production', 32_768)).join(''),
  )
  const stdout = captureStream()
  const stderr = captureStream()
  return {
    stdout,
    stderr,
    io: {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { LOG_PATH: t.dir },
      pollMs: 10,
      ...(signal ? { signal } : {}),
    },
  }
}

describe('log:tail flags', () => {
  test('parseSince takes durations and dates', () => {
    expect(parseSince('15m', NOW)).toBe('2026-11-15T09:45:00.000Z')
    expect(parseSince('30s', NOW)).toBe('2026-11-15T09:59:30.000Z')
    expect(parseSince('2h', NOW)).toBe('2026-11-15T08:00:00.000Z')
    expect(parseSince('7d', NOW)).toBe('2026-11-08T10:00:00.000Z')
    expect(parseSince('2026-11-15T09:00:00Z', NOW)).toBe('2026-11-15T09:00:00.000Z')
    expect(parseSince('2026-11-14', NOW)).toBe('2026-11-14T00:00:00.000Z')
    for (const bad of ['', 'soon', '15', '15 minutes', '-5m', 'm', '2026-13-45']) {
      expect(parseSince(bad, NOW), bad).toBeUndefined()
    }
  })

  test('--grep and --since filter; --no-follow exits', async () => {
    const run = setup()
    expect(
      await logTailCommand.run(
        ['--grep=PAYMENT', '--since=2026-11-15T09:00:00Z', '--no-follow'],
        run.io,
      ),
    ).toBe(0)
    expect(run.stdout.text()).toContain('payment failed')
    expect(run.stdout.text()).not.toContain('early payment ok')
    expect(run.stdout.text()).not.toContain('invoice sent')
  })

  test('a bad --since exits 1 with the usage', async () => {
    const run = setup()
    expect(await logTailCommand.run(['--since=soon', '--no-follow'], run.io)).toBe(1)
    expect(run.stderr.text()).toContain('--since="soon" is not a duration')
    expect(run.stderr.text()).toContain('Usage: node strut log:tail')
  })

  test('--filter is not a flag any more (the blueprint calls it --grep)', async () => {
    const run = setup()
    expect(await logTailCommand.run(['--filter=x', '--no-follow'], run.io)).toBe(1)
  })

  test('follow is the default: without --no-follow it keeps running until stopped', async () => {
    const controller = new AbortController()
    const run = setup(controller.signal)
    let finished = false
    const running = logTailCommand.run(['-n', '1'], run.io).then((code) => {
      finished = true
      return code
    })
    await waitFor(() => run.stdout.text().includes('invoice sent'), 5_000)
    await new Promise((r) => setTimeout(r, 100))
    expect(finished).toBe(false)
    controller.abort()
    expect(await running).toBe(0)
  })
})
