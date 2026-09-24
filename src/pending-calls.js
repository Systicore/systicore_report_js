/**
 * Calls made before init(): an error during module evaluation or early
 * bootstrap would otherwise be lost. They are replayed in order once init()
 * has decided whether reporting is on; beyond the capacity new calls are
 * dropped, so the first (usually root-cause) errors are kept.
 */

export const PENDING_CALL_CAPACITY = 30;

/**
 * @template Target
 */
export class PendingCalls {
  /** @type {Array<(target: Target) => unknown>} */
  #calls = [];
  #capacity;

  /**
   * @param {number} [capacity]
   */
  constructor(capacity = PENDING_CALL_CAPACITY) {
    this.#capacity = capacity;
  }

  /**
   * @param {(target: Target) => unknown} call
   */
  add(call) {
    if (this.#calls.length < this.#capacity) {
      this.#calls.push(call);
    }
  }

  /**
   * Runs and forgets every pending call.
   *
   * @param {Target} target
   */
  replay(target) {
    const calls = this.#calls;
    this.#calls = [];
    for (const call of calls) {
      try {
        call(target);
      } catch {
        // One failing call must not cost the others.
      }
    }
  }
}
