/**
 * Builds the ingest body of contract §3 and enforces its limits.
 *
 * Two steps, so the app's beforeSend hook sits between them: assembleEvent
 * shapes one capture plus the reporter's scope into the contract layout, and
 * limitEvent (idempotent) scrubs URL queries, applies the size caps, drops
 * empty fields and rejects an event that has neither type, code nor message.
 */

import {
  BREADCRUMB_MESSAGE_MAX_CHARACTERS,
  DEFAULT_FIELD_BYTE_LIMIT,
  FIELD_BYTE_LIMITS,
  FINGERPRINT_PATTERN,
  MAX_BREADCRUMBS,
  MAX_TAGS,
  TAG_KEY_MAX_CHARACTERS,
  TAG_VALUE_MAX_CHARACTERS,
} from './limits.js';
import {
  stripUrlQueriesInText,
  stripUrlQuery,
  toOptionalText,
  truncateBytes,
  truncateCharacters,
} from './text.js';

export const SEVERITIES = Object.freeze(['warning', 'error', 'critical']);
export const DEFAULT_SEVERITY = 'error';
export const BREADCRUMB_CATEGORIES = Object.freeze(['http', 'nav', 'ui', 'log']);
export const PLATFORM = 'web';

/**
 * Free text is cut to this multiple of its cap before URL queries are
 * removed, so a huge message costs no more than a large one on the app's
 * error path. Removing queries only shortens the text.
 */
const SCRUB_INPUT_HEADROOM = 2;

/**
 * @typedef {object} Capture one reported error, before the scope is added
 * @property {unknown} [type]
 * @property {unknown} [code]
 * @property {unknown} [message]
 * @property {unknown} [trace]
 * @property {unknown} [action]
 * @property {unknown} [severity]
 * @property {unknown} [fingerprint]
 * @property {unknown} [route]
 * @property {unknown} [requestId]
 * @property {Record<string, unknown>} [tags]
 */

/**
 * @typedef {object} Scope what the reporter knows at capture time
 * @property {{ version?: string, commit?: string, buildTime?: string }} [release]
 * @property {string} [environment]
 * @property {import('./device.js').DeviceInfo} [device]
 * @property {{ id?: unknown, issuer?: unknown } | null} [user]
 * @property {unknown} [url]
 * @property {unknown} [route]
 * @property {ReadonlyArray<Breadcrumb>} [breadcrumbs]
 */

/**
 * @typedef {object} Breadcrumb
 * @property {string} ts RFC 3339 timestamp
 * @property {string} category one of BREADCRUMB_CATEGORIES
 * @property {string} message
 */

/**
 * @typedef {object} IngestError
 * @property {string} [type]
 * @property {string} [code]
 * @property {string} [message]
 * @property {string} [trace]
 * @property {string} [action]
 * @property {string} [severity]
 * @property {string} [fingerprint]
 */

/**
 * @typedef {object} IngestEvent
 * @property {IngestError} error
 * @property {{ version?: string, commit?: string, buildTime?: string }} [release]
 * @property {string} [environment]
 * @property {string} [platform]
 * @property {{ brand?: string, model?: string, osVersion?: string, apiLevel?: number, appVersion?: string, installId?: string }} [device]
 * @property {{ id: string, issuer?: string }} [user]
 * @property {{ route?: string, url?: string, requestId?: string, tags?: Record<string, string>, breadcrumbs?: Breadcrumb[] }} [context]
 */

/**
 * @param {Capture} capture
 * @param {Scope} scope
 * @returns {Record<string, any>} the contract layout, not yet limited
 */
export function assembleEvent(capture, scope) {
  return {
    error: {
      type: capture.type,
      code: capture.code,
      message: capture.message,
      trace: capture.trace,
      action: capture.action,
      severity: capture.severity,
      fingerprint: capture.fingerprint,
    },
    release: scope.release,
    environment: scope.environment,
    platform: PLATFORM,
    device: scope.device,
    user: scope.user ?? undefined,
    context: {
      route: capture.route ?? scope.route,
      url: scope.url,
      requestId: capture.requestId,
      tags: capture.tags,
      breadcrumbs: scope.breadcrumbs,
    },
  };
}

