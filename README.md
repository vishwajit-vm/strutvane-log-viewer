<div align="center">

# Strutvane Logs

**Laravel-style logging for TypeScript apps: channels from `.env` (single, daily, stack, stderr, slack…), non-blocking writes, rotation and retention, secret redaction, request logging, and a built-in, locked-down log viewer at /_strutvane/logs. Installed by default in Strutvane apps.**

[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Pre-release.** The package is implemented and tested, but not released to npm yet. APIs may still change before 1.0. The spec is [RFC-0004](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md), refined by [ADR-0022](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0022-laravel-style-log-channels.md) (Laravel-style channels). After Phase 0 the pipeline moves into `@strutvane/framework` and the viewer becomes `@strutvane/log-viewer`.

## What it is

Strutvane Logs is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for enterprise B2B apps. It works in **any Node 24+ app** (plain `node:http`, Express, Hono, anything that speaks `Request`/`Response`), and it is installed **by default** in Strutvane apps. Logging works **like Laravel's** ([ADR-0022](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0022-laravel-style-log-channels.md)): channels in `config/logging`, settings in `.env`, files in `storage/logs`.

- **Zero configuration.** `Log.info('Invoice sent', { invoiceId })` just works. Request context (request id, trace id, tenant, user) is added automatically.
- **Channels, like Laravel.** `single`, `daily`, `stack`, `stderr`, `stdout`, `slack`, `null` and `custom`, plus any channel you name (`Log.channel('payments')`).
- **Never slows or crashes your app.** Log calls are synchronous, cheap and never throw. Writing happens off the hot path in batches, per channel. If a channel fails, it falls back to stderr (with exactly one warning) and recovers by itself; the other channels never notice.
- **Secrets never reach the disk, or Slack.** Passwords, passphrases, tokens, cookies, sessions, authorization headers, API keys, signatures, one-time and MFA codes, PINs, card data, JWTs, credentials in URLs, secret query parameters (`?token=`, `&sig=`, `#access_token=`), well-known prefixed keys (`sk_live_…`, `ghp_…`, `AKIA…`, `xoxb-…`), private keys and card numbers (in text or stored as numbers) are redacted once, before any channel sees the record. No channel option can turn redaction off. Add your own keys with `sanitize.extraKeys`, or at runtime with `registerSensitiveKeys(['taxNumber'])`.
- **Readable, safe files.** One record per line, always: newlines and ANSI codes are escaped. Daily or single files, a size cap per file, retention by days, one file per process when several processes log, and a guaranteed flush on shutdown.
- **Request logging** and a **built-in viewer** at `/_strutvane/logs` (closed by default), plus the `log:tail`, `log:list` and `log:clear` commands.

## Quick start

```bash
pnpm add @strutvane/logs
```

```ts
import { Log, logger, report } from '@strutvane/logs'

Log.info('Invoice sent', { invoiceId: 'inv_42', amount: 120 })
Log.channel('payments').warning('Card declined', { orderId: 123 })
Log.stack(['daily', 'slack']).critical('Ledger out of balance')
Log.withContext({ orderId: 123 })          // every record in this request
Log.shareContext({ release: '2026.11.15' }) // every record, every channel

try {
  await charge()
} catch (error) {
  report(error, { orderId: 123 })           // error level, stack and cause chain kept
}
logger('Cache warmed')                       // debug on the default channel
```

With no configuration, records go to the `stack` channel, which writes the `daily` file `storage/logs/strutvane-2026-11-15.log`:

```
[2026-11-15 10:22:01.123] local.ERROR: Payment failed {"invoice":42,"requestId":"9f1c…"}
```

`LOG_FORMAT=json` writes one JSON object per line instead (for log shippers):

```json
{"time":"2026-11-15T10:22:01.123Z","level":"error","msg":"Payment failed","requestId":"9f1c…","fields":{"invoice":42}}
```

### Levels

The eight RFC 5424 levels, as in Laravel, from least to most severe: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`. Every level has a method, plus `Log.log(level, …)`.

The v1 names keep working as aliases: `trace` → `debug`, `warn` → `warning`, `fatal` → `critical` (`Log.warn()` writes a `warning` record). When a channel's queue is full, `debug`, `info` and `notice` records are dropped before `warning` and above, and the drop count is logged later.

## Channels

```ts
// config/logging.ts
import { defineLoggingConfig } from '@strutvane/logs'

export default defineLoggingConfig({
  default: 'stack', // or LOG_CHANNEL
  channels: {
    payments: { driver: 'daily', name: 'payments', days: 90, level: 'info' },
    audit: { driver: 'stack', channels: ['daily', 'payments'] },
    shipper: { driver: 'custom', via: ({ format }) => myShipperTransport(format) },
  },
})
```

| Driver | Writes | Options |
|---|---|---|
| `single` | `storage/logs/strutvane.log` | `path`, `name`, `level`, `format`, `maxFileSize` |
| `daily` | `storage/logs/strutvane-YYYY-MM-DD.log`, kept for `days` | same, plus `days` |
| `stack` | every record to each of its `channels` (once each, even if stacks overlap) | `channels` |
| `stderr` / `stdout` | the stream, for containers | `level`, `format` |
| `slack` | `critical` and above to `LOG_SLACK_WEBHOOK_URL`; at most one message per 10 s, the rest counted | `url`, `level`, `username`, `emoji`, `minIntervalMs` |
| `null` | nothing | |
| `custom` | your transport: `via: (context) => transport` | `via`, `level`, `format` |

The built-in channels are `stack`, `single`, `daily`, `slack`, `stderr`, `stdout` and `null`; a channel with the same name replaces one. A stack that contains itself, directly or through other stacks, is refused with an error that shows the loop.

With `createLogManager({ config })` the channel names are **typed**: `Log.channel('paymnets')` doesn't compile.

**Mistakes.** A mistake in the config file throws a `LoggingConfigError` at startup that lists every problem with a hint. A mistake in `.env` never crashes the app: the default is used and a friendly warning is logged once (`LOG_LEVEL="loud" is not valid (use one of debug, info, …); using info`). An unknown channel name at runtime writes to the default channel and logs which channels exist.

### `.env` reference

| Key | Default | Meaning |
|---|---|---|
| `LOG_CHANNEL` | `stack` | The default channel |
| `LOG_STACK` | `daily` | The channels of the built-in `stack`, comma-separated (e.g. `daily,slack`) |
| `LOG_LEVEL` | `debug` when `APP_ENV=local`, else `info` | Minimum level for every channel without its own (Slack: `critical`) |
| `LOG_DAILY_DAYS` | `14` | Days a `daily` channel keeps, today included (`0` keeps everything) |
| `LOG_FORMAT` | `line` | `line` (readable) or `json` (one JSON object per line) |
| `LOG_MAX_FILE_SIZE` | `100mb` | Size of one file before the next part starts (`-2`, `-3`, …) |
| `LOG_PATH` | `storage/logs` | Log directory, relative to the project root |
| `LOG_SLACK_WEBHOOK_URL` | — | The `slack` channel's webhook (https only) |
| `LOG_DEPRECATIONS_CHANNEL` | `null` | Where `Log.deprecation()` writes |
| `LOGS_VIEWER_TOKEN` | — | Opens the viewer for token holders (16+ characters) |

The production Dockerfile sets `LOG_CHANNEL=stderr` and `LOG_FORMAT=json`. Additional processes get their own files automatically (cluster workers, worker threads); a process manager can set `LOG_WORKER_ID` for queue workers and schedulers.

### Coming from Laravel

| Laravel | Strutvane |
|---|---|
| `config/logging.php` | `config/logging.ts` (`defineLoggingConfig`) |
| `Log::info()`, `Log::warning()` … | `Log.info()`, `Log.warning()` … |
| `Log::channel('slack')` | `Log.channel('slack')` |
| `Log::stack(['daily', 'slack'])` | `Log.stack(['daily', 'slack'])` |
| `Log::build([...])` | `Log.build({ driver: 'single', path: 'storage/logs/imports' })` |
| `Log::withContext()`, `Log::withoutContext()` | `Log.withContext()`, `Log.withoutContext()` |
| `Log::shareContext()` | `Log.shareContext()` |
| `logger()`, `report()` | `logger()`, `report()` |
| `LOG_CHANNEL`, `LOG_STACK`, `LOG_LEVEL`, `LOG_DAILY_DAYS`, `LOG_SLACK_WEBHOOK_URL`, `LOG_DEPRECATIONS_CHANNEL` | the same keys |
| `storage/logs/laravel.log`, `laravel-2026-11-15.log` | `storage/logs/strutvane.log`, `strutvane-2026-11-15.log` |
| `tap`, `processors`, Monolog handlers | `custom` channels (`via`) |
| one shared file for every process | one file per process (`…worker-2.log`): a size cap can't break, lines never tear |

### Files

```
strutvane.log                         single
strutvane-2.log                       single, second size part (files are never renamed)
strutvane-2026-11-15.log              daily
strutvane-2026-11-15-2.log            daily, second size part
strutvane-2026-11-15.worker-2.log     an additional process (queue worker, cluster worker 2…)
payments-2026-11-15.log               a channel with name: 'payments'
```

Files are ordered with `compareLogFiles` (base, day, process, part number), never with a plain string sort, which would put `-10` before `-2`. Retention deletes whole days and never the day being written. `log:clear` and the viewer never delete the newest file of a process (it may still be written), nor any file whose base name no channel uses.

## Commands

`@strutvane/logs/commands` exports `log:tail`, `log:list` and `log:clear` for the `node strut` command registry (pure functions plus a thin adapter: `command.run(argv, { stdout, stderr, config })`).

```bash
node strut log:tail [--level=warning] [--channel=payments] [--filter=text] [-n 50] [-f]
node strut log:list [--channel=payments]
node strut log:clear [--days=7] [--channel=payments]
```

- `log:tail` shows the last records and, with `-f`, new ones as they arrive. It reads both formats and merges the per-process files by timestamp. Output is re-redacted and printed in the `line` format, so a hostile log line can't drive your terminal.
- `log:list` shows every file with its size and day, and totals per day.
- `log:clear` deletes files, keeping the last `--days` days if given; files a running process may still write are kept and listed.

## Migrating from v1 (`0.1.0-next.0`)

| v1 | Now |
|---|---|
| `import { log } from '@strutvane/logs'` | `import { Log } from '@strutvane/logs'` (`log` still works: it is the same object) |
| `createLogger({ driver, path, retentionDays, maxDailyBytes, writerTag, enabled })` | `createLogManager({ config, env, root, workerId })` with channels |
| `setDefaultLogger(logger)` | `setLogManager(manager)` |
| six levels `trace/debug/info/warn/error/fatal` | eight RFC 5424 levels; `trace`, `warn`, `fatal` are aliases |
| `LOG_FORMAT=pretty` (console only) | `LOG_FORMAT=line`, files included (`pretty` reads as `line`, with a warning) |
| `LOGS_PATH`, `LOGS_RETENTION_DAYS`, `LOGS_MAX_DAILY_SIZE` | `LOG_PATH`, `LOG_DAILY_DAYS`, `LOG_MAX_FILE_SIZE` (the old names are read once, with a rename warning) |
| `LOGS_DRIVER=stdout`, `LOGS_ENABLED=false` | `LOG_CHANNEL=stdout`, `LOG_CHANNEL=null` (also read once, with a warning) |
| files `2026-11-14.ndjson`, `2026-11-14.w3-1.ndjson` | `strutvane-2026-11-14.log`, `strutvane-2026-11-14.worker-3-2.log`; old files are not read or deleted, move or remove them by hand |
| `config/logging.ts` keys `level`, `driver`, `format`, `retentionDays`, `maxDailySize`, `enabled` | `default`, `channels`, `deprecations`, `path` (plus `requests` and `viewer`, unchanged) |
| `fileName`, `automaticWriterTag`, `prettyLine`, `prettyTransport`, `resolveLogsConfig` | `logFileName`, `automaticWorkerId`, the line format, `streamTransport`, `resolveLoggingConfig` |
| viewer level filter `level=warn,fatal` | still accepted (aliases), records show `warning`, `critical` |

## Request logging and the viewer

Pick the adapter for your server. `logs()` adds request logging **and** the viewer in one line.

**Hono**

```ts
import { Hono } from 'hono'
import { logs } from '@strutvane/logs/hono'

const app = new Hono()
app.use(logs())
```

**Express 5**

```ts
import express from 'express'
import { logs, errorLogging } from '@strutvane/logs/express'

const app = express()
app.use(logs())
// … your routes …
app.use(errorLogging()) // logs unhandled errors with their stack, then passes them on
```

**Plain `node:http`**

```ts
import { createServer } from 'node:http'
import { toNodeHandler, withRequestLogging } from '@strutvane/logs/node'
import { createViewerHandler } from '@strutvane/logs/viewer'

const viewer = createViewerHandler()
const serveViewer = toNodeHandler((request, info) => viewer.fetch(request, info))

createServer(
  withRequestLogging((req, res) => {
    if (viewer.matchesPath(new URL(req.url ?? '/', 'http://x').pathname)) return void serveViewer(req, res)
    res.end('hello')
  }),
).listen(3000)
```

**Any `fetch`-style server** (Bun, Deno, Next.js route handlers…)

```ts
import { createRequestLogger } from '@strutvane/logs/http'

const requests = createRequestLogger()
export default { fetch: (request: Request) => requests.handle(request, (r) => app.fetch(r)) }
```

Every request gets one line like `GET /invoices/:id 200` with `{ method, route, status, durationMs, size }`. Server errors log at `error`, slow requests (over 1 s) and aborted ones at `warning`, and `/health` and `/ready` are skipped. The request id comes from a safe incoming `x-request-id` header, or a new UUID, and is echoed back in the response.

The viewer's record list reads both formats and merges every process's files by timestamp, newest first: the web process, queue workers and cluster workers each write their own file (`…worker-2.log`), and one incident reads in the order it happened. Paging is exact: a page continues where the last one stopped, per process, and records written meanwhile never slip into older pages.

### Who can open the viewer

| Situation | Access |
|---|---|
| `APP_ENV=local` | Open, so `pnpm dev` just works, for requests to `localhost`, `127.0.0.1` or `[::1]` only (any other `Host` gets a 404, which blocks DNS-rebinding pages). When the runtime exposes the client's socket address, it must be loopback too (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`), so a dev server listening on `0.0.0.0` doesn't open the viewer to the network; when it doesn't, only the host is checked |
| `LOGS_VIEWER_TOKEN` set (16+ characters) | `Authorization: Bearer <token>`, or open `/_strutvane/logs?token=<token>` once in a browser (sets an 8-hour, HttpOnly, SameSite=Strict cookie and redirects to a clean URL) |
| You pass `authorize: (request) => boolean` | Only your rule decides (for example "admins only") |
| Anything else (e.g. production with nothing set) | **404**, as if the viewer didn't exist |

