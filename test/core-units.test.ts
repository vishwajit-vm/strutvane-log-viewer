/** Unit tests for the small building blocks: levels, context, records, serialisation, queue, files. */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  addToLogContext,
  getLogContext,
  removeFromLogContext,
  runWithLogContext,
} from '../src/context.ts'
import {
  IMPORTANT_PRIORITY,
  isLevel,
  isLevelName,
  LEVEL_ALIASES,
  LEVEL_PRIORITY,
  LEVELS,
  priorityOf,
  RFC5424_CODE,
  toLevel,
} from '../src/levels.ts'
import { BoundedQueue, type QueueItem } from '../src/queue.ts'
import { buildRecord, toMessage } from '../src/record.ts'
import {
  DEFAULT_MAX_RECORD_BYTES,
  escapeLineSeparators,
  LINE_SEPARATOR,
  PARAGRAPH_SEPARATOR,
  serializeRecord,
} from '../src/serialize.ts'

describe('levels', () => {
  test('the eight RFC 5424 levels in order; warning and above are important', () => {
    expect(LEVELS).toEqual([
      'debug',
      'info',
      'notice',
      'warning',
      'error',
      'critical',
      'alert',
      'emergency',
    ])
    for (let i = 1; i < LEVELS.length; i++) {
      const lower = LEVELS[i - 1] ?? 'debug'
      const higher = LEVELS[i] ?? 'debug'
      expect(LEVEL_PRIORITY[lower]).toBeLessThan(LEVEL_PRIORITY[higher])
      expect(RFC5424_CODE[lower]).toBeGreaterThan(RFC5424_CODE[higher])
    }
    expect(RFC5424_CODE.emergency).toBe(0)
    expect(RFC5424_CODE.debug).toBe(7)
    expect(IMPORTANT_PRIORITY).toBe(LEVEL_PRIORITY.warning)
    expect(isLevel('notice')).toBe(true)
    expect(isLevel('warn')).toBe(false)
    expect(isLevel(3)).toBe(false)
  })

  test('aliases resolve to canonical levels (v1 callers keep working)', () => {
    expect(LEVEL_ALIASES).toEqual({ trace: 'debug', warn: 'warning', fatal: 'critical' })
    expect(toLevel('warn')).toBe('warning')
    expect(toLevel('FATAL')).toBe('critical')
    expect(toLevel(' trace ')).toBe('debug')
    expect(toLevel('Emergency')).toBe('emergency')
    expect(toLevel('verbose')).toBeUndefined()
    expect(toLevel('toString')).toBeUndefined()
    expect(toLevel(7)).toBeUndefined()
    expect(isLevelName('fatal')).toBe(true)
    expect(isLevelName('constructor')).toBe(false)
    expect(priorityOf('fatal')).toBe(priorityOf('critical'))
    expect(priorityOf('warn')).toBe(LEVEL_PRIORITY.warning)
    expect(priorityOf('nope' as 'info')).toBe(-1)
  })
})

describe('context', () => {
  test('is visible through async calls and nests', async () => {
    expect(getLogContext()).toBeUndefined()
    await runWithLogContext({ requestId: 'r1', tenantId: 't1' }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      expect(getLogContext()).toEqual({ requestId: 'r1', tenantId: 't1' })
      runWithLogContext({ tenantId: 't2', extra: 1 }, () => {
        expect(getLogContext()).toEqual({ requestId: 'r1', tenantId: 't2', extra: 1 })
      })
    })
  })

  test('withContext values stay in their scope; clearing keeps the request ids', () => {
    expect(addToLogContext({ x: 1 })).toBe(false)
    expect(removeFromLogContext()).toBe(false)
    const input = { requestId: 'r1' }
    runWithLogContext(input, () => {
      expect(addToLogContext({ orderId: 42, step: 'pay' })).toBe(true)
      runWithLogContext({ inner: true }, () => {
        addToLogContext({ innerOnly: 1 })
        expect(getLogContext()).toMatchObject({ orderId: 42, inner: true, innerOnly: 1 })
      })
      expect(getLogContext()).toEqual({ requestId: 'r1', orderId: 42, step: 'pay' })
      removeFromLogContext(['step'])
      expect(getLogContext()).toEqual({ requestId: 'r1', orderId: 42 })
      removeFromLogContext()
      expect(getLogContext()).toEqual({ requestId: 'r1' })
    })
    expect(input).toEqual({ requestId: 'r1' }) // the caller's object is never mutated
  })
})

