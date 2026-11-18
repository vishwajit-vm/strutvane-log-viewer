# CLAUDE.md: Strutvane Log Viewer (`@strutvane/log-viewer`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

The log viewer for Strutvane apps (Laravel's opcodesio/log-viewer): a locked-down page at `/_strutvane/logs`, its read API and a React screen, on top of the logging built into `@strutvane/framework` (`@strutvane/framework/log`, ADR-0022). Formerly `@strutvane/logs`; GitHub repo renamed to `vishwajit-vm/strutvane-log-viewer` (the local folder is still `packages/logs`).

It is an **add-on**: it depends only on the published `@strutvane/framework` (peer + dev) and imports it through its public subpaths (`/log`, `/core`, `/contracts`, `/devkit`), never by relative path.

## Status

- **v2 on branch `v2/log-viewer`, version `0.2.0-next.0`** (Changesets pre mode `next`), not on npm. See `NEXT.md` and `RELEASE-READINESS.md`.
- **The framework isn't on npm yet**, so `package-lock.json` has no `@strutvane/framework` entry and `npm ci` fails (ETARGET) until it is published. Locally: `npm install`, then `npm install --no-save --ignore-scripts <framework tarball>` (pack it from a framework worktree: `npm ci && npx tsdown && npm pack`). Never commit `file:`/`link:` specs.
- **The pipeline left in v2:** channels, formats, redaction, files, the `log:*` commands all live in the framework now. Don't re-add them here.
- **Deprecated, kept:** the request-logging adapters (`src/http/`, `src/adapters/`) until the framework ships request logging.

## Code map

| Path | What |
|---|---|
| `src/index.ts` | Root entry: the viewer handler and read API |
| `src/viewer/handler.ts` | Routes, problem codes, channel filter, CSRF, CSP, tail slots |
| `src/viewer/access.ts` | Who may open it: IP allow-list → `authorize(request, { actor, ip })` → local loopback → `LOG_VIEWER_TOKEN` → 404 |
| `src/viewer/store.ts` | Reading files: pages newest first merged by time (backwards, bounded), days oldest first merged by time (`readLinesForward`, bounded), cursors, re-sanitising |
| `src/viewer/filters.ts`, `csv.ts`, `tail.ts`, `ui.ts` | Query parsing, formula-safe CSV, SSE tail, the HTML page |
| `src/provider.ts` | The framework 0.2 provider: `http.onRequest` after `auth.identity`, `LogManagerToken`, `config('logViewer')`, `LogViewerGateToken` |
| `src/installer.ts`, `src/install/patch.ts` | `node strut add log-viewer` (`strutvane.installer`); pure, reversible source edits |
| `src/react/` | `<LogViewer>` and the browser-safe client (no Node imports here) |
| `src/http/`, `src/adapters/` | Deprecated request logging (Web, node, Hono, Express) |
| `test/` | Real temp files, the framework's real app/hooks/log manager/devkit, jsdom for React (`// @vitest-environment jsdom`) |

## Commands

- `npm run ci`: the quality gate (Biome → tsc → Vitest with coverage 90/90/85/90 → tsdown).
- `npx vitest run test/viewer.test.ts`: one file.
- R5 checks: `node .github/scripts/check-package.mjs`, `npm pack`, then `npm exec --package=publint@0.3.25 -- publint run <tgz> --strict` and `npm exec --package=@arethetypeswrong/cli@0.18.5 -- attw <tgz> --profile esm-only`.

## Gotchas

- `src/react/` must stay browser-safe: type-only imports from the server side, nothing from `@strutvane/framework/log` at runtime.
- The framework's devkit `config.registerProvider` edits `strutvane.config.ts`, but v2 apps list providers in `bootstrap/providers.ts`; the installer patches that file itself (`src/install/patch.ts`) and uses the devkit only for older apps.
- Config files may be cached as JSON (`config:cache`): functions (the gate) come from `LogViewerGateToken`, never from `config/log-viewer.ts`.
- The viewer's CSRF token is per handler instance. Behind several processes, use sticky sessions for the viewer, or clear from one instance.
- Readers always pass the channels' base names to `listLogFiles`: `*.log` names are generic, and a log directory may be shared.
- Precedence: the hub's `docs/00-executive-summary.md` and accepted ADRs win over this file.

## Boundaries (non-negotiable)

- Depends only on `@strutvane/framework` (peer + dev, `^0.2.0-next.0`); React, Hono and Express are optional peers. Never import `@strutvane/auth`, `ui` or any other add-on: the actor arrives through the `http.onRequest` payload.
- Connections used (integration map): container tokens (`LogManagerToken`, `HooksToken`, `LogViewerGateToken`), hooks (`http.onRequest`), installer, HTTP.
- Public API changes need a changeset, docs and tests.

## Definition of done (for any change)

Code, tests, docs and a changeset ship together. Security implications are noted. `NEXT.md` and `RELEASE-READINESS.md` stay current.
