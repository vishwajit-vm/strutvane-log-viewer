/**
 * `@strutvane/log-viewer`: the log viewer for Strutvane apps, on top of the framework's built-in
 * logging (ADR-0022). This entry is the viewer's read API and its framework-agnostic Web handler.
 *
 * - **In a Strutvane app** you don't import this: `node strut add log-viewer` registers
 *   `@strutvane/log-viewer/provider`, which serves the viewer at `/_strutvane/logs`.
 * - **Your own React admin:** `@strutvane/log-viewer/react` has the `<LogViewer>` screen.
 * - **Any other server** that speaks `Request`/`Response`: mount {@link createViewerHandler}.
 *
 * @example
 * import { createViewerHandler } from '@strutvane/log-viewer'
 * const viewer = createViewerHandler({ authorize: (_req, { actor }) => actor?.roles.includes('admin') === true })
 * if (viewer.matches(request)) return viewer.fetch(request, { ip })
 *
 * @module
 */
export type {
  AccessDecision,
  AccessPolicy,
  AuthorizeFn,
  ViewerAuthContext,
} from './viewer/access.ts'
export {
  addressedToLoopback,
  buildAllowList,
  decideAccess,
  ipAllowed,
  isLoopbackAddress,
  isLoopbackHost,
  MIN_TOKEN_LENGTH,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  safeEqual,
  sessionValue,
  verifySession,
} from './viewer/access.ts'
export { CSV_COLUMNS, csvCell, csvHeader, csvRow } from './viewer/csv.ts'
export type { RecordFilter, RecordQuery, StatusFilter, ViewerRecord } from './viewer/filters.ts'
export { matchesQuery, parseRecordQuery, QueryError } from './viewer/filters.ts'
export type {
  ViewerAuditEvent,
  ViewerHandler,
  ViewerOptions,
  ViewerProblemCode,
  ViewerRequestInfo,
} from './viewer/handler.ts'
export { createViewerHandler } from './viewer/handler.ts'
export type { Cursor, FileLine, LogFileInfo, Page, PageOptions } from './viewer/store.ts'
export {
  decodeCursor,
  describeFiles,
  encodeCursor,
  MAX_LINE_BYTES,
  readDayLines,
  readLinesBackward,
  readLinesForward,
  readPage,
} from './viewer/store.ts'
export type { TailOptions } from './viewer/tail.ts'
export { createTailStream } from './viewer/tail.ts'
export { escapeHtml, renderViewerPage } from './viewer/ui.ts'
