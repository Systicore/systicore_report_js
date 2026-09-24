/**
 * Size limits of the ingest contract (POST /api/v1/ingest, contract §3).
 *
 * The server truncates rather than rejects, but the client applies the same
 * caps before sending: a trimmed field costs nothing to transmit, and the
 * whole body has to stay below the server's INGEST_BODY_LIMIT (64 KiB) and the
 * browser's 64 KiB budget for keepalive requests and beacons.
 */

/** Byte caps (UTF-8) of the error and context fields, as the server applies them. */
export const FIELD_BYTE_LIMITS = Object.freeze({
  type: 200,
  code: 100,
  message: 8 * 1024,
  trace: 32 * 1024,
  action: 200,
  route: 500,
  url: 500,
  requestId: 100,
});

/**
 * Byte cap for the string fields the contract leaves unbounded (release,
 * device, user, environment). They come from app configuration, so a cap only
 * matters for a misconfigured build, and it keeps the body size predictable.
 */
export const DEFAULT_FIELD_BYTE_LIMIT = 200;

export const MAX_TAGS = 10;
export const TAG_KEY_MAX_CHARACTERS = 32;
export const TAG_VALUE_MAX_CHARACTERS = 128;

export const MAX_BREADCRUMBS = 20;
export const BREADCRUMB_MESSAGE_MAX_CHARACTERS = 200;

/** Allowed shape of a client-supplied fingerprint override. */
export const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Upper bound of one serialized event. Below the server's 65536-byte body limit
 * with room to spare, and below the browsers' 64 KiB keepalive/beacon quota.
 */
export const MAX_BODY_BYTES = 60_000;
