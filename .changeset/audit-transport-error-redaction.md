---
"@strutvane/logs": patch
---

The records the pipeline writes itself (the warning when a channel fails over to stderr, and the Slack "could not send" notice) now redact and cap the transport's error text. A custom transport or driver error such as `connect failed postgres://app:secret@db` no longer reaches stderr unredacted.
