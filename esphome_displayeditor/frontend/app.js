// @ts-check

import { computeLayout, contentOrigin, fontFamilyId, resolvedFontFamily } from "./layout.js";
import { createApiClient, encodedName } from "./api/client.js";
import { renderUnifiedDiff } from "./configurations/diff-view.js";
import { blobToBase64, uploadImageAsset } from "./api/assets.js";
import {
  actionIdsForEditor,
  actionObjectEntry,
  generatedActionCondition,
  normalizeActionColor,
  widgetSupportsValueCondition,
} from "./actions/model.js";
import { describeWidgetAction as describeAction } from "./actions/describe.js";
import { buildWidgetAction, wrapValueCondition } from "./actions/build.js";
import { buildFlowAction } from "./actions/flow.js";
import { nearestSegment } from "./glowline/geometry.js";
import { drawDocument, hasFlow } from "./glowline/renderer.js";
import { strokeBaseName } from "./glowline/baking-model.js";
import { bakeGlowStroke } from "./glowline/bake.js";
import { format565, hsvToRgb, quantizeImageData, rgb565to888, rgb888to565 } from "./glowline/rgb565.js";
import { MDI_CATALOG_VERSION, MDI_GLYPHS } from "./mdi-glyphs.js";
import {
  collectProjectWidgets,
  freshGlowStroke,
  freshProject,
  normalizeProjectSurfaces,
  projectWidgetEntries as collectActionTargets,
  uniqueProjectWidgetId as nextProjectWidgetId,
} from "./project/model.js";
import {
  cloneProject,
  pushHistory,
  redoHistory,
  undoHistory,
} from "./project/history.js";
import {
  resolveActiveSurface,
  surfaceEntries as entriesForProject,
  surfaceLayoutProject,
} from "./project/surfaces.js";
import { normalizeProjectName } from "./project/names.js";
import { buildImportPayload, summarizeImport } from "./project/import.js";
import {
  colorReferenceLocations as findColorReferences,
  normalizeLibraryHex,
  projectIdIsUsed as idIsUsedInProject,
} from "./project/colors.js";
import {
  fontReferenceLocations as findFontReferences,
  fontSourceMetadataMap as sourceMetadataForProject,
  formatGlyphCodepoint,
  glyphCodepoint,
  ingressAssetUrl,
  isMdiWebfontUrl,
  parseGlyphInput as parseGlyphs,
  uniqueGlyphs,
} from "./project/fonts.js";
import {
  cloneWidgetSubtree as cloneProjectWidgetSubtree,
  findParentContainerId,
  findWidgetLocation,
  removeWidget,
  replaceProjectWidgetReferences as replaceWidgetReferences,
} from "./project/widgets.js";
import {
  assignRuntimeBinding,
  bindingIsOrphan as isRuntimeBindingOrphan,
  canPasteRuntimeBinding,
  cleanRuntimeBindings,
  findRuntimeBinding,
  removeRuntimeBinding as withoutRuntimeBinding,
  runtimeStateFor,
  runtimeTargets as targetsForRuntime,
} from "./runtime/bindings.js";
import {
  bindingGraph,
  bindingsForWidget,
  compatibleEntities,
  defaultBindingId,
  deviceBindingTargets,
  removeDeviceBinding,
  upsertDeviceBinding,
} from "./bindings/device-bindings.js";
import { createStore } from "./state/store.js";
import { createActions } from "./state/actions.js";
import { selectCapability, selectDesignerStatus, selectSelectedDevice } from "./state/selectors.js";
import { createProjectsController } from "./controllers/projects-controller.js";
import { createDevicesController } from "./controllers/devices-controller.js";
import { createBuilderController } from "./controllers/builder-controller.js";
import { createJsonSocket } from "./services/websocket.js";
import {
  applyRuntimeEvent,
  deviceTableColumns,
  formatDeviceLogs as formatLogs,
  mergeDeviceState,
} from "./devices/model.js";
import {
  applyBuilderEvent,
  builderAvailability,
  builderRequest,
  replaceBuilderJobs,
  sortedBuilderJobs,
} from "./builder/model.js";
import { pointFromClient, snapAngle } from "./canvas/geometry.js";
import { applyWidgetLayout, configureCanvas, createCanvasLayers } from "./canvas/view.js";
import { dragPosition, resizeDimensions, translatePoints } from "./canvas/interactions.js";
import {
  LIST_KINDS,
  parseListValue,
  propertyInputValue,
  propertyTarget as resolvePropertyTarget,
  propertyValueClears,
} from "./properties/model.js";
import { createBasicPropertyControl } from "./properties/view.js";
import { renderViewerMeter } from "./viewer/widget-primitives.js";
import {
  cursorPosition,
  editorIsDirty,
  findMatch,
  lineNumbers,
} from "./configurations/editor-model.js";
import { applyStaticTranslations, getLanguage, setLanguage, t } from "./i18n/runtime.js";
import {
  ViewerController,
  describeViewerArc,
  effectiveViewerStyle,
  entityMatchesRuntimeTarget,
  formatRuntimeValue,
  resolveViewerColor,
  runtimeBindingHealth,
  runtimeBoolean,
  viewerBarGeometry,
  viewerGradientBackground,
  viewerTextAlign,
} from "./viewer/viewer.js";

/** Dynamic DOM boundary for the legacy HTML shell. @param {string} selector @returns {any} */
const $ = (selector) => document.querySelector(selector);
/** @param {string} selector @returns {any[]} */
const $$ = (selector) => [...document.querySelectorAll(selector)];

// Mirrors backend/designer_core/model.py's STATES_KEY - both sides need
// the exact same key name for a widget/theme's per-state style overrides.
const STATES_KEY = "states";

// Maps each widget to its live canvas DOM node, so a drag/resize can update
// descendant boxes (children, layout-dependent siblings) without recreating
// any node - recreating the dragged/resized node mid-gesture would drop its
// pointer capture.
/** @type {Map<any, HTMLElement>} */
const canvasNodeByWidget = new Map();

function syncCanvasLayout() {
  applyWidgetLayout(computeLayout(activeSurfaceProject()), canvasNodeByWidget);
}

const store = createStore();
/** The store accepts imported ESPHome extension fields beyond the core schema. @type {any} */
const state = store.state;
const actions = createActions(store);

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

/** @type {any} */
let viewer = null;

function ensureProjectSurfaces() {
  normalizeProjectSurfaces(state.project);
}

function surfaceEntries() {
  return entriesForProject(state.project, t);
}

function normaliseActiveSurface() {
  const resolved = resolveActiveSurface(state.project, state.activeSurface, t);
  state.activeSurface = resolved.key;
  return resolved.entry;
}

function activeSurfaceEntry() {
  return normaliseActiveSurface();
}

function activeWidgetRoots() {
  return activeSurfaceEntry().surface.widgets;
}

function activeSurfaceProject() {
  return surfaceLayoutProject(state.project, activeSurfaceEntry());
}

function allProjectWidgets() {
  return collectProjectWidgets(state.project);
}

function uniqueProjectWidgetId(/** @type {any} */ base) {
  // reserved_ids are ids used by hardware entities elsewhere in an imported
  // source config (binary_sensor:, button:, ...) - never modeled here, but
  // sharing ESPHome's one flat id() namespace with everything created here.
  return nextProjectWidgetId(state.project, base);
}

function selectSurface(/** @type {any} */ key) {
  if (!surfaceEntries().some((entry) => entry.key === key)) return;
  stopFlowPreview();
  state.activeSurface = key;
  state.selectedWidget = null;
  state.selectedStroke = null;
  state.drawingStroke = null;
  state.canvasMode = "widgets";
  renderDesigner();
}

const api = createApiClient();
const projectsController = createProjectsController(api);
const devicesController = createDevicesController(api);
const builderController = createBuilderController(api);
/** @type {any} */
let deviceEventsClient = null;
/** @type {any} */
let builderEventsClient = null;
/** @type {any} */
let viewerRuntimeClient = null;

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
/** @param {unknown} message @param {boolean} [error] */
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = String(message);
  node.className = error ? "show error" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = ""; }, 3500);
}

function bindLanguageSwitch() {
  const select = $("#language-select");
  select.value = getLanguage();
  select.addEventListener("change", () => {
    setLanguage(select.value);
    // Widget/property labels come from the backend (?language=), and most of
    // the app's own dynamic text is built once at render time - a full
    // reload is the simplest way to apply a language switch consistently
    // everywhere rather than re-running every render function by hand.
    location.reload();
  });
}

async function initialize() {
  applyStaticTranslations();
  bindLanguageSwitch();
  bindTabs();
  bindDesigner();
  bindConfigurations();
  bindDevices();
  try {
    const [health, system, capabilityData, schemaData] = await Promise.all([
      api("health"), api("system"), api("capabilities"), api(`designer/schemas?language=${getLanguage()}`),
    ]);
    actions.patch({
      system,
      capabilities: capabilityData.capabilities,
      schemas: schemaData.widgets,
      gridCellProperties: schemaData.grid_cell_properties || [],
      states: schemaData.states || [],
    });
    renderStateChoices();
    $("#health").classList.toggle("ok", health.status === "ok");
    $("#profile").textContent = `${system.access_level} · ${system.user.role} · ${system.user.display_name || system.user.name || "Ingress"}`;
    $("#system-json").textContent = JSON.stringify({ system, ...capabilityData }, null, 2);
    renderPalette();
    const initialLoads = [loadServerProjects(), loadDevices(), loadViewerRuntimeSources()];
    if (state.capabilities["configuration.list"]) initialLoads.push(loadConfigurations());
    else {
      $("#config-list").textContent = t("configs.filesystemDisabled");
      $("#refresh-configs").disabled = true;
    }
    await Promise.all(initialLoads);
    connectDeviceEvents();
    if (state.capabilities["firmware.compile"]) {
      await loadBuilderJobs();
      connectBuilderEvents();
    }
  } catch (/** @type {any} */ error) {
    $("#profile").textContent = t("app.tagline.unreachable");
    toast(error.message, true);
  }
  renderDesigner();
}

function bindTabs() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
    $$(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === tab.dataset.tab));
    if (tab.dataset.tab !== "designer") stopFlowPreview();
  }));
}

function bindDevices() {
  $("#refresh-devices").addEventListener("click", loadDevices);
  $("#add-device").addEventListener("click", () => openDeviceDialog());
  $("#edit-device").addEventListener("click", () => {
    const device = state.devices.find((/** @type {any} */ item) => item.id === state.selectedDevice);
    if (device) openDeviceDialog(device);
  });
  $("#remove-device").addEventListener("click", removeSelectedDevice);
  $("#reconnect-device").addEventListener("click", reconnectSelectedDevice);
  $("#close-device-dialog").addEventListener("click", () => $("#device-dialog").close());
  $("#device-form").addEventListener("submit", saveDevice);
  $$(".device-subtab").forEach((tab) => tab.addEventListener("click", () => {
    $$(".device-subtab").forEach((item) => item.classList.toggle("active", item === tab));
    $$(".device-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `device-${tab.dataset.devicePanel}`));
  }));
  // Phone layout only, mirrors #back-to-configs - a no-op above the
  // breakpoint where list and detail already show side by side.
  $("#back-to-devices").addEventListener("click", () => {
    $("#devices").classList.add("showing-list");
  });
}

/** @type {Record<string, string>} */
const DEVICE_STATUS = {
  configured: t("devices.status.configured"),
  connecting: t("devices.status.connecting"),
  ready: t("devices.status.ready"),
  disconnected: t("devices.status.disconnected"),
  auth_failed: t("devices.status.authFailed"),
  missing_key: t("devices.status.missingKey"),
  disabled: t("devices.status.disabled"),
};

async function loadDevices() {
  const list = $("#device-list");
  const canRead = selectCapability("device.info")(state);
  const canManage = selectCapability("device.manage")(state);
  $("#add-device").classList.toggle("hidden", !canManage);
  if (!canRead) {
    list.className = "device-list empty";
    list.textContent = t("devices.apiUnavailable");
    return;
  }
  try {
    state.devices = await devicesController.list();
    if (state.selectedDevice && !state.devices.some((/** @type {any} */ item) => item.id === state.selectedDevice)) {
      state.selectedDevice = null;
    }
    renderDeviceList();
    if (state.selectedDevice) await loadDeviceDetails(state.selectedDevice);
  } catch (/** @type {any} */ error) {
    list.className = "device-list empty";
    list.textContent = error.message;
  }
}

function renderDeviceList() {
  const list = $("#device-list");
  list.replaceChildren();
  list.className = "device-list";
  if (!state.devices.length) {
    list.classList.add("empty");
    list.textContent = t("devices.empty");
    resetDeviceDetails();
    return;
  }
  state.devices.forEach((/** @type {any} */ device) => {
    const button = document.createElement("button");
    button.className = "device-item";
    button.classList.toggle("active", device.id === state.selectedDevice);
    const dot = document.createElement("span");
    dot.className = `device-status-dot ${device.status || "configured"}`;
    const content = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = device.name;
    const details = document.createElement("small");
    details.textContent = `${DEVICE_STATUS[device.status] || device.status} · ${device.host}:${device.port}`;
    content.append(name, details);
    button.append(dot, content);
    button.addEventListener("click", async () => {
      state.selectedDevice = device.id;
      $("#devices").classList.remove("showing-list");
      renderDeviceList();
      await loadDeviceDetails(device.id);
    });
    list.append(button);
  });
}

function resetDeviceDetails() {
  $("#device-title").textContent = t("devices.noneSelected");
  $("#device-connection").textContent = "–";
  ["edit-device", "remove-device", "reconnect-device"].forEach((id) => { $(`#${id}`).disabled = true; });
  $("#device-info pre").textContent = t("devices.noData");
  $("#device-entities").replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: t("devices.noEntities") }));
  $("#device-states").replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: t("devices.noStates") }));
  $("#device-logs pre").textContent = t("devices.noLogs");
  state.deviceStates = [];
}

async function loadDeviceDetails(/** @type {any} */ deviceId) {
  const device = state.selectedDevice === deviceId
    ? selectSelectedDevice(state)
    : state.devices.find((/** @type {any} */ item) => item.id === deviceId);
  if (!device) return;
  const canManage = Boolean(state.capabilities["device.manage"]);
  $("#device-title").textContent = device.name;
  $("#device-connection").textContent = `${DEVICE_STATUS[device.status] || device.status} · ${device.host}:${device.port}${device.last_error ? ` · ${device.last_error}` : ""}`;
  $("#edit-device").disabled = !canManage;
  $("#remove-device").disabled = !canManage;
  $("#reconnect-device").disabled = !canManage;
  try {
    const { info, entities, states, logs } = await devicesController.details(deviceId);
    if (state.selectedDevice !== deviceId) return;
    $("#device-info pre").textContent = Object.keys(info).length
      ? JSON.stringify(info, null, 2)
      : t("devices.noInfoYet");
    renderDeviceTable($("#device-entities"), entities, ["type", "name", "object_id", "key"]);
    state.deviceStates = states;
    renderDeviceTable($("#device-states"), state.deviceStates, ["type", "key", "available", "state"]);
    $("#device-logs pre").textContent = formatDeviceLogs(logs);
  } catch (/** @type {any} */ error) {
    toast(error.message, true);
  }
}

function renderDeviceTable(/** @type {any} */ container, /** @type {any} */ rows, /** @type {any} */ preferredColumns) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(Object.assign(document.createElement("div"), { className: "empty", textContent: t("devices.noDataYet") }));
    return;
  }
  const columns = deviceTableColumns(rows, preferredColumns);
  const table = document.createElement("table");
  table.className = "device-data-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((column) => {
    const cell = document.createElement("th");
    cell.textContent = column;
    headRow.append(cell);
  });
  head.append(headRow);
  const body = document.createElement("tbody");
  rows.forEach((/** @type {any} */ row) => {
    const line = document.createElement("tr");
    columns.forEach((column) => {
      const cell = document.createElement("td");
      const value = row[column];
      cell.textContent = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
      line.append(cell);
    });
    body.append(line);
  });
  table.append(head, body);
  container.append(table);
}

function formatDeviceLogs(/** @type {any} */ logs) {
  return formatLogs(logs, t("devices.noLogsYet"));
}

function openDeviceDialog(/** @type {any} */ device = null) {
  state.editingDevice = device?.id || null;
  $("#device-dialog-title").textContent = device ? t("dialog.device.editTitle") : t("dialog.device.addTitle");
  $("#device-id").value = device?.id || "";
  $("#device-id").disabled = Boolean(device);
  $("#device-name").value = device?.name || "";
  $("#device-host").value = device?.host || "";
  $("#device-port").value = device?.port || 6053;
  $("#device-key-ref").value = device?.encryption_key_ref || "";
  $("#device-key").value = "";
  $("#device-key").required = !device || !device.has_encryption_key;
  $("#device-dialog").showModal();
}

async function saveDevice(/** @type {any} */ event) {
  event.preventDefault();
  const editing = state.editingDevice;
  const body = {
    id: editing || $("#device-id").value.trim(),
    name: $("#device-name").value.trim(),
    host: $("#device-host").value.trim(),
    port: Number($("#device-port").value),
    encryption_key_ref: $("#device-key-ref").value.trim(),
  };
  const encryptionKey = $("#device-key").value.trim();
  try {
    await devicesController.save(body, editing, encryptionKey);
    state.selectedDevice = body.id;
    $("#device-dialog").close();
    await loadDevices();
    toast(editing ? t("toast.device.updated") : t("toast.device.added"));
  } catch (/** @type {any} */ error) {
    toast(error.message, true);
  }
}

async function reconnectSelectedDevice() {
  if (!state.selectedDevice) return;
  try {
    await devicesController.reconnect(state.selectedDevice);
    toast(t("toast.device.reconnectStarted"));
    await loadDevices();
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

async function removeSelectedDevice() {
  const device = state.devices.find((/** @type {any} */ item) => item.id === state.selectedDevice);
  if (!device || !confirm(t("confirm.device.remove", { name: device.name }))) return;
  try {
    await devicesController.remove(device.id);
    state.selectedDevice = null;
    await loadDevices();
    toast(t("toast.device.removed"));
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

function connectDeviceEvents() {
  if (!state.capabilities["device.states"] || deviceEventsClient?.socket) return;
  deviceEventsClient ||= createJsonSocket({
    path: "devices/events",
    onOpen: (socket) => { state.deviceSocket = socket; },
    onClose: () => { state.deviceSocket = null; },
    onMessage: async (rawEvent) => {
    const event = /** @type {any} */ (rawEvent);
    if (event.type === "heartbeat") return;
    if (event.type === "log" && event.device_id === state.selectedDevice) {
      const output = $("#device-logs pre");
      const line = formatDeviceLogs([event.log]);
      output.textContent = output.textContent === t("devices.noLogsYet") ? line : `${output.textContent}\n${line}`;
      output.textContent = output.textContent.split("\n").slice(-1000).join("\n");
      return;
    }
    if (["devices", "connection", "snapshot", "device_removed", "resync_required"].includes(event.type)) {
      await loadDevices();
      if (["devices", "snapshot", "device_removed", "resync_required"].includes(event.type)) {
        await loadViewerRuntimeSources();
      }
      updateViewerRuntimeEvent(event);
      renderProperties();
      applyDesignerRuntimePreview();
    } else if (event.type === "state") {
      if (event.device_id === state.selectedDevice) {
        mergeDeviceState(state.deviceStates, event.state);
        renderDeviceTable($("#device-states"), state.deviceStates, ["type", "key", "available", "state"]);
      }
      updateViewerRuntimeEvent(event);
      renderRuntimeBindingStatus();
      applyDesignerRuntimePreview();
    }
    },
  });
  state.deviceSocket = deviceEventsClient.connect();
}

async function loadViewerRuntimeSources() {
  if (!state.capabilities["device.states"]) {
    state.viewerRuntimeSources = { devices: [] };
    return state.viewerRuntimeSources;
  }
  try {
    state.viewerRuntimeSources = await devicesController.runtime();
  } catch {
    state.viewerRuntimeSources = { devices: [] };
  }
  return state.viewerRuntimeSources;
}

function updateViewerRuntimeEvent(/** @type {any} */ event) {
  applyRuntimeEvent(state.viewerRuntimeSources, event);
}

async function loadViewerBindings(/** @type {any} */ name) {
  clearViewerBindings();
  if (!name) return;
  try {
    const result = await api("viewer/bindings/" + encodeURIComponent(name));
    state.viewerBindings = result.bindings || [];
    state.viewerBindingsRevision = result.revision || null;
  } catch (/** @type {any} */ error) {
    toast(t("toast.binding.loadFailed", { error: error.message }), true);
  }
}

function clearViewerBindings() {
  state.viewerBindings = [];
  state.viewerBindingsRevision = null;
}

async function openLiveViewer() {
  // Glow-line strokes only become real image/animimg widgets through
  // bakeAllStrokes() (see there) - without this, a stroke's flow action
  // would reference widget ids the viewer (which only simulates
  // project.widgets, not glow_strokes) can never find, reporting them as
  // "not found" instead of actually showing the flow.
  await bakeAllStrokes();
  let snapshot = state.viewerRuntimeSources;
  if (state.viewerBindings.length) snapshot = await loadViewerRuntimeSources();
  viewer.open(state.project, {
    name: state.projectName || $("#project-name").value || "Lokales Projekt",
    backgroundPreview: state.backgroundPreview,
    runtimeBindings: state.viewerBindings,
    runtimeSnapshot: snapshot,
  });
  if (state.viewerBindings.length && state.capabilities["device.states"]) connectViewerRuntimeEvents();
}

function connectViewerRuntimeEvents() {
  if (viewerRuntimeClient?.socket || !state.viewerRuntimeActive && !$("#viewer-dialog").open) return;
  state.viewerRuntimeActive = true;
  viewerRuntimeClient ||= createJsonSocket({
    path: "viewer/runtime/events",
    reconnect: () => state.viewerRuntimeActive && $("#viewer-dialog").open,
    onOpen: (socket) => { state.viewerRuntimeSocket = socket; },
    onClose: () => { state.viewerRuntimeSocket = null; },
    onMessage: async (rawEvent) => {
      const event = /** @type {any} */ (rawEvent);
      if (event.type === "resync_required") {
        const snapshot = await loadViewerRuntimeSources();
        viewer.setRuntimeSnapshot(snapshot);
        renderProperties();
        applyDesignerRuntimePreview();
        return;
      }
      updateViewerRuntimeEvent(event);
      viewer.applyRuntimeEvent(event);
      renderRuntimeBindingStatus();
      applyDesignerRuntimePreview();
    },
  });
  state.viewerRuntimeSocket = viewerRuntimeClient.connect();
}

function stopViewerRuntimeEvents() {
  state.viewerRuntimeActive = false;
  viewerRuntimeClient?.stop();
  viewerRuntimeClient = null;
  state.viewerRuntimeSocket = null;
}

function closeViewer() {
  stopViewerRuntimeEvents();
  viewer.close();
}

// Phone layout only: which of the three designer panels is the active full-
// width pane. Irrelevant above the 700px breakpoint, where CSS shows all
// three as grid columns regardless of this attribute.
function setDesignerPane(/** @type {any} */ pane) {
  document.body.dataset.designerPane = pane;
  $$("#designer-pane-switch .button").forEach((button) => {
    button.classList.toggle("active", button.dataset.pane === pane);
  });
}

function bindDesignerPaneSwitch() {
  setDesignerPane("canvas");
  $$("#designer-pane-switch .button").forEach((button) => {
    button.addEventListener("click", () => setDesignerPane(button.dataset.pane));
  });
}

function bindDesigner() {
  bindDesignerPaneSwitch();
  bindThemeEditor();
  bindColorLibrary();
  bindFontLibrary();
  viewer = new ViewerController({
    dialog: $("#viewer-dialog"),
    stage: $("#viewer-stage"),
    frame: $("#viewer-frame"),
    display: $("#viewer-display"),
    title: $("#viewer-title"),
    status: $("#viewer-status"),
    zoomLabel: $("#viewer-zoom-label"),
    rotationControl: $("#viewer-rotation"),
    eventLog: $("#viewer-event-log"),
    eventCount: $("#viewer-event-count"),
    pageControls: $("#viewer-page-controls"),
    pageSelect: $("#viewer-page-select"),
    pagePrevious: $("#viewer-page-previous"),
    pageNext: $("#viewer-page-next"),
    rendererControl: $("#viewer-renderer"),
  });
  $("#open-viewer").addEventListener("click", openLiveViewer);
  $("#viewer-close").addEventListener("click", closeViewer);
  $("#viewer-reset").addEventListener("click", () => viewer.reset());
  $("#viewer-page-select").addEventListener("change", (/** @type {any} */ event) => {
    viewer.setActivePage(event.target.value);
  });
  $("#viewer-page-previous").addEventListener("click", () => viewer.changePage(-1));
  $("#viewer-page-next").addEventListener("click", () => viewer.changePage(1));
  $("#viewer-fit").addEventListener("click", () => viewer.fit());
  $("#viewer-zoom-100").addEventListener("click", () => viewer.setZoom(1));
  $("#viewer-zoom-out").addEventListener("click", () => viewer.setZoom(viewer.zoom / 1.25));
  $("#viewer-zoom-in").addEventListener("click", () => viewer.setZoom(viewer.zoom * 1.25));
  $("#viewer-renderer").addEventListener("change", (/** @type {any} */ event) => viewer.setRenderer(event.target.value));
  $("#viewer-rotation").addEventListener("change", (/** @type {any} */ event) => viewer.setRotation(event.target.value));
  $("#viewer-dialog").addEventListener("close", closeViewer);
  $("#viewer-dialog").addEventListener("cancel", (/** @type {any} */ event) => {
    event.preventDefault();
    closeViewer();
  });
  $("#canvas-width").addEventListener("change", updateCanvasSize);
  $("#canvas-height").addEventListener("change", updateCanvasSize);
  $("#new-project").addEventListener("click", newDesignerProject);
  $("#open-project").addEventListener("click", () => $("#project-file").click());
  $("#project-file").addEventListener("change", openDesignerProject);
  $("#save-project").addEventListener("click", downloadDesignerProject);
  $("#export-project").addEventListener("click", exportDesignerYaml);
  $("#undo").addEventListener("click", undoDesignerChange);
  $("#redo").addEventListener("click", redoDesignerChange);
  $("#server-projects").addEventListener("change", updateServerProjectButtons);
  $("#load-server-project").addEventListener("click", loadSelectedServerProject);
  $("#save-server-project").addEventListener("click", saveServerProject);
  $("#delete-server-project").addEventListener("click", deleteServerProject);
  $("#delete-widget").addEventListener("click", deleteSelectedWidget);
  ["id", "x", "y", "width", "height"].forEach((key) => {
    const control = $(`#prop-${key}`);
    control.addEventListener("focus", pushUndo);
    control.addEventListener("input", updateSelectedWidget);
  });
  // Checked on blur rather than every keystroke, so an in-progress edit
  // isn't reverted mid-type. Catches the same class of bug as the reserved
  // ids in uniqueWidgetId(): typing an id a hardware entity (or another
  // widget/style/font/image/color) already uses would otherwise silently
  // produce a config ESPHome can't compile. The "input" handler above
  // already committed each keystroke to widget.id, so this checks for
  // *other* owners of the current id rather than reusing projectIdIsUsed()
  // (which would always find the widget's own just-committed id).
  /** @type {any} */
  let widgetIdBeforeEdit = null;
  $("#prop-id").addEventListener("focus", (/** @type {any} */ event) => {
    widgetIdBeforeEdit = event.target.value;
  });
  $("#prop-id").addEventListener("blur", (/** @type {any} */ event) => {
    const widget = state.selectedWidget;
    if (!widget) return;
    const currentId = widget.id;
    const collides = projectWidgetEntries().some((entry) => entry !== widget && entry.id === currentId)
      || (state.project.reserved_ids || []).includes(currentId)
      || [state.project.styles, state.project.fonts, state.project.images, colorLibrary()]
        .some((entries) => (entries || []).some((/** @type {any} */ entry) => entry.id === currentId));
    if (collides) {
      const previousId = widgetIdBeforeEdit || currentId;
      toast(t("toast.id.alreadyUsed", { id: currentId }), true);
      replaceProjectWidgetReferences(currentId, previousId);
      widget.id = previousId;
      event.target.value = previousId;
      markProjectDirty();
      renderCanvas();
    }
  });
  $("#prop-locked").addEventListener("change", () => toggleWidgetFlag("locked"));
  $("#prop-hidden").addEventListener("change", () => toggleWidgetFlag("hidden"));
  ["row", "col"].forEach((key) => {
    const control = $(`#tile-${key}`);
    control.addEventListener("focus", pushUndo);
    control.addEventListener("input", () => {
      const widget = state.selectedWidget;
      if (!widget) return;
      widget[`tile_${key}`] = Math.max(0, Number(control.value) || 0);
      markProjectDirty();
      renderCanvas();
    });
  });
  $("#tile-dir").addEventListener("change", () => {
    const widget = state.selectedWidget;
    if (!widget) return;
    pushUndo();
    widget.tile_dir = $("#tile-dir").value || "ALL";
    markProjectDirty();
    renderCanvas();
  });
  $("#add-tile").addEventListener("click", addTileToSelectedTileview);
  $("#tab-title").addEventListener("focus", pushUndo);
  $("#tab-title").addEventListener("input", () => {
    const widget = state.selectedWidget;
    if (!widget) return;
    widget.tab_title = $("#tab-title").value;
    markProjectDirty();
    renderCanvas();
  });
  $("#add-tab").addEventListener("click", addTabToSelectedTabview);
  $("#style-state").addEventListener("change", changeActiveState);
  $("#style-mode").addEventListener("change", changeStyleMode);
  $("#style-ref").addEventListener("change", changeStyleRef);
  $("#save-as-style").addEventListener("click", saveCurrentStyleAsNamed);
  $("#widget-action-trigger").addEventListener("change", () => renderWidgetActionBuilder(state.selectedWidget));
  $("#widget-action-type").addEventListener("change", () => renderWidgetActionBuilder(state.selectedWidget));
  $("#widget-action-target").addEventListener("change", () => renderWidgetActionBuilder(state.selectedWidget));
  $("#widget-action-flow-stroke").addEventListener("change", () => renderWidgetActionBuilder(state.selectedWidget));
  $("#widget-action-indicator-trigger-value").addEventListener("change", () => renderWidgetActionBuilder(state.selectedWidget));
  $("#add-widget-action").addEventListener("click", addWidgetAction);
  $("#close-meter-dialog").addEventListener("click", () => $("#meter-dialog").close());
  $("#cancel-meter-dialog").addEventListener("click", () => $("#meter-dialog").close());
  $("#apply-meter-dialog").addEventListener("click", applyMeterConfigurator);
  $("#meter-add-scale").addEventListener("click", addMeterScale);
  $("#meter-add-indicator").addEventListener("click", addMeterIndicator);
  $("#meter-preview-indicator").addEventListener("change", () => {
    meterPreviewIndicatorId = $("#meter-preview-indicator").value;
    renderMeterConfiguratorPreview();
  });
  $("#meter-preview-value").addEventListener("input", () => {
    const testValue = Number($("#meter-preview-value").value);
    meterPreviewTestValues.set(meterPreviewIndicatorId, testValue);
    $("#meter-preview-value-label").value = String(testValue);
    renderMeterConfiguratorPreview(false);
  });
  $("#apply-image-button").addEventListener("click", applyImageButtonSettings);
  $("#runtime-binding-target").addEventListener("change", () => renderRuntimeBinding(state.selectedWidget));
  $("#runtime-binding-device").addEventListener("change", () => {
    populateRuntimeEntityChoices();
    renderRuntimeBindingStatus();
  });
  $("#runtime-binding-entity").addEventListener("change", () => {
    renderRuntimeBindingStatus();
    applyDesignerRuntimePreview();
  });
  ["runtime-binding-format", "runtime-binding-fallback", "runtime-binding-stale"].forEach((id) => {
    $(`#${id}`).addEventListener("input", () => {
      renderRuntimeBindingStatus();
      applyDesignerRuntimePreview();
    });
  });
  $("#save-runtime-binding").addEventListener("click", saveRuntimeBinding);
  $("#remove-runtime-binding").addEventListener("click", removeRuntimeBinding);
  $("#copy-runtime-binding").addEventListener("click", copyRuntimeBinding);
  $("#paste-runtime-binding").addEventListener("click", pasteRuntimeBinding);
  $("#cleanup-runtime-bindings").addEventListener("click", cleanupRuntimeBindings);
  $("#runtime-live-preview").addEventListener("change", (/** @type {any} */ event) => {
    state.designerRuntimePreview = event.target.checked;
    renderCanvas();
  });
  $("#device-binding-direction").addEventListener("change", () => renderDeviceBindings(state.selectedWidget));
  $("#device-binding-existing").addEventListener("change", loadSelectedDeviceBinding);
  $("#device-binding-entity").addEventListener("change", () => populateDeviceBindingCommands());
  $("#device-binding-property").addEventListener("change", () => renderDeviceBindingIndicator(state.selectedWidget));
  $("#save-device-binding").addEventListener("click", saveDeviceBinding);
  $("#remove-device-binding").addEventListener("click", deleteDeviceBinding);
  $("#save-custom-binding").addEventListener("click", saveCustomDeviceBinding);
  $("#restore-custom-binding").addEventListener("click", restoreCustomDeviceBinding);
  $("#save-flow-binding").addEventListener("click", saveGlowFlowBinding);
  $("#remove-flow-binding").addEventListener("click", removeGlowFlowBinding);
  state.runtimeStatusTimer ||= window.setInterval(() => {
    renderRuntimeBindingStatus();
    applyDesignerRuntimePreview();
  }, 1000);
  bindGlowTools();
  bindSurfaceTools();
  bindMsgboxDialog();

  $("#zoom-in").addEventListener("click", () => setZoom(state.zoom * 1.25));
  $("#zoom-out").addEventListener("click", () => setZoom(state.zoom / 1.25));
  $("#zoom-100").addEventListener("click", () => setZoom(1));
  $("#zoom-fit").addEventListener("click", fitCanvasToView);

  $("#bg-path").addEventListener("focus", pushUndo);
  $("#bg-path").addEventListener("input", updateBackgroundFields);
  $("#bg-image-id").addEventListener("focus", pushUndo);
  $("#bg-image-id").addEventListener("input", updateBackgroundFields);
  $("#bg-export").addEventListener("change", updateBackgroundFields);
  $("#bg-opacity").addEventListener("input", updateBackgroundFields);
  $("#bg-preview-pick").addEventListener("click", () => $("#bg-preview-file").click());
  $("#bg-preview-file").addEventListener("change", loadBackgroundPreview);
  $("#bg-preview-clear").addEventListener("click", clearBackgroundPreview);

  $("#import-yaml").addEventListener("click", openImportDialog);
  $("#close-import").addEventListener("click", () => $("#import-dialog").close());
  $("#import-config").addEventListener("change", probeSelectedConfiguration);
  $("#import-pick-file").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", probePickedFile);
  $("#do-import").addEventListener("click", runImport);
  $("#close-dialog").addEventListener("click", () => $("#yaml-dialog").close());
  $("#copy-yaml").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#yaml-output").textContent);
    toast(t("toast.yaml.copied"));
  });
  $("#merge-draft-target").addEventListener("change", () => {
    $("#merge-draft-save").disabled = !$("#merge-draft-target").value;
  });
  $("#merge-draft-save").addEventListener("click", saveMergeDraft);
  $("#download-zip").addEventListener("click", downloadProjectZip);
  const actionsSection = $("#widget-actions-section");
  actionsSection.open = !collapsedPropertyGroups.actions;
  actionsSection.addEventListener("toggle", () => togglePropertyGroup("actions", !actionsSection.open));
  document.addEventListener("keydown", (event) => {
    if (!$("#designer").classList.contains("active")) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(
      event.target instanceof HTMLElement ? event.target.tagName : "",
    );

    if (state.canvasMode === "lines" && !typing && !event.ctrlKey) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (state.drawingStroke) {
          removeStroke(state.drawingStroke);
          state.drawingStroke = null;
          state.selectedStroke = null;
          setLineTool("select");
          renderDesigner();
        }
        return;
      }
      if (event.key === "Backspace" && state.drawingStroke) {
        event.preventDefault();
        state.drawingStroke.points.pop();
        markProjectDirty();
        renderGlowCanvas();
        renderGlowHandles();
        return;
      }
      if (event.key === "Enter" && state.drawingStroke) {
        event.preventDefault();
        finishDrawing();
        return;
      }
      if (event.key === "Delete" && state.selectedStroke && !state.drawingStroke) {
        event.preventDefault();
        deleteSelectedStroke();
        return;
      }
      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        setLineTool("draw");
        return;
      }
      if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        setLineTool("select");
        return;
      }
    }

    if (event.key === "Delete" && !typing) {
      event.preventDefault();
      deleteSelectedWidget();
      return;
    }
    if (!event.ctrlKey) return;

    const key = event.key.toLowerCase();
    /** @type {Record<string, () => unknown>} */
    const actions = {
      z: undoDesignerChange,
      y: redoDesignerChange,
      n: newDesignerProject,
      o: () => $("#project-file").click(),
      s: downloadDesignerProject,
      e: exportDesignerYaml,
      0: fitCanvasToView,
      1: () => setZoom(1),
      "+": () => setZoom(state.zoom * 1.25),
      "-": () => setZoom(state.zoom / 1.25),
    };
    if (actions[key]) {
      event.preventDefault();
      actions[key]();
    }
  });
}

