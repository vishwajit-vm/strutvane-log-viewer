/**
 * Credentials in URLs and webhook URLs, the class (audit 2026-11-15):
 * - a URL with only a password (`redis://:secret@host`, the usual Redis form) was not redacted;
 * - a password containing `:` or `@` leaked its first part;
 * - the rule backtracked over every scheme-like start, so a long hostile string cost quadratic
 *   time (timed in the perf suite);
 * - Slack, Discord and similar webhook URLs (the secret is the path) were not redacted;
 * - an error's `name` skipped redaction.
 * Every case is checked in the message, the fields, error messages and stacks, and in both
 * formats, so no channel or format can let one through.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { createPipelineLogger } from '../src/logger.ts'
import { createSanitizer, redactString } from '../src/redact.ts'
import { memoryTransport } from './helpers.ts'

const SECRET = 'Zq9-secret-value'

/** Connection strings with the secret somewhere in the password. */
const URLS = [
  `redis://:${SECRET}@cache:6379/0`,
  `rediss://default:${SECRET}@cache.example.com:6380`,
  `postgres://app:${SECRET}@db:5432/app`,
  `postgres://app:pa:${SECRET}@db/app`,
  `postgres://app:${SECRET}:tail@db/app`,
  `postgresql://app:p@${SECRET}@db/app`,
  `mysql://root:${SECRET}@ss@db`,
  `amqp://guest:${SECRET}@mq:5672`,
  `mongodb+srv://user:${SECRET}@cluster0.example.net/?retryWrites=true`,
  `https://x-access-token:${SECRET}@github.com/org/repo.git`,
  `ftp://:${SECRET}@files.example.com`,
]

const WEBHOOKS = [
  `https://hooks.slack.com/services/T0123ABCD/B0456EFGH/${SECRET}`,
  `https://hooks.slack.com/workflows/T0123ABCD/A0456EFGH/123456/${SECRET}`,
  `https://discord.com/api/webhooks/123456789012345678/${SECRET}`,
  `https://discordapp.com/api/webhooks/123456789012345678/${SECRET}`,
  `https://outlook.office.com/webhook/abc-123/IncomingWebhook/def/${SECRET}`,
]

describe('URL credentials and webhook URLs are redacted', () => {
  test.each([...URLS, ...WEBHOOKS])('redactString(%s)', (url) => {
    for (const text of [url, `failed to connect to ${url} (ECONNREFUSED)`, `"${url}"`]) {
      const out = redactString(text)
      expect(out).not.toContain(SECRET)
      expect(out).toContain('[REDACTED')
    }
  })

  test('the host stays readable', () => {
    expect(redactString(`redis://:${SECRET}@cache:6379`)).toBe('redis://:[REDACTED]@cache:6379')
    expect(redactString(`postgres://app:p@${SECRET}@db/x`)).toBe('postgres://app:[REDACTED]@db/x')
    expect(redactString(`https://hooks.slack.com/services/T01/B02/${SECRET}`)).toBe(
      'https://hooks.slack.com/services/[REDACTED:webhook]',
    )
  })

  test('URLs without credentials are untouched', () => {
    for (const text of [
      'https://example.com/a/b?x=1',
      'see https://user@example.com/profile',
      'mailto:someone@example.com',
      'http://[::1]:8080/health',
      'time 10:22:01 at host@2',
      'https://api.example.com:443/users?email=a@b.com',
      'http://localhost:3000/@me',
    ])
      expect(redactString(text)).toBe(text)
  })

  test('property: any password in a connection string is hidden, whatever it contains', () => {
    const passwordChar = fc.constantFrom(
      // Everything but `/`, `?` and `#`, which end a URL's authority in every parser.
      ...'abcXYZ0129:@!$%^&*()_+-=[]{};,.~'.split(''),
    )
    fc.assert(
      fc.property(
        fc.constantFrom('redis', 'postgres', 'mysql', 'amqp', 'https'),
        fc.constantFrom('', 'app', 'user.name'),
        fc.array(passwordChar, { minLength: 0, maxLength: 12 }).map((a) => a.join('')),
        (scheme, user, extra) => {
          const password = `${extra}${SECRET}${extra}`
          const out = redactString(`${scheme}://${user}:${password}@db.internal:5432/x`)
          expect(out).not.toContain(SECRET)
        },
      ),
      { numRuns: 500 },
    )
  })

  test('an error name, message, stack, code and cause never carry the secret', () => {
    const err = new Error(`connect ${URLS[0]}`)
    err.name = `DriverError(${URLS[2]})`
    Object.assign(err, { code: WEBHOOKS[0], cause: new Error(WEBHOOKS[2]) })
    const out = JSON.stringify(createSanitizer()({ err }))
    expect(out).not.toContain(SECRET)
  })

  test.each(['line', 'json'] as const)(
    'no format lets one through (message, fields, nested, Map, Set, error) — %s',
    async (format) => {
      const t = memoryTransport()
      const log = createPipelineLogger({ transport: t, format, level: 'debug' })
      for (const url of [...URLS, ...WEBHOOKS]) {
        log.info(`connecting to ${url}`, {
          url,
          nested: { deeper: [{ dsn: url }] },
          map: new Map([['target', url]]),
          set: new Set([url]),
          ...(URL.canParse(url) ? { parsed: new URL(url) } : {}),
          err: new Error(`failed: ${url}`),
        })
      }
      await log.close()
      expect(t.text()).not.toContain(SECRET)
    },
  )
})
