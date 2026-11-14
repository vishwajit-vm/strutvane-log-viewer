/**
 * The slack channel (ADR-0022 §2): critical and above by default, at most one message per window
 * with a coalesced count, SSRF refusal (scheme, credentials, private/loopback/metadata addresses,
 * DNS answers that point inside), and failure isolation (never blocks or crashes the app).
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { createLogManager } from '../src/manager.ts'
import { isBlockedAddress, safePost, UnsafeUrlError, vetUrl } from '../src/net/safe-http.ts'
import { slackEscape, slackTransport } from '../src/transports/slack.ts'
import { captureStream, memoryTransport, sleep, waitFor } from './helpers.ts'

const URL_OK = 'https://hooks.slack.com/services/T000/B000/XXXX'
const T0 = Date.parse('2026-11-15T10:00:00.000Z')

interface Sent {
  url: string
  body: { username: string; icon_emoji: string; text: string }
}

function recorder(fail?: () => boolean) {
  const sent: Sent[] = []
  const post = async (url: string, body: string): Promise<void> => {
    if (fail?.()) throw new Error('webhook answered HTTP 500')
    sent.push({ url, body: JSON.parse(body) as Sent['body'] })
  }
  return { sent, post }
}

const batch = (records: Array<Record<string, unknown>>) => {
  const text = records.map((r) => `${JSON.stringify(r)}\n`).join('')
  return { text, bytes: text.length, records: records.length, dayKey: '2026-11-15' }
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})

describe('slack transport', () => {
  test('one message per window; records in between are counted and coalesced', async () => {
    let now = T0
    const { sent, post } = recorder()
    const t = slackTransport({
      url: URL_OK,
      channel: 'slack',
      env: 'production',
      post,
      now: () => now,
    })
    await t.write(
      batch([{ time: 'a', level: 'critical', msg: 'Ledger <!channel> & co', fields: { id: 1 } }]),
    )
    for (let i = 0; i < 25; i++) {
      now += 100
      await t.write(batch([{ time: `t${i}`, level: 'critical', msg: `again ${i}` }]))
    }
    expect(sent).toHaveLength(1) // 2.5 s later: still inside the 10 s window
    expect(sent[0]?.body.text).toBe(
      '*CRITICAL* on `production` (slack): Ledger &lt;!channel&gt; &amp; co\n```{"fields":{"id":1}}```',
    )
    expect(sent[0]?.body).toMatchObject({ username: 'Strutvane Log', icon_emoji: ':boom:' })
    now += 10_000
    await t.write(batch([{ time: 'late', level: 'alert', msg: 'next window' }, { msg: 'x' }]))
    expect(sent).toHaveLength(2)
    expect(sent[1]?.body.text).toBe(
      '*ALERT* on `production` (slack): next window\n_+26 more since t0_',
    )
    await t.close()
  })

  test('a quiet window still reports its count, on a timer', async () => {
    const { sent, post } = recorder()
    const t = slackTransport({ url: URL_OK, post, minIntervalMs: 40 })
    await t.write(batch([{ level: 'critical', msg: 'first' }]))
    await t.write(
      batch([
        { level: 'critical', msg: 'second', time: 'T' },
        { level: 'critical', msg: 'third' },
      ]),
    )
    await waitFor(() => sent.length === 2, 2_000)
    expect(sent[1]?.body.text).toBe('*CRITICAL* on `production`: 2 more records')
    // close() sends a pending count right away.
    await t.write(batch([{ level: 'critical', msg: 'fourth' }]))
    await t.close()
    expect(sent[2]?.body.text).toContain('1 more record')
    expect(sent.length).toBe(3)
  })

  test('failures: no URL throws (sink falls back); a failed summary is reported once', async () => {
    const noUrl = slackTransport({ url: undefined })
    await expect(noUrl.write(batch([{ msg: 'x' }]))).rejects.toThrow(/LOG_SLACK_WEBHOOK_URL/)
    await expect(noUrl.write(batch([]))).resolves.toBeUndefined() // nothing to send
    await expect(
      noUrl.write({ text: 'not json\n', bytes: 9, records: 1, dayKey: '' }),
    ).resolves.toBeUndefined()
    let failing = true
    const errors: unknown[] = []
    const { sent, post } = recorder(() => failing)
    // The clock is ours, so the window doesn't depend on machine load; summary timers still run
    // for real (their delay is computed from this clock).
    let now = 0
    const t = slackTransport({
      url: URL_OK,
      post,
      minIntervalMs: 20,
      onError: (e) => errors.push(e),
      now: () => now,
    })
    // A direct send rejects: the sink in front falls back (tested through the manager below).
    await expect(t.write(batch([{ msg: 'a' }]))).rejects.toThrow('HTTP 500')
    await t.write(batch([{ msg: 'b' }])) // inside the window: counted
    await waitFor(() => errors.length === 1, 2_000) // the summary fails: reported once
    now = 100
    await expect(t.write(batch([{ msg: 'c' }]))).rejects.toThrow('HTTP 500')
    await t.write(batch([{ msg: 'd' }])) // inside the new window: counted again
    await sleep(80) // its summary fails too, but the outage was already reported
    expect(errors).toHaveLength(1)
    failing = false
    now = 200
    await t.write(batch([{ msg: 'e' }]))
    expect(sent.map((s) => s.body.text)).toEqual(['*CRITICAL* on `production`: e'])
    await t.close()
  })

  test('slackEscape', () => {
    expect(slackEscape('<@U1> & <!here>')).toBe('&lt;@U1&gt; &amp; &lt;!here&gt;')
  })
})

describe('slack channel through the manager', () => {
  test('critical and above only, by default; never blocks other channels', async () => {
    const { sent, post } = recorder()
    const mem = memoryTransport()
    const log = createLogManager({
      config: {
        default: 'both',
        channels: {
          mem: { driver: 'custom', via: () => mem, format: 'json' },
          both: { driver: 'stack', channels: ['slack', 'mem'] },
        },
      },
      env: { LOG_SLACK_WEBHOOK_URL: URL_OK, APP_ENV: 'staging' },
      slackPost: post,
      workerId: false,
    })
    log.error('just an error')
    log.critical('Ledger out of balance', { password: 'hunter2' })
    log.emergency('second, within the window')
    await log.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(URL_OK)
    expect(sent[0]?.body.text).toContain('*CRITICAL* on `staging` (slack): Ledger out of balance')
    expect(sent[0]?.body.text).toContain('[REDACTED]')
    expect(sent[0]?.body.text).not.toContain('hunter2')
    expect(mem.records().map((r) => r.msg)).toEqual([
      'just an error',
      'Ledger out of balance',
      'second, within the window',
    ])
    await log.close()
  })

  test('a broken webhook falls back to stderr with one warning; the app never sees an error', async () => {
    const stderr = captureStream()
    const log = createLogManager({
      config: { default: 'slack' },
      env: { LOG_SLACK_WEBHOOK_URL: URL_OK },
      slackPost: () => Promise.reject(new Error('ETIMEDOUT')),
      streams: { stderr: stderr.stream },
      workerId: false,
    })
    expect(() => log.critical('first')).not.toThrow()
    await log.flush()
    log.critical('second')
    await log.flush()
    const lines = stderr.lines()
    expect(lines.filter((l) => String(l.msg).includes('failed; writing to stderr'))).toHaveLength(1)
    expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(['first', 'second']))
  })

  test('a failed out-of-band summary is reported once on stderr', async () => {
    const stderr = captureStream()
    let calls = 0
    const log = createLogManager({
      config: { default: 'fast', channels: { fast: { driver: 'slack', minIntervalMs: 30 } } },
      env: { LOG_SLACK_WEBHOOK_URL: URL_OK },
      slackPost: async () => {
        calls++
        if (calls > 1) throw new Error('rate limited by Slack')
      },
      streams: { stderr: stderr.stream },
      workerId: false,
    })
    log.critical('one')
    await log.flush()
    log.critical('two')
    await log.flush()
    await waitFor(() => stderr.text().includes('could not send a summary'), 2_000)
    expect(stderr.text()).toContain('rate limited by Slack')
  })

  test('without a webhook URL the slack channel is harmless', async () => {
    const stderr = captureStream()
    const log = createLogManager({
      config: { default: 'slack' },
      env: { LOG_SLACK_WEBHOOK_URL: 'http://insecure.example/hook' },
      streams: { stderr: stderr.stream },
      workerId: false,
    })
    expect(log.issues.map((i) => i.key)).toEqual(['LOG_SLACK_WEBHOOK_URL'])
    log.critical('still recorded on stderr')
    await log.flush()
    expect(stderr.text()).toContain('still recorded on stderr')
  })
})

describe('SSRF-safe HTTP', () => {
  test.each([
    ['127.0.0.1', true],
    ['127.255.0.9', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.0.10', true],
    ['169.254.169.254', true], // cloud metadata
    ['100.64.0.1', true], // carrier-grade NAT
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['198.18.0.1', true],
    ['8.8.8.8', false],
    ['34.120.10.20', false],
    ['::1', true],
    ['::', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:8.8.8.8', false],
    ['64:ff9b::a00:1', true], // NAT64 of 10.0.0.1
    ['64:ff9b::808:808', false],
    ['fd00:ec2::254', true], // AWS metadata over IPv6
    ['fc00::1', true],
    ['fe80::1%eth0', true],
    ['fec0::1', true],
    ['ff02::1', true],
    ['2001:db8::1', true],
    ['2002:0a00:0001::1', true], // 6to4 of 10.0.0.1
    ['2606:4700:4700::1111', false],
    ['not-an-ip', true],
  ])('isBlockedAddress(%s) = %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked)
  })

  test('vetUrl refuses unsafe URLs with a hint', async () => {
    const refuse = async (
      url: string,
      re: RegExp,
      lookup?: () => Promise<{ address: string; family: number }[]>,
    ) => {
      const error = await vetUrl(url, lookup).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(UnsafeUrlError)
      expect((error as UnsafeUrlError).code).toBe('UNSAFE_URL')
      expect((error as Error).message).toMatch(re)
    }
    await refuse('http://hooks.slack.com/x', /only https/)
    await refuse('ftp://x/y', /only https/)
    await refuse('not a url', /not a valid URL/)
    await refuse('https://user:pw@hooks.slack.com/x', /credentials/)
    await refuse('https://127.0.0.1/x', /refusing "127.0.0.1"/)
    await refuse('https://[::1]:8443/x', /refusing "::1"/)
    await refuse('https://169.254.169.254/latest/meta-data', /metadata/)
    // A public-looking name whose DNS answer points inside (rebinding): refused.
    await refuse('https://hooks.example.com/x', /resolves to 10.0.0.5/, async () => [
      { address: '52.1.2.3', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
    await refuse('https://nowhere.example/x', /did not resolve/, async () => [])
    // The real resolver: localhost is loopback.
    await refuse('https://localhost/x', /refusing "localhost"/)
  })

  test('vetUrl pins the checked address and keeps the host name for TLS', async () => {
    const target = await vetUrl('https://hooks.example.com:8443/a?b=1', async () => [
      { address: '2606:4700:4700::1111', family: 6 },
    ])
    expect(target).toMatchObject({
      servername: 'hooks.example.com',
      address: '2606:4700:4700::1111',
      family: 6,
    })
    const literal = await vetUrl('https://8.8.8.8/x')
    expect(literal.servername).toBeUndefined()
  })

  test('safePost sends to the pinned address, needs a 2xx, and times out', async () => {
    const seen: Array<{
      method: string | undefined
      url: string | undefined
      body: string
      type: string | undefined
    }> = []
    let status = 200
    let hang = false
    let trickle = false
    const timers: NodeJS.Timeout[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString()
      })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, type: req.headers['content-type'] })
        if (hang) return
        if (trickle) {
          // Headers, then a byte every 20 ms forever: the socket is never idle.
          res.writeHead(200)
          timers.push(setInterval(() => res.write('.'), 20))
          return
        }
        res.statusCode = status
        res.end('ignored body')
      })
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    // Tests only: plain HTTP to a loopback server stands in for HTTPS to Slack. The URL check
    // (https only) still runs; the name resolves to the server's address.
    const options = {
      request: httpRequest as unknown as typeof httpsRequest,
      isBlocked: () => false,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      timeoutMs: 300,
    }
    await safePost(`https://hooks.test:${port}/hook?x=1`, '{"text":"hi"}', options)
    expect(seen[0]).toEqual({
      method: 'POST',
      url: '/hook?x=1',
      body: '{"text":"hi"}',
      type: 'application/json',
    })
    status = 500
    await expect(safePost(`https://hooks.test:${port}/hook`, '{}', options)).rejects.toThrow(
      'HTTP 500',
    )
    trickle = true
    const started = performance.now()
    await expect(safePost(`https://hooks.test:${port}/hook`, '{}', options)).rejects.toThrow(
      /timed out/,
    )
    expect(performance.now() - started).toBeLessThan(2_000)
    for (const t of timers) clearInterval(t)
    trickle = false
    hang = true
    await expect(safePost(`https://hooks.test:${port}/hook`, '{}', options)).rejects.toThrow(
      /timed out/,
    )
    // Default port and IP-literal URLs build their request options too.
    await expect(
      safePost('https://hooks.test/x', '{}', {
        ...options,
        timeoutMs: 50,
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow()
  })
})
