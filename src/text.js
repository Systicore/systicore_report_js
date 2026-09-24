/**
 * String helpers shared by the event builder: size caps that never split a
 * character, and removal of URL query strings and fragments, which is where
 * tokens, e-mail addresses and search terms usually hide.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes UTF-8 needs at most for one UTF-16 code unit. */
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes on a character boundary.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateBytes(text, maxBytes) {
  if (text.length * MAX_UTF8_BYTES_PER_CODE_UNIT <= maxBytes) {
    return text;
  }
  // Every UTF-16 code unit takes at least one byte, so the cut falls inside
  // the first maxBytes + 1 units; a huge text is never encoded as a whole.
  const bytes = encoder.encode(text.length > maxBytes ? text.slice(0, maxBytes + 1) : text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  // A continuation byte (10xxxxxx) at the cut means a character straddles it.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
}

/**
 * Cuts `text` to at most `maxCharacters` Unicode code points.
 *
 * @param {string} text
 * @param {number} maxCharacters
 * @returns {string}
 */
export function truncateCharacters(text, maxCharacters) {
  if (text.length <= maxCharacters) {
    return text;
  }
  let result = '';
  let count = 0;
  for (const character of text) {
    if (count === maxCharacters) {
      break;
    }
    result += character;
    count += 1;
  }
  return result;
}

/**
 * Byte length of `text` once encoded as UTF-8.
 *
 * @param {string} text
 * @returns {number}
 */
export function utf8ByteLength(text) {
  return encoder.encode(text).length;
}

/**
 * Drops the query string and the fragment of one URL (absolute or relative).
 *
 * @param {string} url
 * @returns {string}
 */
export function stripUrlQuery(url) {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * An http(s) URL inside free text: everything up to the next whitespace,
 * quote or bracket. The pattern has nothing to backtrack into, so a scan
 * stays linear even over long runs of URL-like text.
 */
const ABSOLUTE_URL_IN_TEXT = /\bhttps?:\/\/[^\s?#"'`<>()[\]{}][^\s"'`<>()[\]{}]*/g;

/**
 * A root-relative path inside free text ("GET /api/items?page=2 failed"),
 * after the start of the text, whitespace, a quote, a bracket, "=" or ",".
 * The first capture is that boundary, which is kept.
 */
const RELATIVE_URL_IN_TEXT = /(^|[\s"'`<>()[\]{}=,])(\/[\w.~%-][^\s"'`<>()[\]{}]*)/g;

/**
 * What stays after a removed query: a stack frame's `:line:column`, so
 * `app.js?v=3:10:5` keeps `:10:5`, or a colon that ends the URL
 * ("…/items?page=2: 500 Internal Server Error" in Angular's HTTP messages).
 */
const POSITION_AFTER_QUERY = /(?::\d+){0,2}:?$/;

/**
 * Removes query strings and fragments from every http(s) URL and every
 * root-relative path in `text` (messages, stack traces, breadcrumbs, tags).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripUrlQueriesInText(text) {
  return text
    .replace(ABSOLUTE_URL_IN_TEXT, stripQueryKeepingPosition)
    .replace(
      RELATIVE_URL_IN_TEXT,
      (_match, boundary, path) => `${boundary}${stripQueryKeepingPosition(path)}`,
    );
}

/**
 * @param {string} url one URL or path, without surrounding text
 * @returns {string} the URL without its query and fragment, but with a
 *   trailing stack-frame position or colon
 */
function stripQueryKeepingPosition(url) {
  const queryStart = url.search(/[?#]/);
  if (queryStart === -1) {
    return url;
  }
  const query = url.slice(queryStart);
  const position = POSITION_AFTER_QUERY.exec(query)?.[0] ?? '';
  return url.slice(0, queryStart) + position;
}

/**
 * Returns `value` as a trimmed string, or undefined for null, undefined and
 * blank values.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function toOptionalText(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  return text === '' ? undefined : text;
}
