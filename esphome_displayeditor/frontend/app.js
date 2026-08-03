import { computeLayout, contentOrigin, fontFamilyId, resolvedFontFamily } from "./layout.js";
import { boundingBox, nearestSegment } from "./glowline/geometry.js";
import { drawDocument, flowBoundsDocument, hasFlow, strokePath } from "./glowline/renderer.js";
import { format565, hsvToRgb, quantizeImageData, rgb565to888, rgb888to565 } from "./glowline/rgb565.js";
import { MDI_CATALOG_VERSION, MDI_GLYPHS } from "./mdi-glyphs.js";
import { applyStaticTranslations, getLanguage, setLanguage, t } from "./i18n.js";
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

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// Mirrors backend/designer_core/model.py's STATES_KEY - both sides need
// the exact same key name for a widget/theme's per-state style overrides.
const STATES_KEY = "states";

// Maps each widget to its live canvas DOM node, so a drag/resize can update
// descendant boxes (children, layout-dependent siblings) without recreating
// any node - recreating the dragged/resized node mid-gesture would drop its
// pointer capture.
const canvasNodeByWidget = new Map();

function syncCanvasLayout() {
  const boxes = computeLayout(activeSurfaceProject());
  boxes.forEach((box, widget) => {
    const node = canvasNodeByWidget.get(widget);
    if (!node) return;
    node.style.left = `${box.left}px`;
    node.style.top = `${box.top}px`;
    node.style.width = `${Math.max(1, box.width)}px`;
    node.style.height = `${Math.max(1, box.height)}px`;
  });
}

const state = {
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
  // Which LVGL state the style controls currently edit. "" is the base style.
  activeState: "",
  // Theme editor: which widget type/state it's currently showing. Separate
  // from activeState above, which belongs to the per-widget style editor -
  // both panels can be visible at once and must not fight over one state.
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

  // Glow lines (ported GlowLine editor). Editing widgets and editing lines are
  // mutually exclusive modes, matching the desktop app being a separate tool -
  // mixing hit-testing for both under one cursor model would be a lot of
  // complexity for a case that rarely overlaps in practice.
  canvasMode: "widgets", // "widgets" | "lines"
  lineTool: "select", // "select" | "draw"
  selectedStroke: null,
  drawingPoints: null, // points of a line being placed, while lineTool === "draw"
  colorWheelTarget: "line", // "line" | "glow" | "flow"
  flowPreviewTimer: null,
  flowPreviewStart: 0,
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

let viewer = null;

function freshProject() {
  return {
    format: "esphome-lvgl-designer-project",
    format_version: 3,
    canvas: { width: 480, height: 480 },
    background: { path: "", export_as_lvgl_image: false, image_id: "bg_image", opacity_in_editor: 40 },
    display_id_placeholder: "my_display",
    default_font: "",
    widgets: [],
    pages: [],
    top_layer: null,
    bottom_layer: null,
    page_wrap: true,
    styles: [],
    fonts: [],
    images: [],
    colors: [],
    theme: {},
    extra_lvgl: {},
    canvas_source: "default",
    export_sections: ["color", "font", "image", "lvgl"],
    import_source: {},
    glow_strokes: [],
  };
}

function ensureProjectSurfaces() {
  if (!Array.isArray(state.project.widgets)) state.project.widgets = [];
  if (!Array.isArray(state.project.pages)) state.project.pages = [];
  if (typeof state.project.page_wrap !== "boolean") state.project.page_wrap = true;
  [state.project.top_layer, state.project.bottom_layer, ...state.project.pages].filter(Boolean).forEach((surface) => {
    if (!Array.isArray(surface.widgets)) surface.widgets = [];
    if (!surface.layout || typeof surface.layout !== "object" || Array.isArray(surface.layout)) surface.layout = {};
    if (!surface.style_tree || typeof surface.style_tree !== "object" || Array.isArray(surface.style_tree)) surface.style_tree = {};
    if (!surface.extra || typeof surface.extra !== "object" || Array.isArray(surface.extra)) surface.extra = {};
  });
}

function surfaceEntries() {
  ensureProjectSurfaces();
  const entries = [];
  const pages = state.project.pages;
  if (!pages.length || state.project.widgets.length) {
    entries.push({ key: "root", kind: "root", label: t("surface.root"), surface: state.project });
  }
  if (state.project.bottom_layer) {
    entries.push({ key: "bottom", kind: "bottom", label: "Bottom-Layer", surface: state.project.bottom_layer });
  }
  pages.forEach((page, index) => entries.push({
    key: `page:${page.id}`,
    kind: "page",
    label: t("surface.page", { n: index + 1, id: page.id }) + (page.skip ? t("surface.pageSkippedSuffix") : ""),
    surface: page,
    index,
  }));
  if (state.project.top_layer) {
    entries.push({ key: "top", kind: "top", label: "Top-Layer", surface: state.project.top_layer });
  }
  return entries;
}

function normaliseActiveSurface() {
  const entries = surfaceEntries();
  if (!entries.some((entry) => entry.key === state.activeSurface)) {
    state.activeSurface = entries.find((entry) => entry.kind === "page")?.key || entries[0]?.key || "root";
  }
  return entries.find((entry) => entry.key === state.activeSurface)
    || { key: "root", kind: "root", label: t("surface.root"), surface: state.project };
}

function activeSurfaceEntry() {
  return normaliseActiveSurface();
}

function activeWidgetRoots() {
  return activeSurfaceEntry().surface.widgets;
}

function activeSurfaceProject() {
  const entry = activeSurfaceEntry();
  if (entry.kind === "root") return state.project;
  return {
    ...state.project,
    widgets: entry.surface.widgets,
    extra_lvgl: {
      ...(state.project.extra_lvgl || {}),
      ...(entry.surface.style_tree || {}),
      layout: entry.surface.layout || {},
    },
  };
}

function allProjectWidgets() {
  ensureProjectSurfaces();
  const result = [];
  const visit = (nodes) => (nodes || []).forEach((widget) => {
    result.push(widget);
    visit(widget.children || []);
  });
  visit(state.project.widgets);
  state.project.pages.forEach((page) => visit(page.widgets));
  visit(state.project.bottom_layer?.widgets);
  visit(state.project.top_layer?.widgets);
  return result;
}

function uniqueProjectWidgetId(base) {
  // reserved_ids are ids used by hardware entities elsewhere in an imported
  // source config (binary_sensor:, button:, ...) - never modeled here, but
  // sharing ESPHome's one flat id() namespace with everything created here.
  const ids = new Set([
    ...allProjectWidgets().map((widget) => widget.id),
    ...(state.project.reserved_ids || []),
  ]);
  let number = 1;
  let candidate = `${base}_${number}`;
  while (ids.has(candidate)) {
    number += 1;
    candidate = `${base}_${number}`;
  }
  return candidate;
}

function selectSurface(key) {
  if (!surfaceEntries().some((entry) => entry.key === key)) return;
  stopFlowPreview();
  state.activeSurface = key;
  state.selectedWidget = null;
  state.selectedStroke = null;
  state.drawingStroke = null;
  state.canvasMode = "widgets";
  renderDesigner();
}

function freshGlowStroke(id) {
  return {
    id, points: [], name: "", color565: 0x07ff, width: 5, corner_radius: 12,
    mode: "polyline", closed: false,
    glow: { enabled: true, radius: 14, intensity: 0.85, use_line_color: true, color565: 0x07ff },
    flow: {
      enabled: false, mode: "arrows", reversed: false, spacing: 40, size: 14,
      width: 0, use_line_color: false, color565: 0xffff, glow_radius: 0, glow_intensity: 0.9,
    },
    parent_id: "",
    hidden: false,
    locked: false,
  };
}

async function api(path, options = {}) {
  const appBase = window.location.pathname.endsWith("/")
    ? window.location.pathname
    : `${window.location.pathname}/`;
  const response = await fetch(`${appBase}api/v1/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `HTTP ${response.status}`);
    error.code = body.error;
    error.details = body.details;
    throw error;
  }
  return body;
}

let toastTimer;
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = error ? "show error" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = ""; }, 3500);
}

function encodedName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

function cloneProject(project = state.project) {
  return JSON.parse(JSON.stringify(project));
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
    state.system = system;
    state.capabilities = capabilityData.capabilities;
    state.schemas = schemaData.widgets;
    state.gridCellProperties = schemaData.grid_cell_properties || [];
    state.states = schemaData.states || [];
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
  } catch (error) {
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
    const device = state.devices.find((item) => item.id === state.selectedDevice);
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
  const canRead = Boolean(state.capabilities["device.info"]);
  const canManage = Boolean(state.capabilities["device.manage"]);
  $("#add-device").classList.toggle("hidden", !canManage);
  if (!canRead) {
    list.className = "device-list empty";
    list.textContent = t("devices.apiUnavailable");
    return;
  }
  try {
    const result = await api("devices");
    state.devices = result.devices || [];
    if (state.selectedDevice && !state.devices.some((item) => item.id === state.selectedDevice)) {
      state.selectedDevice = null;
    }
    renderDeviceList();
    if (state.selectedDevice) await loadDeviceDetails(state.selectedDevice);
  } catch (error) {
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
  state.devices.forEach((device) => {
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

async function loadDeviceDetails(deviceId) {
  const device = state.devices.find((item) => item.id === deviceId);
  if (!device) return;
  const canManage = Boolean(state.capabilities["device.manage"]);
  $("#device-title").textContent = device.name;
  $("#device-connection").textContent = `${DEVICE_STATUS[device.status] || device.status} · ${device.host}:${device.port}${device.last_error ? ` · ${device.last_error}` : ""}`;
  $("#edit-device").disabled = !canManage;
  $("#remove-device").disabled = !canManage;
  $("#reconnect-device").disabled = !canManage;
  try {
    const [info, entities, states, logs] = await Promise.all([
      api(`devices/${encodeURIComponent(deviceId)}/info`),
      api(`devices/${encodeURIComponent(deviceId)}/entities`),
      api(`devices/${encodeURIComponent(deviceId)}/states`),
      api(`devices/${encodeURIComponent(deviceId)}/logs?limit=500`),
    ]);
    if (state.selectedDevice !== deviceId) return;
    $("#device-info pre").textContent = Object.keys(info.info || {}).length
      ? JSON.stringify(info.info, null, 2)
      : t("devices.noInfoYet");
    renderDeviceTable($("#device-entities"), entities.entities || [], ["type", "name", "object_id", "key"]);
    state.deviceStates = states.states || [];
    renderDeviceTable($("#device-states"), state.deviceStates, ["type", "key", "available", "state"]);
    $("#device-logs pre").textContent = formatDeviceLogs(logs.logs || []);
  } catch (error) {
    toast(error.message, true);
  }
}

function renderDeviceTable(container, rows, preferredColumns) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(Object.assign(document.createElement("div"), { className: "empty", textContent: t("devices.noDataYet") }));
    return;
  }
  const columns = preferredColumns.filter((column) => rows.some((row) => row[column] !== undefined));
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
  rows.forEach((row) => {
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

function formatDeviceLogs(logs) {
  if (!logs.length) return t("devices.noLogsYet");
  return logs.map((item) => `[${item.received_at || ""}] [${item.level || "INFO"}] ${item.message || ""}`).join("\n");
}

function openDeviceDialog(device = null) {
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

async function saveDevice(event) {
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
    await api(editing ? `admin/devices/${encodeURIComponent(editing)}` : "admin/devices", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    if (encryptionKey) {
      await api(`admin/device-secrets/${encodeURIComponent(body.encryption_key_ref)}`, {
        method: "PUT",
        body: JSON.stringify({ encryption_key: encryptionKey }),
      });
    }
    state.selectedDevice = body.id;
    $("#device-dialog").close();
    await loadDevices();
    toast(editing ? t("toast.device.updated") : t("toast.device.added"));
  } catch (error) {
    toast(error.message, true);
  }
}

async function reconnectSelectedDevice() {
  if (!state.selectedDevice) return;
  try {
    await api(`admin/devices/${encodeURIComponent(state.selectedDevice)}/reconnect`, { method: "POST" });
    toast(t("toast.device.reconnectStarted"));
    await loadDevices();
  } catch (error) { toast(error.message, true); }
}

async function removeSelectedDevice() {
  const device = state.devices.find((item) => item.id === state.selectedDevice);
  if (!device || !confirm(t("confirm.device.remove", { name: device.name }))) return;
  try {
    await api(`admin/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
    state.selectedDevice = null;
    await loadDevices();
    toast(t("toast.device.removed"));
  } catch (error) { toast(error.message, true); }
}

function connectDeviceEvents() {
  if (!state.capabilities["device.states"] || state.deviceSocket) return;
  const appBase = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}${appBase}api/v1/devices/events`);
  state.deviceSocket = socket;
  socket.addEventListener("message", async (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
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
        const key = `${event.state.type}:${event.state.key ?? event.state.object_id ?? "unknown"}`;
        const index = state.deviceStates.findIndex((item) => `${item.type}:${item.key ?? item.object_id ?? "unknown"}` === key);
        if (index >= 0) state.deviceStates[index] = event.state;
        else state.deviceStates.push(event.state);
        renderDeviceTable($("#device-states"), state.deviceStates, ["type", "key", "available", "state"]);
      }
      updateViewerRuntimeEvent(event);
      renderRuntimeBindingStatus();
      applyDesignerRuntimePreview();
    }
  });
  socket.addEventListener("close", () => {
    if (state.deviceSocket === socket) state.deviceSocket = null;
    window.setTimeout(connectDeviceEvents, 3000);
  });
}

async function loadViewerRuntimeSources() {
  if (!state.capabilities["device.states"]) {
    state.viewerRuntimeSources = { devices: [] };
    return state.viewerRuntimeSources;
  }
  try {
    state.viewerRuntimeSources = await api("viewer/runtime");
  } catch {
    state.viewerRuntimeSources = { devices: [] };
  }
  return state.viewerRuntimeSources;
}

function updateViewerRuntimeEvent(event) {
  const devices = state.viewerRuntimeSources.devices || (state.viewerRuntimeSources.devices = []);
  if (event.type === "device_removed") {
    state.viewerRuntimeSources.devices = devices.filter((device) => device.id !== event.device_id);
    return;
  }
  const device = devices.find((item) => item.id === event.device_id);
  if (!device) return;
  if (event.type === "connection") {
    device.status = event.status;
    return;
  }
  if (event.type !== "state" || !event.state) return;
  const runtimeState = { ...event.state };
  runtimeState.entity_id ||= `${runtimeState.type}:${runtimeState.key ?? runtimeState.object_id ?? "unknown"}`;
  device.states ||= [];
  const index = device.states.findIndex((item) => item.entity_id === runtimeState.entity_id);
  if (index >= 0) device.states[index] = runtimeState;
  else device.states.push(runtimeState);
  device.last_seen = runtimeState.received_at || device.last_seen;
}

async function loadViewerBindings(name) {
  clearViewerBindings();
  if (!name) return;
  try {
    const result = await api("viewer/bindings/" + encodeURIComponent(name));
    state.viewerBindings = result.bindings || [];
    state.viewerBindingsRevision = result.revision || null;
  } catch (error) {
    toast(t("toast.binding.loadFailed", { error: error.message }), true);
  }
}

function clearViewerBindings() {
  state.viewerBindings = [];
  state.viewerBindingsRevision = null;
}

async function openLiveViewer() {
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
  if (state.viewerRuntimeSocket || !state.viewerRuntimeActive && !$("#viewer-dialog").open) return;
  state.viewerRuntimeActive = true;
  const appBase = window.location.pathname.endsWith("/") ? window.location.pathname : window.location.pathname + "/";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(protocol + "//" + window.location.host + appBase + "api/v1/viewer/runtime/events");
  state.viewerRuntimeSocket = socket;
  socket.addEventListener("message", async (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
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
  });
  socket.addEventListener("close", () => {
    if (state.viewerRuntimeSocket === socket) state.viewerRuntimeSocket = null;
    if (state.viewerRuntimeActive && $("#viewer-dialog").open) {
      state.viewerRuntimeReconnect = window.setTimeout(connectViewerRuntimeEvents, 3000);
    }
  });
}

function stopViewerRuntimeEvents() {
  state.viewerRuntimeActive = false;
  if (state.viewerRuntimeReconnect !== null) window.clearTimeout(state.viewerRuntimeReconnect);
  state.viewerRuntimeReconnect = null;
  const socket = state.viewerRuntimeSocket;
  state.viewerRuntimeSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
}

function closeViewer() {
  stopViewerRuntimeEvents();
  viewer.close();
}

// Phone layout only: which of the three designer panels is the active full-
// width pane. Irrelevant above the 700px breakpoint, where CSS shows all
// three as grid columns regardless of this attribute.
function setDesignerPane(pane) {
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
  });
  $("#open-viewer").addEventListener("click", openLiveViewer);
  $("#viewer-close").addEventListener("click", closeViewer);
  $("#viewer-reset").addEventListener("click", () => viewer.reset());
  $("#viewer-page-select").addEventListener("change", (event) => {
    viewer.setActivePage(event.target.value);
  });
  $("#viewer-page-previous").addEventListener("click", () => viewer.changePage(-1));
  $("#viewer-page-next").addEventListener("click", () => viewer.changePage(1));
  $("#viewer-fit").addEventListener("click", () => viewer.fit());
  $("#viewer-zoom-100").addEventListener("click", () => viewer.setZoom(1));
  $("#viewer-zoom-out").addEventListener("click", () => viewer.setZoom(viewer.zoom / 1.25));
  $("#viewer-zoom-in").addEventListener("click", () => viewer.setZoom(viewer.zoom * 1.25));
  $("#viewer-rotation").addEventListener("change", (event) => viewer.setRotation(event.target.value));
  $("#viewer-dialog").addEventListener("close", closeViewer);
  $("#viewer-dialog").addEventListener("cancel", (event) => {
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
  let widgetIdBeforeEdit = null;
  $("#prop-id").addEventListener("focus", (event) => {
    widgetIdBeforeEdit = event.target.value;
  });
  $("#prop-id").addEventListener("blur", (event) => {
    const widget = state.selectedWidget;
    if (!widget) return;
    const currentId = widget.id;
    const collides = projectWidgetEntries().some((entry) => entry !== widget && entry.id === currentId)
      || (state.project.reserved_ids || []).includes(currentId)
      || [state.project.styles, state.project.fonts, state.project.images, colorLibrary()]
        .some((entries) => (entries || []).some((entry) => entry.id === currentId));
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
  $("#style-state").addEventListener("change", changeActiveState);
  $("#style-mode").addEventListener("change", changeStyleMode);
  $("#style-ref").addEventListener("change", changeStyleRef);
  $("#save-as-style").addEventListener("click", saveCurrentStyleAsNamed);
  $("#widget-action-trigger").addEventListener("change", () => renderWidgetActionBuilder(state.selectedWidget));
  $("#widget-action-type").addEventListener("change", () => renderWidgetActionBuilder(state.selectedWidget));
  $("#widget-action-target").addEventListener("change", () => renderWidgetActionBuilder(state.selectedWidget));
  $("#add-widget-action").addEventListener("click", addWidgetAction);
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
  $("#runtime-live-preview").addEventListener("change", (event) => {
    state.designerRuntimePreview = event.target.checked;
    renderCanvas();
  });
  state.runtimeStatusTimer ||= window.setInterval(() => {
    renderRuntimeBindingStatus();
    applyDesignerRuntimePreview();
  }, 1000);
  bindGlowTools();
  bindSurfaceTools();

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
  document.addEventListener("keydown", (event) => {
    if (!$("#designer").classList.contains("active")) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

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

function setZoom(value) {
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

async function openDesignerProject(event) {
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
    if (!result.valid) throw new Error(result.issues.map((issue) => issue.message).join("\n"));
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
  } catch (error) {
    toast(t("toast.project.loadFailed", { error: error.message }), true);
  }
}

async function downloadDesignerProject() {
  try {
    const result = await api("designer/projects/validate", {
      method: "POST", body: JSON.stringify({ project: state.project }),
    });
    if (!result.valid) throw new Error(result.issues.map((issue) => issue.message).join("\n"));
    const blob = new Blob([JSON.stringify(result.project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = normalizeProjectName($("#project-name").value);
    link.click();
    URL.revokeObjectURL(url);
    toast(t("toast.project.downloaded"));
  } catch (error) {
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
  state.configurations.forEach((config) => select.append(new Option(config.name, config.name)));
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

async function probePickedFile(event) {
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

async function probeImport(payload) {
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
  } catch (error) {
    importState.stats = null;
    summary.textContent = error.message;
    summary.classList.add("import-error");
    $("#import-canvas").classList.add("hidden");
    $("#do-import").disabled = true;
  }
}

const CANVAS_SOURCE_LABELS = {
  user: t("canvas.source.user"),
  display_dimensions: t("canvas.source.displayDimensions"),
  display_model: t("canvas.source.displayModel"),
  root_grid: t("canvas.source.rootGrid"),
  bounding_box: t("canvas.source.boundingBox"),
  default: t("canvas.source.default"),
};

function renderImportSummary(stats) {
  const summary = $("#import-summary");
  summary.classList.remove("import-error");
  summary.replaceChildren();

  const types = Object.entries(stats.widget_types)
    .map(([type, count]) => `${count}× ${type}`).join(", ");
  const lines = [
    t("import.summary.widgetsLine", { count: stats.widget_count, types }),
    t("import.summary.canvasLine", {
      width: stats.canvas.width,
      height: stats.canvas.height,
      source: CANVAS_SOURCE_LABELS[stats.canvas.source] || stats.canvas.source,
    }),
  ];
  if (stats.images || stats.fonts || stats.styles) {
    lines.push(t("import.summary.assetsLine", { images: stats.images, fonts: stats.fonts, styles: stats.styles }));
  }
  lines.forEach((text) => {
    const row = document.createElement("div");
    row.textContent = text;
    summary.append(row);
  });

  if (stats.unsupported_types.length) {
    summary.append(warningRow(
      t("import.summary.unsupportedTypes", { types: stats.unsupported_types.join(", ") })));
  }
  if (stats.preserved_keys.length) {
    summary.append(warningRow(
      t("import.summary.preservedKeys", { count: stats.preserved_keys.length })));
  }
  if (stats.issues.A) {
    summary.append(warningRow(t("import.summary.blockingIssues", { count: stats.issues.A }), true));
  }
}

function warningRow(text, severe = false) {
  const row = document.createElement("div");
  row.className = severe ? "issue-error" : "import-warning";
  row.textContent = text;
  return row;
}

async function runImport() {
  if (state.projectDirty && !confirm(t("confirm.discardUnsaved"))) return;
  const payload = importState.configuration
    ? { configuration: importState.configuration }
    : { content: importState.content };
  payload.canvas = {
    width: clamp(Number($("#import-width").value), 1, 4096),
    height: clamp(Number($("#import-height").value), 1, 4096),
  };

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
    const warnings = result.issues.filter((issue) => issue.severity === "B").length;
    toast(t("toast.import.summary", { count: result.stats.widget_count })
      + (warnings ? t("toast.import.warningsSuffix", { count: warnings }) : ""));
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("#do-import").disabled = false;
  }
}

async function loadServerProjects() {
  try {
    const result = await api("designer/projects");
    const select = $("#server-projects");
    const selected = select.value;
    select.replaceChildren(new Option(t("project.savedProjects"), ""));
    result.projects.forEach((project) => {
      const option = new Option(project.name, project.name);
      option.dataset.revision = project.revision;
      select.append(option);
    });
    select.value = result.projects.some((project) => project.name === selected) ? selected : "";
    updateServerProjectButtons();
  } catch (error) {
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
    const result = await api(`designer/projects/${encodeURIComponent(name)}`);
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
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveServerProject() {
  const name = normalizeProjectName($("#project-name").value);
  $("#project-name").value = name;
  const expectedRevision = state.projectName === name ? state.projectRevision : null;
  try {
    const result = await api(`designer/projects/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ project: state.project, expected_revision: expectedRevision }),
    });
    state.projectName = name;
    state.projectRevision = result.revision;
    state.projectDirty = false;
    renderDesignerStatus();
    renderProperties();
    await loadServerProjects();
    $("#server-projects").value = name;
    updateServerProjectButtons();
    toast(t("toast.project.savedToStorage"));
  } catch (error) {
    toast(error.code === "project_exists" ? t("toast.project.alreadyExists") : error.message, true);
  }
}

