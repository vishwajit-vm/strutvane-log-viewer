/**
 * Clearing never deletes today's files, nor any dated later (audit 2026-11-15). The "newest file
 * of each stream" rule alone is not enough: a file dated tomorrow (a clock that was ahead, another
 * host writing into a shared directory) made today's live file look old, and `log:clear` without
 * `--days` deleted it while the process was still appending to it. On Linux those records then
 * go to an unlinked file nobody can read.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { clearLogs } from '../src/commands/list.ts'
import { clearLogFiles } from '../src/files.ts'
import { tempDir } from './helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})
function dir(): string {
  const t = tempDir()
  cleanups.push(t.cleanup)
  return t.dir
}

const NOW = Date.parse('2026-11-15T10:00:00.000Z')
const files = [
  'strutvane-2026-11-13.log',
  'strutvane-2026-11-14.log',
  'strutvane-2026-11-15.log', // today, live
  'strutvane-2026-11-15.worker-2.log', // today, another process
  'strutvane-2026-11-16.log', // tomorrow: a skewed clock
  'strutvane-2026-11-15-2.log', // today, a later part
]

function seed(d: string): void {
  for (const f of files) writeFileSync(join(d, f), 'x\n')
}

describe('clearing keeps today and later', () => {
  test.each([undefined, '2026-11-15', '2026-11-16', '2099-01-01'])(
    'clearLogFiles(before = %s) never deletes a file dated today or later',
    async (before) => {
      const d = dir()
      seed(d)
      const result = await clearLogFiles(d, { now: NOW, ...(before ? { before } : {}) })
      for (const f of files.filter((name) => name >= 'strutvane-2026-11-15'))
        expect(existsSync(join(d, f)), f).toBe(true)
      expect(result.deleted).toEqual(['strutvane-2026-11-13.log', 'strutvane-2026-11-14.log'])
    },
  )

  test('log:clear without --days keeps today, with the same rule', async () => {
    const d = dir()
    seed(d)
    const result = await clearLogs([{ dir: d, bases: new Set(['strutvane']) }], {
      now: NOW,
    })
    expect(result.deleted).toEqual(['strutvane-2026-11-13.log', 'strutvane-2026-11-14.log'])
    expect(existsSync(join(d, 'strutvane-2026-11-15.log'))).toBe(true)
  })
})