function setZoom(/** @type {any} */ value) {
  state.zoom = clamp(Number(value) || 1, MIN_ZOOM, MAX_ZOOM);
  applyZoom();
}

function applyZoom() {
  const { width, height } = state.project.canvas;
  // A CSS transform does not affect layout, so the canvas is scaled from its
  // top-left corner while the wrapper reserves the resulting visual size -
  // otherwise the stage would scroll against the unscaled box.
  $("#canvas").style.transform = `scale(${state.zoom})`;
  const scaler = $("#canvas-scaler");
  scaler.style.width = `${width * state.zoom}px`;
  scaler.style.height = `${height * state.zoom}px`;
  $("#zoom-label").textContent = `${Math.round(state.zoom * 100)} %`;
}

function fitCanvasToView() {
  const stage = $(".canvas-stage");
  const styles = getComputedStyle(stage);
  const available = {
    width: stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight),
    height: stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom),
  };
  const { width, height } = state.project.canvas;
  if (!width || !height || available.width <= 0 || available.height <= 0) return;
  setZoom(Math.min(available.width / width, available.height / height));
}

function newDesignerProject() {
  if (state.projectDirty && !confirm(t("confirm.discardUnsaved"))) return;
  stopFlowPreview();
  state.project = freshProject();
  state.activeSurface = "root";
  state.projectName = null;
  clearViewerBindings();
  state.projectRevision = null;
  state.projectDirty = false;
  state.selectedWidget = null;
  state.selectedStroke = null;
  state.drawingStroke = null;
  state.backgroundPreview = null;
  resetHistory();
  $("#project-name").value = "display.lvgldesign";
  renderDesigner();
  fitCanvasToView();
}

async function openDesignerProject(/** @type {any} */ event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    toast(t("toast.project.fileTooLarge"), true);
    return;
  }
  try {
    const project = JSON.parse(await file.text());
    const result = await api("designer/projects/validate", {
      method: "POST", body: JSON.stringify({ project }),
    });
    if (!result.valid) throw new Error(result.issues.map((/** @type {any} */ issue) => issue.message).join("\n"));
    stopFlowPreview();
    state.project = result.project;
    state.activeSurface = result.project.pages?.[0] ? `page:${result.project.pages[0].id}` : "root";
    state.projectName = null;
    clearViewerBindings();
    state.projectRevision = null;
    state.projectDirty = false;
    state.selectedWidget = null;
    state.selectedStroke = null;
    state.drawingStroke = null;
    $("#project-name").value = normalizeProjectName(file.name);
    resetHistory();
    renderDesigner();
    toast(t("toast.project.loaded"));
  } catch (/** @type {any} */ error) {
    toast(t("toast.project.loadFailed", { error: error.message }), true);
  }
}