/**
 * Normalizes an event (from assembleEvent or from the app's beforeSend hook)
 * to the contract: every string capped, URL queries removed, empty fields
 * dropped. Returns null when the error has no type, code or message, which
 * the server would reject with 400.
 *
 * @param {unknown} candidate
 * @returns {IngestEvent | null}
 */
export function limitEvent(candidate) {
  if (!isRecord(candidate) || !isRecord(candidate.error)) {
    return null;
  }
  const error = limitError(candidate.error);
  if (!error.type && !error.code && !error.message) {
    return null;
  }
  return /** @type {IngestEvent} */ (
    compact({
      error,
      release: limitRelease(candidate.release),
      environment: capText(candidate.environment, DEFAULT_FIELD_BYTE_LIMIT),
      platform: capText(candidate.platform, DEFAULT_FIELD_BYTE_LIMIT),
      device: limitDevice(candidate.device),
      user: limitUser(candidate.user),
      context: limitContext(candidate.context),
    })
  );
}

/**
 * @param {Record<string, unknown>} error
 * @returns {IngestError}
 */
function limitError(error) {
  return compact({
    type: capText(error.type, FIELD_BYTE_LIMITS.type),
    code: capText(error.code, FIELD_BYTE_LIMITS.code),
    message: capScrubbedText(error.message, FIELD_BYTE_LIMITS.message),
    trace: capScrubbedText(error.trace, FIELD_BYTE_LIMITS.trace),
    action: capUrlLike(error.action, FIELD_BYTE_LIMITS.action),
    severity: normalizeSeverity(error.severity),
    fingerprint: normalizeFingerprint(error.fingerprint),
  });
}

/**
 * @param {unknown} release
 */
function limitRelease(release) {
  if (!isRecord(release)) {
    return undefined;
  }
  return compact({
    version: capText(release.version, DEFAULT_FIELD_BYTE_LIMIT),
    commit: capText(release.commit, DEFAULT_FIELD_BYTE_LIMIT),
    buildTime: capText(release.buildTime, DEFAULT_FIELD_BYTE_LIMIT),
  });
}

/**
 * @param {unknown} device
 */
function limitDevice(device) {
  if (!isRecord(device)) {
    return undefined;
  }
  const apiLevel = Number(device.apiLevel);
  return compact({
    brand: capText(device.brand, DEFAULT_FIELD_BYTE_LIMIT),
    model: capText(device.model, DEFAULT_FIELD_BYTE_LIMIT),
    osVersion: capText(device.osVersion, DEFAULT_FIELD_BYTE_LIMIT),
    apiLevel: Number.isInteger(apiLevel) && apiLevel > 0 ? apiLevel : undefined,
    appVersion: capText(device.appVersion, DEFAULT_FIELD_BYTE_LIMIT),
    installId: capText(device.installId, DEFAULT_FIELD_BYTE_LIMIT),
  });
}

/**
 * The contract's user id is a string; numeric ids from the app are converted.
 *
 * @param {unknown} user
 */
function limitUser(user) {
  if (!isRecord(user)) {
    return undefined;
  }
  const id = capText(user.id, DEFAULT_FIELD_BYTE_LIMIT);
  if (!id) {
    return undefined;
  }
  return compact({ id, issuer: capText(user.issuer, DEFAULT_FIELD_BYTE_LIMIT) });
}

/**
 * @param {unknown} context
 */
function limitContext(context) {
  if (!isRecord(context)) {
    return undefined;
  }
  return compact({
    route: capUrlLike(context.route, FIELD_BYTE_LIMITS.route),
    url: capUrlLike(context.url, FIELD_BYTE_LIMITS.url),
    requestId: capText(context.requestId, FIELD_BYTE_LIMITS.requestId),
    tags: limitTags(context.tags),
    breadcrumbs: limitBreadcrumbs(context.breadcrumbs),
  });
}

/**
 * At most 10 tags; keys up to 32 and values up to 128 characters, URL queries
 * removed. Tags with a null or undefined value are skipped rather than sent
 * as "null". Any key is kept as an own property, including "constructor" and
 * "__proto__".
 *
 * @param {unknown} tags
 * @returns {Record<string, string> | undefined}
 */
