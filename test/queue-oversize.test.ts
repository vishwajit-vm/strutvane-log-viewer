/**
 * The queue's drop policy for a record that can never fit (audit 2026-11-15): an important record
 * larger than the whole byte budget evicted every queued record first, then was dropped itself,
 * so one oversized record emptied the queue. It is now dropped at once and counted, and nothing
 * else is touched.
 */
import { expect, test } from 'vitest'
import { BoundedQueue, type QueueItem } from '../src/queue.ts'

let seq = 0
const item = (bytes: number, priority: number, level: QueueItem['level']): QueueItem => ({
  seq: seq++,
  line: 'x'.repeat(bytes),
  bytes,
  priority,
  level,
  dayKey: '2026-11-15',
})

test('a record larger than the byte budget is dropped without evicting anything', () => {
  const q = new BoundedQueue({ maxRecords: 100, maxBytes: 1_000 })
  for (let i = 0; i < 5; i++) expect(q.push(item(100, 200, 'info'))).toBe('queued')
  expect(q.push(item(100, 400, 'error'))).toBe('queued')
  expect(q.push(item(5_000, 600, 'emergency'))).toBe('dropped')
  expect(q.size).toBe(6)
  expect(q.byteSize).toBe(600)
  expect(q.takeDropped()).toEqual({ emergency: 1 })
})

test('the normal policy is unchanged: an important record evicts the oldest low record', () => {
  const q = new BoundedQueue({ maxRecords: 3, maxBytes: 10_000 })
  q.push(item(10, 200, 'info'))
  q.push(item(10, 100, 'debug'))
  q.push(item(10, 400, 'error'))
  expect(q.push(item(10, 300, 'warning'))).toBe('evicted-other')
  expect(q.takeDropped()).toEqual({ info: 1 })
})
