/**
 * Names that exist on `Object.prototype` (`toString`, `constructor`, `__proto__`, …) are not
 * channels. Channel names reach the manager from `.env` (`LOG_CHANNEL`, `LOG_STACK`,
 * `LOG_DEPRECATIONS_CHANNEL`), from the config file and from application input
 * (`Log.channel(name)`), so every lookup must see only the channels that were really declared.
 * Before the fix, an inherited name passed the `in` check, resolved to a function, and the first
 * log call threw.
 */
import { describe, expect, test } from 'vitest'
import { sourcesFor } from '../src/commands/sources.ts'
import { LoggingConfigError, resolveLoggingConfig } from '../src/config.ts'
import { parseLogLine } from '../src/format/parse.ts'
import { createLogManager } from '../src/manager.ts'
import { createSanitizer } from '../src/redact.ts'
import { captureStream, tempDir } from './helpers.ts'

/** Every property name an object literal inherits, plus the special `__proto__`. */
const INHERITED = [...Object.getOwnPropertyNames(Object.prototype), '__proto__'].filter(
  (name, i, all) => all.indexOf(name) === i,
)

function quietManager(env: Record<string, string> = {}) {
  const stderr = captureStream()
  const stdout = captureStream()
  const t = tempDir()
  const log = createLogManager({
    env: { LOG_CHANNEL: 'stderr', ...env },
    root: t.dir,
    workerId: false,
    streams: { stderr: stderr.stream, stdout: stdout.stream },
  })
  return { log, stderr, stdout, cleanup: t.cleanup }
}

describe('inherited property names are never channels', () => {
  test.each(INHERITED)(
    'Log.channel(%j) writes to the default channel and never throws',
    async (name) => {
      const { log, stderr, cleanup } = quietManager()
      try {
        expect(() => log.channel(name as never).warning('still logged')).not.toThrow()
        expect(() => log.stack([name as never]).warning('stacked')).not.toThrow()
        await log.flush()
        expect(stderr.text()).toContain('still logged')
        expect(stderr.text()).toContain('stacked')
        expect(stderr.text()).toContain('is not defined in config/logging')
      } finally {
        await log.close()
        cleanup()
      }
    },
  )

  test.each(INHERITED)(
    'LOG_CHANNEL / LOG_STACK / LOG_DEPRECATIONS_CHANNEL = %j only warn',
    async (name) => {
      const t = tempDir()
      const stderr = captureStream()
      try {
        for (const key of ['LOG_CHANNEL', 'LOG_STACK', 'LOG_DEPRECATIONS_CHANNEL']) {
          const env = { [key]: name, ...(key === 'LOG_CHANNEL' ? {} : { LOG_CHANNEL: 'stderr' }) }
          const log = createLogManager({
            env,
            root: t.dir,
            workerId: false,
            streams: { stderr: stderr.stream, stdout: stderr.stream },
          })
          expect(log.issues.map((i) => i.key)).toContain(key)
          expect(() => log.error('after a bad env value')).not.toThrow()
          expect(() => log.deprecation('deprecated')).not.toThrow()
          await log.close()
        }
      } finally {
        t.cleanup()
      }
    },
  )

  test.each(INHERITED)('the config file can not reference %j as a channel', (name) => {
    for (const config of [
      { default: name },
      { deprecations: name },
      { channels: { audit: { driver: 'stack' as const, channels: [name] } } },
    ]) {
      expect(() => resolveLoggingConfig(config, { env: {} })).toThrow(LoggingConfigError)
    }
  })

  test.each(INHERITED)('the log commands refuse channel %j with a friendly error', (name) => {
    const { config } = resolveLoggingConfig({}, { env: {} })
    expect(() => sourcesFor(config, name)).toThrow(/is not defined in config\/logging/)
  })

  test('a channel really named like an inherited key still works (null-prototype maps)', async () => {
    const stderr = captureStream()
    const log = createLogManager({
      config: { default: 'toString', channels: { toString: { driver: 'stderr' } } },
      env: {},
      workerId: false,
      streams: { stderr: stderr.stream, stdout: stderr.stream },
    })
    log.channel('toString').info('own channel')
    await log.flush()
    expect(stderr.text()).toContain('own channel')
    await log.close()
  })
})

describe('a "__proto__" key is data, never a prototype', () => {
  test('the line parser keeps it as a field', () => {
    const record = parseLogLine(
      '[2026-11-15 10:22:01.123] local.INFO: m {"__proto__":{"tenantId":"other"},"a":1}',
    )
    const fields = record?.fields as Record<string, unknown>
    expect(Object.hasOwn(fields, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype)
    expect(fields['tenantId']).toBeUndefined()
    expect(record?.tenantId).toBeUndefined()
  })

  test('the sanitiser keeps it as a key (and still redacts inside it)', () => {
    const input = JSON.parse('{"__proto__":{"password":"hunter2","ok":1}}') as object
    const out = createSanitizer()(input) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(JSON.stringify(out)).toBe('{"__proto__":{"password":"[REDACTED]","ok":1}}')
  })
})