describe('buildRecord', () => {
  const T = Date.parse('2026-11-14T10:00:00.000Z')

  test('correlation ids go top-level, other context into fields, errors into err', () => {
    const err = new Error('boom')
    const rec = buildRecord(
      'error',
      'failed',
      { service: 'api' },
      { requestId: 'r', traceId: 'tr', tenantId: 't', actorId: 'a', region: 'eu', empty: '' },
      { err, invoiceId: 1 },
      T,
    )
    expect(rec).toEqual({
      time: '2026-11-14T10:00:00.000Z',
      level: 'error',
      msg: 'failed',
      requestId: 'r',
      traceId: 'tr',
      tenantId: 't',
      actorId: 'a',
      fields: { service: 'api', region: 'eu', empty: '', invoiceId: 1 },
      err,
    })
  })

  test('base context has the lowest precedence', () => {
    const rec = buildRecord('info', 'm', { b: 'binding' }, { c: 'ctx' }, { f: 'field' }, T, {
      b: 'base',
      c: 'base',
      f: 'base',
      only: 'base',
    })
    expect(rec.fields).toEqual({ b: 'binding', c: 'ctx', f: 'field', only: 'base' })
  })

  test('`error` is accepted as the error key; no fields means no fields key', () => {
    const e = new Error('x')
    expect(buildRecord('info', 'm', {}, undefined, { error: e }, T).err).toBe(e)
    expect(buildRecord('info', 'm', {}, undefined, undefined, T)).not.toHaveProperty('fields')
  })

  test('hostile fields never throw', () => {
    const getter = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        throw new Error('no')
      },
    })
    expect(buildRecord('info', 'm', {}, undefined, getter, T).fields).toEqual({ x: '[Unreadable]' })
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    expect(buildRecord('info', 'm', {}, undefined, proxy, T).fields).toEqual({
      fieldsError: 'unreadable fields object',
    })
  })

  test('toMessage coerces anything', () => {
    expect(toMessage('a')).toBe('a')
    expect(toMessage(5)).toBe('5')
    expect(
      toMessage({
        toString() {
          throw new Error('x')
        },
      }),
    ).toBe('[unprintable message]')
  })
})

describe('serializeRecord', () => {
  test('always exactly one line, even with newlines and Unicode line separators (log injection)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (msg, field) => {
        const line = serializeRecord({ time: 't', level: 'info', msg, fields: { field } })
        const body = line.slice(0, -1)
        const unsafe = [10, 13, 0x2028, 0x2029].some((c) => body.includes(String.fromCharCode(c)))
        return line.endsWith(String.fromCharCode(10)) && !unsafe && JSON.parse(body).msg === msg
      }),
      { numRuns: 500 },
    )
    const injected = serializeRecord({
      msg: `ok\n{"level":"fatal","msg":"forged"}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`,
    })
    expect(injected.split('\n')).toHaveLength(2)
    expect(escapeLineSeparators(`a${LINE_SEPARATOR}b`)).toBe('a\\u2028b')
  })

  test('oversized records become a truncation marker', () => {
    const line = serializeRecord({
      time: 't',
      level: 'info',
      msg: 'm'.repeat(2000),
      fields: { big: 'x'.repeat(50_000) },
    })
    const rec = JSON.parse(line)
    expect(rec.fields).toEqual({ truncated: true, originalBytes: expect.any(Number) })
    expect(rec.msg).toHaveLength(1024)
    expect(Buffer.byteLength(line)).toBeLessThan(DEFAULT_MAX_RECORD_BYTES)
    const multibyte = serializeRecord({ msg: '€'.repeat(400) }, 1024)
    expect(JSON.parse(multibyte).fields.truncated).toBe(true)
  })

  test('a serialisation failure is reported, not thrown', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    const rec = JSON.parse(serializeRecord({ time: 't', level: 'info', msg: 5, fields: circular }))
    expect(rec.fields.serializationError).toEqual(expect.any(String))
    expect(rec.msg).toBe('[non-string message]')
  })
})

describe('BoundedQueue', () => {
  let seq = 0
  const item = (
    level: 'debug' | 'info' | 'notice' | 'warning' | 'error',
    bytes = 10,
    dayKey = '2026-11-14',
  ): QueueItem => ({
    seq: seq++,
    line: 'x',
    bytes,
    priority: LEVEL_PRIORITY[level],
    level,
    dayKey,
  })

  test('rejects invalid limits', () => {
    expect(() => new BoundedQueue({ maxRecords: 0, maxBytes: 10 })).toThrow(RangeError)
  })

  test('a full queue drops new debug/info/notice records but evicts for warning and up', () => {
    const q = new BoundedQueue({ maxRecords: 2, maxBytes: 1_000 })
    expect(q.push(item('info'))).toBe('queued')
    expect(q.push(item('warning'))).toBe('queued')
    expect(q.push(item('debug'))).toBe('dropped')
    expect(q.push(item('notice'))).toBe('dropped')
    expect(q.push(item('error'))).toBe('evicted-other') // evicts the info
    expect(q.push(item('error'))).toBe('evicted-other') // only important left: evicts the oldest warning
    expect(q.takeDropped()).toEqual({ debug: 1, notice: 1, info: 1, warning: 1 })
    expect(q.takeDropped()).toBeUndefined()
    expect(q.size).toBe(2)
    expect(q.peakRecords).toBe(2)
  })

  test('a record bigger than the whole queue is dropped', () => {
    const q = new BoundedQueue({ maxRecords: 10, maxBytes: 5 })
    expect(q.push(item('error', 6))).toBe('dropped')
  })

  test('takeBatch keeps input order across priorities, respects size, never mixes days', () => {
    const q = new BoundedQueue({ maxRecords: 100, maxBytes: 10_000 })
    const a = item('info', 10)
    const b = item('error', 10)
    const c = item('info', 10)
    const d = item('info', 10, '2026-11-15')
    for (const i of [a, b, c, d]) q.push(i)
    expect(q.byteSize).toBe(40)
    expect(q.takeBatch(20)).toEqual([a, b])
    expect(q.takeBatch(1)).toEqual([c]) // at least one item, even over the limit
    expect(q.takeBatch(1_000)).toEqual([d])
    expect(q.takeBatch(1_000)).toEqual([])
    expect(q.peakBytes).toBe(40)
  })
})
