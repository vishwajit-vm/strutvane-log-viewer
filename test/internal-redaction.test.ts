/**
 * Records the pipeline writes itself (the fallback warning when a channel fails, the Slack
 * "could not send" notice) bypassed the sanitiser, and they quote a transport's error message.
 * A custom transport's error often names its target with credentials (`connect failed
 * postgres://app:secret@db`), and that went to stderr unredacted. Every pipeline-generated record
 * must be redacted like any other.
 */
import { describe, expect, test } from 'vitest'
import { createLogManager } from '../src/manager.ts'
import { createSink } from '../src/sink.ts'
import type { Batch, Transport } from '../src/transports/types.ts'
import { captureStream } from './helpers.ts'

const SECRET = 'Zq9-secret-value'
const LEAKY_MESSAGES = [
  `connect failed postgres://app:${SECRET}@db:5432/app`,
  `401 for Bearer ${SECRET}${SECRET}`,
  `POST https://hooks.slack.com/services/T01/B02/${SECRET} failed`,
  `bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${SECRET}`,
]

function failingTransport(message: string): Transport {
  return {
    name: 'custom',
    write: () => Promise.reject(Object.assign(new Error(message), { code: message })),
    close: () => Promise.resolve(),
  }
}

describe('pipeline-generated records are redacted', () => {
  test.each(LEAKY_MESSAGES)('the fallback warning never quotes a secret: %s', async (message) => {
    const out: string[] = []
    const fallback: Transport = {
      name: 'stderr',
      write: (b: Batch) => {
        out.push(b.text)
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
    }
    const sink = createSink({ name: 'c', transport: failingTransport(message), fallback })
    sink.push('{"msg":"a"}\n', 6, 'info', Date.now())
    await sink.drain(10_000)
    await sink.close(1_000)
    const text = out.join('')
    expect(text).toContain('failed; writing to stderr')
    expect(text).not.toContain(SECRET)
  })

  test('a custom channel whose factory throws a secret-bearing error is redacted too', async () => {
    const stderr = captureStream()
    const log = createLogManager({
      config: {
        default: 'shipper',
        channels: {
          shipper: {
            driver: 'custom',
            via: () => {
              throw new Error(`cannot reach https://user:${SECRET}@logs.example.com`)
            },
          },
        },
      },
      env: {},
      workerId: false,
      streams: { stderr: stderr.stream, stdout: stderr.stream },
    })
    log.error('hello')
    await log.flush()
    await log.close()
    expect(stderr.text()).toContain('hello')
    expect(stderr.text()).not.toContain(SECRET)
  })

  test('the Slack "could not send" notice is redacted', async () => {
    const stderr = captureStream()
    const log = createLogManager({
      env: {
        LOG_CHANNEL: 'slack',
        LOG_SLACK_WEBHOOK_URL: `https://hooks.slack.com/services/T01/B02/${SECRET}`,
      },
      config: { channels: { slack: { driver: 'slack', minIntervalMs: 10 } } },
      slackPost: (url) => Promise.reject(new Error(`POST ${url} failed: socket hang up`)),
      workerId: false,
      streams: { stderr: stderr.stream, stdout: stderr.stream },
    })
    for (let i = 0; i < 5; i++) log.critical(`incident ${i}`)
    await log.flush()
    await new Promise((r) => setTimeout(r, 100))
    await log.close()
    expect(stderr.text()).toContain('incident')
    expect(stderr.text()).not.toContain(SECRET)
  })
})
