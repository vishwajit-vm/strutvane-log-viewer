/**
 * Type-level tests for the log commands: clearing logs can't be undone, so `clearLogs` must not
 * compile without `confirm: true`.
 */
import { expectTypeOf, test } from 'vitest'
import { type ClearLogsResult, clearLogs, type LogSource } from '../src/commands/index.ts'

declare const sources: readonly LogSource[]

test('clearLogs requires confirm: true', () => {
  expectTypeOf(clearLogs(sources, { confirm: true })).resolves.toEqualTypeOf<ClearLogsResult>()
  // @ts-expect-error confirm is required
  void clearLogs(sources, {})
  // @ts-expect-error confirm must be exactly true
  void clearLogs(sources, { confirm: false })
  // @ts-expect-error the options are required
  void clearLogs(sources)
})
