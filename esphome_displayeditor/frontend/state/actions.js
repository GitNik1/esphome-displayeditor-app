// @ts-check

/** @template T @typedef {import("./store.js").Store<T>} Store */

/** @template {Record<string, any>} T @param {Store<T>} store */
export function createActions(store) {
  return {
    /** @param {Partial<T>} values */
    patch(values) { return store.update((state) => Object.assign(state, values)); },
    /** @param {keyof T} key @param {T[keyof T]} value */
    set(key, value) { return store.update((state) => { state[key] = value; }); },
    /** @param {(state: T) => void} mutator */
    mutate(mutator) { return store.update(mutator); },
  };
}
