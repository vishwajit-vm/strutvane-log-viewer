/**
 * Type-level tests: channel names typed through `config/logging`, levels, and config shapes.
 * Misuse must fail to compile (every `@ts-expect-error` below is an error the compiler must find).
 */
import { describe, expectTypeOf, test } from 'vitest'
import {
  type BuiltInChannel,
  type ChannelName,
  createLogManager,
  defineLoggingConfig,
  type Level,
  type LevelName,
  Log,
  type LogManager,
  type StrutvaneLogger,
} from '../src/index.ts'

const config = defineLoggingConfig({
  channels: {
    payments: { driver: 'daily', name: 'payments', days: 90 },
    audit: { driver: 'stack', channels: ['payments', 'daily'] },
  },
})

describe('typed channel names', () => {
  test('ChannelName is the built-ins plus the channels of the config', () => {
    expectTypeOf<ChannelName<typeof config>>().toEqualTypeOf<
      BuiltInChannel | 'payments' | 'audit'
    >()
    expectTypeOf<ChannelName<{ default: 'stack' }>>().toEqualTypeOf<BuiltInChannel>()
  })

  test('Log.channel and Log.stack accept only defined channels', () => {
    const log = createLogManager({ config })
    expectTypeOf(log).toEqualTypeOf<LogManager<BuiltInChannel | 'payments' | 'audit'>>()
    expectTypeOf(log.channel('payments')).toEqualTypeOf<StrutvaneLogger>()
    log.channel('daily')
    log.channel()
    log.stack(['payments', 'slack'])
    // @ts-expect-error: a typo is a compile error
    log.channel('paymnets')
    // @ts-expect-error: every stack member must exist
    log.stack(['payments', 'nope'])
    // @ts-expect-error: a stack takes a list
    log.stack('payments')
  })

  test('the untyped default facade suggests built-ins but accepts any configured name', () => {
    Log.channel('daily')
    Log.channel('anything-from-config')
    expectTypeOf(Log.withContext({ a: 1 })).toEqualTypeOf(Log)
  })
})

describe('levels', () => {
  test('canonical names and aliases are accepted; anything else is not', () => {
    const log = createLogManager()
    log.log('warning', 'x')
    log.log('warn', 'x')
    log.log('emergency', 'x')
    // @ts-expect-error: not a level
    log.log('loud', 'x')
    expectTypeOf(log.level).toEqualTypeOf<Level>()
    expectTypeOf<'fatal'>().toExtend<LevelName>()
    expectTypeOf<'fatal'>().not.toExtend<Level>()
    // @ts-expect-error: fields must be an object
    log.info('x', 'not fields')
  })
})

describe('config shapes', () => {
  test('drivers and their options are checked', () => {
    defineLoggingConfig({
      channels: { s: { driver: 'single', maxFileSize: '50mb', format: 'json' } },
    })
    defineLoggingConfig({
      channels: {
        c: {
          driver: 'custom',
          via: ({ name }) => ({ name: name ?? 'x', write: async () => {}, close: async () => {} }),
        },
      },
    })
    // @ts-expect-error: unknown driver
    defineLoggingConfig({ channels: { x: { driver: 'kafka' } } })
    // @ts-expect-error: a stack needs its channels
    defineLoggingConfig({ channels: { x: { driver: 'stack' } } })
    // @ts-expect-error: a custom channel needs via
    defineLoggingConfig({ channels: { x: { driver: 'custom' } } })
    // @ts-expect-error: not a format
    defineLoggingConfig({ channels: { x: { driver: 'stderr', format: 'pretty' } } })
    // @ts-expect-error: not a level
    defineLoggingConfig({ channels: { x: { driver: 'daily', level: 'loud' } } })
  })
})
