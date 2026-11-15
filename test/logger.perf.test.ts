/**
 * Performance budgets for the pipeline. Outside the quality gate (timings depend on machine load):
 * run with `vitest run --config vitest.perf.config.ts` on a quiet machine. PERF_BUDGET_FACTOR
 * scales the budgets (e.g. 2 on a slow CI runner).
 */
import { expect, test } from 'vitest'
import { createPipelineLogger } from '../src/logger.ts'
import { createLogManager } from '../src/manager.ts'
import { memoryTransport } from './helpers.ts'

const factor = Number(process.env['PERF_BUDGET_FACTOR'] ?? '1') || 1

test('a log call does not block: 5,000 calls well under a second', () => {
  const log = createPipelineLogger({ transport: memoryTransport({ delayMs: 5 }) })
  const started = performance.now()
  for (let i = 0; i < 5_000; i++) log.info('fast', { i })
  expect(performance.now() - started).toBeLessThan(1_000 * factor)
})

test('throughput: 50k records/s or more through the pipeline', async () => {
  const t = memoryTransport()
  const log = createPipelineLogger({
    transport: t,
    queue: { maxRecords: 200_000, maxBytes: 256 * 1024 * 1024 },
  })
  const n = 50_000
  const started = performance.now()
  for (let i = 0; i < n; i++)
    log.info('request handled', { method: 'GET', route: '/api/v1/invoices', status: 200, i })
  await log.drain(30_000)
  const perSecond = n / ((performance.now() - started) / 1000)
  expect(log.stats().written).toBe(n)
  expect(perSecond).toBeGreaterThan(50_000 / factor)
})

test('throughput: 50k records/s or more through a channel in the line format', async () => {
  const t = memoryTransport()
  const log = createLogManager({
    config: {
      default: 'mem',
      channels: { mem: { driver: 'custom', via: () => t, format: 'line' } },
    },
    env: {},
    workerId: false,
    queue: { maxRecords: 200_000, maxBytes: 256 * 1024 * 1024 },
  })
  const n = 50_000
  const started = performance.now()
  for (let i = 0; i < n; i++)
    log.info('request handled', { method: 'GET', route: '/api/v1/invoices', status: 200, i })
  await log.drain(30_000)
  const perSecond = n / ((performance.now() - started) / 1000)
  expect(log.stats().written).toBe(n)
  expect(perSecond).toBeGreaterThan(50_000 / factor)
})

test('a stack of two file-like channels costs one redaction per record', async () => {
  const a = memoryTransport()
  const b = memoryTransport()
  const log = createLogManager({
    config: {
      default: 'both',
      channels: {
        a: { driver: 'custom', via: () => a, format: 'line' },
        b: { driver: 'custom', via: () => b, format: 'line' },
        both: { driver: 'stack', channels: ['a', 'b'] },
      },
    },
    env: {},
    workerId: false,
    queue: { maxRecords: 200_000, maxBytes: 256 * 1024 * 1024 },
  })
  const n = 50_000
  const started = performance.now()
  for (let i = 0; i < n; i++) log.info('fan out', { i })
  await log.drain(30_000)
  const perSecond = n / ((performance.now() - started) / 1000)
  expect(log.stats().written).toBe(2 * n)
  expect(perSecond).toBeGreaterThan(40_000 / factor)
})

test('redaction stays linear: hostile 8 KB strings cost milliseconds, not a blocked event loop', async () => {
  const { redactString } = await import('../src/redact.ts')
  const hostile = [
    'abcdefgh'.repeat(1024), // scheme-like letters with no "://" (was quadratic)
    'a://'.repeat(2048),
    'a://:'.repeat(1638),
    `x://u:${'p'.repeat(8180)}`,
    `?${'a_'.repeat(4090)}`,
    'Bearer '.repeat(1170),
    '4111 '.repeat(1638),
    `eyJ${'a.'.repeat(4090)}`,
    'password:'.repeat(910), // the key=value rule
    `password="${'a'.repeat(8180)}`,
    'x_'.repeat(4096),
  ]
  for (const text of hostile) {
    const started = performance.now()
    for (let i = 0; i < 5; i++) redactString(text)
    expect((performance.now() - started) / 5, text.slice(0, 12)).toBeLessThan(10 * factor)
  }
})
