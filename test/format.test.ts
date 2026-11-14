/**
 * The two formats (ADR-0022 §5): the `line` layout, the one-line guarantee under hostile input
 * (newlines, ANSI, C1 controls, U+2028/9, huge values), the size cap, and both formats
 * round-tripping through the parser the viewer, its tail and `log:tail` use.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { createFormatter, isLogFormat } from '../src/format/formatter.ts'
import { envLabel, escapeMessage, formatLine, unescapeMessage } from '../src/format/line.ts'
import { parseLogLine } from '../src/format/parse.ts'
import { createSanitizer } from '../src/redact.ts'
import { escapeLineSeparators, serializeRecord } from '../src/serialize.ts'
import { cleanLine, parseLine } from '../src/viewer/store.ts'

const ch = String.fromCharCode
const NL = ch(10)
const CR = ch(13)
const ESC = ch(0x1b)
const CSI8 = ch(0x9b)
const LS = ch(0x2028)
const PS = ch(0x2029)
const T = '2026-11-15T10:22:01.123Z'
const sanitize = createSanitizer()

/** Characters that must never appear raw in a written line. */
function unsafe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

describe('line format', () => {
  test('the Laravel-like layout, with the context as JSON at the end', () => {
    expect(
      formatLine(
        {
          time: T,
          level: 'error',
          msg: 'Payment failed',
          requestId: 'r-1',
          fields: { invoice: 42 },
        },
        'local',
        32_768,
      ),
    ).toBe(
      '[2026-11-15 10:22:01.123] local.ERROR: Payment failed {"invoice":42,"requestId":"r-1"}\n',
    )
    expect(formatLine({ time: T, level: 'warning', msg: 'x' }, 'production', 1024)).toBe(
      '[2026-11-15 10:22:01.123] production.WARNING: x {}\n',
    )
    // Aliases and unknown levels never break the header.
    expect(formatLine({ time: T, level: 'warn', msg: 'x' }, 'p', 1024)).toContain('p.WARNING:')
    expect(formatLine({ time: T, level: 'loud', msg: 'x' }, 'p', 1024)).toContain('p.INFO:')
    // A missing or odd time still gives a parseable header.
    expect(formatLine({ level: 'info', msg: 'x' }, 'p', 1024)).toMatch(
      /^\[1970-01-01 00:00:00\.000\]/,
    )
    expect(formatLine({ time: '2026-11-15T10:22:01Z', msg: 'x' }, 'p', 1024)).toMatch(
      /^\[2026-11-15 10:22:01\.000\] p\.INFO: x \{\}/,
    )
    expect(formatLine({ time: T, level: 'info', msg: 5 }, 'p', 1024)).toContain(': 5 {}')
  })

  test('reserved names among the fields are kept under fields.<name>', () => {
    const line = formatLine(
      { time: T, level: 'info', msg: 'm', requestId: 'real', fields: { requestId: 'fake', a: 1 } },
      'p',
      4096,
    )
    expect(line).toContain('{"fields.requestId":"fake","a":1,"requestId":"real"}')
    expect(parseLogLine(line.trimEnd())).toMatchObject({
      requestId: 'real',
      fields: { requestId: 'fake', a: 1 },
    })
  })

  test('message escaping makes the context split exact', () => {
    const hostile = `a {"requestId":"forged"} ${NL}[2026-01-01 00:00:00.000] p.EMERGENCY: forged {} \\{ \\`
    const escaped = escapeMessage(hostile)
    expect(escaped).not.toContain(' {')
    expect(escaped).not.toContain(NL)
    expect(unescapeMessage(escaped)).toBe(hostile)
    const parsed = parseLogLine(
      formatLine({ time: T, level: 'info', msg: hostile }, 'p', 4096).trimEnd(),
    )
    expect(parsed?.msg).toBe(hostile)
    expect(parsed?.requestId).toBeUndefined()
    expect(unescapeMessage('no escapes')).toBe('no escapes')
    expect(unescapeMessage('\\q stays')).toBe('\\q stays')
  })

  test('newlines, ANSI, C1 controls and line separators are escaped: exactly one line', () => {
    const msg = `ok${NL}${CR}${ESC}[31mred${CSI8}2J${LS}${PS}${ch(0)}${ch(0x7f)}\ttab`
    const line = formatLine(
      { time: T, level: 'info', msg, fields: { v: msg, [`k${NL}`]: 1 } },
      'p',
      32_768,
    )
    expect(line.endsWith(NL)).toBe(true)
    expect(unsafe(line.slice(0, -1))).toBe(false)
    expect(line).toContain('\\u001b[31mred\\u009b2J\\u2028\\u2029\\u0000\\u007f\\ttab')
    const parsed = parseLogLine(line.slice(0, -1))
    expect(parsed?.msg).toBe(msg)
    expect(parsed?.fields).toEqual({ v: msg, [`k${NL}`]: 1 })
  })

  test('one line for any message and field (property, incl. full Unicode)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' }), (msg, value) => {
        const line = formatLine({ time: T, level: 'notice', msg, fields: { value } }, 'p', 1 << 20)
        const body = line.slice(0, -1)
        if (!line.endsWith(NL) || unsafe(body)) return false
        const parsed = parseLogLine(body)
        // Lone surrogates can't survive UTF-8 anyway; everything else round-trips exactly.
        return parsed?.msg === msg && (parsed.fields as { value: string }).value === value
      }),
      { numRuns: 500 },
    )
  })

  test('huge values: the size cap gives a short, well-formed marker line', () => {
    const line = formatLine(
      { time: T, level: 'error', msg: 'm'.repeat(5_000), fields: { big: 'x'.repeat(100_000) } },
      'p',
      32_768,
    )
    expect(Buffer.byteLength(line)).toBeLessThan(8_000)
    const parsed = parseLogLine(line.trimEnd())
    expect(parsed?.msg).toBe('m'.repeat(1024))
    expect(parsed?.fields).toEqual({ truncated: true, originalBytes: expect.any(Number) })
    // Multibyte text near the limit is measured in bytes, not characters.
    const euro = formatLine({ time: T, level: 'info', msg: '€'.repeat(400) }, 'p', 1024)
    expect(parseLogLine(euro.trimEnd())?.fields).toMatchObject({ truncated: true })
  })

  test('a context that cannot be serialised is reported, not thrown', () => {
    const line = formatLine({ time: T, level: 'info', msg: 'm', fields: { n: 1n } }, 'p', 4096)
    expect(parseLogLine(line.trimEnd())?.fields).toEqual({ serializationError: expect.any(String) })
  })

  test('envLabel keeps the header parseable', () => {
    expect(envLabel('local')).toBe('local')
    expect(envLabel('staging eu.1')).toBe('staging_eu_1')
    expect(envLabel('')).toBe('production')
    expect(envLabel(undefined)).toBe('production')
    expect(envLabel('x'.repeat(50))).toHaveLength(32)
  })
})

