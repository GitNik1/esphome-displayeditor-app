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
  projectName: null,
  projectRevision: null,
  projectDirty: false,
  undo: [],
  redo: [],
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
    await Promise.all([loadConfigurations(), loadServerProjects()]);
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
  $("#close-dialog").addEventListener("click", () => $("#yaml-dialog").close());
  $("#copy-yaml").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#yaml-output").textContent);
    toast("YAML wurde kopiert.");
  });
  document.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || !$("#designer").classList.contains("active")) return;
    if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoDesignerChange();
    } else if (event.key.toLowerCase() === "y") {
      event.preventDefault();
      redoDesignerChange();
    }
  });
}

function newDesignerProject() {
  if (state.projectDirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
  state.project = freshProject();
  state.projectName = null;
  state.projectRevision = null;
  state.projectDirty = false;
  state.selectedWidget = null;
  resetHistory();
  $("#project-name").value = "display.lvgldesign";
  renderDesigner();
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
    state.project = result.project;
    state.projectName = null;
    state.projectRevision = null;
    state.projectDirty = false;
    state.selectedWidget = null;
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
    state.project = result.project;
    state.projectName = result.name;
    state.projectRevision = result.revision;
    state.projectDirty = false;
    state.selectedWidget = null;
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
  if (name.endsWith(".lvgldesign")) name = name.slice(0, -".lvgldesign".length);
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

function undoDesignerChange() {
  if (!state.undo.length) return;
  const selectedId = state.selectedWidget?.id;
  state.redo.push(JSON.stringify(state.project));
  state.project = JSON.parse(state.undo.pop());
  state.selectedWidget = selectedId
    ? allWidgets().find((widget) => widget.id === selectedId) || null
    : null;
  markProjectDirty();
  renderDesigner();
}

function redoDesignerChange() {
  if (!state.redo.length) return;
  const selectedId = state.selectedWidget?.id;
  state.undo.push(JSON.stringify(state.project));
  state.project = JSON.parse(state.redo.pop());
  state.selectedWidget = selectedId
    ? allWidgets().find((widget) => widget.id === selectedId) || null
    : null;
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
  };
  target.push(widget);
  state.selectedWidget = widget;
  markProjectDirty();
  renderDesigner();
}

function visualWidgets() {
  const result = [];
  const visit = (nodes, offsetX = 0, offsetY = 0, depth = 0) => nodes.forEach((widget) => {
    const left = offsetX + (Number(widget.x) || 0);
    const top = offsetY + (Number(widget.y) || 0);
    result.push({ widget, left, top, offsetX, offsetY, depth });
    visit(widget.children || [], left, top, depth + 1);
  });
  visit(state.project.widgets);
  return result;
}

function renderDesigner() {
  renderCanvas();
  renderProperties();
  renderTree();
  renderDesignerStatus();
  updateUndoButtons();
}

function renderCanvas() {
  const canvas = $("#canvas");
  canvas.style.width = `${state.project.canvas.width}px`;
  canvas.style.height = `${state.project.canvas.height}px`;
  $("#canvas-width").value = state.project.canvas.width;
  $("#canvas-height").value = state.project.canvas.height;
  canvas.replaceChildren();
  visualWidgets().forEach((item) => canvas.append(renderWidget(item)));
  $("#widget-count").textContent = `${allWidgets().length} Widgets`;
}

function renderDesignerStatus() {
  const name = state.projectName || "Lokales Projekt";
  $("#designer-status").textContent = `${state.projectDirty ? "● Ungespeichert · " : ""}${name}`;
}

function renderWidget(item) {
  const { widget, left, top, offsetX, offsetY } = item;
  const node = document.createElement("div");
  node.className = `canvas-widget${state.selectedWidget === widget ? " selected" : ""}`;
  node.dataset.type = widget.widget_type;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.width = `${Number(widget.width) || 1}px`;
  node.style.height = `${Number(widget.height) || 1}px`;
  node.style.opacity = widget.hidden ? "0.35" : "1";
  if (widget.style_tree.bg_color) {
    const color = String(widget.style_tree.bg_color).replace("#", "");
    if (/^[0-9a-f]{6}$/i.test(color)) node.style.backgroundColor = `#${color}`;
  }
  node.textContent = widget.properties.text || widget.id;
  node.addEventListener("pointerdown", (event) => beginDrag(event, widget, node, offsetX, offsetY));
  if (state.selectedWidget === widget && !widget.locked) {
    const handle = document.createElement("span");
    handle.className = "resize-handle";
    handle.addEventListener("pointerdown", (event) => beginResize(event, widget, node));
    node.append(handle);
  }
  return node;
}

function beginDrag(event, widget, node, offsetX, offsetY) {
  if (event.target.classList.contains("resize-handle")) return;
  state.selectedWidget = widget;
  renderProperties();
  renderTree();
  $$(".canvas-widget").forEach((item) => item.classList.toggle("selected", item === node));
  if (widget.locked) return;
  pushUndo();
  const origin = { clientX: event.clientX, clientY: event.clientY, x: Number(widget.x), y: Number(widget.y) };
  node.setPointerCapture(event.pointerId);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", end, { once: true });
  function move(moveEvent) {
    widget.x = clamp(Math.round(origin.x + moveEvent.clientX - origin.clientX), 0, state.project.canvas.width - Number(widget.width));
    widget.y = clamp(Math.round(origin.y + moveEvent.clientY - origin.clientY), 0, state.project.canvas.height - Number(widget.height));
    node.style.left = `${offsetX + widget.x}px`;
    node.style.top = `${offsetY + widget.y}px`;
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
    widget.width = clamp(Math.round(origin.width + moveEvent.clientX - origin.clientX), 8, 4096);
    widget.height = clamp(Math.round(origin.height + moveEvent.clientY - origin.clientY), 8, 4096);
    node.style.width = `${widget.width}px`;
    node.style.height = `${widget.height}px`;
    $("#prop-width").value = widget.width;
    $("#prop-height").value = widget.height;
    markProjectDirty();
  }
  function end() { event.target.removeEventListener("pointermove", resize); }
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
  renderDynamicProperties(widget);
}

function renderDynamicProperties(widget) {
  const container = $("#dynamic-properties");
  container.replaceChildren();
  const schema = state.schemas.find((item) => item.type_key === widget.widget_type);
  if (!schema) return;
  let previousSection = "";
  schema.properties.forEach((property, index) => {
    const section = property.category === "content" ? "Inhalt" : `Stil · ${property.part}`;
    if (section !== previousSection) {
      const heading = document.createElement("div");
      heading.className = "property-section";
      heading.textContent = section;
      container.append(heading);
      previousSection = section;
    }
    const label = document.createElement("label");
    label.textContent = property.label;
    const target = propertyTarget(widget, property, false);
    const value = target?.[property.key];
    const control = propertyControl(property, value, index);
    control.addEventListener("focus", pushUndo);
    control.addEventListener("change", () => updateDynamicProperty(widget, property, control));
    control.addEventListener("input", () => updateDynamicProperty(widget, property, control));
    if (property.kind === "bool") label.className = "checkbox-field";
    label.append(control);
    container.append(label);
  });
}

function propertyTarget(widget, property, create) {
  if (property.category === "content") return widget.properties;
  if (property.part === "main") return widget.style_tree;
  if (!widget.style_tree[property.part] && create) widget.style_tree[property.part] = {};
  return widget.style_tree[property.part];
}

function propertyControl(property, value, index) {
  let control;
  if (property.kind === "bool") {
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

function updateDynamicProperty(widget, property, control) {
  const target = propertyTarget(widget, property, true);
  let value;
  if (property.kind === "bool") value = control.checked;
  else if (["int", "float"].includes(property.kind)) value = control.value === "" ? null : Number(control.value);
  else value = control.value;
  if ((value === "" || value === null) && property.category === "style") delete target[property.key];
  else if (value === "" && property.kind === "enum") delete target[property.key];
  else target[property.key] = value;
  markProjectDirty();
  renderCanvas();
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
  tree.classList.toggle("empty", widgets.length === 0);
  if (!widgets.length) {
    tree.textContent = "Noch keine Widgets";
    return;
  }
  const appendNodes = (nodes, depth = 0) => nodes.forEach((widget) => {
    const item = document.createElement("div");
    item.className = `tree-item${state.selectedWidget === widget ? " selected" : ""}`;
    item.style.paddingLeft = `${9 + depth * 16}px`;
    item.textContent = `${widget.id} · ${widget.widget_type}${widget.locked ? " · 🔒" : ""}`;
    item.addEventListener("click", () => { state.selectedWidget = widget; renderDesigner(); });
    tree.append(item);
    appendNodes(widget.children || [], depth + 1);
  });
  appendNodes(state.project.widgets);
}

async function exportDesignerYaml() {
  $("#designer-status").textContent = "Projekt wird geprüft …";
  try {
    const result = await api("designer/projects/export-yaml", {
      method: "POST", body: JSON.stringify({ project: state.project }),
    });
    $("#yaml-output").textContent = result.yaml;
    $("#yaml-dialog").showModal();
    renderDesignerStatus();
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
