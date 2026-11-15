---
"@strutvane/logs": patch
---

`log:clear` and `clearLogFiles` never delete a daily file dated today or later. A file dated in the future (a clock that was ahead, or another host sharing the directory) used to make today's live file look old, and clearing without `--days` deleted it while a process was still writing to it. `clearLogFiles` takes an optional `now`.
