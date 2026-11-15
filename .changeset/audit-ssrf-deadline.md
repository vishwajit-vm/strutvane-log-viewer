---
"@strutvane/logs": patch
---

The Slack channel's HTTP client refuses more IPv6 forms that lead to internal IPv4 addresses (local-use NAT64 `64:ff9b:1::/48`, IPv4-translated `::ffff:0:a.b.c.d`, Teredo `2001::/32`, discard-only `100::/64`), and its deadline now covers DNS resolution too, so a resolver that never answers can't hold the channel past `timeoutMs`.