async function deleteServerProject() {
  const name = $("#server-projects").value;
  if (!name || !confirm(t("confirm.project.deleteStored", { name }))) return;
  const option = $("#server-projects").selectedOptions[0];
  const revision = state.projectName === name ? state.projectRevision : option.dataset.revision;
  try {
    await api(`designer/projects/${encodeURIComponent(name)}?expected_revision=${encodeURIComponent(revision)}`, {
      method: "DELETE",
    });
    if (state.projectName === name) {
      state.projectName = null;
      clearViewerBindings();
      state.projectRevision = null;
      state.projectDirty = true;
    }
    await loadServerProjects();
    renderDesignerStatus();
    toast(t("toast.project.deletedFromStorage"));
  } catch (error) {
    toast(error.message, true);
  }
}

function normalizeProjectName(value) {
  let name = String(value || "display").trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  name = name.replace(/^\.+/, "") || "display";
  // Drop a source extension too, so importing panel.yaml gives panel.lvgldesign
  // rather than panel.yaml.lvgldesign.
  name = name.replace(/\.(lvgldesign|ya?ml)$/i, "");
  return `${name.slice(0, 116) || "display"}.lvgldesign`;
}

function pushUndo() {
  const serialized = JSON.stringify(state.project);
  if (state.undo[state.undo.length - 1] !== serialized) {
    state.undo.push(serialized);
    if (state.undo.length > 50) state.undo.shift();
  }
  state.redo = [];
  updateUndoButtons();
}

function reselectAfterHistoryChange(widgetId, strokeId) {
  state.selectedWidget = widgetId
    ? allWidgets().find((widget) => widget.id === widgetId) || null
    : null;
  state.selectedStroke = strokeId
    ? (state.project.glow_strokes || []).find((stroke) => stroke.id === strokeId) || null
    : null;
}

function undoDesignerChange() {
  if (!state.undo.length) return;
  const widgetId = state.selectedWidget?.id;
  const strokeId = state.selectedStroke?.id;
  state.redo.push(JSON.stringify(state.project));
  state.project = JSON.parse(state.undo.pop());
  normaliseActiveSurface();
  reselectAfterHistoryChange(widgetId, strokeId);
  markProjectDirty();
  renderDesigner();
}

function redoDesignerChange() {
  if (!state.redo.length) return;
  const widgetId = state.selectedWidget?.id;
  const strokeId = state.selectedStroke?.id;
  state.undo.push(JSON.stringify(state.project));
  state.project = JSON.parse(state.redo.pop());
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
  state.projectDirty = true;
  renderDesignerStatus();
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
  const icons = {
    obj: "▣", container: "▤", label: "T", button: "▰",
    switch: "◉", slider: "━", bar: "▮", arc: "◔", image: "▧", animimg: "▩",
  };
  state.schemas.forEach((schema) => {
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
  });

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
  const result = [];
  const visit = (items) => items.forEach((widget) => {
    result.push(widget);
    visit(widget.children || []);
  });
  visit(nodes);
  return result;
}

