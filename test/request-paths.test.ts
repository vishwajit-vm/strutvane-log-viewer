/** Request lines never carry secrets from the path (VAPT regression tests). */
import { createPipelineLogger } from '@strutvane/framework/log'
import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import * as honoAdapter from '../src/adapters/hono.ts'
import {
  createRequestLogger,
  loggedPath,
  MAX_LOGGED_PATH_LENGTH,
  safePath,
} from '../src/http/index.ts'
import { memoryTransport } from './helpers.ts'

const RESET_TOKEN = '9f8e7d6c5b4a39281706f5e4d3c2b1a0'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVl'

describe('safePath', () => {
  test('token-like segments, JWTs and prefixed keys in a path are hidden', () => {
    expect(safePath(`/password/reset/${RESET_TOKEN}`)).toBe('/password/reset/[REDACTED]')
    expect(safePath(`/verify/${JWT}`)).not.toContain('c2lnbmF0dXJl')
    expect(safePath(`/keys/${'sk_live_'}51HxAbCdEfGh12345678/revoke`)).not.toContain('51HxAbCd')
    expect(safePath('/invite/aB3dE5gH7jK9mN1pQ3sT5vW7')).toBe('/invite/[REDACTED]')
  })

  test('ordinary paths are kept', () => {
    for (const path of [
      '/',
      '/invoices/42',
      '/users/ann-smith/settings',
      '/files/2026-11-14-quarterly-report-final.pdf',
      '/orders/550e8400',
      '/orders/550e8400-e29b-41d4-a716-446655440000',
      '/docs/getting_started_with_the_platform',
      '/n/12345678901234567890123',
    ])
      expect(safePath(path)).toBe(path)
  })

  test('long paths are capped', () => {
    const out = safePath(`/${'a/'.repeat(500)}`)
    expect(out.length).toBe(MAX_LOGGED_PATH_LENGTH + 1)
    expect(out.endsWith('…')).toBe(true)
    expect(loggedPath(`http://h/reset/${RESET_TOKEN}?token=x`)).toBe('/reset/[REDACTED]')
  })

  test('the Web handler and the Hono fallback log the safe path', async () => {
    const t = memoryTransport()
    const logger = createPipelineLogger({ transport: t })
    await createRequestLogger({ logger }).handle(
      new Request(`http://x/reset/${RESET_TOKEN}`),
      () => new Response('ok'),
    )
    const app = new Hono()
    app.use(honoAdapter.requestLogging({ logger }))
    app.get('/known/:token', (c) => c.text('ok'))
    await app.fetch(new Request(`http://x/known/${RESET_TOKEN}`))
    await app.fetch(new Request(`http://x/unknown/${RESET_TOKEN}`))
    await logger.flush()
    const text = JSON.stringify(t.records())
    expect(text).not.toContain(RESET_TOKEN)
    expect(text).toContain('/known/:token')
    expect(text).toContain('/unknown/[REDACTED]')
  })
})
