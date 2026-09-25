/**
 * Holds back the errors an app's error handler meets while the app is
 * starting, until it is known whether one of them stopped the start.
 *
 * Angular hands the error that stops its bootstrap to the ErrorHandler a few
 * microtasks before the bootstrap promise rejects with it. Reporting every
 * error met in between as the start's failure would escalate unrelated ones
 * (a third-party script error, a "ResizeObserver loop" error); reporting
 * them all at once, as usual, would leave the real failure at the default
 * severity and drop the rejection's own report as a duplicate. So each error
 * is held: the one the start rejects with is claimed and reported as the
 * start's failure, and the others are reported as usual once no start is
 * pending, or HOLD_LIMIT_MILLISECONDS after they were met, whichever comes
 * first. A start that never settles therefore delays errors briefly and
 * escalates none.
 */

/**
 * Far longer than the microtasks between Angular's ErrorHandler call and the
 * rejection, and short enough that an error that has nothing to do with the
 * start is not held for long.
 */
export const HOLD_LIMIT_MILLISECONDS = 1000;

/**
 * @typedef {object} Timers
 * @property {(callback: () => void, delay: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/**
 * @typedef {object} HeldError
 * @property {unknown} error
 * @property {() => void} report reports the error the usual way
 * @property {unknown} timer
 */

export class StartupHold {
  #timers;
  #pendingStarts = 0;
  /** @type {HeldError[]} */
  #heldErrors = [];

  /**
   * @param {Timers} [timers] the page's timers by default
   */
  constructor(timers = pageTimers()) {
    this.#timers = timers;
  }

  /** Marks a start as begun. Pair every call with end(). */
  begin() {
    this.#pendingStarts += 1;
  }

  /**
   * Marks a start as over. Once no start is pending, every held error is
   * reported as usual, in the order it was met.
   */
  end() {
    this.#pendingStarts = Math.max(0, this.#pendingStarts - 1);
    if (this.#pendingStarts > 0) {
      return;
    }
    for (const heldError of [...this.#heldErrors]) {
      this.#release(heldError);
    }
  }

  /**
   * Runs `report` now, or, while a start is pending, holds it until the
   * start settles, `error` is claimed, or the hold limit passes.
   *
   * @param {unknown} error
   * @param {() => void} report reports `error` the usual way
   */
  reportOrHold(error, report) {
    if (this.#pendingStarts === 0) {
      report();
      return;
    }
    /** @type {HeldError} */
    const heldError = { error, report, timer: undefined };
    heldError.timer = this.#timers.setTimeout(
      () => this.#release(heldError),
      HOLD_LIMIT_MILLISECONDS,
    );
    this.#heldErrors.push(heldError);
  }

  /**
   * Takes `error` out of the hold without reporting it: the start failed
   * with it, and the caller reports it as the start's failure.
   *
   * @param {unknown} error
   * @returns {boolean} whether `error` was held
   */
  claim(error) {
    const claimed = this.#heldErrors.filter((heldError) => heldError.error === error);
    for (const heldError of claimed) {
      this.#forget(heldError);
    }
    return claimed.length > 0;
  }

  /**
   * @param {HeldError} heldError
   */
  #release(heldError) {
    if (!this.#forget(heldError)) {
      return;
    }
    try {
      heldError.report();
    } catch {
      // A failing report must not keep the other held errors back.
    }
  }

  /**
   * @param {HeldError} heldError
   * @returns {boolean} false when it was no longer held
   */
  #forget(heldError) {
    const index = this.#heldErrors.indexOf(heldError);
    if (index === -1) {
      return false;
    }
    this.#heldErrors.splice(index, 1);
    this.#timers.clearTimeout(heldError.timer);
    return true;
  }
}

/**
 * The page's timers, looked up at call time.
 *
 * @returns {Timers}
 */
function pageTimers() {
  return {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) => globalThis.clearTimeout(/** @type {number} */ (handle)),
  };
}
