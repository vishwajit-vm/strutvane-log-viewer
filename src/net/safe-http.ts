/**
 * An SSRF-safe HTTPS POST, used by the `slack` channel (ADR-0022 §2).
 *
 * A webhook URL comes from configuration, so it can be wrong or hostile: `http://`, a credential
 * in the URL, `localhost`, a cloud metadata address (`169.254.169.254`), or a public name that
 * resolves to an internal address (DNS rebinding). Each would turn the logger into a way to reach
 * internal services. This client:
 *
 * - accepts only `https:` URLs without user info;
 * - resolves the host once and refuses it if **any** address is loopback, private, link-local,
 *   carrier-grade NAT, multicast, reserved, unspecified or a known metadata address, including
 *   IPv4 addresses embedded in IPv6 (`::ffff:10.0.0.1`, `64:ff9b::a00:1`);
 * - connects to exactly the address it checked (no second lookup that a rebinding DNS server
 *   could answer differently), while TLS still verifies the certificate for the real host name;
 * - never follows redirects, caps the time per request, and discards the response body.
 *
 * It throws on refusal or failure; the caller (a log sink) turns that into its fallback.
 *
 * @module
 */
import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { isIP } from 'node:net'

/** The URL is not allowed (scheme, credentials or a blocked address). */
export class UnsafeUrlError extends Error {
  override readonly name = 'UnsafeUrlError'
  readonly code = 'UNSAFE_URL'
}

/** Resolves a host name to every address (injectable for tests). */
export type LookupAll = (hostname: string) => Promise<readonly LookupAddress[]>

/** Options for {@link safePost}. */
export interface SafePostOptions {
  /** Request timeout. Default: 5,000 ms. */
  readonly timeoutMs?: number
  /** Header map; `content-type` defaults to `application/json`. */
  readonly headers?: Readonly<Record<string, string>>
  /** DNS resolution. Default: `dns.lookup` with every address. */
  readonly lookup?: LookupAll
  /** For tests only: the address rule. Default: {@link isBlockedAddress}. */
  readonly isBlocked?: (address: string) => boolean
  /** For tests only: the request function. Default: `https.request`. */
  readonly request?: typeof httpsRequest
}

const defaultLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

/** IPv4 dotted quad → 32-bit number. */
function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0)
}

const V4_BLOCKS: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]

function blockedV4(ip: string): boolean {
  const n = v4ToInt(ip)
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (n & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0
  })
}

