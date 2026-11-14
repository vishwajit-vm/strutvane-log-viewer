/**
 * File naming, ordering, retention and clearing (ADR-0022 §6): names parse one way only,
 * `compareLogFiles` never string-sorts (the RFC-0004 bug class), retention deletes whole days and
 * never the day being written, clearing never deletes a stream's live file or foreign files.
 */
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vitest'
import {
  applyRetention,
  clearLogFiles,
  compareLogFiles,
  dayKeyOf,
  fileDay,
  isDayKey,
  isLogBaseName,
  isWorkerId,
  listLogFiles,
  logFileName,
  newestPerStream,
  parseLogFileName,
  shiftDay,
} from '../src/files.ts'
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
const touch = (d: string, ...names: string[]) => {
  for (const n of names) writeFileSync(join(d, n), 'x\n')
}

describe('names', () => {
  test('build and parse: single, daily, workers, parts', () => {
    expect(logFileName({ base: 'strutvane' })).toBe('strutvane.log')
    expect(logFileName({ base: 'strutvane', part: 2 })).toBe('strutvane-2.log')
    expect(logFileName({ base: 'strutvane', day: '2026-11-15' })).toBe('strutvane-2026-11-15.log')
    expect(logFileName({ base: 'strutvane', day: '2026-11-15', part: 3 })).toBe(
      'strutvane-2026-11-15-3.log',
    )
    expect(logFileName({ base: 'strutvane', day: '2026-11-15', worker: '2' })).toBe(
      'strutvane-2026-11-15.worker-2.log',
    )
    expect(logFileName({ base: 'payments', worker: 't7', part: 2 })).toBe(
      'payments.worker-t7-2.log',
    )
    expect(parseLogFileName('strutvane-2026-11-15.worker-2-3.log')).toEqual({
      base: 'strutvane',
      kind: 'daily',
      day: '2026-11-15',
      worker: '2',
      part: 3,
    })
    expect(parseLogFileName('strutvane-2.log')).toEqual({
      base: 'strutvane',
      kind: 'single',
      part: 2,
    })
    expect(parseLogFileName('strutvane.log')).toEqual({
      base: 'strutvane',
      kind: 'single',
      part: 1,
    })
  })

  test('foreign and malformed names are not log files', () => {
    for (const name of [
      'notes.txt',
      '../strutvane.log',
      'strutvane-2026-02-30.log', // not a real day
      'strutvane-1.log', // part 1 has no suffix: one name per file
      'strutvane-0.log',
      'my-app.log', // base names have no dash
      'strutvane.worker-.log',
      'strutvane-2026-11-15.ndjson', // v1 extension
      '2026-11-14.ndjson',
      '.log',
    ])
      expect(parseLogFileName(name)).toBeUndefined()
  })

  test('invalid parts are refused with a hint', () => {
    expect(() => logFileName({ base: 'my-app' })).toThrow(/letters, digits and _ only/)
    expect(() => logFileName({ base: 'a', day: '2026-13-01' })).toThrow(/YYYY-MM-DD/)
    expect(() => logFileName({ base: 'a', worker: '../x' })).toThrow(/worker id/)
    expect(() => logFileName({ base: 'a', part: 0 })).toThrow(/whole number/)
    expect(isLogBaseName('payments_eu')).toBe(true)
    expect(isWorkerId('2')).toBe(true)
    expect(isWorkerId('')).toBe(false)
  })

  test('round trip: every built name parses back to its parts (property)', () => {
    const word = fc.stringMatching(/^[A-Za-z0-9_]{1,12}$/)
    const day = fc
      .integer({ min: Date.parse('2000-01-01'), max: Date.parse('2099-12-31') })
      .map(dayKeyOf)
    fc.assert(
      fc.property(
        word,
        fc.option(day, { nil: undefined }),
        fc.option(word, { nil: undefined }),
        fc.integer({ min: 1, max: 999_999 }),
        (base, d, worker, part) => {
          const parsed = parseLogFileName(logFileName({ base, day: d, worker, part }))
          return (
            parsed !== undefined &&
            parsed.base === base &&
            parsed.day === d &&
            parsed.worker === worker &&
            parsed.part === part
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  test('day helpers', () => {
    expect(isDayKey('2026-11-14')).toBe(true)
    expect(isDayKey('2026-13-01')).toBe(false)
    expect(isDayKey('20261114')).toBe(false)
    expect(dayKeyOf(Date.parse('2026-11-14T23:59:59Z'))).toBe('2026-11-14')
    expect(shiftDay('2026-11-01', 1)).toBe('2026-10-31')
    expect(shiftDay('2026-12-31', -1)).toBe('2027-01-01')
  })
})

describe('compareLogFiles (never a string sort)', () => {
  test('base, single before daily, day, main process before workers (numeric), part number', () => {
    const names = [
      'z.txt',
      'strutvane-2026-11-14-10.log',
      'strutvane-2026-11-14.worker-10.log',
      'strutvane-2026-11-14.worker-2.log',
      'strutvane-2026-11-14.worker-2-2.log',
      'strutvane-2026-11-14-2.log',
      'a.txt',
      'strutvane-2026-11-13.log',
      'strutvane-2026-11-14.log',
      'strutvane-10.log',
      'strutvane.log',
      'strutvane-2.log',
      'payments-2026-11-14.log',
    ]
    expect([...names].sort(compareLogFiles)).toEqual([
      'payments-2026-11-14.log',
      'strutvane.log',
      'strutvane-2.log',
      'strutvane-10.log',
      'strutvane-2026-11-13.log',
      'strutvane-2026-11-14.log',
      'strutvane-2026-11-14-2.log',
      'strutvane-2026-11-14-10.log',
      'strutvane-2026-11-14.worker-2.log',
      'strutvane-2026-11-14.worker-2-2.log',
      'strutvane-2026-11-14.worker-10.log',
      'a.txt',
      'z.txt',
    ])
    // The bug class: a plain string sort gets these wrong.
    expect(['strutvane-2026-11-14-10.log', 'strutvane-2026-11-14-2.log'].sort()).toEqual([
      'strutvane-2026-11-14-10.log',
      'strutvane-2026-11-14-2.log',
    ])
    expect(compareLogFiles('a.txt', 'a.txt')).toBe(0)
    expect(compareLogFiles('x.worker-a.log', 'x.worker-B.log')).not.toBe(0)
  })

  test('ordering is a total order consistent with the parts (property)', () => {
    const name = fc
      .record({
        base: fc.constantFrom('a', 'b'),
        day: fc.option(fc.constantFrom('2026-11-14', '2026-11-15'), { nil: undefined }),
        worker: fc.option(fc.constantFrom('1', '2', '10'), { nil: undefined }),
        part: fc.integer({ min: 1, max: 12 }),
      })
      .map((p) => logFileName(p))
    fc.assert(
      fc.property(fc.array(name, { maxLength: 30 }), (list) => {
        const sorted = [...list].sort(compareLogFiles)
        for (let i = 1; i < sorted.length; i++) {
          const a = parseLogFileName(sorted[i - 1] ?? '')
          const b = parseLogFileName(sorted[i] ?? '')
          if (!a || !b) return false
          if (a.base === b.base && a.kind === b.kind && a.day === b.day && a.worker === b.worker)
            if (a.part > b.part) return false
        }
        return true
      }),
      { numRuns: 300 },
    )
  })

  test('listLogFiles: log files only, optionally of some bases; a missing dir is empty', async () => {
    const d = dir()
    touch(d, 'strutvane-2.log', 'strutvane.log', 'payments.log', 'secrets.env', 'auth.log')
    expect(await listLogFiles(d)).toEqual([
      'auth.log',
      'payments.log',
      'strutvane.log',
      'strutvane-2.log',
    ])
    expect(await listLogFiles(d, new Set(['strutvane']))).toEqual([
      'strutvane.log',
      'strutvane-2.log',
    ])
    expect(await listLogFiles(join(d, 'missing'))).toEqual([])
  })
})

describe('retention (LOG_DAILY_DAYS)', () => {
  const NOW = Date.parse('2026-11-15T09:00:00Z')

  test('keeps the last N days (today included), deletes whole days of one base only', async () => {
    const d = dir()
    touch(
      d,
      'strutvane-2026-11-01.log',
      'strutvane-2026-11-01-2.log',
      'strutvane-2026-11-01.worker-3.log',
      'strutvane-2026-11-01.worker-3-2.log',
      'strutvane-2026-11-01.log.bak',
      'strutvane-2026-11-01.ndjson',
      'strutvane-2026-11-14.log',
      'strutvane-2026-11-15.log',
      'strutvane.log',
      'payments-2026-11-01.log',
      'notes.txt',
    )
    // A directory with a log-like name can't be unlinked: skipped, never fatal.
    mkdirSync(join(d, 'strutvane-2026-10-01.log'))
    utimesSync(join(d, 'strutvane-2026-11-14.log'), new Date(0), new Date(0)) // mtime is irrelevant
    const deleted = await applyRetention(d, { base: 'strutvane', days: 2, now: NOW })
    expect(deleted.sort()).toEqual(
      [
        'strutvane-2026-11-01.log',
        'strutvane-2026-11-01-2.log',
        'strutvane-2026-11-01.worker-3.log',
        'strutvane-2026-11-01.worker-3-2.log',
      ].sort(),
    )
    expect(readdirSync(d).sort()).toEqual(
      [
        'notes.txt',
        'payments-2026-11-01.log',
        'strutvane-2026-10-01.log',
        'strutvane-2026-11-01.log.bak',
        'strutvane-2026-11-01.ndjson',
        'strutvane-2026-11-14.log',
        'strutvane-2026-11-15.log',
        'strutvane.log',
      ].sort(),
    )
    expect(await applyRetention(d, { base: 'strutvane', days: 0, now: NOW })).toEqual([])
  })

  test('never deletes the day being written, even when the clock says it is old', async () => {
    const d = dir()
    touch(d, 'strutvane-2026-11-01.log', 'strutvane-2026-10-31.log')
    const deleted = await applyRetention(d, {
      base: 'strutvane',
      days: 1,
      now: NOW,
      writingDay: '2026-11-01',
    })
    expect(deleted).toEqual(['strutvane-2026-10-31.log'])
    expect(readdirSync(d)).toEqual(['strutvane-2026-11-01.log'])
  })
})

describe('clearing (log:clear, the viewer)', () => {
  test('never deletes the newest file of a stream, nor foreign or other-base files', async () => {
    const d = dir()
    touch(
      d,
      'strutvane-2026-11-13.log',
      'strutvane-2026-11-14.log',
      'strutvane-2026-11-14-2.log',
      'strutvane-2026-11-13.worker-2.log',
      'strutvane.log',
      'strutvane-2.log',
      'auth.log',
      'payments-2026-11-01.log',
    )
    expect(newestPerStream(await listLogFiles(d))).toEqual(
      new Set([
        'strutvane-2026-11-14-2.log',
        'strutvane-2026-11-13.worker-2.log',
        'strutvane-2.log',
        'auth.log',
        'payments-2026-11-01.log',
      ]),
    )
    const result = await clearLogFiles(d)
    expect([...result.deleted].sort()).toEqual(
      ['strutvane-2026-11-13.log', 'strutvane-2026-11-14.log', 'strutvane.log'].sort(),
    )
    expect([...result.live].sort()).toEqual(
      ['strutvane-2.log', 'strutvane-2026-11-13.worker-2.log', 'strutvane-2026-11-14-2.log'].sort(),
    )
    expect(readdirSync(d)).toEqual(expect.arrayContaining(['auth.log', 'payments-2026-11-01.log']))
  })

  test('`before` limits by day; a single file is dated by its last write', async () => {
    const d = dir()
    touch(
      d,
      'strutvane-2026-11-01.log',
      'strutvane-2026-11-14.log',
      'strutvane.log',
      'strutvane-2.log',
    )
    utimesSync(join(d, 'strutvane.log'), new Date('2026-10-01'), new Date('2026-10-01'))
    expect(await fileDay(d, 'strutvane.log')).toBe('2026-10-01')
    expect(await fileDay(d, 'notes.txt')).toBeUndefined()
    expect(await fileDay(d, 'strutvane-9.log')).toBeUndefined() // vanished
    const result = await clearLogFiles(d, { before: '2026-11-10' })
    expect([...result.deleted].sort()).toEqual(['strutvane-2026-11-01.log', 'strutvane.log'])
    expect(readdirSync(d).sort()).toEqual(['strutvane-2.log', 'strutvane-2026-11-14.log'])
  })
})
