/**
 * Validates the init() options. Anything missing or unsafe turns reporting
 * off instead of failing: a bad REPORTS_* value must never break the app.
 */

import { DEFAULT_RATE_LIMIT_PER_MINUTE } from './throttle.js';
import { toOptionalText } from './text.js';

export const DEFAULT_MAX_QUEUE = 30;
const MAX_QUEUE_UPPER_BOUND = 500;
const RATE_LIMIT_UPPER_BOUND = 600;
/** A public ingest key of contract v1.1: scpk_, the key's environment, 32 base62 characters. */
const PUBLIC_KEY_PATTERN = /^scpk_(?:live|test)_[0-9A-Za-z]{32}$/;
const SECRET_KEY_PREFIX = 'scsk_';
/** Key types before contract v1.1, retired because sk_ matches Stripe's secret-key pattern. */
const RETIRED_KEY_PREFIXES = ['pk_', 'sk_'];

/** String spellings of "on" that runtime configs (env.js, import.meta.env) produce. */
const ENABLED_WORDS = new Set(['true', '1', 'yes', 'on']);

/**
 * @typedef {object} Configuration
 * @property {string} url base URL without trailing slash
 * @property {string} key the public scpk_ key
 * @property {string | undefined} source
 * @property {string | undefined} environment
 * @property {{ version?: string, commit?: string, buildTime?: string }} release
 * @property {(() => unknown) | undefined} userProvider
 * @property {(() => unknown) | undefined} routeProvider
 * @property {((event: import('./event-builder.js').IngestEvent) => unknown) | undefined} beforeSend
 * @property {number} maxQueue
 * @property {number} rateLimitPerMinute
 * @property {boolean} useIndexedDbQueue
 * @property {boolean} debug
 */

/**
 * @typedef {{ configuration: Configuration, disabledReason?: undefined } | { configuration?: undefined, disabledReason: string }} ConfigurationResult
 */

/**
 * @param {unknown} options the object passed to init()
 * @returns {ConfigurationResult}
 */
export function resolveConfiguration(options) {
  if (typeof options !== 'object' || options === null) {
    return { disabledReason: 'init() was called without an options object' };
  }
  const settings = /** @type {Record<string, any>} */ (options);
  if (!isEnabledFlag(settings.enabled)) {
    return { disabledReason: 'reporting is disabled (REPORTS_ENABLED is not true)' };
  }
  const url = toOptionalText(settings.url)?.replace(/\/+$/, '');
  const key = toOptionalText(settings.key);
  if (!url || !key) {
    return { disabledReason: 'REPORTS_URL or REPORTS_KEY is empty' };
  }
  if (!/^https?:\/\/[^/]/i.test(url)) {
    return { disabledReason: 'REPORTS_URL must be an absolute http(s) URL' };
  }
  const keyRejection = describeKeyRejection(key);
  if (keyRejection) {
    return { disabledReason: keyRejection };
  }
  return {
    configuration: {
      url,
      key,
      source: toOptionalText(settings.source),
      environment: toOptionalText(settings.environment),
      release: resolveRelease(settings.release),
      userProvider: functionOrUndefined(settings.userProvider),
      routeProvider: functionOrUndefined(settings.routeProvider),
      beforeSend: functionOrUndefined(settings.beforeSend),
      maxQueue: boundedInteger(settings.maxQueue, DEFAULT_MAX_QUEUE, MAX_QUEUE_UPPER_BOUND),
      rateLimitPerMinute: boundedInteger(
        settings.rateLimitPerMinute,
        DEFAULT_RATE_LIMIT_PER_MINUTE,
        RATE_LIMIT_UPPER_BOUND,
      ),
      useIndexedDbQueue: settings.useIndexedDbQueue === true,
      debug: settings.debug === true,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEnabledFlag(value) {
  if (value === true) {
    return true;
  }
  return typeof value === 'string' && ENABLED_WORDS.has(value.trim().toLowerCase());
}

/**
 * Only a public scpk_ key may ship to a browser: secret keys belong to
 * backends, and contract v1.1 retired the pk_/sk_ spelling.
 *
 * @param {string} key the trimmed REPORTS_KEY
 * @returns {string | undefined} why the key is refused, or undefined for a public key
 */
function describeKeyRejection(key) {
  if (PUBLIC_KEY_PATTERN.test(key)) {
    return undefined;
  }
  if (key.startsWith(SECRET_KEY_PREFIX)) {
    return 'REPORTS_KEY is a secret scsk_ key; it must never ship to a browser';
  }
  if (RETIRED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return 'REPORTS_KEY uses the retired pk_/sk_ format; create a public scpk_ key';
  }
  return 'REPORTS_KEY must be scpk_live_ or scpk_test_ followed by 32 base62 characters';
}

/**
 * @param {unknown} release
 * @returns {{ version?: string, commit?: string, buildTime?: string }}
 */
function resolveRelease(release) {
  if (typeof release !== 'object' || release === null) {
    return {};
  }
  const fields = /** @type {Record<string, unknown>} */ (release);
  return {
    version: toOptionalText(fields.version),
    commit: toOptionalText(fields.commit),
    buildTime: toOptionalText(fields.buildTime),
  };
}

/**
 * @template {Function} T
 * @param {T | unknown} value
 * @returns {T | undefined}
 */
function functionOrUndefined(value) {
  return typeof value === 'function' ? /** @type {T} */ (value) : undefined;
}

/**
 * @param {unknown} value
 * @param {number} fallback used for missing, non-integer or non-positive values
 * @param {number} upperBound
 * @returns {number}
 */
function boundedInteger(value, fallback, upperBound) {
  const number = Number(value);
  if (value === undefined || value === null || !Number.isInteger(number) || number < 1) {
    return fallback;
  }
  return Math.min(number, upperBound);
}
