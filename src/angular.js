/**
 * Angular adapter, without importing Angular (the app's own Angular version
 * is used, and this package stays build-free):
 *
 *   { provide: ErrorHandler, useClass: ReportingErrorHandler }
 *
 * plus reportHttpErrorResponse() for an HttpInterceptorFn. Angular's DI can
 * construct ReportingErrorHandler because its constructor declares no
 * required arguments; apps that need a hook construct it themselves:
 *
 *   { provide: ErrorHandler, useFactory: () => new ReportingErrorHandler({ beforeHandle }) }
 *
 * and bootstrapWithReporting() around bootstrapApplication(), so a failed
 * start is reported as critical.
 */

import { captureException, captureUncaughtError, reportHttpError } from './facade.js';

const ANGULAR_ERROR_HANDLER_MECHANISM = 'angular.ErrorHandler';

/** How a failure during bootstrapWithReporting() is reported. */
const BOOTSTRAP_CAPTURE_OPTIONS = Object.freeze({ action: 'bootstrap', severity: 'critical' });

/**
 * How many bootstrapWithReporting() calls are waiting for Angular. While one
 * is, ReportingErrorHandler reports with BOOTSTRAP_CAPTURE_OPTIONS.
 */
let pendingBootstraps = 0;

/**
 * Error objects a beforeHandle hook kept from being reported ("skip" or
 * "handled"), so bootstrapWithReporting() does not report them either.
 */
const errorsKeptFromReporting = new WeakSet();

/** Response headers that carry the backend's request id, first match wins. */
const REQUEST_ID_HEADERS = ['X-Request-Id', 'X-Correlation-Id'];

/**
 * What a beforeHandle hook decides about an error: "report" logs and
 * reports it (the default), "skip" only logs it, and "handled" means the
 * hook took care of it, so it is neither logged nor reported.
 *
 * @typedef {'report' | 'skip' | 'handled'} ErrorHandlingDecision
 */

const REPORT = 'report';
const SKIP = 'skip';
const HANDLED = 'handled';

/**
 * @typedef {object} ReportingErrorHandlerOptions
 * @property {(error: unknown) => unknown} [beforeHandle] runs first for every
 *   error, with a Zone.js promise rejection unwrapped; returns an
 *   ErrorHandlingDecision
 */

/**
 * Drop-in replacement for Angular's ErrorHandler: logs like the default
 * handler (console.error('ERROR', error)) and reports the error. With
 * provideBrowserGlobalErrorListeners() (zoneless apps) this also covers
 * uncaught errors and unhandled rejections, so installGlobalHandlers() is
 * not needed. An error object the app already passed to reportHttpError is
 * logged but not reported again.
 */
export class ReportingErrorHandler {
  /** @type {((error: unknown) => unknown) | undefined} */
  #beforeHandle;

  /**
   * The default value keeps the constructor's length at 0: Angular's DI
   * refuses an undecorated useClass whose constructor declares parameters.
   *
   * @param {ReportingErrorHandlerOptions | null} [options]
   */
  constructor(options = {}) {
    const beforeHandle = options?.beforeHandle;
    this.#beforeHandle = typeof beforeHandle === 'function' ? beforeHandle : undefined;
  }

  /**
   * @param {unknown} error
   */
  handleError(error) {
    const unwrapped = unwrapZoneRejection(error);
    const decision = this.#decide(unwrapped);
    if (decision !== REPORT && typeof unwrapped === 'object' && unwrapped !== null) {
      errorsKeptFromReporting.add(unwrapped);
    }
    if (decision === HANDLED) {
      return;
    }
    try {
      globalThis.console?.error('ERROR', error);
    } catch {
      // A broken console must not stop the report.
    }
    if (decision === SKIP) {
      return;
    }
    if (isHttpErrorResponse(unwrapped)) {
      reportHttpErrorResponse(unwrapped);
      return;
    }
    const tags = { mechanism: ANGULAR_ERROR_HANDLER_MECHANISM };
    captureUncaughtError(
      unwrapped,
      pendingBootstraps > 0 ? { ...BOOTSTRAP_CAPTURE_OPTIONS, tags } : { tags },
    );
  }

  /**
   * Asks the beforeHandle hook. No hook, any other return value and a hook
   * that throws all mean "report": a broken hook must not lose errors.
   *
   * @param {unknown} error
   * @returns {ErrorHandlingDecision}
   */
  #decide(error) {
    if (!this.#beforeHandle) {
      return REPORT;
    }
    try {
      const decision = this.#beforeHandle(error);
      return decision === SKIP || decision === HANDLED ? decision : REPORT;
    } catch {
      return REPORT;
    }
  }
}

/**
 * Runs Angular's bootstrap so that a failed start is reported as critical:
 *
 *   bootstrapWithReporting(() => bootstrapApplication(App, appConfig))
 *     .catch((error) => console.error(error));
 *
 * Angular hands an app-initializer or root-component failure to the
 * ErrorHandler before the bootstrap promise rejects, so by the time a
 * .catch() runs the error has already been reported at the default
 * severity. While `bootstrap` runs, ReportingErrorHandler therefore reports
 * with action "bootstrap" and severity "critical". The rejection itself is
 * reported here as well, which covers failures thrown before the
 * ErrorHandler exists and HTTP 4xx failures the ErrorHandler only keeps as
 * breadcrumbs; one error object is still sent once, and an error a
 * beforeHandle hook skipped or handled is left alone. The returned promise
 * settles like the bootstrap's own.
 *
 * @template Result
 * @param {() => Result | PromiseLike<Result>} bootstrap
 * @returns {Promise<Result>}
 */
export async function bootstrapWithReporting(bootstrap) {
  pendingBootstraps += 1;
  try {
    return await bootstrap();
  } catch (error) {
    const unwrapped = unwrapZoneRejection(error);
    if (!errorsKeptFromReporting.has(/** @type {object} */ (unwrapped))) {
      captureException(unwrapped, BOOTSTRAP_CAPTURE_OPTIONS);
    }
    throw error;
  } finally {
    pendingBootstraps -= 1;
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
