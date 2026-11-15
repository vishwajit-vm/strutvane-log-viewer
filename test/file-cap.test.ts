/**
 * The file size cap holds for every batch size (audit 2026-11-15). A batch was never split, so a
 * batch larger than the room left (up to `maxBatchBytes`, 256 KB by default) was written whole,
 * and with `LOG_MAX_FILE_SIZE=16kb` files grew to several times the cap. A batch now fills the
 * current part and continues in the next one, cut only between lines.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { compareLogFiles } from '../src/files.ts'
import { fileTransport } from '../src/transports/file.ts'
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

const batch = (lines: string[]) => {
  const text = lines.map((l) => `${l}\n`).join('')
  return { text, bytes: Buffer.byteLength(text), records: lines.length, dayKey: '2026-11-15' }
}

function contents(d: string): { files: string[]; lines: string[] } {
  const files = readdirSync(d).sort(compareLogFiles)
  const lines = files.flatMap((f) =>
    readFileSync(join(d, f), 'utf8')
      .split('\n')
      .filter((l) => l !== ''),
  )
  return { files, lines }
}

describe('the size cap holds for any batch', () => {
  test('a batch larger than the cap spans parts, cut between lines', async () => {
    const d = dir()
    const cap = 1_024
    const t = fileTransport({ dir: d, maxFileBytes: cap, days: 0 })
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'€'.repeat(i % 7)}`)
    await t.write(batch(lines.slice(0, 5)))
    await t.write(batch(lines.slice(5))) // ~3 KB in one batch
    await t.close()
    const { files, lines: written } = contents(d)
    expect(files.length).toBeGreaterThan(3)
    for (const f of files) expect(statSync(join(d, f)).size, f).toBeLessThanOrEqual(cap)
    expect(written).toEqual(lines) // nothing lost, duplicated, reordered or torn
  })

  test('a single line larger than the cap gets a part of its own', async () => {
    const d = dir()
    const t = fileTransport({ dir: d, maxFileBytes: 1_024, days: 0 })
    const big = 'x'.repeat(3_000)
    await t.write(batch(['a', big, 'b']))
    await t.close()
    const { files, lines } = contents(d)
    expect(lines).toEqual(['a', big, 'b'])
    const sizes = files.map((f) => statSync(join(d, f)).size)
    expect(sizes).toEqual([2, 3_001, 2])
  })

  test('a resumed part with little room left is filled, not overrun', async () => {
    const d = dir()
    const first = fileTransport({ dir: d, maxFileBytes: 1_024, days: 0 })
    await first.write(batch(['y'.repeat(900)]))
    await first.close()
    const second = fileTransport({ dir: d, maxFileBytes: 1_024, days: 0 })
    await second.write(batch(Array.from({ length: 20 }, (_, i) => `after restart ${i}`)))
    await second.close()
    for (const f of readdirSync(d)) expect(statSync(join(d, f)).size, f).toBeLessThanOrEqual(1_024)
    expect(contents(d).lines).toHaveLength(21)
  })
})