/** Expand an IPv6 address to eight 16-bit groups (an embedded IPv4 tail is converted). */
function v6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail?.[1]) {
    const n = v4ToInt(tail[1])
    text = `${text.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head = '', rest] = text.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = rest === undefined || rest === '' ? [] : rest.split(':')
  const missing = 8 - left.length - right.length
  if (rest === undefined ? left.length !== 8 : missing < 1) return undefined
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...right]
  const out = groups.map((g) => Number.parseInt(g, 16))
  return out.length === 8 && out.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? out
    : undefined
}

function blockedV6(ip: string): boolean {
  const g = v6Groups(ip)
  if (!g) return true // unparseable: refuse
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, h = 0, i = 0] = g
  const embedded = `${h >>> 8}.${h & 0xff}.${i >>> 8}.${i & 0xff}`
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff)) {
    // ::, ::1, ::a.b.c.d (deprecated compatible) and ::ffff:a.b.c.d (mapped): judge the IPv4 part.
    if (f === 0 && h === 0 && (i === 0 || i === 1)) return true
    return blockedV4(embedded)
  }
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    return blockedV4(embedded) // NAT64
  if ((a & 0xfe00) === 0xfc00) return true // unique local fc00::/7 (incl. fd00:ec2::254 metadata)
  if ((a & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true // site-local (deprecated) fec0::/10
  if ((a & 0xff00) === 0xff00) return true // multicast ff00::/8
  if (a === 0x2001 && b === 0x0db8) return true // documentation
  if (a === 0x2002) return blockedV4(`${b >>> 8}.${b & 0xff}.${c >>> 8}.${c & 0xff}`) // 6to4
  return false
}

/**
 * Is `address` one a server-side request must never reach (loopback, private, link-local,
 * metadata, multicast, reserved…)? Anything that isn't a valid IP address is refused too.
 *
 * @example
 * isBlockedAddress('169.254.169.254') // true
 * isBlockedAddress('::ffff:127.0.0.1') // true
 * isBlockedAddress('203.0.113.9')     // true (documentation range)
 * isBlockedAddress('34.120.10.20')    // false
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return blockedV4(address)
  if (version === 6) return blockedV6(address)
  return true
}

/** The vetted target of a request. */
export interface VettedTarget {
  readonly url: URL
  /** Host name for TLS verification (`undefined` when the URL holds an IP address). */
  readonly servername: string | undefined
  readonly address: string
  readonly family: 4 | 6
}

/**
 * Check a URL and resolve its host, refusing anything unsafe. Exposed so the rules can be tested
 * (and reused) without sending anything.
 *
 * @throws UnsafeUrlError with a message that says what to fix
 *
 * @example
 * await vetUrl('http://hooks.slack.com/x') // throws: only https:// URLs are allowed
 */
export async function vetUrl(
  value: string,
  lookup: LookupAll = defaultLookup,
  isBlocked: (address: string) => boolean = isBlockedAddress,
): Promise<VettedTarget> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UnsafeUrlError('the webhook URL is not a valid URL')
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('only https:// URLs are allowed')
  if (url.username !== '' || url.password !== '')
    throw new UnsafeUrlError('credentials in the URL are not allowed')
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const literal = isIP(host)
  const addresses: readonly LookupAddress[] =
    literal === 0 ? await lookup(host) : [{ address: host, family: literal }]
  const first = addresses[0]
  if (!first) throw new UnsafeUrlError(`"${host}" did not resolve to any address`)
  for (const a of addresses) {
    if (isBlocked(a.address)) {
      throw new UnsafeUrlError(
        `refusing "${host}": it resolves to ${a.address}, a private, loopback, link-local or metadata address`,
      )
    }
  }
  return {
    url,
    servername: literal === 0 ? host : undefined,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  }
}

/**
 * POST `body` to `url` safely (see the module notes). Resolves when the server answered 2xx.
 *
 * @throws UnsafeUrlError for a refused URL; `Error` for a timeout, a network error or a non-2xx
 *
 * @example
 * await safePost(webhookUrl, JSON.stringify({ text: 'Payment failed' }))
 */
export async function safePost(
  url: string,
  body: string,
  options: SafePostOptions = {},
): Promise<void> {
  const target = await vetUrl(url, options.lookup, options.isBlocked)
  const timeoutMs = options.timeoutMs ?? 5_000
  const send = options.request ?? httpsRequest
  const payload = Buffer.from(body, 'utf8')
  const requestOptions: RequestOptions = {
    method: 'POST',
    hostname: target.url.hostname,
    port: target.url.port === '' ? 443 : Number(target.url.port),
    path: `${target.url.pathname}${target.url.search}`,
    headers: {
      'content-type': 'application/json',
      ...options.headers,
      'content-length': String(payload.length),
    },
    // Connect to the address that was checked, never a fresh lookup (DNS rebinding).
    lookup: (_hostname, opts, callback) => {
      if (opts.all) callback(null, [{ address: target.address, family: target.family }])
      else callback(null, target.address, target.family)
    },
    ...(target.servername === undefined ? {} : { servername: target.servername }),
    timeout: timeoutMs,
    agent: false,
  }
  await new Promise<void>((resolvePost, rejectPost) => {
    const timedOut = (): Error => new Error(`webhook timed out after ${timeoutMs} ms`)
    // `timeout` above only catches an idle socket; this caps the whole exchange, so a server that
    // trickles an endless body can't hold the channel's sink forever.
    const deadline = setTimeout(() => req.destroy(timedOut()), timeoutMs)
    deadline.unref()
    const settle = (error?: Error): void => {
      clearTimeout(deadline)
      if (error) rejectPost(error)
      else resolvePost()
    }
    const req = send(requestOptions, (res) => {
      res.resume() // discard the body: nothing in it is needed
      const status = res.statusCode ?? 0
      res.on('end', () =>
        settle(
          status >= 200 && status < 300 ? undefined : new Error(`webhook answered HTTP ${status}`),
        ),
      )
      res.on('error', settle)
    })
    req.on('timeout', () => req.destroy(timedOut()))
    req.on('error', settle)
    req.end(payload)
  })
}
