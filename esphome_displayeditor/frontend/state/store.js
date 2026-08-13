import { freshProject } from "../project/model.js";

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

export function createStore(initialState = createInitialState()) {
  const listeners = new Set();
  return {
    state: initialState,
    subscribe(listener, selector = (state) => state) {
      const subscription = { listener, selector, value: selector(initialState) };
      listeners.add(subscription);
      return () => listeners.delete(subscription);
    },
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
