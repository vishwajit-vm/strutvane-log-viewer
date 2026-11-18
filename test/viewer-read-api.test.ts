/**
 * The read API on top of the framework's files (ADR-0022 §6): downloads merge every writer process
 * by timestamp across rotation parts, both formats are read, forward reads stay bounded however
 * large a file or line is, the channel filter can't be used for traversal, every error carries a
 * stable problem code, and the gate sees the actor (VAPT-style tests on real temp files).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Actor } from '@strutvane/framework/contracts'
import { formatLine, serializeRecord } from '@strutvane/framework/log'
import { afterEach, describe, expect, test } from 'vitest'
import { createViewerHandler, type ViewerOptions } from '../src/viewer/handler.ts'
import { MAX_LINE_BYTES, readDayLines, readLinesForward } from '../src/viewer/store.ts'
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

const BASE = 'http://localhost:3000/_strutvane/logs'
const at = (second: number): string =>
  new Date(Date.parse('2026-11-15T10:00:00.000Z') + second * 1000).toISOString()

/** One record in the `line` format (even seconds) or `json` (odd seconds). */
function record(second: number, msg: string, extra: Record<string, unknown> = {}): string {
  const r = { time: at(second), level: 'info', msg, ...extra }
  return second % 2 === 0 ? formatLine(r, 'local', 32_768) : serializeRecord(r)
}

/**
 * Main process (two rotation parts), worker 2 and worker 10, interleaved by time, both formats,
 * plus a `payments` channel file. Returns the main channel's messages, oldest first.
 */
function fixture(d: string): string[] {
  const files: Record<string, number[]> = {
    'strutvane-2026-11-15.log': [0, 4, 8],
    'strutvane-2026-11-15-2.log': [12, 16],
    'strutvane-2026-11-15.worker-2.log': [1, 5, 9, 13],
    'strutvane-2026-11-15.worker-10.log': [2, 3, 6, 7, 10, 11, 14, 15],
  }
  const all: Array<{ second: number; msg: string }> = []
  for (const [file, seconds] of Object.entries(files)) {
    writeFileSync(join(d, file), seconds.map((s) => record(s, `${file}@${s}`)).join(''))
    for (const s of seconds) all.push({ second: s, msg: `${file}@${s}` })
  }
  writeFileSync(join(d, 'payments-2026-11-15.log'), record(3, 'paid', { amount: 42 }))
  writeFileSync(join(d, 'strutvane-2026-11-14.log'), record(0, 'yesterday'))
  return all.sort((a, b) => a.second - b.second).map((r) => r.msg)
}

function viewer(d: string, options: ViewerOptions = {}) {
  return createViewerHandler({
    dir: d,
    bases: ['strutvane', 'payments'],
    channels: { daily: 'strutvane', payments: 'payments' },
    env: { APP_ENV: 'local' },
    ...options,
  })
}

describe('downloads merge every process by time', () => {
  test('NDJSON: workers, parts and both formats interleave oldest first', async () => {
    const d = dir()
    const expected = fixture(d)
    const res = await viewer(d).fetch(
      new Request(`${BASE}/api/download?day=2026-11-15&channel=daily`),
    )
    expect(res.status).toBe(200)
    const msgs = (await res.text())
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { msg: string }).msg)
    expect(msgs).toEqual(expected)
  })

  test('without a channel, every channel of the day is merged in', async () => {
    const d = dir()
    fixture(d)
    const res = await viewer(d).fetch(new Request(`${BASE}/api/download?day=2026-11-15`))
    const msgs = (await res.text()).trim().split('\n')
    expect(msgs).toHaveLength(18)
    // `paid` (second 3) sits between the two second-3 neighbours, by time.
    const index = msgs.findIndex((l) => l.includes('"paid"'))
    expect(JSON.parse(msgs[index - 1] ?? '{}')).toMatchObject({ time: at(2) })
  })

  test('CSV download is merged by time too, formula-safe', async () => {
    const d = dir()
    writeFileSync(join(d, 'strutvane-2026-11-15.log'), record(2, '=HYPERLINK("http://evil")'))
    writeFileSync(join(d, 'strutvane-2026-11-15.worker-2.log'), record(1, '+cmd'))
    const res = await viewer(d).fetch(new Request(`${BASE}/api/download?day=2026-11-15&format=csv`))
    const rows = (await res.text()).trim().split('\r\n')
    expect(rows[1]).toContain(`'+cmd`)
    expect(rows[2]).toContain(`'=HYPERLINK`)
  })

  test('single files only contribute the lines of the requested day', async () => {
    const d = dir()
    writeFileSync(
      join(d, 'strutvane.log'),
      `${serializeRecord({ time: '2026-11-14T23:59:59.000Z', level: 'info', msg: 'before' })}${serializeRecord({ time: '2026-11-15T00:00:00.000Z', level: 'info', msg: 'on' })}`,
    )
    const lines: string[] = []
    for await (const line of readDayLines(d, '2026-11-15')) lines.push(line)
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['on'])
  })
})

