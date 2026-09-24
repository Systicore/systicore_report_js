/**
 * Angular adapter of @systicore/report. It imports nothing from Angular; the
 * types below describe the Angular objects structurally.
 */

/** The parts of Angular's HttpRequest the adapter reads. */
export interface HttpRequestLike {
  readonly method: string;
  readonly url: string;
}

/** The parts of Angular's HttpErrorResponse the adapter reads. */
export interface HttpErrorResponseLike {
  readonly name: 'HttpErrorResponse';
  readonly status: number;
  readonly url: string | null;
  readonly headers?: { get(name: string): string | null };
}

/**
 * Drop-in ErrorHandler: `{ provide: ErrorHandler, useClass: ReportingErrorHandler }`.
 * Logs like Angular's default handler and reports the error; an
 * HttpErrorResponse is reported only for status >= 500 or 0.
 */
export declare class ReportingErrorHandler {
  handleError(error: unknown): void;
}

/** True for Angular's HttpErrorResponse (checked by shape). */
export declare function isHttpErrorResponse(value: unknown): value is HttpErrorResponseLike;

/**
 * Reports an HttpErrorResponse when it is a server fault (>= 500) or a
 * network failure (status 0). Call it from an HttpInterceptorFn with the
 * request, so the report carries the method.
 * @returns true when an event was queued for delivery
 */
export declare function reportHttpErrorResponse(
  response: unknown,
  request?: HttpRequestLike | null,
): boolean;
