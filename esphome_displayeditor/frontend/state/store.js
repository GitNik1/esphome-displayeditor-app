// @ts-check

import { freshProject } from "../project/model.js";

/**
 * @template T
 * @typedef {{
 *   state: T,
 *   subscribe: <S>(listener: (value: S, previous: S, state: T) => void,
 *     selector: (state: T) => S) => () => boolean,
 *   update: (mutator: (state: T) => void) => T,
 * }} Store
 */

export function createInitialState() {
  return {
    system: null,
    capabilities: {},
    schemas: [],
    selectedWidget: null,
    activeConfig: null,
    activeRevision: null,
    configurations: [],
    hasDraft: false,
    yamlLoadedContent: "",
    yamlDirty: false,
    project: freshProject(),
    activeSurface: "root",
    projectName: null,
    projectRevision: null,
    projectDirty: false,
    undo: [],
    redo: [],
    zoom: 1,
    backgroundPreview: null,
    gridCellProperties: [],
    states: [],
    activeState: "",
    themeType: "",
    themeState: "",
    editingColorId: null,
    editingFontId: null,
    devices: [],
    selectedDevice: null,
    editingDevice: null,
    deviceSocket: null,
    deviceStates: [],
    viewerBindings: [],
    viewerBindingsRevision: null,
    viewerRuntimeSources: { devices: [] },
    viewerRuntimeSocket: null,
    viewerRuntimeReconnect: null,
    viewerRuntimeActive: false,
    designerRuntimePreview: false,
    copiedRuntimeBinding: null,
    runtimeStatusTimer: null,
    builderJobs: {},
    builderSocket: null,
    builderRequestKeys: {},
    builderRequestsRunning: new Set(),
    canvasMode: "widgets",
    lineTool: "select",
    selectedStroke: null,
    drawingPoints: null,
    colorWheelTarget: "line",
    flowPreviewTimer: null,
    flowPreviewStart: 0,
  };
}

/**
 * @template T
 * @param {T} initialState
 * @returns {Store<T>}
 */
export function createStore(initialState = /** @type {T} */ (createInitialState())) {
  /** @type {Set<{listener: Function, selector: Function, value: unknown}>} */
  const listeners = new Set();
  return {
    state: initialState,
    /** @template S @param {(value: S, previous: S, state: T) => void} listener
     * @param {(state: T) => S} selector */
    subscribe(listener, selector) {
      const subscription = { listener, selector, value: selector(initialState) };
      listeners.add(subscription);
      return () => listeners.delete(subscription);
    },
    /** @param {(state: T) => void} mutator */
    update(mutator) {
      mutator(initialState);
      listeners.forEach((subscription) => {
        const value = subscription.selector(initialState);
        if (Object.is(value, subscription.value)) return;
        const previous = subscription.value;
        subscription.value = value;
        subscription.listener(value, previous, initialState);
      });
      return initialState;
    },
  };
}