function editorWidgetNode(id, widgetType, {
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

function migrateButtonTextToChildLabel(button) {
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

function selectedChildTarget() {
  const parentSchema = state.selectedWidget
    ? state.schemas.find((item) => item.type_key === state.selectedWidget.widget_type)
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

function addWidget(schema) {
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

function visualWidgets() {
  // The layout engine resolves grid/flex/align placement; a widget with no
  // computed box (an unknown parent arrangement) falls back to its raw
  // coordinates so it stays reachable rather than vanishing.
  const boxes = computeLayout(activeSurfaceProject());
  return allWidgets().map((widget) => {
    const box = boxes.get(widget);
    return box
      ? { widget, ...box }
      : {
          widget,
          left: Number(widget.x) || 0,
          top: Number(widget.y) || 0,
          width: Number(widget.width) || 100,
          height: Number(widget.height) || 40,
          managed: false,
          originX: 0,
          originY: 0,
        };
  });
}

function blankSurface() {
  return { widgets: [], layout: {}, style_tree: {}, extra: {} };
}

function uniquePageId() {
  const used = new Set([
    ...allProjectWidgets().map((widget) => widget.id),
    ...(state.project.pages || []).map((page) => page.id),
    ...(state.project.colors || []).map((item) => item.id),
    ...(state.project.fonts || []).map((item) => item.id),
    ...(state.project.images || []).map((item) => item.id),
    ...(state.project.styles || []).map((item) => item.id),
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

function addLayer(kind) {
  const property = kind === "top" ? "top_layer" : "bottom_layer";
  if (!state.project[property]) {
    pushUndo();
    state.project[property] = blankSurface();
    markProjectDirty();
  }
  selectSurface(kind);
}

function moveActivePage(delta) {
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

function parseSurfaceObject(control, label) {
  let value;
  try {
    value = JSON.parse(control.value || "{}");
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(t("validation.json.mustBeObject", { label }));
  }
  return value;
}

function pageIdIsUsed(id, currentPage) {
  return (state.project.pages || []).some((page) => page !== currentPage && page.id === id)
    || allProjectWidgets().some((widget) => widget.id === id)
    || ["colors", "fonts", "images", "styles"].some((key) =>
      (state.project[key] || []).some((item) => item.id === id));
}

function applySurfaceSettings() {
  const entry = activeSurfaceEntry();
  const errorNode = $("#surface-error");
  try {
    const layout = parseSurfaceObject($("#surface-layout-json"), t("validation.surface.fieldLayout"));
    const styleTree = parseSurfaceObject($("#surface-style-json"), t("validation.surface.fieldStyle"));
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
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.classList.remove("hidden");
  }
}

function bindSurfaceTools() {
  $("#surface-select").addEventListener("change", (event) => selectSurface(event.target.value));
  $("#add-page").addEventListener("click", addPage);
  $("#add-bottom-layer").addEventListener("click", () => addLayer("bottom"));
  $("#add-top-layer").addEventListener("click", () => addLayer("top"));
  $("#surface-up").addEventListener("click", () => moveActivePage(-1));
  $("#surface-down").addEventListener("click", () => moveActivePage(1));
  $("#delete-surface").addEventListener("click", deleteActiveSurface);
  $("#page-wrap").addEventListener("change", (event) => {
    pushUndo();
    state.project.page_wrap = event.target.checked;
    markProjectDirty();
    renderDesigner();
  });
  $("#surface-skip").addEventListener("change", (event) => {
    const entry = activeSurfaceEntry();
    if (entry.kind !== "page") return;
    pushUndo();
    entry.surface.skip = event.target.checked;
    markProjectDirty();
    renderDesigner();
  });
  $("#apply-surface").addEventListener("click", applySurfaceSettings);
}

function renderSurfaceToolbar() {
  const entries = surfaceEntries();
  const entry = activeSurfaceEntry();
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
  $("#surface-settings").classList.toggle("hidden", entry.kind === "root");
  $("#surface-id").value = entry.kind === "page" ? entry.surface.id : "";
  $("#surface-layout-json").value = JSON.stringify(entry.surface.layout || {}, null, 2);
  $("#surface-style-json").value = JSON.stringify(entry.surface.style_tree || {}, null, 2);
  $("#surface-extra-json").value = JSON.stringify(entry.surface.extra || {}, null, 2);
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
  renderDesignerStatus();
  updateUndoButtons();
}

function renderCanvas() {
  const canvas = $("#canvas");
  canvas.style.width = `${state.project.canvas.width}px`;
  canvas.style.height = `${state.project.canvas.height}px`;
  canvas.classList.toggle("lines-mode", state.canvasMode === "lines");
  canvas.classList.toggle("tool-select", state.lineTool === "select");
  $("#canvas-width").value = state.project.canvas.width;
  $("#canvas-height").value = state.project.canvas.height;

  // Order matters: background, then the glow-line overlay for lines with no
  // parent (a decorative layer that stays behind everything), then widgets,
  // then a second glow-line overlay for lines nested under a container (so
  // that container's own background can't paint over its own child line -
  // widgets are flat DOM siblings here, not actually nested, so a container's
  // "children" only render on top of it if something puts them there), then
  // the edit handles on top of everything so they stay grabbable.
  const glowCanvasBack = document.createElement("canvas");
  glowCanvasBack.id = "glow-canvas-back";
  glowCanvasBack.className = "glow-canvas";
  const glowCanvasFront = document.createElement("canvas");
  glowCanvasFront.id = "glow-canvas-front";
  glowCanvasFront.className = "glow-canvas";
  const handles = document.createElement("div");
  handles.id = "glow-handles";
  handles.className = "glow-handles";
  canvas.replaceChildren(renderCanvasBackground(), glowCanvasBack);
  canvasNodeByWidget.clear();
  visualWidgets().forEach((item) => {
    const node = renderWidget(item);
    canvasNodeByWidget.set(item.widget, node);
    canvas.append(node);
  });
  canvas.append(glowCanvasFront, handles);

  fontLibrary().forEach((font) => ensureFontLoaded(font.id));

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

async function loadBackgroundPreview(event) {
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
  $("#bake-line").addEventListener("click", bakeSelectedStroke);

  const canvas = $("#canvas");
  canvas.addEventListener("pointerdown", onGlowPointerDown);
  canvas.addEventListener("dblclick", onGlowDoubleClick);
  canvas.addEventListener("contextmenu", onGlowContextMenu);

  $$(".colorwheel-target .button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.colorWheelTarget = btn.dataset.wheelTarget;
      $$(".colorwheel-target .button").forEach((b) => b.classList.toggle("active", b === btn));
      renderColorWheelReadout();
    });
  });
  $("#color-wheel").addEventListener("pointerdown", (event) => {
    onColorWheelPick(event);
    const move = (moveEvent) => onColorWheelPick(moveEvent);
    const up = () => window.removeEventListener("pointermove", move);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  });
  $("#color-wheel-value").addEventListener("input", drawColorWheel);

  bindLinePropertyInputs();
}

function setCanvasMode(mode) {
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

function setLineTool(tool) {
  state.lineTool = tool;
  if (tool === "select") state.drawingStroke = null;
  $("#tool-select").classList.toggle("active", tool === "select");
  $("#tool-draw").classList.toggle("active", tool === "draw");
  $("#canvas").classList.toggle("tool-select", tool === "select");
  renderGlowHandles();
}

function uniqueStrokeId() {
  const ids = new Set((state.project.glow_strokes || []).map((s) => s.id));
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
    ? state.schemas.find((item) => item.type_key === state.selectedWidget.widget_type)
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
  stroke.points = [[40 + offset, 40 + offset], [120 + offset, 40 + offset]];
  state.project.glow_strokes.push(stroke);
  state.selectedStroke = stroke;
  markProjectDirty();
  setLineTool("select");
  renderDesigner();
}

function removeStroke(stroke) {
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
function canvasPointFromEvent(event) {
  const rect = $("#canvas").getBoundingClientRect();
  return [(event.clientX - rect.left) / state.zoom, (event.clientY - rect.top) / state.zoom];
}

/** Snap `point` to the nearest `step` angle around `origin`, same distance. */
function snapAngle(origin, point, step) {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) return point;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [origin[0] + Math.cos(angle) * distance, origin[1] + Math.sin(angle) * distance];
}

function onGlowPointerDown(event) {
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

function placeDrawPoint(rawPoint, event) {
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

function onGlowDoubleClick(event) {
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

function onGlowContextMenu(event) {
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
function findStrokeAt(point) {
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

function beginLineBodyDrag(event, stroke, startPoint) {
  pushUndo();
  const target = event.target;
  const originPoints = stroke.points.map((p) => [...p]);
  const handles = $("#glow-handles");
  handles.style.visibility = "hidden";
  target.setPointerCapture(event.pointerId);
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end, { once: true });
  function move(moveEvent) {
    const [x, y] = canvasPointFromEvent(moveEvent);
    const dx = x - startPoint[0];
    const dy = y - startPoint[1];
    stroke.points = originPoints.map(([px, py]) => [px + dx, py + dy]);
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

function beginPointDrag(event, stroke, index) {
  pushUndo();
  const handle = event.target;
  handle.setPointerCapture(event.pointerId);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end, { once: true });
  function move(moveEvent) {
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

function drawGlowFrame(phase) {
  const back = $("#glow-canvas-back");
  const front = $("#glow-canvas-front");
  if (!back || !front) return;
  const strokes = (state.project.glow_strokes || []).filter((stroke) => !stroke.hidden);
  const backStrokes = strokes.filter((stroke) => !stroke.parent_id);
  const frontStrokes = strokes.filter((stroke) => stroke.parent_id);
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
  stroke.points.forEach((point, index) => {
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
  const tick = (now) => {
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

  drawColorWheel();
  renderColorWheelReadout();
}

function bindLinePropertyInputs() {
  const num = (raw, fallback = 0) => (raw === "" ? fallback : Number(raw));
  const onText = (id, apply) => {
    const el = $(id);
    el.addEventListener("focus", pushUndo);
    el.addEventListener("input", () => {
      if (!state.selectedStroke) return;
      apply(state.selectedStroke, el);
      markProjectDirty();
      renderGlowCanvas();
    });
  };
  const onCheck = (id, apply) => {
    $(id).addEventListener("change", (event) => {
      if (!state.selectedStroke) return;
      pushUndo();
      apply(state.selectedStroke, event.target);
      markProjectDirty();
      renderGlowCanvas();
    });
  };
  const onSelect = (id, apply) => {
    $(id).addEventListener("change", (event) => {
      if (!state.selectedStroke) return;
      pushUndo();
      apply(state.selectedStroke, event.target.value);
      markProjectDirty();
      renderGlowCanvas();
    });
  };

  onText("#line-name", (s, el) => { s.name = el.value; });
  onText("#line-width", (s, el) => { s.width = Math.max(0.5, num(el.value, 1)); });
  onText("#line-corner-radius", (s, el) => { s.corner_radius = Math.max(0, num(el.value, 0)); });
  onSelect("#line-mode", (s, value) => { s.mode = value; });
  onCheck("#line-closed", (s, el) => { s.closed = el.checked; });

  onCheck("#glow-enabled", (s, el) => { s.glow.enabled = el.checked; });
  onText("#glow-radius", (s, el) => { s.glow.radius = Math.max(0, num(el.value)); });
  onText("#glow-intensity", (s, el) => { s.glow.intensity = clamp(num(el.value), 0, 1); });
  onCheck("#glow-use-line-color", (s, el) => { s.glow.use_line_color = el.checked; });

  onCheck("#flow-enabled", (s, el) => { s.flow.enabled = el.checked; });
  onSelect("#flow-mode", (s, value) => { s.flow.mode = value; });
  onCheck("#flow-reversed", (s, el) => { s.flow.reversed = el.checked; });
  onText("#flow-spacing", (s, el) => { s.flow.spacing = Math.max(1, num(el.value, 40)); });
  onText("#flow-size", (s, el) => { s.flow.size = Math.max(1, num(el.value, 14)); });
  onText("#flow-width", (s, el) => { s.flow.width = Math.max(0, num(el.value)); });
  onText("#flow-glow-radius", (s, el) => { s.flow.glow_radius = Math.max(0, num(el.value)); });
  onCheck("#flow-use-line-color", (s, el) => { s.flow.use_line_color = el.checked; });
}

function colorWheelTargetObject(stroke) {
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

function onColorWheelPick(event) {
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

function slugifyStrokeName(text, fallback) {
  let slug = String(text || "").trim().toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" }[c]))
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) slug = fallback;
  return slug;
}

/** The area a line's own stroke (core + glow, no markers) occupies. */
function strokeRenderBounds(stroke) {
  const { measure } = strokePath(stroke);
  const box = boundingBox(measure);
  const canvas = state.project.canvas;
  if (!box) return { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
  const margin = stroke.width / 2 + (stroke.glow.enabled ? stroke.glow.radius : 0) + 2;
  return {
    left: Math.max(0, box.left - margin),
    top: Math.max(0, box.top - margin),
    right: Math.min(canvas.width, box.right + margin),
    bottom: Math.min(canvas.height, box.bottom + margin),
  };
}

function renderStrokeFrame(doc, rect, { withLines, withFlow, phase }) {
  return new Promise((resolve, reject) => {
    const width = Math.max(1, Math.ceil(rect.right - rect.left));
    const height = Math.max(1, Math.ceil(rect.bottom - rect.top));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
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

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked to stay well under any engine's argument-count limit for
  // String.fromCharCode - fine for the small, cropped frames baked here.
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function uploadBakedFrame(name, blob) {
  const content_base64 = await blobToBase64(blob);
  const result = await api("designer/assets/images", {
    method: "POST", body: JSON.stringify({ name, content_base64 }),
  });
  return result.path;
}

function ensureImageEntry(id, filePath) {
  if (!Array.isArray(state.project.images)) state.project.images = [];
  let entry = state.project.images.find((img) => img.id === id);
  if (!entry) {
    entry = { id, file_path: filePath, resize: "", dither: "", transparency: "opaque",
             img_type: "", external: true, extra: {} };
    state.project.images.push(entry);
  } else {
    entry.file_path = filePath;
    entry.external = true;
  }
  return entry;
}

function uniqueWidgetId(base) {
  // reserved_ids are ids used by hardware entities elsewhere in an imported
  // source config (binary_sensor:, button:, ...) - never modeled here, but
  // sharing ESPHome's one flat id() namespace with everything this designer
  // does create, so a freshly auto-generated widget id must avoid them too.
  const ids = new Set([...allWidgets().map((widget) => widget.id), ...(state.project.reserved_ids || [])]);
  let n = 1;
  let candidate = `${base}_${n}`;
  while (ids.has(candidate)) { n += 1; candidate = `${base}_${n}`; }
  return candidate;
}

function strokeParentContainer(stroke) {
  if (!stroke.parent_id) return null;
  return allWidgets().find((widget) => widget.id === stroke.parent_id) || null;
}

function newImageWidget(id, rect, src) {
  return {
    id, widget_type: "image", name: "", x: Math.round(rect.left), y: Math.round(rect.top),
    width: Math.round(rect.right - rect.left), height: Math.round(rect.bottom - rect.top),
    align: "TOP_LEFT", align_to: "", hidden: false, locked: false,
    properties: { src, angle: 0, zoom: 1 },
    style_mode: "inline", style_refs: [], style_tree: {}, events: {}, children: [],
    tab_title: "", tile_row: 0, tile_col: 0, tile_dir: "ALL",
    layout: {}, grid_cell: {}, extra: {}, source: "editor", synthetic_id: false,
  };
}

function newAnimimgWidget(id, rect, frameIds, durationMs) {
  const widget = newImageWidget(id, rect, "");
  widget.widget_type = "animimg";
  widget.properties = {
    src: frameIds, duration: durationMs, repeat_count: "forever", auto_start: true,
  };
  return widget;
}

async function bakeSelectedStroke() {
  const stroke = state.selectedStroke;
  if (!stroke) return;
  if ((stroke.points || []).length < 2) {
    toast(t("toast.glow.noGeometry"), true);
    return;
  }
  if (!state.capabilities["designer.asset_write"]) {
    toast(t("toast.glow.noWritePermission"), true);
    return;
  }

  const frameCount = clamp(Number($("#bake-frame-count").value) || 6, 1, 60);
  const crop = $("#bake-crop").checked;
  const doc = { strokes: [stroke] };
  const staticRect = crop ? strokeRenderBounds(stroke)
    : { left: 0, top: 0, right: state.project.canvas.width, bottom: state.project.canvas.height };
  const baseName = slugifyStrokeName(stroke.name, stroke.id);
  const button = $("#bake-line");
  button.disabled = true;

  try {
    toast(t("toast.glow.generatingImages"));
    const staticBlob = await renderStrokeFrame(doc, staticRect,
      { withLines: true, withFlow: false, phase: 0 });
    const staticPath = await uploadBakedFrame(`${baseName}_static.png`, staticBlob);
    const staticImageId = `img_${baseName}_static`;
    ensureImageEntry(staticImageId, staticPath);

    let animimgWidget = null;
    if (stroke.flow.enabled) {
      const animRect = crop ? (flowBoundsDocument(doc) || staticRect) : staticRect;
      const frameIds = [];
      for (let i = 0; i < frameCount; i += 1) {
        const blob = await renderStrokeFrame(doc, animRect,
          { withLines: false, withFlow: true, phase: i / frameCount });
        const suffix = String(i).padStart(2, "0");
        const path = await uploadBakedFrame(`${baseName}_flow_${suffix}.png`, blob);
        const frameId = `img_${baseName}_flow_${suffix}`;
        ensureImageEntry(frameId, path);
        frameIds.push(frameId);
      }
      animimgWidget = newAnimimgWidget(
        uniqueWidgetId(`${baseName}_anim`), animRect, frameIds, frameCount * 300);
    }

    pushUndo();
    const imageWidget = newImageWidget(uniqueWidgetId(baseName), staticRect, staticImageId);
    const target = strokeParentContainer(stroke);
    if (target) {
      // The rect (and thus the widget's x/y from newImageWidget) is in
      // absolute canvas coordinates; a child's x/y is relative to its
      // parent's content box, so it needs converting before nesting it.
      const origin = contentOrigin(state.project, target);
      [imageWidget, animimgWidget].filter(Boolean).forEach((w) => {
        w.x = Math.round(w.x - origin.x);
        w.y = Math.round(w.y - origin.y);
      });
      target.children.push(imageWidget);
      if (animimgWidget) target.children.push(animimgWidget);
    } else {
      state.project.widgets.push(imageWidget);
      if (animimgWidget) state.project.widgets.push(animimgWidget);
    }
    markProjectDirty();
    renderDesigner();
    toast(t("toast.glow.baked", { widgets: 1 + (animimgWidget ? 1 : 0), images: 1 + frameCount }));
  } catch (error) {
    toast(t("toast.glow.bakeFailed", { error: error.message }), true);
  } finally {
    button.disabled = false;
  }
}

function renderWidget(item) {
  const { widget, left, top, width, height, managed } = item;
  const node = document.createElement("div");
  node.className = `canvas-widget${state.selectedWidget === widget ? " selected" : ""}`;
  node.dataset.type = widget.widget_type;
  if (managed) node.classList.add("managed");
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.width = `${Math.max(1, width)}px`;
  node.style.height = `${Math.max(1, height)}px`;
  node.style.opacity = widget.hidden ? "0" : "1";
  if (widget.locked) node.classList.add("locked");
  // The state selected in the property panel is also the state previewed on
  // the canvas. This is especially useful for a button's pressed/checked
  // colours: previously those values were editable but only visible after
  // opening the separate Viewer.
  const previewState = state.selectedWidget === widget ? state.activeState : "";
  const effectiveStyle = effectiveViewerStyle(state.project, widget, previewState);
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
  node.style.fontFamily = resolvedFontFamily(effectiveStyle.text_font || state.project.default_font);
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
    handle.addEventListener("pointerdown", (event) => beginResize(event, widget));
    node.append(handle);
  }
  return node;
}

function renderCanvasValueVisual(widget) {
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

function effectiveStyleTree(widget) {
  const theme = (state.project.theme || {})[widget.widget_type] || {};
  let ownTree;
  if (widget.style_mode !== "named") {
    ownTree = widget.style_tree || {};
  } else {
    ownTree = {};
    (widget.style_refs || []).forEach((ref) => {
      const entry = styleLibrary().find((item) => item.id === ref);
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

function beginDrag(event, widget, node, box) {
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
  const childStrokes = (state.project.glow_strokes || [])
    .filter((stroke) => stroke.parent_id === widget.id)
    .map((stroke) => ({ stroke, points: stroke.points.map((p) => [...p]) }));
  node.setPointerCapture(event.pointerId);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", end, { once: true });
  function move(moveEvent) {
    const deltaX = (moveEvent.clientX - origin.clientX) / state.zoom;
    const deltaY = (moveEvent.clientY - origin.clientY) / state.zoom;
    widget.x = clamp(Math.round(origin.x + deltaX), 0, state.project.canvas.width - box.width);
    widget.y = clamp(Math.round(origin.y + deltaY), 0, state.project.canvas.height - box.height);
    // Re-running the layout (rather than just offsetting this node) keeps any
    // children - and siblings anchored to this widget - moving along with it.
    syncCanvasLayout();
    if (childStrokes.length) {
      const totalDeltaX = widget.x - origin.x;
      const totalDeltaY = widget.y - origin.y;
      childStrokes.forEach(({ stroke, points }) => {
        stroke.points = points.map(([px, py]) => [px + totalDeltaX, py + totalDeltaY]);
      });
      renderGlowCanvas();
    }
    $("#prop-x").value = widget.x;
    $("#prop-y").value = widget.y;
    markProjectDirty();
  }
  function end() { node.removeEventListener("pointermove", move); }
}

function beginResize(event, widget) {
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
  function resize(moveEvent) {
    const deltaX = (moveEvent.clientX - origin.clientX) / state.zoom;
    const deltaY = (moveEvent.clientY - origin.clientY) / state.zoom;
    widget.width = clamp(Math.round(origin.width + deltaX), 8, 4096);
    widget.height = clamp(Math.round(origin.height + deltaY), 8, 4096);
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
  renderStateChoices();
  renderStyleControls(widget);
  renderDynamicProperties(widget);
  renderImageButtonSettings(widget);
  renderWidgetActions(widget);
  renderRuntimeBinding(widget);
  renderExtraKeys(widget);
}

const ACTION_TRIGGER_LABELS = {
  on_click: t("actions.trigger.click"),
  on_press: t("actions.trigger.press"),
  on_release: t("actions.trigger.release"),
  on_value: t("actions.trigger.valueShort"),
};

function directImageButtonParts(widget) {
  if (widget?.widget_type !== "button") return null;
  const image = (widget.children || []).find((child) => child.widget_type === "image");
  if (!image) return null;
  return {
    image,
    label: (widget.children || []).find((child) => child.widget_type === "label") || null,
  };
}

function imageUpdateDetails(action, imageId) {
  const conditional = generatedActionCondition(action);
  if (conditional) {
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

function eventImageSource(widget, trigger, imageId, condition = "always") {
  const raw = widget.events?.[trigger];
  const actions = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const action of actions) {
    const details = imageUpdateDetails(action, imageId);
    if (details?.condition === condition) return details.src;
  }
  return "";
}

function populateImageChoice(control, value) {
  control.replaceChildren(new Option(t("imgbtn.notSet"), ""));
  imageLibrary().forEach((entry) => control.append(new Option(entry.id, entry.id)));
  if (value && !imageEntry(value)) control.append(new Option(`${value} (fehlt)`, value));
  control.value = value || "";
}

function renderImageButtonSettings(widget) {
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

function actionUpdatesImage(action, imageId) {
  const conditional = generatedActionCondition(action);
  if (conditional) return actionUpdatesImage(conditional.action, imageId);
  const entry = actionObjectEntry(action);
  return entry?.[0] === "lvgl.image.update" && actionIdsForEditor(entry[1]).includes(imageId);
}

function removeGeneratedImageButtonActions(widget, imageId) {
  ["on_press", "on_release", "on_value"].forEach((trigger) => {
    const raw = widget.events?.[trigger];
    if (raw === undefined) return;
    const actions = (Array.isArray(raw) ? raw : [raw])
      .filter((action) => !actionUpdatesImage(action, imageId));
    if (actions.length) widget.events[trigger] = actions;
    else delete widget.events[trigger];
  });
}

function appendWidgetEvent(widget, trigger, action) {
  widget.events ||= {};
  if (!Array.isArray(widget.events[trigger])) {
    widget.events[trigger] = widget.events[trigger] === undefined ? [] : [widget.events[trigger]];
  }
  widget.events[trigger].push(action);
}

function imageUpdateAction(imageId, src) {
  return { "lvgl.image.update": { id: imageId, src } };
}

function conditionalImageUpdate(imageId, src, checked) {
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

function actionObjectEntry(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const entries = Object.entries(action);
  return entries.length === 1 ? entries[0] : null;
}

function actionIdsForEditor(payload) {
  if (typeof payload === "string") return [payload];
  if (Array.isArray(payload)) return payload.flatMap(actionIdsForEditor);
  if (payload && typeof payload === "object") return actionIdsForEditor(payload.id);
  return [];
}

function generatedActionCondition(action) {
  const entry = actionObjectEntry(action);
  if (entry?.[0] !== "if" || !entry[1] || typeof entry[1] !== "object") return null;
  const expression = String(entry[1].condition?.lambda || "").replace(/\s+/g, "").toLowerCase();
  const branch = Array.isArray(entry[1].then) && entry[1].then.length === 1 ? entry[1].then[0] : null;
  if (!branch || !["returnx;", "return!x;"].includes(expression)) return null;
  return { condition: expression === "returnx;" ? "checked" : "unchecked", action: branch };
}

function describeWidgetAction(action) {
  const conditional = generatedActionCondition(action);
  if (conditional) {
    const prefix = conditional.condition === "checked" ? t("action.desc.whenChecked") : t("action.desc.whenUnchecked");
    const inner = describeWidgetAction(conditional.action);
    return { ...inner, text: `${prefix}${inner.text}` };
  }
  const entry = actionObjectEntry(action);
  if (!entry) return { text: t("action.desc.unsupported"), targetIds: [], supported: false };
  const [name, payload] = entry;
  const targetIds = actionIdsForEditor(payload);
  if (["lvgl.widget.show", "lvgl.widget.hide"].includes(name)) {
    return {
      text: `${name.endsWith(".show") ? t("action.desc.show") : t("action.desc.hide")}: ${targetIds.join(", ") || t("action.desc.noTarget")}`,
      targetIds,
      supported: Boolean(targetIds.length),
    };
  }
  if (name === "lvgl.page.show") {
    return { text: `${t("action.desc.openPage")}${targetIds.join(", ") || t("action.desc.noTarget")}`, targetIds: [], supported: Boolean(targetIds.length) };
  }
  if (["lvgl.widget.update", "lvgl.label.update", "lvgl.button.update", "lvgl.image.update"].includes(name)
      && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const fields = Object.keys(payload).filter((key) => key !== "id");
    return {
      text: `${t("action.desc.change")}${targetIds.join(", ") || t("action.desc.noTarget")}${fields.length ? ` · ${fields.join(", ")}` : ""}`,
      targetIds,
      supported: Boolean(targetIds.length && fields.length),
    };
  }
  return { text: t("action.desc.yamlOnly", { name }), targetIds, supported: false };
}

function renderWidgetActions(widget) {
  const section = $("#widget-actions-section");
  const visible = widget?.widget_type === "button";
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
      const description = describeWidgetAction(action);
      const missing = description.targetIds.filter((id) => !projectWidgetEntries().some((item) => item.id === id));
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

function renderWidgetActionBuilder(widget) {
  if (!widget || widget.widget_type !== "button") return;
  const trigger = $("#widget-action-trigger").value;
  const type = $("#widget-action-type").value;
  const conditionField = $("#widget-action-condition-field");
  conditionField.classList.toggle("hidden", trigger !== "on_value");
  if (trigger !== "on_value") $("#widget-action-condition").value = "always";

  const target = $("#widget-action-target");
  const previous = target.value;
  const choices = type === "page_show"
    ? (state.project.pages || []).map((page) => ({ value: page.id, label: `${page.id} · Seite` }))
    : projectWidgetEntries().map((item) => ({ value: item.id, label: `${item.id} · ${item.widget_type}` }));
  target.replaceChildren();
  choices.forEach((choice) => target.append(new Option(choice.label, choice.value)));
  if (choices.some((choice) => choice.value === previous)) target.value = previous;

  const update = type === "update";
  $("#widget-action-update-fields").classList.toggle("hidden", !update);
  const targetWidget = projectWidgetEntries().find((item) => item.id === target.value);
  $("#widget-action-text-field").classList.toggle(
    "hidden", !update || !["label", "button"].includes(targetWidget?.widget_type),
  );
  $("#widget-action-image-field").classList.toggle(
    "hidden", !update || targetWidget?.widget_type !== "image",
  );
  populateImageChoice($("#widget-action-image"), "");
  $("#widget-action-error").classList.add("hidden");
}

function normaliseActionColor(value) {
  const raw = String(value || "").trim();
  const hex = raw.replace(/^#/, "").replace(/^0x/i, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? `0x${hex.toUpperCase()}` : raw;
}

function addWidgetAction() {
  const widget = state.selectedWidget;
  if (!widget || widget.widget_type !== "button") return;
  const trigger = $("#widget-action-trigger").value;
  const type = $("#widget-action-type").value;
  const targetId = $("#widget-action-target").value;
  const error = $("#widget-action-error");
  const fail = (message) => {
    error.textContent = message;
    error.classList.remove("hidden");
  };
  if (!targetId) {
    fail(type === "page_show" ? t("validation.action.noPage") : t("validation.action.noTargetWidget"));
    return;
  }
  if (trigger === "on_value" && !widget.properties?.checkable) {
    fail(t("validation.action.needsCheckable"));
    return;
  }

  let action;
  if (type === "show" || type === "hide") {
    action = { [`lvgl.widget.${type}`]: targetId };
  } else if (type === "page_show") {
    action = { "lvgl.page.show": targetId };
  } else {
    const targetWidget = projectWidgetEntries().find((item) => item.id === targetId);
    const payload = { id: targetId };
    const text = $("#widget-action-text").value.trim();
    if (text && ["label", "button"].includes(targetWidget?.widget_type)) payload.text = text;
    const imageSource = $("#widget-action-image").value;
    if (imageSource && targetWidget?.widget_type === "image") payload.src = imageSource;
    const styleControls = {
      bg_color: "#widget-action-bg-color",
      text_color: "#widget-action-text-color",
      border_color: "#widget-action-border-color",
      opa: "#widget-action-opacity",
    };
    Object.entries(styleControls).forEach(([key, selector]) => {
      const value = $(selector).value.trim();
      if (value) payload[key] = key.endsWith("_color") ? normaliseActionColor(value) : value;
    });
    if (Object.keys(payload).length === 1) {
      fail(t("validation.action.needsAtLeastOneField"));
      return;
    }
    const actionName = targetWidget?.widget_type === "label"
      ? "lvgl.label.update"
      : targetWidget?.widget_type === "button" ? "lvgl.button.update"
        : targetWidget?.widget_type === "image" ? "lvgl.image.update" : "lvgl.widget.update";
    action = { [actionName]: payload };
  }

  const condition = $("#widget-action-condition").value;
  if (trigger === "on_value" && condition !== "always") {
    action = {
      if: {
        condition: { lambda: condition === "checked" ? "return x;" : "return !x;" },
        then: [action],
      },
    };
  }

  pushUndo();
  widget.events ||= {};
  if (!Array.isArray(widget.events[trigger])) {
    widget.events[trigger] = widget.events[trigger] === undefined ? [] : [widget.events[trigger]];
  }
  widget.events[trigger].push(action);
  markProjectDirty();
  error.classList.add("hidden");
  ["#widget-action-text", "#widget-action-bg-color", "#widget-action-text-color",
    "#widget-action-border-color", "#widget-action-opacity", "#widget-action-image"]
    .forEach((selector) => { $(selector).value = ""; });
  syncLinkedColorPickers();
  renderWidgetActions(widget);
}

function removeWidgetAction(widget, trigger, index) {
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

function runtimeTargets(widget) {
  if (!widget) return [];
  if (widget.widget_type === "label") return [{ value: "text", label: "Label-Text" }];
  if (["slider", "bar", "arc"].includes(widget.widget_type)) {
    return [{ value: "value", label: `${widget.widget_type === "slider" ? "Slider" : widget.widget_type === "bar" ? "Bar" : "Arc"}-Wert` }];
  }
  if (widget.widget_type === "switch") return [{ value: "state_checked", label: "Switch-Zustand" }];
  return [];
}

function projectWidgetEntries() {
  const result = [];
  const visit = (nodes) => (nodes || []).forEach((widget) => {
    result.push(widget);
    visit(widget.children);
  });
  visit(state.project.widgets);
  (state.project.pages || []).forEach((page) => visit(page.widgets));
  visit(state.project.top_layer?.widgets);
  visit(state.project.bottom_layer?.widgets);
  return result;
}

function bindingIsOrphan(binding) {
  const widget = projectWidgetEntries().find((item) => item.id === binding.widget_id);
  return !widget || !runtimeTargets(widget).some((target) => target.value === binding.target);
}

function renderRuntimeBindingOrphans() {
  const section = $("#runtime-binding-orphans");
  const orphans = state.viewerBindings.filter(bindingIsOrphan);
  section.classList.toggle("hidden", !orphans.length);
  const list = $("#runtime-binding-orphan-list");
  list.replaceChildren();
  orphans.forEach((binding) => {
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

function runtimeStateFor(device, entityId) {
  return (device?.states || []).find((item) => item.entity_id === entityId) || null;
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

function renderRuntimeBinding(widget) {
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
    (item) => item.widget_id === widget.id && item.target === target,
  );

  const deviceControl = $("#runtime-binding-device");
  deviceControl.replaceChildren(new Option(t("binding.devicePlaceholder"), ""));
  (state.viewerRuntimeSources.devices || []).forEach((device) => {
    const suffix = device.status === "ready" ? t("binding.deviceConnectedSuffix") : " · " + (DEVICE_STATUS[device.status] || device.status);
    deviceControl.append(new Option(device.name + suffix, device.id));
  });
  if (binding?.device_id && !(state.viewerRuntimeSources.devices || []).some(
    (device) => device.id === binding.device_id,
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
  const device = (state.viewerRuntimeSources.devices || []).find((item) => item.id === deviceId);
  const control = $("#runtime-binding-entity");
  const target = $("#runtime-binding-target").value;
  const current = selectedEntity || control.value;
  control.replaceChildren(new Option(t("binding.entityPlaceholder"), ""));
  const matching = [...(device?.entities || [])].filter((entity) => (
    entityMatchesRuntimeTarget(entity, target, runtimeStateFor(device, entity.entity_id))
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
    const exists = (device?.entities || []).some((entity) => entity.entity_id === current);
    control.append(new Option(
      current + (exists ? t("binding.entityMismatchSuffix") : t("binding.entityUnavailableSuffix")),
      current,
    ));
  }
  control.value = current || "";
}

function renderAdditionalRuntimeWidgets(widget, target) {
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
    const entity = (health.device.entities || []).find((item) => item.entity_id === binding.entity_id);
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

async function persistRuntimeBindings(bindings) {
  const cleaned = bindings.filter((binding) => !bindingIsOrphan(binding));
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
  } catch (error) {
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
  const next = state.viewerBindings.filter(
    (binding) => !(widgetIds.includes(binding.widget_id) && binding.target === target),
  );
  widgetIds.forEach((widgetId) => next.push(bindingFromControls(widgetId)));
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
  const next = state.viewerBindings.filter(
    (binding) => !(binding.widget_id === widget.id && binding.target === target),
  );
  if (await persistRuntimeBindings(next)) toast(t("toast.binding.removed"));
}

function copyRuntimeBinding() {
  const widget = state.selectedWidget;
  if (!widget) return;
  const binding = state.viewerBindings.find((item) => (
    item.widget_id === widget.id && item.target === $("#runtime-binding-target").value
  ));
  if (!binding) return;
  state.copiedRuntimeBinding = { ...binding };
  $("#paste-runtime-binding").disabled = false;
  toast(t("toast.binding.copied"));
}

function pasteRuntimeBinding() {
  const widget = state.selectedWidget;
  const copied = state.copiedRuntimeBinding;
  if (!widget || !copied || !runtimeTargets(widget).some((target) => target.value === copied.target)) {
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
  const valid = state.viewerBindings.filter((binding) => !bindingIsOrphan(binding));
  const removed = state.viewerBindings.length - valid.length;
  if (!removed) return;
  if (await persistRuntimeBindings(valid)) toast(t("toast.binding.cleanedOrphans", { count: removed }));
}

function setCanvasRuntimeText(node, text) {
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
  state.viewerBindings.forEach((binding) => {
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
        if (["bar", "arc"].includes(widget.widget_type)) {
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

function toggleWidgetFlag(flag) {
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

function normaliseLibraryHex(value) {
  const raw = String(value || "").trim().replace(/^#/, "").replace(/^0x/i, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return raw.split("").map((character) => character + character).join("").toUpperCase();
  }
  return /^[0-9a-f]{6}$/i.test(raw) ? raw.toUpperCase() : null;
}

function colorReferenceLocations(id, replacement = null) {
  const matches = [];
  const visit = (value, path, key = "", parent = null) => {
    if (typeof value === "string") {
      if (/color$/i.test(key) && value === id) {
        matches.push(path);
        if (replacement !== null) parent[key] = replacement;
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.entries(value).forEach(([childKey, child]) => {
      visit(child, path ? `${path}.${childKey}` : childKey, childKey, value);
    });
  };
  Object.entries(state.project).forEach(([key, value]) => {
    if (key !== "colors") visit(value, key);
  });
  return matches;
}

function projectIdIsUsed(id, ignoredColorId = null) {
  if (projectWidgetEntries().some((entry) => entry.id === id)) return true;
  if ((state.project.pages || []).some((page) => page.id === id)) return true;
  const libraries = [state.project.styles, state.project.fonts, state.project.images];
  if (libraries.some((entries) => (entries || []).some((entry) => entry.id === id))) return true;
  // Ids used by hardware entities elsewhere in an imported source config
  // (binary_sensor:, button:, ...) share ESPHome's one flat id() namespace
  // with everything editable here, even though this designer never models
  // those entities itself.
  if ((state.project.reserved_ids || []).includes(id)) return true;
  return colorLibrary().some((entry) => entry.id === id && entry.id !== ignoredColorId);
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

function editColorLibraryEntry(id) {
  const entry = colorLibrary().find((item) => item.id === id);
  if (!entry) return;
  state.editingColorId = id;
  $("#color-library-id").value = entry.id;
  $("#color-library-hex").value = normaliseLibraryHex(entry.hex) || "FFFFFF";
  $("#color-library-picker").value = `#${normaliseLibraryHex(entry.hex) || "FFFFFF"}`;
  $("#color-library-error").classList.add("hidden");
  $("#save-color-library-entry").textContent = t("colorlib.form.save");
  $("#cancel-color-library-edit").classList.remove("hidden");
  $("#color-library-id").focus();
}

function saveColorLibraryEntry(event) {
  event.preventDefault();
  const id = $("#color-library-id").value.trim();
  const hex = normaliseLibraryHex($("#color-library-hex").value);
  const error = $("#color-library-error");
  const fail = (message) => {
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
    const entry = colorLibrary().find((item) => item.id === state.editingColorId);
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

function deleteColorLibraryEntry(id) {
  const entry = colorLibrary().find((item) => item.id === id);
  if (!entry) return;
  const references = colorReferenceLocations(id);
  if (references.length && !confirm(
    t("confirm.color.deleteWithRefs", { id, count: references.length, hex: entry.hex }),
  )) return;
  pushUndo();
  if (references.length) colorReferenceLocations(id, normaliseLibraryHex(entry.hex) || entry.hex);
  state.project.colors = colorLibrary().filter((item) => item !== entry);
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
  colorLibrary().forEach((entry) => {
    const hex = normaliseLibraryHex(entry.hex) || "FFFFFF";
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
  colorLibrary().forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.label = `#${normaliseLibraryHex(entry.hex) || entry.hex}`;
    options.append(option);
  });
  $("#color-library-export-hint").classList.toggle(
    "hidden", (state.project.export_sections || []).includes("color"),
  );
  if (state.editingColorId && !colorLibrary().some((entry) => entry.id === state.editingColorId)) {
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
  $("#color-library-picker").addEventListener("input", (event) => {
    $("#color-library-hex").value = event.target.value.slice(1).toUpperCase();
  });
  $("#color-library-hex").addEventListener("input", (event) => {
    const hex = normaliseLibraryHex(event.target.value);
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
// locally-pinned copy from here.
const MDI_WEBFONT_URL =
  "https://github.com/Templarian/MaterialDesign-Webfont/raw/master/fonts/materialdesignicons-webfont.ttf";
const MDI_WEBFONT_DEFAULT_ID = "icons_mdi";

function isMdiWebfontUrl(url) {
  return /materialdesignicons-webfont\.ttf(\?.*)?$/i.test(String(url || "").trim());
}

// --- Font library -------------------------------------------------------
//
// Mirrors the color library: a project-wide, id-addressable library that
// `text_font`/`default_font` fields reference by id (or, for a builtin LVGL
// font, by typing its name directly - hence the datalist rather than a
// strict picker in appendPropertyControl). Unlike a color, a font id has no
// literal-value fallback to substitute on delete, so a deleted font's
// references are cleared instead of replaced.

function fontReferenceLocations(id, replacement = null) {
  const matches = [];
  if (state.project.default_font === id) {
    matches.push("default_font");
    if (replacement !== null) state.project.default_font = replacement;
  }
  const visit = (value, path, key = "", parent = null) => {
    if (typeof value === "string") {
      if (/font$/i.test(key) && value === id) {
        matches.push(path);
        if (replacement !== null) parent[key] = replacement;
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.entries(value).forEach(([childKey, child]) => {
      visit(child, path ? `${path}.${childKey}` : childKey, childKey, value);
    });
  };
  Object.entries(state.project).forEach(([key, value]) => {
    if (key !== "fonts" && key !== "default_font") visit(value, key);
  });
  return matches;
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
function setGfontsFamilyInput(family) {
  const select = $("#font-library-gfonts-family");
  const known = GOOGLE_FONTS.includes(family);
  select.value = known ? family : GOOGLE_FONTS_CUSTOM;
  $("#font-library-gfonts-custom").value = known ? "" : family;
}

// Update metadata belongs to the editor project, not to ESPHome's `font:`
// schema. `import_source` is persisted with a project but never exported, so
// the shared/read-only designer core needs no private model fields.
function fontSourceMetadataMap(create = false) {
  if (!state.project.import_source || typeof state.project.import_source !== "object") {
    if (!create) return {};
    state.project.import_source = {};
  }
  if (!state.project.import_source.font_sources || typeof state.project.import_source.font_sources !== "object") {
    if (!create) return {};
    state.project.import_source.font_sources = {};
  }
  return state.project.import_source.font_sources;
}

function fontSourceMetadata(entry) {
  return fontSourceMetadataMap()[entry?.id] || null;
}

function isManagedWebFont(entry) {
  return Boolean(fontSourceMetadata(entry)?.url);
}

function webFontUrl(entry) {
  return fontSourceMetadata(entry)?.url || entry?.web_url || "";
}

const mdiByName = new Map(MDI_GLYPHS.map((entry) => [entry.name.toLowerCase(), entry]));
let glyphPreviewRequest = 0;
let glyphPreviewState = { status: "idle", family: "inherit" };
// The widget/control an open icon dialog inserts into - null while closed.
let activeIconTarget = null;

function glyphCodepoint(glyph) {
  return String(glyph || "").codePointAt(0);
}

function formatGlyphCodepoint(glyphOrCodepoint) {
  const value = typeof glyphOrCodepoint === "number" ? glyphOrCodepoint : glyphCodepoint(glyphOrCodepoint);
  return Number.isInteger(value) ? `U+${value.toString(16).toUpperCase().padStart(4, "0")}` : "—";
}

function uniqueGlyphs(values) {
  const result = [];
  const seen = new Set();
  values.flatMap((value) => Array.from(String(value || ""))).forEach((glyph) => {
    const codepoint = glyphCodepoint(glyph);
    if (codepoint === undefined || seen.has(codepoint)) return;
    seen.add(codepoint);
    result.push(glyph);
  });
  return result;
}

/** This dialog only ever inserts into the MDI icon webfont, so "mdi:home"
 * name resolution is always on here (unlike the old per-font-editing dialog,
 * where the same lookup had to be disabled for non-icon fonts). */
function parseGlyphInput(value) {
  const input = String(value || "").trim();
  if (!input) return [];
  const tokens = input.split(/[\s,;]+/).filter(Boolean);
  const glyphs = [];
  tokens.forEach((rawToken) => {
    const token = rawToken.replace(/^["']|["']$/g, "");
    const mdi = mdiByName.get(token.toLowerCase());
    if (mdi) {
      glyphs.push(mdi.glyph);
      return;
    }
    const codeMatch = token.match(/^(?:U\+|0x|\\U|\\u\{?)([0-9A-Fa-f]{4,8})\}?$/i);
    if (codeMatch) {
      const codepoint = Number.parseInt(codeMatch[1], 16);
      if (codepoint > 0x10FFFF || (codepoint >= 0xD800 && codepoint <= 0xDFFF)) {
        throw new Error(t("validation.glyph.invalidCodepoint", { token }));
      }
      glyphs.push(String.fromCodePoint(codepoint));
      return;
    }
    if (/^mdi:/i.test(token)) throw new Error(t("validation.glyph.notInCatalog", { token }));
    glyphs.push(...Array.from(token));
  });
  return uniqueGlyphs(glyphs);
}

function glyphPreviewPlaceholder() {
  return glyphPreviewState.status === "loading" ? "…" : "?";
}

function updateGlyphPreviewStatus(message, status) {
  const node = $("#glyph-preview-status");
  node.textContent = message;
  node.classList.toggle("ready", status === "loaded");
  node.classList.toggle("error", status === "failed");
}

/** Loads the MDI webfont once (from its pinned local revision if the
 * library already has it, else straight from the upstream URL) so the
 * catalog can show the real glyph shapes instead of placeholder boxes. */
async function ensureMdiPreviewFont() {
  if (glyphPreviewState.status === "loaded") return;
  const request = ++glyphPreviewRequest;
  const mdiFont = fontLibrary().find((entry) => isMdiWebfontUrl(webFontUrl(entry)));
  const source = mdiFont?.file_path || MDI_WEBFONT_URL;
  glyphPreviewState = { status: "loading", family: "inherit" };
  updateGlyphPreviewStatus("Vorschaufont wird geladen …", "loading");
  renderIconCatalog();
  try {
    const cssSource = `url(${JSON.stringify(assetUrl(source))})`;
    const loaded = await new FontFace("esphome_mdi_preview", cssSource).load();
    if (request !== glyphPreviewRequest) return;
    document.fonts.add(loaded);
    glyphPreviewState = { status: "loaded", family: "esphome_mdi_preview" };
    updateGlyphPreviewStatus("Vorschaufont geladen.", "loaded");
  } catch (error) {
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
 * `text` property). Insertion both writes the glyph into that control and,
 * on first use, wires up the MDI font as the widget's text_font - an icon
 * glyph is meaningless without the font that actually contains it. */
function openIconInsertDialog(widget, control) {
  activeIconTarget = { widget, control };
  pushUndo();
  $("#glyph-input").value = "";
  $("#glyph-search").value = "";
  $("#glyph-input-error").classList.add("hidden");
  $("#glyph-catalog-version").textContent = `Lokaler MDI-Katalog ${MDI_CATALOG_VERSION}`;
  renderIconCatalog();
  $("#glyph-dialog").showModal();
  ensureMdiPreviewFont();
}

async function insertMdiGlyphs(glyphs) {
  if (!activeIconTarget) return;
  const { widget } = activeIconTarget;
  let mdiFont = fontLibrary().find((entry) => isMdiWebfontUrl(webFontUrl(entry)));
  if (!mdiFont) {
    // First use in this project: register the MDI font automatically so the
    // inserted glyph actually renders on the real device, not just here.
    await addMdiIconFont();
    mdiFont = fontLibrary().find((entry) => isMdiWebfontUrl(webFontUrl(entry)));
  }
  // addMdiIconFont() may have re-rendered the properties panel (new font
  // registered), which replaces property controls - re-resolve by id so
  // later inserts keep landing in the control the user is actually looking at.
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
  } catch (problem) {
    error.textContent = problem.message;
    error.classList.remove("hidden");
  }
}

function bindGlyphEditor() {
  $("#close-glyph-dialog").addEventListener("click", () => $("#glyph-dialog").close());
  $("#finish-glyph-dialog").addEventListener("click", () => $("#glyph-dialog").close());
  $("#add-glyph-input").addEventListener("click", addGlyphInput);
  $("#glyph-input").addEventListener("keydown", (event) => {
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

function editFontLibraryEntry(id) {
  const entry = fontLibrary().find((item) => item.id === id);
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

function saveFontLibraryEntry(event) {
  event.preventDefault();
  const id = $("#font-library-id").value.trim();
  const source = $("#font-library-source").value;
  const error = $("#font-library-error");
  const fail = (message) => {
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

  pushUndo();
  let entry;
  const previousId = state.editingFontId || id;
  const previousMeta = fontSourceMetadataMap()[previousId] || null;
  const previousWebUrl = previousMeta?.url || "";
  if (state.editingFontId) {
    entry = fontLibrary().find((item) => item.id === state.editingFontId);
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

function deleteFontLibraryEntry(id) {
  const entry = fontLibrary().find((item) => item.id === id);
  if (!entry) return;
  const references = fontReferenceLocations(id);
  if (references.length && !confirm(
    t("confirm.font.deleteWithRefs", { id, count: references.length }),
  )) return;
  pushUndo();
  if (references.length) fontReferenceLocations(id, "");
  state.project.fonts = fontLibrary().filter((item) => item !== entry);
  delete fontSourceMetadataMap(true)[id];
  fontLoadState.delete(id);
  if (state.editingFontId === id) resetFontLibraryForm();
  markProjectDirty();
  renderDesigner();
  toast(references.length
    ? t("toast.font.deletedWithRefs", { id, count: references.length })
    : t("toast.font.deleted", { id }));
}

const FONT_SOURCE_LABELS = {
  builtin: t("fontlib.source.builtin"),
  gfonts: t("fontlib.source.gfonts"),
  file: t("fontlib.source.file"),
  web: t("fontlib.source.web"),
};
const fontSourceStatuses = new Map();

function fontSourceStatus(entry) {
  const status = fontSourceStatuses.get(entry.id);
  if (status?.url === webFontUrl(entry)) return status;
  if (status) fontSourceStatuses.delete(entry.id);
  return isManagedWebFont(entry)
    ? { state: "managed", label: t("fontlib.status.managed") }
    : { state: "unmanaged", label: t("fontlib.status.unmanaged") };
}

async function checkFontSource(entry, manual = false) {
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
  } catch (error) {
    fontSourceStatuses.set(entry.id, { state: "error", label: t("fontlib.status.checkFailed"), url: webFontUrl(entry) });
    if (manual) toast(t("toast.font.checkFailed", { error: error.message }), true);
  }
  renderFontLibrary();
}

async function updateFontSource(entry) {
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
      } catch (coverageError) {
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
  } catch (error) {
    fontSourceStatuses.set(entry.id, { state: "error", label: t("fontlib.status.updateFailed"), url: webFontUrl(entry) });
    renderFontLibrary();
    toast(t("toast.font.updateFailed", { error: error.message }), true);
  }
}

function renderFontLibrary() {
  const list = $("#font-library-list");
  list.replaceChildren();
  fontLibrary().forEach((entry) => {
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
  fontLibrary().forEach((entry) => defaultSelect.append(new Option(entry.id, entry.id)));
  if (currentDefault && !fontLibrary().some((entry) => entry.id === currentDefault)) {
    defaultSelect.append(new Option(t("fontlib.unknownFontSuffix", { id: currentDefault }), currentDefault));
  }
  defaultSelect.value = currentDefault;

  const options = $("#project-font-options");
  options.replaceChildren();
  fontLibrary().forEach((entry) => options.append(new Option(entry.id)));

  $("#font-library-export-hint").classList.toggle(
    "hidden", (state.project.export_sections || []).includes("font"),
  );
  if (state.editingFontId && !fontLibrary().some((entry) => entry.id === state.editingFontId)) {
    resetFontLibraryForm();
  }
}

async function uploadFontFile(file) {
  const content_base64 = await blobToBase64(file);
  const result = await api("designer/assets/fonts", {
    method: "POST", body: JSON.stringify({ name: file.name, content_base64 }),
  });
  return result.path;
}

/** One-click preset: adds the MDI icon webfont as a normal Font Library
 * entry (source_kind "web", refresh "never") and, where write access is
 * available, immediately pins a local revision the same way the manual
 * "Update"/"Lokal" button does - so the result is a font that's fixed in
 * the library from the start, not just a URL the user still has to fetch
 * themselves. */
async function addMdiIconFont() {
  const existing = fontLibrary().find((entry) => isMdiWebfontUrl(webFontUrl(entry)));
  if (existing) {
    editFontLibraryEntry(existing.id);
    toast(t("toast.font.mdiAlreadyUsed", { id: existing.id }));
    return;
  }
  let id = MDI_WEBFONT_DEFAULT_ID;
  let suffix = 2;
  while (projectIdIsUsed(id)) id = `${MDI_WEBFONT_DEFAULT_ID}_${suffix++}`;

  pushUndo();
  const entry = {
    id, external: false,
    source_kind: "web", builtin_name: "", gfonts_family: "", gfonts_weight: 400, gfonts_italic: false,
    file_path: "", web_url: MDI_WEBFONT_URL,
    extra: { file: { type: "web", url: MDI_WEBFONT_URL, refresh: "never" } },
    size: 24, bpp: 4, glyphs: [],
  };
  fontLibrary().push(entry);
  markProjectDirty();
  renderDesigner();

  if (!state.capabilities["designer.asset_write"]) {
    toast(t("toast.font.mdiCreatedNoWrite", { id }), true);
    return;
  }
  toast(t("toast.font.mdiPinning", { id }));
  await updateFontSource(entry);
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
    } catch (error) {
      toast(t("toast.font.uploadFailed", { error: error.message }), true);
    } finally {
      $("#font-library-file-input").value = "";
    }
  });
  $("#default-font").addEventListener("change", (event) => {
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

function renderStyleControls(widget) {
  const mode = widget.style_mode === "named" ? "named" : "inline";
  $("#style-mode").value = mode;

  const select = $("#style-ref");
  select.replaceChildren(new Option("— keiner —", ""));
  styleLibrary().forEach((entry) => select.append(new Option(entry.id, entry.id)));
  const current = (widget.style_refs || [])[0] || "";
  if (current && !styleLibrary().some((entry) => entry.id === current)) {
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
  if (styleLibrary().some((entry) => entry.id === name)) {
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

function renderDynamicProperties(widget) {
  const container = $("#dynamic-properties");
  container.replaceChildren();
  const schema = state.schemas.find((item) => item.type_key === widget.widget_type);
  if (!schema) return;
  // Layout and grid placement have their own sections in the markup, so the
  // panel can read top-down: what it is, where it sits, then how it looks.
  const inline = schema.properties.filter(
    (property) => property.category === "content" || property.category === "style");

  let previousSection = "";
  inline.forEach((property, index) => {
    const section = property.category === "content"
      ? "Inhalt"
      : `Stil · ${property.part}${state.activeState ? ` · ${state.activeState}` : ""}`;
    if (section !== previousSection) {
      const heading = document.createElement("div");
      heading.className = "property-section";
      heading.textContent = section;
      container.append(heading);
      previousSection = section;
    }
    container.append(propertyField(widget, property, index));
  });
}

function renderLayoutSection(widget) {
  const schema = state.schemas.find((item) => item.type_key === widget.widget_type);
  const properties = (schema?.properties || []).filter((p) => p.category === "layout");
  $("#layout-section").classList.toggle("hidden", !properties.length);
  if (!properties.length) return;

  const container = $("#layout-properties");
  container.replaceChildren();
  const type = String((widget.layout || {}).type || "NONE").toUpperCase();
  properties.forEach((property, index) => {
    // Flex and grid options are mutually exclusive; showing both at once
    // invites setting grid tracks on a flex container.
    if (property.key.startsWith("flex_") && type !== "FLEX") return;
    if (property.key.startsWith("grid_") && type !== "GRID") return;
    container.append(propertyField(widget, property, `lay-${index}`));
  });
}

function propertyField(widget, property, index, targetKind) {
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
// dither/transparency aren't editable either), so this rides along with
// whatever control already lets you pick the image itself.
const IMAGE_TYPE_OPTIONS = [
  ["", "— Standard —"],
  ["BINARY", "BINARY"],
  ["TRANSPARENT_BINARY", "TRANSPARENT_BINARY"],
  ["GRAYSCALE", "GRAYSCALE"],
  ["RGB565", "RGB565"],
  ["RGB", "RGB"],
  ["RGBA", "RGBA"],
];

function appendPropertyControl(label, control, property, widget) {
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

function propertyTarget(widget, property, create, kind = property.category) {
  if (kind === "content") return widget.properties;
  if (kind === "layout") {
    if (!widget.layout && create) widget.layout = {};
    return widget.layout;
  }
  if (kind === "grid_cell") {
    if (!widget.grid_cell && create) widget.grid_cell = {};
    return widget.grid_cell;
  }
  // Style: a selected state routes into style_tree.states[<state>], which is
  // where the exporter expects per-state overrides to live.
  let root = widget.style_tree;
  if (state.activeState) {
    if (!root.states && create) root.states = {};
    if (!root.states?.[state.activeState] && create) root.states[state.activeState] = {};
    root = root.states?.[state.activeState];
  }
  if (!root) return undefined;
  if (property.part === "main") return root;
  if (!root[property.part] && create) root[property.part] = {};
  return root[property.part];
}

function renderStateChoices() {
  const select = $("#style-state");
  select.replaceChildren(new Option("Normal", ""));
  const labels = {
    checked: t("properties.state.checked"),
    pressed: t("properties.state.pressed"),
    disabled: t("properties.state.disabled"),
    focused: t("properties.state.focused"),
    edited: t("properties.state.edited"),
    scrolled: t("properties.state.scrolled"),
  };
  state.states.forEach((name) => select.append(new Option(labels[name] || name, name)));
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
  const typeSelect = $("#theme-type");
  typeSelect.replaceChildren();
  state.schemas.forEach((schema) => typeSelect.append(new Option(schema.label, schema.type_key)));
  if (!state.themeType && state.schemas.length) state.themeType = state.schemas[0].type_key;
  typeSelect.value = state.themeType;

  const stateSelect = $("#theme-state");
  stateSelect.replaceChildren(new Option("Normal", ""));
  state.states.forEach((name) => stateSelect.append(new Option(name, name)));
  stateSelect.value = state.themeState;

  const schema = state.schemas.find((item) => item.type_key === state.themeType);
  const entry = themeLibrary()[state.themeType];
  $("#delete-theme-entry").disabled = !entry;
  $("#theme-empty").classList.toggle("hidden", Boolean(entry));

  const container = $("#theme-properties");
  container.replaceChildren();
  if (!schema) return;
  const properties = schema.properties.filter((property) => property.category === "style");
  let previousPart = null;
  properties.forEach((property, index) => {
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
function themePropertyTarget(typeKey, property, create) {
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

function updateThemeProperty(property, control) {
  const target = themePropertyTarget(state.themeType, property, true);
  if (property.kind === "image_ref" && control.value === ADD_IMAGE_OPTION) {
    pushUndo();
    const id = addImageSource();
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

function renderGridCellSection(widget) {
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
  state.gridCellProperties.forEach((property, index) => {
    container.append(propertyField(widget, property, `gc-${index}`, "grid_cell"));
  });
}

function findParent(nodes, target, parent = null) {
  for (const node of nodes) {
    if (node === target) return parent;
    const found = findParent(node.children || [], target, node);
    if (found !== undefined) return found;
  }
  return undefined;
}

function renderExtraKeys(widget) {
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

function imageEntry(id) {
  return id ? imageLibrary().find((entry) => entry.id === id) : undefined;
}

function fontLibrary() {
  if (!Array.isArray(state.project.fonts)) state.project.fonts = [];
  return state.project.fonts;
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
function ensureFontLoaded(fontId) {
  if (!fontId || fontLoadState.has(fontId)) return;
  const entry = fontLibrary().find((font) => font.id === fontId);
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

function isRemoteAsset(path) {
  return /^https?:\/\//i.test(String(path || ""));
}

// A local path (e.g. from an imported config's own `images:`/`font:` entry)
// isn't something the browser can fetch directly - it lives on the HA host,
// not the web. Route it through the read-only asset endpoint instead, which
// confines itself to the same config directory those entries came from in
// the first place. Deliberately not used by addImageSource(): a user typing
// an arbitrary path into that prompt is a different trust situation than a
// path that already existed in an imported project.
function assetUrl(filePath) {
  if (isRemoteAsset(filePath)) return filePath;
  const appBase = window.location.pathname.endsWith("/")
    ? window.location.pathname
    : `${window.location.pathname}/`;
  return `${appBase}api/v1/designer/assets/read/${encodedName(filePath)}`;
}

// The canvas can show any source the browser can fetch: an http(s) URL
// as-is, or a local path (from an imported config) through assetUrl().
function displayableImageSource(id) {
  const entry = imageEntry(id);
  return entry && entry.file_path ? assetUrl(entry.file_path) : null;
}

function addImageSource() {
  const url = (prompt(t("prompt.image.url"), "https://") || "").trim();
  if (!url || url === "https://") return null;
  if (!isRemoteAsset(url)) {
    toast(t("toast.image.onlyHttpUrls"), true);
    return null;
  }
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
function resizeWidgetToImage(widget, id) {
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

function propertyControl(property, value, index) {
  let control;
  if (property.kind === "image_ref") {
    control = document.createElement("select");
    control.append(new Option("—", ""));
    imageLibrary().forEach((entry) => control.append(new Option(entry.id, entry.id)));
    if (value && !imageEntry(value)) control.append(new Option(`${value} (fehlt)`, value));
    control.value = value ?? "";
    control.append(new Option("＋ Neue Bildquelle …", ADD_IMAGE_OPTION));
  } else if (property.kind === "bool") {
    control = document.createElement("input");
    control.type = "checkbox";
    control.checked = value ?? Boolean(property.default);
  } else if (property.kind === "enum") {
    control = document.createElement("select");
    control.append(new Option("—", ""));
    property.enum_values.forEach((option) => control.append(new Option(option, option)));
    if (value !== undefined && !property.enum_values.includes(String(value))) {
      control.append(new Option(String(value), String(value)));
    }
    control.value = value ?? "";
  } else if (LIST_KINDS.includes(property.kind)) {
    // The model value is a list even though the editor is one line - grid
    // tracks and animation frames are both short, comma-separated sequences.
    control = document.createElement("input");
    control.type = "text";
    control.value = Array.isArray(value) ? value.join(", ") : "";
    control.placeholder = property.kind === "grid_track_list"
      ? "40, FR(1), CONTENT" : "img_a, img_b";
  } else {
    control = document.createElement("input");
    control.type = ["int", "float"].includes(property.kind) ? "number" : "text";
    if (property.kind === "float") control.step = "any";
    control.value = value ?? "";
    if (property.default !== null) control.placeholder = String(property.default);
    if (property.kind === "color") control.placeholder = "RRGGBB oder Farb-ID";
  }
  control.id = `dynamic-${index}-${property.part}-${property.key}`;
  return control;
}

const LIST_KINDS = ["grid_track_list", "image_ref_list"];

function parseListValue(property, text) {
  const items = String(text).split(",").map((part) => part.trim()).filter(Boolean);
  if (property.kind !== "grid_track_list") return items;
  // Pixel tracks are numbers; FR(n) and CONTENT stay strings.
  return items.map((part) => (/^-?\d+$/.test(part) ? Number(part) : part));
}

function updateDynamicProperty(widget, property, control, targetKind = property.category) {
  const target = propertyTarget(widget, property, true, targetKind);
  if (property.kind === "image_ref" && control.value === ADD_IMAGE_OPTION) {
    pushUndo();
    const id = addImageSource();
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
  if (property.kind === "bool") value = control.checked;
  else if (LIST_KINDS.includes(property.kind)) value = parseListValue(property, control.value);
  else if (["int", "float"].includes(property.kind)) value = control.value === "" ? null : Number(control.value);
  else value = control.value;

  // An empty field means "unset", not "set to empty" - carrying blanks into
  // layout or grid placement would emit keys the source never had.
  const clears = value === "" || value === null
    || (Array.isArray(value) && value.length === 0);
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

function updateSelectedWidget(event) {
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
        .filter((stroke) => stroke.parent_id === widget.id)
        .forEach((stroke) => {
          stroke.points = stroke.points.map(([px, py]) => (
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

function replaceActionTargetReference(action, previousId, nextId) {
  const entry = actionObjectEntry(action);
  if (!entry) return;
  const [name, payload] = entry;
  if (name === "if" && payload && typeof payload === "object") {
    [payload.then, payload.else].forEach((branch) => {
      const actions = Array.isArray(branch) ? branch : branch ? [branch] : [];
      actions.forEach((nested) => replaceActionTargetReference(nested, previousId, nextId));
    });
    return;
  }
  if (["lvgl.widget.show", "lvgl.widget.hide", "lvgl.page.show"].includes(name)) {
    if (payload === previousId) action[name] = nextId;
    else if (Array.isArray(payload)) {
      action[name] = payload.map((item) => item === previousId ? nextId : item);
    } else if (payload && typeof payload === "object") {
      if (payload.id === previousId) payload.id = nextId;
      else if (Array.isArray(payload.id)) {
        payload.id = payload.id.map((item) => item === previousId ? nextId : item);
      }
    }
    return;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (payload.id === previousId) payload.id = nextId;
    else if (Array.isArray(payload.id)) {
      payload.id = payload.id.map((item) => item === previousId ? nextId : item);
    }
  }
}

function replaceProjectWidgetReferences(previousId, nextId) {
  projectWidgetEntries().forEach((item) => {
    if (item.align_to === previousId) item.align_to = nextId;
    Object.values(item.events || {}).forEach((raw) => {
      const actions = Array.isArray(raw) ? raw : [raw];
      actions.forEach((action) => replaceActionTargetReference(action, previousId, nextId));
    });
  });
  (state.project.glow_strokes || []).forEach((stroke) => {
    if (stroke.parent_id === previousId) stroke.parent_id = nextId;
  });
  state.viewerBindings.forEach((binding) => {
    if (binding.widget_id === previousId) binding.widget_id = nextId;
  });
}

function deleteSelectedWidget() {
  if (!state.selectedWidget) return;
  pushUndo();
  // Glow lines aren't part of the widget tree, so removing a container would
  // otherwise leave its child lines pointing at a parent_id that no longer
  // exists anywhere - orphan them back to top-level instead.
  const removedIds = new Set(allWidgets([state.selectedWidget]).map((widget) => widget.id));
  (state.project.glow_strokes || []).forEach((stroke) => {
    if (removedIds.has(stroke.parent_id)) stroke.parent_id = "";
  });
  removeWidget(activeWidgetRoots(), state.selectedWidget);
  state.selectedWidget = null;
  markProjectDirty();
  renderDesigner();
}

function removeWidget(nodes, target) {
  const index = nodes.indexOf(target);
  if (index >= 0) {
    nodes.splice(index, 1);
    return true;
  }
  return nodes.some((widget) => removeWidget(widget.children || [], target));
}

/** The array actually holding `target` (top-level list or some widget's
 * `children`) plus its index there - the array reference is live, so
 * splicing it moves/removes the real widget, not a copy. */
function findWidgetLocation(nodes, target) {
  const index = nodes.indexOf(target);
  if (index >= 0) return { array: nodes, index };
  for (const node of nodes) {
    const found = findWidgetLocation(node.children || [], target);
    if (found) return found;
  }
  return null;
}

/** id of the widget whose `children` directly contains `target`, "" if
 * `target` is top-level, or null if `target` isn't in the tree at all. */
function findParentContainerId(nodes, target, parentId = "") {
  if (nodes.includes(target)) return parentId;
  for (const node of nodes) {
    const found = findParentContainerId(node.children || [], target, node.id);
    if (found !== null) return found;
  }
  return null;
}

function widgetAllowsChildren(widget) {
  const schema = state.schemas.find((item) => item.type_key === widget.widget_type);
  return Boolean(schema?.allows_children);
}

function cloneWidgetSubtree(widget) {
  const usedIds = new Set([
    ...allProjectWidgets().map((w) => w.id),
    ...(state.project.reserved_ids || []),
  ]);
  const assignIds = (node) => {
    let n = 1;
    let candidate = `${node.widget_type}_${n}`;
    while (usedIds.has(candidate)) { n += 1; candidate = `${node.widget_type}_${n}`; }
    node.id = candidate;
    usedIds.add(candidate);
    (node.children || []).forEach(assignIds);
  };
  const clone = JSON.parse(JSON.stringify(widget));
  assignIds(clone);
  return clone;
}

function duplicateWidget(widget) {
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

function duplicateStroke(stroke) {
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

let treeDrag = null; // { kind: "widget", widget } | { kind: "stroke", stroke }

function clearDropIndicators() {
  $$(".tree-item.drop-before, .tree-item.drop-after, .tree-item.drop-into")
    .forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-into"));
}

function bindTreeItemDrag(item, payload, { allowInto }) {
  item.draggable = true;
  item.addEventListener("dragstart", (event) => {
    event.stopPropagation();
    treeDrag = payload;
    event.dataTransfer.effectAllowed = "move";
  });
  item.addEventListener("dragover", (event) => {
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
  item.addEventListener("drop", (event) => {
    if (!treeDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const position = item.classList.contains("drop-into") ? "into"
      : item.classList.contains("drop-after") ? "after" : "before";
    clearDropIndicators();
    performTreeDrop(treeDrag, { ...payload, position });
    treeDrag = null;
  });
  item.addEventListener("dragend", (event) => {
    event.stopPropagation();
    clearDropIndicators();
    treeDrag = null;
  });
}

function performTreeDrop(dragged, target) {
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
      const container = containerId ? allWidgets().find((w) => w.id === containerId) : null;
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
    tree.addEventListener("dragover", (event) => {
      if (!treeDrag) return;
      event.preventDefault();
    });
    tree.addEventListener("drop", (event) => {
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

  const appendStroke = (stroke, depth) => {
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

  const appendNodes = (nodes, depth = 0) => nodes.forEach((widget) => {
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
    strokes.filter((stroke) => stroke.parent_id === widget.id).forEach((stroke) => appendStroke(stroke, depth + 1));
  });
  const appendReadOnlyNodes = (nodes, depth = 1) => (nodes || []).forEach((widget) => {
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
  const appendSurface = (key, title, surface, { skipped = false } = {}) => {
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
    (state.project.pages || []).forEach((page) => {
      appendSurface(`page:${page.id}`, t("surface.pageLabel", { id: page.id }), page, { skipped: page.skip });
    });
    if (state.project.top_layer) appendSurface("top", "Top-Layer", state.project.top_layer);
  }

  if (activeSurfaceEntry().kind === "root") {
    strokes.filter((stroke) => !stroke.parent_id).forEach((stroke) => appendStroke(stroke, 0));
  }
}

function treeGlyph(widget, flag, iconHtml, title) {
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

function treeActionGlyph(iconHtml, title, onClick) {
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
  try {
    const result = await api("designer/projects/export-yaml", {
      method: "POST", body: JSON.stringify({ project: state.project }),
    });
    $("#yaml-output").textContent = result.yaml;
    renderExportIssues(result.issues || []);
    $("#yaml-dialog").showModal();
    renderDesignerStatus();
  } catch (error) {
    $("#designer-status").textContent = t("designer.status.exportFailed");
    renderExportIssues(error.details?.issues || []);
    toast(error.message, true);
  }
}

function renderExportIssues(issues) {
  renderIssues($("#yaml-issues"), issues, t("issues.contextExport"));
}

function isBlockingIssue(issue) {
  // Validation issues use severity "error"; the YAML exporter and importer
  // use "A" (blocking) vs "B" (warning) vs "C" (informational).
  return issue.severity === "error" || issue.severity === "A";
}

function renderIssues(container, issues, context = "") {
  container.replaceChildren();
  // "Preserved but not editable" notes are informational and a real config
  // produces dozens of them - listing each one would bury the real warnings.
  const notable = issues.filter((issue) => issue.severity !== "C");
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
  notable.forEach((issue) => {
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
  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const start = editor.selectionStart;
    editor.setRangeText("  ", start, editor.selectionEnd, "end");
    updateYamlEditorUi();
  });
  $("#yaml-search-next").addEventListener("click", () => findYamlMatch(1));
  $("#yaml-search-previous").addEventListener("click", () => findYamlMatch(-1));
  $("#yaml-search").addEventListener("input", () => findYamlMatch(0));
  $("#yaml-search").addEventListener("keydown", (event) => {
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
  const lineCount = editor.value.split("\n").length;
  $("#yaml-line-numbers").textContent = Array.from(
    { length: lineCount }, (_unused, index) => String(index + 1),
  ).join("\n");
  state.yamlDirty = Boolean(state.activeConfig)
    && editor.value !== state.yamlLoadedContent;
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
  const before = editor.value.slice(0, editor.selectionStart);
  const lines = before.split("\n");
  $("#yaml-cursor-status").textContent = t("configs.cursorStatus", { line: lines.length, column: lines.at(-1).length + 1 });
}

function findYamlMatch(direction) {
  const editor = $("#yaml-editor");
  const query = $("#yaml-search").value;
  const result = $("#yaml-search-result");
  if (!query) {
    result.textContent = "";
    return;
  }
  const haystack = editor.value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const matches = [];
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + Math.max(needle.length, 1))) {
    matches.push(index);
  }
  if (!matches.length) {
    result.textContent = "Kein Treffer";
    return;
  }
  let selected = matches.findIndex((index) => index >= editor.selectionStart);
  if (direction > 0) selected = matches.findIndex((index) => index > editor.selectionStart);
  if (direction < 0) {
    selected = matches.findLastIndex((index) => index < editor.selectionStart);
  }
  if (selected < 0) selected = direction < 0 ? matches.length - 1 : 0;
  const index = matches[selected];
  editor.focus();
  editor.setSelectionRange(index, index + query.length);
  result.textContent = `${selected + 1} von ${matches.length}`;
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
    result.configurations.forEach((configuration) => {
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
  } catch (error) { toast(error.message, true); }
}

async function loadConfiguration(configuration) {
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
  } catch (error) { toast(error.message, true); }
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
  } catch (error) { toast(error.message, true); }
}

async function checkYaml() {
  if (!state.activeConfig) return;
  try {
    const source = state.hasDraft ? "draft" : "active";
    const result = await api(`configurations/${encodedName(state.activeConfig)}/check-yaml?source=${source}`, { method: "POST" });
    const output = $("#config-output");
    output.textContent = result.valid
      ? t("config.output.yamlValid", { revision: result.revision })
      : t("config.output.yamlError", { line: result.line, column: result.column, error: result.error });
    output.classList.remove("hidden");
  } catch (error) { toast(error.message, true); }
}

async function showDiff() {
  if (!state.activeConfig || !state.hasDraft) return;
  try {
    const result = await api(`configurations/${encodedName(state.activeConfig)}/diff`);
    const output = $("#config-output");
    output.textContent = result.diff || t("config.output.noDifferences");
    output.classList.remove("hidden");
  } catch (error) { toast(error.message, true); }
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
  } catch (error) { toast(error.message, true); }
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
  } catch (error) { toast(error.message, true); }
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
  } catch (error) { toast(error.message, true); }
}

function updateBuilderButtons() {
  const activePublishedConfiguration = Boolean(state.activeConfig) && !state.hasDraft;
  $("#validate-esphome").disabled = !activePublishedConfiguration || !state.capabilities["configuration.validate_esphome"];
  $("#compile-config").disabled = !activePublishedConfiguration || !state.capabilities["firmware.compile"] || state.builderRequestsRunning.has("compile");
  $("#install-config").disabled = !activePublishedConfiguration || !state.capabilities["firmware.upload"] || state.builderRequestsRunning.has("install");
}

async function validateEspHome() {
  if (!state.activeConfig || state.hasDraft) return;
  const output = $("#config-output");
  output.textContent = t("config.output.validating");
  output.classList.remove("hidden");
  try {
    const result = await api(`configurations/${encodedName(state.activeConfig)}/validate`, { method: "POST" });
    const lines = Array.isArray(result.output) ? result.output.join("\n") : "";
    const validity = result.valid ? t("config.output.buildApprovalSuffix", { seconds: result.expires_in_seconds }) : "";
    output.textContent = `${result.valid ? t("config.output.espValid") : t("config.output.espInvalid")}\nRevision: ${result.revision}${validity}\n\n${lines}`.trim();
  } catch (error) {
    output.textContent = `${error.code || t("config.output.errorFallback")}: ${error.message}`;
    toast(error.message, true);
  }
}

function builderRequestKey(operation) {
  const slot = `${operation}:${state.activeConfig}`;
  if (!state.builderRequestKeys[slot]) {
    state.builderRequestKeys[slot] = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-request`;
  }
  return { slot, key: state.builderRequestKeys[slot] };
}

async function compileConfiguration() {
  if (!state.activeConfig || state.hasDraft) return;
  const request = builderRequestKey("compile");
  state.builderRequestsRunning.add("compile");
  updateBuilderButtons();
  try {
    const result = await api(`configurations/${encodedName(state.activeConfig)}/compile`, {
      method: "POST", headers: { "Idempotency-Key": request.key },
    });
    delete state.builderRequestKeys[request.slot];
    state.builderJobs[result.job.job_id] = result.job;
    renderBuilderJobs();
    toast(result.idempotent_replay
      ? t("toast.builder.jobRestored", { id: result.job.job_id })
      : t("toast.builder.jobStarted", { id: result.job.job_id }));
  } catch (error) { toast(error.message, true); }
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
    const result = await api(`configurations/${encodedName(state.activeConfig)}/install`, {
      method: "POST",
      headers: { "Idempotency-Key": request.key },
      body: JSON.stringify({ port: "OTA", confirmed: true }),
    });
    delete state.builderRequestKeys[request.slot];
    state.builderJobs[result.job.job_id] = result.job;
    renderBuilderJobs();
    toast(result.idempotent_replay ? `OTA-Job ${result.job.job_id} wiederhergestellt.` : `OTA-Job ${result.job.job_id} gestartet.`);
  } catch (error) { toast(error.message, true); }
  finally {
    state.builderRequestsRunning.delete("install");
    updateBuilderButtons();
  }
}

async function loadBuilderJobs() {
  if (!state.capabilities["firmware.compile"]) return;
  try {
    const result = await api("jobs");
    state.builderJobs = Object.fromEntries((result.jobs || []).map((job) => [job.job_id, job]));
    renderBuilderJobs();
  } catch (error) { toast(error.message, true); }
}

function renderBuilderJobs() {
  const panel = $("#builder-jobs");
  const list = $("#builder-job-list");
  const jobs = Object.values(state.builderJobs).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
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
          await api(`jobs/${encodeURIComponent(job.job_id)}/cancel`, { method: "POST" });
          await loadBuilderJobs();
        } catch (error) { toast(error.message, true); }
      });
      row.append(cancel);
    }
    list.append(row);
  });
}

function connectBuilderEvents() {
  if (!state.capabilities["firmware.compile"] || state.builderSocket) return;
  const appBase = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}${appBase}api/v1/jobs/events`);
  state.builderSocket = socket;
  socket.addEventListener("message", (message) => {
    let payload;
    try { payload = JSON.parse(message.data); } catch { return; }
    if (payload.type === "resync_required") {
      loadBuilderJobs();
      return;
    }
    if (payload.type !== "builder_job" || !payload.data) return;
    const data = payload.data;
    if (payload.event === "job_output" && data.job_id) {
      const job = state.builderJobs[data.job_id];
      if (job) job.last_output = String(data.line || "").slice(-4096);
    } else if (data.job_id) {
      state.builderJobs[data.job_id] = { ...(state.builderJobs[data.job_id] || {}), ...data };
    }
    renderBuilderJobs();
  });
  socket.addEventListener("close", () => {
    if (state.builderSocket === socket) state.builderSocket = null;
    window.setTimeout(connectBuilderEvents, 3000);
  });
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum);
}

// Read-only debug handle - not part of the app's own logic, only for
// inspecting state from the browser console or an automated check.
window.__appState = state;

initialize();
