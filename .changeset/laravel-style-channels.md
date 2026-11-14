---
"@strutvane/logs": minor
---

Laravel-style logging channels (ADR-0022). **Breaking** for v1 callers; see "Migrating from v1" in the README.

- **Channels** from `config/logging` and `.env`: `single`, `daily`, `stack`, `stderr`, `stdout`, `slack`, `null` and `custom`, plus named channels of your own. New `.env` keys `LOG_CHANNEL`, `LOG_STACK`, `LOG_LEVEL` (debug in local, info otherwise), `LOG_DAILY_DAYS`, `LOG_FORMAT`, `LOG_MAX_FILE_SIZE`, `LOG_PATH`, `LOG_SLACK_WEBHOOK_URL`, `LOG_DEPRECATIONS_CHANNEL`. Config-file mistakes (unknown channels or drivers, bad levels, sizes or file names, stacks that contain themselves) throw one `LoggingConfigError` listing every problem; `.env` mistakes fall back to the default with a friendly warning. The v1 `LOGS_*` names are still read once, with a rename warning.
- **API:** the `Log` facade (`Log.channel()`, `Log.stack()`, `Log.build()`, `Log.withContext()`, `Log.shareContext()`, `Log.withoutContext()`, `Log.deprecation()`, `Log.report()`), the `logger()` and `report()` helpers, and `createLogManager()` with channel names typed from the config. `log` is the same object as `Log`.
- **Levels:** the eight RFC 5424 levels, with `trace`, `warn` and `fatal` as aliases so `Logger`-contract callers keep working. `debug`, `info` and `notice` are dropped before `warning` and up when a channel's queue is full.
- **Formats:** `line` (default, readable like Laravel's, one line per record with every newline and control character escaped) and `json` (NDJSON). The viewer, its live tail and `log:tail` read both, even mixed.
- **Files:** `strutvane.log`, `strutvane-YYYY-MM-DD.log`, `….worker-<id>.log` per additional process, size parts `-2`, `-3` (never renamed). Retention deletes whole days and never the day being written; clearing never deletes a live file or a file no channel owns. `compareLogFiles` orders parts and workers numerically.
- **Slack channel:** critical and above by default, at most one message per 10 s per channel with a coalesced count, sent through a new SSRF-safe HTTPS client (`safePost`, `vetUrl`, `isBlockedAddress`); failures fall back to stderr and never reach the app.
- **Commands:** new `@strutvane/logs/commands` entry with `log:tail` (level, channel and text filters, follow, per-process files merged by timestamp), `log:list` and `log:clear [--days=N]`.
- Removed: `createLogger`, `setDefaultLogger`, `resolveLogsConfig`, `DEFAULT_CONFIG`, `fileName`, `automaticWriterTag`, `prettyLine`, `prettyTransport` and the v1 `LOG_LEVELS`/`LOG_LEVEL_SEVERITY` re-exports (replacements are in the README).