async function downloadDesignerProject() {
  try {
    const result = await api("designer/projects/validate", {
      method: "POST", body: JSON.stringify({ project: state.project }),
    });
    if (!result.valid) throw new Error(result.issues.map((/** @type {any} */ issue) => issue.message).join("\n"));
    const blob = new Blob([JSON.stringify(result.project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = normalizeProjectName($("#project-name").value);
    link.click();
    URL.revokeObjectURL(url);
    toast(t("toast.project.downloaded"));
  } catch (/** @type {any} */ error) {
    toast(t("toast.project.downloadFailed", { error: error.message }), true);
  }
}

// --- Import an existing ESPHome configuration -------------------------------
// Two steps on purpose: probe first so the user sees what would happen before
// their current project is replaced, and can correct the detected canvas size.

const importState = { configuration: null, content: null, fileName: "", stats: null };

function openImportDialog() {
  const select = $("#import-config");
  select.replaceChildren(new Option(t("dialog.importYaml.pickFile"), ""));
  state.configurations.forEach((/** @type {any} */ config) => select.append(new Option(config.name, config.name)));
  resetImportSelection();
  $("#import-dialog").showModal();
}

function resetImportSelection() {
  importState.configuration = null;
  importState.content = null;
  importState.fileName = "";
  importState.stats = null;
  $("#import-file-name").textContent = "";
  $("#import-summary").classList.add("hidden");
  $("#import-canvas").classList.add("hidden");
  $("#do-import").disabled = true;
}

async function probeSelectedConfiguration() {
  const name = $("#import-config").value;
  if (!name) return resetImportSelection();
  importState.configuration = name;
  importState.content = null;
  importState.fileName = "";
  $("#import-file-name").textContent = "";
  await probeImport({ configuration: name });
}

async function probePickedFile(/** @type {any} */ event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    toast(t("toast.file.tooLarge4MB"), true);
    return;
  }
  importState.configuration = null;
  importState.content = await file.text();
  importState.fileName = file.name;
  $("#import-config").value = "";
  $("#import-file-name").textContent = file.name;
  await probeImport({ content: importState.content });
}

async function probeImport(/** @type {any} */ payload) {
  const summary = $("#import-summary");
  summary.classList.remove("hidden");
  summary.textContent = "Wird analysiert …";
  try {
    const stats = await api("designer/import/probe", {
      method: "POST", body: JSON.stringify(payload),
    });
    importState.stats = stats;
    renderImportSummary(stats);
    $("#import-width").value = stats.canvas.width;
    $("#import-height").value = stats.canvas.height;
    $("#import-canvas").classList.remove("hidden");
    $("#do-import").disabled = false;
  } catch (/** @type {any} */ error) {
    importState.stats = null;
    summary.textContent = error.message;
    summary.classList.add("import-error");
    $("#import-canvas").classList.add("hidden");
    $("#do-import").disabled = true;
  }
}

function renderImportSummary(/** @type {any} */ stats) {
  const summary = $("#import-summary");
  summary.classList.remove("import-error");
  summary.replaceChildren();

  const { lines, warnings } = summarizeImport(stats, t);
  lines.forEach((text) => {
    const row = document.createElement("div");
    row.textContent = text;
    summary.append(row);
  });

  warnings.forEach((warning) => summary.append(warningRow(warning.text, warning.severe)));
}

function warningRow(/** @type {any} */ text, severe = false) {
  const row = document.createElement("div");
  row.className = severe ? "issue-error" : "import-warning";
  row.textContent = text;
  return row;
}

async function runImport() {
  if (state.projectDirty && !confirm(t("confirm.discardUnsaved"))) return;
  const payload = buildImportPayload(
    importState,
    $("#import-width").value,
    $("#import-height").value,
  );

  $("#do-import").disabled = true;
  try {
    const result = await api("designer/import", { method: "POST", body: JSON.stringify(payload) });
    if (!result.valid) {
      // Keep the dialog open - the summary is the only place these are
      // visible, and adopting a project we know is broken helps nobody.
      renderIssues($("#import-summary"), result.issues, t("issues.contextImport"));
      return;
    }
    stopFlowPreview();
    state.project = result.project;
    state.activeSurface = result.project.pages?.[0] ? `page:${result.project.pages[0].id}` : "root";
    // An import is not "the saved project under this name" - it is a new,
    // unsaved document derived from a config we must never write back to.
    state.projectName = null;
    clearViewerBindings();
    state.projectRevision = null;
    state.projectDirty = true;
    state.selectedWidget = null;
    state.selectedStroke = null;
    state.drawingStroke = null;
    state.backgroundPreview = null;
    $("#project-name").value = normalizeProjectName(
      importState.configuration || importState.fileName || "import");
    resetHistory();
    renderDesigner();
    fitCanvasToView();
    $("#import-dialog").close();
    const warnings = result.issues.filter((/** @type {any} */ issue) => issue.severity === "B").length;
    toast(t("toast.import.summary", { count: result.stats.widget_count })
      + (warnings ? t("toast.import.warningsSuffix", { count: warnings }) : ""));
  } catch (/** @type {any} */ error) {
    toast(error.message, true);
  } finally {
    $("#do-import").disabled = false;
  }
}

async function loadServerProjects() {
  try {
    const projects = await projectsController.list();
    const select = $("#server-projects");
    const selected = select.value;
    select.replaceChildren(new Option(t("project.savedProjects"), ""));
    projects.forEach((/** @type {any} */ project) => {
      const option = new Option(project.name, project.name);
      option.dataset.revision = project.revision;
      select.append(option);
    });
    select.value = projects.some((/** @type {any} */ project) => project.name === selected) ? selected : "";
    updateServerProjectButtons();
  } catch (/** @type {any} */ error) {
    toast(error.message, true);
  }
}

function updateServerProjectButtons() {
  const selected = Boolean($("#server-projects").value);
  const canWrite = Boolean(state.capabilities["designer.project_write"]);
  const writeHint = canWrite ? "" : "Erfordert mindestens die Rolle \"editor\" (siehe Add-on-Konfiguration: default_role/user_roles).";
  $("#load-server-project").disabled = !selected;
  $("#delete-server-project").disabled = !selected || !canWrite;
  $("#delete-server-project").title = canWrite ? "" : writeHint;
  $("#save-server-project").disabled = !canWrite;
  $("#save-server-project").title = writeHint;
}

async function loadSelectedServerProject() {
  const name = $("#server-projects").value;
  if (!name) return;
  if (state.projectDirty && !confirm(t("confirm.discardUnsaved"))) return;
  try {
    const result = await projectsController.load(name);
    stopFlowPreview();
    state.project = result.project;
    state.activeSurface = result.project.pages?.[0] ? `page:${result.project.pages[0].id}` : "root";
    state.projectName = result.name;
    state.projectRevision = result.revision;
    await loadViewerBindings(result.name);
    state.projectDirty = false;
    state.selectedWidget = null;
    state.selectedStroke = null;
    state.drawingStroke = null;
    $("#project-name").value = result.name;
    resetHistory();
    renderDesigner();
    toast(t("toast.project.loadedFromStorage"));
  } catch (/** @type {any} */ error) {
    toast(error.message, true);
  }
}

async function saveServerProject() {
  const name = normalizeProjectName($("#project-name").value);
  $("#project-name").value = name;
  const expectedRevision = state.projectName === name ? state.projectRevision : null;
  try {
    const result = await projectsController.save(name, state.project, expectedRevision);
    state.projectName = name;
    state.projectRevision = result.revision;
    state.projectDirty = false;
    renderDesignerStatus();
    renderProperties();
    await loadServerProjects();
    $("#server-projects").value = name;
    updateServerProjectButtons();
    toast(t("toast.project.savedToStorage"));
  } catch (/** @type {any} */ error) {
    toast(error.code === "project_exists" ? t("toast.project.alreadyExists") : error.message, true);
  }
}

async function deleteServerProject() {
  const name = $("#server-projects").value;
  if (!name || !confirm(t("confirm.project.deleteStored", { name }))) return;
  const option = $("#server-projects").selectedOptions[0];
  const revision = state.projectName === name ? state.projectRevision : option.dataset.revision;
  try {
    await projectsController.remove(name, revision);
    if (state.projectName === name) {
      state.projectName = null;
      clearViewerBindings();
      state.projectRevision = null;
      state.projectDirty = true;
    }
    await loadServerProjects();
    renderDesignerStatus();
    toast(t("toast.project.deletedFromStorage"));
  } catch (/** @type {any} */ error) {
    toast(error.message, true);
  }
}

function pushUndo() {
  state.undo = pushHistory(state.undo, state.project);
  state.redo = [];
  updateUndoButtons();
}

function reselectAfterHistoryChange(/** @type {any} */ widgetId, /** @type {any} */ strokeId) {
  state.selectedWidget = widgetId
    ? allWidgets().find((/** @type {any} */ widget) => widget.id === widgetId) || null
    : null;
  state.selectedStroke = strokeId
    ? (state.project.glow_strokes || []).find((/** @type {any} */ stroke) => stroke.id === strokeId) || null
    : null;
}

function undoDesignerChange() {
  const history = undoHistory(state.undo, state.redo, state.project);
  if (!history) return;
  const widgetId = state.selectedWidget?.id;
  const strokeId = state.selectedStroke?.id;
  Object.assign(state, history);
  normaliseActiveSurface();
  reselectAfterHistoryChange(widgetId, strokeId);
  markProjectDirty();
  renderDesigner();
}

function redoDesignerChange() {
  const history = redoHistory(state.undo, state.redo, state.project);
  if (!history) return;
  const widgetId = state.selectedWidget?.id;
  const strokeId = state.selectedStroke?.id;
  Object.assign(state, history);
  normaliseActiveSurface();
  reselectAfterHistoryChange(widgetId, strokeId);
  markProjectDirty();
  renderDesigner();
}

function resetHistory() {
  state.undo = [];
  state.redo = [];
  updateUndoButtons();
}

function updateUndoButtons() {
  $("#undo").disabled = state.undo.length === 0;
  $("#redo").disabled = state.redo.length === 0;
}

function markProjectDirty() {
  actions.set("projectDirty", true);
}

function updateCanvasSize() {
  pushUndo();
  state.project.canvas.width = clamp(Number($("#canvas-width").value), 1, 4096);
  state.project.canvas.height = clamp(Number($("#canvas-height").value), 1, 4096);
  markProjectDirty();
  renderDesigner();
}

function renderPalette() {
  const palette = $("#palette");
  palette.replaceChildren();
  /** @type {Record<string, string>} */
  const icons = {
    obj: "▣", container: "▤", label: "T", button: "▰",
    switch: "◉", slider: "━", bar: "▮", arc: "◔", image: "▧", animimg: "▩",
    checkbox: "☑", dropdown: "▾", roller: "≡", textarea: "⌨︎", keyboard: "⌨",
    tileview: "▦", tabview: "▭", led: "●", spinner: "◌", qrcode: "▥", spinbox: "🔢",
  };

  const appendWidgetButton = (/** @type {any} */ schema) => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    icon.className = "widget-icon";
    icon.textContent = icons[schema.type_key] || "◇";
    button.append(icon, document.createTextNode(schema.label));
    button.addEventListener("click", () => addWidget(schema));
    palette.append(button);
    if (schema.type_key === "button") {
      const imageButton = document.createElement("button");
      const imageButtonIcon = document.createElement("span");
      imageButtonIcon.className = "widget-icon";
      imageButtonIcon.textContent = "▧";
      imageButton.append(imageButtonIcon, document.createTextNode(t("palette.imageButtonText")));
      imageButton.title = t("palette.imageButtonTitle");
      imageButton.addEventListener("click", addImageButton);
      palette.append(imageButton);
    }
  };

  const appendGroupHeading = (/** @type {any} */ labelKey) => {
    const heading = document.createElement("div");
    heading.className = "palette-group-heading";
    heading.textContent = t(labelKey);
    palette.append(heading);
  };

  // is_stub schemas (e.g. "tile") are structural children of another widget,
  // not something placeable on their own - they never get a palette entry.
  const placeable = state.schemas.filter((/** @type {any} */ schema) => !schema.is_stub);
  const inputSchemas = placeable.filter((/** @type {any} */ schema) => schema.category === "input");
  const displaySchemas = placeable.filter((/** @type {any} */ schema) => schema.category !== "input");
  if (inputSchemas.length) {
    appendGroupHeading("palette.categoryInput");
    inputSchemas.forEach(appendWidgetButton);
  }
  if (displaySchemas.length) {
    appendGroupHeading("palette.categoryDisplay");
    displaySchemas.forEach(appendWidgetButton);
  }

  const glowButton = document.createElement("button");
  const glowIcon = document.createElement("span");
  glowIcon.className = "widget-icon";
  glowIcon.textContent = "∿";
  glowButton.append(glowIcon, document.createTextNode(t("palette.glowLineText")));
  glowButton.title = t("palette.glowLineTitle");
  glowButton.addEventListener("click", startNewLine);
  palette.append(glowButton);
}

function allWidgets(nodes = activeWidgetRoots()) {
  /** @type {any} */
  const result = [];
  const visit = (/** @type {any} */ items) => items.forEach((/** @type {any} */ widget) => {
    result.push(widget);
    visit(widget.children || []);
  });
  visit(nodes);
  return result;
}

function editorWidgetNode(/** @type {any} */ id, /** @type {any} */ widgetType, /** @type {any} */ {
  x = 0, y = 0, width = 100, height = 40, align = "TOP_LEFT", properties = {},
  styleTree = {}, children = [],
} = {}) {
  return {
    id,
    widget_type: widgetType,
    name: "",
    x,
    y,
    width,
    height,
    align,
    align_to: "",
    hidden: false,
    locked: false,
    properties,
    style_mode: "inline",
    style_refs: [],
    style_tree: styleTree,
    events: {},
    children,
    tab_title: "",
    tile_row: 0,
    tile_col: 0,
    tile_dir: "ALL",
    layout: {},
    grid_cell: {},
    extra: {},
    source: "editor",
    synthetic_id: false,
  };
}

function migrateButtonTextToChildLabel(/** @type {any} */ button) {
  if (button?.widget_type !== "button" || !Object.hasOwn(button.properties || {}, "text")) return null;
  const text = String(button.properties.text ?? "");
  delete button.properties.text;
  if (!text) return null;
  const label = editorWidgetNode(uniqueProjectWidgetId(`${button.id}_label`), "label", {
    width: Math.max(40, Number(button.width) || 120),
    height: 24,
    align: "CENTER",
    properties: { text, long_mode: "WRAP", recolor: false },
  });
  button.children ||= [];
  button.children.push(label);
  toast(t("toast.imgbtn.textMovedToLabel"));
  return label;
}

/** @returns {any} */
function selectedChildTarget() {
  const parentSchema = state.selectedWidget
    ? state.schemas.find((/** @type {any} */ item) => item.type_key === state.selectedWidget.widget_type)
    : null;
  const parent = parentSchema?.allows_children ? state.selectedWidget : null;
  if (parent) migrateButtonTextToChildLabel(parent);
  return { parent, target: parent ? parent.children : activeWidgetRoots() };
}

function addImageButton() {
  if (state.canvasMode !== "widgets") setCanvasMode("widgets");
  pushUndo();
  const { target } = selectedChildTarget();
  const buttonId = uniqueProjectWidgetId("image_button");
  const imageId = uniqueProjectWidgetId(`${buttonId}_image`);
  const labelId = uniqueProjectWidgetId(`${buttonId}_label`);
  const firstImage = imageLibrary()[0]?.id || "";
  const offset = (target.length * 12) % 100;
  const image = editorWidgetNode(imageId, "image", {
    width: 56,
    height: 56,
    align: "CENTER",
    y: -8,
    properties: { src: firstImage, angle: 0, zoom: 1 },
  });
  const label = editorWidgetNode(labelId, "label", {
    width: 112,
    height: 22,
    align: "BOTTOM_MID",
    y: -4,
    properties: { text: "Bild-Button", long_mode: "WRAP", recolor: false },
    styleTree: { text_align: "CENTER" },
  });
  const button = editorWidgetNode(buttonId, "button", {
    x: 20 + offset,
    y: 20 + offset,
    width: 120,
    height: 90,
    properties: { checkable: false },
    children: [image, label],
  });
  target.push(button);
  state.selectedWidget = button;
  markProjectDirty();
  renderDesigner();
  if (!firstImage) toast(t("toast.imgbtn.created"));
}

function addWidget(/** @type {any} */ schema) {
  if (state.canvasMode !== "widgets") setCanvasMode("widgets");
  pushUndo();
  const idBase = schema.type_key === "container" ? "container" : schema.type_key;
  let number = 1;
  // reserved_ids are ids used by hardware entities elsewhere in an imported
  // source config (binary_sensor:, button:, ...) - never modeled here, but
  // sharing ESPHome's one flat id() namespace with everything created here.
  const ids = new Set([
    ...allProjectWidgets().map((widget) => widget.id),
    ...(state.project.reserved_ids || []),
  ]);
  while (ids.has(`${idBase}_${number}`)) number += 1;
  /** @type {Record<string, any>} */
  const properties = {};
  for (const property of schema.properties) {
    if (property.category === "content" && property.default !== null) properties[property.key] = property.default;
  }
  const { target } = selectedChildTarget();
  const widget = {
    id: `${idBase}_${number}`,
    widget_type: schema.type_key,
    name: "",
    x: 20 + (target.length * 12) % 100,
    y: 20 + (target.length * 12) % 100,
    width: schema.default_size[0],
    height: schema.default_size[1],
    align: "TOP_LEFT",
    align_to: "",
    hidden: false,
    locked: false,
    properties,
    style_mode: "inline",
    style_refs: [],
    style_tree: {},
    events: {},
    children: [],
    tab_title: "",
    tile_row: 0,
    tile_col: 0,
    tile_dir: "ALL",
    layout: {},
    grid_cell: {},
    extra: {},
    source: "editor",
    synthetic_id: false,
  };
  target.push(widget);
  state.selectedWidget = widget;
  markProjectDirty();
  renderDesigner();
}

// A hidden container's children have no widget-level "hidden" of their own
// in real LVGL either - the whole subtree just disappears with the parent.
// Walks from the active surface's roots (not allWidgets()'s flat list,
// which has no ancestor information) so a child two levels under a hidden
// grandparent is still caught.
function effectivelyHiddenWidgets(nodes = activeWidgetRoots(), ancestorHidden = false, result = new Set()) {
  (nodes || []).forEach((widget) => {
    const hidden = ancestorHidden || Boolean(widget.hidden);
    if (hidden) result.add(widget);
    effectivelyHiddenWidgets(widget.children, hidden, result);
  });
  return result;
}

function visualWidgets() {
  // The layout engine resolves grid/flex/align placement; a widget with no
  // computed box (an unknown parent arrangement) falls back to its raw
  // coordinates so it stays reachable rather than vanishing.
  const boxes = computeLayout(activeSurfaceProject());
  const hiddenWidgets = effectivelyHiddenWidgets();
  return allWidgets().map((/** @type {any} */ widget) => {
    const box = boxes.get(widget);
    const effectivelyHidden = hiddenWidgets.has(widget);
    return box
      ? { widget, ...box, effectivelyHidden }
      : {
          widget,
          left: Number(widget.x) || 0,
          top: Number(widget.y) || 0,
          width: Number(widget.width) || 100,
          height: Number(widget.height) || 40,
          managed: false,
          originX: 0,
          originY: 0,
          effectivelyHidden,
        };
  });
}

function blankSurface() {
  return { widgets: [], layout: {}, style_tree: {}, extra: {} };
}

function uniquePageId() {
  const used = new Set([
    ...allProjectWidgets().map((widget) => widget.id),
    ...(state.project.pages || []).map((/** @type {any} */ page) => page.id),
    ...(state.project.colors || []).map((/** @type {any} */ item) => item.id),
    ...(state.project.fonts || []).map((/** @type {any} */ item) => item.id),
    ...(state.project.images || []).map((/** @type {any} */ item) => item.id),
    ...(state.project.styles || []).map((/** @type {any} */ item) => item.id),
    ...(state.project.reserved_ids || []),
  ]);
  let number = 1;
  while (used.has(`page_${number}`)) number += 1;
  return `page_${number}`;
}

function addPage() {
  ensureProjectSurfaces();
  pushUndo();
  const page = {
    id: uniquePageId(),
    synthetic_id: false,
    skip: false,
    ...blankSurface(),
  };
  if (!state.project.pages.length && state.project.widgets.length) {
    page.widgets = state.project.widgets;
    state.project.widgets = [];
    toast(t("toast.page.rootWidgetsMoved"));
  }
  state.project.pages.push(page);
  state.activeSurface = `page:${page.id}`;
  state.selectedWidget = null;
  markProjectDirty();
  renderDesigner();
}

function addLayer(/** @type {any} */ kind) {
  const property = kind === "top" ? "top_layer" : "bottom_layer";
  if (!state.project[property]) {
    pushUndo();
    state.project[property] = blankSurface();
    markProjectDirty();
  }
  selectSurface(kind);
}

function uniqueMsgboxId() {
  const used = new Set([
    ...allProjectWidgets().map((widget) => widget.id),
    ...(state.project.pages || []).map((/** @type {any} */ page) => page.id),
    ...(state.project.msgboxes || []).map((/** @type {any} */ msgbox) => msgbox.id),
    ...(state.project.colors || []).map((/** @type {any} */ item) => item.id),
    ...(state.project.fonts || []).map((/** @type {any} */ item) => item.id),
    ...(state.project.images || []).map((/** @type {any} */ item) => item.id),
    ...(state.project.styles || []).map((/** @type {any} */ item) => item.id),
    ...(state.project.reserved_ids || []),
  ]);
  let number = 1;
  while (used.has(`msgbox_${number}`)) number += 1;
  return `msgbox_${number}`;
}

function addMessageBox() {
  ensureProjectSurfaces();
  pushUndo();
  const msgbox = {
    id: uniqueMsgboxId(),
    synthetic_id: false,
    title: t("surface.msgboxDefaultTitle"),
    close_button: true,
    body: { text: "", style_tree: {}, extra: {} },
    buttons: [],
    header_buttons: [],
    extra: {},
  };
  state.project.msgboxes.push(msgbox);
  markProjectDirty();
  renderMsgboxList();
  openMsgboxDialog(msgbox);
}

function deleteMsgbox(/** @type {any} */ msgbox) {
  const widgetCount = allWidgets(msgbox.buttons).length + allWidgets(msgbox.header_buttons).length;
  if (!confirm(t("confirm.surface.remove", { label: msgbox.title || msgbox.id })
    + (widgetCount ? t("confirm.surface.removeWidgetsSuffix", { count: widgetCount }) : ""))) return;
  pushUndo();
  const index = state.project.msgboxes.indexOf(msgbox);
  if (index >= 0) state.project.msgboxes.splice(index, 1);
  markProjectDirty();
  renderMsgboxList();
}

// --- Message box dialog (Option B: a dedicated dialog instead of treating
// a msgbox's buttons/header_buttons as canvas surfaces - see the German
// chat discussion this was decided in). Buttons here are simplified: text +
// an optional "closes this message box" toggle (the overwhelmingly common
// case, see msgbox docs), not full canvas-editable widgets with styling.

function renderMsgboxList() {
  ensureProjectSurfaces();
  const list = $("#msgbox-list");
  list.replaceChildren();
  state.project.msgboxes.forEach((/** @type {any} */ msgbox) => {
    const row = document.createElement("div");
    row.className = "msgbox-list-item";
    const label = document.createElement("span");
    label.className = "msgbox-list-item-label";
    label.textContent = msgbox.title || msgbox.id;
    const meta = document.createElement("span");
    meta.className = "msgbox-list-item-meta";
    meta.textContent = t("dialog.msgbox.listMeta", {
      buttons: msgbox.buttons.length, headerButtons: msgbox.header_buttons.length,
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button subtle compact";
    edit.textContent = t("common.edit");
    edit.addEventListener("click", () => openMsgboxDialog(msgbox));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button danger compact";
    remove.textContent = t("surface.remove");
    remove.addEventListener("click", () => deleteMsgbox(msgbox));
    row.append(label, meta, edit, remove);
    list.append(row);
  });
}

function uniqueMsgboxButtonId(/** @type {any} */ base) {
  const used = new Set([
    ...allProjectWidgets().map((widget) => widget.id),
    ...(state.project.reserved_ids || []),
  ]);
  let number = 1;
  while (used.has(`${base}_${number}`)) number += 1;
  return `${base}_${number}`;
}

function blankMsgboxButton(/** @type {any} */ id, extra = {}) {
  return {
    id, widget_type: "button", name: "", x: 0, y: 0, width: null, height: null,
    align: "TOP_LEFT", align_to: "", hidden: false, locked: false,
    properties: {}, style_mode: "inline", style_refs: [], style_tree: {},
    events: {}, children: [], tab_title: "", tile_row: 0, tile_col: 0, tile_dir: "ALL",
    layout: {}, grid_cell: {}, extra, source: "editor", synthetic_id: false,
  };
}

function openMsgboxDialog(/** @type {any} */ msgbox) {
  state.editingMsgbox = msgbox;
  $("#msgbox-dialog-title").value = msgbox.title || "";
  $("#msgbox-dialog-close-button").checked = msgbox.close_button !== false;
  $("#msgbox-dialog-body-text").value = msgbox.body?.text || "";
  renderMsgboxDialogButtons();
  renderMsgboxDialogHeaderButtons();
  const dialog = $("#msgbox-dialog");
  if (!dialog.open) dialog.showModal();
}

function closeMsgboxDialog() {
  state.editingMsgbox = null;
  $("#msgbox-dialog").close();
  renderMsgboxList();
}

function renderMsgboxDialogButtons() {
  const msgbox = state.editingMsgbox;
  const container = $("#msgbox-dialog-buttons");
  container.replaceChildren();
  if (!msgbox) return;
  msgbox.buttons.forEach((/** @type {any} */ button) => {
    const row = document.createElement("div");
    row.className = "msgbox-dialog-row";
    const text = document.createElement("input");
    text.type = "text";
    text.value = button.properties?.text || "";
    text.placeholder = t("dialog.msgbox.buttonTextPlaceholder");
    text.addEventListener("input", () => {
      pushUndo();
      button.properties ||= {};
      button.properties.text = text.value;
      markProjectDirty();
    });
    const closes = document.createElement("label");
    closes.className = "checkbox-field";
    const closesInput = document.createElement("input");
    closesInput.type = "checkbox";
    closesInput.checked = Boolean(
      (button.events?.on_click || []).some((/** @type {any} */ action) => action?.["lvgl.widget.hide"] === msgbox.id),
    );
    closesInput.addEventListener("change", () => {
      pushUndo();
      button.events ||= {};
      if (closesInput.checked) {
        button.events.on_click = [{ "lvgl.widget.hide": msgbox.id }];
      } else {
        delete button.events.on_click;
      }
      markProjectDirty();
    });
    closes.append(closesInput, document.createTextNode(t("dialog.msgbox.closesThisBox")));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button danger compact";
    remove.textContent = "×";
    remove.title = t("surface.remove");
    remove.addEventListener("click", () => {
      pushUndo();
      const index = msgbox.buttons.indexOf(button);
      if (index >= 0) msgbox.buttons.splice(index, 1);
      markProjectDirty();
      renderMsgboxDialogButtons();
    });
    row.append(text, closes, remove);
    container.append(row);
  });
}

function renderMsgboxDialogHeaderButtons() {
  const msgbox = state.editingMsgbox;
  const container = $("#msgbox-dialog-header-buttons");
  container.replaceChildren();
  if (!msgbox) return;
  msgbox.header_buttons.forEach((/** @type {any} */ button) => {
    const row = document.createElement("div");
    row.className = "msgbox-dialog-row";
    const src = document.createElement("select");
    src.append(new Option("—", ""));
    imageLibrary().forEach((/** @type {any} */ entry) => src.append(new Option(entry.id, entry.id)));
    const currentSrc = button.extra?.src || "";
    if (currentSrc && !imageLibrary().some((/** @type {any} */ entry) => entry.id === currentSrc)) {
      src.append(new Option(t("dynprops.widgetRefMissing", { id: currentSrc }), currentSrc));
    }
    src.value = currentSrc;
    src.addEventListener("change", () => {
      pushUndo();
      button.extra ||= {};
      if (src.value) button.extra.src = src.value;
      else delete button.extra.src;
      markProjectDirty();
    });
    const closes = document.createElement("label");
    closes.className = "checkbox-field";
    const closesInput = document.createElement("input");
    closesInput.type = "checkbox";
    closesInput.checked = Boolean(
      (button.events?.on_click || []).some((/** @type {any} */ action) => action?.["lvgl.widget.hide"] === msgbox.id),
    );
    closesInput.addEventListener("change", () => {
      pushUndo();
      button.events ||= {};
      if (closesInput.checked) {
        button.events.on_click = [{ "lvgl.widget.hide": msgbox.id }];
      } else {
        delete button.events.on_click;
      }
      markProjectDirty();
    });
    closes.append(closesInput, document.createTextNode(t("dialog.msgbox.closesThisBox")));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button danger compact";
    remove.textContent = "×";
    remove.title = t("surface.remove");
    remove.addEventListener("click", () => {
      pushUndo();
      const index = msgbox.header_buttons.indexOf(button);
      if (index >= 0) msgbox.header_buttons.splice(index, 1);
      markProjectDirty();
      renderMsgboxDialogHeaderButtons();
    });
    row.append(src, closes, remove);
    container.append(row);
  });
}

function addMsgboxButton() {
  const msgbox = state.editingMsgbox;
  if (!msgbox) return;
  pushUndo();
  const button = blankMsgboxButton(uniqueMsgboxButtonId(`${msgbox.id}_button`));
  /** @type {any} */ (button.properties).text = t("dialog.msgbox.defaultButtonText");
  msgbox.buttons.push(button);
  markProjectDirty();
  renderMsgboxDialogButtons();
}

function addMsgboxHeaderButton() {
  const msgbox = state.editingMsgbox;
  if (!msgbox) return;
  pushUndo();
  msgbox.header_buttons.push(blankMsgboxButton(uniqueMsgboxButtonId(`${msgbox.id}_header_button`)));
  markProjectDirty();
  renderMsgboxDialogHeaderButtons();
}

function moveActivePage(/** @type {any} */ delta) {
  const entry = activeSurfaceEntry();
  if (entry.kind !== "page") return;
  const nextIndex = entry.index + delta;
  if (nextIndex < 0 || nextIndex >= state.project.pages.length) return;
  pushUndo();
  const [page] = state.project.pages.splice(entry.index, 1);
  state.project.pages.splice(nextIndex, 0, page);
  markProjectDirty();
  renderDesigner();
}

function deleteActiveSurface() {
  const entry = activeSurfaceEntry();
  if (entry.kind === "root") return;
  const widgetCount = allWidgets(entry.surface.widgets).length;
  if (!confirm(t("confirm.surface.remove", { label: entry.label })
    + (widgetCount ? t("confirm.surface.removeWidgetsSuffix", { count: widgetCount }) : ""))) return;
  pushUndo();
  if (entry.kind === "page") {
    const [removed] = state.project.pages.splice(entry.index, 1);
    if (!state.project.pages.length && removed.widgets.length) {
      state.project.widgets.push(...removed.widgets);
      toast(t("toast.page.lastPageRemoved"));
    }
  } else {
    state.project[entry.kind === "top" ? "top_layer" : "bottom_layer"] = null;
  }
  state.activeSurface = state.project.pages[0] ? `page:${state.project.pages[0].id}` : "root";
  state.selectedWidget = null;
  markProjectDirty();
  renderDesigner();
}

function parseSurfaceObject(/** @type {any} */ control, /** @type {any} */ label) {
  let value;
  try {
    value = JSON.parse(control.value || "{}");
  } catch (/** @type {any} */ error) {
    throw new Error(`${label}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(t("validation.json.mustBeObject", { label }));
  }
  return value;
}

function pageIdIsUsed(/** @type {any} */ id, /** @type {any} */ currentPage) {
  return (state.project.pages || []).some((/** @type {any} */ page) => page !== currentPage && page.id === id)
    || allProjectWidgets().some((widget) => widget.id === id)
    || ["colors", "fonts", "images", "styles"].some((key) =>
      (state.project[key] || []).some((/** @type {any} */ item) => item.id === id));
}

function applySurfaceSettings() {
  const entry = activeSurfaceEntry();
  const errorNode = $("#surface-error");
  const isRootSurface = entry.kind === "root";
  try {
    const styleTree = parseSurfaceObject($("#surface-style-json"), t("validation.surface.fieldStyle"));
    const bgColor = $("#surface-bg-color").value.trim();
    if (bgColor) styleTree.bg_color = normalizeActionColor(bgColor);
    if (isRootSurface) {
      pushUndo();
      state.project.extra_lvgl = styleTree;
      errorNode.classList.add("hidden");
      markProjectDirty();
      renderDesigner();
      toast(t("toast.surface.settingsApplied"));
      return;
    }
    const layout = parseSurfaceObject($("#surface-layout-json"), t("validation.surface.fieldLayout"));
    const extra = parseSurfaceObject($("#surface-extra-json"), t("validation.surface.fieldExtra"));
    let nextId = "";
    if (entry.kind === "page") {
      nextId = $("#surface-id").value.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nextId)) {
        throw new Error(t("validation.page.invalidId"));
      }
      if (pageIdIsUsed(nextId, entry.surface)) throw new Error(t("toast.id.alreadyUsed", { id: nextId }));
    }
    pushUndo();
    const previousId = entry.surface.id;
    entry.surface.layout = layout;
    entry.surface.style_tree = styleTree;
    entry.surface.extra = extra;
    if (entry.kind === "page" && nextId !== previousId) {
      entry.surface.id = nextId;
      entry.surface.synthetic_id = false;
      replaceProjectWidgetReferences(previousId, nextId);
      state.activeSurface = `page:${nextId}`;
    }
    errorNode.classList.add("hidden");
    markProjectDirty();
    renderDesigner();
    toast(t("toast.surface.settingsApplied"));
  } catch (/** @type {any} */ error) {
    errorNode.textContent = error.message;
    errorNode.classList.remove("hidden");
  }
}

function bindSurfaceTools() {
  $("#surface-select").addEventListener("change", (/** @type {any} */ event) => selectSurface(event.target.value));
  $("#add-page").addEventListener("click", addPage);
  $("#add-bottom-layer").addEventListener("click", () => addLayer("bottom"));
  $("#add-top-layer").addEventListener("click", () => addLayer("top"));
  $("#surface-up").addEventListener("click", () => moveActivePage(-1));
  $("#surface-down").addEventListener("click", () => moveActivePage(1));
  $("#delete-surface").addEventListener("click", deleteActiveSurface);
  $("#page-wrap").addEventListener("change", (/** @type {any} */ event) => {
    pushUndo();
    state.project.page_wrap = event.target.checked;
    markProjectDirty();
    renderDesigner();
  });
  $("#surface-skip").addEventListener("change", (/** @type {any} */ event) => {
    const entry = activeSurfaceEntry();
    if (entry.kind !== "page") return;
    pushUndo();
    entry.surface.skip = event.target.checked;
    markProjectDirty();
    renderDesigner();
  });
  $("#apply-surface").addEventListener("click", applySurfaceSettings);
}

function bindMsgboxDialog() {
  $("#add-msgbox").addEventListener("click", addMessageBox);
  $("#close-msgbox-dialog").addEventListener("click", closeMsgboxDialog);
  $("#msgbox-dialog-done").addEventListener("click", closeMsgboxDialog);
  $("#msgbox-dialog").addEventListener("close", () => { state.editingMsgbox = null; renderMsgboxList(); });
  $("#msgbox-dialog").addEventListener("cancel", (/** @type {any} */ event) => {
    event.preventDefault();
    closeMsgboxDialog();
  });
  $("#msgbox-dialog-title").addEventListener("focus", pushUndo);
  $("#msgbox-dialog-title").addEventListener("input", () => {
    if (!state.editingMsgbox) return;
    state.editingMsgbox.title = $("#msgbox-dialog-title").value;
    markProjectDirty();
  });
  $("#msgbox-dialog-close-button").addEventListener("change", () => {
    if (!state.editingMsgbox) return;
    pushUndo();
    state.editingMsgbox.close_button = $("#msgbox-dialog-close-button").checked;
    markProjectDirty();
  });
  $("#msgbox-dialog-body-text").addEventListener("focus", pushUndo);
  $("#msgbox-dialog-body-text").addEventListener("input", () => {
    if (!state.editingMsgbox) return;
    state.editingMsgbox.body.text = $("#msgbox-dialog-body-text").value;
    markProjectDirty();
  });
  $("#msgbox-dialog-add-button").addEventListener("click", addMsgboxButton);
  $("#msgbox-dialog-add-header-button").addEventListener("click", addMsgboxHeaderButton);
}

function renderSurfaceToolbar() {
  const entries = surfaceEntries();
  const entry = activeSurfaceEntry();
  renderPalette();
  const select = $("#surface-select");
  select.replaceChildren(...entries.map((item) => new Option(item.label, item.key)));
  select.value = entry.key;
  $("#add-bottom-layer").disabled = Boolean(state.project.bottom_layer);
  $("#add-top-layer").disabled = Boolean(state.project.top_layer);
  $("#surface-up").disabled = entry.kind !== "page" || entry.index === 0;
  $("#surface-down").disabled = entry.kind !== "page" || entry.index === state.project.pages.length - 1;
  $("#delete-surface").disabled = entry.kind === "root";
  $("#surface-skip-field").classList.toggle("hidden", entry.kind !== "page");
  $("#surface-skip").checked = Boolean(entry.surface.skip);
  $("#page-wrap-field").classList.toggle("hidden", state.project.pages.length < 2);
  $("#page-wrap").checked = state.project.page_wrap !== false;
  $("#surface-id-field").classList.toggle("hidden", entry.kind !== "page");
  const isRootSurface = entry.kind === "root";
  // Root has no page-like layout/extra passthrough of its own - both live
  // inside extra_lvgl already, which the style JSON field below edits whole.
  $("#surface-layout-field").classList.toggle("hidden", isRootSurface);
  $("#surface-extra-field").classList.toggle("hidden", isRootSurface);
  $("#surface-id").value = entry.kind === "page" ? entry.surface.id : "";
  if (isRootSurface) {
    const rootStyle = state.project.extra_lvgl || {};
    $("#surface-layout-json").value = "{}";
    $("#surface-bg-color").value = rootStyle.bg_color || "";
    $("#surface-style-json").value = JSON.stringify(rootStyle, null, 2);
    $("#surface-extra-json").value = "{}";
  } else {
    $("#surface-layout-json").value = JSON.stringify(entry.surface.layout || {}, null, 2);
    $("#surface-bg-color").value = entry.surface.style_tree?.bg_color || "";
    $("#surface-style-json").value = JSON.stringify(entry.surface.style_tree || {}, null, 2);
    $("#surface-extra-json").value = JSON.stringify(entry.surface.extra || {}, null, 2);
  }
  syncLinkedColorPickers();
  $("#surface-error").classList.add("hidden");
  $("#line-tool-group").classList.toggle("hidden", state.canvasMode !== "lines" || entry.kind !== "root");
}

function renderDesigner() {
  normaliseActiveSurface();
  renderSurfaceToolbar();
  renderCanvas();
  renderBackgroundFields();
  renderProperties();
  renderLineProperties();
  renderTree();
  renderThemeEditor();
  renderColorLibrary();
  renderFontLibrary();
  renderMsgboxList();
  renderDesignerStatus();
  updateUndoButtons();
}

function renderCanvas() {
  const canvas = $("#canvas");
  configureCanvas(canvas, state.project, state.canvasMode, state.lineTool);
  $("#canvas-width").value = state.project.canvas.width;
  $("#canvas-height").value = state.project.canvas.height;

  // Order matters: background, then the glow-line overlay for lines with no
  // parent (a decorative layer that stays behind everything), then widgets,
  // then a second glow-line overlay for lines nested under a container (so
  // that container's own background can't paint over its own child line -
  // widgets are flat DOM siblings here, not actually nested, so a container's
  // "children" only render on top of it if something puts them there), then
  // the edit handles on top of everything so they stay grabbable.
  const { back: glowCanvasBack, front: glowCanvasFront, handles } = createCanvasLayers(document);
  canvas.replaceChildren(renderCanvasBackground(), glowCanvasBack);
  canvasNodeByWidget.clear();
  visualWidgets().forEach((/** @type {any} */ item) => {
    const node = renderWidget(item);
    canvasNodeByWidget.set(item.widget, node);
    canvas.append(node);
  });
  canvas.append(glowCanvasFront, handles);

  fontLibrary().forEach((/** @type {any} */ font) => ensureFontLoaded(font.id));

  const totalWidgetCount = allProjectWidgets().length;
  $("#widget-count").textContent = (state.project.pages || []).length
    ? t("designer.status.pagesAndWidgets", { pages: state.project.pages.length, widgets: totalWidgetCount })
    : t("designer.status.widgetCount", { count: totalWidgetCount });
  applyZoom();
  renderGlowCanvas();
  renderGlowHandles();
  applyDesignerRuntimePreview();
}

function renderCanvasBackground() {
  const layer = document.createElement("div");
  layer.id = "canvas-background";
  layer.className = "canvas-background";
  const background = state.project.background || {};
  // A remote path is the exported source and can be shown directly; the local
  // preview is the editor-only fallback for mockups that never get exported.
  const source = isRemoteAsset(background.path)
    ? background.path
    : state.backgroundPreview;
  if (source) {
    // Escape for a quoted url() token - CSS.escape() is for identifiers and
    // would mangle the URL's own separators.
    const escaped = String(source).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    layer.style.backgroundImage = `url("${escaped}")`;
    layer.style.opacity = String(clamp(Number(background.opacity_in_editor ?? 40), 0, 100) / 100);
  }
  const surfaceStyle = activeSurfaceEntry().kind === "root"
    ? (state.project.extra_lvgl || {})
    : (activeSurfaceEntry().surface.style_tree || {});
  const surfaceColor = resolveViewerColor(state.project, surfaceStyle.bg_color);
  const surfaceGradient = viewerGradientBackground(state.project, surfaceStyle);
  if (surfaceColor) layer.style.backgroundColor = surfaceColor;
  if (surfaceGradient) layer.style.backgroundImage = surfaceGradient;
  return layer;
}

function renderBackgroundFields() {
  const background = state.project.background || {};
  $("#bg-path").value = background.path || "";
  $("#bg-image-id").value = background.image_id || "bg_image";
  $("#bg-export").checked = Boolean(background.export_as_lvgl_image);
  $("#bg-opacity").value = Number(background.opacity_in_editor ?? 40);
  $("#bg-preview-clear").disabled = !state.backgroundPreview;
}

function updateBackgroundFields() {
  const background = state.project.background || (state.project.background = {});
  background.path = $("#bg-path").value;
  background.image_id = $("#bg-image-id").value || "bg_image";
  background.export_as_lvgl_image = $("#bg-export").checked;
  background.opacity_in_editor = clamp(Number($("#bg-opacity").value), 0, 100);
  markProjectDirty();
  renderCanvas();
}

async function loadBackgroundPreview(/** @type {any} */ event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast(t("toast.preview.tooLarge8MB"), true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.backgroundPreview = reader.result;
    $("#bg-preview-clear").disabled = false;
    renderCanvas();
    toast(t("toast.preview.loaded"));
  };
  reader.onerror = () => toast(t("toast.preview.readFailed"), true);
  reader.readAsDataURL(file);
}

function clearBackgroundPreview() {
  state.backgroundPreview = null;
  $("#bg-preview-clear").disabled = true;
  renderCanvas();
}

function renderDesignerStatus() {
  const name = state.projectName || t("designer.status.localProject");
  $("#designer-status").textContent = `${state.projectDirty ? t("designer.status.unsavedPrefix") : ""}${name}`;
}

// --- Glow lines (ported GlowLine editor) ------------------------------------
//
// Editing widgets and editing lines are mutually exclusive modes (state.
// canvasMode), matching the desktop app being a separate tool from the LVGL
// designer: mixing hit-testing for both under one cursor model would be a lot
// of complexity for a case that rarely overlaps in practice.

function bindGlowTools() {
  $("#tool-select").addEventListener("click", () => setLineTool("select"));
  $("#tool-draw").addEventListener("click", () => {
    // No dedicated "start a blank line" action anymore (a new line already
    // comes with a default segment) - picking this tool with a line selected
    // resumes appending points to that line's shape instead.
    if (state.selectedStroke && !state.drawingStroke) state.drawingStroke = state.selectedStroke;
    setLineTool("draw");
  });
  $("#line-done").addEventListener("click", () => setCanvasMode("widgets"));
  $("#line-delete").addEventListener("click", deleteSelectedStroke);
  $("#delete-line").addEventListener("click", deleteSelectedStroke);
  $("#line-preview").addEventListener("click", toggleFlowPreview);

  const canvas = $("#canvas");
  canvas.addEventListener("pointerdown", onGlowPointerDown);
  canvas.addEventListener("dblclick", onGlowDoubleClick);
  canvas.addEventListener("contextmenu", onGlowContextMenu);
  // Clicking empty canvas space (not a widget, not a resize/glow handle)
  // deselects the current widget - `beginDrag()` only ever sets a selection,
  // it never had a matching way to clear one.
  canvas.addEventListener("click", (/** @type {any} */ event) => {
    if (state.canvasMode !== "widgets") return;
    if (event.target.closest(".canvas-widget, .resize-handle")) return;
    if (!state.selectedWidget) return;
    state.selectedWidget = null;
    renderProperties();
    renderTree();
    $$(".canvas-widget.selected").forEach((item) => item.classList.remove("selected"));
  });

  $$(".colorwheel-target .button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.colorWheelTarget = btn.dataset.wheelTarget;
      $$(".colorwheel-target .button").forEach((b) => b.classList.toggle("active", b === btn));
      renderColorWheelReadout();
    });
  });
  $("#color-wheel").addEventListener("pointerdown", (/** @type {any} */ event) => {
    onColorWheelPick(event);
    const move = (/** @type {any} */ moveEvent) => onColorWheelPick(moveEvent);
    const up = () => window.removeEventListener("pointermove", move);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  });
  $("#color-wheel-value").addEventListener("input", drawColorWheel);

  bindLinePropertyInputs();
}

function setCanvasMode(/** @type {any} */ mode) {
  if (mode !== "widgets") stopFlowPreview();
  state.canvasMode = mode;
  if (mode === "widgets") {
    state.selectedStroke = null;
    state.drawingStroke = null;
    state.lineTool = "select";
  } else {
    state.selectedWidget = null;
  }
  $("#line-tool-group").classList.toggle("hidden", mode !== "lines");
  $("#tool-select").classList.toggle("active", state.lineTool === "select");
  $("#tool-draw").classList.toggle("active", state.lineTool === "draw");
  renderDesigner();
}

function setLineTool(/** @type {any} */ tool) {
  state.lineTool = tool;
  if (tool === "select") state.drawingStroke = null;
  $("#tool-select").classList.toggle("active", tool === "select");
  $("#tool-draw").classList.toggle("active", tool === "draw");
  $("#canvas").classList.toggle("tool-select", tool === "select");
  renderGlowHandles();
}

function uniqueStrokeId() {
  const ids = new Set((state.project.glow_strokes || []).map((/** @type {any} */ s) => s.id));
  let n = 1;
  while (ids.has(`line_${n}`)) n += 1;
  return `line_${n}`;
}

function startNewLine() {
  if (activeSurfaceEntry().kind !== "root") {
    toast(t("toast.glow.projectWide"), true);
    return;
  }
  // Capture the intended parent before switching modes - entering lines mode
  // clears state.selectedWidget, the same way addWidget() reads it before
  // any mode change to decide which container a new widget nests under.
  const parentSchema = state.selectedWidget
    ? state.schemas.find((/** @type {any} */ item) => item.type_key === state.selectedWidget.widget_type)
    : null;
  const parent = parentSchema?.allows_children ? state.selectedWidget : null;

  if (state.canvasMode !== "lines") setCanvasMode("lines");
  pushUndo();
  if (!Array.isArray(state.project.glow_strokes)) state.project.glow_strokes = [];
  const stroke = freshGlowStroke(uniqueStrokeId());
  stroke.parent_id = parent ? parent.id : "";
  // Like addWidget(), this places a ready-made shape (a short default
  // segment) rather than an empty placeholder - a line is immediately
  // visible, selected and draggable, the same as any other widget added
  // from the palette. The old behaviour (start blank, click out each point,
  // Enter/double-click to finish) is still available via the "Linie
  // zeichnen" tool once a line is selected - it now appends to whichever
  // line is selected instead of only ever starting a fresh one.
  const offset = (state.project.glow_strokes.length * 12) % 100;
  /** @type {any} */ (stroke).points = [[40 + offset, 40 + offset], [120 + offset, 40 + offset]];
  state.project.glow_strokes.push(stroke);
  state.selectedStroke = stroke;
  markProjectDirty();
  setLineTool("select");
  renderDesigner();
}

function removeStroke(/** @type {any} */ stroke) {
  const list = state.project.glow_strokes || [];
  const index = list.indexOf(stroke);
  if (index >= 0) list.splice(index, 1);
}

function deleteSelectedStroke() {
  if (!state.selectedStroke) return;
  pushUndo();
  removeStroke(state.selectedStroke);
  state.selectedStroke = null;
  markProjectDirty();
  renderDesigner();
}

function finishDrawing() {
  const stroke = state.drawingStroke;
  state.drawingStroke = null;
  if (stroke && stroke.points.length < 2) {
    // A line needs at least two points; a stray click produced nothing usable.
    removeStroke(stroke);
    state.selectedStroke = null;
  }
  setLineTool("select");
  renderDesigner();
}

/** Pointer position in canvas image coordinates (undoes the zoom transform). */
function canvasPointFromEvent(/** @type {any} */ event) {
  const rect = $("#canvas").getBoundingClientRect();
  return pointFromClient(event.clientX, event.clientY, rect, state.zoom);
}

function onGlowPointerDown(/** @type {any} */ event) {
  if (state.canvasMode !== "lines" || event.target.closest(".glow-handle")) return;
  const point = canvasPointFromEvent(event);

  if (state.lineTool === "draw") {
    placeDrawPoint(point, event);
    return;
  }
  const hit = findStrokeAt(point);
  state.selectedStroke = hit;
  if (hit && !hit.locked) beginLineBodyDrag(event, hit, point);
  renderDesigner();
}

function placeDrawPoint(/** @type {any} */ rawPoint, /** @type {any} */ event) {
  const stroke = state.drawingStroke;
  if (!stroke) return;
  let point = rawPoint;
  if (stroke.points.length) {
    const prev = stroke.points[stroke.points.length - 1];
    if (event.shiftKey) point = snapAngle(prev, point, Math.PI / 4);
    else if (event.ctrlKey) point = snapAngle(prev, point, Math.PI / 2);
  }
  // Clicking back on the first point closes the line into a ring.
  if (stroke.points.length >= 2) {
    const first = stroke.points[0];
    if (Math.hypot(point[0] - first[0], point[1] - first[1]) < 8 / state.zoom) {
      stroke.closed = true;
      finishDrawing();
      return;
    }
  }
  stroke.points.push(point);
  markProjectDirty();
  renderGlowCanvas();
  renderGlowHandles();
}

function onGlowDoubleClick(/** @type {any} */ event) {
  if (state.canvasMode !== "lines") return;
  event.preventDefault();
  if (state.lineTool === "draw" && state.drawingStroke) {
    finishDrawing();
    return;
  }
  if (state.lineTool === "select" && state.selectedStroke) {
    const point = canvasPointFromEvent(event);
    const stroke = state.selectedStroke;
    const hit = nearestSegment(stroke.points, point, stroke.closed);
    if (hit.index !== null) {
      pushUndo();
      stroke.points.splice(hit.index, 0, hit.point);
      markProjectDirty();
      renderDesigner();
    }
  }
}

function onGlowContextMenu(/** @type {any} */ event) {
  if (state.canvasMode !== "lines") return;
  event.preventDefault();
  if (state.lineTool === "draw" && state.drawingStroke) finishDrawing();
}

/**
 * Line under `point`, tested against the control polygon (straight segments
 * between the stored points) rather than the rendered curve. A reasonable
 * approximation for picking - it can be slightly generous near a large
 * corner radius or a spline bulge, which only ever widens the click target.
 */
function findStrokeAt(/** @type {any} */ point) {
  let best = null;
  let bestDistance = Infinity;
  for (const stroke of state.project.glow_strokes || []) {
    if ((stroke.points || []).length < 2) continue;
    const hit = nearestSegment(stroke.points, point, stroke.closed);
    if (hit.index === null) continue;
    const tolerance = Math.max(6, stroke.width / 2 + 4) / state.zoom;
    if (hit.distance <= tolerance && hit.distance < bestDistance) {
      bestDistance = hit.distance;
      best = stroke;
    }
  }
  return best;
}

function beginLineBodyDrag(/** @type {any} */ event, /** @type {any} */ stroke, /** @type {any} */ startPoint) {
  pushUndo();
  const target = event.target;
  const originPoints = stroke.points.map((/** @type {any} */ p) => [...p]);
  const handles = $("#glow-handles");
  handles.style.visibility = "hidden";
  target.setPointerCapture(event.pointerId);
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end, { once: true });
  function move(/** @type {any} */ moveEvent) {
    const [x, y] = canvasPointFromEvent(moveEvent);
    const dx = x - startPoint[0];
    const dy = y - startPoint[1];
    stroke.points = translatePoints(originPoints, dx, dy);
    markProjectDirty();
    renderGlowCanvas();
  }
  function end() {
    target.removeEventListener("pointermove", move);
    handles.style.visibility = "visible";
    renderGlowHandles();
    renderDesignerStatus();
  }
}

function beginPointDrag(/** @type {any} */ event, /** @type {any} */ stroke, /** @type {any} */ index) {
  pushUndo();
  const handle = event.target;
  handle.setPointerCapture(event.pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end, { once: true });
  function move(/** @type {any} */ moveEvent) {
    let point = canvasPointFromEvent(moveEvent);
    if (moveEvent.ctrlKey || moveEvent.shiftKey) {
      const neighbourIndex = index === 0 ? 1 : index - 1;
      const neighbour = stroke.points[neighbourIndex];
      if (neighbour) point = snapAngle(neighbour, point, moveEvent.shiftKey ? Math.PI / 4 : Math.PI / 2);
    }
    stroke.points[index] = point;
    handle.style.left = `${point[0]}px`;
    handle.style.top = `${point[1]}px`;
    markProjectDirty();
    renderGlowCanvas();
  }
  function end() {
    handle.removeEventListener("pointermove", move);
    renderDesignerStatus();
  }
}

function renderGlowCanvas() {
  const back = $("#glow-canvas-back");
  const front = $("#glow-canvas-front");
  if (!back || !front) return;
  [back, front].forEach((canvas) => {
    canvas.width = state.project.canvas.width;
    canvas.height = state.project.canvas.height;
  });
  if (activeSurfaceEntry().kind !== "root") {
    back.getContext("2d").clearRect(0, 0, back.width, back.height);
    front.getContext("2d").clearRect(0, 0, front.width, front.height);
    return;
  }
  drawGlowFrame(0);
}

function drawGlowFrame(/** @type {any} */ phase) {
  const back = $("#glow-canvas-back");
  const front = $("#glow-canvas-front");
  if (!back || !front) return;
  const strokes = (state.project.glow_strokes || []).filter((/** @type {any} */ stroke) => !stroke.hidden);
  const backStrokes = strokes.filter((/** @type {any} */ stroke) => !stroke.parent_id);
  const frontStrokes = strokes.filter((/** @type {any} */ stroke) => stroke.parent_id);
  const backCtx = back.getContext("2d");
  backCtx.clearRect(0, 0, back.width, back.height);
  drawDocument(backCtx, { strokes: backStrokes }, { quality: "final", phase, withFlow: true });
  const frontCtx = front.getContext("2d");
  frontCtx.clearRect(0, 0, front.width, front.height);
  drawDocument(frontCtx, { strokes: frontStrokes }, { quality: "final", phase, withFlow: true });
}

function renderGlowHandles() {
  const layer = $("#glow-handles");
  if (!layer) return;
  layer.replaceChildren();
  if (state.canvasMode !== "lines" || !state.selectedStroke) return;
  const stroke = state.selectedStroke;
  if (stroke.locked) return; // locked: selectable, but points aren't draggable or deletable
  stroke.points.forEach((/** @type {any} */ point, /** @type {any} */ index) => {
    const handle = document.createElement("div");
    handle.className = `glow-handle${index === 0 ? " first" : ""}`;
    handle.style.left = `${point[0]}px`;
    handle.style.top = `${point[1]}px`;
    handle.title = index === 0 ? t("glow.firstPointTitle") : t("glow.pointNTitle", { index: index + 1 });
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      if (state.lineTool === "draw") return; // the canvas handler places points instead
      beginPointDrag(event, stroke, index);
    });
    handle.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (stroke.points.length <= 2) {
        toast(t("toast.glow.needsTwoPoints"), true);
        return;
      }
      pushUndo();
      stroke.points.splice(index, 1);
      markProjectDirty();
      renderDesigner();
    });
    layer.append(handle);
  });
}

function stopFlowPreview() {
  if (state.flowPreviewTimer) {
    cancelAnimationFrame(state.flowPreviewTimer);
    state.flowPreviewTimer = null;
    $("#line-preview")?.classList.remove("active");
  }
}

function toggleFlowPreview() {
  if (state.flowPreviewTimer) {
    stopFlowPreview();
    renderGlowCanvas();
    return;
  }
  if (!hasFlow({ strokes: state.project.glow_strokes || [] })) {
    toast(t("toast.glow.noActiveFlow"), true);
    return;
  }
  $("#line-preview").classList.add("active");
  const start = performance.now();
  const loopMs = 1500; // arbitrary preview speed - export timing is independent
  const tick = (/** @type {any} */ now) => {
    drawGlowFrame(((now - start) / loopMs) % 1);
    state.flowPreviewTimer = requestAnimationFrame(tick);
  };
  state.flowPreviewTimer = requestAnimationFrame(tick);
}

// --- Line properties + RGB565 colour wheel ----------------------------------

function renderLineProperties() {
  const stroke = state.canvasMode === "lines" ? state.selectedStroke : null;
  $("#empty-line-properties").classList.toggle("hidden", state.canvasMode !== "lines" || Boolean(stroke));
  $("#line-properties").classList.toggle("hidden", !stroke);
  $("#line-delete").disabled = !stroke;
  if (!stroke) return;

  $("#line-name").value = stroke.name;
  $("#line-width").value = stroke.width;
  $("#line-corner-radius").value = stroke.corner_radius;
  $("#line-mode").value = stroke.mode;
  $("#line-closed").checked = stroke.closed;

  $("#glow-enabled").checked = stroke.glow.enabled;
  $("#glow-radius").value = stroke.glow.radius;
  $("#glow-intensity").value = stroke.glow.intensity;
  $("#glow-use-line-color").checked = stroke.glow.use_line_color;

  $("#flow-enabled").checked = stroke.flow.enabled;
  $("#flow-mode").value = stroke.flow.mode;
  $("#flow-reversed").checked = stroke.flow.reversed;
  $("#flow-spacing").value = stroke.flow.spacing;
  $("#flow-size").value = stroke.flow.size;
  $("#flow-width").value = stroke.flow.width;
  $("#flow-glow-radius").value = stroke.flow.glow_radius;
  $("#flow-use-line-color").checked = stroke.flow.use_line_color;
  $("#flow-bidirectional").checked = stroke.flow.bidirectional;
  $("#bake-frame-count").value = stroke.flow.bake_frame_count;
  $("#bake-crop").checked = stroke.flow.bake_crop;

  renderGlowFlowBinding(stroke);

  drawColorWheel();
  renderColorWheelReadout();
}

function glowFlowBinding(/** @type {any} */ stroke) {
  return (state.project.bindings || []).find(
    (/** @type {any} */ binding) => binding.target?.glow_stroke_id === stroke?.id
      && binding.target?.property === "flow_direction",
  ) || null;
}

function renderGlowFlowBinding(/** @type {any} */ stroke) {
  const binding = glowFlowBinding(stroke);
  const select = $("#flow-binding-entity");
  select.replaceChildren(new Option("— Sensor wählen —", ""));
  (state.project.entities || [])
    .filter((/** @type {any} */ entity) => entity.readable && entity.data_type === "number")
    .forEach((/** @type {any} */ entity) => select.append(
      new Option(`${entity.domain}.${entity.id}${entity.unit ? ` · ${entity.unit}` : ""}`, entity.id),
    ));
  select.value = binding?.source?.id || "";
  const transform = binding?.transform || {};
  $("#flow-binding-off").value = transform.off_threshold ?? 0;
  $("#flow-binding-fast").value = transform.fast_threshold ?? 1000;
  $("#flow-binding-normal").value = transform.normal_duration ?? 900;
  $("#flow-binding-fast-duration").value = transform.fast_duration ?? 300;
  $("#remove-flow-binding").disabled = !binding;
  $("#flow-binding-error").classList.add("hidden");
}

function saveGlowFlowBinding() {
  const stroke = state.selectedStroke;
  const error = $("#flow-binding-error");
  const entityId = $("#flow-binding-entity").value;
  const entity = (state.project.entities || []).find(
    (/** @type {any} */ item) => item.id === entityId && item.readable && item.data_type === "number",
  );
  const fail = (/** @type {string} */ message) => {
    error.textContent = message;
    error.classList.remove("hidden");
  };
  if (!stroke?.flow?.enabled || !stroke.flow.bidirectional) {
    fail("Für diese Bindung müssen Fluss und bidirektionaler Modus aktiviert sein.");
    return;
  }
  if (!entity) {
    fail("Bitte einen numerischen ESPHome-Sensor auswählen.");
    return;
  }
  const off = Math.max(0, Number($("#flow-binding-off").value) || 0);
  const fast = Number($("#flow-binding-fast").value) || 0;
  const normalDuration = Math.max(10, Number($("#flow-binding-normal").value) || 0);
  const fastDuration = Math.max(10, Number($("#flow-binding-fast-duration").value) || 0);
  if (fast <= off) {
    fail("Der Schnell-Schwellwert muss größer als die Totzone sein.");
    return;
  }
  const baseName = strokeBaseName(stroke);
  const existing = glowFlowBinding(stroke);
  const binding = {
    id: existing?.id || defaultBindingId(`${stroke.id}_flow`, entity.id),
    direction: "entity_to_widget",
    source: { domain: entity.domain, id: entity.id },
    target: {
      widget_id: `${baseName}_anim`,
      reverse_widget_id: `${baseName}_anim_rev`,
      glow_stroke_id: stroke.id,
      property: "flow_direction",
    },
    transform: {
      off_threshold: off,
      fast_threshold: fast,
      normal_duration: normalDuration,
      fast_duration: fastDuration,
    },
    conditions: [],
  };
  pushUndo();
  state.project.bindings = upsertDeviceBinding(state.project.bindings || [], binding);
  markProjectDirty();
  renderGlowFlowBinding(stroke);
}

function removeGlowFlowBinding() {
  const stroke = state.selectedStroke;
  const binding = glowFlowBinding(stroke);
  if (!binding) return;
  pushUndo();
  state.project.bindings = (state.project.bindings || []).filter(
    (/** @type {any} */ item) => item.id !== binding.id,
  );
  markProjectDirty();
  renderGlowFlowBinding(stroke);
}

function bindLinePropertyInputs() {
  const num = (/** @type {any} */ raw, fallback = 0) => (raw === "" ? fallback : Number(raw));
  const onText = (/** @type {any} */ id, /** @type {any} */ apply) => {
    const el = $(id);
    el.addEventListener("focus", pushUndo);
    el.addEventListener("input", () => {
      if (!state.selectedStroke) return;
      apply(state.selectedStroke, el);
      markProjectDirty();
      renderGlowCanvas();
    });
  };
  const onCheck = (/** @type {any} */ id, /** @type {any} */ apply) => {
    $(id).addEventListener("change", (/** @type {any} */ event) => {
      if (!state.selectedStroke) return;
      pushUndo();
      apply(state.selectedStroke, event.target);
      markProjectDirty();
      renderGlowCanvas();
    });
  };
  const onSelect = (/** @type {any} */ id, /** @type {any} */ apply) => {
    $(id).addEventListener("change", (/** @type {any} */ event) => {
      if (!state.selectedStroke) return;
      pushUndo();
      apply(state.selectedStroke, event.target.value);
      markProjectDirty();
      renderGlowCanvas();
    });
  };

  onText("#line-name", (/** @type {any} */ s, /** @type {any} */ el) => { s.name = el.value; });
  onText("#line-width", (/** @type {any} */ s, /** @type {any} */ el) => { s.width = Math.max(0.5, num(el.value, 1)); });
  onText("#line-corner-radius", (/** @type {any} */ s, /** @type {any} */ el) => { s.corner_radius = Math.max(0, num(el.value, 0)); });
  onSelect("#line-mode", (/** @type {any} */ s, /** @type {any} */ value) => { s.mode = value; });
  onCheck("#line-closed", (/** @type {any} */ s, /** @type {any} */ el) => { s.closed = el.checked; });

  onCheck("#glow-enabled", (/** @type {any} */ s, /** @type {any} */ el) => { s.glow.enabled = el.checked; });
  onText("#glow-radius", (/** @type {any} */ s, /** @type {any} */ el) => { s.glow.radius = Math.max(0, num(el.value)); });
  onText("#glow-intensity", (/** @type {any} */ s, /** @type {any} */ el) => { s.glow.intensity = clamp(num(el.value), 0, 1); });
  onCheck("#glow-use-line-color", (/** @type {any} */ s, /** @type {any} */ el) => { s.glow.use_line_color = el.checked; });

  onCheck("#flow-enabled", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.enabled = el.checked; });
  onSelect("#flow-mode", (/** @type {any} */ s, /** @type {any} */ value) => { s.flow.mode = value; });
  onCheck("#flow-reversed", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.reversed = el.checked; });
  onText("#flow-spacing", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.spacing = Math.max(1, num(el.value, 40)); });
  onText("#flow-size", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.size = Math.max(1, num(el.value, 14)); });
  onText("#flow-width", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.width = Math.max(0, num(el.value)); });
  onText("#flow-glow-radius", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.glow_radius = Math.max(0, num(el.value)); });
  onCheck("#flow-use-line-color", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.use_line_color = el.checked; });
  onCheck("#flow-bidirectional", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.bidirectional = el.checked; });
  onText("#bake-frame-count", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.bake_frame_count = clamp(num(el.value, 6), 1, 60); });
  onCheck("#bake-crop", (/** @type {any} */ s, /** @type {any} */ el) => { s.flow.bake_crop = el.checked; });
}

function colorWheelTargetObject(/** @type {any} */ stroke) {
  if (state.colorWheelTarget === "glow") return stroke.glow;
  if (state.colorWheelTarget === "flow") return stroke.flow;
  return stroke;
}

/**
 * Every pixel of the wheel is run through RGB565, so the quantisation steps
 * are visible - the preview then shows what an RGB565 display actually shows,
 * not the continuous colour a desktop screen would render.
 */
function drawColorWheel() {
  const canvas = $("#color-wheel");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 2;
  const value = Number($("#color-wheel-value").value || 1);
  const image = ctx.createImageData(w, h);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const i = (y * w + x) * 4;
      if (r > radius) continue; // left transparent (alpha already 0)
      const hue = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
      const sat = Math.min(1, r / radius);
      const [rr, gg, bb] = hsvToRgb(hue, sat, value);
      const [qr, qg, qb] = rgb565to888(rgb888to565(rr, gg, bb));
      image.data[i] = qr;
      image.data[i + 1] = qg;
      image.data[i + 2] = qb;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function onColorWheelPick(/** @type {any} */ event) {
  const stroke = state.selectedStroke;
  if (!stroke) return;
  const canvas = $("#color-wheel");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 2;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.min(radius, Math.hypot(dx, dy));
  const hue = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
  const sat = r / radius;
  const value = Number($("#color-wheel-value").value || 1);
  const [rr, gg, bb] = hsvToRgb(hue, sat, value);

  pushUndo();
  colorWheelTargetObject(stroke).color565 = rgb888to565(rr, gg, bb);
  markProjectDirty();
  renderGlowCanvas();
  renderColorWheelReadout();
}

function renderColorWheelReadout() {
  const readout = $("#color-wheel-readout");
  if (!readout) return;
  const stroke = state.selectedStroke;
  readout.textContent = stroke ? format565(colorWheelTargetObject(stroke).color565) : "";
}

// --- Baking: line -> image sequence -> widgets ------------------------------
//
// The browser equivalent of glowline-editor's "Export for a display" dialog:
// render the static line once, the flow markers as a cropped, looping
// sequence, quantise every pixel to RGB565 (so the preview matches what the
// device will actually show), upload each PNG through the asset-store
// endpoint, and wire up an image + animimg widget pair referencing them.

/** @returns {Promise<Blob>} */
function renderStrokeFrame(/** @type {any} */ doc, /** @type {any} */ rect, /** @type {any} */ { withLines, withFlow, phase }) {
  return new Promise((resolve, reject) => {
    const width = Math.max(1, Math.ceil(rect.right - rect.left));
    const height = Math.max(1, Math.ceil(rect.bottom - rect.top));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      reject(new Error("Canvas-Rendering-Kontext ist nicht verfügbar."));
      return;
    }
    ctx.translate(-rect.left, -rect.top);
    drawDocument(ctx, doc, { quality: "export", phase, withLines, withFlow });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Every pixel run through RGB565 before it leaves the browser - otherwise
    // the exported PNG shows colours the target display cannot reproduce.
    const image = ctx.getImageData(0, 0, width, height);
    quantizeImageData(image);
    ctx.putImageData(image, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG-Erzeugung ist fehlgeschlagen."));
    }, "image/png");
  });
}

async function uploadBakedFrame(/** @type {any} */ name, /** @type {any} */ blob) {
  return uploadImageAsset(api, name, blob);
}

// Only ever called for a baked glow-line frame (see bakeStroke()):
// renderStrokeFrame() draws onto a blank <canvas>, which starts fully
// transparent, and only ever paints the stroke itself on top of that - so
// the frame's background pixels are genuinely alpha=0, not opaque black.
// "opaque"/default type (this function's old default) would flatten that
// away, baking the frame in as an opaque box instead of a see-through
// glow line. RGB565 matches the colour depth renderStrokeFrame() already
// quantizes every pixel to before it leaves the browser.
// Baking used to be a one-off manual click that created a fresh widget every
// time (unique-suffixed id, so re-baking piled up copies). Now it runs
// automatically before every export, so it has to be idempotent: the same
// stroke always maps to the same deterministic widget id, and re-baking
// updates that widget in place instead of creating a new one.
/**
 * Bakes one glow-line stroke into its static-line image widget plus, if the
 * stroke's flow is enabled, one animated widget (and, if the stroke is
 * marked bidirectional, a second one with a mirrored travel direction -
 * `flow.reversed` flipped just for that render pass, not persisted). All ids
 * are derived deterministically from the stroke, so calling this again for
 * the same stroke updates the existing widgets/images rather than adding
 * duplicates.
 */
async function bakeStroke(/** @type {any} */ stroke) {
  return bakeGlowStroke({
    project: state.project,
    stroke,
    renderFrame: renderStrokeFrame,
    uploadFrame: uploadBakedFrame,
    contentOrigin,
    messages: {
      reserved: (id) => t("toast.glow.idReserved", { id }),
      collision: (id) => t("toast.glow.idCollision", { id }),
    },
  });
}

/** Runs before every YAML export/download - bakes (or re-bakes) every glow
 * line with enough geometry, so the exported project never references
 * stale or missing baked images/widgets. */
async function bakeAllStrokes() {
  const strokes = (state.project.glow_strokes || []).filter((/** @type {any} */ stroke) => (stroke.points || []).length >= 2);
  if (!strokes.length) return true;
  if (!state.capabilities["designer.asset_write"]) {
    toast(t("toast.glow.noWritePermission"), true);
    return false;
  }
  toast(t("toast.glow.generatingImages"));
  pushUndo();
  try {
    for (const stroke of strokes) {
      await bakeStroke(stroke);
    }
    markProjectDirty();
    renderDesigner();
    return true;
  } catch (/** @type {any} */ error) {
    toast(t("toast.glow.bakeFailed", { error: error.message }), true);
    return false;
  }
}

function renderWidget(/** @type {any} */ item) {
  const { widget, left, top, width, height, managed, effectivelyHidden } = item;
  const node = document.createElement("div");
  node.className = `canvas-widget${state.selectedWidget === widget ? " selected" : ""}`;
  node.dataset.type = widget.widget_type;
  if (managed) node.classList.add("managed");
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.width = `${Math.max(1, width)}px`;
  node.style.height = `${Math.max(1, height)}px`;
  node.style.opacity = effectivelyHidden ? "0" : "1";
  // A hidden widget is invisible but, without this, still sat in front for
  // hit-testing (opacity alone doesn't affect it) - stacking several
  // widgets and hiding the front one meant every click on that spot kept
  // selecting the widget you can't see instead of whatever is now visible
  // underneath it. The resize handle below restores its own pointer-events
  // so a hidden widget that is already selected (e.g. via the Hierarchy
  // tree) can still be resized from the canvas.
  node.style.pointerEvents = effectivelyHidden ? "none" : "";
  if (widget.locked) node.classList.add("locked");
  // The state selected in the property panel is also the state previewed on
  // the canvas. This is especially useful for a button's pressed/checked
  // colours: previously those values were editable but only visible after
  // opening the separate Viewer.
  const previewState = state.selectedWidget === widget ? state.activeState : "";
  const effectiveStyle = /** @type {any} */ (
    effectiveViewerStyle(state.project, widget, previewState)
  );
  if (previewState) node.dataset.previewState = previewState;
  const backgroundColor = resolveViewerColor(state.project, effectiveStyle.bg_color);
  if (backgroundColor) node.style.backgroundColor = backgroundColor;
  const gradientBackground = viewerGradientBackground(state.project, effectiveStyle);
  if (gradientBackground) node.style.backgroundImage = gradientBackground;
  const textColor = resolveViewerColor(state.project, effectiveStyle.text_color);
  if (textColor) node.style.color = textColor;
  const textAlign = viewerTextAlign(effectiveStyle.text_align);
  if (textAlign) node.style.textAlign = textAlign;
  const bgImageSource = displayableImageSource(effectiveStyle.bg_image_src);
  if (bgImageSource) {
    // `cover` is an approximation - LVGL's own bg_image scaling isn't
    // modeled here, same "plausible, not pixel-exact" spirit as the rest
    // of the layout engine. Falls back to bg_color alone if the URL 404s;
    // a CSS background-image has no onerror hook to fall back further.
    node.style.backgroundImage = `url("${bgImageSource}")`;
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
  }
  const textFontReference = effectiveStyle.text_font || state.project.default_font;
  node.style.fontFamily = resolvedFontFamily(textFontReference);
  const textFontSize = fontEntrySize(textFontReference);
  if (textFontSize) node.style.fontSize = `${textFontSize}px`;
  let imageReference = widget.properties?.src;
  const selectedImageButton = directImageButtonParts(state.selectedWidget);
  if (widget.widget_type === "image" && selectedImageButton?.image === widget) {
    if (state.activeState === "pressed") {
      imageReference = eventImageSource(state.selectedWidget, "on_press", widget.id) || imageReference;
    } else if (state.activeState === "checked") {
      imageReference = eventImageSource(
        state.selectedWidget, "on_value", widget.id, "checked",
      ) || imageReference;
    }
  }
  const imageSource = widget.widget_type === "image"
    ? displayableImageSource(imageReference)
    : null;
  if (["bar", "arc"].includes(widget.widget_type)) {
    node.append(renderCanvasValueVisual(widget));
  } else if (widget.widget_type === "meter") {
    node.append(renderViewerMeter(state.project, widget, previewState ? [previewState] : []));
  } else if (imageSource) {
    const picture = document.createElement("img");
    picture.className = "widget-image";
    picture.src = imageSource;
    picture.draggable = false;
    picture.alt = "";
    // Fall back to a label if the URL cannot be loaded in the browser. Replace
    // only the image - setting textContent here would drop the resize handle.
    picture.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.textContent = `${imageReference || widget.id} ⚠`;
      picture.replaceWith(fallback);
      node.title = t("canvas.imageLoadFailedTitle");
    });
    node.append(picture);
  } else if (!(widget.widget_type === "button" && widget.children?.length
      && !Object.hasOwn(widget.properties || {}, "text"))) {
    const text = document.createElement("span");
    text.className = "canvas-widget-text";
    text.textContent = widget.properties.text || widget.id;
    node.append(text);
  }
  node.addEventListener("pointerdown", (event) => beginDrag(event, widget, node, item));
  if (state.selectedWidget === widget && !widget.locked && !managed) {
    const handle = document.createElement("span");
    handle.className = "resize-handle";
    // Regains interactivity even under a pointer-events:none parent (see
    // the effectivelyHidden node above) - a hidden widget selected via the
    // Hierarchy tree should still be resizable from the canvas.
    handle.style.pointerEvents = "auto";
    handle.addEventListener("pointerdown", (event) => beginResize(event, widget));
    node.append(handle);
  }
  return node;
}

function renderCanvasValueVisual(/** @type {any} */ widget) {
  if (widget.widget_type === "bar") {
    const { lower, upper, vertical } = viewerBarGeometry(widget);
    const control = document.createElement("span");
    control.className = `canvas-value-visual canvas-bar${vertical ? " vertical" : ""}`;
    const fill = document.createElement("span");
    fill.className = "canvas-bar-fill";
    if (vertical) {
      fill.style.bottom = `${lower * 100}%`;
      fill.style.height = `${(upper - lower) * 100}%`;
    } else {
      fill.style.left = `${lower * 100}%`;
      fill.style.width = `${(upper - lower) * 100}%`;
    }
    const style = effectiveStyleTree(widget);
    fill.style.backgroundColor = resolveViewerColor(state.project, style.indicator?.bg_color) || "#20c7b7";
    control.append(fill);
    return control;
  }

  const control = document.createElement("span");
  control.className = "canvas-value-visual canvas-arc";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  const style = effectiveStyleTree(widget);
  const minimum = Number(widget.properties?.min_value) || 0;
  const maximum = Number(widget.properties?.max_value) || 100;
  const value = clamp(Number(widget.properties?.value) || 0, Math.min(minimum, maximum), Math.max(minimum, maximum));
  const percentage = maximum === minimum ? 0 : clamp((value - minimum) / (maximum - minimum), 0, 1);
  const start = Number(widget.properties?.start_angle ?? 135) + Number(widget.properties?.rotation || 0);
  const end = Number(widget.properties?.end_angle ?? 45) + Number(widget.properties?.rotation || 0);
  const sweep = ((end - start) % 360 + 360) % 360 || 360;
  const width = clamp((Number(style.arc_width) || 10) * 100
    / Math.max(1, Math.min(Number(widget.width) || 120, Number(widget.height) || 120)), 1, 30);
  const background = document.createElementNS("http://www.w3.org/2000/svg", "path");
  background.setAttribute("d", describeViewerArc(start, sweep));
  background.setAttribute("fill", "none");
  background.setAttribute("stroke", resolveViewerColor(state.project, style.arc_color) || "#657386");
  background.setAttribute("stroke-width", String(width));
  background.setAttribute("stroke-linecap", style.arc_rounded === false ? "butt" : "round");
  const indicator = document.createElementNS("http://www.w3.org/2000/svg", "path");
  indicator.setAttribute("d", describeViewerArc(start, sweep * percentage));
  indicator.setAttribute("fill", "none");
  indicator.setAttribute("stroke", resolveViewerColor(state.project, style.indicator?.arc_color) || "#20c7b7");
  indicator.setAttribute("stroke-width", String(width));
  indicator.setAttribute("stroke-linecap", style.indicator?.arc_rounded === false ? "butt" : "round");
  svg.append(background, indicator);
  control.append(svg);
  return control;
}

function effectiveStyleTree(/** @type {any} */ widget) {
  const theme = (state.project.theme || {})[widget.widget_type] || {};
  /** @type {any} */
  let ownTree;
  if (widget.style_mode !== "named") {
    ownTree = widget.style_tree || {};
  } else {
    ownTree = {};
    (widget.style_refs || []).forEach((/** @type {any} */ ref) => {
      const entry = styleLibrary().find((/** @type {any} */ item) => item.id === ref);
      if (entry) Object.assign(ownTree, entry.style_tree || {});
    });
  }
  // The theme is this type's default; the widget's own style (inline or
  // named) overrides it key-by-key, same precedence ESPHome's LVGL
  // component applies. Main widget state previews use effectiveViewerStyle
  // in renderWidget; this nested tree remains useful for part visuals such
  // as the bar indicator.
  return { ...theme, ...ownTree };
}

function beginDrag(/** @type {any} */ event, /** @type {any} */ widget, /** @type {any} */ node, /** @type {any} */ box) {
  if (event.target.classList.contains("resize-handle")) return;
  state.selectedWidget = widget;
  renderProperties();
  renderTree();
  $$(".canvas-widget").forEach((item) => item.classList.toggle("selected", item === node));
  if (widget.locked) return;
  if (box.managed) {
    // A parent grid or flex arrangement owns this position. Writing an x/y
    // here would be an offset fighting the layout, not a move - so the
    // position is edited through the grid cell fields instead.
    toast(t("toast.widget.positionManagedByParent"));
    return;
  }
  pushUndo();
  const origin = {
    clientX: event.clientX, clientY: event.clientY,
    x: Number(widget.x) || 0, y: Number(widget.y) || 0,
  };
  // Glow lines nested under this widget aren't part of the layout tree (their
  // points are always absolute canvas coordinates, not a child x/y offset),
  // so they need their own translation to follow the drag.
  /** @type {any[]} */
  const childStrokes = (state.project.glow_strokes || [])
    .filter((/** @type {any} */ stroke) => stroke.parent_id === widget.id)
    .map((/** @type {any} */ stroke) => ({ stroke, points: stroke.points.map((/** @type {any} */ p) => [...p]) }));
  node.setPointerCapture(event.pointerId);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", end, { once: true });
  function move(/** @type {any} */ moveEvent) {
    const position = dragPosition(origin, moveEvent, state.zoom, {
      width: state.project.canvas.width,
      height: state.project.canvas.height,
      itemWidth: box.width,
      itemHeight: box.height,
    });
    widget.x = position.x;
    widget.y = position.y;
    // Re-running the layout (rather than just offsetting this node) keeps any
    // children - and siblings anchored to this widget - moving along with it.
    syncCanvasLayout();
    if (childStrokes.length) {
      const totalDeltaX = widget.x - origin.x;
      const totalDeltaY = widget.y - origin.y;
      childStrokes.forEach(({ stroke, points }) => {
        stroke.points = translatePoints(points, totalDeltaX, totalDeltaY);
      });
      renderGlowCanvas();
    }
    $("#prop-x").value = widget.x;
    $("#prop-y").value = widget.y;
    markProjectDirty();
  }
  function end() { node.removeEventListener("pointermove", move); }
}

function beginResize(/** @type {any} */ event, /** @type {any} */ widget) {
  event.stopPropagation();
  pushUndo();
  const origin = {
    clientX: event.clientX,
    clientY: event.clientY,
    width: Number(widget.width),
    height: Number(widget.height),
  };
  event.target.setPointerCapture(event.pointerId);
  event.target.addEventListener("pointermove", resize);
  event.target.addEventListener("pointerup", end, { once: true });
  function resize(/** @type {any} */ moveEvent) {
    const dimensions = resizeDimensions(origin, moveEvent, state.zoom);
    widget.width = dimensions.width;
    widget.height = dimensions.height;
    // A container's children can depend on its size (grid tracks, flex
    // stretch), so re-run the layout instead of only resizing this node.
    syncCanvasLayout();
    $("#prop-width").value = widget.width;
    $("#prop-height").value = widget.height;
    markProjectDirty();
  }
  function end() { event.target.removeEventListener("pointermove", resize); }
}

function renderProperties() {
  renderRuntimeBindingOrphans();
  const widget = state.canvasMode === "lines" ? null : state.selectedWidget;
  $("#empty-properties").classList.toggle("hidden", state.canvasMode === "lines" || Boolean(widget));
  $("#properties").classList.toggle("hidden", !widget);
  if (!widget) $("#runtime-binding-section").classList.add("hidden");
  if (!widget) $("#widget-actions-section").classList.add("hidden");
  if (!widget) return;
  $("#prop-id").value = widget.id;
  $("#prop-x").value = widget.x;
  $("#prop-y").value = widget.y;
  $("#prop-width").value = widget.width;
  $("#prop-height").value = widget.height;
  $("#prop-locked").checked = Boolean(widget.locked);
  $("#prop-hidden").checked = Boolean(widget.hidden);
  renderLayoutSection(widget);
  renderGridCellSection(widget);
  renderTileSection(widget);
  renderTileviewActionsSection(widget);
  renderTabSection(widget);
  renderTabviewActionsSection(widget);
  renderStateChoices();
  renderStyleControls(widget);
  renderDynamicProperties(widget);
  renderImageButtonSettings(widget);
  renderWidgetActions(widget);
  renderRuntimeBinding(widget);
  renderDeviceBindings(widget);
  renderExtraKeys(widget);
}

/** @type {Record<string, string>} */
const ACTION_TRIGGER_LABELS = {
  on_click: t("actions.trigger.click"),
  on_press: t("actions.trigger.press"),
  on_release: t("actions.trigger.release"),
  on_value: t("actions.trigger.valueShort"),
};

function directImageButtonParts(/** @type {any} */ widget) {
  if (widget?.widget_type !== "button") return null;
  const image = (widget.children || []).find((/** @type {any} */ child) => child.widget_type === "image");
  if (!image) return null;
  return {
    image,
    label: (widget.children || []).find((/** @type {any} */ child) => child.widget_type === "label") || null,
  };
}

/** @returns {any} */
function imageUpdateDetails(/** @type {any} */ action, /** @type {any} */ imageId) {
  const conditional = generatedActionCondition(action);
  if (conditional) {
    /** @type {any} */
    const inner = imageUpdateDetails(conditional.action, imageId);
    return inner ? { ...inner, condition: conditional.condition } : null;
  }
  const entry = actionObjectEntry(action);
  if (entry?.[0] !== "lvgl.image.update") return null;
  const payload = entry[1];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!actionIdsForEditor(payload).includes(imageId) || typeof payload.src !== "string") return null;
  return { src: payload.src, condition: "always" };
}

function eventImageSource(/** @type {any} */ widget, /** @type {any} */ trigger, /** @type {any} */ imageId, condition = "always") {
  const raw = widget.events?.[trigger];
  const actions = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const action of actions) {
    const details = imageUpdateDetails(action, imageId);
    if (details?.condition === condition) return details.src;
  }
  return "";
}

function populateImageChoice(/** @type {any} */ control, /** @type {any} */ value) {
  control.replaceChildren(new Option(t("imgbtn.notSet"), ""));
  imageLibrary().forEach((/** @type {any} */ entry) => control.append(new Option(entry.id, entry.id)));
  if (value && !imageEntry(value)) control.append(new Option(`${value} (fehlt)`, value));
  control.value = value || "";
}

function renderImageButtonSettings(/** @type {any} */ widget) {
  const section = $("#image-button-section");
  const parts = directImageButtonParts(widget);
  section.classList.toggle("hidden", !parts);
  if (!parts) return;
  populateImageChoice($("#image-button-normal"), parts.image.properties?.src || "");
  populateImageChoice(
    $("#image-button-pressed"),
    eventImageSource(widget, "on_press", parts.image.id),
  );
  populateImageChoice(
    $("#image-button-checked"),
    eventImageSource(widget, "on_value", parts.image.id, "checked"),
  );
  $("#image-button-label").value = parts.label?.properties?.text || "";
  $("#image-button-checkable").checked = Boolean(widget.properties?.checkable);
  $("#image-button-error").classList.add("hidden");
}

function actionUpdatesImage(/** @type {any} */ action, /** @type {any} */ imageId) {
  const conditional = generatedActionCondition(action);
  if (conditional) return actionUpdatesImage(conditional.action, imageId);
  const entry = actionObjectEntry(action);
  return entry?.[0] === "lvgl.image.update" && actionIdsForEditor(entry[1]).includes(imageId);
}

function removeGeneratedImageButtonActions(/** @type {any} */ widget, /** @type {any} */ imageId) {
  ["on_press", "on_release", "on_value"].forEach((trigger) => {
    const raw = widget.events?.[trigger];
    if (raw === undefined) return;
    const actions = (Array.isArray(raw) ? raw : [raw])
      .filter((action) => !actionUpdatesImage(action, imageId));
    if (actions.length) widget.events[trigger] = actions;
    else delete widget.events[trigger];
  });
}

function appendWidgetEvent(/** @type {any} */ widget, /** @type {any} */ trigger, /** @type {any} */ action) {
  widget.events ||= {};
  if (!Array.isArray(widget.events[trigger])) {
    widget.events[trigger] = widget.events[trigger] === undefined ? [] : [widget.events[trigger]];
  }
  widget.events[trigger].push(action);
}

function imageUpdateAction(/** @type {any} */ imageId, /** @type {any} */ src) {
  return { "lvgl.image.update": { id: imageId, src } };
}

function conditionalImageUpdate(/** @type {any} */ imageId, /** @type {any} */ src, /** @type {any} */ checked) {
  return {
    if: {
      condition: { lambda: checked ? "return x;" : "return !x;" },
      then: [imageUpdateAction(imageId, src)],
    },
  };
}

function applyImageButtonSettings() {
  const widget = state.selectedWidget;
  const parts = directImageButtonParts(widget);
  if (!parts) return;
  const normal = $("#image-button-normal").value;
  const pressed = $("#image-button-pressed").value;
  const checked = $("#image-button-checked").value;
  const error = $("#image-button-error");
  if (!normal) {
    error.textContent = t("imgbtn.selectNormalImage");
    error.classList.remove("hidden");
    return;
  }

  pushUndo();
  parts.image.properties ||= {};
  parts.image.properties.src = normal;
  const labelText = $("#image-button-label").value;
  let label = parts.label;
  if (!label && labelText) {
    label = editorWidgetNode(uniqueProjectWidgetId(`${widget.id}_label`), "label", {
      width: Math.max(40, Number(widget.width) || 120),
      height: 22,
      align: "BOTTOM_MID",
      y: -4,
      properties: { text: labelText, long_mode: "WRAP", recolor: false },
      styleTree: { text_align: "CENTER" },
    });
    widget.children.push(label);
  } else if (label) {
    label.properties ||= {};
    label.properties.text = labelText;
  }

  widget.properties ||= {};
  widget.properties.checkable = Boolean($("#image-button-checkable").checked || checked);
  removeGeneratedImageButtonActions(widget, parts.image.id);
  if (pressed) {
    appendWidgetEvent(widget, "on_press", imageUpdateAction(parts.image.id, pressed));
    appendWidgetEvent(widget, "on_release", imageUpdateAction(parts.image.id, normal));
  }
  if (checked) {
    appendWidgetEvent(widget, "on_value", conditionalImageUpdate(parts.image.id, checked, true));
    appendWidgetEvent(widget, "on_value", conditionalImageUpdate(parts.image.id, normal, false));
  }
  error.classList.add("hidden");
  markProjectDirty();
  renderDesigner();
  toast(t("toast.imgbtn.updated"));
}

// Recognises the specific nested if/show/hide/animimg.start structure
// addWidgetAction() builds for type === "flow" (see there), purely from its
// shape - no extra metadata is stored on the action itself, since it must
// still export as plain ESPHome-native actions.
// "on_value" + a checked/unchecked condition only makes sense for a widget
// whose value is fundamentally a boolean - a plain lambda `return x;`/
// `return !x;` has nothing meaningful to compare against for e.g. a
// slider's numeric value. A button only qualifies once "checkable" is on
// (otherwise it never reports a checked state to begin with); switch and
// checkbox are inherently boolean, no extra flag needed.
function renderWidgetActions(/** @type {any} */ widget) {
  const section = $("#widget-actions-section");
  const visible = Boolean(widget);
  section.classList.toggle("hidden", !visible);
  if (!visible) return;

  widget.events ||= {};
  const list = $("#widget-action-list");
  list.replaceChildren();
  let count = 0;
  Object.entries(widget.events).forEach(([trigger, raw]) => {
    const actions = Array.isArray(raw) ? raw : [raw];
    actions.forEach((action, index) => {
      count += 1;
      const description = describeAction(action, t);
      const missing = description.skipMissingCheck ? [] : description.targetIds.filter(
        (id) => !actionTargetEntries().some((item) => item.id === id));
      const row = document.createElement("div");
      row.className = `widget-action-item${!description.supported || missing.length ? " invalid" : ""}`;
      const label = document.createElement("span");
      const triggerLabel = ACTION_TRIGGER_LABELS[trigger] || trigger;
      label.textContent = `${triggerLabel}: ${description.text}${missing.length ? ` · Ziel fehlt: ${missing.join(", ")}` : ""}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button danger compact";
      remove.textContent = "Entfernen";
      remove.addEventListener("click", () => removeWidgetAction(widget, trigger, index));
      row.append(label, remove);
      list.append(row);
    });
  });
  if (!count) {
    const empty = document.createElement("p");
    empty.className = "widget-action-empty";
    empty.textContent = t("actions.empty");
    list.append(empty);
  }
  renderWidgetActionBuilder(widget);
}

// Glow lines with flow enabled that are eligible as a flow action's target.
// The stroke itself is the source of truth for direction/speed baking, not
// the (possibly not-yet-baked) animimg widget it produces - see bakeStroke().
function flowEligibleStrokes() {
  return (state.project.glow_strokes || []).filter((/** @type {any} */ stroke) => stroke.flow.enabled);
}

function meterIndicatorEntries() {
  /** @type {any[]} */
  const entries = [];
  projectWidgetEntries().filter((item) => item.widget_type === "meter").forEach((meter) => {
    (meter.properties?.scales || []).forEach((/** @type {any} */ scale, /** @type {number} */ scaleIndex) => {
      (scale?.indicators || []).forEach((/** @type {any} */ entry) => {
        if (!entry || typeof entry !== "object") return;
        const [kind, config] = Object.entries(entry)[0] || [];
        if (!kind || !config || typeof config !== "object" || !config.id) return;
        entries.push({
          id: String(config.id), widget_type: "meter_indicator",
          indicator_type: kind, meter_id: meter.id, scale_index: scaleIndex,
        });
      });
    });
  });
  return entries;
}

function actionTargetEntries() {
  return [...projectWidgetEntries(), ...meterIndicatorEntries()];
}

function renderWidgetActionBuilder(/** @type {any} */ widget) {
  if (!widget) return;
  const trigger = $("#widget-action-trigger").value;
  const type = $("#widget-action-type").value;
  const flow = type === "flow";
  const indicatorUpdate = type === "indicator_update";
  const conditionField = $("#widget-action-condition-field");
  const supportsCondition = trigger === "on_value" && !flow && widgetSupportsValueCondition(widget);
  conditionField.classList.toggle("hidden", !supportsCondition);
  if (!supportsCondition) $("#widget-action-condition").value = "always";

  $("#widget-action-target-field").classList.toggle("hidden", flow);
  const animimgOnly = type === "animimg_start" || type === "animimg_stop";
  const target = $("#widget-action-target");
  const previous = target.value;
  const choices = flow ? []
    : type === "page_show"
      ? (state.project.pages || []).map((/** @type {any} */ page) => ({ value: page.id, label: `${page.id} · Seite` }))
      : (indicatorUpdate ? meterIndicatorEntries() : projectWidgetEntries())
        .filter((item) => !animimgOnly || item.widget_type === "animimg")
        .map((item) => ({ value: item.id, label: `${item.id} · ${item.widget_type}` }));
  target.replaceChildren();
  choices.forEach((/** @type {any} */ choice) => target.append(new Option(choice.label, choice.value)));
  if (choices.some((/** @type {any} */ choice) => choice.value === previous)) target.value = previous;

  const update = type === "update";
  $("#widget-action-update-fields").classList.toggle("hidden", !update);
  const targetWidget = actionTargetEntries().find((item) => item.id === target.value);
  $("#widget-action-text-field").classList.toggle(
    "hidden", !update || !["label", "button"].includes(targetWidget?.widget_type || ""),
  );
  $("#widget-action-image-field").classList.toggle(
    "hidden", !update || targetWidget?.widget_type !== "image",
  );
  populateImageChoice($("#widget-action-image"), "");

  $("#widget-action-indicator-fields").classList.toggle("hidden", !indicatorUpdate);
  const useTriggerValue = $("#widget-action-indicator-trigger-value");
  useTriggerValue.disabled = trigger !== "on_value";
  if (trigger !== "on_value") useTriggerValue.checked = false;
  $("#widget-action-indicator-value").disabled = Boolean(useTriggerValue.checked);

  $("#widget-action-flow-fields").classList.toggle("hidden", !flow);
  if (flow) {
    const strokeSelect = $("#widget-action-flow-stroke");
    const previousStroke = strokeSelect.value;
    const strokes = flowEligibleStrokes();
    strokeSelect.replaceChildren();
    strokes.forEach((/** @type {any} */ stroke) => strokeSelect.append(
      new Option(`${stroke.name || stroke.id} · ${stroke.id}`, stroke.id),
    ));
    if (strokes.some((/** @type {any} */ stroke) => stroke.id === previousStroke)) strokeSelect.value = previousStroke;
    const selected = strokes.find((/** @type {any} */ stroke) => stroke.id === strokeSelect.value);
    $("#widget-action-flow-stroke-hint").textContent = !strokes.length
      ? t("actions.flow.noStrokes")
      : selected?.flow.bidirectional
        ? t("actions.flow.strokeIsBidirectional")
        : t("actions.flow.strokeIsSingleDirection");
  }
  $("#widget-action-error").classList.add("hidden");
}

function addWidgetAction() {
  const widget = state.selectedWidget;
  if (!widget) return;
  const trigger = $("#widget-action-trigger").value;
  const type = $("#widget-action-type").value;
  const targetId = $("#widget-action-target").value;
  const error = $("#widget-action-error");
  const fail = (/** @type {any} */ message) => {
    error.textContent = message;
    error.classList.remove("hidden");
  };
  if (type !== "flow" && !targetId) {
    fail(type === "page_show" ? t("validation.action.noPage") : t("validation.action.noTargetWidget"));
    return;
  }
  const condition = $("#widget-action-condition").value;
  if (trigger === "on_value" && condition !== "always" && !widgetSupportsValueCondition(widget)) {
    fail(t("validation.action.needsCheckable"));
    return;
  }

  let action;
  if (type === "flow") {
    if (trigger !== "on_value") {
      fail(t("validation.action.flowNeedsValueTrigger"));
      return;
    }
    const strokeId = $("#widget-action-flow-stroke").value;
    const stroke = flowEligibleStrokes().find((/** @type {any} */ item) => item.id === strokeId);
    if (!stroke) {
      fail(t("validation.action.flowNeedsStroke"));
      return;
    }
    // Deterministic ids bakeStroke() will (re-)create these widgets under -
    // see strokeBaseName()/bakeDirection() there. The widgets need not exist
    // yet: baking runs automatically before every export.
    const baseName = strokeBaseName(stroke);
    const flowTargetId = `${baseName}_anim`;
    const bidir = stroke.flow.bidirectional;
    const reverseId = bidir ? `${baseName}_anim_rev` : "";
    const offThreshold = $("#widget-action-flow-off").value;
    const fastThreshold = $("#widget-action-flow-fast").value;
    if ((Number(fastThreshold) || 0) <= Math.max(0, Number(offThreshold) || 0)) {
      fail(t("validation.action.flowInvalidThresholds"));
      return;
    }
    action = buildFlowAction({
      forwardId: flowTargetId,
      reverseId,
      offThreshold,
      fastThreshold,
      normalDuration: $("#widget-action-flow-normal-duration").value,
      fastDuration: $("#widget-action-flow-fast-duration").value,
    });
  } else {
    const targetWidget = actionTargetEntries().find((item) => item.id === targetId);
    try {
      action = buildWidgetAction({
        type,
        targetId,
        targetWidget,
        fields: {
          text: $("#widget-action-text").value,
          imageSource: $("#widget-action-image").value,
          bg_color: $("#widget-action-bg-color").value,
          text_color: $("#widget-action-text-color").value,
          border_color: $("#widget-action-border-color").value,
          opa: $("#widget-action-opacity").value,
          triggerValue: $("#widget-action-indicator-trigger-value").checked,
          value: $("#widget-action-indicator-value").value,
          start_value: $("#widget-action-indicator-start-value").value,
          end_value: $("#widget-action-indicator-end-value").value,
          ...(type === "indicator_update" ? { opa: $("#widget-action-indicator-opacity").value } : {}),
        },
      });
    } catch (/** @type {any} */ error) {
      if (error.message === "missing_update_fields") {
        fail(t("validation.action.needsAtLeastOneField"));
        return;
      }
      throw error;
    }
  }

  if (trigger === "on_value") action = wrapValueCondition(action, condition);

  pushUndo();
  widget.events ||= {};
  if (!Array.isArray(widget.events[trigger])) {
    widget.events[trigger] = widget.events[trigger] === undefined ? [] : [widget.events[trigger]];
  }
  widget.events[trigger].push(action);
  markProjectDirty();
  error.classList.add("hidden");
  ["#widget-action-text", "#widget-action-bg-color", "#widget-action-text-color",
    "#widget-action-border-color", "#widget-action-opacity", "#widget-action-image",
    "#widget-action-indicator-value", "#widget-action-indicator-start-value",
    "#widget-action-indicator-end-value", "#widget-action-indicator-opacity"]
    .forEach((selector) => { $(selector).value = ""; });
  $("#widget-action-indicator-trigger-value").checked = false;
  syncLinkedColorPickers();
  renderWidgetActions(widget);
}

function removeWidgetAction(/** @type {any} */ widget, /** @type {any} */ trigger, /** @type {any} */ index) {
  pushUndo();
  const raw = widget.events?.[trigger];
  if (Array.isArray(raw)) {
    raw.splice(index, 1);
    if (!raw.length) delete widget.events[trigger];
  } else {
    delete widget.events[trigger];
  }
  markProjectDirty();
  renderWidgetActions(widget);
}

const runtimeTargets = (/** @type {any} */ widget) => targetsForRuntime(widget, t);

function meterIndicatorIds(/** @type {any} */ widget) {
  /** @type {string[]} */
  const ids = [];
  (widget?.properties?.scales || []).forEach((/** @type {any} */ scale) => {
    (scale?.indicators || []).forEach((/** @type {any} */ entry) => {
      Object.values(entry || {}).forEach((/** @type {any} */ payload) => {
        if (payload && typeof payload === "object" && payload.id) ids.push(payload.id);
      });
    });
  });
  return ids;
}

function renderDeviceBindingIndicator(/** @type {any} */ widget) {
  const visible = $("#device-binding-property").value.startsWith("indicator_");
  $("#device-binding-indicator-field").classList.toggle("hidden", !visible);
  const select = $("#device-binding-indicator");
  const previous = select.value;
  select.replaceChildren();
  meterIndicatorIds(widget).forEach((id) => select.append(new Option(id, id)));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function populateDeviceBindingCommands(selected = "") {
  const entityId = $("#device-binding-entity").value;
  const entity = (state.project.entities || []).find((/** @type {any} */ item) => item.id === entityId);
  const select = $("#device-binding-command");
  select.replaceChildren();
  (entity?.commands || []).forEach((/** @type {any} */ command) => select.append(new Option(command, command)));
  if (selected && [...select.options].some((option) => option.value === selected)) select.value = selected;
}

function renderDeviceBindings(/** @type {any} */ widget, /** @type {any} */ selectedBinding = null) {
  const section = $("#device-binding-section");
  const visible = Boolean(widget);
  section.classList.toggle("hidden", !visible);
  if (!visible) return;
  state.project.entities ||= [];
  state.project.bindings ||= [];
  const own = bindingsForWidget(state.project.bindings, widget.id).filter(
    (/** @type {any} */ binding) => !binding.deleted,
  );
  const existing = $("#device-binding-existing");
  const selectedId = selectedBinding?.id || existing.value;
  existing.replaceChildren(new Option("— Neue Bindung —", ""));
  own.forEach((/** @type {any} */ binding) => existing.append(new Option(
    ["opaque_yaml", "custom_yaml"].includes(binding.kind)
      ? `${binding.id} · ${t("deviceBinding.importedOnly")}`
      : `${binding.id} · ${binding.direction}`,
    binding.id,
  )));
  existing.value = own.some((/** @type {any} */ binding) => binding.id === selectedId) ? selectedId : "";

  const binding = selectedBinding || own.find((/** @type {any} */ item) => item.id === existing.value);
  const importedOnly = binding?.kind === "opaque_yaml" || binding?.kind === "custom_yaml";
  const direction = binding?.direction || $("#device-binding-direction").value || "entity_to_widget";
  $("#device-binding-direction").value = direction;
  const entity = direction === "widget_to_entity" ? binding?.target : binding?.source;
  const widgetSide = direction === "widget_to_entity" ? binding?.source : binding?.target;

  const entitySelect = $("#device-binding-entity");
  entitySelect.replaceChildren(new Option("— Entität wählen —", ""));
  compatibleEntities(state.project.entities, direction).forEach((/** @type {any} */ item) => {
    entitySelect.append(new Option(`${item.domain}.${item.id}${item.unit ? ` · ${item.unit}` : ""}`, item.id));
  });
  entitySelect.value = entity?.id || "";

  const propertySelect = $("#device-binding-property");
  propertySelect.replaceChildren();
  deviceBindingTargets(widget, direction).forEach((/** @type {string} */ property) => propertySelect.append(new Option(property, property)));
  propertySelect.value = widgetSide?.property || widgetSide?.event || propertySelect.options[0]?.value || "";

  const bidirectional = direction === "bidirectional";
  $("#device-binding-event-field").classList.toggle("hidden", !bidirectional);
  const eventSelect = $("#device-binding-event");
  eventSelect.replaceChildren();
  deviceBindingTargets(widget, "widget_to_entity").forEach((/** @type {string} */ event) => eventSelect.append(new Option(event, event)));
  eventSelect.value = widgetSide?.event || eventSelect.options[0]?.value || "value";
  $("#device-binding-command-field").classList.toggle("hidden", direction === "entity_to_widget");
  populateDeviceBindingCommands(entity?.command || "");
  $("#device-binding-transform").value = JSON.stringify(binding?.transform || {}, null, 2);
  $("#device-binding-conditions").value = JSON.stringify(binding?.conditions || [], null, 2);
  $("#remove-device-binding").disabled = !binding;
  ["device-binding-direction", "device-binding-entity", "device-binding-property",
    "device-binding-event", "device-binding-indicator", "device-binding-command",
    "device-binding-transform", "device-binding-conditions", "save-device-binding"]
    .forEach((id) => { $(`#${id}`).disabled = importedOnly; });
  $("#device-binding-custom-fields").classList.toggle("hidden", !importedOnly);
  $("#device-binding-custom-yaml").value = importedOnly ? binding.raw_yaml || "" : "";
  $("#restore-custom-binding").classList.toggle("hidden", binding?.origin !== "imported");
  const bindingError = $("#device-binding-error");
  if (importedOnly) {
    bindingError.textContent = t("deviceBinding.importedHint");
    bindingError.classList.remove("hidden");
  } else {
    bindingError.classList.add("hidden");
  }
  renderDeviceBindingIndicator(widget);

  const list = $("#device-binding-list");
  list.replaceChildren();
  own.forEach((/** @type {any} */ item) => {
    const row = document.createElement("div");
    const source = item.direction === "widget_to_entity" ? `${widget.id}.${item.source.event}` : `${item.source.domain}.${item.source.id}`;
    const target = item.direction === "widget_to_entity" ? `${item.target.domain}.${item.target.id}` : `${widget.id}.${item.target.property}`;
    row.textContent = ["opaque_yaml", "custom_yaml"].includes(item.kind)
      ? `${source} → ${target} · ${t("deviceBinding.importedOnly")}`
      : `${source} → ${target}`;
    list.append(row);
  });
  const graphElement = $("#device-binding-graph");
  graphElement.replaceChildren();
  const graph = bindingGraph(state.project.bindings);
  graph.edges.forEach((/** @type {any} */ edge) => {
    const from = graph.nodes.find((node) => node.id === edge.from)?.label || edge.from;
    const to = graph.nodes.find((node) => node.id === edge.to)?.label || edge.to;
    const row = document.createElement("div");
    row.className = "device-binding-edge";
    row.textContent = `${from} ${edge.bidirectional ? "⇄" : "→"} ${to}`;
    row.title = edge.id;
    graphElement.append(row);
  });
}

function loadSelectedDeviceBinding() {
  const binding = (state.project.bindings || []).find((/** @type {any} */ item) => item.id === $("#device-binding-existing").value);
  renderDeviceBindings(state.selectedWidget, binding || null);
}

function saveDeviceBinding() {
  const widget = state.selectedWidget;
  const error = $("#device-binding-error");
  if (!widget) return;
  const selected = (state.project.bindings || []).find(
    (/** @type {any} */ item) => item.id === $("#device-binding-existing").value,
  );
  if (selected?.kind === "opaque_yaml" || selected?.kind === "custom_yaml") return;
  const direction = $("#device-binding-direction").value;
  const entityId = $("#device-binding-entity").value;
  const entity = (state.project.entities || []).find((/** @type {any} */ item) => item.id === entityId);
  if (!entity) {
    error.textContent = "Bitte eine kompatible ESPHome-Entität auswählen.";
    error.classList.remove("hidden"); return;
  }
  let transform, conditions;
  try {
    transform = JSON.parse($("#device-binding-transform").value || "{}");
    conditions = JSON.parse($("#device-binding-conditions").value || "[]");
    if (!Array.isArray(conditions)) throw new Error("Bedingungen müssen eine Liste sein.");
  }
  catch (/** @type {any} */ parseError) {
    error.textContent = `Transformation ist kein gültiges JSON: ${parseError.message}`;
    error.classList.remove("hidden"); return;
  }
  const property = $("#device-binding-property").value;
  const existingId = $("#device-binding-existing").value;
  const id = existingId || defaultBindingId(widget.id, entity.id);
  /** @type {Record<string, any>} */
  const widgetSide = { widget_id: widget.id };
  if (direction === "widget_to_entity") widgetSide.event = property;
  else {
    widgetSide.property = property;
    if (property.startsWith("indicator_")) widgetSide.indicator_id = $("#device-binding-indicator").value;
    if (direction === "bidirectional") widgetSide.event = $("#device-binding-event").value;
  }
  /** @type {Record<string, any>} */
  const entitySide = { domain: entity.domain, id: entity.id };
  if (direction !== "entity_to_widget") entitySide.command = $("#device-binding-command").value;
  /** @type {any} */
  const binding = {
    id, direction, transform, conditions,
    source: direction === "widget_to_entity" ? widgetSide : entitySide,
    target: direction === "widget_to_entity" ? entitySide : widgetSide,
  };
  pushUndo();
  state.project.bindings = upsertDeviceBinding(state.project.bindings, binding);
  markProjectDirty();
  error.classList.add("hidden");
  renderDeviceBindings(widget, binding);
}

function deleteDeviceBinding() {
  const id = $("#device-binding-existing").value;
  if (!id) return;
  pushUndo();
  const binding = (state.project.bindings || []).find((/** @type {any} */ item) => item.id === id);
  state.project.bindings = ["opaque_yaml", "custom_yaml"].includes(binding?.kind)
    ? state.project.bindings.map((/** @type {any} */ item) => item.id === id ? { ...item, deleted: true } : item)
    : removeDeviceBinding(state.project.bindings, id);
  markProjectDirty();
  renderDeviceBindings(state.selectedWidget);
}

async function saveCustomDeviceBinding() {
  const id = $("#device-binding-existing").value;
  const binding = (state.project.bindings || []).find((/** @type {any} */ item) => item.id === id);
  if (!binding || !["opaque_yaml", "custom_yaml"].includes(binding.kind)) return;
  const error = $("#device-binding-error");
  try {
    const result = await api("designer/bindings/custom-yaml/validate", {
      method: "POST",
      body: JSON.stringify({ content: $("#device-binding-custom-yaml").value }),
    });
    pushUndo();
    binding.kind = "custom_yaml";
    binding.raw_action = result.action;
    binding.raw_yaml = result.yaml;
    binding.read_only = false;
    markProjectDirty();
    renderDeviceBindings(state.selectedWidget, binding);
  } catch (/** @type {any} */ validationError) {
    error.textContent = validationError.message;
    error.classList.remove("hidden");
  }
}

function restoreCustomDeviceBinding() {
  const id = $("#device-binding-existing").value;
  const binding = (state.project.bindings || []).find((/** @type {any} */ item) => item.id === id);
  if (!binding?.original_action || !binding?.original_yaml) return;
  pushUndo();
  binding.raw_action = structuredClone(binding.original_action);
  binding.raw_yaml = binding.original_yaml;
  markProjectDirty();
  renderDeviceBindings(state.selectedWidget, binding);
}

function projectWidgetEntries() {
  return collectActionTargets(state.project);
}

function bindingIsOrphan(/** @type {any} */ binding) {
  return isRuntimeBindingOrphan(state.project, binding);
}

function renderRuntimeBindingOrphans() {
  const section = $("#runtime-binding-orphans");
  const orphans = state.viewerBindings.filter(bindingIsOrphan);
  section.classList.toggle("hidden", !orphans.length);
  const list = $("#runtime-binding-orphan-list");
  list.replaceChildren();
  orphans.forEach((/** @type {any} */ binding) => {
    const item = document.createElement("li");
    item.textContent = `${binding.widget_id} → ${binding.target}`;
    list.append(item);
  });
  $("#cleanup-runtime-bindings").disabled = !state.projectName
    || state.projectDirty || !state.capabilities["designer.project_write"];
}

function runtimeCanWrite() {
  return Boolean(
    state.projectName && !state.projectDirty && state.capabilities["designer.project_write"],
  );
}

function bindingFromControls(widgetId = state.selectedWidget?.id) {
  return {
    widget_id: widgetId,
    target: $("#runtime-binding-target").value,
    device_id: $("#runtime-binding-device").value,
    entity_id: $("#runtime-binding-entity").value,
    value_format: $("#runtime-binding-format").value || "{state}",
    fallback: $("#runtime-binding-fallback").value || "",
    stale_after: clamp(Number($("#runtime-binding-stale").value) || 0, 0, 86400),
  };
}

function renderRuntimeBinding(/** @type {any} */ widget) {
  const section = $("#runtime-binding-section");
  const targets = runtimeTargets(widget);
  const visible = Boolean(targets.length && state.capabilities["device.states"]);
  section.classList.toggle("hidden", !visible);
  if (!visible) return;

  const targetControl = $("#runtime-binding-target");
  const previousTarget = targetControl.value;
  targetControl.replaceChildren();
  targets.forEach((target) => targetControl.append(new Option(target.label, target.value)));
  targetControl.value = targets.some((target) => target.value === previousTarget)
    ? previousTarget : targets[0].value;
  const target = targetControl.value;
  const binding = state.viewerBindings.find(
    (/** @type {any} */ item) => item.widget_id === widget.id && item.target === target,
  );

  const deviceControl = $("#runtime-binding-device");
  deviceControl.replaceChildren(new Option(t("binding.devicePlaceholder"), ""));
  (state.viewerRuntimeSources.devices || []).forEach((/** @type {any} */ device) => {
    const suffix = device.status === "ready" ? t("binding.deviceConnectedSuffix") : " · " + (DEVICE_STATUS[device.status] || device.status);
    deviceControl.append(new Option(device.name + suffix, device.id));
  });
  if (binding?.device_id && !(state.viewerRuntimeSources.devices || []).some(
    (/** @type {any} */ device) => device.id === binding.device_id,
  )) {
    deviceControl.append(new Option(t("binding.deviceUnavailable", { id: binding.device_id }), binding.device_id));
  }
  deviceControl.value = binding?.device_id || "";
  populateRuntimeEntityChoices(binding?.entity_id || "");

  $("#runtime-binding-format").value = binding?.value_format || "{state}";
  $("#runtime-binding-fallback").value = binding?.fallback || "";
  $("#runtime-binding-stale").value = binding?.stale_after || 0;
  const textTarget = target === "text";
  $("#runtime-binding-format-field").classList.toggle("hidden", !textTarget);
  $("#runtime-binding-fallback-field").classList.toggle("hidden", !textTarget);

  renderAdditionalRuntimeWidgets(widget, target);
  $("#runtime-live-preview").checked = state.designerRuntimePreview;
  const canWrite = runtimeCanWrite();
  $("#save-runtime-binding").disabled = !canWrite;
  $("#remove-runtime-binding").disabled = !canWrite || !binding;
  $("#copy-runtime-binding").disabled = !binding;
  $("#paste-runtime-binding").disabled = !state.copiedRuntimeBinding;
  $("#runtime-binding-hint").textContent = !state.projectName
    ? t("binding.hint.saveProjectFirst")
    : state.projectDirty
      ? t("binding.hint.saveChangesFirst")
      : t("binding.hint.default");
  renderRuntimeBindingStatus();
}

function populateRuntimeEntityChoices(selectedEntity = "") {
  const deviceId = $("#runtime-binding-device").value;
  const device = (state.viewerRuntimeSources.devices || []).find((/** @type {any} */ item) => item.id === deviceId);
  const control = $("#runtime-binding-entity");
  const target = $("#runtime-binding-target").value;
  const current = selectedEntity || control.value;
  control.replaceChildren(new Option(t("binding.entityPlaceholder"), ""));
  const matching = [...(device?.entities || [])].filter((entity) => (
    (/** @type {any} */ (entityMatchesRuntimeTarget))(
      entity, target, runtimeStateFor(device, entity.entity_id),
    )
  ));
  matching
    .sort((left, right) => String(left.name || left.object_id || left.entity_id)
      .localeCompare(String(right.name || right.object_id || right.entity_id), "de"))
    .forEach((entity) => {
      const unit = entity.unit_of_measurement ? " · " + entity.unit_of_measurement : "";
      control.append(new Option(
        (entity.name || entity.object_id || entity.entity_id) + unit,
        entity.entity_id,
      ));
    });
  if (current && !matching.some((entity) => entity.entity_id === current)) {
    const exists = (device?.entities || []).some((/** @type {any} */ entity) => entity.entity_id === current);
    control.append(new Option(
      current + (exists ? t("binding.entityMismatchSuffix") : t("binding.entityUnavailableSuffix")),
      current,
    ));
  }
  control.value = current || "";
}

function renderAdditionalRuntimeWidgets(/** @type {any} */ widget, /** @type {any} */ target) {
  const control = $("#runtime-binding-additional-widgets");
  control.replaceChildren();
  projectWidgetEntries()
    .filter((item) => item !== widget && runtimeTargets(item).some((entry) => entry.value === target))
    .sort((left, right) => left.id.localeCompare(right.id, "de"))
    .forEach((item) => control.append(new Option(`${item.id} (${item.widget_type})`, item.id)));
  control.disabled = control.options.length === 0;
}

function renderRuntimeBindingStatus() {
  const output = $("#runtime-binding-current");
  if (!output || $("#runtime-binding-section").classList.contains("hidden")) return;
  const binding = bindingFromControls();
  const health = runtimeBindingHealth(binding, state.viewerRuntimeSources);
  /** @type {Record<string, string>} */
  const labels = {
    unconfigured: t("binding.status.unconfigured"),
    missing_device: t("binding.status.missingDevice"),
    offline: t("binding.status.offline"),
    missing_entity: t("binding.status.missingEntity"),
    unavailable: t("binding.status.unavailable"),
    stale: t("binding.status.stale"),
  };
  output.className = "runtime-binding-status";
  if (health.status === "online") {
    const entity = (health.device.entities || []).find((/** @type {any} */ item) => item.entity_id === binding.entity_id);
    const unit = entity?.unit_of_measurement ? ` ${entity.unit_of_measurement}` : "";
    const received = health.state.received_at
      ? ` · ${new Date(health.state.received_at).toLocaleTimeString("de", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
      : "";
    output.textContent = t("binding.status.online", { value: `${String(health.state.state)}${unit}${received}` });
    output.classList.add("online");
  } else {
    output.textContent = labels[health.status] || t("binding.status.unknown");
    output.classList.add(
      health.status === "stale" ? "stale"
        : health.status === "unavailable" ? "unavailable"
          : ["offline", "missing_device", "missing_entity"].includes(health.status) ? "offline" : "neutral",
    );
  }
}

async function persistRuntimeBindings(/** @type {any} */ bindings) {
  const cleaned = cleanRuntimeBindings(state.project, bindings);
  try {
    const result = await api("viewer/bindings/" + encodeURIComponent(state.projectName), {
      method: "PUT",
      body: JSON.stringify({
        bindings: cleaned,
        expected_revision: state.viewerBindingsRevision,
      }),
    });
    state.viewerBindings = result.bindings || [];
    state.viewerBindingsRevision = result.revision || null;
    renderRuntimeBindingOrphans();
    renderRuntimeBinding(state.selectedWidget);
    renderCanvas();
    return true;
  } catch (/** @type {any} */ error) {
    if (error.code === "revision_conflict") await loadViewerBindings(state.projectName);
    renderRuntimeBinding(state.selectedWidget);
    renderRuntimeBindingOrphans();
    toast(t("toast.binding.saveFailed", { error: error.message }), true);
    return false;
  }
}

async function saveRuntimeBinding() {
  const widget = state.selectedWidget;
  const target = $("#runtime-binding-target").value;
  const deviceId = $("#runtime-binding-device").value;
  const entityId = $("#runtime-binding-entity").value;
  if (!widget || !state.projectName || state.projectDirty) {
    toast(t("toast.binding.saveProjectFirst"), true);
    return;
  }
  if (!deviceId || !entityId) {
    toast(t("toast.binding.selectDeviceEntity"), true);
    return;
  }
  const additional = [...$("#runtime-binding-additional-widgets").selectedOptions]
    .map((option) => option.value);
  const widgetIds = [widget.id, ...additional];
  const next = assignRuntimeBinding(state.viewerBindings, widgetIds, bindingFromControls());
  if (await persistRuntimeBindings(next)) {
    toast(widgetIds.length > 1
      ? t("toast.binding.appliedMultiple", { count: widgetIds.length })
      : t("toast.binding.saved"));
  }
}

async function removeRuntimeBinding() {
  const widget = state.selectedWidget;
  const target = $("#runtime-binding-target").value;
  if (!widget || !state.projectName || state.projectDirty) return;
  const next = withoutRuntimeBinding(state.viewerBindings, widget.id, target);
  if (await persistRuntimeBindings(next)) toast(t("toast.binding.removed"));
}

function copyRuntimeBinding() {
  const widget = state.selectedWidget;
  if (!widget) return;
  const binding = findRuntimeBinding(
    state.viewerBindings, widget.id, $("#runtime-binding-target").value,
  );
  if (!binding) return;
  state.copiedRuntimeBinding = { ...binding };
  $("#paste-runtime-binding").disabled = false;
  toast(t("toast.binding.copied"));
}

function pasteRuntimeBinding() {
  const widget = state.selectedWidget;
  const copied = state.copiedRuntimeBinding;
  if (!canPasteRuntimeBinding(widget, copied)) {
    toast(t("toast.binding.pasteMismatch"), true);
    return;
  }
  $("#runtime-binding-target").value = copied.target;
  renderAdditionalRuntimeWidgets(widget, copied.target);
  if (![...$("#runtime-binding-device").options].some((option) => option.value === copied.device_id)) {
    $("#runtime-binding-device").append(new Option(
      t("binding.deviceUnavailable", { id: copied.device_id }), copied.device_id,
    ));
  }
  $("#runtime-binding-device").value = copied.device_id;
  populateRuntimeEntityChoices(copied.entity_id);
  $("#runtime-binding-format").value = copied.value_format || "{state}";
  $("#runtime-binding-fallback").value = copied.fallback || "";
  $("#runtime-binding-stale").value = copied.stale_after || 0;
  renderRuntimeBindingStatus();
  toast(t("toast.binding.pasted"));
}

async function cleanupRuntimeBindings() {
  if (!runtimeCanWrite()) {
    toast(t("toast.binding.saveChangesFirst"), true);
    return;
  }
  const valid = cleanRuntimeBindings(state.project, state.viewerBindings);
  const removed = state.viewerBindings.length - valid.length;
  if (!removed) return;
  if (await persistRuntimeBindings(valid)) toast(t("toast.binding.cleanedOrphans", { count: removed }));
}

function setCanvasRuntimeText(/** @type {any} */ node, /** @type {any} */ text) {
  let textNode = node.querySelector(".canvas-widget-text");
  if (!textNode) {
    textNode = document.createElement("span");
    textNode.className = "canvas-widget-text";
    node.prepend(textNode);
  }
  textNode.textContent = text;
}

function applyDesignerRuntimePreview() {
  if (!state.designerRuntimePreview) return;
  const widgets = new Map(projectWidgetEntries().map((widget) => [widget.id, widget]));
  state.viewerBindings.forEach((/** @type {any} */ binding) => {
    const widget = widgets.get(binding.widget_id);
    const node = widget ? canvasNodeByWidget.get(widget) : null;
    if (!widget || !node) return;
    const health = runtimeBindingHealth(binding, state.viewerRuntimeSources);
    node.classList.add("runtime-preview");
    node.title = t("binding.liveTitle", { status: health.status });
    if (binding.target === "text") {
      const text = health.status === "online"
        ? formatRuntimeValue(health.state.state, binding.value_format)
        : binding.fallback || widget.properties.text || widget.id;
      setCanvasRuntimeText(node, text);
    } else if (binding.target === "value" && health.status === "online") {
      const value = Number(health.state.state);
      if (Number.isFinite(value)) {
        if (["bar", "arc"].includes(widget.widget_type || "")) {
          const previewWidget = {
            ...widget, properties: { ...(widget.properties || {}), value },
          };
          node.querySelector(".canvas-value-visual")?.replaceWith(renderCanvasValueVisual(previewWidget));
        } else {
          setCanvasRuntimeText(node, `${widget.id} · ${value}`);
        }
      }
    } else if (binding.target === "state_checked" && health.status === "online") {
      const checked = runtimeBoolean(health.state.state);
      if (checked !== null) setCanvasRuntimeText(node, `${widget.id} · ${checked ? "Ein" : "Aus"}`);
    }
  });
}

function toggleWidgetFlag(/** @type {any} */ flag) {
  const widget = state.selectedWidget;
  if (!widget) return;
  pushUndo();
  widget[flag] = $(`#prop-${flag}`).checked;
  markProjectDirty();
  renderCanvas();
  renderTree();
}

// --- Project colour library ------------------------------------------

function colorLibrary() {
  if (!Array.isArray(state.project.colors)) state.project.colors = [];
  return state.project.colors;
}

function colorReferenceLocations(/** @type {any} */ id, replacement = null) {
  return findColorReferences(state.project, id, replacement);
}

function projectIdIsUsed(/** @type {any} */ id, ignoredColorId = null) {
  return idIsUsedInProject(state.project, id, ignoredColorId);
}

function resetColorLibraryForm() {
  state.editingColorId = null;
  $("#color-library-id").value = "";
  $("#color-library-hex").value = "";
  $("#color-library-picker").value = "#00a000";
  $("#color-library-error").classList.add("hidden");
  $("#save-color-library-entry").textContent = t("colorlib.form.add");
  $("#cancel-color-library-edit").classList.add("hidden");
}

function editColorLibraryEntry(/** @type {any} */ id) {
  const entry = colorLibrary().find((/** @type {any} */ item) => item.id === id);
  if (!entry) return;
  state.editingColorId = id;
  $("#color-library-id").value = entry.id;
  $("#color-library-hex").value = normalizeLibraryHex(entry.hex) || "FFFFFF";
  $("#color-library-picker").value = `#${normalizeLibraryHex(entry.hex) || "FFFFFF"}`;
  $("#color-library-error").classList.add("hidden");
  $("#save-color-library-entry").textContent = t("colorlib.form.save");
  $("#cancel-color-library-edit").classList.remove("hidden");
  $("#color-library-id").focus();
}

function saveColorLibraryEntry(/** @type {any} */ event) {
  event.preventDefault();
  const id = $("#color-library-id").value.trim();
  const hex = normalizeLibraryHex($("#color-library-hex").value);
  const error = $("#color-library-error");
  const fail = (/** @type {any} */ message) => {
    error.textContent = message;
    error.classList.remove("hidden");
  };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
    fail(t("validation.id.format"));
    return;
  }
  if (!hex) {
    fail(t("validation.color.needsHex"));
    return;
  }
  if (projectIdIsUsed(id, state.editingColorId)) {
    fail(t("validation.id.usedInProject", { id }));
    return;
  }

  pushUndo();
  if (state.editingColorId) {
    const entry = colorLibrary().find((/** @type {any} */ item) => item.id === state.editingColorId);
    if (!entry) return resetColorLibraryForm();
    const previousId = entry.id;
    entry.id = id;
    entry.hex = hex;
    if (previousId !== id) colorReferenceLocations(previousId, id);
  } else {
    colorLibrary().push({ id, hex });
  }
  markProjectDirty();
  resetColorLibraryForm();
  renderDesigner();
  toast(t("toast.color.saved", { id }));
}

function deleteColorLibraryEntry(/** @type {any} */ id) {
  const entry = colorLibrary().find((/** @type {any} */ item) => item.id === id);
  if (!entry) return;
  const references = colorReferenceLocations(id);
  if (references.length && !confirm(
    t("confirm.color.deleteWithRefs", { id, count: references.length, hex: entry.hex }),
  )) return;
  pushUndo();
  if (references.length) colorReferenceLocations(id, normalizeLibraryHex(entry.hex) || entry.hex);
  state.project.colors = colorLibrary().filter((/** @type {any} */ item) => item !== entry);
  if (state.editingColorId === id) resetColorLibraryForm();
  markProjectDirty();
  renderDesigner();
  toast(references.length
    ? t("toast.color.deletedWithRefs", { id, count: references.length })
    : t("toast.color.deleted", { id }));
}

function renderColorLibrary() {
  const list = $("#color-library-list");
  list.replaceChildren();
  colorLibrary().forEach((/** @type {any} */ entry) => {
    const hex = normalizeLibraryHex(entry.hex) || "FFFFFF";
    const row = document.createElement("div");
    row.className = "color-library-item";
    const swatch = document.createElement("span");
    swatch.className = "color-library-swatch";
    swatch.style.backgroundColor = `#${hex}`;
    const name = document.createElement("span");
    name.className = "color-library-name";
    name.textContent = entry.id;
    const value = document.createElement("small");
    value.textContent = `#${hex}`;
    name.append(value);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-button";
    edit.title = t("library.editTooltip", { id: entry.id });
    edit.textContent = "✎";
    edit.addEventListener("click", () => editColorLibraryEntry(entry.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.title = t("library.deleteTooltip", { id: entry.id });
    remove.textContent = "×";
    remove.addEventListener("click", () => deleteColorLibraryEntry(entry.id));
    row.append(swatch, name, edit, remove);
    list.append(row);
  });
  if (!colorLibrary().length) {
    const empty = document.createElement("p");
    empty.className = "color-library-empty";
    empty.textContent = t("colorlib.noProjectColors");
    list.append(empty);
  }

  const options = $("#project-color-options");
  options.replaceChildren();
  colorLibrary().forEach((/** @type {any} */ entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.label = `#${normalizeLibraryHex(entry.hex) || entry.hex}`;
    options.append(option);
  });
  $("#color-library-export-hint").classList.toggle(
    "hidden", (state.project.export_sections || []).includes("color"),
  );
  if (state.editingColorId && !colorLibrary().some((/** @type {any} */ entry) => entry.id === state.editingColorId)) {
    resetColorLibraryForm();
  }
  syncLinkedColorPickers();
}

function syncLinkedColorPickers() {
  $$(".linked-color-picker").forEach((picker) => {
    const target = picker.dataset.colorTarget
      ? document.getElementById(picker.dataset.colorTarget)
      : picker.previousElementSibling;
    const resolved = target ? resolveViewerColor(state.project, target.value) : null;
    picker.value = resolved && /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : "#000000";
  });
}

function bindColorLibrary() {
  $("#color-library-form").addEventListener("submit", saveColorLibraryEntry);
  $("#cancel-color-library-edit").addEventListener("click", resetColorLibraryForm);
  $("#color-library-picker").addEventListener("input", (/** @type {any} */ event) => {
    $("#color-library-hex").value = event.target.value.slice(1).toUpperCase();
  });
  $("#color-library-hex").addEventListener("input", (/** @type {any} */ event) => {
    const hex = normalizeLibraryHex(event.target.value);
    if (hex) $("#color-library-picker").value = `#${hex}`;
  });
  $$(".linked-color-picker").forEach((picker) => {
    const target = $(`#${picker.dataset.colorTarget}`);
    picker.addEventListener("input", () => {
      target.value = picker.value.slice(1).toUpperCase();
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
    target.addEventListener("input", syncLinkedColorPickers);
  });
}

// A curated subset of Google Fonts - the full catalog runs into the
// thousands and would need a live API call (this add-on makes none at
// runtime beyond what the user explicitly points it at). "Andere (manuell)"
// falls back to a free-text field for anything not listed here.
const GOOGLE_FONTS_CUSTOM = "__custom__";
const GOOGLE_FONTS = [
  "Abel", "Alegreya", "Anton", "Archivo", "Arimo", "Arvo", "Asap",
  "Bangers", "Barlow", "Bebas Neue", "BenchNine", "Bitter", "Bree Serif",
  "Cabin", "Cairo", "Caveat", "Cinzel", "Comfortaa", "Cormorant",
  "Cousine", "Crimson Text", "DM Sans", "DM Serif Display", "Dancing Script",
  "Dosis", "EB Garamond", "Exo", "Exo 2", "Fira Code", "Fira Sans",
  "Fjalla One", "Frank Ruhl Libre", "Grandstander", "Great Vibes",
  "Heebo", "IBM Plex Mono", "IBM Plex Sans", "IBM Plex Serif", "Inconsolata",
  "Inder", "Indie Flower", "Inter", "JetBrains Mono", "Josefin Sans",
  "Jost", "Kanit", "Karla", "Lato", "League Gothic", "Lexend", "Libre Baskerville",
  "Libre Franklin", "Lobster", "Lora", "Manrope", "Merriweather", "Montserrat",
  "Mukta", "Mulish", "Nanum Gothic", "Neuton", "Noto Sans", "Noto Serif",
  "Nunito", "Nunito Sans", "Open Sans", "Oswald", "Outfit", "Overpass",
  "PT Sans", "PT Serif", "Pacifico", "Playfair Display", "Poppins",
  "Prompt", "Public Sans", "Quicksand", "Rajdhani", "Raleway", "Righteous",
  "Roboto", "Roboto Condensed", "Roboto Mono", "Roboto Serif", "Roboto Slab",
  "Rubik", "Sacramento", "Signika", "Slabo 27px", "Sora", "Source Code Pro",
  "Source Sans Pro", "Source Serif Pro", "Space Grotesk", "Space Mono",
  "Spectral", "Teko", "Titillium Web", "Ubuntu", "Ubuntu Mono", "Varela Round",
  "Vollkorn", "Work Sans", "Yanone Kaffeesatz", "Zilla Slab",
];

// The Pictogrammers Material Design Icons webfont, offered as a one-click
// preset so users don't have to know or type this URL themselves. Font and
// icons are Apache 2.0 (see mdi-glyphs.js header) - free to redistribute a
// locally-pinned copy from here. Deliberately raw.githubusercontent.com,
// not the github.com/.../raw/... URL that redirects to it: that redirect
// hop's response carries an empty (invalid) Access-Control-Allow-Origin
// header, which fails CORS for the browser's FontFace() loader even though
// the final raw.githubusercontent.com response itself serves a correct
// "*" header and would otherwise be fine.
const MDI_WEBFONT_URL =
  "https://raw.githubusercontent.com/Templarian/MaterialDesign-Webfont/master/fonts/materialdesignicons-webfont.ttf";
const MDI_WEBFONT_DEFAULT_ID = "icons_mdi";
// Served straight out of frontend/ (mounted as static files - see
// backend/app.py), so it needs no network access at all once this add-on
// itself has loaded. Only used while the "mdi_local" add-on option is on
// (see state.system.mdi_local); off keeps the previous GitHub-backed
// behaviour, e.g. to pick up icon updates ahead of an add-on release.
function mdiLocalFontUrl() {
  return ingressAssetUrl(window.location.pathname, "vendor/materialdesignicons-webfont.ttf");
}

// --- Font library -------------------------------------------------------
//
// Mirrors the color library: a project-wide, id-addressable library that
// `text_font`/`default_font` fields reference by id (or, for a builtin LVGL
// font, by typing its name directly - hence the datalist rather than a
// strict picker in appendPropertyControl). Unlike a color, a font id has no
// literal-value fallback to substitute on delete, so a deleted font's
// references are cleared instead of replaced.

function fontReferenceLocations(/** @type {any} */ id, /** @type {any} */ replacement = null) {
  return findFontReferences(state.project, id, replacement);
}

function populateGoogleFontsSelect() {
  const select = $("#font-library-gfonts-family");
  if (select.options.length) return; // static list, populate once
  GOOGLE_FONTS.forEach((family) => select.append(new Option(family, family)));
  select.append(new Option("Andere (manuell) …", GOOGLE_FONTS_CUSTOM));
}

function updateFontSourceFieldsVisibility() {
  const source = $("#font-library-source").value;
  $("#font-library-builtin-field").classList.toggle("hidden", source !== "builtin");
  $("#font-library-gfonts-field").classList.toggle("hidden", source !== "gfonts");
  $("#font-library-gfonts-extra").classList.toggle("hidden", source !== "gfonts");
  $("#font-library-gfonts-custom-field").classList.toggle(
    "hidden", source !== "gfonts" || $("#font-library-gfonts-family").value !== GOOGLE_FONTS_CUSTOM,
  );
  $("#font-library-file-field").classList.toggle("hidden", source !== "file");
  $("#font-library-file-upload").classList.toggle("hidden", source !== "file");
  $("#font-library-web-field").classList.toggle("hidden", source !== "web");
  $("#font-library-refresh-field").classList.toggle("hidden", source !== "web");
}

/** The gfonts family currently expressed by the form, whichever of the two
 * controls (curated select vs. manual fallback) is authoritative. */
function currentGfontsFamilyInput() {
  const selected = $("#font-library-gfonts-family").value;
  return selected === GOOGLE_FONTS_CUSTOM ? $("#font-library-gfonts-custom").value.trim() : selected;
}

/** Points the select/custom-field pair at `family`, adding it as the
 * custom fallback if it isn't one of the curated options. */
function setGfontsFamilyInput(/** @type {any} */ family) {
  const select = $("#font-library-gfonts-family");
  const known = GOOGLE_FONTS.includes(family);
  select.value = known ? family : GOOGLE_FONTS_CUSTOM;
  $("#font-library-gfonts-custom").value = known ? "" : family;
}

// Update metadata belongs to the editor project, not to ESPHome's `font:`
// schema. `import_source` is persisted with a project but never exported, so
// the shared/read-only designer core needs no private model fields.
function fontSourceMetadataMap(create = false) {
  return sourceMetadataForProject(state.project, create);
}

function fontSourceMetadata(/** @type {any} */ entry) {
  return fontSourceMetadataMap()[entry?.id] || null;
}

function isManagedWebFont(/** @type {any} */ entry) {
  return Boolean(fontSourceMetadata(entry)?.url);
}

function webFontUrl(/** @type {any} */ entry) {
  return fontSourceMetadata(entry)?.url || entry?.web_url || "";
}

let glyphPreviewRequest = 0;
let glyphPreviewState = { status: "idle", family: "inherit" };
// The widget/control an open icon dialog inserts into - null while closed.
/** @type {any} */
let activeIconTarget = null;

/** This dialog only ever inserts into the MDI icon webfont, so "mdi:home"
 * name resolution is always on here (unlike the old per-font-editing dialog,
 * where the same lookup had to be disabled for non-icon fonts). */
function parseGlyphInput(/** @type {any} */ value) {
  return parseGlyphs(value, t);
}

function glyphPreviewPlaceholder() {
  return glyphPreviewState.status === "loading" ? "…" : "?";
}

function updateGlyphPreviewStatus(/** @type {any} */ message, /** @type {any} */ status) {
  const node = $("#glyph-preview-status");
  node.textContent = message;
  node.classList.toggle("ready", status === "loaded");
  node.classList.toggle("error", status === "failed");
}

/** Loads the MDI webfont once - from its pinned local revision if the
 * project's font library already has it, else from this add-on's own
 * bundled copy if "mdi_local" is on, else straight from the upstream URL -
 * so the catalog can show the real glyph shapes instead of placeholder
 * boxes. */
async function ensureMdiPreviewFont() {
  if (glyphPreviewState.status === "loaded") return;
  const request = ++glyphPreviewRequest;
  const mdiFont = fontLibrary().find((/** @type {any} */ entry) => isMdiWebfontUrl(webFontUrl(entry)));
  const cssUrl = mdiFont?.file_path
    ? assetUrl(mdiFont.file_path)
    : state.system?.mdi_local ? mdiLocalFontUrl() : MDI_WEBFONT_URL;
  glyphPreviewState = { status: "loading", family: "inherit" };
  updateGlyphPreviewStatus("Vorschaufont wird geladen …", "loading");
  renderIconCatalog();
  try {
    const cssSource = `url(${JSON.stringify(cssUrl)})`;
    const loaded = await new FontFace("esphome_mdi_preview", cssSource).load();
    if (request !== glyphPreviewRequest) return;
    document.fonts.add(loaded);
    glyphPreviewState = { status: "loaded", family: "esphome_mdi_preview" };
    updateGlyphPreviewStatus("Vorschaufont geladen.", "loaded");
  } catch (/** @type {any} */ error) {
    if (request !== glyphPreviewRequest) return;
    glyphPreviewState = { status: "failed", family: "inherit" };
    updateGlyphPreviewStatus("Vorschaufont konnte nicht geladen werden.", "failed");
  }
  renderIconCatalog();
}

function renderIconCatalog() {
  const filter = $("#glyph-search").value.trim().toLowerCase();
  const family = glyphPreviewState.status === "loaded" ? glyphPreviewState.family : "inherit";
  const catalog = $("#glyph-catalog");
  catalog.replaceChildren();
  MDI_GLYPHS.filter((entry) => (
    !filter || entry.name.includes(filter) || formatGlyphCodepoint(entry.codepoint).toLowerCase().includes(filter)
  )).forEach((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "glyph-catalog-item";
    button.title = `${entry.name} · ${formatGlyphCodepoint(entry.codepoint)}`;
    const symbol = document.createElement("span");
    symbol.className = `glyph-symbol${glyphPreviewState.status === "loaded" ? "" : " preview-unavailable"}`;
    symbol.style.fontFamily = family;
    symbol.textContent = glyphPreviewState.status === "loaded" ? entry.glyph : glyphPreviewPlaceholder();
    const description = document.createElement("span");
    description.textContent = entry.name;
    const code = document.createElement("small");
    code.textContent = formatGlyphCodepoint(entry.codepoint);
    description.append(code);
    button.append(symbol, description);
    button.addEventListener("click", () => insertMdiGlyphs(entry.glyph));
    catalog.append(button);
  });
  if (!catalog.children.length) {
    const empty = document.createElement("p");
    empty.className = "glyph-selected-empty";
    empty.textContent = t("mdi.noMatches");
    catalog.append(empty);
  }
}

/** Opens the icon picker for a specific text control (a label/button's
 * `text` property). Insertion both writes the glyph into that control and
 * wires up an MDI font at the dialog's chosen size as the widget's
 * text_font - an icon glyph is meaningless without the font that actually
 * contains it. The size field starts at the widget's current MDI font size
 * if it already has one, else the library preset's default (24px). */
function openIconInsertDialog(/** @type {any} */ widget, /** @type {any} */ control) {
  activeIconTarget = { widget, control };
  pushUndo();
  $("#glyph-input").value = "";
  $("#glyph-search").value = "";
  $("#glyph-input-error").classList.add("hidden");
  $("#glyph-catalog-version").textContent = `Lokaler MDI-Katalog ${MDI_CATALOG_VERSION}`;
  const currentFontId = /** @type {any} */ (
    effectiveViewerStyle(state.project, widget, state.activeState)
  ).text_font;
  const currentFont = fontLibrary().find((/** @type {any} */ entry) => entry.id === currentFontId);
  const currentIsMdi = currentFont && isMdiWebfontUrl(webFontUrl(currentFont));
  $("#glyph-size").value = (currentIsMdi && Number(currentFont.size)) || 24;
  renderIconCatalog();
  $("#glyph-dialog").showModal();
  ensureMdiPreviewFont();
}

async function insertMdiGlyphs(/** @type {any} */ glyphs) {
  if (!activeIconTarget) return;
  const { widget } = activeIconTarget;
  const mdiFont = await ensureMdiFontAtSize($("#glyph-size").value);
  // ensureMdiFontAtSize() may have re-rendered the properties panel (new
  // font registered), which replaces property controls - re-resolve by id
  // so later inserts keep landing in the control the user is actually
  // looking at.
  const control = document.getElementById(activeIconTarget.control.id) || activeIconTarget.control;
  activeIconTarget.control = control;

  if (mdiFont) {
    const fauxProperty = { part: "main", category: "style" };
    const styleTarget = propertyTarget(widget, fauxProperty, true, "style");
    if (styleTarget.text_font !== mdiFont.id) styleTarget.text_font = mdiFont.id;
  }
  const start = control.selectionStart ?? control.value.length;
  const end = control.selectionEnd ?? control.value.length;
  control.value = control.value.slice(0, start) + glyphs + control.value.slice(end);
  const pos = start + glyphs.length;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.focus();
  control.setSelectionRange(pos, pos);
  markProjectDirty();
  renderCanvas();
}

function addGlyphInput() {
  const error = $("#glyph-input-error");
  try {
    const parsed = parseGlyphInput($("#glyph-input").value);
    if (!parsed.length) throw new Error(t("validation.glyph.needsOne"));
    insertMdiGlyphs(parsed.join(""));
    $("#glyph-input").value = "";
    error.classList.add("hidden");
  } catch (/** @type {any} */ problem) {
    error.textContent = problem.message;
    error.classList.remove("hidden");
  }
}

function bindGlyphEditor() {
  $("#close-glyph-dialog").addEventListener("click", () => $("#glyph-dialog").close());
  $("#finish-glyph-dialog").addEventListener("click", () => $("#glyph-dialog").close());
  $("#add-glyph-input").addEventListener("click", addGlyphInput);
  $("#glyph-input").addEventListener("keydown", (/** @type {any} */ event) => {
    if (event.key === "Enter") { event.preventDefault(); addGlyphInput(); }
  });
  $("#glyph-search").addEventListener("input", renderIconCatalog);
  $("#glyph-dialog").addEventListener("close", () => {
    activeIconTarget = null;
    renderProperties();
  });
}

function resetFontLibraryForm() {
  state.editingFontId = null;
  $("#font-library-id").value = "";
  $("#font-library-source").value = "builtin";
  $("#font-library-builtin-name").value = "";
  $("#font-library-gfonts-family").selectedIndex = 0;
  $("#font-library-gfonts-custom").value = "";
  $("#font-library-gfonts-weight").value = "400";
  $("#font-library-gfonts-italic").checked = false;
  $("#font-library-file-path").value = "";
  $("#font-library-web-url").value = "";
  $("#font-library-refresh").value = "never";
  $("#font-library-size").value = "16";
  $("#font-library-bpp").value = "4";
  $("#font-library-error").classList.add("hidden");
  $("#save-font-library-entry").textContent = t("fontlib.form.add");
  $("#cancel-font-library-edit").classList.add("hidden");
  updateFontSourceFieldsVisibility();
}

function editFontLibraryEntry(/** @type {any} */ id) {
  const entry = fontLibrary().find((/** @type {any} */ item) => item.id === id);
  if (!entry) return;
  state.editingFontId = id;
  $("#font-library-id").value = entry.id;
  $("#font-library-source").value = isManagedWebFont(entry) ? "web" : (entry.source_kind || "builtin");
  $("#font-library-builtin-name").value = entry.builtin_name || "";
  setGfontsFamilyInput(entry.gfonts_family || "");
  $("#font-library-gfonts-weight").value = entry.gfonts_weight || 400;
  $("#font-library-gfonts-italic").checked = Boolean(entry.gfonts_italic);
  $("#font-library-file-path").value = entry.file_path || "";
  $("#font-library-web-url").value = webFontUrl(entry);
  const refresh = fontSourceMetadata(entry)?.refresh || entry.extra?.file?.refresh || "never";
  if (![...$("#font-library-refresh").options].some((option) => option.value === refresh)) {
    $("#font-library-refresh").append(new Option(refresh, refresh));
  }
  $("#font-library-refresh").value = refresh;
  $("#font-library-size").value = entry.size || 16;
  $("#font-library-bpp").value = String(entry.bpp || 4);
  $("#font-library-error").classList.add("hidden");
  $("#save-font-library-entry").textContent = t("fontlib.form.save");
  $("#cancel-font-library-edit").classList.remove("hidden");
  updateFontSourceFieldsVisibility();
  $("#font-library-id").focus();
}

function saveFontLibraryEntry(/** @type {any} */ event) {
  event.preventDefault();
  const id = $("#font-library-id").value.trim();
  const source = $("#font-library-source").value;
  const error = $("#font-library-error");
  const fail = (/** @type {any} */ message) => {
    error.textContent = message;
    error.classList.remove("hidden");
  };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
    fail(t("validation.id.format"));
    return;
  }
  if (projectIdIsUsed(id) && id !== state.editingFontId) {
    fail(t("validation.id.usedInProject", { id }));
    return;
  }
  if (source === "builtin" && !$("#font-library-builtin-name").value.trim()) {
    fail(t("validation.font.needsBuiltinName"));
    return;
  }
  if (source === "gfonts" && !currentGfontsFamilyInput()) {
    fail(t("validation.font.needsGfontsFamily"));
    return;
  }
  if (source === "file" && !$("#font-library-file-path").value.trim()) {
    fail(t("validation.font.needsFilePath"));
    return;
  }
  if (source === "web" && !isRemoteAsset($("#font-library-web-url").value.trim())) {
    fail(t("validation.font.needsWebUrl"));
    return;
  }
  if (!state.editingFontId) {
    const candidate = {
      source_kind: source,
      size: clamp(Number($("#font-library-size").value) || 16, 1, 255),
      bpp: Number($("#font-library-bpp").value) || 4,
      builtin_name: source === "builtin" ? $("#font-library-builtin-name").value.trim() : "",
      gfonts_family: source === "gfonts" ? currentGfontsFamilyInput() : "",
      gfonts_weight: source === "gfonts" ? (Number($("#font-library-gfonts-weight").value) || 400) : 400,
      gfonts_italic: source === "gfonts" && $("#font-library-gfonts-italic").checked,
      file_path: source === "file" ? $("#font-library-file-path").value.trim() : "",
      web_url: source === "web" ? $("#font-library-web-url").value.trim() : "",
    };
    const duplicate = findEquivalentFontEntry(candidate);
    if (duplicate) {
      fail(t("validation.font.alreadyExists", { id: duplicate.id }));
      return;
    }
  }

  pushUndo();
  let entry;
  const previousId = state.editingFontId || id;
  const previousMeta = fontSourceMetadataMap()[previousId] || null;
  const previousWebUrl = previousMeta?.url || "";
  if (state.editingFontId) {
    entry = fontLibrary().find((/** @type {any} */ item) => item.id === state.editingFontId);
    if (!entry) return resetFontLibraryForm();
    if (previousId !== id) fontReferenceLocations(previousId, id);
    entry.id = id;
  } else {
    entry = { id, external: false, extra: {} };
    fontLibrary().push(entry);
  }
  const requestedWebUrl = source === "web" ? $("#font-library-web-url").value.trim() : "";
  const keepManagedRevision = Boolean(previousMeta && previousWebUrl === requestedWebUrl && entry.file_path);
  entry.source_kind = keepManagedRevision ? "file" : source;
  entry.builtin_name = source === "builtin" ? $("#font-library-builtin-name").value.trim() : "";
  entry.gfonts_family = source === "gfonts" ? currentGfontsFamilyInput() : "";
  entry.gfonts_weight = source === "gfonts" ? (Number($("#font-library-gfonts-weight").value) || 400) : 400;
  entry.gfonts_italic = source === "gfonts" && $("#font-library-gfonts-italic").checked;
  entry.file_path = source === "file"
    ? $("#font-library-file-path").value.trim()
    : (keepManagedRevision ? entry.file_path : "");
  entry.web_url = source === "web" && !keepManagedRevision ? requestedWebUrl : "";
  entry.extra = entry.extra && typeof entry.extra === "object" ? entry.extra : {};
  if (source === "web") {
    entry.extra.file = {
      ...(entry.extra.file && typeof entry.extra.file === "object" ? entry.extra.file : {}),
      type: "web", url: requestedWebUrl, refresh: $("#font-library-refresh").value || "never",
    };
  }
  const metadata = fontSourceMetadataMap(true);
  if (previousId !== id) delete metadata[previousId];
  if (keepManagedRevision) {
    metadata[id] = { ...previousMeta, url: requestedWebUrl, refresh: $("#font-library-refresh").value || "never" };
  } else {
    delete metadata[id];
  }
  entry.size = clamp(Number($("#font-library-size").value) || 16, 1, 255);
  entry.bpp = Number($("#font-library-bpp").value) || 4;
  fontSourceStatuses.delete(state.editingFontId || id);
  fontSourceStatuses.delete(id);

  markProjectDirty();
  resetFontLibraryForm();
  renderDesigner();
  toast(t("toast.font.saved", { id }));
}

function deleteFontLibraryEntry(/** @type {any} */ id) {
  const entry = fontLibrary().find((/** @type {any} */ item) => item.id === id);
  if (!entry) return;
  const references = fontReferenceLocations(id);
  if (references.length && !confirm(
    t("confirm.font.deleteWithRefs", { id, count: references.length }),
  )) return;
  pushUndo();
  if (references.length) fontReferenceLocations(id, "");
  state.project.fonts = fontLibrary().filter((/** @type {any} */ item) => item !== entry);
  delete fontSourceMetadataMap(true)[id];
  fontLoadState.delete(id);
  if (state.editingFontId === id) resetFontLibraryForm();
  markProjectDirty();
  renderDesigner();
  toast(references.length
    ? t("toast.font.deletedWithRefs", { id, count: references.length })
    : t("toast.font.deleted", { id }));
}

/** @type {Record<string, string>} */
const FONT_SOURCE_LABELS = {
  builtin: t("fontlib.source.builtin"),
  gfonts: t("fontlib.source.gfonts"),
  file: t("fontlib.source.file"),
  web: t("fontlib.source.web"),
};
const fontSourceStatuses = new Map();

function fontSourceStatus(/** @type {any} */ entry) {
  const status = fontSourceStatuses.get(entry.id);
  if (status?.url === webFontUrl(entry)) return status;
  if (status) fontSourceStatuses.delete(entry.id);
  return isManagedWebFont(entry)
    ? { state: "managed", label: t("fontlib.status.managed") }
    : { state: "unmanaged", label: t("fontlib.status.unmanaged") };
}

async function checkFontSource(/** @type {any} */ entry, manual = false) {
  if ((entry.source_kind !== "web" && !isManagedWebFont(entry)) || !state.capabilities["designer.asset_write"]) return;
  const metadata = fontSourceMetadata(entry) || {};
  const existing = fontSourceStatuses.get(entry.id);
  if (existing?.state === "checking") return;
  fontSourceStatuses.set(entry.id, { state: "checking", label: t("fontlib.status.checking"), url: webFontUrl(entry) });
  renderFontLibrary();
  try {
    const result = await api("designer/font-sources/check", {
      method: "POST",
      body: JSON.stringify({
        url: webFontUrl(entry),
        etag: metadata.etag || "",
        last_modified: metadata.last_modified || "",
        sha256: metadata.sha256 || "",
      }),
    });
    const changed = !isManagedWebFont(entry) || result.changed;
    fontSourceStatuses.set(entry.id, changed
      ? { state: "changed", label: isManagedWebFont(entry) ? t("fontlib.status.updateAvailable") : t("fontlib.status.localMissing"), url: webFontUrl(entry) }
      : { state: "current", label: t("fontlib.status.unchanged"), url: webFontUrl(entry) });
    if (manual) toast(changed ? t("toast.font.updateAvailableFor", { id: entry.id }) : t("toast.font.upToDate", { id: entry.id }));
  } catch (/** @type {any} */ error) {
    fontSourceStatuses.set(entry.id, { state: "error", label: t("fontlib.status.checkFailed"), url: webFontUrl(entry) });
    if (manual) toast(t("toast.font.checkFailed", { error: error.message }), true);
  }
  renderFontLibrary();
}

async function updateFontSource(/** @type {any} */ entry) {
  if ((entry.source_kind !== "web" && !isManagedWebFont(entry)) || !state.capabilities["designer.asset_write"]) return;
  fontSourceStatuses.set(entry.id, { state: "checking", label: t("fontlib.status.downloading"), url: webFontUrl(entry) });
  renderFontLibrary();
  try {
    const result = await api("designer/font-sources/update", {
      method: "POST", body: JSON.stringify({ id: entry.id, url: webFontUrl(entry) }),
    });
    const selectedGlyphs = uniqueGlyphs(entry.glyphs || []);
    if (selectedGlyphs.length && state.capabilities["designer.asset_read"]) {
      try {
        const coverage = await api("designer/fonts/glyph-coverage", {
          method: "POST",
          body: JSON.stringify({ path: result.path, codepoints: selectedGlyphs.map(glyphCodepoint) }),
        });
        if (coverage.missing_count && !confirm(
          t("confirm.font.missingGlyphs", { count: coverage.missing_count }),
        )) {
          fontSourceStatuses.set(entry.id, {
            state: "changed",
            label: t("fontlib.status.missingGlyphs", { count: coverage.missing_count }),
            url: webFontUrl(entry),
          });
          renderFontLibrary();
          toast(t("toast.font.revisionUnchanged"), true);
          return;
        }
      } catch (/** @type {any} */ coverageError) {
        toast(t("toast.font.glyphCheckFailed", { error: coverageError.message }), true);
      }
    }
    pushUndo();
    const sourceUrl = webFontUrl(entry);
    entry.source_kind = "file";
    entry.file_path = result.path;
    entry.web_url = "";
    fontSourceMetadataMap(true)[entry.id] = {
      url: sourceUrl,
      refresh: "never",
      etag: result.etag || "",
      last_modified: result.last_modified || "",
      sha256: result.sha256,
      size: result.size || 0,
      checked_at: result.checked_at || "",
      path: result.path,
    };
    fontLoadState.delete(entry.id);
    fontSourceStatuses.set(entry.id, { state: "current", label: t("fontlib.status.updatedLocally"), url: sourceUrl });
    markProjectDirty();
    renderDesigner();
    if (!(state.project.export_sections || []).includes("font")) {
      toast(t("toast.font.savedLocallyNoExport", { path: result.path }), false);
    } else {
      toast(t("toast.font.pinnedLocally", { id: entry.id, path: result.path }));
    }
  } catch (/** @type {any} */ error) {
    fontSourceStatuses.set(entry.id, { state: "error", label: t("fontlib.status.updateFailed"), url: webFontUrl(entry) });
    renderFontLibrary();
    toast(t("toast.font.updateFailed", { error: error.message }), true);
  }
}

function renderFontLibrary() {
  const list = $("#font-library-list");
  list.replaceChildren();
  fontLibrary().forEach((/** @type {any} */ entry) => {
    const row = document.createElement("div");
    row.className = "font-library-item";
    const name = document.createElement("span");
    name.className = "font-library-name";
    name.textContent = entry.id;
    const detail = document.createElement("small");
    const sourceLabel = isManagedWebFont(entry)
      ? t("fontlib.sourceWebPinned")
      : (FONT_SOURCE_LABELS[entry.source_kind] || entry.source_kind);
    detail.textContent = `${sourceLabel} · ${entry.size}px`;
    name.append(detail);
    const actions = document.createElement("span");
    actions.className = "font-library-actions";
    if (entry.source_kind === "web" || isManagedWebFont(entry)) {
      const statusData = fontSourceStatus(entry);
      const status = document.createElement("span");
      status.className = `font-source-status ${statusData.state}`;
      status.textContent = statusData.label;
      name.append(status);
      if (state.capabilities["designer.asset_write"]) {
        const check = document.createElement("button");
        check.type = "button";
        check.className = "icon-button";
        check.title = t("fontlib.checkTooltip", { id: entry.id });
        check.textContent = "↻";
        check.disabled = statusData.state === "checking";
        check.addEventListener("click", () => checkFontSource(entry, true));
        actions.append(check);
        if (!isManagedWebFont(entry) || statusData.state === "changed") {
          const update = document.createElement("button");
          update.type = "button";
          update.className = "button subtle compact";
          update.textContent = isManagedWebFont(entry) ? t("fontlib.updateButton") : t("fontlib.localButton");
          update.disabled = statusData.state === "checking";
          update.addEventListener("click", () => updateFontSource(entry));
          actions.append(update);
        }
      }
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-button";
    edit.title = t("library.editTooltip", { id: entry.id });
    edit.textContent = "✎";
    edit.addEventListener("click", () => editFontLibraryEntry(entry.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.title = t("library.deleteTooltip", { id: entry.id });
    remove.textContent = "×";
    remove.addEventListener("click", () => deleteFontLibraryEntry(entry.id));
    actions.append(edit, remove);
    row.append(name, actions);
    list.append(row);
    if (
      (entry.source_kind === "web" || isManagedWebFont(entry))
      && isManagedWebFont(entry)
      && (() => { const meta = fontSourceMetadata(entry); return meta?.etag || meta?.last_modified || meta?.sha256; })()
      && !fontSourceStatuses.has(entry.id)
      && state.capabilities["designer.asset_write"]
    ) {
      fontSourceStatuses.set(entry.id, { state: "queued", label: t("fontlib.checkQueued"), url: webFontUrl(entry) });
      queueMicrotask(() => checkFontSource(entry));
    }
  });
  if (!fontLibrary().length) {
    const empty = document.createElement("p");
    empty.className = "font-library-empty";
    empty.textContent = t("fontlib.noProjectFonts");
    list.append(empty);
  }

  const defaultSelect = $("#default-font");
  const currentDefault = state.project.default_font || "";
  defaultSelect.replaceChildren(new Option(t("fontlib.defaultFontNone"), ""));
  fontLibrary().forEach((/** @type {any} */ entry) => defaultSelect.append(new Option(entry.id, entry.id)));
  if (currentDefault && !fontLibrary().some((/** @type {any} */ entry) => entry.id === currentDefault)) {
    defaultSelect.append(new Option(t("fontlib.unknownFontSuffix", { id: currentDefault }), currentDefault));
  }
  defaultSelect.value = currentDefault;

  const options = $("#project-font-options");
  options.replaceChildren();
  fontLibrary().forEach((/** @type {any} */ entry) => options.append(new Option(entry.id)));

  $("#font-library-export-hint").classList.toggle(
    "hidden", (state.project.export_sections || []).includes("font"),
  );
  if (state.editingFontId && !fontLibrary().some((/** @type {any} */ entry) => entry.id === state.editingFontId)) {
    resetFontLibraryForm();
  }
}

async function uploadFontFile(/** @type {any} */ file) {
  const content_base64 = await blobToBase64(file);
  const result = await api("designer/assets/fonts", {
    method: "POST", body: JSON.stringify({ name: file.name, content_base64 }),
  });
  return result.path;
}

/** Registers a new MDI Font Library entry (source_kind "web", refresh
 * "never") at exactly `size` and, where write access is available,
 * immediately pins a local revision the same way the manual "Update"/
 * "Lokal" button does - so the result is a font that's fixed in the
 * library from the start, not just a URL the user still has to fetch
 * themselves. Shared by the Font Library's "Add MDI icons" preset and the
 * icon-insert dialog's per-size auto-provisioning. */
async function registerAndPinMdiFont(/** @type {any} */ id, /** @type {any} */ size) {
  pushUndo();
  const entry = {
    id, external: false,
    source_kind: "web", builtin_name: "", gfonts_family: "", gfonts_weight: 400, gfonts_italic: false,
    file_path: "", web_url: MDI_WEBFONT_URL,
    extra: { file: { type: "web", url: MDI_WEBFONT_URL, refresh: "never" } },
    size, bpp: 4, glyphs: [],
  };
  fontLibrary().push(entry);
  markProjectDirty();
  renderDesigner();

  if (!state.capabilities["designer.asset_write"]) {
    toast(t("toast.font.mdiCreatedNoWrite", { id }), true);
    return entry;
  }
  toast(t("toast.font.mdiPinning", { id }));
  await updateFontSource(entry);
  return entry;
}

/** One-click preset in the Font Library section: pre-provisions the
 * default-size MDI font without assigning it to any widget yet. */
async function addMdiIconFont() {
  const existing = fontLibrary().find((/** @type {any} */ entry) => isMdiWebfontUrl(webFontUrl(entry)));
  if (existing) {
    editFontLibraryEntry(existing.id);
    toast(t("toast.font.mdiAlreadyUsed", { id: existing.id }));
    return;
  }
  let id = MDI_WEBFONT_DEFAULT_ID;
  let suffix = 2;
  while (projectIdIsUsed(id)) id = `${MDI_WEBFONT_DEFAULT_ID}_${suffix++}`;
  await registerAndPinMdiFont(id, 24);
}

/** Finds (or registers + pins) an MDI Font Library entry at exactly the
 * requested size, so the icon-insert dialog's own size field can offer a
 * size independent of the library - while still landing every icon
 * inserted at that size on one shared entry, not a fresh one per insert.
 * ESPHome bakes bitmap fonts at one fixed pixel size per font: entry, so a
 * distinct size always needs its own entry; the glyph list each one
 * exports with is already scoped per font id (see _is_mdi_font()/
 * _collect_used_glyphs() in yamlexport.py), so this never bakes more than
 * what is actually used at that specific size. */
async function ensureMdiFontAtSize(/** @type {any} */ size) {
  const targetSize = clamp(Math.round(Number(size)) || 24, 1, 255);
  const existing = fontLibrary().find(
    (/** @type {any} */ entry) => isMdiWebfontUrl(webFontUrl(entry)) && Number(entry.size) === targetSize,
  );
  if (existing) return existing;
  let id = targetSize === 24 ? MDI_WEBFONT_DEFAULT_ID : `${MDI_WEBFONT_DEFAULT_ID}_${targetSize}`;
  let suffix = 2;
  while (projectIdIsUsed(id)) id = `${MDI_WEBFONT_DEFAULT_ID}_${targetSize}_${suffix++}`;
  return registerAndPinMdiFont(id, targetSize);
}

function bindFontLibrary() {
  $("#add-mdi-font").addEventListener("click", addMdiIconFont);
  populateGoogleFontsSelect();
  bindGlyphEditor();
  $("#font-library-form").addEventListener("submit", saveFontLibraryEntry);
  $("#cancel-font-library-edit").addEventListener("click", resetFontLibraryForm);
  $("#font-library-source").addEventListener("change", updateFontSourceFieldsVisibility);
  $("#font-library-gfonts-family").addEventListener("change", updateFontSourceFieldsVisibility);
  $("#font-library-file-pick").addEventListener("click", () => $("#font-library-file-input").click());
  $("#font-library-file-input").addEventListener("change", async () => {
    const file = $("#font-library-file-input").files[0];
    if (!file) return;
    try {
      const path = await uploadFontFile(file);
      $("#font-library-file-path").value = path;
      toast(t("toast.font.fileUploaded", { name: file.name }));
    } catch (/** @type {any} */ error) {
      toast(t("toast.font.uploadFailed", { error: error.message }), true);
    } finally {
      $("#font-library-file-input").value = "";
    }
  });
  $("#default-font").addEventListener("change", (/** @type {any} */ event) => {
    pushUndo();
    state.project.default_font = event.target.value;
    markProjectDirty();
    renderCanvas();
  });
  updateFontSourceFieldsVisibility();
}

// --- Named styles -----------------------------------------------------
// The model persists exactly two style modes: "inline" (style_tree applies
// directly to the widget) and "named" (style_refs point into the project's
// style library). "Save as named style" is a UI action that moves the
// inline tree into the library and switches the mode - not a third state.

function styleLibrary() {
  if (!Array.isArray(state.project.styles)) state.project.styles = [];
  return state.project.styles;
}

function renderStyleControls(/** @type {any} */ widget) {
  const mode = widget.style_mode === "named" ? "named" : "inline";
  $("#style-mode").value = mode;

  const select = $("#style-ref");
  select.replaceChildren(new Option("— keiner —", ""));
  styleLibrary().forEach((/** @type {any} */ entry) => select.append(new Option(entry.id, entry.id)));
  const current = (widget.style_refs || [])[0] || "";
  if (current && !styleLibrary().some((/** @type {any} */ entry) => entry.id === current)) {
    select.append(new Option(`${current} (fehlt)`, current));
  }
  select.value = current;

  $("#style-ref-field").classList.toggle("hidden", mode !== "named");
  $("#save-as-style").disabled = mode !== "inline";
  // In named mode the widget's own style tree is not what gets rendered,
  // so editing the inline style properties would be misleading.
  $("#dynamic-properties").classList.toggle("style-locked", mode === "named");
}

function changeStyleMode() {
  const widget = state.selectedWidget;
  if (!widget) return;
  pushUndo();
  widget.style_mode = $("#style-mode").value === "named" ? "named" : "inline";
  if (widget.style_mode === "inline") widget.style_refs = [];
  markProjectDirty();
  renderDesigner();
}

function changeStyleRef() {
  const widget = state.selectedWidget;
  if (!widget) return;
  pushUndo();
  const value = $("#style-ref").value;
  widget.style_refs = value ? [value] : [];
  markProjectDirty();
  renderCanvas();
}

function saveCurrentStyleAsNamed() {
  const widget = state.selectedWidget;
  if (!widget) return;
  if (!Object.keys(widget.style_tree || {}).length) {
    toast(t("toast.style.noStyleToSave"), true);
    return;
  }
  const suggestion = `style_${styleLibrary().length + 1}`;
  const name = (prompt(t("prompt.style.name"), suggestion) || "").trim();
  if (!name) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    toast(t("toast.style.invalidName"), true);
    return;
  }
  if (styleLibrary().some((/** @type {any} */ entry) => entry.id === name)) {
    toast(t("toast.style.nameExists", { name }), true);
    return;
  }
  pushUndo();
  styleLibrary().push({ id: name, style_tree: JSON.parse(JSON.stringify(widget.style_tree)) });
  widget.style_tree = {};
  widget.style_mode = "named";
  widget.style_refs = [name];
  markProjectDirty();
  renderDesigner();
  toast(t("toast.style.saved", { name }));
}

// Rarely-tweaked style clusters the schema tags with a PropertyDef.group -
// folded into a <details> instead of listed flat, so a widget with every
// style property offered doesn't turn the panel into one long scroll.
// Collapsed by default; the open/closed choice is remembered per group (not
// per widget) in localStorage, so it does not reset every time the
// selection changes.
/** @type {Record<string, string>} */
const PROPERTY_GROUP_LABELS = {
  spacing: "dynprops.group.spacing",
  border: "dynprops.group.border",
  shadow: "dynprops.group.shadow",
};
const COLLAPSED_GROUPS_KEY = "designer.collapsedPropertyGroups";

function loadCollapsedGroups() {
  const defaults = { spacing: true, border: true, shadow: true, actions: true };
  try {
    const stored = JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_KEY) || "{}");
    return { ...defaults, ...stored };
  } catch {
    return defaults;
  }
}

const collapsedPropertyGroups = loadCollapsedGroups();

function togglePropertyGroup(/** @type {any} */ key, /** @type {any} */ collapsed) {
  collapsedPropertyGroups[key] = collapsed;
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsedPropertyGroups));
  } catch {
    // Best-effort only - the in-memory toggle for this session still works.
  }
}

function appendPropertyGroup(/** @type {any} */ container, /** @type {any} */ key) {
  const details = document.createElement("details");
  details.className = "property-group";
  details.open = !collapsedPropertyGroups[key];
  const summary = document.createElement("summary");
  summary.textContent = t(PROPERTY_GROUP_LABELS[key] || key);
  details.append(summary);
  details.addEventListener("toggle", () => togglePropertyGroup(key, !details.open));
  container.append(details);
  return details;
}

function renderDynamicProperties(/** @type {any} */ widget) {
  const container = $("#dynamic-properties");
  container.replaceChildren();
  const schema = state.schemas.find((/** @type {any} */ item) => item.type_key === widget.widget_type);
  if (!schema) return;
  // Layout and grid placement have their own sections in the markup, so the
  // panel can read top-down: what it is, where it sits, then how it looks.
  const inline = schema.properties.filter(
    (/** @type {any} */ property) => property.category === "content" || property.category === "style");

  let previousSection = "";
  /** @type {any} */
  let openGroup = null;
  let openGroupKey = "";
  inline.forEach((/** @type {any} */ property, /** @type {any} */ index) => {
    const section = property.category === "content"
      ? t("dynprops.content")
      : t("dynprops.stylePart", { part: property.part }) + (state.activeState ? ` · ${state.activeState}` : "");
    if (section !== previousSection) {
      const heading = document.createElement("div");
      heading.className = "property-section";
      heading.textContent = section;
      container.append(heading);
      previousSection = section;
      openGroup = null;
      openGroupKey = "";
    }
    const groupKey = property.category === "style" ? property.group || "" : "";
    if (groupKey) {
      if (groupKey !== openGroupKey) {
        openGroup = appendPropertyGroup(container, groupKey);
        openGroupKey = groupKey;
      }
      openGroup.append(propertyField(widget, property, index));
      return;
    }
    openGroup = null;
    openGroupKey = "";
    container.append(propertyField(widget, property, index));
  });
}

function renderLayoutSection(/** @type {any} */ widget) {
  const schema = state.schemas.find((/** @type {any} */ item) => item.type_key === widget.widget_type);
  const properties = (schema?.properties || []).filter((/** @type {any} */ p) => p.category === "layout");
  $("#layout-section").classList.toggle("hidden", !properties.length);
  if (!properties.length) return;

  const container = $("#layout-properties");
  container.replaceChildren();
  const type = String((widget.layout || {}).type || "NONE").toUpperCase();
  properties.forEach((/** @type {any} */ property, /** @type {any} */ index) => {
    // Flex and grid options are mutually exclusive; showing both at once
    // invites setting grid tracks on a flex container.
    if (property.key.startsWith("flex_") && type !== "FLEX") return;
    if (property.key.startsWith("grid_") && type !== "GRID") return;
    container.append(propertyField(widget, property, `lay-${index}`));
  });
}

function propertyField(/** @type {any} */ widget, /** @type {any} */ property, /** @type {any} */ index, /** @type {any} */ targetKind = property.category) {
  const label = document.createElement("label");
  label.textContent = widget.widget_type === "button" && property.key === "checkable"
    ? "Einrastfunktion (Schalter)"
    : property.label;
  const target = propertyTarget(widget, property, false, targetKind);
  const value = target?.[property.key];
  const control = propertyControl(property, value, index);
  control.addEventListener("focus", pushUndo);
  control.addEventListener("change", () => updateDynamicProperty(widget, property, control, targetKind));
  control.addEventListener("input", () => updateDynamicProperty(widget, property, control, targetKind));
  if (property.kind === "bool") label.className = "checkbox-field";
  appendPropertyControl(label, control, property, widget);
  return label;
}

// ESPHome's `image: type:` values - the colour format a PNG gets converted
// to. There is no per-image-entry editor anywhere else in the app (resize/
// dither aren't editable either), so this rides along with whatever
// control already lets you pick the image itself.
const IMAGE_TYPE_OPTIONS = [
  ["", "— Standard —"],
  ["BINARY", "BINARY"],
  ["TRANSPARENT_BINARY", "TRANSPARENT_BINARY"],
  ["GRAYSCALE", "GRAYSCALE"],
  ["RGB565", "RGB565"],
  ["RGB", "RGB"],
  ["RGBA", "RGBA"],
];

// ESPHome's `image: transparency:` values - how (or whether) the compiled
// firmware image keeps an alpha channel. This only affects the real
// device: the browser preview always shows the PNG's actual alpha data
// regardless of this setting (see displayableImageSource()/assetUrl()),
// which is why a project could look correctly transparent here while
// compiling opaque - "opaque" (the ESPHome default) silently drops alpha
// unless the source's own type already implies transparency (see
// IMAGE_TYPE_OPTIONS's TRANSPARENT_BINARY/RGBA).
const IMAGE_TRANSPARENCY_OPTIONS = [
  ["opaque", "opaque"],
  ["chroma_key", "chroma_key"],
  ["alpha_channel", "alpha_channel"],
];

/** @type {any | null} */
let meterConfiguratorWidget = null;
/** @type {any[]} */
let meterConfiguratorScales = [];
let meterConfiguratorScaleIndex = 0;
let meterPreviewIndicatorId = "";
/** @type {Map<string, number>} */
let meterPreviewTestValues = new Map();

function defaultMeterScale() {
  return {
    range_from: 0, range_to: 100, angle_range: 240, rotation: 150,
    draw_ticks_on_top: true,
    ticks: {
      count: 11, width: 2, length: 8, color: "808080",
      major: { stride: 2, width: 4, length: 12, color: "FFFFFF", label_gap: 6 },
    },
    indicators: [],
  };
}

function defaultMeterIndicator(/** @type {string} */ kind = "line") {
  const used = new Set(actionTargetEntries().map((/** @type {any} */ entry) => entry.id));
  meterConfiguratorScales.forEach((/** @type {any} */ scale) => (scale.indicators || []).forEach((/** @type {any} */ entry) => {
    const config = entry && typeof entry === "object" ? Object.values(entry)[0] : null;
    if (config && typeof config === "object" && config.id) used.add(String(config.id));
  }));
  let id = "meter_indicator";
  let suffix = 2;
  while (used.has(id)) id = `meter_indicator_${suffix++}`;
  if (kind === "arc") return { arc: { id, start_value: 0, end_value: 50, width: 8, color: "20C7B7", rounded: true } };
  if (kind === "image") return { image: { id, src: "", value: 0, pivot_x: 0, pivot_y: 0, opa: "100%" } };
  if (kind === "tick_style") return { tick_style: { start_value: 0, end_value: 100, width: 3, color_start: "20C7B7", color_end: "FF0000", local: true } };
  return { line: { id, value: 0, width: 3, length: "85%", radial_offset: 0, color: "FF0000", rounded: true } };
}

function openMeterConfigurator(/** @type {any} */ widget) {
  meterConfiguratorWidget = widget;
  const source = widget.properties?.scales;
  meterConfiguratorScales = JSON.parse(JSON.stringify(Array.isArray(source) && source.length ? source : [defaultMeterScale()]));
  meterConfiguratorScaleIndex = 0;
  meterPreviewIndicatorId = "";
  meterPreviewTestValues = new Map();
  $("#meter-dialog-widget-id").textContent = widget.id;
  renderMeterConfigurator();
  $("#meter-dialog").showModal();
}

function meterField(
  /** @type {HTMLElement} */ parent, /** @type {string} */ labelText,
  /** @type {any} */ target, /** @type {string} */ key,
  /** @type {{type?: string, step?: string, wide?: boolean, color?: boolean}} */ options = {},
) {
  const label = document.createElement("label");
  if (options.wide) label.className = "wide";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const input = document.createElement("input");
  input.type = options.type || "number";
  if (options.step) input.step = options.step;
  if (input.type === "checkbox") input.checked = Boolean(target[key]);
  else input.value = String(target[key] ?? "");
  input.addEventListener("input", () => {
    target[key] = input.type === "checkbox" ? input.checked
      : input.type === "number" ? (input.value === "" ? null : Number(input.value))
        : input.value;
    renderMeterConfiguratorPreview();
  });
  label.append(input.type === "checkbox" ? input : caption);
  if (input.type === "checkbox") label.append(caption);
  else if (options.color) {
    input.setAttribute("list", "project-color-options");
    const row = document.createElement("div");
    row.className = "color-input-row";
    const picker = document.createElement("input");
    picker.type = "color";
    picker.setAttribute("aria-label", `${labelText} auswählen`);
    const syncPicker = () => {
      const resolved = resolveViewerColor(state.project, input.value);
      picker.value = resolved && /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : "#000000";
    };
    picker.addEventListener("input", () => {
      input.value = picker.value.slice(1).toUpperCase();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    input.addEventListener("input", syncPicker);
    syncPicker();
    row.append(input, picker);
    label.append(row);
  } else label.append(input);
  parent.append(label);
  return input;
}

function meterPreviewIndicators(/** @type {any[]} */ scales = meterConfiguratorScales) {
  /** @type {any[]} */
  const entries = [];
  scales.forEach((/** @type {any} */ scale, /** @type {number} */ scaleIndex) => (scale.indicators || []).forEach((/** @type {any} */ entry, /** @type {number} */ indicatorIndex) => {
    if (!entry || typeof entry !== "object") return;
    const [kind, config] = Object.entries(entry)[0] || [];
    if (!["line", "arc", "image"].includes(kind) || !config || typeof config !== "object") return;
    entries.push({
      kind, config, scale, scaleIndex, indicatorIndex,
      id: String(config.id || `${kind}_${scaleIndex}_${indicatorIndex}`),
      key: `${scaleIndex}:${indicatorIndex}`,
    });
  }));
  return entries;
}

function syncMeterPreviewControls() {
  const entries = meterPreviewIndicators();
  const select = $("#meter-preview-indicator");
  const previous = meterPreviewIndicatorId;
  select.replaceChildren();
  entries.forEach((entry) => select.append(new Option(`${entry.config.id || entry.kind} · ${entry.kind}`, entry.key)));
  meterPreviewIndicatorId = entries.some((entry) => entry.key === previous) ? previous : entries[0]?.key || "";
  select.value = meterPreviewIndicatorId;
  const selected = entries.find((entry) => entry.key === meterPreviewIndicatorId);
  const slider = $("#meter-preview-value");
  slider.disabled = !selected;
  select.disabled = !entries.length;
  if (!selected) {
    $("#meter-preview-value-label").value = "—";
    return;
  }
  const minimum = Number(selected.scale.range_from ?? 0);
  const maximum = Number(selected.scale.range_to ?? 100);
  slider.min = String(Math.min(minimum, maximum));
  slider.max = String(Math.max(minimum, maximum));
  slider.step = "1";
  let testValue = meterPreviewTestValues.get(selected.key);
  if (testValue === undefined || !Number.isFinite(testValue)) {
    testValue = Number(
      selected.kind === "arc" ? selected.config.end_value : selected.config.value,
    ) || minimum;
  }
  testValue = clamp(testValue, Math.min(minimum, maximum), Math.max(minimum, maximum));
  meterPreviewTestValues.set(selected.key, testValue);
  slider.value = String(testValue);
  $("#meter-preview-value-label").value = String(testValue);
}

function renderMeterConfiguratorPreview(/** @type {boolean} */ syncControls = true) {
  if (syncControls) syncMeterPreviewControls();
  const preview = $("#meter-preview");
  preview.replaceChildren();
  if (!meterConfiguratorWidget) return;
  const previewScales = JSON.parse(JSON.stringify(meterConfiguratorScales));
  meterPreviewIndicators(previewScales).forEach((entry) => {
    const testValue = meterPreviewTestValues.get(entry.key);
    if (testValue === undefined) return;
    if (entry.kind === "arc") entry.config.end_value = testValue;
    else entry.config.value = testValue;
  });
  const widget = {
    ...meterConfiguratorWidget,
    width: 320,
    height: 320,
    properties: { ...(meterConfiguratorWidget.properties || {}), scales: previewScales },
  };
  preview.append(renderViewerMeter(state.project, widget, []));
}

function renderMeterScaleEditor(/** @type {any} */ scale) {
  const root = $("#meter-scale-editor");
  root.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "meter-indicator-heading";
  const title = document.createElement("strong");
  title.textContent = t("dialog.meter.scale", { number: meterConfiguratorScaleIndex + 1 });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button danger compact";
  remove.textContent = t("dialog.meter.removeScale");
  remove.disabled = meterConfiguratorScales.length === 1;
  remove.addEventListener("click", () => {
    meterConfiguratorScales.splice(meterConfiguratorScaleIndex, 1);
    meterConfiguratorScaleIndex = Math.max(0, meterConfiguratorScaleIndex - 1);
    renderMeterConfigurator();
  });
  heading.append(title, remove);
  root.append(heading);
  const grid = document.createElement("div");
  grid.className = "meter-form-grid";
  meterField(grid, "Minimum", scale, "range_from");
  meterField(grid, "Maximum", scale, "range_to");
  meterField(grid, "Winkelbereich (°)", scale, "angle_range");
  meterField(grid, "Startdrehung (°)", scale, "rotation");
  meterField(grid, "Ticks über Indikatoren", scale, "draw_ticks_on_top", { type: "checkbox", wide: true });
  const ticks = scale.ticks ||= {};
  meterField(grid, "Tick-Anzahl", ticks, "count");
  meterField(grid, "Tick-Breite", ticks, "width");
  meterField(grid, "Tick-Länge", ticks, "length", { type: "text" });
  meterField(grid, "Tick-Farbe", ticks, "color", { type: "text", color: true });
  const major = ticks.major ||= {};
  meterField(grid, "Major-Abstand", major, "stride");
  meterField(grid, "Major-Breite", major, "width");
  meterField(grid, "Major-Länge", major, "length", { type: "text" });
  meterField(grid, "Major-Farbe", major, "color", { type: "text", color: true });
  meterField(grid, "Beschriftungsabstand", major, "label_gap");
  root.append(grid);
}

function indicatorFields(/** @type {HTMLElement} */ parent, /** @type {string} */ kind, /** @type {any} */ config) {
  if (kind !== "tick_style") meterField(parent, "ID", config, "id", { type: "text", wide: true });
  if (kind === "line") {
    meterField(parent, "Wert", config, "value");
    meterField(parent, "Breite", config, "width");
    meterField(parent, "Länge", config, "length", { type: "text" });
    meterField(parent, "Radialer Versatz", config, "radial_offset", { type: "text" });
    meterField(parent, "Farbe", config, "color", { type: "text", color: true });
    meterField(parent, "Gerundet", config, "rounded", { type: "checkbox" });
  } else if (kind === "arc") {
    meterField(parent, "Startwert", config, "start_value");
    meterField(parent, "Endwert", config, "end_value");
    meterField(parent, "Breite", config, "width");
    meterField(parent, "Abstand zur Skala", config, "padding");
    meterField(parent, "Farbe", config, "color", { type: "text", color: true });
    meterField(parent, "Gerundet", config, "rounded", { type: "checkbox" });
  } else if (kind === "image") {
    const label = document.createElement("label");
    label.textContent = "Bildquelle";
    const select = document.createElement("select");
    select.append(new Option("—", ""));
    imageLibrary().forEach((/** @type {any} */ entry) => select.append(new Option(entry.id, entry.id)));
    if (config.src && !imageEntry(config.src)) select.append(new Option(`${config.src} (fehlt)`, config.src));
    select.value = config.src || "";
    select.addEventListener("change", () => { config.src = select.value; renderMeterConfiguratorPreview(); });
    label.append(select);
    parent.append(label);
    meterField(parent, "Wert", config, "value");
    meterField(parent, "Drehpunkt X", config, "pivot_x");
    meterField(parent, "Drehpunkt Y", config, "pivot_y");
    meterField(parent, "Deckkraft", config, "opa", { type: "text" });
  } else {
    meterField(parent, "Startwert", config, "start_value");
    meterField(parent, "Endwert", config, "end_value");
    meterField(parent, "Breite", config, "width");
    meterField(parent, "Startfarbe", config, "color_start", { type: "text", color: true });
    meterField(parent, "Endfarbe", config, "color_end", { type: "text", color: true });
    meterField(parent, "Lokaler Verlauf", config, "local", { type: "checkbox" });
  }
}

function renderMeterIndicators(/** @type {any} */ scale) {
  const list = $("#meter-indicator-list");
  list.replaceChildren();
  (scale.indicators ||= []).forEach((/** @type {any} */ entry, /** @type {number} */ index) => {
    const [kind, config] = Object.entries(entry)[0] || ["line", {}];
    const card = document.createElement("div");
    card.className = "meter-indicator-card";
    const header = document.createElement("div");
    header.className = "meter-indicator-card-header";
    const type = document.createElement("select");
    [["line", "Zeiger (Linie)"], ["arc", "Bogen"], ["image", "Bildzeiger"], ["tick_style", "Tick-Farbbereich"]]
      .forEach(([value, label]) => type.append(new Option(label, value)));
    type.value = kind;
    type.addEventListener("change", () => {
      const replacement = defaultMeterIndicator(type.value);
      const replacementConfig = Object.values(replacement)[0];
      if (config?.id && replacementConfig && typeof replacementConfig === "object") replacementConfig.id = config.id;
      scale.indicators[index] = replacement;
      renderMeterConfigurator();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button danger compact";
    remove.textContent = "×";
    remove.title = t("dialog.meter.removeIndicator");
    remove.addEventListener("click", () => { scale.indicators.splice(index, 1); renderMeterConfigurator(); });
    header.append(type, remove);
    const fields = document.createElement("div");
    fields.className = "meter-indicator-fields";
    indicatorFields(fields, kind, config);
    card.append(header, fields);
    list.append(card);
  });
}

function renderMeterConfigurator() {
  const list = $("#meter-scale-list");
  list.replaceChildren();
  meterConfiguratorScales.forEach((_, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button subtle meter-scale-button${index === meterConfiguratorScaleIndex ? " active" : ""}`;
    button.textContent = t("dialog.meter.scale", { number: index + 1 });
    button.addEventListener("click", () => { meterConfiguratorScaleIndex = index; renderMeterConfigurator(); });
    list.append(button);
  });
  const scale = meterConfiguratorScales[meterConfiguratorScaleIndex];
  renderMeterScaleEditor(scale);
  renderMeterIndicators(scale);
  renderMeterConfiguratorPreview();
}

function addMeterScale() {
  meterConfiguratorScales.push(defaultMeterScale());
  meterConfiguratorScaleIndex = meterConfiguratorScales.length - 1;
  renderMeterConfigurator();
}

function addMeterIndicator() {
  const scale = meterConfiguratorScales[meterConfiguratorScaleIndex];
  scale.indicators ||= [];
  scale.indicators.push(defaultMeterIndicator());
  renderMeterConfigurator();
}

function applyMeterConfigurator() {
  if (!meterConfiguratorWidget) return;
  pushUndo();
  meterConfiguratorWidget.properties ||= {};
  meterConfiguratorWidget.properties.scales = JSON.parse(JSON.stringify(meterConfiguratorScales));
  markProjectDirty();
  $("#meter-dialog").close();
  renderDesigner();
}

function appendPropertyControl(/** @type {any} */ label, /** @type {any} */ control, /** @type {any} */ property, /** @type {any} */ widget = state.selectedWidget) {
  if (property.kind === "json" && widget?.widget_type === "meter" && property.key === "scales") {
    const column = document.createElement("div");
    column.className = "meter-json-control";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button subtle compact";
    button.textContent = t("dynprops.openMeterConfigurator");
    button.addEventListener("click", () => openMeterConfigurator(widget));
    column.append(button, control);
    label.append(column);
    return;
  }
  if (property.kind === "text") {
    const row = document.createElement("div");
    row.className = "text-with-icon-row";
    row.append(control);
    const iconButton = document.createElement("button");
    iconButton.type = "button";
    iconButton.className = "button subtle compact";
    iconButton.title = t("mdi.insertTooltip");
    iconButton.textContent = t("mdi.insertButton");
    iconButton.addEventListener("click", () => openIconInsertDialog(widget, control));
    row.append(iconButton);
    label.append(row);
    return;
  }
  if (property.kind === "image_ref") {
    const row = document.createElement("div");
    row.className = "image-ref-row";
    row.append(control);
    const format = document.createElement("select");
    format.className = "image-ref-format";
    format.title = t("properties.imageFormatTitle");
    IMAGE_TYPE_OPTIONS.forEach(([value, text]) => format.append(new Option(text, value)));
    const syncFormat = () => {
      const entry = imageEntry(control.value);
      format.disabled = !entry;
      format.value = entry ? (entry.img_type || "") : "";
    };
    syncFormat();
    control.addEventListener("change", syncFormat);
    format.addEventListener("change", () => {
      const entry = imageEntry(control.value);
      if (!entry) return;
      pushUndo();
      entry.img_type = format.value;
      markProjectDirty();
    });
    row.append(format);
    const transparency = document.createElement("select");
    transparency.className = "image-ref-transparency";
    transparency.title = t("properties.imageTransparencyTitle");
    IMAGE_TRANSPARENCY_OPTIONS.forEach(([value, text]) => transparency.append(new Option(text, value)));
    const syncTransparency = () => {
      const entry = imageEntry(control.value);
      transparency.disabled = !entry;
      transparency.value = entry ? (entry.transparency || "opaque") : "opaque";
    };
    syncTransparency();
    control.addEventListener("change", syncTransparency);
    transparency.addEventListener("change", () => {
      const entry = imageEntry(control.value);
      if (!entry) return;
      pushUndo();
      entry.transparency = transparency.value;
      markProjectDirty();
    });
    row.append(transparency);
    label.append(row);
    return;
  }
  if (property.kind === "font_ref") {
    // A datalist rather than a strict picker: ESPHome also accepts a
    // builtin font name (montserrat_16) typed directly, not only a
    // font: library id - same trade-off the color datalist already makes.
    control.setAttribute("list", "project-font-options");
    label.append(control);
    return;
  }
  if (property.kind !== "color") {
    label.append(control);
    return;
  }
  control.setAttribute("list", "project-color-options");
  const row = document.createElement("div");
  row.className = "color-input-row";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.className = "linked-color-picker";
  picker.setAttribute("aria-label", t("properties.colorPickerLabel", { label: property.label }));
  const resolved = resolveViewerColor(state.project, control.value);
  picker.value = resolved && /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : "#000000";
  picker.addEventListener("input", () => {
    control.value = picker.value.slice(1).toUpperCase();
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
  control.addEventListener("input", syncLinkedColorPickers);
  row.append(control, picker);
  label.append(row);
}

function propertyTarget(/** @type {any} */ widget, /** @type {any} */ property, /** @type {any} */ create, kind = property.category) {
  return resolvePropertyTarget(widget, property, create, kind, state.activeState);
}

function renderStateChoices() {
  const select = $("#style-state");
  select.replaceChildren(new Option("Normal", ""));
  /** @type {Record<string, string>} */
  const labels = {
    checked: t("properties.state.checked"),
    pressed: t("properties.state.pressed"),
    disabled: t("properties.state.disabled"),
    focused: t("properties.state.focused"),
    edited: t("properties.state.edited"),
    scrolled: t("properties.state.scrolled"),
  };
  state.states.forEach((/** @type {any} */ name) => select.append(new Option(labels[name] || name, name)));
  select.value = state.activeState;

  const hint = $("#style-state-hint");
  const widget = state.selectedWidget;
  if (!hint) return;
  if (widget?.widget_type !== "button") {
    hint.textContent = t("properties.stateHint.default");
  } else if (state.activeState === "pressed") {
    hint.textContent = t("properties.stateHint.pressed");
  } else if (state.activeState === "checked") {
    hint.textContent = widget.properties?.checkable
      ? t("properties.stateHint.checkedEnabled")
      : t("properties.stateHint.checkedDisabled");
  } else {
    hint.textContent = t("properties.stateHint.normal");
  }
}

function changeActiveState() {
  state.activeState = $("#style-state").value;
  renderCanvas();
  renderProperties();
}

// --- Theme editor -------------------------------------------------------
//
// `lvgl.theme:` sets a default style per widget TYPE (optionally per state),
// applied to every widget of that type that doesn't override it - unlike
// everything else in the properties panel, it isn't about the selected
// widget at all, so it gets its own small, independent editor rather than
// being squeezed into the per-widget style form.

function themeLibrary() {
  if (!state.project.theme || typeof state.project.theme !== "object") state.project.theme = {};
  return state.project.theme;
}

function bindThemeEditor() {
  $("#theme-type").addEventListener("change", () => {
    state.themeType = $("#theme-type").value;
    renderThemeEditor();
  });
  $("#theme-state").addEventListener("change", () => {
    state.themeState = $("#theme-state").value;
    renderThemeEditor();
  });
  $("#delete-theme-entry").addEventListener("click", () => {
    const type = state.themeType;
    if (!type || !themeLibrary()[type]) return;
    pushUndo();
    delete themeLibrary()[type];
    markProjectDirty();
    renderThemeEditor();
  });
}

function renderThemeEditor() {
  // A stub type like "tile" has no style properties of its own (see
  // widgetschema.py) - a theme entry for it would have nothing to edit.
  const themeableSchemas = state.schemas.filter((/** @type {any} */ schema) => !schema.is_stub);
  const typeSelect = $("#theme-type");
  typeSelect.replaceChildren();
  themeableSchemas.forEach((/** @type {any} */ schema) => typeSelect.append(new Option(schema.label, schema.type_key)));
  if (!state.themeType && themeableSchemas.length) state.themeType = themeableSchemas[0].type_key;
  typeSelect.value = state.themeType;

  const stateSelect = $("#theme-state");
  stateSelect.replaceChildren(new Option("Normal", ""));
  state.states.forEach((/** @type {any} */ name) => stateSelect.append(new Option(name, name)));
  stateSelect.value = state.themeState;

  const schema = state.schemas.find((/** @type {any} */ item) => item.type_key === state.themeType);
  const entry = themeLibrary()[state.themeType];
  $("#delete-theme-entry").disabled = !entry;
  $("#theme-empty").classList.toggle("hidden", Boolean(entry));

  const container = $("#theme-properties");
  container.replaceChildren();
  if (!schema) return;
  const properties = schema.properties.filter((/** @type {any} */ property) => property.category === "style");
  /** @type {any} */
  let previousPart = null;
  properties.forEach((/** @type {any} */ property, /** @type {any} */ index) => {
    if (property.part !== previousPart) {
      const heading = document.createElement("div");
      heading.className = "property-section";
      heading.textContent = property.part === "main" ? "Stil" : property.part;
      container.append(heading);
      previousPart = property.part;
    }
    const label = document.createElement("label");
    label.textContent = property.label;
    const target = themePropertyTarget(state.themeType, property, false);
    const value = target?.[property.key];
    const control = propertyControl(property, value, `theme-${index}`);
    control.addEventListener("focus", pushUndo);
    control.addEventListener("change", () => updateThemeProperty(property, control));
    control.addEventListener("input", () => updateThemeProperty(property, control));
    if (property.kind === "bool") label.className = "checkbox-field";
    appendPropertyControl(label, control, property);
    container.append(label);
  });
}

// Mirrors propertyTarget()'s state-routing (root.states[<state>]), but keyed
// by widget TYPE against project.theme instead of by widget instance against
// widget.style_tree.
function themePropertyTarget(/** @type {any} */ typeKey, /** @type {any} */ property, /** @type {any} */ create) {
  if (!typeKey) return undefined;
  const lib = themeLibrary();
  if (!lib[typeKey] && create) lib[typeKey] = {};
  let root = lib[typeKey];
  if (!root) return undefined;
  if (state.themeState) {
    if (!root[STATES_KEY] && create) root[STATES_KEY] = {};
    if (!root[STATES_KEY]?.[state.themeState] && create) root[STATES_KEY][state.themeState] = {};
    root = root[STATES_KEY]?.[state.themeState];
  }
  if (!root) return undefined;
  if (property.part === "main") return root;
  if (!root[property.part] && create) root[property.part] = {};
  return root[property.part];
}

async function updateThemeProperty(/** @type {any} */ property, /** @type {any} */ control) {
  const target = themePropertyTarget(state.themeType, property, true);
  if (property.kind === "image_ref" && control.value === ADD_IMAGE_OPTION) {
    pushUndo();
    const id = await addImageSource();
    control.value = id || target[property.key] || "";
    if (!id) return;
    target[property.key] = id;
    markProjectDirty();
    renderDesigner();
    return;
  }

  let value;
  if (property.kind === "bool") value = control.checked;
  else if (LIST_KINDS.includes(property.kind)) value = parseListValue(property, control.value);
  else if (["int", "float"].includes(property.kind)) value = control.value === "" ? null : Number(control.value);
  else value = control.value;

  const clears = value === "" || value === null
    || (Array.isArray(value) && value.length === 0);
  if (clears) delete target[property.key];
  else target[property.key] = value;

  markProjectDirty();
  renderCanvas();
  renderThemeEditor();
}

function renderGridCellSection(/** @type {any} */ widget) {
  const section = $("#grid-cell-section");
  const parent = findParent(activeWidgetRoots(), widget);
  const entry = activeSurfaceEntry();
  const parentLayout = parent
    ? parent.layout
    : entry.kind === "root" ? (state.project.extra_lvgl || {}).layout : entry.surface.layout;
  const isGridChild = String(parentLayout?.type || "").toUpperCase() === "GRID";
  section.classList.toggle("hidden", !isGridChild);
  if (!isGridChild) return;

  const container = $("#grid-cell-properties");
  container.replaceChildren();
  state.gridCellProperties.forEach((/** @type {any} */ property, /** @type {any} */ index) => {
    container.append(propertyField(widget, property, `gc-${index}`, "grid_cell"));
  });
}

// `tile_row`/`tile_col`/`tile_dir` are dedicated WidgetNode fields, not
// generic PropertyDefs (a tile has no styling of its own in real ESPHome
// YAML - see the widgetschema.py comment on the "tile" pseudo-widget), so
// this section is bound directly rather than through propertyField().
function renderTileSection(/** @type {any} */ widget) {
  const section = $("#tile-section");
  const isTile = widget.widget_type === "tile";
  section.classList.toggle("hidden", !isTile);
  if (!isTile) return;
  $("#tile-row").value = widget.tile_row ?? 0;
  $("#tile-col").value = widget.tile_col ?? 0;
  $("#tile-dir").value = widget.tile_dir || "ALL";
}

function renderTileviewActionsSection(/** @type {any} */ widget) {
  const isTileview = widget.widget_type === "tileview";
  $("#tileview-actions-section").classList.toggle("hidden", !isTileview);
}

function addTileToSelectedTileview() {
  const tileview = state.selectedWidget;
  if (!tileview || tileview.widget_type !== "tileview") return;
  pushUndo();
  const usedCols = (tileview.children || [])
    .filter((/** @type {any} */ tile) => (tile.tile_row || 0) === 0)
    .map((/** @type {any} */ tile) => tile.tile_col || 0);
  let col = 0;
  while (usedCols.includes(col)) col += 1;
  const tile = {
    id: uniqueProjectWidgetId("tile"), widget_type: "tile",
    x: 0, y: 0, width: null, height: null, align: "TOP_LEFT", align_to: "",
    hidden: false, locked: false, properties: {}, style_mode: "inline",
    style_refs: [], style_tree: {}, events: {}, children: [],
    tab_title: "", tile_row: 0, tile_col: col, tile_dir: "ALL",
    layout: {}, grid_cell: {}, extra: {}, source: "editor", synthetic_id: false,
  };
  tileview.children ||= [];
  tileview.children.push(tile);
  state.selectedWidget = tile;
  markProjectDirty();
  renderDesigner();
}

// `tab_title` is a dedicated WidgetNode field, not a generic PropertyDef -
// same reasoning as renderTileSection() above, applied to the "tab"
// pseudo-widget.
function renderTabSection(/** @type {any} */ widget) {
  const section = $("#tab-section");
  const isTab = widget.widget_type === "tab";
  section.classList.toggle("hidden", !isTab);
  if (!isTab) return;
  $("#tab-title").value = widget.tab_title || "";
}

function renderTabviewActionsSection(/** @type {any} */ widget) {
  const isTabview = widget.widget_type === "tabview";
  $("#tabview-actions-section").classList.toggle("hidden", !isTabview);
}

function addTabToSelectedTabview() {
  const tabview = state.selectedWidget;
  if (!tabview || tabview.widget_type !== "tabview") return;
  pushUndo();
  const index = (tabview.children || []).length + 1;
  const tab = {
    id: uniqueProjectWidgetId("tab"), widget_type: "tab",
    x: 0, y: 0, width: null, height: null, align: "TOP_LEFT", align_to: "",
    hidden: false, locked: false, properties: {}, style_mode: "inline",
    style_refs: [], style_tree: {}, events: {}, children: [],
    tab_title: `${t("tabview.defaultTabTitle")} ${index}`, tile_row: 0, tile_col: 0, tile_dir: "ALL",
    layout: {}, grid_cell: {}, extra: {}, source: "editor", synthetic_id: false,
  };
  tabview.children ||= [];
  tabview.children.push(tab);
  state.selectedWidget = tab;
  markProjectDirty();
  renderDesigner();
}

/** @returns {any} */
function findParent(/** @type {any} */ nodes, /** @type {any} */ target, /** @type {any} */ parent = null) {
  for (const node of nodes) {
    if (node === target) return parent;
    /** @type {any} */
    const found = findParent(node.children || [], target, node);
    if (found !== undefined) return found;
  }
  return undefined;
}

function renderExtraKeys(/** @type {any} */ widget) {
  const section = $("#extra-keys-section");
  const keys = Object.keys(widget.extra || {});
  section.classList.toggle("hidden", keys.length === 0);
  if (!keys.length) return;
  $("#extra-keys").textContent = JSON.stringify(widget.extra, null, 2);
}

const ADD_IMAGE_OPTION = "__add_image__";

function imageLibrary() {
  if (!Array.isArray(state.project.images)) state.project.images = [];
  return state.project.images;
}

function imageEntry(/** @type {any} */ id) {
  return id ? imageLibrary().find((/** @type {any} */ entry) => entry.id === id) : undefined;
}

function fontLibrary() {
  if (!Array.isArray(state.project.fonts)) state.project.fonts = [];
  return state.project.fonts;
}

// Whether `candidate` (the not-yet-saved shape saveFontLibraryEntry() is
// about to write) already exists under a different id - same source,
// same size/bpp (a different size is a genuinely different font: block,
// not a duplicate, matching ensureMdiFontAtSize()'s own per-size entries),
// and the fields identifying that source. Two font: entries that would
// bake the identical source at the identical size is pure YAML/flash
// bloat, never something a user actually wants.
function findEquivalentFontEntry(/** @type {any} */ candidate) {
  return fontLibrary().find((/** @type {any} */ entry) => {
    if (entry.source_kind !== candidate.source_kind) return false;
    if (Number(entry.size) !== candidate.size || Number(entry.bpp) !== candidate.bpp) return false;
    if (candidate.source_kind === "builtin") return entry.builtin_name === candidate.builtin_name;
    if (candidate.source_kind === "gfonts") {
      return entry.gfonts_family === candidate.gfonts_family
        && Number(entry.gfonts_weight) === candidate.gfonts_weight
        && Boolean(entry.gfonts_italic) === candidate.gfonts_italic;
    }
    if (candidate.source_kind === "file") return entry.file_path === candidate.file_path;
    if (candidate.source_kind === "web") return webFontUrl(entry) === candidate.web_url;
    return false;
  });
}

// ESPHome bitmap fonts are baked at one fixed pixel size per font: entry
// (LVGL v9 has no runtime scaling for them), so - like resolvedFontFamily()
// - "the font's size" lives on the library entry, not per widget instance.
// Same fallback as viewer.js's viewerFont(): a name like "montserrat_16"
// that was never actually registered in the library still yields a
// plausible size instead of falling back to the browser default.
function fontEntrySize(/** @type {any} */ reference) {
  if (!reference) return null;
  const entry = fontLibrary().find((/** @type {any} */ font) => font.id === reference);
  const inferredSize = Number.parseInt(String(reference).match(/(\d+)(?!.*\d)/)?.[1] || "", 10);
  return Number(entry?.size) || inferredSize || null;
}

// One attempt per font id per page load - "failed" is sticky (no retry loop
// against a permanently-missing file), but a fresh project/import naturally
// gets fresh ids to try again with.
const fontLoadState = new Map();

// Kicks off loading the real font file behind a project font entry (http(s)
// as-is, a local path from an imported config via assetUrl()) so the canvas
// can show its actual glyphs instead of only ever approximating with the
// browser's generic sans-serif. Loading is async; once it resolves this
// re-renders so layout/measurement (layout.js's resolvedFontFamily) and the
// visible label text both pick up the real family.
function ensureFontLoaded(/** @type {any} */ fontId) {
  if (!fontId || fontLoadState.has(fontId)) return;
  const entry = fontLibrary().find((/** @type {any} */ font) => font.id === fontId);
  // A `font: file: {type: web, url: ...}` entry keeps its URL in web_url,
  // not file_path (which stays empty for that source kind) - web_url is
  // already a full http(s) URL, so it needs no assetUrl() resolution.
  const source = entry?.file_path || entry?.web_url;
  if (!source) return;
  fontLoadState.set(fontId, "loading");
  const face = new FontFace(fontFamilyId(fontId), `url(${JSON.stringify(assetUrl(source))})`);
  face.load().then((loaded) => {
    document.fonts.add(loaded);
    fontLoadState.set(fontId, "loaded");
    renderDesigner();
  }).catch(() => {
    fontLoadState.set(fontId, "failed");
  });
}

function isRemoteAsset(/** @type {any} */ path) {
  return /^https?:\/\//i.test(String(path || ""));
}

// A local path (e.g. from an imported config's own `images:`/`font:` entry)
// isn't something the browser can fetch directly - it lives on the HA host,
// not the web. Route it through the read-only asset endpoint instead, which
// confines itself to the same config directory those entries came from in
// the first place. Deliberately not used by addImageSource(): a user typing
// an arbitrary path into that prompt is a different trust situation than a
// path that already existed in an imported project.
function assetUrl(/** @type {any} */ filePath) {
  if (isRemoteAsset(filePath)) return filePath;
  const appBase = window.location.pathname.endsWith("/")
    ? window.location.pathname
    : `${window.location.pathname}/`;
  return `${appBase}api/v1/designer/assets/read/${encodedName(filePath)}`;
}

// The canvas can show any source the browser can fetch: an http(s) URL
// as-is, or a local path (from an imported config) through assetUrl().
function displayableImageSource(/** @type {any} */ id) {
  const entry = imageEntry(id);
  return entry && entry.file_path ? assetUrl(entry.file_path) : null;
}

// Cached for the session once fetched - the images/ folder only grows while
// the app is open (uploads/pins go through this same app), so a stale list
// only ever misses a file someone else added on the host in the meantime,
// same trade-off the font library's "check for update" already accepts.
/** @type {any} */
let serverImageAssetsCache = null;

async function availableServerImages() {
  if (!state.capabilities["designer.asset_read"]) return [];
  if (serverImageAssetsCache === null) {
    try {
      const result = await api("designer/assets/images");
      serverImageAssetsCache = result.images || [];
    } catch {
      // Leave the cache empty (not []) so a transient failure - the request
      // simply didn't reach the backend this once - gets retried next time
      // instead of being remembered forever as "no images exist".
      return [];
    }
  }
  const used = new Set(imageLibrary().map((/** @type {any} */ entry) => entry.file_path));
  return serverImageAssetsCache.filter((/** @type {any} */ path) => !used.has(path));
}

// Registers an image already sitting in the host's images/ folder (as
// reported by the server itself, not typed by the user - see addImageSource()
// below for why that distinction matters) as a project image, the same way
// a baked animation frame is registered after upload. Reuses an existing
// entry for the same path rather than ever creating a second one - two
// image: entries pointing at the identical file is pure YAML/flash bloat,
// never something a user actually wants.
function registerServerImageAsset(/** @type {any} */ path) {
  const existing = imageLibrary().find((/** @type {any} */ entry) => entry.file_path === path);
  if (existing) return existing.id;
  const base = (path.split("/").pop() || "bild").replace(/\.[^.]*$/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "bild";
  let id = `img_${slug}`;
  let counter = 2;
  while (imageEntry(id)) id = `img_${slug}_${counter++}`;
  // external:true - this path is already exactly where it needs to be
  // (images/<name>.png under the config root), so export must reference it
  // as-is rather than trying to copy it from this process's own working
  // directory, which is a different, unrelated location.
  imageLibrary().push({
    id, file_path: path, resize: "", dither: "", transparency: "opaque", img_type: "", external: true,
  });
  return id;
}

async function addImageSource() {
  const existing = await availableServerImages();
  let url;
  if (existing.length) {
    const list = existing.map((/** @type {any} */ path, /** @type {any} */ index) => `${index + 1}: ${path}`).join("\n");
    const answer = (prompt(t("prompt.image.urlOrExisting", { list }), "https://") || "").trim();
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= existing.length) {
      return registerServerImageAsset(existing[index - 1]);
    }
    url = answer;
  } else {
    url = (prompt(t("prompt.image.url"), "https://") || "").trim();
  }
  if (!url || url === "https://") return null;
  if (!isRemoteAsset(url)) {
    toast(t("toast.image.onlyHttpUrls"), true);
    return null;
  }
  // Typing a URL that already backs another entry must not create a
  // second, functionally-identical image: block - reuse the existing one.
  const existingEntry = imageLibrary().find((/** @type {any} */ entry) => entry.file_path === url);
  if (existingEntry) return existingEntry.id;
  const base = (url.split("/").pop() || "bild").replace(/\.[^.]*$/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "bild";
  let id = `img_${slug}`;
  let counter = 2;
  while (imageEntry(id)) id = `img_${slug}_${counter++}`;
  imageLibrary().push({ id, file_path: url, resize: "", dither: "", transparency: "opaque", img_type: "" });
  return id;
}

// Sizing a widget to the asset it was just given is what most design tools
// do on drop; the desktop app does the same via ImageRefEditor.imagePicked.
function resizeWidgetToImage(/** @type {any} */ widget, /** @type {any} */ id) {
  const source = displayableImageSource(id);
  if (!source) return;
  const probe = new Image();
  probe.onload = () => {
    if (!probe.naturalWidth || !probe.naturalHeight) return;
    widget.width = clamp(probe.naturalWidth, 8, 4096);
    widget.height = clamp(probe.naturalHeight, 8, 4096);
    markProjectDirty();
    renderCanvas();
    if (state.selectedWidget === widget) {
      $("#prop-width").value = widget.width;
      $("#prop-height").value = widget.height;
    }
  };
  probe.src = source;
}

function propertyControl(/** @type {any} */ property, /** @type {any} */ value, /** @type {any} */ index) {
  /** @type {any} */
  let control;
  if (property.kind === "image_ref") {
    control = document.createElement("select");
    control.append(new Option("—", ""));
    imageLibrary().forEach((/** @type {any} */ entry) => control.append(new Option(entry.id, entry.id)));
    if (value && !imageEntry(value)) control.append(new Option(`${value} (fehlt)`, value));
    control.value = value ?? "";
    control.append(new Option("＋ Neue Bildquelle …", ADD_IMAGE_OPTION));
  } else if (property.kind === "widget_ref") {
    control = document.createElement("select");
    control.append(new Option("—", ""));
    const candidates = projectWidgetEntries().filter((item) =>
      property.key !== "textarea" || item.widget_type === "textarea");
    candidates.forEach((item) => control.append(new Option(`${item.id} · ${item.widget_type}`, item.id)));
    if (value && !candidates.some((item) => item.id === value)) {
      control.append(new Option(t("dynprops.widgetRefMissing", { id: value }), value));
    }
    control.value = value ?? "";
  } else {
    control = createBasicPropertyControl(document, property, value);
    if (property.kind === "text_list") control.placeholder = t("dynprops.optionsPlaceholder");
  }
  control.id = `dynamic-${index}-${property.part}-${property.key}`;
  return control;
}

async function updateDynamicProperty(/** @type {any} */ widget, /** @type {any} */ property, /** @type {any} */ control, targetKind = property.category) {
  const target = propertyTarget(widget, property, true, targetKind);
  if (property.kind === "image_ref" && control.value === ADD_IMAGE_OPTION) {
    pushUndo();
    const id = await addImageSource();
    // Cancelling the prompt must not leave the sentinel option selected.
    control.value = id || target[property.key] || "";
    if (!id) return;
    target[property.key] = id;
    markProjectDirty();
    resizeWidgetToImage(widget, id);
    renderDesigner();
    return;
  }

  let value;
  try {
    value = propertyInputValue(property, control);
    if (property.kind === "json" && !Array.isArray(value)) {
      throw new Error(t("dynprops.jsonArrayRequired"));
    }
    control.setCustomValidity("");
  } catch (error) {
    control.setCustomValidity(error instanceof Error ? error.message : String(error));
    return;
  }

  // An empty field means "unset", not "set to empty" - carrying blanks into
  // layout or grid placement would emit keys the source never had.
  const clears = propertyValueClears(value);
  if (clears && (targetKind !== "content" || property.kind === "enum")) {
    delete target[property.key];
  } else {
    target[property.key] = value;
  }

  if (targetKind === "layout" && String(target.type || "NONE").toUpperCase() === "NONE") {
    // A layout mapping with no type is not a layout; leaving the leftovers
    // would emit `layout: {flex_flow: ROW}` on a widget that has none.
    Object.keys(target).forEach((key) => delete target[key]);
  }

  markProjectDirty();
  // Layout and placement change where everything else sits, so the whole
  // canvas has to be recomputed rather than just this widget repainted.
  renderCanvas();
  if (targetKind === "layout" || targetKind === "grid_cell") renderProperties();
}

function updateSelectedWidget(/** @type {any} */ event) {
  const widget = state.selectedWidget;
  if (!widget) return;
  const key = event.target.id.replace("prop-", "");
  if (key === "id") {
    const previousId = widget.id;
    const nextId = event.target.value;
    if (previousId !== nextId) replaceProjectWidgetReferences(previousId, nextId);
    widget.id = nextId;
  } else if (["width", "height"].includes(key)) {
    widget[key] = Math.max(1, Number(event.target.value));
  } else if (key === "x" || key === "y") {
    // Typing a new x/y is the same move as dragging the widget - nested glow
    // lines need the same delta applied to their (always-absolute) points.
    const delta = (Number(event.target.value) || 0) - (Number(widget[key]) || 0);
    widget[key] = Number(event.target.value) || 0;
    if (delta) {
      (state.project.glow_strokes || [])
        .filter((/** @type {any} */ stroke) => stroke.parent_id === widget.id)
        .forEach((/** @type {any} */ stroke) => {
          stroke.points = stroke.points.map((/** @type {any} */ [px, py]) => (
            key === "x" ? [px + delta, py] : [px, py + delta]
          ));
        });
    }
  } else {
    widget[key] = Number(event.target.value);
  }
  markProjectDirty();
  renderCanvas();
  renderTree();
  if (key === "id") {
    renderRuntimeBindingOrphans();
    renderRuntimeBinding(widget);
    renderWidgetActions(widget);
  }
}

function replaceProjectWidgetReferences(/** @type {any} */ previousId, /** @type {any} */ nextId) {
  replaceWidgetReferences(state.project, state.viewerBindings, previousId, nextId);
}

function deleteSelectedWidget() {
  if (!state.selectedWidget) return;
  pushUndo();
  // Glow lines aren't part of the widget tree, so removing a container would
  // otherwise leave its child lines pointing at a parent_id that no longer
  // exists anywhere - orphan them back to top-level instead.
  const removedIds = new Set(allWidgets([state.selectedWidget]).map((/** @type {any} */ widget) => widget.id));
  (state.project.glow_strokes || []).forEach((/** @type {any} */ stroke) => {
    if (removedIds.has(stroke.parent_id)) stroke.parent_id = "";
  });
  removeWidget(activeWidgetRoots(), state.selectedWidget);
  state.selectedWidget = null;
  markProjectDirty();
  renderDesigner();
}

function widgetAllowsChildren(/** @type {any} */ widget) {
  const schema = state.schemas.find((/** @type {any} */ item) => item.type_key === widget.widget_type);
  return Boolean(schema?.allows_children);
}

function cloneWidgetSubtree(/** @type {any} */ widget) {
  return cloneProjectWidgetSubtree(state.project, widget);
}

function duplicateWidget(/** @type {any} */ widget) {
  pushUndo();
  const location = findWidgetLocation(activeWidgetRoots(), widget);
  if (!location) return;
  const clone = cloneWidgetSubtree(widget);
  location.array.splice(location.index + 1, 0, clone);
  if (state.canvasMode !== "widgets") setCanvasMode("widgets");
  state.selectedWidget = clone;
  markProjectDirty();
  renderDesigner();
}

function duplicateStroke(/** @type {any} */ stroke) {
  pushUndo();
  const list = state.project.glow_strokes || [];
  const index = list.indexOf(stroke);
  if (index < 0) return;
  const clone = JSON.parse(JSON.stringify(stroke));
  clone.id = uniqueStrokeId();
  list.splice(index + 1, 0, clone);
  setCanvasMode("lines");
  setLineTool("select");
  state.selectedStroke = clone;
  markProjectDirty();
  renderDesigner();
}

// --- Hierarchy drag-and-drop -------------------------------------------------
//
// Widgets and glow lines live in different data shapes (a tree of `children`
// arrays vs. one flat array with a `parent_id`), so the tree can't just splice
// one unified list. Drop semantics: "into" a widget that allows children
// nests the dragged item there; "before"/"after" a widget moves the dragged
// item to be that widget's real sibling (same array, adjacent index); "before"
// /"after" a glow line adopts that line's parent context (its container, or
// top-level) since lines don't have a position index of their own relative to
// sibling widgets - the tree always lists a container's child widgets before
// its child lines, so there is no finer position to preserve there anyway.

/** @type {any} */
let treeDrag = null; // { kind: "widget", widget } | { kind: "stroke", stroke }

function clearDropIndicators() {
  $$(".tree-item.drop-before, .tree-item.drop-after, .tree-item.drop-into")
    .forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-into"));
}

function bindTreeItemDrag(/** @type {any} */ item, /** @type {any} */ payload, /** @type {any} */ { allowInto }) {
  item.draggable = true;
  item.addEventListener("dragstart", (/** @type {any} */ event) => {
    event.stopPropagation();
    treeDrag = payload;
    event.dataTransfer.effectAllowed = "move";
  });
  item.addEventListener("dragover", (/** @type {any} */ event) => {
    if (!treeDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = item.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    clearDropIndicators();
    if (allowInto && ratio > 0.25 && ratio < 0.75) item.classList.add("drop-into");
    else if (ratio <= 0.5) item.classList.add("drop-before");
    else item.classList.add("drop-after");
  });
  item.addEventListener("drop", (/** @type {any} */ event) => {
    if (!treeDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const position = item.classList.contains("drop-into") ? "into"
      : item.classList.contains("drop-after") ? "after" : "before";
    clearDropIndicators();
    performTreeDrop(treeDrag, { ...payload, position });
    treeDrag = null;
  });
  item.addEventListener("dragend", (/** @type {any} */ event) => {
    event.stopPropagation();
    clearDropIndicators();
    treeDrag = null;
  });
}

function performTreeDrop(/** @type {any} */ dragged, /** @type {any} */ target) {
  if (!dragged) return;
  if (dragged.kind === "widget" && target.kind === "widget" && dragged.widget === target.widget) return;
  if (dragged.kind === "stroke" && target.kind === "stroke" && dragged.stroke === target.stroke) return;
  pushUndo();

  if (dragged.kind === "widget") {
    const draggedWidget = dragged.widget;
    if (target.kind === "widget" && allWidgets([draggedWidget]).includes(target.widget)) return; // no cycles
    const roots = activeWidgetRoots();
    const from = findWidgetLocation(roots, draggedWidget);
    if (!from) return;
    from.array.splice(from.index, 1);

    if (target.kind === "widget" && target.position === "into" && widgetAllowsChildren(target.widget)) {
      migrateButtonTextToChildLabel(target.widget);
      target.widget.children.push(draggedWidget);
    } else if (target.kind === "widget") {
      const to = findWidgetLocation(roots, target.widget);
      const destArray = to ? to.array : roots;
      const destIndex = to ? (target.position === "before" ? to.index : to.index + 1) : destArray.length;
      destArray.splice(destIndex, 0, draggedWidget);
    } else if (target.kind === "stroke") {
      const containerId = target.stroke.parent_id;
      const container = containerId ? allWidgets().find((/** @type {any} */ w) => w.id === containerId) : null;
      (container ? container.children : roots).push(draggedWidget);
    } else {
      roots.push(draggedWidget);
    }
    if (state.canvasMode !== "widgets") setCanvasMode("widgets");
    state.selectedWidget = draggedWidget;
  } else {
    const draggedStroke = dragged.stroke;
    const list = state.project.glow_strokes || [];
    const fromIndex = list.indexOf(draggedStroke);
    if (fromIndex < 0) return;
    list.splice(fromIndex, 1);

    if (target.kind === "widget" && target.position === "into" && widgetAllowsChildren(target.widget)) {
      draggedStroke.parent_id = target.widget.id;
      list.push(draggedStroke);
    } else if (target.kind === "widget") {
      draggedStroke.parent_id = findParentContainerId(activeWidgetRoots(), target.widget) || "";
      list.push(draggedStroke);
    } else if (target.kind === "stroke") {
      draggedStroke.parent_id = target.stroke.parent_id;
      const targetIndex = list.indexOf(target.stroke);
      const insertAt = target.position === "before" ? targetIndex : targetIndex + 1;
      list.splice(Math.max(0, insertAt), 0, draggedStroke);
    } else {
      draggedStroke.parent_id = "";
      list.push(draggedStroke);
    }
    setCanvasMode("lines");
    setLineTool("select");
    state.selectedStroke = draggedStroke;
  }
  markProjectDirty();
  renderDesigner();
}

// Feather Icons' "eye" / "eye-off" glyphs (MIT-licensed geometry) instead of
// an emoji pair - the crossed-out eye reads as "hidden" at a glance, unlike
// the "see-no-evil monkey" which needs a title tooltip to make sense of.
const ICON_EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.6 18.6 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const ICON_DUPLICATE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function renderTree() {
  const tree = $("#widget-tree");
  tree.replaceChildren();
  const widgets = allWidgets();
  const strokes = activeSurfaceEntry().kind === "root" ? (state.project.glow_strokes || []) : [];
  const hasSurfaces = Boolean(
    state.project.pages?.length || state.project.top_layer || state.project.bottom_layer,
  );
  tree.classList.toggle("empty", widgets.length === 0 && strokes.length === 0 && !hasSurfaces);

  if (!tree.dataset.dropBound) {
    tree.dataset.dropBound = "1";
    tree.addEventListener("dragover", (/** @type {any} */ event) => {
      if (!treeDrag) return;
      event.preventDefault();
    });
    tree.addEventListener("drop", (/** @type {any} */ event) => {
      if (!treeDrag) return;
      event.preventDefault();
      clearDropIndicators();
      performTreeDrop(treeDrag, { kind: "root" });
      treeDrag = null;
    });
  }

  if (!widgets.length && !strokes.length && !hasSurfaces) {
    tree.textContent = t("hierarchy.empty");
    return;
  }

  const appendStroke = (/** @type {any} */ stroke, /** @type {any} */ depth) => {
    const item = document.createElement("div");
    item.className = `tree-item${state.canvasMode === "lines" && state.selectedStroke === stroke ? " selected" : ""}`;
    item.style.paddingLeft = `${9 + depth * 16}px`;

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `∿ ${stroke.name || stroke.id}`;
    label.title = t("tree.glow.editTooltip");
    label.addEventListener("click", () => {
      setCanvasMode("lines");
      setLineTool("select");
      state.selectedStroke = stroke;
      renderDesigner();
    });

    const glyphs = document.createElement("span");
    glyphs.className = "tree-glyphs";
    glyphs.append(
      treeGlyph(stroke, "hidden", stroke.hidden ? ICON_EYE_OFF : ICON_EYE, stroke.hidden ? t("tree.show") : t("tree.hide")),
      treeGlyph(stroke, "locked", stroke.locked ? "🔒" : "🔓", stroke.locked ? t("tree.unlock") : t("tree.lock")),
      treeActionGlyph(ICON_DUPLICATE, t("tree.duplicate"), () => duplicateStroke(stroke)),
    );

    item.append(label, glyphs);
    tree.append(item);
    bindTreeItemDrag(item, { kind: "stroke", stroke }, { allowInto: false });
  };

  const appendNodes = (/** @type {any} */ nodes, depth = 0) => nodes.forEach((/** @type {any} */ widget) => {
    const item = document.createElement("div");
    item.className = `tree-item${state.canvasMode === "widgets" && state.selectedWidget === widget ? " selected" : ""}`;
    item.style.paddingLeft = `${9 + depth * 16}px`;

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `${widget.id} · ${directImageButtonParts(widget) ? t("tree.imageButtonLabel") : widget.widget_type}`;
    label.addEventListener("click", () => {
      if (state.canvasMode !== "widgets") setCanvasMode("widgets");
      state.selectedWidget = widget;
      renderDesigner();
    });

    const glyphs = document.createElement("span");
    glyphs.className = "tree-glyphs";
    glyphs.append(
      treeGlyph(widget, "hidden", widget.hidden ? ICON_EYE_OFF : ICON_EYE, widget.hidden ? t("tree.show") : t("tree.hide")),
      treeGlyph(widget, "locked", widget.locked ? "🔒" : "🔓", widget.locked ? t("tree.unlock") : t("tree.lock")),
      treeActionGlyph(ICON_DUPLICATE, t("tree.duplicate"), () => duplicateWidget(widget)),
    );

    item.append(label, glyphs);
    tree.append(item);
    bindTreeItemDrag(item, { kind: "widget", widget }, { allowInto: widgetAllowsChildren(widget) });
    appendNodes(widget.children || [], depth + 1);
    strokes.filter((/** @type {any} */ stroke) => stroke.parent_id === widget.id).forEach((/** @type {any} */ stroke) => appendStroke(stroke, depth + 1));
  });
  const appendReadOnlyNodes = (/** @type {any} */ nodes, depth = 1) => (nodes || []).forEach((/** @type {any} */ widget) => {
    const item = document.createElement("div");
    item.className = "tree-item tree-readonly";
    item.style.paddingLeft = `${9 + depth * 16}px`;
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `${widget.id} · ${directImageButtonParts(widget) ? t("tree.imageButtonLabel") : widget.widget_type}`;
    label.title = t("tree.readonly.editHint");
    item.append(label);
    tree.append(item);
    appendReadOnlyNodes(widget.children, depth + 1);
  });
  const appendSurface = (/** @type {any} */ key, /** @type {any} */ title, /** @type {any} */ surface, { skipped = false } = {}) => {
    const header = document.createElement("div");
    const active = state.activeSurface === key;
    header.className = `tree-item tree-surface${active ? " active" : ""}`;
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `${title}${skipped ? t("tree.surface.skipSuffix") : ""}`;
    label.title = active ? t("tree.surface.active") : t("tree.surface.editHint");
    label.addEventListener("click", () => selectSurface(key));
    header.append(label);
    tree.append(header);
    if (active) appendNodes(surface?.widgets || [], 1);
    else appendReadOnlyNodes(surface?.widgets || []);
  };
  if (!hasSurfaces) {
    appendNodes(state.project.widgets);
  } else {
    if (state.project.widgets.length) appendSurface("root", t("surface.root"), state.project);
    if (state.project.bottom_layer) appendSurface("bottom", "Bottom-Layer", state.project.bottom_layer);
    (state.project.pages || []).forEach((/** @type {any} */ page) => {
      appendSurface(`page:${page.id}`, t("surface.pageLabel", { id: page.id }), page, { skipped: page.skip });
    });
    if (state.project.top_layer) appendSurface("top", "Top-Layer", state.project.top_layer);
  }

  if (activeSurfaceEntry().kind === "root") {
    strokes.filter((/** @type {any} */ stroke) => !stroke.parent_id).forEach((/** @type {any} */ stroke) => appendStroke(stroke, 0));
  }
}

function treeGlyph(/** @type {any} */ widget, /** @type {any} */ flag, /** @type {any} */ iconHtml, /** @type {any} */ title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tree-glyph${widget[flag] ? " active" : ""}`;
  button.innerHTML = iconHtml;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    pushUndo();
    widget[flag] = !widget[flag];
    markProjectDirty();
    renderCanvas();
    renderTree();
    if (state.selectedWidget === widget) renderProperties();
  });
  return button;
}

function treeActionGlyph(/** @type {any} */ iconHtml, /** @type {any} */ title, /** @type {any} */ onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-glyph";
  button.innerHTML = iconHtml;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

async function exportDesignerYaml() {
  $("#designer-status").textContent = t("designer.status.checking");
  if (!(await bakeAllStrokes())) {
    renderDesignerStatus();
    return;
  }
  try {
    const result = await api("designer/projects/export-yaml", {
      method: "POST", body: JSON.stringify({ project: state.project }),
    });
    $("#yaml-output").textContent = result.yaml;
    renderExportIssues(result.issues || []);
    $("#yaml-dialog").showModal();
    renderDesignerStatus();
    populateMergeDraftTargets();
  } catch (/** @type {any} */ error) {
    $("#designer-status").textContent = t("designer.status.exportFailed");
    renderExportIssues(error.details?.issues || []);
    toast(error.message, true);
  }
}

// "Als Entwurf speichern" in the YAML dialog - merges color:/font:/image:/
// lvgl: into an existing configuration's draft instead of the old copy to
// clipboard -> switch tab -> paste round trip. Only wired up when the role
// actually has draft-write access; other roles still only get "copy".
async function populateMergeDraftTargets() {
  const select = $("#merge-draft-target");
  const button = $("#merge-draft-save");
  if (!state.capabilities["configuration.write_draft"]) {
    select.closest(".merge-draft-controls").classList.add("hidden");
    return;
  }
  select.closest(".merge-draft-controls").classList.remove("hidden");
  select.replaceChildren(new Option(t("dialog.yamlOutput.mergeTargetPick"), ""));
  button.disabled = true;
  try {
    const result = await api("configurations");
    result.configurations.forEach((/** @type {any} */ configuration) => {
      select.append(new Option(configuration.name, configuration.name));
    });
    if (state.project.import_source?.name) {
      select.value = state.project.import_source.name;
    }
    button.disabled = !select.value;
  } catch {
    // Configurations list failed to load - leave only the placeholder;
    // "copy to clipboard" remains available regardless.
  }
}

async function saveMergeDraft() {
  const target = $("#merge-draft-target").value;
  if (!target) return;
  const button = $("#merge-draft-save");
  button.disabled = true;
  try {
    const result = await api("designer/projects/merge-draft", {
      method: "POST", body: JSON.stringify({ project: state.project, target }),
    });
    const changed = [...result.replaced, ...result.appended];
    toast(t("toast.mergeDraft.saved", { target, keys: changed.join(", ") }));
    $("#yaml-dialog").close();
    $$(".tab").forEach((item) => item.classList.toggle("active", item.dataset.tab === "configurations"));
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === "configurations"));
    $("#configurations").classList.remove("showing-list");
    await loadConfigurations();
    const entry = state.configurations.find((/** @type {any} */ item) => item.name === target);
    if (entry) await loadConfiguration(entry);
  } catch (/** @type {any} */ error) {
    toast(error.message, true);
  } finally {
    button.disabled = !$("#merge-draft-target").value;
  }
}

// "ZIP herunterladen" in the YAML dialog - bundles ui.yaml plus every
// locally uploaded image/font at its existing images/<name>/fonts/<name>
// path, so unzipping it straight into the config root reproduces exactly
// what the Designer already has on disk. Uses fetch() directly (not the
// api() helper) since the response is a binary blob, not JSON.
async function downloadProjectZip() {
  const button = $("#download-zip");
  button.disabled = true;
  if (!(await bakeAllStrokes())) {
    button.disabled = false;
    return;
  }
  try {
    const appBase = window.location.pathname.endsWith("/")
      ? window.location.pathname
      : `${window.location.pathname}/`;
    const response = await fetch(`${appBase}api/v1/designer/projects/export-zip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: state.project }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${response.status}`);
    }
    const missing = response.headers.get("X-Missing-Assets");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = normalizeProjectName($("#project-name").value).replace(/\.lvgldesign$/, "") + ".zip";
    link.click();
    URL.revokeObjectURL(url);
    if (missing) {
      const paths = missing.split(",").map((path) => decodeURIComponent(path));
      toast(t("toast.zip.missingAssets", { paths: paths.join(", ") }), true);
    } else {
      toast(t("toast.zip.downloaded"));
    }
  } catch (/** @type {any} */ error) {
    toast(t("toast.zip.downloadFailed", { error: error.message }), true);
  } finally {
    button.disabled = false;
  }
}

function renderExportIssues(/** @type {any} */ issues) {
  renderIssues($("#yaml-issues"), issues, t("issues.contextExport"));
}

function isBlockingIssue(/** @type {any} */ issue) {
  // Validation issues use severity "error"; the YAML exporter and importer
  // use "A" (blocking) vs "B" (warning) vs "C" (informational).
  return issue.severity === "error" || issue.severity === "A";
}

function renderIssues(/** @type {any} */ container, /** @type {any} */ issues, context = "") {
  container.replaceChildren();
  // "Preserved but not editable" notes are informational and a real config
  // produces dozens of them - listing each one would bury the real warnings.
  const notable = issues.filter((/** @type {any} */ issue) => issue.severity !== "C");
  const preserved = issues.length - notable.length;
  container.classList.toggle("hidden", !notable.length && !preserved);
  if (!notable.length && !preserved) return;

  const heading = document.createElement("strong");
  heading.textContent = notable.length
    ? `${t("issues.notableCount", { count: notable.length })} ${context}`.trim()
    : t("issues.preservedOnly", { count: preserved });
  container.append(heading);

  if (notable.length && preserved) {
    const note = document.createElement("div");
    note.className = "import-warning";
    note.textContent = t("issues.preservedAdditional", { count: preserved });
    container.append(note);
  }
  if (!notable.length) return;

  const list = document.createElement("ul");
  notable.forEach((/** @type {any} */ issue) => {
    const entry = document.createElement("li");
    entry.className = isBlockingIssue(issue) ? "issue-error" : "issue-warning";
    const where = issue.widget_id || issue.widget || issue.resource || issue.path || "";
    entry.textContent = where ? `${where}: ${issue.message}` : issue.message;
    list.append(entry);
  });
  container.append(list);
}

function bindConfigurations() {
  $("#refresh-configs").addEventListener("click", loadConfigurations);
  $("#save-draft").addEventListener("click", saveDraft);
  $("#check-yaml").addEventListener("click", checkYaml);
  $("#validate-esphome").addEventListener("click", validateEspHome);
  $("#show-diff").addEventListener("click", showDiff);
  $("#merge-draft").addEventListener("click", openMergeDialog);
  $("#publish").addEventListener("click", publishDraft);
  $("#compile-config").addEventListener("click", compileConfiguration);
  $("#install-config").addEventListener("click", installConfiguration);
  $("#refresh-jobs").addEventListener("click", loadBuilderJobs);
  $("#close-merge-dialog").addEventListener("click", () => $("#merge-dialog").close());
  $("#cancel-merge").addEventListener("click", () => $("#merge-dialog").close());
  $("#save-merge").addEventListener("click", saveMergedDraft);
  const editor = $("#yaml-editor");
  editor.addEventListener("input", updateYamlEditorUi);
  editor.addEventListener("click", updateYamlCursorStatus);
  editor.addEventListener("keyup", updateYamlCursorStatus);
  editor.addEventListener("select", updateYamlCursorStatus);
  editor.addEventListener("scroll", () => {
    $("#yaml-line-numbers").scrollTop = editor.scrollTop;
  });
  editor.addEventListener("keydown", (/** @type {any} */ event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const start = editor.selectionStart;
    editor.setRangeText("  ", start, editor.selectionEnd, "end");
    updateYamlEditorUi();
  });
  $("#yaml-search-next").addEventListener("click", () => findYamlMatch(1));
  $("#yaml-search-previous").addEventListener("click", () => findYamlMatch(-1));
  $("#yaml-search").addEventListener("input", () => findYamlMatch(0));
  $("#yaml-search").addEventListener("keydown", (/** @type {any} */ event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    findYamlMatch(event.shiftKey ? -1 : 1);
  });
  // Phone layout only: list <-> detail is one pane at a time there, so this
  // is what "leaving" the detail view means. A no-op above the breakpoint,
  // where both panels already show side by side regardless of the class.
  $("#back-to-configs").addEventListener("click", () => {
    $("#configurations").classList.add("showing-list");
  });
}

function updateYamlEditorUi() {
  const editor = $("#yaml-editor");
  $("#yaml-line-numbers").textContent = lineNumbers(editor.value);
  state.yamlDirty = editorIsDirty(
    state.activeConfig,
    editor.value,
    state.yamlLoadedContent,
  );
  const status = $("#yaml-dirty-status");
  status.classList.toggle("dirty", state.yamlDirty);
  status.textContent = !state.activeConfig
    ? t("configs.noFileLoaded")
    : state.yamlDirty
      ? t("configs.unsavedChanges")
      : state.hasDraft ? t("configs.savedDraft") : t("configs.activeState");
  updateYamlCursorStatus();
}

function updateYamlCursorStatus() {
  const editor = $("#yaml-editor");
  $("#yaml-cursor-status").textContent = t(
    "configs.cursorStatus",
    cursorPosition(editor.value, editor.selectionStart),
  );
}

function findYamlMatch(/** @type {any} */ direction) {
  const editor = $("#yaml-editor");
  const query = $("#yaml-search").value;
  const result = $("#yaml-search-result");
  if (!query) {
    result.textContent = "";
    return;
  }
  const match = findMatch(editor.value, query, editor.selectionStart, direction);
  if (!match.count) {
    result.textContent = "Kein Treffer";
    return;
  }
  editor.focus();
  editor.setSelectionRange(match.index, match.index + query.length);
  result.textContent = `${match.selected + 1} von ${match.count}`;
  updateYamlCursorStatus();
}

async function loadConfigurations() {
  try {
    const result = await api("configurations");
    state.configurations = result.configurations;
    const list = $("#config-list");
    list.replaceChildren();
    list.classList.toggle("empty", result.configurations.length === 0);
    if (!result.configurations.length) {
      list.textContent = t("configs.noFilesFound");
      return;
    }
    result.configurations.forEach((/** @type {any} */ configuration) => {
      const button = document.createElement("button");
      button.className = `config-item${state.activeConfig === configuration.name ? " active" : ""}`;
      const name = document.createElement("span");
      name.textContent = configuration.name;
      const meta = document.createElement("small");
      meta.textContent = `${Math.ceil(configuration.size / 1024)} KiB${configuration.has_draft ? " · Entwurf" : ""}`;
      if (configuration.has_draft) meta.className = "draft-dot";
      button.append(name, meta);
      button.addEventListener("click", () => {
        $("#configurations").classList.remove("showing-list");
        loadConfiguration(configuration);
      });
      list.append(button);
    });
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

async function loadConfiguration(/** @type {any} */ configuration) {
  if (
    state.yamlDirty
    && state.activeConfig
    && state.activeConfig !== configuration.name
    && !confirm(t("confirm.yaml.discardAndLoad"))
  ) return;
  try {
    const active = await api(`configurations/${encodedName(configuration.name)}`);
    state.activeConfig = configuration.name;
    state.activeRevision = active.revision;
    state.hasDraft = configuration.has_draft;
    let content = active.content;
    if (configuration.has_draft) {
      const draft = await api(`configurations/${encodedName(configuration.name)}/draft`);
      content = draft.content;
    }
    $("#config-title").textContent = configuration.name;
    $("#revision").textContent = active.revision;
    $("#yaml-editor").value = content;
    state.yamlLoadedContent = content;
    state.yamlDirty = false;
    $("#yaml-editor").disabled = !state.capabilities["configuration.write_draft"];
    $("#yaml-search").disabled = false;
    $("#yaml-search-previous").disabled = false;
    $("#yaml-search-next").disabled = false;
    $("#save-draft").disabled = !state.capabilities["configuration.write_draft"];
    $("#check-yaml").disabled = false;
    $("#show-diff").disabled = !state.hasDraft;
    $("#merge-draft").disabled = !state.hasDraft || !state.capabilities["configuration.write_draft"];
    $("#publish").disabled = !state.hasDraft || !state.capabilities["configuration.publish"];
    updateBuilderButtons();
    $("#config-output").classList.add("hidden");
    updateYamlEditorUi();
    await loadConfigurations();
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

async function saveDraft() {
  if (!state.activeConfig) return;
  try {
    await api(`configurations/${encodedName(state.activeConfig)}/draft`, {
      method: "PUT", body: JSON.stringify({ content: $("#yaml-editor").value }),
    });
    state.hasDraft = true;
    state.yamlLoadedContent = $("#yaml-editor").value;
    state.yamlDirty = false;
    $("#show-diff").disabled = false;
    $("#merge-draft").disabled = !state.capabilities["configuration.write_draft"];
    $("#publish").disabled = !state.capabilities["configuration.publish"];
    updateBuilderButtons();
    updateYamlEditorUi();
    toast(t("toast.draft.saved"));
    await loadConfigurations();
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

async function checkYaml() {
  if (!state.activeConfig) return;
  try {
    const source = state.hasDraft ? "draft" : "active";
    const result = await api(`configurations/${encodedName(state.activeConfig)}/check-yaml?source=${source}`, { method: "POST" });
    const output = $("#config-output");
    output.classList.remove("diff-output");
    output.textContent = result.valid
      ? t("config.output.yamlValid", { revision: result.revision })
      : t("config.output.yamlError", { line: result.line, column: result.column, error: result.error });
    output.classList.remove("hidden");
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

async function showDiff() {
  if (!state.activeConfig || !state.hasDraft) return;
  try {
    const result = await api(`configurations/${encodedName(state.activeConfig)}/diff`);
    const output = $("#config-output");
    if (result.diff) renderUnifiedDiff(output, result.diff, t);
    else {
      output.classList.remove("diff-output");
      output.textContent = t("config.output.noDifferences");
    }
    output.classList.remove("hidden");
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

async function openMergeDialog() {
  if (!state.activeConfig || !state.hasDraft) return;
  try {
    const encoded = encodedName(state.activeConfig);
    const [active, draft] = await Promise.all([
      api(`configurations/${encoded}`),
      api(`configurations/${encoded}/draft`),
    ]);
    state.activeRevision = active.revision;
    $("#revision").textContent = active.revision;
    $("#merge-config-name").textContent = state.activeConfig;
    $("#merge-active").value = active.content;
    $("#merge-draft-source").value = draft.content;
    $("#merge-result").value = draft.content;
    $("#merge-dialog").showModal();
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

async function saveMergedDraft() {
  if (!state.activeConfig) return;
  const content = $("#merge-result").value;
  try {
    await api(`configurations/${encodedName(state.activeConfig)}/draft`, {
      method: "PUT", body: JSON.stringify({ content }),
    });
    state.hasDraft = true;
    state.yamlLoadedContent = content;
    state.yamlDirty = false;
    $("#yaml-editor").value = content;
    $("#show-diff").disabled = false;
    $("#merge-draft").disabled = false;
    $("#publish").disabled = !state.capabilities["configuration.publish"];
    $("#merge-dialog").close();
    updateBuilderButtons();
    updateYamlEditorUi();
    await loadConfigurations();
    toast(t("toast.draft.mergedSaved"));
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

async function publishDraft() {
  if (!state.activeConfig || !state.hasDraft) return;
  if (!confirm(t("confirm.config.publish", { name: state.activeConfig }))) return;
  try {
    const result = await api(`configurations/${encodedName(state.activeConfig)}/publish`, {
      method: "POST", body: JSON.stringify({ expected_revision: state.activeRevision }),
    });
    state.activeRevision = result.revision;
    state.hasDraft = false;
    state.yamlLoadedContent = $("#yaml-editor").value;
    state.yamlDirty = false;
    $("#revision").textContent = result.revision;
    $("#show-diff").disabled = true;
    $("#merge-draft").disabled = true;
    $("#publish").disabled = true;
    updateBuilderButtons();
    updateYamlEditorUi();
    toast(t("toast.config.published"));
    await loadConfigurations();
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

function updateBuilderButtons() {
  const available = builderAvailability(state);
  $("#validate-esphome").disabled = !available.validate;
  $("#compile-config").disabled = !available.compile;
  $("#install-config").disabled = !available.install;
}

async function validateEspHome() {
  if (!state.activeConfig || state.hasDraft) return;
  const output = $("#config-output");
  output.classList.remove("diff-output");
  output.textContent = t("config.output.validating");
  output.classList.remove("hidden");
  try {
    const result = await builderController.validate(encodedName(state.activeConfig));
    const lines = Array.isArray(result.output) ? result.output.join("\n") : "";
    const validity = result.valid ? t("config.output.buildApprovalSuffix", { seconds: result.expires_in_seconds }) : "";
    output.textContent = `${result.valid ? t("config.output.espValid") : t("config.output.espInvalid")}\nRevision: ${result.revision}${validity}\n\n${lines}`.trim();
  } catch (/** @type {any} */ error) {
    output.textContent = `${error.code || t("config.output.errorFallback")}: ${error.message}`;
    toast(error.message, true);
  }
}

function builderRequestKey(/** @type {any} */ operation) {
  return builderRequest(state, operation, () => globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-request`);
}

async function compileConfiguration() {
  if (!state.activeConfig || state.hasDraft) return;
  const request = builderRequestKey("compile");
  state.builderRequestsRunning.add("compile");
  updateBuilderButtons();
  try {
    const result = await builderController.compile(encodedName(state.activeConfig), request.key);
    delete state.builderRequestKeys[request.slot];
    state.builderJobs[result.job.job_id] = result.job;
    renderBuilderJobs();
    toast(result.idempotent_replay
      ? t("toast.builder.jobRestored", { id: result.job.job_id })
      : t("toast.builder.jobStarted", { id: result.job.job_id }));
  } catch (/** @type {any} */ error) { toast(error.message, true); }
  finally {
    state.builderRequestsRunning.delete("compile");
    updateBuilderButtons();
  }
}

async function installConfiguration() {
  if (!state.activeConfig || state.hasDraft) return;
  if (!confirm(t("confirm.firmware.installOta", { name: state.activeConfig }))) return;
  const request = builderRequestKey("install");
  state.builderRequestsRunning.add("install");
  updateBuilderButtons();
  try {
    const result = await builderController.install(encodedName(state.activeConfig), request.key);
    delete state.builderRequestKeys[request.slot];
    state.builderJobs[result.job.job_id] = result.job;
    renderBuilderJobs();
    toast(result.idempotent_replay ? `OTA-Job ${result.job.job_id} wiederhergestellt.` : `OTA-Job ${result.job.job_id} gestartet.`);
  } catch (/** @type {any} */ error) { toast(error.message, true); }
  finally {
    state.builderRequestsRunning.delete("install");
    updateBuilderButtons();
  }
}

async function loadBuilderJobs() {
  if (!state.capabilities["firmware.compile"]) return;
  try {
    state.builderJobs = replaceBuilderJobs(await builderController.jobs());
    renderBuilderJobs();
  } catch (/** @type {any} */ error) { toast(error.message, true); }
}

function renderBuilderJobs() {
  const panel = $("#builder-jobs");
  const list = $("#builder-job-list");
  const jobs = sortedBuilderJobs(state.builderJobs);
  panel.classList.toggle("hidden", !state.capabilities["firmware.compile"]);
  list.replaceChildren();
  if (!jobs.length) {
    list.textContent = t("configs.noJobs");
    return;
  }
  jobs.forEach((job) => {
    const row = document.createElement("div");
    row.className = "builder-job";
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${job.configuration || "—"} · ${job.job_type || t("configs.jobFallback")}`;
    const meta = document.createElement("small");
    meta.textContent = `${job.status || t("configs.statusUnknown")}${Number.isFinite(job.progress) ? ` · ${job.progress}%` : ""} · ${job.job_id}`;
    description.append(title, meta);
    if (job.last_output) {
      const log = document.createElement("pre");
      log.className = "builder-job-output";
      log.textContent = job.last_output;
      description.append(log);
    }
    row.append(description);
    if (["queued", "running"].includes(job.status)) {
      const cancel = document.createElement("button");
      cancel.className = "button subtle compact";
      cancel.textContent = t("configs.cancelJob");
      cancel.addEventListener("click", async () => {
        try {
          await builderController.cancel(job.job_id);
          await loadBuilderJobs();
        } catch (/** @type {any} */ error) { toast(error.message, true); }
      });
      row.append(cancel);
    }
    list.append(row);
  });
}

function connectBuilderEvents() {
  if (!state.capabilities["firmware.compile"] || builderEventsClient?.socket) return;
  builderEventsClient ||= createJsonSocket({
    path: "jobs/events",
    onOpen: (socket) => { state.builderSocket = socket; },
    onClose: () => { state.builderSocket = null; },
    onMessage: (rawPayload) => {
      const payload = /** @type {any} */ (rawPayload);
      if (payload.type === "resync_required") {
        loadBuilderJobs();
        return;
      }
      if (payload.type !== "builder_job" || !payload.data) return;
      applyBuilderEvent(state.builderJobs, payload);
      renderBuilderJobs();
    },
  });
  state.builderSocket = builderEventsClient.connect();
}

function clamp(/** @type {any} */ value, /** @type {any} */ minimum, /** @type {any} */ maximum) {
  return Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum);
}

// Read-only debug handle - not part of the app's own logic, only for
// inspecting state from the browser console or an automated check.
(/** @type {any} */ (window)).__appState = state;

store.subscribe(() => renderDesignerStatus(), selectDesignerStatus);

initialize();