describe('json format', () => {
  test('C1 controls and line separators are escaped too', () => {
    const line = serializeRecord({ msg: `a${CSI8}b${LS}` })
    expect(unsafe(line.slice(0, -1))).toBe(false)
    expect(JSON.parse(line).msg).toBe(`a${CSI8}b${LS}`)
    expect(escapeLineSeparators('{"a":1}')).toBe('{"a":1}')
  })
})

describe('parser: both formats, mixed', () => {
  const record = {
    time: T,
    level: 'critical',
    msg: `Card ${NL}declined {for} order`,
    requestId: 'r-9',
    traceId: 'tr',
    tenantId: 'acme',
    actorId: 'u-1',
    fields: { orderId: 7, nested: { a: [1, 'two'] } },
    err: { name: 'Error', message: 'boom', stack: `Error: boom${NL}    at x` },
  }

  test('line and json round-trip to the same record', () => {
    const json = parseLogLine(createFormatter('json')(record, 32_768).trimEnd())
    const line = parseLogLine(createFormatter('line', { env: 'local' })(record, 32_768).trimEnd())
    expect(json).toEqual(record)
    const { env, ...withoutEnv } = line ?? {}
    expect(env).toBe('local')
    expect(withoutEnv).toEqual(record)
  })

  test('the viewer parser reads both, and re-sanitises', () => {
    const secret = { ...record, fields: { password: 'hunter2' } }
    for (const format of ['line', 'json'] as const) {
      const text = createFormatter(format)(secret, 32_768).trimEnd()
      expect(parseLine(text)?.msg).toBe(record.msg)
      const clean = cleanLine(text, sanitize)
      expect(clean?.json).not.toContain('hunter2')
    }
  })

  test('v1 JSON levels read as canonical levels; foreign lines are not records', () => {
    expect(parseLogLine('{"level":"warn","msg":"x"}')?.level).toBe('warning')
    expect(parseLogLine('{"level":"fatal"}')?.level).toBe('critical')
    expect(parseLogLine('{"level":"custom"}')?.level).toBe('custom')
    expect(parseLogLine('{"level":"info"}')).toEqual({ level: 'info' })
    for (const foreign of [
      '',
      'plain text',
      '[not a header]',
      '[2026-11-15 10:22:01.123] local.ERROR no colon',
      '{"broken":',
      '[1,2]',
      'null',
    ])
      expect(parseLogLine(foreign)).toBeUndefined()
  })

  test('a hand-written line without a context keeps the whole rest as the message', () => {
    expect(parseLogLine('[2026-11-15 10:22:01.123] local.Notice: hello {not json')).toEqual({
      time: T,
      level: 'notice',
      msg: 'hello {not json',
      env: 'local',
    })
    expect(parseLogLine('[2026-11-15 10:22:01.123] local.DEBUG: only text')?.msg).toBe('only text')
    expect(parseLogLine('[2026-11-15 10:22:01.123] local.VERBOSE: x {}')?.level).toBe('verbose')
    expect(parseLogLine('[2026-11-15 10:22:01.123] l.INFO: x [1]')?.msg).toBe('x [1]')
  })

  test('parsing is linear: a line full of " {" is cheap', () => {
    const hostile = `[2026-11-15 10:22:01.123] l.INFO: ${' {'.repeat(20_000)}`
    const started = performance.now()
    expect(parseLogLine(hostile)?.msg).toBe(' {'.repeat(20_000).slice(0))
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('formats', () => {
    expect(isLogFormat('line')).toBe(true)
    expect(isLogFormat('pretty')).toBe(false)
  })
})