describe('forward reads are bounded', () => {
  test('lines across chunk boundaries, CRLF and blank lines; a torn last line is ignored', async () => {
    const d = dir()
    const long = 'x'.repeat(200_000)
    writeFileSync(join(d, 'f.log'), `a\r\n\nb${long}\nc\ntorn`)
    const lines: string[] = []
    for await (const line of readLinesForward(join(d, 'f.log'))) lines.push(line)
    expect(lines).toEqual(['a', `b${long}`, 'c'])
  })

  test('a line longer than the cap is skipped without being kept, and reading goes on', async () => {
    const d = dir()
    const huge = 'y'.repeat(300_000) // spans several chunks
    writeFileSync(join(d, 'f.log'), `first\n${huge}\nafter\n${'z'.repeat(5_000)}\nlast\n`)
    const lines: string[] = []
    for await (const line of readLinesForward(join(d, 'f.log'), 4_096)) lines.push(line)
    expect(lines).toEqual(['first', 'after', 'last'])
    expect(MAX_LINE_BYTES).toBe(1024 * 1024)
  })

  test('a missing file ends quietly; stopping early closes the file', async () => {
    const d = dir()
    const none: string[] = []
    for await (const line of readLinesForward(join(d, 'missing.log'))) none.push(line)
    expect(none).toEqual([])
    writeFileSync(join(d, 'strutvane-2026-11-15.log'), `${record(1, 'a')}${record(3, 'b')}`)
    for await (const _line of readDayLines(d, '2026-11-15')) break
    // The temp dir cleanup (which fails on an open handle on Windows) proves the file was closed.
  })

  test('a huge day downloads in bounded chunks and can be cancelled mid-way', async () => {
    const d = dir()
    const one = record(1, 'm'.repeat(900))
    writeFileSync(join(d, 'strutvane-2026-11-15.log'), one.repeat(20_000)) // ~19 MB
    const res = await viewer(d).fetch(new Request(`${BASE}/api/download?day=2026-11-15`))
    const reader = res.body?.getReader()
    const first = await reader?.read()
    expect(first?.value?.byteLength ?? 0).toBeGreaterThan(0)
    expect(first?.value?.byteLength ?? 0).toBeLessThan(200_000)
    await reader?.cancel()
  })
})

