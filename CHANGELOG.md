# @strutvane/log-viewer

Formerly `@strutvane/logs`: renamed in 0.2, when the logging pipeline moved into `@strutvane/framework` (ADR-0022).

## 0.2.0-next.0

### Minor Changes

- **v2 (breaking, the 0.2 line): `@strutvane/logs` becomes `@strutvane/log-viewer`, the UI and read API only, on top of the framework's built-in logging (ADR-0022).**
  
  - **Removed (now in `@strutvane/framework/log`):** the whole logging pipeline: `Log`, `logger`, `report`, channels and `config/logging`, levels, the `line` and `json` formats, redaction, the queue, sinks, transports (file, console, Slack), file naming and retention, shutdown flushing, and the `log:tail`, `log:list` and `log:clear` commands (`./commands`). Import them from `@strutvane/framework/log`.
  - **The root entry is the viewer** (was `./viewer`): `createViewerHandler`, the read API (`readPage`, `readDayLines`, `readLinesForward`, `describeFiles`, cursors), filters, CSV and access helpers.
  - **Read API:** downloads now merge every writer process and rotation part by timestamp, oldest first (pages already did, newest first); forward reads are bounded (one chunk plus one line per process, lines over 1 MiB skipped); a new `channel` filter (`?channel=payments`) on records, files, downloads and the live tail, with the channel names in `/api/files`; every error answer carries a lowercase `snake_case` problem `code` (`invalid_query`, `invalid_body`, `unauthenticated`, `forbidden`, `method_not_allowed`, `payload_too_large`, `unsupported_media_type`, `rate_limited`, `internal_error`; RFC-0003).
  - **Access (closed by default):** `authorize(request, { actor, ip })` receives the signed-in actor, so the app's gate can decide by role. The token variable is now `LOG_VIEWER_TOKEN` (was `LOGS_VIEWER_TOKEN`) and the session cookie `sv_log_viewer_session`. In `APP_ENV=local` a request that is not from loopback (Docker, WSL, a VM) can still open the viewer with the token.
  - **New `@strutvane/log-viewer/react`:** the `<LogViewer>` React 19 screen (levels, channel, text, time range and request-id filters; paging with caps; live tail; downloads) and `createLogViewerClient` for the read API. Browser-safe; log text only ever renders as text.
  - **New provider** (`@strutvane/log-viewer/provider`, for the framework 0.2 Application): serves the viewer through `http.onRequest` after `auth.identity`, reads the log directory and file channels from `LogManagerToken`, settings from `config/log-viewer.ts` (`logViewer` key), and the gate from `LogViewerGateToken`. It no longer binds a logger or writes request logs.
  - **New installer** (`node strut add log-viewer`, declared as `strutvane.installer`): writes `config/log-viewer.ts`, lists it in `config/index.ts`, adds `LOG_VIEWER_ENABLED` and an empty `LOG_VIEWER_TOKEN` to `.env` and `.env.example`, and registers the provider in `bootstrap/providers.ts`; idempotent and reversible.
  - **Deprecated:** the request-logging adapters (`./http`, `./node`, `./hono`, `./express`). Request logging belongs in the framework; they stay until it ships there. Without a `logger` they now log through a log manager built from `.env`.
  - **Packaging:** `@strutvane/framework` `^0.2.0-next.0` is a required peer (and dev) dependency; React 19, Hono and Express are optional peers; Node `>=24.3`; built and published with npm.

## 0.1.0-next.0

### Minor Changes

- First implementation of `@strutvane/logs` (RFC-0004, ADR-0015): the zero-config `log` and `createLogger` with a non-blocking, bounded pipeline, redaction before storage, daily size-capped files with retention and per-process files, stderr fallback and shutdown flush; request logging for Web handlers (`/http`), `node:http` (`/node`), Hono (`/hono`) and Express (`/express`); and the secured built-in viewer (`/viewer`) with search, live tail, download and CSRF-protected clearing; and `@strutvane/logs/provider` for Strutvane apps (binds `LoggerToken`, request logging and the viewer through core hooks, settings from `config/logging.ts`).
