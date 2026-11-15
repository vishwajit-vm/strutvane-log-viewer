---
"@strutvane/logs": patch
---

Redaction now hides URL passwords without a user name (`redis://:secret@host`), passwords containing `:` or `@` (previously their first part leaked), and webhook URLs whose path is the secret (Slack, Discord, Microsoft Teams; new pattern rule `webhook`). An error's `name` is redacted and capped like its message. The URL rule now runs in linear time: a long hostile string no longer costs quadratic time on the logging thread.