describe('the channel filter', () => {
  test('records, files and tails narrow to one channel', async () => {
    const d = dir()
    fixture(d)
    const v = viewer(d)
    const paid = (await (
      await v.fetch(new Request(`${BASE}/api/records?channel=payments`))
    ).json()) as {
      records: Array<{ msg: string }>
    }
    expect(paid.records.map((r) => r.msg)).toEqual(['paid'])
    const files = (await (
      await v.fetch(new Request(`${BASE}/api/files?channel=payments`))
    ).json()) as {
      files: Array<{ name: string }>
      channels: string[]
    }
    expect(files.files.map((f) => f.name)).toEqual(['payments-2026-11-15.log'])
    expect(files.channels).toEqual(['daily', 'payments'])
    const tail = await v.fetch(new Request(`${BASE}/api/tail?channel=payments`))
    expect(tail.status).toBe(200)
    await tail.body?.cancel()
  })

  test('an unknown channel is a 400 problem, including traversal attempts', async () => {
    const d = dir()
    fixture(d)
    const v = viewer(d)
    for (const channel of ['nope', '../../etc/passwd', '..\\secrets', 'strutvane/../x']) {
      for (const route of ['records', 'files', 'download?day=2026-11-15&', 'tail']) {
        const sep = route.endsWith('&') ? '' : '?'
        const res = await v.fetch(
          new Request(`${BASE}/api/${route}${sep}channel=${encodeURIComponent(channel)}`),
        )
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ code: 'invalid_query', status: 400 })
      }
    }
  })

  test('a channel must write one of the viewer bases; without channels each base is one', async () => {
    expect(() =>
      createViewerHandler({ dir: dir(), bases: ['strutvane'], channels: { audit: 'audit' } }),
    ).toThrow(/not one of the viewer bases/)
    const d = dir()
    fixture(d)
    const plain = createViewerHandler({
      dir: d,
      bases: ['strutvane', 'payments'],
      env: { APP_ENV: 'local' },
    })
    const files = (await (await plain.fetch(new Request(`${BASE}/api/files`))).json()) as {
      channels: string[]
    }
    expect(files.channels).toEqual(['strutvane', 'payments'])
  })
})

describe('problem codes (RFC-0003)', () => {
  test('every error answer carries a lowercase snake_case code', async () => {
    const d = dir()
    const token = 'a-long-enough-viewer-token'
    const local = viewer(d)
    const prod = createViewerHandler({ dir: d, env: { APP_ENV: 'production' }, token })
    const cases: Array<[Promise<Response>, number, string]> = [
      [local.fetch(new Request(`${BASE}/api/records?limit=0`)), 400, 'invalid_query'],
      [
        local.fetch(new Request(`${BASE}/api/records`, { method: 'DELETE' })),
        405,
        'method_not_allowed',
      ],
      [
        local.fetch(new Request(`${BASE}/api/clear`, { method: 'POST', body: '{}' })),
        403,
        'forbidden',
      ],
      [
        prod.fetch(
          new Request('https://app.example.test/_strutvane/logs/api/files', {
            headers: { authorization: 'Bearer wrong-but-long-enough' },
          }),
        ),
        401,
        'unauthenticated',
      ],
    ]
    for (const [pending, status, code] of cases) {
      const res = await pending
      expect(res.status).toBe(status)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
      const problem = (await res.json()) as { code: string }
      expect(problem.code).toBe(code)
      expect(problem.code).toMatch(/^[a-z]+(?:_[a-z]+)*$/)
    }
  })

  test('the tail limit is a 429 rate_limited problem', async () => {
    const v = viewer(dir(), { maxTails: 0 })
    const res = await v.fetch(new Request(`${BASE}/api/tail`))
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 'rate_limited' })
  })
})

describe('the gate sees the actor', () => {
  test('authorize receives the actor and the socket address; only a literal true allows', async () => {
    const d = dir()
    const seen: unknown[] = []
    const admin: Actor = { id: 'u1', type: 'user', roles: ['admin'], attrs: {} }
    const v = createViewerHandler({
      dir: d,
      env: { APP_ENV: 'production' },
      authorize: (_request, context) => {
        seen.push(context)
        return context.actor?.roles.includes('admin') === true
      },
    })
    const url = 'https://app.example.test/_strutvane/logs/api/files'
    expect((await v.fetch(new Request(url), { actor: admin, ip: '10.0.0.1' })).status).toBe(200)
    expect((await v.fetch(new Request(url), { actor: null })).status).toBe(404)
    expect((await v.fetch(new Request(url))).status).toBe(404)
    expect(seen[0]).toEqual({ actor: admin, ip: '10.0.0.1' })
    expect(seen[2]).toEqual({ actor: null })
    const truthy = createViewerHandler({
      dir: d,
      env: { APP_ENV: 'production' },
      authorize: () => 'yes' as unknown as boolean,
    })
    expect((await truthy.fetch(new Request(url))).status).toBe(404)
  })
})