```ts
logs({
  viewer: {
    authorize: async (request) => (await getUser(request))?.role === 'admin',
    ipAllowList: ['10.0.0.0/8'],                       // optional, all modes
    scopeRecords: (request) => {                        // optional tenant scoping
      const tenant = tenantOf(request)
      return tenant ? (record) => record.tenantId === tenant : undefined
    },
    onAudit: (event) => auditLog.write(event),          // clear and download events
  },
})
```

## Programmatic setup

Outside a Strutvane app (or in tests), build the manager yourself. Options win over `.env`.

```ts
import { createLogManager, defineLoggingConfig, setLogManager } from '@strutvane/logs'

const Log = createLogManager({
  config: defineLoggingConfig({ channels: { payments: { driver: 'daily', name: 'payments' } } }),
  root: '/srv/app',                                           // relative paths start here
  sanitize: { extraKeys: ['iban'], extraPatterns: [/EMP-\d{6}/g] }, // added to the built-in rules
  bindings: { service: 'billing-api' },
  handleShutdown: true,                                       // drain on SIGTERM/SIGINT/beforeExit
})
setLogManager(Log) // optional: make the global `Log` use it
```

## Package entry points

| Import | What it gives you |
|---|---|
| `@strutvane/logs` | `Log`, `logger`, `report`, `createLogManager`, `defineLoggingConfig`, `runWithLogContext`, levels, formats, redaction, transports, file utilities |
| `@strutvane/logs/http` | `createRequestLogger` for `Request`/`Response` handlers, plus the shared request-logging helpers |
| `@strutvane/logs/node` | `withRequestLogging`, `toNodeHandler` (serve any Web handler from `node:http`) |
| `@strutvane/logs/hono` | `requestLogging`, `logs` |
| `@strutvane/logs/express` | `requestLogging`, `errorLogging`, `logs` |
| `@strutvane/logs/viewer` | `createViewerHandler` and its building blocks |
| `@strutvane/logs/provider` | The Strutvane app provider: binds `LoggerToken`, points `Log` at the app's channels, logs every request and serves the viewer through core hooks (`http.onRequest` / `http.onResponse`), configured by `config/logging.ts` |
| `@strutvane/logs/commands` | `log:tail`, `log:list`, `log:clear` (adapters and the pure functions behind them) |

