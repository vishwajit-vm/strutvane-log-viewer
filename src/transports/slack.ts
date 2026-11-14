/**
 * The `slack` channel's transport (ADR-0022 §2): important records to an incoming webhook.
 *
 * - **Rate-limited:** at most one message per `minIntervalMs` (default 10 s) per channel. Records
 *   that arrive in between are *counted*, and the count goes out with the next message ("+12 more
 *   since 10:22:01"), or on its own when the window ends. An incident that logs 10,000 criticals
 *   sends a handful of messages, not 10,000, and never gets the webhook throttled or banned.
 * - **SSRF-safe:** every request goes through `safePost` (https only, no private, loopback or
 *   metadata addresses, no redirects, a timeout).
 * - **Never blocks or crashes the app:** it runs in its own sink, off the hot path. A failed send
 *   rejects, so the sink falls back to stderr with one warning per outage (ADR-0015) and retries
 *   later; a failed out-of-band summary is reported once through `onError`.
 * - **No mention injection:** `&`, `<` and `>` are escaped as Slack requires, so a logged message
 *   can't turn into `@channel` or a link.
 *
 * The sink in front of it always writes JSON lines, so records arrive here already sanitised.
 *
 * @module
 */
import { safePost } from '../net/safe-http.ts'
import type { Batch, Transport } from './types.ts'

/** Sends one webhook body (injectable for tests). */
export type WebhookPost = (url: string, body: string) => Promise<void>

/** Options for {@link slackTransport}. */
export interface SlackTransportOptions {
  /** The webhook URL. Without one, every write fails (and the sink falls back). */
  readonly url: string | undefined
  /** The channel name, shown in messages. */
  readonly channel?: string
  /** `APP_ENV`, shown in messages. */
  readonly env?: string
  /** Sender display name. Default: `Strutvane Log`. */
  readonly username?: string
  /** Sender emoji. Default: `:boom:`. */
  readonly emoji?: string
  /** At most one message per this many milliseconds. Default: 10,000. */
  readonly minIntervalMs?: number
  /** How a body is sent. Default: {@link safePost}. */
  readonly post?: WebhookPost
  /** Called when an out-of-band summary fails (once per outage). */
  readonly onError?: (error: unknown) => void
  /** Injectable clock. */
  readonly now?: () => number
}

/** The record fields a Slack message uses. */
interface SlackRecord {
  readonly time?: unknown
  readonly level?: unknown
  readonly msg?: unknown
  readonly [key: string]: unknown
}

/**
 * Escape text for Slack's `mrkdwn` (`&`, `<`, `>`), which also defuses `<!channel>` mentions.
 *
 * @example
 * slackEscape('<!channel> & co') // '&lt;!channel&gt; &amp; co'
 */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function parseRecords(text: string): SlackRecord[] {
  const out: SlackRecord[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && !Array.isArray(value))
        out.push(value as SlackRecord)
    } catch {
      // Not JSON (a custom formatter): skip the line rather than fail the whole batch.
    }
  }
  return out
}

const MAX_DETAIL = 1_500

/**
 * Create the Slack transport.
 *
 * @example
 * const transport = slackTransport({ url: process.env.LOG_SLACK_WEBHOOK_URL, channel: 'slack' })
 */
export function slackTransport(options: SlackTransportOptions): Transport {
  const interval = options.minIntervalMs ?? 10_000
  const post = options.post ?? ((url: string, body: string) => safePost(url, body))
  const now = options.now ?? Date.now
  let nextAllowed = 0
  let pending = 0
  let pendingSince: string | undefined
  let timer: NodeJS.Timeout | undefined
  let warned = false

  const message = (record: SlackRecord | undefined, more: number, since?: string): string => {
    const level = String(record?.level ?? 'critical').toUpperCase()
    const head = `*${slackEscape(level)}* on \`${slackEscape(options.env ?? 'production')}\`${options.channel ? ` (${slackEscape(options.channel)})` : ''}`
    const text = record
      ? `${head}: ${slackEscape(String(record.msg ?? '').slice(0, 500))}`
      : `${head}: ${more} more record${more === 1 ? '' : 's'}`
    const extra = record && more > 0 ? `\n_+${more} more since ${since ?? 'the last message'}_` : ''
    const { time: _t, level: _l, msg: _m, ...rest } = record ?? {}
    const detail = Object.keys(rest).length > 0 ? JSON.stringify(rest) : ''
    const block =
      detail === ''
        ? ''
        : `\n\`\`\`${slackEscape(detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail)}\`\`\``
    return JSON.stringify({
      username: options.username ?? 'Strutvane Log',
      icon_emoji: options.emoji ?? ':boom:',
      text: `${text}${extra}${block}`,
    })
  }

  const requireUrl = (): string => {
    if (options.url === undefined)
      throw new Error('the slack channel has no webhook URL; set LOG_SLACK_WEBHOOK_URL')
    return options.url
  }

  const sendSummary = async (): Promise<void> => {
    timer = undefined
    if (pending === 0) return
    const count = pending
    const since = pendingSince
    pending = 0
    pendingSince = undefined
    nextAllowed = now() + interval
    try {
      await post(requireUrl(), message(undefined, count, since))
      warned = false
    } catch (error) {
      if (!warned) {
        warned = true
        options.onError?.(error)
      }
    }
  }

  const scheduleSummary = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => void sendSummary(), Math.max(0, nextAllowed - now()))
    timer.unref()
  }

  return {
    name: 'slack',
    async write(batch: Batch): Promise<void> {
      const records = parseRecords(batch.text)
      const first = records[0]
      if (!first) return
      const url = requireUrl()
      if (now() < nextAllowed) {
        // Inside the window: count, and let the summary (or the next message) report it.
        pending += records.length
        pendingSince ??= typeof first.time === 'string' ? first.time : undefined
        scheduleSummary()
        return
      }
      const more = records.length - 1 + pending
      const since = pendingSince
      pending = 0
      pendingSince = undefined
      clearTimeout(timer)
      timer = undefined
      nextAllowed = now() + interval
      await post(url, message(first, more, since))
      warned = false
    },
    async close(): Promise<void> {
      clearTimeout(timer)
      timer = undefined
      if (pending > 0) await sendSummary()
    },
  }
}
