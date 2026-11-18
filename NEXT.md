# NEXT: log-viewer v2 (`v2/log-viewer`), 2026-11-18

Branch `v2/log-viewer`, cut from `v2/channels` (2607bff). Not pushed. `@strutvane/logs` becomes
`@strutvane/log-viewer` (ADR-0022 §1): the UI and read API only, on the framework's logging.

## Done
- **Tooling** (`b3c62e0`): synced from strutvane-tooling, npm only (`.npmrc`, `devEngines`), pnpm
  files and the retired `workspace-packages.mjs` removed.
- **Code** (`f18f158`):
  - Removed the pipeline (now `@strutvane/framework/log`, branch `v2/logging` f3e28b8): config,
    channels, levels, formats, redaction, queue, sinks, transports, files, shutdown, SSRF client,
    `log:*` commands, and their tests.
  - Viewer kept, imports only the framework's public subpaths. Root entry = the viewer.
  - Read API: downloads merge processes and rotation parts by time (`readDayLines`, bounded
    `readLinesForward`); `?channel=` filter on records, files, downloads and tail (channel names in
    `/api/files`); lowercase problem `code` on every error; `authorize(request, { actor, ip })`;
    `LOG_VIEWER_TOKEN` (was `LOGS_VIEWER_TOKEN`), cookie `sv_log_viewer_session`; HTML page gets a
    channel select (and its level-count bug for 8 levels is fixed).
  - Provider for the framework 0.2 Application: `http.onRequest` (`logViewer.serve`, after
    `auth.identity`), `LogManagerToken` for dir and channels, `config('logViewer')`,
    `LogViewerGateToken`. No logger binding, no request logging.
  - Installer (`strutvane.installer` → `./dist/installer.mjs`): `config/log-viewer.ts`,
    `config/index.ts`, `.env` keys, `bootstrap/providers.ts` (own reversible patch; devkit
    `registerProvider` only for `strutvane.config.ts` apps).
  - `./react`: `<LogViewer>` + `createLogViewerClient` (browser-safe).
  - Request-logging adapters kept, deprecated (README), default logger = `createLogManager` from
    `.env` with shutdown drain.
- **Version** (`e21e534`): `0.2.0-next.0` via `changeset version` (pre `next`) from the 0.1.0 base;
  the old pipeline changesets dropped (they ship in the framework).
- **Docs**: README (users), CLAUDE.md, CHANGELOG, RELEASE-READINESS.md rows, this file.

## How it was verified
- Framework: `v2/logging` f3e28b8 packed in a scratchpad worktree (`npm ci && npx tsdown && npm pack`),
  installed with `npm install --no-save --ignore-scripts <tgz>`; lockfile generated without the
  framework (it is not on npm), so `npm ci` fails until it is.
- `npm run ci` 3× green in a row at `e21e534` (Windows, Node 24.21): 163 tests / 9 files, coverage
  95.73/93.96/92.82/97.35 *(agent-reported)*.
- `check-code-rules.mjs`, `check-deps.mjs`, `check-package.mjs` (45 files), `publint --strict`
  0.3.25, `attw --profile esm-only` 0.18.5, `npm audit --omit=dev` (0).

## Next
1. After `@strutvane/framework` 0.2.0-next.0 is on npm: `npm install`, commit the lockfile, then
   `npm ci && npm run ci` 3×.
2. Installer e2e in a real skeleton app: `node strut add log-viewer`, boot, open the page, then
   `node strut remove log-viewer` (R6). Check the framework's CSRF check lets the page's
   same-origin `POST /api/clear` through (it should: same-origin requests pass `verifyCsrf`).
3. R3: a written threat model and a `security-reviewer` pass.
4. Hub follow-ups (not this repo): tooling manifest target `logs` → rename when the local folder is
   renamed; docs-site page; catalogue data.

## Decisions for the project lead
- **Request logging:** the framework 0.2 has none, so the adapters stay here, deprecated. Proposal:
  add request logging to the framework (middleware on the HTTP kernel) and drop the adapters here.
- **Env name:** `LOG_VIEWER_TOKEN` replaces `LOGS_VIEWER_TOKEN` (no fallback, nothing is published).
- **Gate:** a container token (`LogViewerGateToken`), because the framework has no ability registry
  (`Gate::define`) yet; switch to a framework gate when one exists.
- **Installer target:** the framework devkit's `registerProvider` edits `strutvane.config.ts`, but the
  v2 skeleton lists providers in `bootstrap/providers.ts`. This package patches that file itself;
  the devkit should learn it (then remove `src/install/patch.ts`'s provider half).
- **Manifest block:** `strutvane` = `id`, `name`, `description`, `category`, `tags`, `compat`,
  `installer`, `docs` (blueprint §3.3); no schema exists yet to check it against.
