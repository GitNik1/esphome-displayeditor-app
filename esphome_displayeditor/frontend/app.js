import { computeLayout } from "./layout.js";
import { boundingBox, nearestSegment } from "./glowline/geometry.js";
import { drawDocument, flowBoundsDocument, hasFlow, strokePath } from "./glowline/renderer.js";
import { format565, hsvToRgb, quantizeImageData, rgb565to888, rgb888to565 } from "./glowline/rgb565.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  system: null,
  capabilities: {},
  schemas: [],
  selectedWidget: null,
  activeConfig: null,
  activeRevision: null,
  configurations: [],
  hasDraft: false,
  project: freshProject(),
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
  devices: [],
  selectedDevice: null,
  editingDevice: null,
  deviceSocket: null,
  deviceStates: [],

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

function freshProject() {
  return {
    format: "esphome-lvgl-designer-project",
    format_version: 3,
    canvas: { width: 480, height: 480 },
    background: { path: "", export_as_lvgl_image: false, image_id: "bg_image", opacity_in_editor: 40 },
    display_id_placeholder: "my_display",
    default_font: "",
    widgets: [],
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

function freshGlowStroke(id) {
  return {
    id, points: [], name: "", color565: 0x07ff, width: 5, corner_radius: 12,
    mode: "polyline", closed: false,
    glow: { enabled: true, radius: 14, intensity: 0.85, use_line_color: true, color565: 0x07ff },
    flow: {
      enabled: false, mode: "arrows", reversed: false, spacing: 40, size: 14,
      width: 0, use_line_color: false, color565: 0xffff, glow_radius: 0, glow_intensity: 0.9,
    },
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

async function initialize() {
  bindTabs();
  bindDesigner();
  bindConfigurations();
  bindDevices();
  try {
    const [health, system, capabilityData, schemaData] = await Promise.all([
      api("health"), api("system"), api("capabilities"), api("designer/schemas?language=de"),
    ]);
    state.system = system;
    state.capabilities = capabilityData.capabilities;
    state.schemas = schemaData.widgets;
    state.gridCellProperties = schemaData.grid_cell_properties || [];
    state.states = schemaData.states || [];
    renderStateChoices();
    $("#health").classList.toggle("ok", health.status === "ok");
    $("#profile").textContent = `${system.profile} · ${system.user.role} · ${system.user.display_name || system.user.name || "Ingress"}`;
    $("#system-json").textContent = JSON.stringify({ system, ...capabilityData }, null, 2);
    renderPalette();
    const initialLoads = [loadServerProjects(), loadDevices()];
    if (state.capabilities["configuration.list"]) initialLoads.push(loadConfigurations());
    else {
      $("#config-list").textContent = "Dateisystemzugriff ist in diesem Profil deaktiviert.";
      $("#refresh-configs").disabled = true;
    }
    await Promise.all(initialLoads);
    connectDeviceEvents();
  } catch (error) {
    $("#profile").textContent = "Backend nicht erreichbar";
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
}

const DEVICE_STATUS = {
  configured: "Konfiguriert",
  connecting: "Verbindung wird aufgebaut …",
  ready: "Verbunden",
  disconnected: "Getrennt",
  auth_failed: "Authentifizierung fehlgeschlagen",
  missing_key: "Verschlüsselungsschlüssel fehlt",
  disabled: "Native API deaktiviert",
};

async function loadDevices() {
  const list = $("#device-list");
  const canRead = Boolean(state.capabilities["device.info"]);
  const canManage = Boolean(state.capabilities["device.manage"]);
  $("#add-device").classList.toggle("hidden", !canManage);
  if (!canRead) {
    list.className = "device-list empty";
    list.textContent = "Native API ist in diesem Profil nicht verfügbar.";
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
    list.textContent = "Keine Geräte konfiguriert.";
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
      renderDeviceList();
      await loadDeviceDetails(device.id);
    });
    list.append(button);
  });
}

function resetDeviceDetails() {
  $("#device-title").textContent = "Kein Gerät gewählt";
  $("#device-connection").textContent = "–";
  ["edit-device", "remove-device", "reconnect-device"].forEach((id) => { $(`#${id}`).disabled = true; });
  $("#device-info pre").textContent = "Keine Daten.";
  $("#device-entities").replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: "Keine Entitäten." }));
  $("#device-states").replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: "Keine Zustände." }));
  $("#device-logs pre").textContent = "Keine Logs.";
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
      : "Noch keine Geräteinformationen verfügbar.";
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
    container.append(Object.assign(document.createElement("div"), { className: "empty", textContent: "Noch keine Daten verfügbar." }));
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
  if (!logs.length) return "Noch keine Logs verfügbar.";
  return logs.map((item) => `[${item.received_at || ""}] [${item.level || "INFO"}] ${item.message || ""}`).join("\n");
}

