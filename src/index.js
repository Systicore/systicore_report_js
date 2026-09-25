/**
 * @systicore/report: error reporting from browser apps to the Systicore
 * reports backend (POST {REPORTS_URL}/api/v1/ingest with a public scpk_ key).
 *
 * One reporter per page, configured by init(). Every function is safe to call
 * at any time: before init() calls are buffered, while disabled they are
 * no-ops, and none of them ever throws into the app.
 */

export {
  addBreadcrumb,
  captureException,
  captureMessage,
  flush,
  init,
  installGlobalHandlers,
  isEnabled,
  reportHttpError,
  setUser,
} from './facade.js';
