---
"@strutvane/logs": minor
---

`log:clear` asks for confirmation before it deletes anything. In a terminal it asks a yes/no question; without one (CI, scripts, containers) it refuses unless `--force` is given. The function behind it now requires it too: `clearLogs(sources, { confirm: true, days })` (a type error without it, and a `ClearNotConfirmedError` at runtime). `CommandIO.confirm` lets a host CLI supply its own prompt.