function openDeviceDialog(device = null) {
  state.editingDevice = device?.id || null;
  $("#device-dialog-title").textContent = device ? "ESPHome-Gerät bearbeiten" : "ESPHome-Gerät hinzufügen";
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
    toast(editing ? "Gerät aktualisiert." : "Gerät hinzugefügt.");
  } catch (error) {
    toast(error.message, true);
  }
}

async function reconnectSelectedDevice() {
  if (!state.selectedDevice) return;
  try {
    await api(`admin/devices/${encodeURIComponent(state.selectedDevice)}/reconnect`, { method: "POST" });
    toast("Neuverbinden wurde gestartet.");
    await loadDevices();
  } catch (error) { toast(error.message, true); }
}

async function removeSelectedDevice() {
  const device = state.devices.find((item) => item.id === state.selectedDevice);
  if (!device || !confirm(`Gerät „${device.name}“ entfernen? Der separat gespeicherte Schlüssel bleibt erhalten.`)) return;
  try {
    await api(`admin/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
    state.selectedDevice = null;
    await loadDevices();
    toast("Gerät entfernt.");
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
      output.textContent = output.textContent === "Noch keine Logs verfügbar." ? line : `${output.textContent}\n${line}`;
      output.textContent = output.textContent.split("\n").slice(-1000).join("\n");
      return;
    }
    if (["devices", "connection", "snapshot", "device_removed", "resync_required"].includes(event.type)) {
      await loadDevices();
    } else if (event.type === "state" && event.device_id === state.selectedDevice) {
      const key = `${event.state.type}:${event.state.key ?? event.state.object_id ?? "unknown"}`;
      const index = state.deviceStates.findIndex((item) => `${item.type}:${item.key ?? item.object_id ?? "unknown"}` === key);
      if (index >= 0) state.deviceStates[index] = event.state;
      else state.deviceStates.push(event.state);
      renderDeviceTable($("#device-states"), state.deviceStates, ["type", "key", "available", "state"]);
    }
  });
  socket.addEventListener("close", () => {
    if (state.deviceSocket === socket) state.deviceSocket = null;
    window.setTimeout(connectDeviceEvents, 3000);
  });
}

function bindDesigner() {
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
  $("#prop-locked").addEventListener("change", () => toggleWidgetFlag("locked"));
  $("#prop-hidden").addEventListener("change", () => toggleWidgetFlag("hidden"));
  $("#style-state").addEventListener("change", changeActiveState);
  $("#style-mode").addEventListener("change", changeStyleMode);
  $("#style-ref").addEventListener("change", changeStyleRef);
  $("#save-as-style").addEventListener("click", saveCurrentStyleAsNamed);
  bindGlowTools();

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
    toast("YAML wurde kopiert.");
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
  if (state.projectDirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
  stopFlowPreview();
  state.project = freshProject();
  state.projectName = null;
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
    toast("Die Projektdatei ist zu groß.", true);
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
    state.projectName = null;
    state.projectRevision = null;
    state.projectDirty = false;
    state.selectedWidget = null;
    state.selectedStroke = null;
    state.drawingStroke = null;
    $("#project-name").value = normalizeProjectName(file.name);
    resetHistory();
    renderDesigner();
    toast("Projekt geladen.");
  } catch (error) {
    toast(`Projekt konnte nicht geladen werden: ${error.message}`, true);
  }
}

function downloadDesignerProject() {
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = normalizeProjectName($("#project-name").value);
  link.click();
  URL.revokeObjectURL(url);
  toast("Projektdatei heruntergeladen.");
}

// --- Import an existing ESPHome configuration -------------------------------
// Two steps on purpose: probe first so the user sees what would happen before
// their current project is replaced, and can correct the detected canvas size.

const importState = { configuration: null, content: null, fileName: "", stats: null };

function openImportDialog() {
  const select = $("#import-config");
  select.replaceChildren(new Option("Datei wählen …", ""));
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
    toast("Die Datei ist zu groß (max. 4 MB).", true);
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
  user: "manuell gesetzt",
  display_dimensions: "aus display: übernommen",
  display_model: "aus dem Display-Modell abgeleitet",
  root_grid: "aus dem Wurzel-Grid berechnet",
  bounding_box: "aus den Widget-Positionen geschätzt",
  default: "Standardwert — bitte prüfen",
};

function renderImportSummary(stats) {
  const summary = $("#import-summary");
  summary.classList.remove("import-error");
  summary.replaceChildren();

  const types = Object.entries(stats.widget_types)
    .map(([type, count]) => `${count}× ${type}`).join(", ");
  const lines = [
    `${stats.widget_count} Widgets (${types})`,
    `Bildgröße ${stats.canvas.width}×${stats.canvas.height} — ${
      CANVAS_SOURCE_LABELS[stats.canvas.source] || stats.canvas.source}`,
  ];
  if (stats.images || stats.fonts || stats.styles) {
    lines.push(`${stats.images} Bilder, ${stats.fonts} Schriften, ${stats.styles} Stile`);
  }
  lines.forEach((text) => {
    const row = document.createElement("div");
    row.textContent = text;
    summary.append(row);
  });

  if (stats.unsupported_types.length) {
    summary.append(warningRow(
      `Ohne Editor-Unterstützung: ${stats.unsupported_types.join(", ")} — wird erhalten, aber nicht bearbeitbar.`));
  }
  if (stats.preserved_keys.length) {
    summary.append(warningRow(
      `${stats.preserved_keys.length} unbekannte Eigenschaften werden unverändert mitgeführt.`));
  }
  if (stats.issues.A) {
    summary.append(warningRow(`${stats.issues.A} blockierende Probleme.`, true));
  }
}

function warningRow(text, severe = false) {
  const row = document.createElement("div");
  row.className = severe ? "issue-error" : "import-warning";
  row.textContent = text;
  return row;
}

async function runImport() {
  if (state.projectDirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
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
      renderIssues($("#import-summary"), result.issues, "beim Import");
      return;
    }
    stopFlowPreview();
    state.project = result.project;
    // An import is not "the saved project under this name" - it is a new,
    // unsaved document derived from a config we must never write back to.
    state.projectName = null;
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
    toast(`${result.stats.widget_count} Widgets importiert.`
      + (warnings ? ` ${warnings} Hinweis(e) — siehe YAML-Export.` : ""));
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
    select.replaceChildren(new Option("Gespeicherte Projekte …", ""));
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
  $("#load-server-project").disabled = !selected;
  $("#delete-server-project").disabled = !selected || !state.capabilities["designer.project_write"];
  $("#save-server-project").disabled = !state.capabilities["designer.project_write"];
}

async function loadSelectedServerProject() {
  const name = $("#server-projects").value;
  if (!name) return;
  if (state.projectDirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
  try {
    const result = await api(`designer/projects/${encodeURIComponent(name)}`);
    stopFlowPreview();
    state.project = result.project;
    state.projectName = result.name;
    state.projectRevision = result.revision;
    state.projectDirty = false;
    state.selectedWidget = null;
    state.selectedStroke = null;
    state.drawingStroke = null;
    $("#project-name").value = result.name;
    resetHistory();
    renderDesigner();
    toast("Projekt aus App-Speicher geladen.");
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
    await loadServerProjects();
    $("#server-projects").value = name;
    updateServerProjectButtons();
    toast("Projekt sicher im App-Speicher gespeichert.");
  } catch (error) {
    toast(error.code === "project_exists" ? "Projekt existiert bereits. Bitte zuerst laden." : error.message, true);
  }
}

async function deleteServerProject() {
  const name = $("#server-projects").value;
  if (!name || !confirm(`Gespeichertes Projekt ${name} löschen?`)) return;
  const option = $("#server-projects").selectedOptions[0];
  const revision = state.projectName === name ? state.projectRevision : option.dataset.revision;
  try {
    await api(`designer/projects/${encodeURIComponent(name)}?expected_revision=${encodeURIComponent(revision)}`, {
      method: "DELETE",
    });
    if (state.projectName === name) {
      state.projectName = null;
      state.projectRevision = null;
      state.projectDirty = true;
    }
    await loadServerProjects();
    renderDesignerStatus();
    toast("Gespeichertes Projekt gelöscht.");
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
    switch: "◉", slider: "━", image: "▧", animimg: "▩",
  };
  state.schemas.forEach((schema) => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    icon.className = "widget-icon";
    icon.textContent = icons[schema.type_key] || "◇";
    button.append(icon, document.createTextNode(schema.label));
    button.addEventListener("click", () => addWidget(schema));
    palette.append(button);
  });
}

function allWidgets(nodes = state.project.widgets) {
  const result = [];
  const visit = (items) => items.forEach((widget) => {
    result.push(widget);
    visit(widget.children || []);
  });
  visit(nodes);
  return result;
}

function addWidget(schema) {
  pushUndo();
  const idBase = schema.type_key === "container" ? "container" : schema.type_key;
  let number = 1;
  const ids = new Set(allWidgets().map((widget) => widget.id));
  while (ids.has(`${idBase}_${number}`)) number += 1;
  const properties = {};
  for (const property of schema.properties) {
    if (property.category === "content" && property.default !== null) properties[property.key] = property.default;
  }
  const parentSchema = state.selectedWidget
    ? state.schemas.find((item) => item.type_key === state.selectedWidget.widget_type)
    : null;
  const parent = parentSchema?.allows_children ? state.selectedWidget : null;
  const target = parent ? parent.children : state.project.widgets;
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
  const boxes = computeLayout(state.project);
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

function renderDesigner() {
  renderCanvas();
  renderBackgroundFields();
  renderProperties();
  renderLineProperties();
  renderTree();
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

  // Order matters: background, then the glow-line overlay, then widgets on
  // top (so buttons/labels stay legible over a decorative flow animation),
  // then the edit handles on top of everything so they stay grabbable.
  const glowCanvas = document.createElement("canvas");
  glowCanvas.id = "glow-canvas";
  glowCanvas.className = "glow-canvas";
  const handles = document.createElement("div");
  handles.id = "glow-handles";
  handles.className = "glow-handles";
  canvas.replaceChildren(renderCanvasBackground(), glowCanvas);
  visualWidgets().forEach((item) => canvas.append(renderWidget(item)));
  canvas.append(handles);

  $("#widget-count").textContent = `${allWidgets().length} Widgets`;
  applyZoom();
  renderGlowCanvas();
  renderGlowHandles();
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
    toast("Das Vorschaubild ist zu groß (max. 8 MB).", true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.backgroundPreview = reader.result;
    $("#bg-preview-clear").disabled = false;
    renderCanvas();
    toast("Vorschaubild geladen (nur im Editor sichtbar).");
  };
  reader.onerror = () => toast("Vorschaubild konnte nicht gelesen werden.", true);
  reader.readAsDataURL(file);
}

function clearBackgroundPreview() {
  state.backgroundPreview = null;
  $("#bg-preview-clear").disabled = true;
  renderCanvas();
}

function renderDesignerStatus() {
  const name = state.projectName || "Lokales Projekt";
  $("#designer-status").textContent = `${state.projectDirty ? "● Ungespeichert · " : ""}${name}`;
}

// --- Glow lines (ported GlowLine editor) ------------------------------------
//
// Editing widgets and editing lines are mutually exclusive modes (state.
// canvasMode), matching the desktop app being a separate tool from the LVGL
// designer: mixing hit-testing for both under one cursor model would be a lot
// of complexity for a case that rarely overlaps in practice.

function bindGlowTools() {
  $("#mode-widgets").addEventListener("click", () => setCanvasMode("widgets"));
  $("#mode-lines").addEventListener("click", () => setCanvasMode("lines"));
  $("#tool-select").addEventListener("click", () => setLineTool("select"));
  $("#tool-draw").addEventListener("click", () => setLineTool("draw"));
  $("#line-add").addEventListener("click", startNewLine);
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
  $("#mode-widgets").classList.toggle("active", mode === "widgets");
  $("#mode-lines").classList.toggle("active", mode === "lines");
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
  if (state.canvasMode !== "lines") setCanvasMode("lines");
  pushUndo();
  if (!Array.isArray(state.project.glow_strokes)) state.project.glow_strokes = [];
  const stroke = freshGlowStroke(uniqueStrokeId());
  state.project.glow_strokes.push(stroke);
  state.selectedStroke = stroke;
  state.drawingStroke = stroke;
  markProjectDirty();
  setLineTool("draw");
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
  if (hit) beginLineBodyDrag(event, hit, point);
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
  const canvas = $("#glow-canvas");
  if (!canvas) return;
  canvas.width = state.project.canvas.width;
  canvas.height = state.project.canvas.height;
  drawGlowFrame(0);
}

function drawGlowFrame(phase) {
  const canvas = $("#glow-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawDocument(ctx, { strokes: state.project.glow_strokes || [] },
              { quality: "final", phase, withFlow: true });
}

function renderGlowHandles() {
  const layer = $("#glow-handles");
  if (!layer) return;
  layer.replaceChildren();
  if (state.canvasMode !== "lines" || !state.selectedStroke) return;
  const stroke = state.selectedStroke;
  stroke.points.forEach((point, index) => {
    const handle = document.createElement("div");
    handle.className = `glow-handle${index === 0 ? " first" : ""}`;
    handle.style.left = `${point[0]}px`;
    handle.style.top = `${point[1]}px`;
    handle.title = index === 0 ? "Erster Punkt (schließt die Linie beim Zeichnen)" : `Punkt ${index + 1}`;
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      if (state.lineTool === "draw") return; // the canvas handler places points instead
      beginPointDrag(event, stroke, index);
    });
    handle.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (stroke.points.length <= 2) {
        toast("Eine Linie braucht mindestens zwei Punkte.", true);
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
    toast("Keine Linie hat einen aktiven Fluss.", true);
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
             external: true, extra: {} };
    state.project.images.push(entry);
  } else {
    entry.file_path = filePath;
    entry.external = true;
  }
  return entry;
}

function uniqueWidgetId(base) {
  const ids = new Set(allWidgets().map((widget) => widget.id));
  let n = 1;
  let candidate = `${base}_${n}`;
  while (ids.has(candidate)) { n += 1; candidate = `${base}_${n}`; }
  return candidate;
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
    toast("Diese Linie hat noch keine Geometrie.", true);
    return;
  }
  if (!state.capabilities["designer.asset_write"]) {
    toast("Fehlende Berechtigung: Bilder können nicht in die Konfiguration geschrieben werden.", true);
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
    toast("Bilder werden erzeugt …");
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
    state.project.widgets.push(newImageWidget(uniqueWidgetId(baseName), staticRect, staticImageId));
    if (animimgWidget) state.project.widgets.push(animimgWidget);
    markProjectDirty();
    renderDesigner();
    toast(`${1 + (animimgWidget ? 1 : 0)} Widget(s) mit ${1 + frameCount} Bild(ern) angelegt.`);
  } catch (error) {
    toast(`Bildsequenz konnte nicht erzeugt werden: ${error.message}`, true);
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
  node.style.opacity = widget.hidden ? "0.35" : "1";
  if (widget.locked) node.classList.add("locked");
  const effectiveStyle = effectiveStyleTree(widget);
  if (effectiveStyle.bg_color) {
    const color = String(effectiveStyle.bg_color).replace("#", "");
    if (/^[0-9a-f]{6}$/i.test(color)) node.style.backgroundColor = `#${color}`;
  }
  const imageSource = widget.widget_type === "image"
    ? displayableImageSource(widget.properties.src)
    : null;
  if (imageSource) {
    const picture = document.createElement("img");
    picture.className = "widget-image";
    picture.src = imageSource;
    picture.draggable = false;
    picture.alt = "";
    // Fall back to a label if the URL cannot be loaded in the browser. Replace
    // only the image - setting textContent here would drop the resize handle.
    picture.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.textContent = `${widget.properties.src || widget.id} ⚠`;
      picture.replaceWith(fallback);
      node.title = "Bild konnte im Editor nicht geladen werden.";
    });
    node.append(picture);
  } else {
    node.textContent = widget.properties.text || widget.id;
  }
  node.addEventListener("pointerdown", (event) => beginDrag(event, widget, node, item));
  if (state.selectedWidget === widget && !widget.locked && !managed) {
    const handle = document.createElement("span");
    handle.className = "resize-handle";
    handle.addEventListener("pointerdown", (event) => beginResize(event, widget, node));
    node.append(handle);
  }
  return node;
}

