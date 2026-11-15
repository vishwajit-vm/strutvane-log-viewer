/**
 * The viewer's record pages merge the per-process files by timestamp (ADR-0022 §6). Every
 * additional process (queue worker, scheduler, cluster worker) writes its own file; reading the
 * files one after the other showed one process's records, then the next one's, so an incident
 * that spans the web process and a worker read out of order. Paging (any limit, any scan budget)
 * must still visit every record exactly once, newest first.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vitest'
import { formatLine } from '../src/format/line.ts'
import { serializeRecord } from '../src/serialize.ts'
import { type Cursor, decodeCursor, encodeCursor, readPage } from '../src/viewer/store.ts'
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

const at = (day: string, second: number): string =>
  new Date(Date.parse(`${day}T10:00:00.000Z`) + second * 1000).toISOString()

/** Write records (oldest first) to `file`, alternating the two formats line by line. */
function write(d: string, file: string, records: Array<{ time: string; msg: string }>): void {
  writeFileSync(
    join(d, file),
    records
      .map((r, i) =>
        i % 2 === 0
          ? formatLine({ ...r, level: 'info' }, 'local', 32_768)
          : serializeRecord({ ...r, level: 'info' }),
      )
      .join(''),
  )
}

/**
 * Day 2026-11-14: main process (parts 1 and 2), worker 2 and worker 10, interleaved by time.
 * Day 2026-11-15: main and worker 2. Plus a single file. Returns every message newest first.
 */
function fixture(d: string): string[] {
  const all: Array<{ time: string; msg: string; file: string }> = []
  const add = (file: string, day: string, seconds: number[]) => {
    const records = seconds.map((s) => ({ time: at(day, s), msg: `${file}@${s}` }))
    write(d, file, records)
    for (const r of records) all.push({ ...r, file })
  }
  add('strutvane-2026-11-14.log', '2026-11-14', [0, 3, 6, 9])
  add('strutvane-2026-11-14-2.log', '2026-11-14', [12, 15, 18])
  add('strutvane-2026-11-14.worker-2.log', '2026-11-14', [1, 4, 7, 10, 13, 16])
  add('strutvane-2026-11-14.worker-10.log', '2026-11-14', [2, 5, 8, 11, 14, 17, 19])
  add('strutvane-2026-11-15.log', '2026-11-15', [1, 2, 5])
  add('strutvane-2026-11-15.worker-2.log', '2026-11-15', [0, 3, 4, 6])
  // Single files span days and are read after the daily files.
  add('strutvane.log', '2026-11-10', [0, 2])
  add('strutvane.worker-2.log', '2026-11-10', [1])
  const daily = all.filter((r) => r.file !== 'strutvane.log' && r.file !== 'strutvane.worker-2.log')
  const single = all.filter(
    (r) => r.file === 'strutvane.log' || r.file === 'strutvane.worker-2.log',
  )
  const desc = (a: { time: string }, b: { time: string }) => (a.time < b.time ? 1 : -1)
  return [...daily.sort(desc), ...single.sort(desc)].map((r) => r.msg)
}

async function readAll(d: string, limit: number, maxScanLines: number): Promise<string[]> {
  const seen: string[] = []
  let cursor: Cursor | undefined
  for (let page = 0; page < 1_000; page++) {
    const result = await readPage({ dir: d, query: {}, limit, cursor, maxScanLines })
    seen.push(...result.records.map((r) => String(r.msg)))
    if (!result.nextCursor) return seen
    cursor = decodeCursor(result.nextCursor)
    expect(cursor).toBeDefined()
  }
  throw new Error('paging did not finish')
}

