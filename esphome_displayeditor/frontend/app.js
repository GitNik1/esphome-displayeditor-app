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
  zoom: 1,
  backgroundPreview: null,
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

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
  $("#prop-locked").addEventListener("change", () => toggleWidgetFlag("locked"));
  $("#prop-hidden").addEventListener("change", () => toggleWidgetFlag("hidden"));
  $("#style-mode").addEventListener("change", changeStyleMode);
  $("#style-ref").addEventListener("change", changeStyleRef);
  $("#save-as-style").addEventListener("click", saveCurrentStyleAsNamed);

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
  $("#close-dialog").addEventListener("click", () => $("#yaml-dialog").close());
  $("#copy-yaml").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#yaml-output").textContent);
    toast("YAML wurde kopiert.");
  });
  document.addEventListener("keydown", (event) => {
    if (!$("#designer").classList.contains("active")) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

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
  state.project = freshProject();
  state.projectName = null;
  state.projectRevision = null;
  state.projectDirty = false;
  state.selectedWidget = null;
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
  renderBackgroundFields();
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
  canvas.replaceChildren(renderCanvasBackground());
  visualWidgets().forEach((item) => canvas.append(renderWidget(item)));
  $("#widget-count").textContent = `${allWidgets().length} Widgets`;
  applyZoom();
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
  node.addEventListener("pointerdown", (event) => beginDrag(event, widget, node, offsetX, offsetY));
  if (state.selectedWidget === widget && !widget.locked) {
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
    const deltaX = (moveEvent.clientX - origin.clientX) / state.zoom;
    const deltaY = (moveEvent.clientY - origin.clientY) / state.zoom;
    widget.x = clamp(Math.round(origin.x + deltaX), 0, state.project.canvas.width - Number(widget.width));
    widget.y = clamp(Math.round(origin.y + deltaY), 0, state.project.canvas.height - Number(widget.height));
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
  const widget = state.selectedWidget;
  $("#empty-properties").classList.toggle("hidden", Boolean(widget));
  $("#properties").classList.toggle("hidden", !widget);
  if (!widget) return;
  $("#prop-id").value = widget.id;
  $("#prop-x").value = widget.x;
  $("#prop-y").value = widget.y;
  $("#prop-width").value = widget.width;
  $("#prop-height").value = widget.height;
  $("#prop-locked").checked = Boolean(widget.locked);
  $("#prop-hidden").checked = Boolean(widget.hidden);
  renderStyleControls(widget);
  renderDynamicProperties(widget);
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

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = `${widget.id} · ${widget.widget_type}`;
    label.addEventListener("click", () => { state.selectedWidget = widget; renderDesigner(); });

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
  const container = $("#yaml-issues");
  container.replaceChildren();
  container.classList.toggle("hidden", issues.length === 0);
  if (!issues.length) return;
  const heading = document.createElement("strong");
  heading.textContent = `${issues.length} Hinweis(e) beim Export`;
  container.append(heading);
  const list = document.createElement("ul");
  issues.forEach((issue) => {
    const entry = document.createElement("li");
    // Validation issues use severity "error"; yamlexport uses "A" (blocking)
    // vs "B"/"C" (reported but non-fatal).
    const blocking = issue.severity === "error" || issue.severity === "A";
    entry.className = blocking ? "issue-error" : "issue-warning";
    const where = issue.widget_id || issue.widget || issue.resource || "";
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
