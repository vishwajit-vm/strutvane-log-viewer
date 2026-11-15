/**
 * Midnight and size rollover with several real processes (audit 2026-11-15). Four processes write
 * one directory while their clocks cross UTC midnight, with a small size cap so parts roll over at
 * the same time. Every record must land exactly once, in the file of its own day and process, in
 * order, with no torn line and no file over the cap.
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { compareLogFiles, parseLogFileName } from '../src/files.ts'
import { readLogDir, tempDir } from './helpers.ts'

const child = fileURLToPath(new URL('./fixtures/child-midnight.ts', import.meta.url))
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function run(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] })
    p.once('exit', (code) => resolve(code))
  })
}

test('four processes crossing midnight: every record once, in its own day and process', async () => {
  const t = tempDir()
  cleanups.push(t.cleanup)
  const procs = 4
  const count = 600 // the clock crosses midnight at record 300
  const cap = 16 * 1024
  const codes = await Promise.all(
    Array.from({ length: procs }, (_, id) =>
      run([child, t.dir, String(id), String(count), String(cap)]),
    ),
  )
  expect(codes).toEqual(Array(procs).fill(0))

  const names = readdirSync(t.dir).filter((f) => f.endsWith('.log'))
  for (const f of names) expect(statSync(join(t.dir, f)).size, f).toBeLessThanOrEqual(cap)
  const seen = new Map<number, number[]>()
  for (const { file, records } of readLogDir(t.dir)) {
    // readLogDir throws on any torn or invalid line.
    const name = parseLogFileName(file)
    expect(name).toBeDefined()
    for (const r of records) {
      const { proc, i } = r.fields as { proc: number; i: number }
      expect(r.time?.slice(0, 10), `${file}: record ${i}`).toBe(name?.day)
      expect(name?.worker, file).toBe(proc === 0 ? undefined : String(proc))
      const list = seen.get(proc) ?? []
      list.push(i)
      seen.set(proc, list)
    }
  }
  for (let p = 0; p < procs; p++) {
    // compareLogFiles order (day, then part number) gives each process's records in order.
    expect(seen.get(p)).toEqual([...Array(count).keys()])
  }
  expect(names.some((f) => f.startsWith('strutvane-2026-11-15'))).toBe(true)
  expect(names.some((f) => f.startsWith('strutvane-2026-11-16'))).toBe(true)
  expect([...names].sort(compareLogFiles)).toEqual(readLogDir(t.dir).map((f) => f.file))
})