describe('record pages merge processes by time', () => {
  test('one page holds every process, newest first, interleaved by timestamp', async () => {
    const d = dir()
    const expected = fixture(d)
    const page = await readPage({ dir: d, query: {}, limit: 1_000 })
    expect(page.records.map((r) => r.msg)).toEqual(expected)
    expect(page.nextCursor).toBeUndefined()
  })

  test('property: any limit and scan budget visit every record exactly once, in order', async () => {
    const d = dir()
    const expected = fixture(d)
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 15 }),
        async (limit, scan) => {
          expect(await readAll(d, limit, scan)).toEqual(expected)
        },
      ),
      { numRuns: 60 },
    )
  })

  test('records appended after a page was read are not mixed into the next page', async () => {
    const d = dir()
    const expected = fixture(d)
    const first = await readPage({ dir: d, query: {}, limit: 5 })
    // A new worker file and new lines appear after the first page.
    write(d, 'strutvane-2026-11-15.worker-7.log', [{ time: at('2026-11-15', 30), msg: 'late' }])
    writeFileSync(
      join(d, 'strutvane-2026-11-15.log'),
      formatLine({ time: at('2026-11-15', 40), level: 'info', msg: 'appended' }, 'local', 32_768),
      { flag: 'a' },
    )
    const rest = await readAll2(d, first.nextCursor)
    expect([...first.records.map((r) => r.msg), ...rest]).toEqual(expected)
  })

  test('a cursor for a group that is gone continues with the older groups', async () => {
    const d = dir()
    const expected = fixture(d)
    const cursor = { group: '2026-11-16', positions: [['strutvane-2026-11-16.log', 10]] as const }
    const page = await readPage({ dir: d, query: {}, limit: 1_000, cursor })
    expect(page.records.map((r) => r.msg)).toEqual(expected)
  })
})

async function readAll2(d: string, next: string | undefined): Promise<string[]> {
  const seen: string[] = []
  let cursor = next === undefined ? undefined : decodeCursor(next)
  while (cursor) {
    const page = await readPage({ dir: d, query: {}, limit: 4, cursor })
    seen.push(...page.records.map((r) => String(r.msg)))
    cursor = page.nextCursor === undefined ? undefined : decodeCursor(page.nextCursor)
  }
  return seen
}

describe('cursors are validated', () => {
  test('round trip', () => {
    const cursor: Cursor = {
      group: '2026-11-14',
      positions: [
        ['strutvane-2026-11-14-2.log', 3],
        ['strutvane-2026-11-14.worker-2.log', 0],
      ],
    }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
    expect(
      decodeCursor(encodeCursor({ group: 'single', positions: [['strutvane.log', 9]] })),
    ).toEqual({
      group: 'single',
      positions: [['strutvane.log', 9]],
    })
  })

  test.each([
    ['traversal', [1, '2026-11-14', [['../../etc/passwd', 1]]]],
    ['negative offset', [1, '2026-11-14', [['strutvane-2026-11-14.log', -1]]]],
    ['fractional offset', [1, '2026-11-14', [['strutvane-2026-11-14.log', 1.5]]]],
    ['file of another group', [1, '2026-11-14', [['strutvane-2026-11-13.log', 1]]]],
    ['daily file in the single group', [1, 'single', [['strutvane-2026-11-13.log', 1]]]],
    [
      'two positions for one stream',
      [
        1,
        '2026-11-14',
        [
          ['strutvane-2026-11-14.log', 1],
          ['strutvane-2026-11-14-2.log', 1],
        ],
      ],
    ],
    ['bad group', [1, '../x', []]],
    ['wrong version', [2, '2026-11-14', []]],
    ['old shape', ['strutvane-2026-11-14.log', 3]],
    ['not an array', { group: '2026-11-14' }],
  ])('%s is rejected', (_name, value) => {
    expect(decodeCursor(Buffer.from(JSON.stringify(value)).toString('base64url'))).toBeUndefined()
  })

  test('oversized and non-base64url values are rejected', () => {
    expect(decodeCursor('x'.repeat(20_000))).toBeUndefined()
    expect(decodeCursor('!!')).toBeUndefined()
    expect(decodeCursor(Buffer.from('not json').toString('base64url'))).toBeUndefined()
    const many = Array.from({ length: 600 }, (_, i) => [`strutvane-2026-11-14.worker-${i}.log`, 1])
    expect(
      decodeCursor(Buffer.from(JSON.stringify([1, '2026-11-14', many])).toString('base64url')),
    ).toBeUndefined()
  })
})
