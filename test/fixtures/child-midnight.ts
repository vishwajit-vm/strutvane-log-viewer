/**
 * One writer process for the midnight test, with a clock that crosses UTC midnight while it writes.
 *   node test/fixtures/child-midnight.ts <dir> <id> <count> <maxFileBytes>
 * The clock starts 300 ms before midnight and advances 1 ms per record, so every process writes
 * both days, at its own pace, while the others do the same.
 */
import { createLogManager } from '../../src/manager.ts'

const [dir = '.', id = '0', count = '1000', maxFileBytes = '1048576'] = process.argv.slice(2)
const start = Date.parse('2026-11-15T23:59:59.700Z')
let tick = 0
const log = createLogManager({
  config: {
    default: 'daily',
    channels: {
      daily: {
        driver: 'daily',
        path: dir,
        days: 0,
        maxFileSize: Number(maxFileBytes),
        format: 'line',
      },
    },
  },
  env: { APP_ENV: 'testing' },
  workerId: id === '0' ? false : id,
  queue: { maxRecords: 100_000, maxBytes: 128 * 1024 * 1024 },
  now: () => start + tick,
})
const n = Number(count)
for (let i = 0; i < n; i++) {
  tick = i
  log.info('midnight', { proc: Number(id), i, pad: 'm'.repeat(40 + (i % 120)) })
  if (i % 50 === 49) await new Promise((r) => setTimeout(r, 1))
}
const result = await log.close(30_000)
process.stdout.write(`${JSON.stringify({ id, result })}\n`)
