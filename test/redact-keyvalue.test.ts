/**
 * Secrets written as `name=value` or `name: value` in free text (audit 2026-11-15). The query
 * rule only looked after `?`, `&`, `#` or `;`, so a libpq connection string
 * (`host=db user=app password=secret`), a driver error (`invalid password: secret`) or a
 * config dump in a message kept the secret.
 */
import { describe, expect, test } from 'vitest'
import { createPipelineLogger } from '../src/logger.ts'
import { redactString } from '../src/redact.ts'
import { memoryTransport } from './helpers.ts'

const SECRET = 'Zq9secretValue'

describe('key=value secrets in free text', () => {
  test.each([
    `host=db port=5432 user=app password=${SECRET} dbname=app`,
    `password=${SECRET}`,
    `PASSWORD=${SECRET}`,
    `db_password=${SECRET}`,
    `client_secret = ${SECRET}`,
    `api_key: ${SECRET}`,
    `apiKey=${SECRET}`,
    `access_token=${SECRET}, expires=3600`,
    `config {"password":"${SECRET}"}`,
    `refresh-token: "${SECRET}"`,
    `pwd='${SECRET}'`,
    `(passphrase=${SECRET})`,
  ])('%s', (text) => {
    const out = redactString(text)
    expect(out).not.toContain(SECRET)
    expect(out).toContain('[REDACTED]')
  })

  test('ordinary prose and values stay readable', () => {
    for (const text of [
      'exit code=1 after 3 retries',
      'token count: 1234',
      'password reset requested for user 42',
      'secret santa signups: 12',
      'status=200 route=/invoices',
    ])
      expect(redactString(text)).toBe(text)
  })

  test.each(['line', 'json'] as const)('no format keeps one (%s)', async (format) => {
    const t = memoryTransport()
    const log = createPipelineLogger({ transport: t, format })
    log.error(`connect failed: host=db user=app password=${SECRET}`, {
      err: new Error(`invalid api_key: ${SECRET}`),
    })
    await log.close()
    expect(t.text()).not.toContain(SECRET)
  })
})
