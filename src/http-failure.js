/**
 * Turns a failed HTTP call of the app into a report. Only server faults
 * (status >= 500) and network failures are reported; a 4xx is the client's
 * or the user's business and would drown the real errors.
 *
 * Every HTTP failure of one endpoint forms one group: the message and the
 * action carry the method and the path template, never the concrete URL
 * (no tag carries it either), and no stack trace is sent (frames of the app's HTTP wrapper would group
 * all endpoints together, and hashed bundle names would split every release).
 */

import { stripUrlQuery, toOptionalText } from './text.js';

export const HTTP_ERROR_TYPE = 'HttpError';
export const NETWORK_ERROR_TYPE = 'NetworkError';
export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';
export const HTTP_MECHANISM = 'http';

const FIRST_SERVER_ERROR_STATUS = 500;
const UNKNOWN_REQUEST_LABEL = 'HTTP request';
const IDENTIFIER_PLACEHOLDER = ':id';

/** Path segments that are identifiers rather than part of the route. */
const IDENTIFIER_SEGMENT_PATTERNS = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  /^(?=.*\d)[A-Za-z0-9_-]{20,}$/,
  /@|%40/i,
];

/**
 * @typedef {object} HttpFailureDetails
 * @property {string} [method] e.g. GET
 * @property {string} [urlTemplate] the route template, e.g. /api/vault/:id
 * @property {string} [url] the concrete URL, templated here when no urlTemplate is given
 * @property {number | null} [status] HTTP status; 0, null or undefined for a network failure
 * @property {string | null} [requestId]
 * @property {unknown} [error]
 */

/**
 * @typedef {object} HttpCall
 * @property {string} label "METHOD /path/template", or a placeholder
 * @property {number | undefined} status undefined for a network failure
 * @property {string | undefined} target the URL or template as given, query removed
 */

/**
 * @param {HttpFailureDetails} details
 * @returns {HttpCall}
 */
export function describeHttpCall(details) {
  const method = toOptionalText(details.method)?.toUpperCase();
  const urlTemplate = toOptionalText(details.urlTemplate);
  const url = toOptionalText(details.url);
  const template = urlTemplate ? pathOf(urlTemplate) : url ? toUrlTemplate(url) : undefined;
  const label = [method, template].filter(Boolean).join(' ') || UNKNOWN_REQUEST_LABEL;
  const status =
    typeof details.status === 'number' && details.status > 0 ? details.status : undefined;
  const target = urlTemplate ?? url;
  return { label, status, target: target ? stripUrlQuery(target) : undefined };
}

/**
 * @param {HttpCall} call
 * @returns {boolean}
 */
export function isReportableHttpFailure(call) {
  return call.status === undefined || call.status >= FIRST_SERVER_ERROR_STATUS;
}

/**
 * @param {HttpCall} call
 * @param {HttpFailureDetails} details
 * @returns {import('./event-builder.js').Capture}
 */
export function captureOfHttpFailure(call, details) {
  const requestId = toOptionalText(details.requestId);
  if (call.status === undefined) {
    return {
      type: NETWORK_ERROR_TYPE,
      code: NETWORK_ERROR_CODE,
      message: `${call.label} failed: network error`,
      action: call.label,
      severity: 'warning',
      requestId,
      tags: { mechanism: HTTP_MECHANISM, 'http.error': errorNameOf(details.error) },
    };
  }
  return {
    type: HTTP_ERROR_TYPE,
    code: `HTTP_${call.status}`,
    message: `${call.label} failed with HTTP ${call.status}`,
    action: call.label,
    severity: 'error',
    requestId,
    tags: { mechanism: HTTP_MECHANISM, 'http.status': String(call.status) },
  };
}

/**
 * @param {HttpCall} call
 * @returns {string}
 */
export function breadcrumbOfHttpCall(call) {
  return `${call.label} → ${call.status ?? 'network error'}`;
}

/**
 * The path of a URL with identifier-like segments (numbers, UUIDs, long hex
 * or token strings, e-mail addresses) replaced by ":id", e.g.
 * https://api.example/api/vault/42?x=1 → /api/vault/:id.
 *
 * @param {string} url
 * @returns {string}
 */
export function toUrlTemplate(url) {
  return pathOf(url)
    .split('/')
    .map((segment) =>
      IDENTIFIER_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))
        ? IDENTIFIER_PLACEHOLDER
        : segment,
    )
    .join('/');
}

/**
 * @param {string} url
 * @returns {string} the path without scheme, host, query and fragment
 */
function pathOf(url) {
  const withoutQuery = stripUrlQuery(url.trim());
  const origin = /^[a-z][a-z\d+.-]*:\/\/[^/]*/i.exec(withoutQuery);
  const path = origin ? withoutQuery.slice(origin[0].length) : withoutQuery;
  return path === '' ? '/' : path;
}

/**
 * The class of a network failure (TypeError, AbortError, TimeoutError,
 * HttpErrorResponse), never its message: browsers and Angular put the
 * concrete request URL, relative ones with their query, into the message.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
function errorNameOf(error) {
  const name = /** @type {{ name?: unknown } | null | undefined} */ (error)?.name;
  return typeof name === 'string' ? toOptionalText(name) : undefined;
}
