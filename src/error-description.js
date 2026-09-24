/**
 * Turns whatever was thrown (an Error, a DOMException, a string, a plain
 * object, undefined) into the `type`, `message`, `trace` and `code` fields of
 * the ingest contract.
 */

/** How many `cause` links are followed into the trace. */
const MAX_CAUSE_DEPTH = 3;

/** Upper bound of the text produced for a thrown non-Error value. */
const MAX_DESCRIBED_VALUE_CHARACTERS = 1000;

/** Minified class names (`e`, `Xt`) say nothing about the error. */
const MIN_MEANINGFUL_CLASS_NAME_LENGTH = 3;

/** Type used for thrown values that are neither errors nor strings. */
export const NON_ERROR_TYPE = 'NonError';

/**
 * @typedef {object} ErrorDescription
 * @property {string} type
 * @property {string} message
 * @property {string} [trace]
 * @property {string} [code]
 */

/**
 * @param {unknown} value anything a `throw` or a promise rejection can carry
 * @returns {ErrorDescription}
 */
export function describeError(value) {
  if (isErrorLike(value)) {
    return {
      type: errorTypeOf(value),
      message: value.message,
      trace: traceOf(value),
      code: typeof value.code === 'string' ? value.code : undefined,
    };
  }
  if (typeof value === 'string') {
    return { type: 'Error', message: value };
  }
  return { type: NON_ERROR_TYPE, message: describeValue(value) };
}

/**
 * @typedef {{ message: string, name?: unknown, stack?: unknown, code?: unknown, cause?: unknown }} ErrorLike
 */

/**
 * True for Error instances and for error-shaped objects from other realms or
 * frameworks (anything with a string `message`).
 *
 * @param {unknown} value
 * @returns {value is ErrorLike}
 */
export function isErrorLike(value) {
  if (value instanceof Error) {
    return true;
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (/** @type {{ message?: unknown }} */ (value).message) === 'string'
  );
}

/**
 * The error class: `name` when it is more specific than "Error", otherwise a
 * readable constructor name (custom subclasses that do not set `name`).
 *
 * @param {ErrorLike} error
 * @returns {string}
 */
function errorTypeOf(error) {
  const name = typeof error.name === 'string' ? error.name : '';
  if (name !== '' && name !== 'Error') {
    return name;
  }
  const constructorName = error.constructor?.name;
  if (
    typeof constructorName === 'string' &&
    constructorName.length >= MIN_MEANINGFUL_CLASS_NAME_LENGTH &&
    constructorName !== 'Error' &&
    constructorName !== 'Object'
  ) {
    return constructorName;
  }
  return name || 'Error';
}

/**
 * The stack, followed by the stacks (or messages) of up to three causes.
 *
 * @param {ErrorLike} error
 * @returns {string | undefined}
 */
function traceOf(error) {
  const sections = [];
  const ownStack = typeof error.stack === 'string' ? error.stack : '';
  if (ownStack !== '') {
    sections.push(ownStack);
  }
  let cause = error.cause;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null;
    depth += 1
  ) {
    sections.push(`Caused by: ${describeCause(cause)}`);
    cause = isErrorLike(cause) ? cause.cause : undefined;
  }
  return sections.length === 0 ? undefined : sections.join('\n');
}

/**
 * @param {unknown} cause
 * @returns {string}
 */
function describeCause(cause) {
  if (isErrorLike(cause)) {
    if (typeof cause.stack === 'string' && cause.stack !== '') {
      return cause.stack;
    }
    return `${errorTypeOf(cause)}: ${cause.message}`;
  }
  return describeValue(cause);
}

/**
 * A short, never-throwing text form of an arbitrary value.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return String(value).slice(0, MAX_DESCRIBED_VALUE_CHARACTERS);
  }
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') {
      return json.slice(0, MAX_DESCRIBED_VALUE_CHARACTERS);
    }
  } catch {
    // Circular structures and BigInt values fall through to the tag below.
  }
  return Object.prototype.toString.call(value);
}
