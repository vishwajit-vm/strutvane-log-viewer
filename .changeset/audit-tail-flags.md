---
"@strutvane/logs": minor
---

`log:tail` takes the blueprint's flags: `--level=`, `--channel=`, `--grep=` (was `--filter`), `--since=` (a duration such as `15m` or `2h`, or a date or time) and `--follow`, which is now the default; `--no-follow` prints the latest records and exits. `parseSince` and `TailFilter.since` are exported for other tools.
