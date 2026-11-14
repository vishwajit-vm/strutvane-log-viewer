/**
 * One writer process for the multi-process tests.
 *   node test/fixtures/child-writer.ts <dir> <id> <count> <maxFileBytes> [line|json]
 * Process 0 is the main process (plain file names); every other id writes its own files
 * (`strutvane-YYYY-MM-DD.worker-<id>.log`), as a queue worker or cluster worker does.
 */
import { createLogManager } from '../../src/manager.ts'

const [dir = '.', id = '0', count = '1000', maxFileBytes = '1048576', format = 'json'] =
  process.argv.slice(2)
const log = createLogManager({
  config: {
    default: 'daily',
    channels: {
      daily: {
        driver: 'daily',
        path: dir,
        days: 0,
        maxFileSize: Number(maxFileBytes),
        format: format === 'line' ? 'line' : 'json',
      },
    },
  },
  env: { APP_ENV: 'testing' },
  workerId: id === '0' ? false : id,
  queue: { maxRecords: 100_000, maxBytes: 128 * 1024 * 1024 },
})
const n = Number(count)
for (let i = 0; i < n; i++) {
  log.info('multi-process', { proc: Number(id), i, pad: 'q'.repeat(60 + (i % 200)) })
  if (i % 200 === 199) await new Promise((r) => setImmediate(r))
}
const result = await log.close(30_000)
process.stdout.write(`${JSON.stringify({ id, result, stats: log.stats() })}\n`)
