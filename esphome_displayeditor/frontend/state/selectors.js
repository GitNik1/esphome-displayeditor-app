// @ts-check

/** @typedef {{id: string, [key: string]: any}} Device */
/** @typedef {{
 * capabilities: Record<string, unknown>, activeConfig: string | null,
 * hasDraft: boolean, projectDirty: boolean, projectName: string | null,
 * projectRevision?: string | null, selectedDevice: string | null, devices: Device[],
 * }} SelectorState */

/** @param {string} name @returns {(state: SelectorState) => boolean} */
export const selectCapability = (name) => (state) => Boolean(state.capabilities[name]);
/** @param {SelectorState} state */
export const selectProjectIdentity = (state) => ({
  name: state.projectName,
  revision: state.projectRevision,
  dirty: state.projectDirty,
});
/** @param {SelectorState} state */
export const selectPublishedConfiguration = (state) => (
  Boolean(state.activeConfig) && !state.hasDraft
);
/** @param {SelectorState} state */
export const selectSelectedDevice = (state) => (
  state.devices.find((device) => device.id === state.selectedDevice) || null
);
/** @param {SelectorState} state */
export const selectDesignerStatus = (state) => (
  `${state.projectDirty ? "dirty" : "saved"}:${state.projectName || "local"}`
);
