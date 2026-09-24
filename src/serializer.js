/**
 * Serializes an ingest event to a request body that fits MAX_BODY_BYTES.
 *
 * Every field is already capped, but twenty 200-character breadcrumbs of
 * multi-byte text, a 32 KB trace and JSON escaping can still add up to more
 * than the server's 64 KiB limit (413, which would drop the report). Instead,
 * the least valuable parts go first: breadcrumbs, then most of the trace, then
 * most of the message.
 */

import { MAX_BODY_BYTES } from './limits.js';
import { truncateBytes, utf8ByteLength } from './text.js';

const REDUCED_TRACE_BYTES = 8 * 1024;
const MINIMAL_TRACE_BYTES = 2 * 1024;
const MINIMAL_MESSAGE_BYTES = 2 * 1024;

/** @typedef {import('./event-builder.js').IngestEvent} IngestEvent */

/** @type {ReadonlyArray<(event: IngestEvent) => IngestEvent>} */
const REDUCTIONS = [
  (event) => event,
  (event) => withoutBreadcrumbs(event),
  (event) => withShortenedError(withoutBreadcrumbs(event), REDUCED_TRACE_BYTES, undefined),
  (event) =>
    withShortenedError(withoutBreadcrumbs(event), MINIMAL_TRACE_BYTES, MINIMAL_MESSAGE_BYTES),
  (event) => ({
    error: withShortenedError(event, 0, MINIMAL_MESSAGE_BYTES).error,
    release: event.release,
    environment: event.environment,
    platform: event.platform,
  }),
];

/**
 * @param {IngestEvent} event
 * @param {number} [maxBytes]
 * @returns {string | null} null only if even the bare error does not fit
 */
export function serializeEvent(event, maxBytes = MAX_BODY_BYTES) {
  for (const reduce of REDUCTIONS) {
    const body = JSON.stringify(reduce(event));
    if (utf8ByteLength(body) <= maxBytes) {
      return body;
    }
  }
  return null;
}

/**
 * @param {IngestEvent} event
 * @returns {IngestEvent}
 */
function withoutBreadcrumbs(event) {
  if (!event.context?.breadcrumbs) {
    return event;
  }
  const { breadcrumbs, ...context } = event.context;
  return { ...event, context };
}

/**
 * @param {IngestEvent} event
 * @param {number} traceBytes 0 removes the trace
 * @param {number | undefined} messageBytes undefined keeps the message
 * @returns {IngestEvent}
 */
function withShortenedError(event, traceBytes, messageBytes) {
  const error = { ...event.error };
  if (error.trace !== undefined) {
    error.trace = traceBytes > 0 ? truncateBytes(error.trace, traceBytes) : undefined;
  }
  if (error.message !== undefined && messageBytes !== undefined) {
    error.message = truncateBytes(error.message, messageBytes);
  }
  return { ...event, error };
}
