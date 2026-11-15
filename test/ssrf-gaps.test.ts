/**
 * SSRF and deadline gaps in the webhook client (audit 2026-11-15):
 * - IPv6 forms that carry or reach an IPv4 address were allowed: the local-use NAT64 prefix
 *   (64:ff9b:1::/48, RFC 8215), IPv4-translated addresses (::ffff:0:a.b.c.d, RFC 2765), Teredo
 *   (2001::/32) and the discard prefix (100::/64);
 * - the deadline started after DNS resolution, so a resolver that never answered held the Slack
 *   channel's sink for as long as the OS resolver waited.
 */
import { describe, expect, test } from 'vitest'
import { isBlockedAddress, safePost } from '../src/net/safe-http.ts'

describe('IPv6 forms that lead inside are refused', () => {
  test.each([
    '64:ff9b:1::a00:1', // local-use NAT64 → 10.0.0.1
    '64:ff9b:1:ffff::7f00:1',
    '::ffff:0:7f00:1', // IPv4-translated 127.0.0.1
    '::ffff:0:a9fe:a9fe', // IPv4-translated 169.254.169.254
    '::ffff:0:a00:1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '2001::1',
    '100::1', // discard-only
  ])('%s is blocked', (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  test.each([
    '2606:4700:4700::1111',
    '2a00:1450:4001:81d::200e',
    '64:ff9b::808:808', // well-known NAT64 of 8.8.8.8: public
    '2001:4860:4860::8888',
  ])('%s (public) is allowed', (address) => {
    expect(isBlockedAddress(address)).toBe(false)
  })
})

describe('the deadline covers the whole exchange', () => {
  test('a DNS lookup that never answers times out at the deadline', async () => {
    const started = performance.now()
    await expect(
      safePost('https://hooks.example.com/x', '{}', {
        timeoutMs: 200,
        lookup: () => new Promise(() => undefined),
      }),
    ).rejects.toThrow(/timed out/)
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})
