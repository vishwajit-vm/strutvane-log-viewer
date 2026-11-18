/**
 * `@strutvane/log-viewer/react`: the log viewer as a React 19 screen and a framework-free client
 * for its read API. Browser-safe: nothing here imports Node built-ins.
 *
 * @example
 * import { LogViewer } from '@strutvane/log-viewer/react'
 * export default function LogsPage() { return <LogViewer /> }
 *
 * @module
 */
export {
  createLogViewerClient,
  type LogFileEntry,
  type LogFilesResponse,
  type LogQuery,
  type LogRecordsPage,
  LogViewerApiError,
  type LogViewerClient,
  type LogViewerClientOptions,
  MAX_PAGE_SIZE,
  queryParams,
} from './client.ts'
export {
  eventSourceTail,
  LogViewer,
  type LogViewerProps,
  type TailSource,
  toQuery,
  VIEWER_LEVELS,
} from './LogViewer.tsx'