`hono` and `express` are optional peer dependencies: install only the one you use.

In a Strutvane app `create-strutvane` registers `@strutvane/logs/provider` for you. It reads
`config/logging.ts` (`default`, `channels`, `deprecations`, `path` relative to the project root,
`requests.ignore`, `requests.slowThresholdMs`, `viewer.enabled/path/token`, and
`viewer.authorize/ipAllowList/scopeRecords/onAudit`), and never imports the framework: request logging
and the viewer ride on the framework's core hooks. `createLogsProvider({ viewer: { authorize } })`
sets the same access rules in code (and wins over the config file). The IP allow-list is checked
against the hook's `clientAddress` (the socket peer, never a forwarded header); without one it denies.

## Security, in short

- **Redaction before storage**, by key (at any depth) and by pattern, with tripwire tests proving every rule matters.
- **Log injection is impossible**: every record is exactly one line (newlines and U+2028/U+2029 are escaped), and incoming request ids are validated.
- **One line per record, in both formats**: the `line` format escapes newlines, every control character (ANSI codes included) and `U+2028/2029` in messages, and a space before `{`, so the context JSON always starts at the first ` {`. The parser is linear and reads both formats, even mixed in one directory.
- **The Slack channel** only talks HTTPS, refuses private, loopback, link-local and cloud metadata addresses (also when DNS answers with one), connects to the address it checked, never follows redirects, times out, escapes Slack mentions, and sends at most one message per window.
- **The viewer** renders log text with `textContent` only, sends a strict CSP with a per-response nonce, checks a CSRF token and `Origin` before clearing, never deletes today's files, validates every parameter (no path traversal), re-redacts records on the way out, limits concurrent live tails (a slot is freed however a tail ends, including clients that vanish without closing; tails accept GET only) and bounds the work per search (files are read backwards in fixed-size chunks, never whole). Scoped viewers see which days exist, not file names or sizes.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | Backend & database core |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Authentication, authorization, tenancy, audit |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | Metadata-driven frontend |
| [`@strutvane/core`](https://github.com/vishwajit-vm/strutvane-core) | Kernel: container, providers, config, context |
| [`@strutvane/contracts`](https://github.com/vishwajit-vm/strutvane-contracts) | Shared types and wire protocols |
| [`strutvane` / `@strutvane/cli`](https://github.com/vishwajit-vm/strutvane-cli) | Unified CLI |
| [`@strutvane/devkit`](https://github.com/vishwajit-vm/strutvane-devkit) | SDK for installers, generators and plugins |
| [`@strutvane/logs`](https://github.com/vishwajit-vm/strutvane-logs) | Zero-config logging + built-in log viewer (default) |
| [`create-strutvane`](https://github.com/vishwajit-vm/create-strutvane) | Project starter |

## Documentation

- **Package specification:** [RFC-0004](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md), [ADR-0015](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0015-logs-own-pipeline-per-process-files.md) and [ADR-0022](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0022-laravel-style-log-channels.md)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The quality gate is `corepack pnpm@12.18.0 run ci` (lint → typecheck → tests with coverage → build).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