export function limitTags(tags) {
  if (!isRecord(tags)) {
    return undefined;
  }
  /** @type {Map<string, string>} */
  const limited = new Map();
  for (const [key, value] of Object.entries(tags)) {
    if (limited.size === MAX_TAGS) {
      break;
    }
    const limitedKey = truncateCharacters(key.trim(), TAG_KEY_MAX_CHARACTERS);
    const text = toOptionalText(value);
    if (limitedKey === '' || text === undefined || limited.has(limitedKey)) {
      continue;
    }
    limited.set(limitedKey, scrubWithinCharacters(text, TAG_VALUE_MAX_CHARACTERS));
  }
  return limited.size === 0 ? undefined : Object.fromEntries(limited);
}

/**
 * The newest 20 breadcrumbs with a known category and a message of at most
 * 200 characters.
 *
 * @param {unknown} breadcrumbs
 * @returns {Breadcrumb[] | undefined}
 */
function limitBreadcrumbs(breadcrumbs) {
  if (!Array.isArray(breadcrumbs)) {
    return undefined;
  }
  const limited = breadcrumbs
    .filter(isRecord)
    .map((breadcrumb) => ({
      ts: capText(breadcrumb.ts, DEFAULT_FIELD_BYTE_LIMIT),
      category: normalizeBreadcrumbCategory(breadcrumb.category),
      message: limitBreadcrumbMessage(breadcrumb.message),
    }))
    .filter(
      /** @returns {breadcrumb is Breadcrumb} */
      (breadcrumb) => Boolean(breadcrumb.ts && breadcrumb.message),
    )
    .slice(-MAX_BREADCRUMBS);
  return limited.length === 0 ? undefined : limited;
}

/**
 * @param {unknown} message
 * @returns {string | undefined}
 */
export function limitBreadcrumbMessage(message) {
  const text = toOptionalText(message);
  return text === undefined
    ? undefined
    : scrubWithinCharacters(text, BREADCRUMB_MESSAGE_MAX_CHARACTERS);
}

/**
 * @param {unknown} category
 * @returns {string}
 */
export function normalizeBreadcrumbCategory(category) {
  return typeof category === 'string' && BREADCRUMB_CATEGORIES.includes(category)
    ? category
    : 'log';
}

/**
 * Unknown severities become "error" (the server would answer 400).
 *
 * @param {unknown} severity
 * @returns {string}
 */
export function normalizeSeverity(severity) {
  const normalized = typeof severity === 'string' ? severity.trim().toLowerCase() : '';
  return SEVERITIES.includes(normalized) ? normalized : DEFAULT_SEVERITY;
}

/**
 * @param {unknown} fingerprint
 * @returns {string | undefined}
 */
function normalizeFingerprint(fingerprint) {
  const text = toOptionalText(fingerprint);
  return text !== undefined && FINGERPRINT_PATTERN.test(text) ? text : undefined;
}

/**
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string | undefined}
 */
function capText(value, maxBytes) {
  const text = toOptionalText(value);
  return text === undefined ? undefined : truncateBytes(text, maxBytes);
}

/**
 * For free text that may embed URLs (messages, traces).
 *
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string | undefined}
 */
function capScrubbedText(value, maxBytes) {
  const text = toOptionalText(value);
  if (text === undefined) {
    return undefined;
  }
  const bounded = truncateBytes(text, maxBytes * SCRUB_INPUT_HEADROOM);
  return truncateBytes(stripUrlQueriesInText(bounded), maxBytes);
}

/**
 * For short free text capped in characters (tag values, breadcrumbs).
 *
 * @param {string} text
 * @param {number} maxCharacters
 * @returns {string}
 */
function scrubWithinCharacters(text, maxCharacters) {
  const bounded = truncateCharacters(text, maxCharacters * SCRUB_INPUT_HEADROOM);
  return truncateCharacters(stripUrlQueriesInText(bounded), maxCharacters);
}

/**
 * For fields that are one URL or route (context.url, route, action).
 *
 * @param {unknown} value
 * @param {number} maxBytes
 * @returns {string | undefined}
 */
function capUrlLike(value, maxBytes) {
  const text = toOptionalText(value);
  if (text === undefined) {
    return undefined;
  }
  return toOptionalText(truncateBytes(stripUrlQuery(text), maxBytes));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies `record` without undefined values; returns undefined when nothing
 * is left, so empty blocks disappear from the body.
 *
 * @template {Record<string, unknown>} T
 * @param {T} record
 * @returns {T}
 */
function compact(record) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return /** @type {T} */ (Object.keys(result).length === 0 ? undefined : result);
}
