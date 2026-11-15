---
"@strutvane/logs": patch
---

A channel name that exists on `Object.prototype` (`toString`, `constructor`, `__proto__`, …) no longer crashes the logger. `Log.channel(name)`, `Log.stack([...])`, `LOG_CHANNEL`, `LOG_STACK` and `LOG_DEPRECATIONS_CHANNEL` treat it as an unknown channel (default channel plus a friendly warning), the config file reports it as undefined, and a `__proto__` key in logged data or in a log line is kept as data.
