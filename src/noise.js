/**
 * Noise classification: tells a real defect from a failure the environment
 * caused (no network, a request the page itself cancelled, a blocked or
 * opaque cross-origin call, a timeout, a browser extension, a crawler).
 *
 * Every event carries its class as `error.classification`. Each class has an
 * action: "report" (as captured), "report_low" (severity lowered to
 * "warning", the lowest the ingest contract knows) or "drop" (not sent; the
 * reporter counts it and tells the onSuppressed hook). "defect" is always
 * reported as captured.
 */

import { listen } from './listen.js';
import { toOptionalText } from './text.js';

/** @typedef {'defect' | 'offline' | 'aborted' | 'network' | 'timeout' | 'extension' | 'bot'} Classification */
/** @typedef {'report' | 'report_low' | 'drop'} NoiseAction */

export const CLASSIFICATIONS = Object.freeze(
  /** @type {const} */ (['defect', 'offline', 'aborted', 'network', 'timeout', 'extension', 'bot']),
);
export const NOISE_ACTIONS = Object.freeze(/** @type {const} */ (['report', 'report_low', 'drop']));

/** @type {Readonly<Record<Exclude<Classification, 'defect'>, NoiseAction>>} */
export const DEFAULT_NOISE_POLICY = Object.freeze({
  offline: 'drop',
  aborted: 'drop',
  network: 'report_low',
  timeout: 'report_low',
  extension: 'report_low',
  bot: 'report_low',
});

/** The severity of a "report_low" event: the lowest the ingest contract accepts. */
export const LOW_SEVERITY = 'warning';

/**
 * How long a `beforeunload` counts as "the page is leaving". A navigation
 * the user cancelled (a "leave site?" dialog) must not turn later network
 * failures into dropped "aborted" ones.
 */
export const BEFORE_UNLOAD_WINDOW_MS = 10_000;

/** What fetch and XHR wrappers throw when the request never got an answer. */
const NETWORK_FAILURE_MESSAGES = [
  /^Failed to fetch(?: \(.*\))?$/i, // Chrome, Edge (newer ones add the host)
  /^Load failed$/i, // Safari
  /^NetworkError when attempting to fetch resource\.?$/i, // Firefox
  /^Network request failed$/i, // whatwg-fetch polyfill, React Native
  /^The network connection was lost\.?$/i, // Safari
  /^The Internet connection appears to be offline\.?$/i, // Safari
];

const ABORT_MESSAGES = [
  /^The (?:operation|user) (?:was )?aborted/i,
  /^The user aborted a request/i,
  /^signal is aborted/i,
  /^Fetch is aborted$/i, // Safari
  /^cancell?ed$/i, // Safari, for requests a navigation cancelled
  /^Request aborted$/i, // axios
];

const TIMEOUT_MESSAGES = [
  /\bETIMEDOUT\b/,
  /^timeout of \d+ms exceeded$/i,
  /^(?:The )?(?:request|operation|signal) timed out/i,
];

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ECONNABORTED', 'ESOCKETTIMEDOUT']);

