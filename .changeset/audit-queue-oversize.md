---
"@strutvane/logs": patch
---

A record larger than the whole queue byte budget (only possible when `queue.maxBytes` is set below the record cap) is dropped and counted at once, instead of first evicting every queued record.
