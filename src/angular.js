/**
 * Angular adapter, without importing Angular (the app's own Angular version
 * is used, and this package stays build-free):
 *
 *   { provide: ErrorHandler, useClass: ReportingErrorHandler }
 *
 * plus reportHttpErrorResponse() for an HttpInterceptorFn. Angular's DI can
 * construct ReportingErrorHandler because its constructor takes no
 * arguments.
 */

import { captureException, reportHttpError } from './facade.js';

const ANGULAR_ERROR_HANDLER_MECHANISM = 'angular.ErrorHandler';

/** Response headers that carry the backend's request id, first match wins. */
const REQUEST_ID_HEADERS = ['X-Request-Id', 'X-Correlation-Id'];

/**
 * Drop-in replacement for Angular's ErrorHandler: logs like the default
 * handler (console.error('ERROR', error)) and reports the error. With
 * provideBrowserGlobalErrorListeners() (zoneless apps) this also covers
 * uncaught errors and unhandled rejections, so installGlobalHandlers() is
 * not needed.
 */
export class ReportingErrorHandler {
  /**
   * @param {unknown} error
   */
  handleError(error) {
    try {
      globalThis.console?.error('ERROR', error);
    } catch {
      // A broken console must not stop the report.
    }
    const unwrapped = unwrapZoneRejection(error);
    if (isHttpErrorResponse(unwrapped)) {
      reportHttpErrorResponse(unwrapped);
      return;
    }
    captureException(unwrapped, { tags: { mechanism: ANGULAR_ERROR_HANDLER_MECHANISM } });
  }
}

/**
 * True for Angular's HttpErrorResponse (matched by shape, not by class, so
 * no @angular/common/http import is needed).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHttpErrorResponse(value) {
  const candidate = /** @type {{ name?: unknown, status?: unknown } | null} */ (value);
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.name === 'HttpErrorResponse' &&
    typeof candidate.status === 'number'
  );
}

/**
 * Reports an HttpErrorResponse when it is a server fault (>= 500) or a
 * network failure (status 0). Pass the request from an interceptor, so the
 * report carries the HTTP method; the URL is reduced to a path template
 * (/api/vault/42?x=1 → /api/vault/:id).
 *
 *   const reportingInterceptor: HttpInterceptorFn = (request, next) =>
 *     next(request).pipe(tap({ error: (error) => reportHttpErrorResponse(error, request) }));
 *
 * @param {unknown} response usually an HttpErrorResponse
 * @param {{ method?: string, url?: string } | null} [request] the HttpRequest
 * @returns {boolean} true when an event was queued
 */
export function reportHttpErrorResponse(response, request) {
  try {
    if (!isHttpErrorResponse(response)) {
      return false;
    }
    const httpError = /** @type {{ status: number, url?: string | null, headers?: unknown }} */ (
      response
    );
    return reportHttpError({
      method: request?.method,
      url: request?.url ?? httpError.url ?? undefined,
      status: httpError.status,
      requestId: readRequestId(httpError.headers),
      error: response,
    });
  } catch {
    return false;
  }
}

/**
 * Zone.js wraps unhandled rejections in an Error whose `rejection` holds the
 * original value; zoneless apps pass errors through unchanged.
 *
 * @param {unknown} error
 * @returns {unknown}
 */
function unwrapZoneRejection(error) {
  const rejection = /** @type {{ rejection?: unknown } | null} */ (error)?.rejection;
  return typeof error === 'object' &&
    error !== null &&
    rejection !== undefined &&
    rejection !== null
    ? rejection
    : error;
}

/**
 * @param {unknown} headers Angular HttpHeaders (case-insensitive get)
 * @returns {string | undefined}
 */
function readRequestId(headers) {
  const reader = /** @type {{ get?: (name: string) => string | null } | null | undefined} */ (
    headers
  );
  if (typeof reader?.get !== 'function') {
    return undefined;
  }
  for (const name of REQUEST_ID_HEADERS) {
    const value = reader.get(name);
    if (value) {
      return value;
    }
  }
  return undefined;
}