function effectiveStyleTree(widget) {
  if (widget.style_mode !== "named") return widget.style_tree || {};
  const merged = {};
  (widget.style_refs || []).forEach((ref) => {
    const entry = styleLibrary().find((item) => item.id === ref);
    if (entry) Object.assign(merged, entry.style_tree || {});
  });
  return merged;
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
    toast("Position wird vom Layout des Elternteils bestimmt.");
    return;
  }
  pushUndo();
  const origin = {
    clientX: event.clientX, clientY: event.clientY,
    x: Number(widget.x) || 0, y: Number(widget.y) || 0,
  };
  node.setPointerCapture(event.pointerId);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", end, { once: true });
  function move(moveEvent) {
    const deltaX = (moveEvent.clientX - origin.clientX) / state.zoom;
    const deltaY = (moveEvent.clientY - origin.clientY) / state.zoom;
    widget.x = clamp(Math.round(origin.x + deltaX), 0, state.project.canvas.width - box.width);
    widget.y = clamp(Math.round(origin.y + deltaY), 0, state.project.canvas.height - box.height);
    // x/y are relative to the origin the layout gave this widget, which is not
    // the canvas origin once it sits inside a padded or aligned parent.
    node.style.left = `${box.originX + widget.x}px`;
    node.style.top = `${box.originY + widget.y}px`;
    $("#prop-x").value = widget.x;
    $("#prop-y").value = widget.y;
    markProjectDirty();
  }
  function end() { node.removeEventListener("pointermove", move); }
}

