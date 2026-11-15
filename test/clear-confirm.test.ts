/**
 * `log:clear` deletes files and can't be undone, so it needs an explicit confirmation (audit
 * 2026-11-15): the function takes `confirm: true`, and the command asks in a terminal or needs
 * `--force` when there is none. Every refusal deletes nothing.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ClearNotConfirmedError, clearLogs, logClearCommand } from '../src/commands/index.ts'
import { captureStream, tempDir } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function seeded(): { dir: string; old: string } {
  const t = tempDir()
  cleanups.push(t.cleanup)
  writeFileSync(join(t.dir, 'strutvane-2026-11-01.log'), 'x\n')
  writeFileSync(join(t.dir, 'strutvane-2026-11-02.log'), 'x\n')
  return { dir: t.dir, old: join(t.dir, 'strutvane-2026-11-01.log') }
}

function io(dir: string, confirm?: (q: string) => Promise<boolean>) {
  const stdout = captureStream()
  const stderr = captureStream()
  const questions: string[] = []
  return {
    stdout,
    stderr,
    questions,
    io: {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { LOG_PATH: dir },
      ...(confirm
        ? {
            confirm: (q: string) => {
              questions.push(q)
              return confirm(q)
            },
          }
        : {}),
    },
  }
}

describe('clearLogs needs confirm: true', () => {
  test.each([undefined, {}, { confirm: false }, { confirm: 'yes' }, { confirm: 1 }])(
    'refuses %j and deletes nothing',
    async (options) => {
      const { dir, old } = seeded()
      const sources = [{ dir, bases: new Set(['strutvane']) }]
      await expect(clearLogs(sources, options as never)).rejects.toThrow(ClearNotConfirmedError)
      expect(existsSync(old)).toBe(true)
    },
  )

  test('deletes with confirm: true', async () => {
    const { dir, old } = seeded()
    const result = await clearLogs([{ dir, bases: new Set(['strutvane']) }], { confirm: true })
    expect(result.deleted).toEqual(['strutvane-2026-11-01.log'])
    expect(existsSync(old)).toBe(false)
  })
})

describe('the log:clear command asks first', () => {
  test('without a terminal and without --force it refuses, with a hint', async () => {
    const { dir, old } = seeded()
    const run = io(dir)
    expect(await logClearCommand.run([], run.io)).toBe(1)
    expect(run.stderr.text()).toContain('run it again with --force')
    expect(existsSync(old)).toBe(true)
  })

  test('a "no" answer deletes nothing', async () => {
    const { dir, old } = seeded()
    const run = io(dir, async () => false)
    expect(await logClearCommand.run(['--days=3', '--channel=daily'], run.io)).toBe(1)
    expect(run.questions).toEqual([
      'Delete the "daily" log files older than the last 3 day(s)? Files still being written are kept. [y/N] ',
    ])
    expect(run.stdout.text()).toBe('Cancelled; nothing was deleted.\n')
    expect(existsSync(old)).toBe(true)
  })

  test('a "yes" answer deletes', async () => {
    const { dir, old } = seeded()
    const run = io(dir, async () => true)
    expect(await logClearCommand.run([], run.io)).toBe(0)
    expect(existsSync(old)).toBe(false)
  })

  test('--force skips the question', async () => {
    const { dir, old } = seeded()
    const run = io(dir, async () => {
      throw new Error('must not ask')
    })
    expect(await logClearCommand.run(['--force'], run.io)).toBe(0)
    expect(run.questions).toEqual([])
    expect(existsSync(old)).toBe(false)
  })
})
