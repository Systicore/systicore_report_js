/**
 * Listeners for errors nobody caught: window 'error' (uncaught exceptions)
 * and 'unhandledrejection' (rejected promises without a handler).
 *
 * Angular apps with provideBrowserGlobalErrorListeners() already route both
 * into their ErrorHandler; use ReportingErrorHandler there instead, or every
 * error is seen twice (the reporter would still send it only once).
 */

import { listen } from './listen.js';

export const WINDOW_ERROR_MECHANISM = 'window.error';
export const UNHANDLED_REJECTION_MECHANISM = 'window.unhandledrejection';

/**
 * Browsers replace errors from cross-origin scripts without CORS headers by
 * this bare message. It carries no stack, file or line, so it cannot be
 * grouped or fixed and is skipped.
 */
const OPAQUE_SCRIPT_ERROR_MESSAGE = 'Script error.';

/**
 * @param {import('./runtime.js').ListenerTarget | undefined} target the window
 * @param {(error: unknown, mechanism: string) => void} captureError
 * @returns {() => void} removes both listeners
 */
export function installWindowErrorHandlers(target, captureError) {
  const detachError = listen(target, 'error', (event) => {
    const error = errorOfErrorEvent(event);
    if (error !== undefined) {
      captureError(error, WINDOW_ERROR_MECHANISM);
    }
  });
  const detachRejection = listen(target, 'unhandledrejection', (event) => {
    captureError(/** @type {{ reason?: unknown }} */ (event).reason, UNHANDLED_REJECTION_MECHANISM);
  });
  return () => {
    detachError();
    detachRejection();
  };
}

/**
 * @typedef {object} ErrorEventLike the fields of a window ErrorEvent
 * @property {unknown} [error]
 * @property {unknown} [message]
 * @property {unknown} [filename]
 * @property {unknown} [lineno]
 * @property {unknown} [colno]
 */

/**
 * The thrown value of an ErrorEvent, or an error-shaped stand-in built from
 * its message and location when the browser did not expose the value.
 *
 * @param {unknown} event
 * @returns {unknown} undefined when there is nothing worth reporting
 */
function errorOfErrorEvent(event) {
  const errorEvent = /** @type {ErrorEventLike} */ (event);
  if (errorEvent.error !== undefined && errorEvent.error !== null) {
    return errorEvent.error;
  }
  const message = typeof errorEvent.message === 'string' ? errorEvent.message : '';
  const filename = typeof errorEvent.filename === 'string' ? errorEvent.filename : '';
  if (message === '' || (message === OPAQUE_SCRIPT_ERROR_MESSAGE && filename === '')) {
    return undefined;
  }
  return {
    name: 'Error',
    message,
    stack: filename
      ? `Error: ${message}\n    at ${filename}:${errorEvent.lineno ?? 0}:${errorEvent.colno ?? 0}`
      : undefined,
  };
}
