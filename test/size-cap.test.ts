/**
 * The size cap, the class (audit 2026-11-15): a record over `maxBytes` becomes a truncation
 * marker, and the marker itself must also fit the cap and stay one valid line. Before the fix the
 * marker kept up to 1,024 characters of the message, escaped after the cut, so control characters
 * (6 bytes each as `\u0001`) or multi-byte text pushed the marker line far past the cap, and the
 * cut could split a surrogate pair.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { formatLine } from '../src/format/line.ts'
import { parseLogLine } from '../src/format/parse.ts'
import { createPipelineLogger } from '../src/logger.ts'
import { cutText, MIN_RECORD_BYTES, serializeRecord } from '../src/serialize.ts'
import { memoryTransport } from './helpers.ts'

const T = '2026-11-15T10:22:01.123Z'
const LS = String.fromCharCode(0x2028)
const BACKSLASH = String.fromCharCode(0x5c)
const EMOJI = String.fromCodePoint(0x1f600)
const hostileMessages = [
  String.fromCharCode(1).repeat(5_000),
  '\n'.repeat(5_000),
  LS.repeat(5_000),
  EMOJI.repeat(5_000),
  `${'a'.repeat(1_023)}${EMOJI}${'b'.repeat(40_000)}`,
  '€ {'.repeat(5_000),
  BACKSLASH.repeat(5_000),
]

const formatters = {
  line: (record: Record<string, unknown>, max: number) => formatLine(record, 'production', max),
  json: (record: Record<string, unknown>, max: number) => serializeRecord(record, max),
}

/** True when the text holds a lone surrogate (it would not survive UTF-8). */
const hasLoneSurrogate = (text: string): boolean => Buffer.from(text, 'utf8').toString() !== text

describe.each(Object.entries(formatters))('the %s size cap', (_name, format) => {
  test.each(hostileMessages.map((m, i) => [i, m] as const))(
    'hostile message #%i: the marker fits the cap, is one line, and parses',
    (_i, msg) => {
      for (const max of [MIN_RECORD_BYTES, 2_048, 32 * 1024]) {
        const line = format(
          { time: T, level: 'error', msg, fields: { pad: 'x'.repeat(40_000) } },
          max,
        )
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(max)
        expect(line.endsWith('\n')).toBe(true)
        expect(line.indexOf('\n')).toBe(line.length - 1)
        expect(line.includes('\r') || line.includes(LS)).toBe(false)
        expect(hasLoneSurrogate(line)).toBe(false)
        const parsed = parseLogLine(line.slice(0, -1))
        expect(parsed).toBeDefined()
        expect(JSON.stringify(parsed)).toContain('"truncated":true')
      }
    },
  )

  test('property: every record becomes exactly one line within the cap', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 3_000 }),
        fc.string({ unit: 'binary', maxLength: 3_000 }),
        fc.integer({ min: MIN_RECORD_BYTES, max: 8_192 }),
        (msg, value, max) => {
          const line = format({ time: T, level: 'info', msg, fields: { value } }, max)
          expect(Buffer.byteLength(line)).toBeLessThanOrEqual(max)
          expect(line.indexOf('\n')).toBe(line.length - 1)
          expect(parseLogLine(line.slice(0, -1))).toBeDefined()
        },
      ),
      { numRuns: 300 },
    )
  })
})

test('cutText never splits a surrogate pair', () => {
  expect(cutText(`a${EMOJI}`, 2)).toBe('a')
  expect(cutText(`a${EMOJI}`, 3)).toBe(`a${EMOJI}`)
  expect(cutText('abc', 2)).toBe('ab')
})

test(`a cap below ${MIN_RECORD_BYTES} bytes is refused: no marker could fit it`, () => {
  expect(() =>
    createPipelineLogger({ transport: memoryTransport(), maxRecordBytes: MIN_RECORD_BYTES - 1 }),
  ).toThrow(RangeError)
  expect(() =>
    createPipelineLogger({ transport: memoryTransport(), maxRecordBytes: MIN_RECORD_BYTES }),
  ).not.toThrow()
})
