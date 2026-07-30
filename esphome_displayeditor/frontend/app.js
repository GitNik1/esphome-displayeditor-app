const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  system: null,
  capabilities: {},
  schemas: [],
  selectedWidget: null,
  activeConfig: null,
  activeRevision: null,
  hasDraft: false,
  project: freshProject(),
};

function freshProject() {
  return {
    format: "esphome-lvgl-designer-project",
    format_version: 1,
    canvas: { width: 480, height: 480 },
    background: { path: "", export_as_lvgl_image: false, image_id: "bg_image", opacity_in_editor: 40 },
    display_id_placeholder: "my_display",
    default_font: "",
    widgets: [],
    styles: [],
    fonts: [],
    images: [],
    colors: [],
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
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
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

async function initialize() {
  bindTabs();
  bindDesigner();
  bindConfigurations();
  try {
    const [health, system, capabilityData, schemaData] = await Promise.all([
      api("health"), api("system"), api("capabilities"), api("designer/schemas?language=de"),
    ]);
    state.system = system;
    state.capabilities = capabilityData.capabilities;
    state.schemas = schemaData.widgets;
    $("#health").classList.toggle("ok", health.status === "ok");
    $("#profile").textContent = `${system.profile} · ${system.user.display_name || system.user.name || "Ingress"}`;
    $("#system-json").textContent = JSON.stringify({ system, ...capabilityData }, null, 2);
    renderPalette();
    await loadConfigurations();
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
  }));
}

function bindDesigner() {
  $("#canvas-width").addEventListener("change", updateCanvasSize);
  $("#canvas-height").addEventListener("change", updateCanvasSize);
  $("#new-project").addEventListener("click", () => {
    if (state.project.widgets.length && !confirm("Aktuelles Design verwerfen?")) return;
    state.project = freshProject();
    state.selectedWidget = null;
    renderDesigner();
  });
  $("#open-project").addEventListener("click", () => $("#project-file").click());
  $("#project-file").addEventListener("change", openDesignerProject);
  $("#save-project").addEventListener("click", saveDesignerProject);
  $("#export-project").addEventListener("click", exportDesignerYaml);
  $("#delete-widget").addEventListener("click", deleteSelectedWidget);
  ["id", "x", "y", "width", "height", "text", "color"].forEach((key) => {
    $(`#prop-${key}`).addEventListener("input", updateSelectedWidget);
  });
  $("#close-dialog").addEventListener("click", () => $("#yaml-dialog").close());
  $("#copy-yaml").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#yaml-output").textContent);
    toast("YAML wurde kopiert.");
  });
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
    state.project = project;
    state.selectedWidget = null;
    renderDesigner();
    toast("Projekt geladen.");
  } catch (error) {
    toast(`Projekt konnte nicht geladen werden: ${error.message}`, true);
  }
}

function saveDesignerProject() {
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "display.lvgldesign";
  link.click();
  URL.revokeObjectURL(url);
  toast("Projektdatei gespeichert.");
}

function updateCanvasSize() {
  state.project.canvas.width = clamp(Number($("#canvas-width").value), 1, 4096);
  state.project.canvas.height = clamp(Number($("#canvas-height").value), 1, 4096);
  renderDesigner();
}

