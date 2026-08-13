export function createActions(store) {
  return {
    patch(values) { return store.update((state) => Object.assign(state, values)); },
    set(key, value) { return store.update((state) => { state[key] = value; }); },
    mutate(mutator) { return store.update(mutator); },
  };
}
