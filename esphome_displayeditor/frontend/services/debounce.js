// @ts-check

/** Collapse a burst of requests into one call, `delay` ms after the last.
 *
 * Owns the timer, so the modules using it stay free of window and timer
 * access; tests pass their own `setTimer`/`clearTimer`.
 * @param {number} delay
 * @param {{setTimer?: (task: () => void, delay: number) => number,
 *   clearTimer?: (handle: number) => void}} [timers]
 */
export function createDebouncer(delay, {
  setTimer = window.setTimeout.bind(window),
  clearTimer = window.clearTimeout.bind(window),
} = {}) {
  /** @type {number | null} */
  let handle = null;

  function cancel() {
    if (handle !== null) clearTimer(handle);
    handle = null;
  }

  return {
    /** Run `task` after the delay, dropping a call still waiting.
     * @param {() => void} task */
    run(task) {
      cancel();
      handle = setTimer(() => {
        handle = null;
        task();
      }, delay);
    },
    cancel,
  };
}
