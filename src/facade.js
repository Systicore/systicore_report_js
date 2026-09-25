/**
 * The page's one reporter, configured by init(). index.js re-exports the
 * public functions; the framework adapters import this module directly.
 *
 * Every function is safe to call at any time: before init() calls are
 * buffered, while disabled they are no-ops, and none of them ever throws into
 * the app. This is the package's only module-level reporter state.
 */

import { installWindowErrorHandlers } from './global-handlers.js';
import { PendingCalls } from './pending-calls.js';
import { DisabledReporter, createReporter } from './reporter.js';
import { detectRuntime } from './runtime.js';

/** @typedef {import('./reporter.js').Reporter} Reporter */
/** @typedef {import('./reporter.js').CaptureOptions} CaptureOptions */

/** @type {Reporter} */
let activeReporter = new DisabledReporter();
let initialized = false;
/** @type {PendingCalls<Reporter>} */
const pendingCalls = new PendingCalls();
/** @type {(() => void) | null} */
let uninstallGlobalHandlers = null;

/**
 * Configures reporting. Reporting stays off (every call a no-op) unless
 * `enabled` is true and both `url` and a public `key` are set. Calling init()
 * again replaces the previous configuration.
 *
 * @param {Record<string, unknown>} options see InitOptions in index.d.ts
 * @returns {boolean} whether reporting is on
 */
export function init(options) {
  try {
    activeReporter.dispose();
    activeReporter = createReporter(options);
  } catch {
    activeReporter = new DisabledReporter();
  }
  initialized = true;
  pendingCalls.replay(activeReporter);
  return activeReporter.enabled;
}

/** @returns {boolean} */
export function isEnabled() {
  return activeReporter.enabled;
}

/**
 * @param {unknown} error anything that was thrown or rejected
 * @param {CaptureOptions} [options]
 * @returns {boolean} true when the event was queued for delivery
 */
export function captureException(error, options) {
  return dispatch((reporter) => reporter.captureException(error, options));
}

/**
 * @param {string} message
 * @param {CaptureOptions} [options]
 * @returns {boolean}
 */
export function captureMessage(message, options) {
  return dispatch((reporter) => reporter.captureMessage(message, options));
}

/**
 * Reports a failed HTTP call of the app: status >= 500 or a network failure.
 * Anything else only becomes a breadcrumb.
 *
 * @param {import('./http-failure.js').HttpFailureDetails} details
 * @returns {boolean}
 */
export function reportHttpError(details) {
  return dispatch((reporter) => reporter.reportHttpError(details));
}

/**
 * @param {{ id: string | number, issuer?: string } | null} user
 */
export function setUser(user) {
  dispatch((reporter) => reporter.setUser(user));
}

/**
 * @param {{ category?: string, message: string } | string} breadcrumb
 */
export function addBreadcrumb(breadcrumb) {
  dispatch((reporter) => reporter.addBreadcrumb(breadcrumb));
}

/**
 * Sends what is queued now, as far as the network and the server allow.
 *
 * @returns {Promise<void>}
 */
export function flush() {
  return activeReporter.flush();
}

/**
 * Reports uncaught errors and unhandled promise rejections of the window.
 * Idempotent: a second call returns the same uninstall function.
 *
 * @returns {() => void} removes the listeners
 */
export function installGlobalHandlers() {
  if (uninstallGlobalHandlers) {
    return uninstallGlobalHandlers;
  }
  let removeListeners = () => {};
  try {
    removeListeners = installWindowErrorHandlers(detectRuntime().windowTarget, (error, mechanism) =>
      captureException(error, { tags: { mechanism } }),
    );
  } catch {
    // No usable window: nothing to listen to.
  }
  const uninstall = () => {
    if (uninstallGlobalHandlers === uninstall) {
      removeListeners();
      uninstallGlobalHandlers = null;
    }
  };
  uninstallGlobalHandlers = uninstall;
  return uninstall;
}

/**
 * Runs `call` on the reporter, or buffers it until init() when init() has
 * not run yet.
 *
 * @template Result
 * @param {(reporter: Reporter) => Result} call
 * @returns {Result | false}
 */
function dispatch(call) {
  if (!initialized) {
    pendingCalls.add(call);
    return false;
  }
  try {
    return call(activeReporter);
  } catch {
    return false;
  }
}