function renderPalette() {
  const palette = $("#palette");
  palette.replaceChildren();
  const icons = { obj: "▣", container: "▤", label: "T", button: "▰", switch: "◉", slider: "━", image: "▧" };
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

function addWidget(schema) {
  const idBase = schema.type_key === "container" ? "container" : schema.type_key;
  let number = 1;
  const ids = new Set(state.project.widgets.map((widget) => widget.id));
  while (ids.has(`${idBase}_${number}`)) number += 1;
  const properties = {};
  for (const property of schema.properties) {
    if (property.category === "content" && property.default !== null) properties[property.key] = property.default;
  }
  const widget = {
    id: `${idBase}_${number}`,
    widget_type: schema.type_key,
    name: "",
    x: 20 + (state.project.widgets.length * 12) % 100,
    y: 20 + (state.project.widgets.length * 12) % 100,
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
  };
  state.project.widgets.push(widget);
  state.selectedWidget = widget;
  renderDesigner();
}

function renderDesigner() {
  const canvas = $("#canvas");
  canvas.style.width = `${state.project.canvas.width}px`;
  canvas.style.height = `${state.project.canvas.height}px`;
  $("#canvas-width").value = state.project.canvas.width;
  $("#canvas-height").value = state.project.canvas.height;
  canvas.replaceChildren();
  state.project.widgets.forEach((widget) => canvas.append(renderWidget(widget)));
  $("#widget-count").textContent = `${state.project.widgets.length} Widgets`;
  renderProperties();
  renderTree();
}

function renderWidget(widget) {
  const node = document.createElement("div");
  node.className = `canvas-widget${state.selectedWidget === widget ? " selected" : ""}`;
  node.dataset.type = widget.widget_type;
  node.style.left = `${Number(widget.x) || 0}px`;
  node.style.top = `${Number(widget.y) || 0}px`;
  node.style.width = `${Number(widget.width) || 1}px`;
  node.style.height = `${Number(widget.height) || 1}px`;
  if (widget.style_tree.bg_color) node.style.backgroundColor = `#${widget.style_tree.bg_color.replace("#", "")}`;
  node.textContent = widget.properties.text || widget.id;
  node.addEventListener("pointerdown", (event) => beginDrag(event, widget, node));
  return node;
}

function beginDrag(event, widget, node) {
  state.selectedWidget = widget;
  renderProperties();
  renderTree();
  $$(".canvas-widget").forEach((item) => item.classList.toggle("selected", item === node));
  const origin = { clientX: event.clientX, clientY: event.clientY, x: Number(widget.x), y: Number(widget.y) };
  node.setPointerCapture(event.pointerId);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", end, { once: true });
  function move(moveEvent) {
    widget.x = clamp(Math.round(origin.x + moveEvent.clientX - origin.clientX), 0, state.project.canvas.width - Number(widget.width));
    widget.y = clamp(Math.round(origin.y + moveEvent.clientY - origin.clientY), 0, state.project.canvas.height - Number(widget.height));
    node.style.left = `${widget.x}px`;
    node.style.top = `${widget.y}px`;
    $("#prop-x").value = widget.x;
    $("#prop-y").value = widget.y;
  }
  function end() { node.removeEventListener("pointermove", move); }
}

function renderProperties() {
  const widget = state.selectedWidget;
  $("#empty-properties").classList.toggle("hidden", Boolean(widget));
  $("#properties").classList.toggle("hidden", !widget);
  if (!widget) return;
  $("#prop-id").value = widget.id;
  $("#prop-x").value = widget.x;
  $("#prop-y").value = widget.y;
  $("#prop-width").value = widget.width;
  $("#prop-height").value = widget.height;
  $("#prop-text").value = widget.properties.text || "";
  $("#text-field").classList.toggle("hidden", !("text" in widget.properties));
  $("#prop-color").value = `#${widget.style_tree.bg_color || "263345"}`;
}

function updateSelectedWidget(event) {
  const widget = state.selectedWidget;
  if (!widget) return;
  const key = event.target.id.replace("prop-", "");
  if (key === "text") widget.properties.text = event.target.value;
  else if (key === "color") widget.style_tree.bg_color = event.target.value.slice(1).toUpperCase();
  else if (key === "id") widget.id = event.target.value;
  else widget[key] = Number(event.target.value);
  renderDesigner();
}

function deleteSelectedWidget() {
  if (!state.selectedWidget) return;
  state.project.widgets = state.project.widgets.filter((widget) => widget !== state.selectedWidget);
  state.selectedWidget = null;
  renderDesigner();
}

function renderTree() {
  const tree = $("#widget-tree");
  tree.replaceChildren();
  tree.classList.toggle("empty", state.project.widgets.length === 0);
  if (!state.project.widgets.length) {
    tree.textContent = "Noch keine Widgets";
    return;
  }
  state.project.widgets.forEach((widget) => {
    const item = document.createElement("div");
    item.className = `tree-item${state.selectedWidget === widget ? " selected" : ""}`;
    item.textContent = `${widget.id} · ${widget.widget_type}`;
    item.addEventListener("click", () => { state.selectedWidget = widget; renderDesigner(); });
    tree.append(item);
  });
}

async function exportDesignerYaml() {
  $("#designer-status").textContent = "Projekt wird geprüft …";
  try {
    const result = await api("designer/projects/export-yaml", {
      method: "POST", body: JSON.stringify({ project: state.project }),
    });
    $("#yaml-output").textContent = result.yaml;
    $("#yaml-dialog").showModal();
    $("#designer-status").textContent = "YAML erfolgreich erzeugt";
  } catch (error) {
    $("#designer-status").textContent = "Export fehlgeschlagen";
    toast(error.message, true);
  }
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

initialize();