function beginResize(event, widget, node) {
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
    node.style.width = `${widget.width}px`;
    node.style.height = `${widget.height}px`;
    $("#prop-width").value = widget.width;
    $("#prop-height").value = widget.height;
    markProjectDirty();
  }
  function end() { event.target.removeEventListener("pointermove", resize); }
}

function renderProperties() {
  const widget = state.canvasMode === "lines" ? null : state.selectedWidget;
  $("#empty-properties").classList.toggle("hidden", state.canvasMode === "lines" || Boolean(widget));
  $("#properties").classList.toggle("hidden", !widget);
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
  renderExtraKeys(widget);
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
    toast("Dieses Widget hat noch keinen eigenen Stil zum Speichern.", true);
    return;
  }
  const suggestion = `style_${styleLibrary().length + 1}`;
  const name = (prompt("Name für den neuen Stil:", suggestion) || "").trim();
  if (!name) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    toast("Stilname muss mit einem Buchstaben beginnen (nur A-Z, 0-9, _).", true);
    return;
  }
  if (styleLibrary().some((entry) => entry.id === name)) {
    toast(`Ein Stil namens ${name} existiert bereits.`, true);
    return;
  }
  pushUndo();
  styleLibrary().push({ id: name, style_tree: JSON.parse(JSON.stringify(widget.style_tree)) });
  widget.style_tree = {};
  widget.style_mode = "named";
  widget.style_refs = [name];
  markProjectDirty();
  renderDesigner();
  toast(`Stil ${name} gespeichert und zugewiesen.`);
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
  label.textContent = property.label;
  const target = propertyTarget(widget, property, false, targetKind);
  const value = target?.[property.key];
  const control = propertyControl(property, value, index);
  control.addEventListener("focus", pushUndo);
  control.addEventListener("change", () => updateDynamicProperty(widget, property, control, targetKind));
  control.addEventListener("input", () => updateDynamicProperty(widget, property, control, targetKind));
  if (property.kind === "bool") label.className = "checkbox-field";
  label.append(control);
  return label;
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
  state.states.forEach((name) => select.append(new Option(name, name)));
  select.value = state.activeState;
}

