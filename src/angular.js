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
 * and bootstrapWithReporting() around bootstrapApplication(), so the error
 * that stops the start is reported as critical.
 */

import { captureStartupFailure, captureUncaughtError, reportHttpError } from './facade.js';
import { StartupHold } from './startup-hold.js';

const ANGULAR_ERROR_HANDLER_MECHANISM = 'angular.ErrorHandler';

/** How the error that stops bootstrapWithReporting()'s bootstrap is reported. */
const BOOTSTRAP_CAPTURE_OPTIONS = Object.freeze({ action: 'bootstrap', severity: 'critical' });

/**
 * The errors ReportingErrorHandler meets while a bootstrapWithReporting()
 * call waits for Angular, held until it is known which one stopped the start.
 */
const startupHold = new StartupHold();

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
 * logged but not reported again. While bootstrapWithReporting() waits for
 * Angular, reports are held until it is known which error stopped the start.
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
    startupHold.reportOrHold(unwrapped, () =>
      captureUncaughtError(unwrapped, { tags: errorHandlerTags() }),
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
 * Runs Angular's bootstrap so that the error that stops the start is
 * reported as critical, with action "bootstrap":
 *
 *   bootstrapWithReporting(() => bootstrapApplication(App, appConfig))
 *     .catch((error) => console.error(error));
 *
 * Angular hands an app-initializer or root-component failure to the
 * ErrorHandler a few microtasks before the bootstrap promise rejects with
 * it, and one error object is sent once, so a .catch() that captures it
 * comes too late. While `bootstrap` runs, ReportingErrorHandler therefore
 * holds the errors it would report, until the bootstrap settles (at most
 * 1 s each, see StartupHold). The one the bootstrap rejects with is
 * reported as critical; the others keep their usual severity. The rejection
 * is reported even when the ErrorHandler never saw it (an environment
 * initializer fails before the ErrorHandler exists).
 *
 * HTTP failures follow the HTTP layer: one it reported (>= 500, or a network
 * failure while online) keeps its HTTP event, a network failure while
 * offline stays unreported, and any other status (a 4xx) that stops the
 * start is reported as critical. An error a beforeHandle hook skipped or
 * handled is left alone. The returned promise settles like the bootstrap's
 * own.
 *
 * @template Result
 * @param {() => Result | PromiseLike<Result>} bootstrap
 * @returns {Promise<Result>}
 */
export async function bootstrapWithReporting(bootstrap) {
  startupHold.begin();
  try {
    return await bootstrap();
  } catch (error) {
    reportBootstrapFailure(unwrapZoneRejection(error));
    throw error;
  } finally {
    startupHold.end();
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
 * @param {unknown} failure what the bootstrap rejected with, unwrapped
 */
function reportBootstrapFailure(failure) {
  const seenByErrorHandler = startupHold.claim(failure);
  if (errorsKeptFromReporting.has(/** @type {object} */ (failure))) {
    return;
  }
  if (isHttpErrorResponse(failure)) {
    // Let the HTTP layer judge it first, as ReportingErrorHandler does; a
    // no-op when the interceptor or the ErrorHandler already did.
    reportHttpErrorResponse(failure);
  }
  captureStartupFailure(
    failure,
    seenByErrorHandler
      ? { ...BOOTSTRAP_CAPTURE_OPTIONS, tags: errorHandlerTags() }
      : BOOTSTRAP_CAPTURE_OPTIONS,
  );
}

/**
 * @returns {Record<string, string>} the tags of a report from ReportingErrorHandler
 */
function errorHandlerTags() {
  return { mechanism: ANGULAR_ERROR_HANDLER_MECHANISM };
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
