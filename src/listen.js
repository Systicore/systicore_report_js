/**
 * Adds an event listener and returns the function that removes it. A missing
 * target (no window during server-side rendering) yields a no-op remover.
 *
 * @param {import('./runtime.js').ListenerTarget | undefined} target
 * @param {string} type
 * @param {(event: unknown) => void} listener
 * @returns {() => void}
 */
export function listen(target, type, listener) {
  if (!target) {
    return () => {};
  }
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}
