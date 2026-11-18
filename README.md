<div align="center">

# Strutvane Log Viewer

**Browse, search, tail and download your app's logs at `/_strutvane/logs`. One command to install, closed by default, and it reads the files Strutvane's built-in logging writes.**

[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Pre-release (`0.2.0-next.0`).** Implemented and tested, not on npm yet: it waits for `@strutvane/framework` 0.2. This package used to be `@strutvane/logs`. Since [ADR-0022](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0022-laravel-style-log-channels.md) logging itself is part of the framework (`@strutvane/framework/log`), and this package is only the viewer. See [Migrating from `@strutvane/logs`](#migrating-from-strutvanelogs).

## What it is

Laravel developers know [opcodesio/log-viewer](https://github.com/opcodesio/log-viewer): open a page, find the error. This is that page for **[Strutvane](https://github.com/vishwajit-vm/strutvane)** apps.

Logging is built into the framework, Laravel style: channels in `config/logging.ts`, settings in `.env`, files in `storage/logs/`. This package reads those files.

- **Every file, one timeline.** Both formats (`line` and `json`, even mixed after a `LOG_FORMAT` change), every rotation part (`…-2.log`), and every process: the web process, queue workers and cluster workers each write their own file (`…worker-2.log`). The viewer merges them by timestamp, so one incident reads in the order it happened.
- **Search that scales.** Filter by level, channel, text, time range, request id, route, status or tenant. Newest first, paged with an exact cursor. Files are read in fixed-size chunks, never whole, so a 10 GB log costs no more memory than a 10 KB one.
- **Live tail** of new records, and **downloads** of a day as NDJSON or CSV (formula-safe for Excel).
- **Closed by default.** Open on `localhost` while `APP_ENV=local`. Anywhere else, only for the users your gate allows, or with a token. Everyone else gets a 404, as if the page didn't exist.
- **Two ways to show it:** the built-in page at `/_strutvane/logs` (no build step), or the `<LogViewer>` React screen inside your own admin.

## Install

```bash
node strut add log-viewer
```

That's it. The installer, in one transaction (preview it with `--dry-run --diff`):

| File | Change |
|---|---|
| `config/log-viewer.ts` | Created: the viewer's settings (kept if you already have one) |
| `config/index.ts` | Lists it as `logViewer` |
| `.env`, `.env.example` | `LOG_VIEWER_ENABLED=true`, `LOG_VIEWER_TOKEN=` (empty: token access off) |
| `bootstrap/providers.ts` | Registers `@strutvane/log-viewer/provider` |

Run `node strut dev` and open <http://localhost:3000/_strutvane/logs>. `node strut remove log-viewer` reverses every edit (your `config/log-viewer.ts` is kept).

If a file doesn't look like the one the skeleton ships, the installer leaves it alone and prints the one line to add yourself.

## Who can open it

| Situation | Access |
|---|---|
| `APP_ENV=local`, browser on the same machine | **Open**, for requests to `localhost`, `127.0.0.1` or `[::1]` from a loopback address. Any other `Host` header gets a 404 (this blocks DNS-rebinding pages), and so does another machine on the network |
| Your gate (see below) | **Only your rule decides**: `true` opens it, anything else is a 404 |
| `LOG_VIEWER_TOKEN` set (16+ characters) | `Authorization: Bearer <token>`, or open `/_strutvane/logs?token=<token>` once in a browser (an 8-hour, HttpOnly, SameSite=Strict cookie, then a clean URL). Also works in local mode from Docker, WSL or a VM |
| Anything else (production with nothing set) | **404** |

### The gate

Like Laravel's `Gate::define('viewLogViewer', …)`, decide in your service provider who may open it. The gate receives the signed-in user that `@strutvane/auth` resolved:

```ts
// app/providers/app.provider.ts
import { type Application, ServiceProvider } from '@strutvane/framework'
import { LogViewerGateToken } from '@strutvane/log-viewer/provider'

export class AppServiceProvider extends ServiceProvider {
  override register(app: Application): void {
    app.container.value(LogViewerGateToken, {
      authorize: (_request, { actor }) => actor?.roles.includes('admin') === true,
      // Optional: only one tenant's records for tenant admins.
      scopeRecords: () => undefined,
      // Optional: write downloads and clears to your audit log.
      onAudit: (event) => audit.write(event),
    })
  }
}
```

Only a literal `true` opens the viewer; a gate that throws is a 404 (fail closed). A scoped viewer (`scopeRecords` returns a filter) sees only matching records, sees which days exist but not file names or sizes, and can't clear logs.

### Settings: `config/log-viewer.ts`

```ts
import { defineConfig } from '@strutvane/framework'

export default defineConfig((env) => ({
  enabled: env.boolean('LOG_VIEWER_ENABLED', true),
  path: '/_strutvane/logs',
  token: env.optional('LOG_VIEWER_TOKEN'),
  ipAllowList: [] as string[], // e.g. ['10.0.0.0/8']; checked against the socket peer, never a forwarded header
}))
```

Functions (the gate) live in code, not in this file, because `node strut config:cache` stores config as JSON. A wrong setting (a short token, an odd path, a bad IP range) stops the boot with a message naming it: a typo must never open the viewer by accident.

## Using it

The page has filters for **levels** (debug is off by default), **channel**, **search** text, **route**, **status** (`404` or `5xx`), **request id** and a **time range**; **Load older records** pages back; **Live tail** streams new records in; the **Files** list downloads a day as NDJSON or CSV; **Clear old logs** deletes files before today after you type `DELETE` (today's files and every process's newest file are never deleted).

Channels are the file channels of your `config/logging.ts` that write into `storage/logs` (`daily`, `single`, and any you add, such as `payments`).

### In your own React admin

```tsx
import { LogViewer } from '@strutvane/log-viewer/react'

export default function LogsPage() {
  return <LogViewer pageSize={100} />
}
```

`<LogViewer>` talks to the same API, so the same access rules apply. It has no look of its own: style the `lv-*` classes (or `[data-log-viewer]`) from your design. Log text is only ever rendered as text, so a log line can't become markup. Props: `basePath`, `pageSize` (at most 500), `maxRows` (records kept on screen, default 2,000), `title`, and `client` / `openTail` for tests.

`createLogViewerClient()` is the same API as a small, browser-safe client, for any other front end.

## The read API

Under the viewer path (default `/_strutvane/logs`). Errors are RFC 9457 problems (`application/problem+json`) with a stable lowercase `code`.

| Method | Path | What |
|---|---|---|
| GET | `/api/files` | Files, newest first, and `channels` |
| GET | `/api/records` | Records, newest first. `limit` (1–500, default 100), `cursor`, and the filters |
| GET | `/api/download?day=YYYY-MM-DD&format=ndjson\|csv` | One day, oldest first, every process merged |
| GET | `/api/tail` | Live tail (Server-Sent Events) |
| GET | `/api/session` | The CSRF token for `clear` |
| POST | `/api/clear` | `{"confirm":"DELETE","before":"YYYY-MM-DD"}` |

Filters (all optional): `level` (comma-separated; `warn`, `fatal` and `trace` are accepted aliases), `channel`, `q`, `from`, `to` (ISO 8601), `route`, `status`, `requestId`, `traceId`, `tenantId`. An invalid filter is a 400 `invalid_query`, never silently ignored.

Codes: `invalid_query`, `invalid_body`, `unauthenticated`, `forbidden`, `method_not_allowed`, `payload_too_large`, `unsupported_media_type`, `rate_limited` (too many live tails), `internal_error`. A viewer you may not open answers a plain 404.

## Outside a Strutvane app

The viewer is a plain Web handler, for anything that speaks `Request`/`Response`:

```ts
import { createViewerHandler } from '@strutvane/log-viewer'

const viewer = createViewerHandler({
  dir: '/srv/app/storage/logs',
  authorize: (request) => isAdmin(request),
})

// in your server:
if (viewer.matches(request)) return viewer.fetch(request, { ip: socketAddress })
```

### Request logging adapters (deprecated)

`@strutvane/log-viewer/http`, `/node`, `/hono` and `/express` still log one line per request and mount the viewer, for apps that don't run on the Strutvane HTTP kernel. **They are deprecated:** request logging belongs in `@strutvane/framework` and will move there; until then they work as before. Without a `logger` option they write through a log manager built from `.env` (`createLogManager` from `@strutvane/framework/log`).

```ts
import { Hono } from 'hono'
import { logs } from '@strutvane/log-viewer/hono'

const app = new Hono()
app.use(logs())
```

## Package entry points

| Import | What |
|---|---|
| `@strutvane/log-viewer` | `createViewerHandler`, the read API (`readPage`, `readDayLines`, `readLinesForward`, `describeFiles`, cursors), filters, CSV and access helpers |
| `@strutvane/log-viewer/react` | `<LogViewer>`, `createLogViewerClient` (browser-safe) |
| `@strutvane/log-viewer/provider` | The app provider, `LogViewerGateToken`, `createLogViewerProvider` |
| `@strutvane/log-viewer/installer` | The installer `node strut add log-viewer` runs |
| `@strutvane/log-viewer/http`, `/node`, `/hono`, `/express` | Request-logging adapters (deprecated) |

`@strutvane/framework` is a required peer dependency (`^0.2.0-next.0`); `react`, `hono` and `express` are optional peers.

## Migrating from `@strutvane/logs`

| Before | Now |
|---|---|
| `import { Log, logger, report } from '@strutvane/logs'` and the rest of the logging API | `@strutvane/framework/log` (built in; nothing to install) |
| `log:tail`, `log:list`, `log:clear` | Built into the framework's `node strut` |
| `@strutvane/logs/viewer` | `@strutvane/log-viewer` (the root entry) |
| `@strutvane/logs/provider` (`config/logging.ts` `viewer`, `requests`) | `@strutvane/log-viewer/provider`, settings in `config/log-viewer.ts`, the gate in `LogViewerGateToken`. It no longer binds the logger or logs requests |
| `authorize(request)` | `authorize(request, { actor, ip })` |
| `LOGS_VIEWER_TOKEN` | `LOG_VIEWER_TOKEN` |
| `@strutvane/logs/http`, `/node`, `/hono`, `/express` | `@strutvane/log-viewer/…` (deprecated) |

## Security, in short

- **Deny by default**, a 404 for anyone without access, and secrets compared in constant time.
- **Log text is hostile**: the page renders it with `textContent` only under a strict CSP with a per-response nonce; the React screen renders it as text; CSV cells that could run as formulas are neutralised.
- **No path traversal**: file names come from the directory listing and must match the framework's log file pattern; `day`, `channel` and `cursor` are validated.
- **Records are re-redacted** on the way out, and searches match the redacted text, so a search can't guess a secret.
- **Bounded work**: pages scan at most 100,000 lines, reads go in fixed-size chunks, lines over 1 MiB are skipped unread, at most 5 live tails run at once (a slot is freed however a tail ends).
- **Clearing** needs the CSRF token, a same-origin request and `"confirm":"DELETE"`, and never deletes today's files.

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | The framework, including logging (`/log`) |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Sign-in, roles and teams: the actor your gate sees |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | The React admin `<LogViewer>` fits into |
| [`create-strutvane`](https://github.com/vishwajit-vm/create-strutvane) | Project starter (offers the log viewer, preselected) |

## Documentation

- [ADR-0022](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0022-laravel-style-log-channels.md): logging in the framework, the viewer as its own package
- [ADR-0015](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0015-logs-own-pipeline-per-process-files.md) and [RFC-0004](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md) (§6, the viewer)
- The ecosystem blueprint: [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). npm only (npm 11.19+). The quality gate is `npm run ci` (lint → typecheck → tests with coverage → build).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
