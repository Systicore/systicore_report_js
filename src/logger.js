/**
 * The reporter's own diagnostics. Silent unless init({ debug: true }): an
 * error reporter that logs its own failures to the console would show up in
 * every app's console, and in apps that report console output, loop.
 */

const PREFIX = '[systicore/report]';

/**
 * @typedef {object} Logger
 * @property {(message: string, detail?: unknown) => void} warn
 */

/** @type {Logger} */
export const SILENT_LOGGER = Object.freeze({ warn: () => {} });

/**
 * @param {boolean} debug
 * @returns {Logger}
 */
export function createLogger(debug) {
  if (!debug) {
    return SILENT_LOGGER;
  }
  return {
    warn(message, detail) {
      try {
        if (detail === undefined) {
          globalThis.console?.warn(`${PREFIX} ${message}`);
        } else {
          globalThis.console?.warn(`${PREFIX} ${message}`, detail);
        }
      } catch {
        // A replaced or broken console must not break the reporter.
      }
    },
  };
}