function changeActiveState() {
  state.activeState = $("#style-state").value;
  renderProperties();
}

function renderGridCellSection(widget) {
  const section = $("#grid-cell-section");
  const parent = findParent(state.project.widgets, widget);
  const parentLayout = parent ? parent.layout : (state.project.extra_lvgl || {}).layout;
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

function isRemoteAsset(path) {
  return /^https?:\/\//i.test(String(path || ""));
}

// The canvas can only show sources the browser itself can fetch, i.e. URLs.
function displayableImageSource(id) {
  const entry = imageEntry(id);
  return entry && isRemoteAsset(entry.file_path) ? entry.file_path : null;
}

function addImageSource() {
  const url = (prompt("Bildquelle als http(s)-URL:", "https://") || "").trim();
  if (!url || url === "https://") return null;
  if (!isRemoteAsset(url)) {
    toast("Nur http(s)-URLs werden unterstützt - lokale Dateien liest das Add-on bewusst nicht.", true);
    return null;
  }
  const base = (url.split("/").pop() || "bild").replace(/\.[^.]*$/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "bild";
  let id = `img_${slug}`;
  let counter = 2;
  while (imageEntry(id)) id = `img_${slug}_${counter++}`;
  imageLibrary().push({ id, file_path: url, resize: "", dither: "", transparency: "opaque" });
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
  if (key === "id") widget.id = event.target.value;
  else if (["width", "height"].includes(key)) widget[key] = Math.max(1, Number(event.target.value));
  else widget[key] = Number(event.target.value);
  markProjectDirty();
  renderCanvas();
  renderTree();
}

function deleteSelectedWidget() {
  if (!state.selectedWidget) return;
  pushUndo();
  removeWidget(state.project.widgets, state.selectedWidget);
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

function renderTree() {
  const tree = $("#widget-tree");
  tree.replaceChildren();
  const widgets = allWidgets();
  const strokes = state.project.glow_strokes || [];
  tree.classList.toggle("empty", widgets.length === 0 && strokes.length === 0);
  if (!widgets.length && !strokes.length) {
    tree.textContent = "Noch keine Widgets";
    return;
  }

  const appendNodes = (nodes, depth = 0) => nodes.forEach((widget) => {
    const item = document.createElement("div");
    item.className = `tree-item${state.canvasMode === "widgets" && state.selectedWidget === widget ? " selected" : ""}`;
    item.style.paddingLeft = `${9 + depth * 16}px`;

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `${widget.id} · ${widget.widget_type}`;
    label.addEventListener("click", () => {
      if (state.canvasMode !== "widgets") setCanvasMode("widgets");
      state.selectedWidget = widget;
      renderDesigner();
    });

    const glyphs = document.createElement("span");
    glyphs.className = "tree-glyphs";
    glyphs.append(
      treeGlyph(widget, "hidden", widget.hidden ? "🙈" : "👁", widget.hidden ? "Einblenden" : "Ausblenden"),
      treeGlyph(widget, "locked", widget.locked ? "🔒" : "🔓", widget.locked ? "Entsperren" : "Sperren"),
    );

    item.append(label, glyphs);
    tree.append(item);
    appendNodes(widget.children || [], depth + 1);
  });
  appendNodes(state.project.widgets);

  if (strokes.length) {
    const heading = document.createElement("div");
    heading.className = "tree-subheading";
    heading.textContent = "Glow-Linien";
    tree.append(heading);

    strokes.forEach((stroke) => {
      const item = document.createElement("div");
      item.className = `tree-item${state.canvasMode === "lines" && state.selectedStroke === stroke ? " selected" : ""}`;
      item.style.paddingLeft = "9px";

      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = `∿ ${stroke.name || stroke.id}`;
      label.title = "Zur Bearbeitung in den Glow-Linien-Modus wechseln";
      label.addEventListener("click", () => {
        setCanvasMode("lines");
        setLineTool("select");
        state.selectedStroke = stroke;
        renderDesigner();
      });

      item.append(label);
      tree.append(item);
    });
  }
}

function treeGlyph(widget, flag, symbol, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tree-glyph${widget[flag] ? " active" : ""}`;
  button.textContent = symbol;
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

async function exportDesignerYaml() {
  $("#designer-status").textContent = "Projekt wird geprüft …";
  try {
    const result = await api("designer/projects/export-yaml", {
      method: "POST", body: JSON.stringify({ project: state.project }),
    });
    $("#yaml-output").textContent = result.yaml;
    renderExportIssues(result.issues || []);
    $("#yaml-dialog").showModal();
    renderDesignerStatus();
  } catch (error) {
    $("#designer-status").textContent = "Export fehlgeschlagen";
    renderExportIssues(error.details?.issues || []);
    toast(error.message, true);
  }
}

function renderExportIssues(issues) {
  renderIssues($("#yaml-issues"), issues, "beim Export");
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
    ? `${notable.length} Hinweis(e) ${context}`.trim()
    : `${preserved} Eigenschaft(en) unverändert übernommen`;
  container.append(heading);

  if (notable.length && preserved) {
    const note = document.createElement("div");
    note.className = "import-warning";
    note.textContent = `Zusätzlich ${preserved} Eigenschaft(en) unverändert übernommen.`;
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
  $("#show-diff").addEventListener("click", showDiff);
  $("#publish").addEventListener("click", publishDraft);
}

async function loadConfigurations() {
  try {
    const result = await api("configurations");
    state.configurations = result.configurations;
    const list = $("#config-list");
    list.replaceChildren();
    list.classList.toggle("empty", result.configurations.length === 0);
    if (!result.configurations.length) {
      list.textContent = "Keine ESPHome-YAML-Dateien gefunden.";
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
      button.addEventListener("click", () => loadConfiguration(configuration));
      list.append(button);
    });
  } catch (error) { toast(error.message, true); }
}

async function loadConfiguration(configuration) {
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
    $("#yaml-editor").disabled = !state.capabilities["configuration.write_draft"];
    $("#save-draft").disabled = !state.capabilities["configuration.write_draft"];
    $("#check-yaml").disabled = false;
    $("#show-diff").disabled = !state.hasDraft;
    $("#publish").disabled = !state.hasDraft || !state.capabilities["configuration.publish"];
    $("#config-output").classList.add("hidden");
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
    $("#show-diff").disabled = false;
    $("#publish").disabled = !state.capabilities["configuration.publish"];
    toast("Entwurf gespeichert.");
    await loadConfigurations();
  } catch (error) { toast(error.message, true); }
}

async function checkYaml() {
  if (!state.activeConfig) return;
  try {
    const source = state.hasDraft ? "draft" : "active";
    const result = await api(`configurations/${encodedName(state.activeConfig)}/check-yaml?source=${source}`, { method: "POST" });
    const output = $("#config-output");
    output.textContent = result.valid ? `✓ YAML-Syntax gültig\nRevision: ${result.revision}` : `Fehler in Zeile ${result.line}, Spalte ${result.column}\n${result.error}`;
    output.classList.remove("hidden");
  } catch (error) { toast(error.message, true); }
}

async function showDiff() {
  if (!state.activeConfig || !state.hasDraft) return;
  try {
    const result = await api(`configurations/${encodedName(state.activeConfig)}/diff`);
    const output = $("#config-output");
    output.textContent = result.diff || "Keine Unterschiede.";
    output.classList.remove("hidden");
  } catch (error) { toast(error.message, true); }
}

async function publishDraft() {
  if (!state.activeConfig || !state.hasDraft) return;
  if (!confirm(`Entwurf für ${state.activeConfig} in die aktive ESPHome-Konfiguration veröffentlichen?`)) return;
  try {
    const result = await api(`configurations/${encodedName(state.activeConfig)}/publish`, {
      method: "POST", body: JSON.stringify({ expected_revision: state.activeRevision }),
    });
    state.activeRevision = result.revision;
    state.hasDraft = false;
    $("#revision").textContent = result.revision;
    $("#show-diff").disabled = true;
    $("#publish").disabled = true;
    toast("Konfiguration atomar veröffentlicht.");
    await loadConfigurations();
  } catch (error) { toast(error.message, true); }
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum);
}

// Read-only debug handle - not part of the app's own logic, only for
// inspecting state from the browser console or an automated check.
window.__appState = state;

initialize();