const EXTENSION_FRAME = /\b(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;

const BOT_USER_AGENT =
  /bot\b|bot\/|crawler|crawling|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|prerender|phantomjs|puppeteer|playwright|selenium|webdriver|facebookexternalhit|embedly|bingpreview|python-requests|curl\/|wget\//i;

/**
 * @typedef {object} NoiseConfiguration
 * @property {boolean} enabled false: no classification, the 0.2 behaviour
 * @property {Record<Exclude<Classification, 'defect'>, NoiseAction>} policy
 * @property {((suppressed: SuppressedEvent) => void) | undefined} onSuppressed
 */

/**
 * @typedef {object} SuppressedEvent
 * @property {Classification} classification
 * @property {number} count how many events of this class were dropped so far
 * @property {string | undefined} message the message the event would have had
 * @property {string | undefined} action
 * @property {unknown} error the original error, when there was one
 */

/**
 * @param {unknown} option init({ noise }): false, or { enabled?, policy?, onSuppressed? }
 * @returns {NoiseConfiguration}
 */
export function resolveNoiseConfiguration(option) {
  const settings =
    typeof option === 'object' && option !== null
      ? /** @type {Record<string, any>} */ (option)
      : {};
  const policy = { ...DEFAULT_NOISE_POLICY };
  const overrides = settings.policy;
  if (typeof overrides === 'object' && overrides !== null) {
    for (const classification of /** @type {Array<keyof typeof policy>} */ (Object.keys(policy))) {
      const action = overrides[classification];
      if (NOISE_ACTIONS.includes(action)) {
        policy[classification] = action;
      }
    }
  }
  return {
    enabled: option !== false && settings.enabled !== false,
    policy,
    onSuppressed: typeof settings.onSuppressed === 'function' ? settings.onSuppressed : undefined,
  };
}

/**
 * @param {{ userAgent?: unknown, webdriver?: unknown } | undefined} navigator
 * @returns {boolean} true for crawlers, headless and automated browsers
 */
export function isBotNavigator(navigator) {
  if (navigator?.webdriver === true) {
    return true;
  }
  const userAgent = toOptionalText(navigator?.userAgent);
  return userAgent !== undefined && BOT_USER_AGENT.test(userAgent);
}

/**
 * @param {unknown} trace
 * @returns {boolean} true when a stack frame belongs to a browser extension
 */
export function hasExtensionFrame(trace) {
  return typeof trace === 'string' && EXTENSION_FRAME.test(trace);
}

/**
 * @typedef {object} NoiseSignals the state of the page when a failure is classified
 * @property {boolean} online navigator.onLine is not false
 * @property {boolean} leaving the page is being unloaded, navigated away from or hidden
 * @property {boolean} bot
 */

/**
 * @typedef {object} FailureInput
 * @property {unknown} [error] the thrown value or the failed call's error object
 * @property {unknown} [trace] the stack trace that will be sent
 * @property {boolean} [httpNetworkFailure] a reportHttpError call without an HTTP status
 */

/**
 * The class of one failure. First match wins: offline, aborted, timeout,
 * network, extension, bot, defect. A failed call that got an HTTP status
 * (a 5xx) is never offline, aborted, timeout or network.
 *
 * @param {FailureInput} input
 * @param {NoiseSignals} signals
 * @returns {Classification}
 */
export function classifyFailure(input, signals) {
  const kind = failureKindOf(input.error);
  const transportFailure = input.httpNetworkFailure === true || kind !== undefined;
  if (transportFailure && !signals.online) {
    return 'offline';
  }
  if (kind === 'aborted' || (transportFailure && kind !== 'timeout' && signals.leaving)) {
    return 'aborted';
  }
  if (kind === 'timeout') {
    return 'timeout';
  }
  if (transportFailure) {
    return 'network';
  }
  if (hasExtensionFrame(input.trace) || hasExtensionFrame(stackOf(input.error))) {
    return 'extension';
  }
  return signals.bot ? 'bot' : 'defect';
}

/**
 * Whether an error says the request never got an answer, and why. Looks at
 * the error, Angular's HttpErrorResponse.error (a ProgressEvent or the fetch
 * error) and one `cause`.
 *
 * @param {unknown} error
 * @returns {'aborted' | 'timeout' | 'network' | undefined}
 */
export function failureKindOf(error) {
  /** @type {'aborted' | 'timeout' | 'network' | undefined} */
  let found;
  for (const candidate of candidatesOf(error)) {
    const kind = ownFailureKindOf(candidate);
    if (kind === 'aborted' || kind === 'timeout') {
      return kind;
    }
    found ??= kind;
  }
  return found;
}

/**
 * @param {unknown} error
 * @returns {unknown[]}
 */
function candidatesOf(error) {
  if (typeof error !== 'object' || error === null) {
    return [error];
  }
  const record = /** @type {{ error?: unknown, cause?: unknown }} */ (error);
  return [error, record.error, record.cause].filter(
    (value) => value !== undefined && value !== null,
  );
}

/**
 * @param {unknown} value
 * @returns {'aborted' | 'timeout' | 'network' | undefined}
 */
function ownFailureKindOf(value) {
  if (typeof value === 'string') {
    return kindOfMessage(value);
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record =
    /** @type {{ name?: unknown, type?: unknown, code?: unknown, message?: unknown }} */ (value);
  if (record.name === 'AbortError') {
    return 'aborted';
  }
  if (
    record.name === 'TimeoutError' ||
    (typeof record.code === 'string' && TIMEOUT_CODES.has(record.code))
  ) {
    return 'timeout';
  }
  // A ProgressEvent from XMLHttpRequest, as Angular's HttpClient passes it.
  if (record.type === 'abort') {
    return 'aborted';
  }
  if (record.type === 'timeout') {
    return 'timeout';
  }
  return typeof record.message === 'string' ? kindOfMessage(record.message) : undefined;
}

/**
 * @param {string} message
 * @returns {'aborted' | 'timeout' | 'network' | undefined}
 */
function kindOfMessage(message) {
  const text = message.trim();
  if (ABORT_MESSAGES.some((pattern) => pattern.test(text))) {
    return 'aborted';
  }
  if (TIMEOUT_MESSAGES.some((pattern) => pattern.test(text))) {
    return 'timeout';
  }
  return NETWORK_FAILURE_MESSAGES.some((pattern) => pattern.test(text)) ? 'network' : undefined;
}

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function stackOf(error) {
  return typeof error === 'object' && error !== null
    ? /** @type {{ stack?: unknown }} */ (error).stack
    : undefined;
}

/**
 * Watches whether the page is leaving: `pagehide` until a `pageshow` (a
 * back/forward cache restore), a `beforeunload` for BEFORE_UNLOAD_WINDOW_MS,
 * and a hidden document. Requests the browser cancels then fail with status
 * 0, "Failed to fetch" or Safari's "Load failed"; they are not defects.
 */
export class PageLifecycle {
  #runtime;
  #hidden = false;
  /** @type {number | undefined} */
  #beforeUnloadAt;
  #detachers;

  /**
   * @param {import('./runtime.js').Runtime} runtime
   */
  constructor(runtime) {
    this.#runtime = runtime;
    const windowTarget = runtime.windowTarget;
    const documentTarget = runtime.documentTarget;
    this.#detachers = [
      listen(windowTarget, 'pagehide', () => {
        this.#hidden = true;
      }),
      listen(windowTarget, 'pageshow', () => {
        this.#hidden = false;
        this.#beforeUnloadAt = undefined;
      }),
      listen(windowTarget, 'beforeunload', () => {
        this.#beforeUnloadAt = runtime.now();
      }),
      listen(documentTarget, 'visibilitychange', () => {
        this.#hidden = documentTarget?.visibilityState === 'hidden';
      }),
    ];
  }

  /** @returns {boolean} */
  get leaving() {
    if (this.#hidden || this.#runtime.documentTarget?.visibilityState === 'hidden') {
      return true;
    }
    return (
      this.#beforeUnloadAt !== undefined &&
      this.#runtime.now() - this.#beforeUnloadAt < BEFORE_UNLOAD_WINDOW_MS
    );
  }

  dispose() {
    for (const detach of this.#detachers) {
      detach();
    }
  }
}
