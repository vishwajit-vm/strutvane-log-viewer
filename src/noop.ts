/**
 * The no-op logger: every call is a cheap no-op, so code that holds a logger never needs to check
 * whether logging is on. The `null` channel behaves the same way.
 *
 * @module
 */
import { createEmitter, type StrutvaneLogger } from './logger.ts'

/**
 * Create a logger that writes nowhere.
 *
 * @example
 * const quiet = createNoopLogger()
 * quiet.error('never written')
 */
export function createNoopLogger(): StrutvaneLogger {
  return createEmitter({ sinks: [], sanitize: (value) => value })
}
