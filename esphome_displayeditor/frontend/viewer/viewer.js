import { computeLayout } from "../layout.js";
import { drawDocument, hasFlow } from "../glowline/renderer.js";

const SUPPORTED_WIDGETS = new Set([
  "obj", "container", "label", "button", "switch", "slider", "image", "animimg",
]);
const STYLE_BRANCHES = new Set([
  "states", "indicator", "knob", "items", "ticks", "selected", "scrollbar", "cursor",
]);

const clamp = (value, minimum, maximum) => (
  Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum)
);

export function cloneViewerProject(project) {
  return JSON.parse(JSON.stringify(project || {}));
}

function mergeStyle(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target;
  Object.entries(source).forEach(([key, value]) => {
    if (!STYLE_BRANCHES.has(key)) target[key] = value;
  });
  return target;
}

export function effectiveViewerStyle(project, widget, activeState = "") {
  const result = {};
  const activeStates = Array.isArray(activeState) ? activeState.filter(Boolean) : [activeState].filter(Boolean);
  const theme = project.theme?.[widget.widget_type];
  mergeStyle(result, theme);

  if (widget.style_mode === "named") {
    (widget.style_refs || []).forEach((reference) => {
      const entry = (project.styles || []).find((style) => style.id === reference);
      mergeStyle(result, entry?.style_tree);
    });
  }
  mergeStyle(result, widget.style_tree);

  activeStates.forEach((state) => {
    mergeStyle(result, theme?.states?.[state]);
    if (widget.style_mode === "named") {
      (widget.style_refs || []).forEach((reference) => {
        const entry = (project.styles || []).find((style) => style.id === reference);
        mergeStyle(result, entry?.style_tree?.states?.[state]);
      });
    }
    mergeStyle(result, widget.style_tree?.states?.[state]);
  });
  return result;
}

export function effectiveViewerPartStyle(project, widget, part, activeState = "") {
  const result = {};
  const activeStates = Array.isArray(activeState) ? activeState.filter(Boolean) : [activeState].filter(Boolean);
  const theme = project.theme?.[widget.widget_type];
  mergeStyle(result, theme?.[part]);
  if (widget.style_mode === "named") {
    (widget.style_refs || []).forEach((reference) => {
      const entry = (project.styles || []).find((style) => style.id === reference);
      mergeStyle(result, entry?.style_tree?.[part]);
    });
  }
  mergeStyle(result, widget.style_tree?.[part]);
  activeStates.forEach((state) => {
    mergeStyle(result, theme?.states?.[state]?.[part]);
    if (widget.style_mode === "named") {
      (widget.style_refs || []).forEach((reference) => {
        const entry = (project.styles || []).find((style) => style.id === reference);
        mergeStyle(result, entry?.style_tree?.states?.[state]?.[part]);
      });
    }
    mergeStyle(result, widget.style_tree?.states?.[state]?.[part]);
  });
  return result;
}

export function resolveViewerColor(project, value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  const libraryEntry = (project.colors || []).find((entry) => entry.id === raw);
  const candidate = String(libraryEntry?.hex || raw).trim()
    .replace(/^#/, "")
    .replace(/^0x/i, "");
  if (/^[0-9a-f]{6}$/i.test(candidate)) return `#${candidate.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(candidate)) return `#${candidate.toUpperCase()}`;
  return null;
}

function viewerOpacity(value) {
  if (value === null || value === undefined || value === "") return null;
  const upper = String(value).trim().toUpperCase();
  if (upper === "COVER") return 1;
  if (upper === "TRANSP") return 0;
  const number = Number.parseFloat(upper.replace("%", ""));
  if (!Number.isFinite(number)) return null;
  return clamp(number > 1 ? number / 100 : number, 0, 1);
}

function colorWithOpacity(color, opacity) {
  if (!color || opacity === null || opacity >= 1) return color;
  const hex = color.replace("#", "");
  const expanded = hex.length === 3 ? hex.split("").map((character) => character + character).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return color;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${clamp(opacity, 0, 1)})`;
}

function viewerFont(project, reference) {
  if (!reference) return null;
  const raw = String(reference);
  const entry = (project.fonts || []).find((font) => font.id === raw);
  const inferredSize = Number.parseInt(raw.match(/(\d+)(?!.*\d)/)?.[1] || "", 10);
  return {
    family: entry?.gfonts_family || entry?.builtin_name || null,
    size: Number(entry?.size) || inferredSize || null,
    weight: Number(entry?.gfonts_weight) || null,
    italic: Boolean(entry?.gfonts_italic),
  };
}

function imageSource(project, id) {
  const entry = (project.images || []).find((image) => image.id === id);
  const source = String(entry?.file_path || "");
  return /^https?:\/\//i.test(source) ? source : null;
}

function allWidgetItems(project) {
  const boxes = computeLayout(project);
  const result = [];
  const visit = (widgets, ancestorHidden = false) => {
    (widgets || []).forEach((widget) => {
      const hidden = ancestorHidden || Boolean(widget.hidden);
      const box = boxes.get(widget) || {
        left: Number(widget.x) || 0,
        top: Number(widget.y) || 0,
        width: Number(widget.width) || 100,
        height: Number(widget.height) || 40,
      };
      result.push({ widget, box, hidden });
      visit(widget.children, hidden);
    });
  };
  visit(project.widgets);
  return result;
}

function applyStyleObject(node, project, style) {
  const background = resolveViewerColor(project, style.bg_color);
  const gradient = resolveViewerColor(project, style.bg_grad_color);
  const border = resolveViewerColor(project, style.border_color);
  const shadow = resolveViewerColor(project, style.shadow_color);
  const text = resolveViewerColor(project, style.text_color);
  const opacity = viewerOpacity(style.opa);
  const backgroundOpacity = viewerOpacity(style.bg_opa);
  const shadowOpacity = viewerOpacity(style.shadow_opa);

  if (background) node.style.backgroundColor = colorWithOpacity(background, backgroundOpacity);
  if (background && gradient && ["HOR", "VER"].includes(String(style.bg_grad_dir).toUpperCase())) {
    const direction = String(style.bg_grad_dir).toUpperCase() === "HOR" ? "to right" : "to bottom";
    node.style.backgroundImage = `linear-gradient(${direction}, ${colorWithOpacity(background, backgroundOpacity)}, ${colorWithOpacity(gradient, backgroundOpacity)})`;
  }
  if (border) node.style.borderColor = border;
  if (style.border_width !== undefined) node.style.borderWidth = `${Math.max(0, Number(style.border_width) || 0)}px`;
  if (style.radius !== undefined) node.style.borderRadius = `${Math.max(0, Number(style.radius) || 0)}px`;
  if (text) node.style.color = text;
  if (style.text_align) node.style.textAlign = String(style.text_align).toLowerCase();
  const font = viewerFont(project, style.text_font);
  if (font?.family) node.style.fontFamily = JSON.stringify(font.family);
  if (font?.size) node.style.fontSize = `${font.size}px`;
  if (font?.weight) node.style.fontWeight = String(font.weight);
  if (font?.italic) node.style.fontStyle = "italic";
  if (style.text_letter_space !== undefined) node.style.letterSpacing = `${Number(style.text_letter_space) || 0}px`;
  if (style.text_line_space !== undefined) {
    const size = font?.size || Number.parseFloat(getComputedStyle(node).fontSize) || 16;
    node.style.lineHeight = `${Math.max(1, size + (Number(style.text_line_space) || 0))}px`;
  }
  const allPadding = Math.max(0, Number(style.pad_all) || 0);
  node.style.paddingTop = `${Math.max(0, Number(style.pad_top ?? allPadding) || 0)}px`;
  node.style.paddingRight = `${Math.max(0, Number(style.pad_right ?? allPadding) || 0)}px`;
  node.style.paddingBottom = `${Math.max(0, Number(style.pad_bottom ?? allPadding) || 0)}px`;
  node.style.paddingLeft = `${Math.max(0, Number(style.pad_left ?? allPadding) || 0)}px`;
  if (style.pad_row !== undefined) node.style.rowGap = `${Math.max(0, Number(style.pad_row) || 0)}px`;
  if (style.pad_column !== undefined) node.style.columnGap = `${Math.max(0, Number(style.pad_column) || 0)}px`;
  if (opacity !== null) node.style.opacity = String(opacity);
  if (shadow && Number(style.shadow_width) > 0) {
    const x = Number(style.shadow_offset_x) || 0;
    const y = Number(style.shadow_offset_y) || 0;
    const blur = Math.max(0, Number(style.shadow_width) || 0);
    const spread = Math.max(0, Number(style.shadow_spread) || 0);
    node.style.boxShadow = `${x}px ${y}px ${blur}px ${spread}px ${colorWithOpacity(shadow, shadowOpacity)}`;
  }
}

function applyStyle(node, project, widget, activeState = "") {
  applyStyleObject(node, project, effectiveViewerStyle(project, widget, activeState));
}

function applyPartStyle(node, project, widget, part, activeState = "") {
  applyStyleObject(node, project, effectiveViewerPartStyle(project, widget, part, activeState));
}

function findWidget(project, id) {
  let found = null;
  const visit = (widgets) => {
    for (const widget of widgets || []) {
      if (String(widget.id || "") === String(id)) {
        found = widget;
        return;
      }
      visit(widget.children);
      if (found) return;
    }
  };
  visit(project.widgets);
  return found;
}

function actionIds(payload) {
  if (["string", "number"].includes(typeof payload)) return [String(payload)];
  if (Array.isArray(payload)) return payload.flatMap(actionIds);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return actionIds(payload.id);
  }
  return [];
}

function updatePayloads(payload) {
  return (Array.isArray(payload) ? payload : [payload])
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}

function safeLiteral(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function applyViewerAction(project, action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { handled: false, changed: false, message: "Ungültiger Aktionseintrag übersprungen." };
  }
  const entries = Object.entries(action);
  if (entries.length !== 1) {
    return { handled: false, changed: false, message: "Mehrdeutiger Aktionseintrag übersprungen." };
  }
  const [name, payload] = entries[0];

  if (["lvgl.widget.show", "lvgl.widget.hide"].includes(name)) {
    const hidden = name.endsWith(".hide");
    const ids = actionIds(payload);
    let changed = false;
    const missing = [];
    ids.forEach((id) => {
      const widget = findWidget(project, id);
      if (!widget) missing.push(id);
      else {
        widget.hidden = hidden;
        changed = true;
      }
    });
    if (!ids.length) return {
      handled: true, changed: false, warning: true, message: `${name}: keine gültige Widget-ID.`,
    };
    const suffix = missing.length ? `; nicht gefunden: ${missing.join(", ")}` : "";
    return {
      handled: true, changed, warning: Boolean(missing.length),
      message: `${name}: ${ids.join(", ")}${suffix}`,
    };
  }

  if (["lvgl.animation.start", "lvgl.animation.stop"].includes(name)) {
    const running = name.endsWith(".start");
    const ids = actionIds(payload);
    let changed = false;
    const rejected = [];
    ids.forEach((id) => {
      const widget = findWidget(project, id);
      if (!widget || widget.widget_type !== "animimg") rejected.push(id);
      else {
        widget.properties ||= {};
        widget.properties.auto_start = running;
        changed = true;
      }
    });
    const detail = rejected.length ? `; nicht als animimg gefunden: ${rejected.join(", ")}` : "";
    return {
      handled: true,
      changed,
      warning: Boolean(rejected.length || !ids.length),
      message: `${name}: ${ids.join(", ") || "keine gültige Widget-ID"}${detail}`,
    };
  }

  const updateKeys = {
    "lvgl.widget.update": new Set(["hidden", "text", "value", "state_checked"]),
    "lvgl.label.update": new Set(["text"]),
    "lvgl.slider.update": new Set(["value"]),
    "lvgl.switch.update": new Set(["state_checked"]),
  };
  if (updateKeys[name]) {
    let changed = false;
    const notes = [];
    const updates = updatePayloads(payload);
    updates.forEach((update) => {
      if (!safeLiteral(update.id)) {
        notes.push("fehlende ID");
        return;
      }
      const widget = findWidget(project, update.id);
      if (!widget) {
        notes.push(`${update.id}: nicht gefunden`);
        return;
      }
      Object.entries(update).forEach(([key, value]) => {
        if (key === "id") return;
        if (!updateKeys[name].has(key) || !safeLiteral(value)) {
          notes.push(`${widget.id}.${key}: nicht erlaubt`);
          return;
        }
        if (["hidden", "state_checked"].includes(key) && typeof value !== "boolean") {
          notes.push(`${widget.id}.${key}: Boolescher Wert erwartet`);
          return;
        }
        if (key === "value" && !Number.isFinite(Number(value))) {
          notes.push(`${widget.id}.${key}: numerischer Wert erwartet`);
          return;
        }
        if (key === "hidden") widget.hidden = value;
        else {
          widget.properties ||= {};
          if (key === "state_checked") widget.properties[key] = value;
          else if (key === "value") widget.properties[key] = Number(value);
          else widget.properties[key] = String(value ?? "");
        }
        changed = true;
      });
    });
    if (!updates.length) notes.push("keine gültigen Update-Daten");
    const detail = notes.length ? ` (${notes.join("; ")})` : "";
    return { handled: true, changed, warning: Boolean(notes.length), message: `${name}${detail}` };
  }

  return { handled: false, changed: false, message: `${name} wird im Browser nicht ausgeführt.` };
}

function textContent(widget) {
  return String(widget.properties?.text || widget.name || widget.id || "");
}

function renderImage(project, widget, sourceId) {
  const source = imageSource(project, sourceId);
  if (!source) {
    const fallback = document.createElement("span");
    fallback.className = "viewer-image-fallback";
    fallback.textContent = `${sourceId || widget.id} ⚠`;
    return fallback;
  }
  const image = document.createElement("img");
  image.className = "viewer-image";
  image.src = source;
  image.alt = "";
  image.draggable = false;
  image.addEventListener("error", () => {
    const fallback = document.createElement("span");
    fallback.className = "viewer-image-fallback";
    fallback.textContent = `${sourceId || widget.id} ⚠`;
    image.replaceWith(fallback);
  });
  return image;
}

function renderWidgetContent(project, widget, timers, activeStates = []) {
  if (["label", "button"].includes(widget.widget_type)) {
    const text = document.createElement("span");
    text.className = "viewer-widget-text";
    text.textContent = textContent(widget);
    return text;
  }
  if (widget.widget_type === "switch") {
    const indicator = document.createElement("span");
    indicator.className = "viewer-switch-indicator";
    const knob = document.createElement("span");
    knob.className = "viewer-switch-knob";
    indicator.append(knob);
    if (widget.properties?.state_checked) indicator.classList.add("checked");
    applyPartStyle(indicator, project, widget, "indicator", activeStates);
    applyPartStyle(knob, project, widget, "knob", activeStates);
    return indicator;
  }
  if (widget.widget_type === "slider") {
    const minimum = Number(widget.properties?.min_value) || 0;
    const maximum = Number(widget.properties?.max_value) || 100;
    const value = clamp(Number(widget.properties?.value) || 0, minimum, maximum);
    const percentage = maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 100;
    const control = document.createElement("span");
    control.className = "viewer-slider-control";
    const track = document.createElement("span");
    track.className = "viewer-slider-track";
    const fill = document.createElement("span");
    fill.className = "viewer-slider-fill";
    fill.style.width = `${percentage}%`;
    const knob = document.createElement("span");
    knob.className = "viewer-slider-knob";
    knob.style.left = `${percentage}%`;
    applyPartStyle(fill, project, widget, "indicator", activeStates);
    applyPartStyle(knob, project, widget, "knob", activeStates);
    const input = document.createElement("input");
    input.className = "viewer-slider-input";
    input.type = "range";
    input.min = String(minimum);
    input.max = String(maximum);
    input.value = String(value);
    input.setAttribute("aria-label", widget.name || widget.id || "Slider");
    track.append(fill, knob);
    control.append(track, input);
    return control;
  }
  if (widget.widget_type === "image") {
    return renderImage(project, widget, widget.properties?.src);
  }
  if (widget.widget_type === "animimg") {
    const frames = Array.isArray(widget.properties?.src) ? widget.properties.src : [];
    const holder = document.createElement("span");
    holder.className = "viewer-animimg";
    let index = 0;
    const showFrame = () => {
      holder.replaceChildren(renderImage(project, widget, frames[index]));
      index = frames.length ? (index + 1) % frames.length : 0;
    };
    showFrame();
    if (frames.length > 1 && widget.properties?.auto_start) {
      const duration = clamp(Number(widget.properties?.duration) || 1000, 50, 600000);
      timers.push(window.setInterval(showFrame, duration / frames.length));
    }
    return holder;
  }
  return null;
}

function renderWidget(project, item, timers, warnings, controller) {
  const { widget, box, hidden } = item;
  const node = document.createElement("div");
  node.className = "viewer-widget";
  node.dataset.type = widget.widget_type;
  node.dataset.widgetId = widget.id || "";
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${Math.max(1, box.width)}px`;
  node.style.height = `${Math.max(1, box.height)}px`;
  node.hidden = hidden;
  const activeStates = [];
  if (["switch", "button"].includes(widget.widget_type) && widget.properties?.state_checked) {
    activeStates.push("checked");
  }
  if (widget.properties?.disabled || widget.extra?.disabled) activeStates.push("disabled");
  applyStyle(node, project, widget, activeStates);

  if (!SUPPORTED_WIDGETS.has(widget.widget_type)) {
    warnings.add(`Widgettyp „${widget.widget_type}“ wird noch nicht dargestellt.`);
    node.classList.add("unsupported");
    node.textContent = `${widget.widget_type}: ${widget.id || "ohne ID"}`;
    return node;
  }

  const content = renderWidgetContent(project, widget, timers, activeStates);
  if (content) node.append(content);
  if (activeStates.includes("disabled")) {
    node.classList.add("viewer-disabled");
    node.setAttribute("aria-disabled", "true");
  }
  controller.bindWidget(node, widget);
  return node;
}

function prepareCanvas(canvas, width, height) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

export class ViewerController {
  constructor({
    dialog, stage, frame, display, title, status, zoomLabel, rotationControl,
    eventLog, eventCount,
  }) {
    this.dialog = dialog;
    this.stage = stage;
    this.frame = frame;
    this.display = display;
    this.title = title;
    this.status = status;
    this.zoomLabel = zoomLabel;
    this.rotationControl = rotationControl;
    this.eventLog = eventLog;
    this.eventCount = eventCount;
    this.sourceProject = null;
    this.project = null;
    this.name = "";
    this.backgroundPreview = null;
    this.zoom = 1;
    this.rotation = 0;
    this.fitMode = true;
    this.timers = [];
    this.logEntries = [];
    this.renderWarnings = new Set();
    this.animationFrame = null;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.dialog.open && this.fitMode) this.fit();
    });
    this.resizeObserver.observe(this.stage);
  }

  open(project, { name = "Lokales Projekt", backgroundPreview = null } = {}) {
    this.stopAnimations();
    this.sourceProject = cloneViewerProject(project);
    this.project = cloneViewerProject(this.sourceProject);
    this.name = name;
    this.backgroundPreview = backgroundPreview;
    this.zoom = 1;
    this.rotation = 0;
    this.rotationControl.value = "0";
    this.fitMode = true;
    this.logEntries = [];
    this.renderEventLog();
    this.title.textContent = name;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    window.requestAnimationFrame(() => this.fit());
  }

  close() {
    this.stopAnimations();
    this.sourceProject = null;
    this.project = null;
    this.display.replaceChildren();
    if (this.dialog.open) this.dialog.close();
  }

  reset() {
    if (!this.sourceProject) return;
    this.stopAnimations();
    this.project = cloneViewerProject(this.sourceProject);
    this.logEntries = [];
    this.renderEventLog();
    this.render();
  }

  recordEvent(kind, message) {
    this.logEntries.push({ kind, message, time: new Date() });
    if (this.logEntries.length > 100) this.logEntries.shift();
    this.renderEventLog();
    this.refreshStatus();
  }

  refreshStatus() {
    if (!this.status) return;
    const runtimeWarnings = this.logEntries.filter((entry) => entry.kind === "warning");
    const warningCount = this.renderWarnings.size + runtimeWarnings.length;
    this.status.textContent = warningCount
      ? `Browser-Simulation · ${warningCount} Hinweis(e)`
      : "Browser-Simulation · nicht pixelgenau";
    this.status.title = [
      ...this.renderWarnings,
      ...runtimeWarnings.map((entry) => entry.message),
    ].join("\n");
  }

  renderEventLog() {
    if (!this.eventLog || !this.eventCount) return;
    this.eventCount.textContent = String(this.logEntries.length);
    this.eventLog.replaceChildren();
    if (!this.logEntries.length) {
      const empty = document.createElement("p");
      empty.className = "viewer-event-empty";
      empty.textContent = "Noch keine Viewer-Ereignisse.";
      this.eventLog.append(empty);
      return;
    }
    [...this.logEntries].reverse().forEach((entry) => {
      const row = document.createElement("div");
      row.className = `viewer-event viewer-event-${entry.kind}`;
      const time = document.createElement("time");
      time.dateTime = entry.time.toISOString();
      time.textContent = entry.time.toLocaleTimeString("de-DE", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const text = document.createElement("span");
      text.textContent = entry.message;
      row.append(time, text);
      this.eventLog.append(row);
    });
  }

  runEvent(widget, eventName) {
    const raw = widget.events?.[eventName];
    if (raw === undefined || raw === null) return false;
    const actions = Array.isArray(raw) ? raw : [raw];
    this.recordEvent("trigger", `${widget.id || widget.widget_type}: ${eventName}`);
    let changed = false;
    actions.forEach((action) => {
      const result = applyViewerAction(this.project, action);
      changed ||= result.changed;
      this.recordEvent(result.handled && !result.warning ? "action" : "warning", result.message);
    });
    return changed;
  }

  bindWidget(node, widget) {
    if (widget.properties?.disabled || widget.extra?.disabled) return;
    if (widget.widget_type === "button") {
      node.classList.add("viewer-interactive");
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      const baseStyle = node.getAttribute("style") || "";
      const setTransientStates = (...extraStates) => {
        node.setAttribute("style", baseStyle);
        const states = widget.properties?.state_checked ? ["checked"] : [];
        if (document.activeElement === node) states.push("focused");
        states.push(...extraStates);
        applyStyle(node, this.project, widget, states);
      };
      const press = () => {
        setTransientStates("pressed");
        node.classList.add("viewer-pressed");
      };
      const release = () => {
        setTransientStates();
        node.classList.remove("viewer-pressed");
      };
      const activate = () => {
        if (widget.properties?.checkable) {
          widget.properties.state_checked = !Boolean(widget.properties.state_checked);
          this.recordEvent("state", `${widget.id || "button"}: ${widget.properties.state_checked ? "aktiv" : "inaktiv"}`);
        }
        const changed = this.runEvent(widget, "on_click");
        if (changed || widget.properties?.checkable) this.render();
      };
      node.addEventListener("focus", () => setTransientStates());
      node.addEventListener("blur", () => {
        node.setAttribute("style", baseStyle);
        node.classList.remove("viewer-pressed");
      });
      node.addEventListener("pointerdown", press);
      node.addEventListener("pointerup", release);
      node.addEventListener("pointercancel", release);
      node.addEventListener("pointerleave", release);
      node.addEventListener("click", activate);
      node.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          press();
        }
      });
      node.addEventListener("keyup", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          release();
          activate();
        }
      });
      return;
    }

    if (widget.widget_type === "switch") {
      node.classList.add("viewer-interactive");
      node.tabIndex = 0;
      node.setAttribute("role", "switch");
      node.setAttribute("aria-checked", String(Boolean(widget.properties?.state_checked)));
      const baseStyle = node.getAttribute("style") || "";
      node.addEventListener("focus", () => {
        node.setAttribute("style", baseStyle);
        applyStyle(node, this.project, widget, [
          ...(widget.properties?.state_checked ? ["checked"] : []), "focused",
        ]);
      });
      node.addEventListener("blur", () => node.setAttribute("style", baseStyle));
      const activate = () => {
        widget.properties ||= {};
        widget.properties.state_checked = !Boolean(widget.properties.state_checked);
        this.recordEvent("state", `${widget.id || "switch"}: ${widget.properties.state_checked ? "an" : "aus"}`);
        const valueChanged = this.runEvent(widget, "on_value");
        const clickChanged = this.runEvent(widget, "on_click");
        this.render();
        return valueChanged || clickChanged;
      };
      node.addEventListener("click", activate);
      node.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          activate();
        }
      });
      return;
    }

    if (widget.widget_type === "slider") {
      node.classList.add("viewer-interactive");
      const input = node.querySelector(".viewer-slider-input");
      const fill = node.querySelector(".viewer-slider-fill");
      const knob = node.querySelector(".viewer-slider-knob");
      if (!input) return;
      input.addEventListener("input", () => {
        const minimum = Number(input.min);
        const maximum = Number(input.max);
        const value = Number(input.value);
        const percentage = maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 100;
        widget.properties ||= {};
        widget.properties.value = value;
        if (fill) fill.style.width = `${percentage}%`;
        if (knob) knob.style.left = `${percentage}%`;
      });
      input.addEventListener("change", () => {
        this.recordEvent("state", `${widget.id || "slider"}: ${input.value}`);
        const changed = this.runEvent(widget, "on_value");
        if (changed) this.render();
      });
    }
  }

  stopAnimations() {
    this.timers.forEach((timer) => window.clearInterval(timer));
    this.timers = [];
    if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  setZoom(value) {
    this.zoom = clamp(value, 0.25, 4);
    this.fitMode = false;
    this.applyTransform();
  }

  setRotation(value) {
    this.rotation = ((Number(value) % 360) + 360) % 360;
    this.rotationControl.value = String(this.rotation);
    if (this.fitMode) this.fit();
    else this.applyTransform();
  }

  fit() {
    if (!this.project || !this.stage.clientWidth || !this.stage.clientHeight) return;
    const width = Number(this.project.canvas?.width) || 480;
    const height = Number(this.project.canvas?.height) || 480;
    const rotated = this.rotation % 180 === 0
      ? { width, height }
      : { width: height, height: width };
    const styles = getComputedStyle(this.stage);
    const availableWidth = this.stage.clientWidth
      - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    const availableHeight = this.stage.clientHeight
      - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
    this.zoom = clamp(Math.min(availableWidth / rotated.width, availableHeight / rotated.height), 0.25, 4);
    this.fitMode = true;
    this.applyTransform();
  }

  applyTransform() {
    if (!this.project) return;
    const width = Number(this.project.canvas?.width) || 480;
    const height = Number(this.project.canvas?.height) || 480;
    const rotatedWidth = this.rotation % 180 === 0 ? width : height;
    const rotatedHeight = this.rotation % 180 === 0 ? height : width;
    this.frame.style.width = `${rotatedWidth * this.zoom}px`;
    this.frame.style.height = `${rotatedHeight * this.zoom}px`;
    this.display.style.transform = `rotate(${this.rotation}deg) scale(${this.zoom})`;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)} %`;
  }

  render() {
    if (!this.project) return;
    this.stopAnimations();
    const warnings = new Set();
    const width = Number(this.project.canvas?.width) || 480;
    const height = Number(this.project.canvas?.height) || 480;
    this.display.style.width = `${width}px`;
    this.display.style.height = `${height}px`;
    this.display.replaceChildren();

    const background = document.createElement("div");
    background.className = "viewer-background";
    const configuredBackground = String(this.project.background?.path || "");
    const source = /^https?:\/\//i.test(configuredBackground)
      ? configuredBackground
      : this.backgroundPreview;
    if (source) {
      background.style.backgroundImage = `url(${JSON.stringify(String(source))})`;
      background.style.opacity = String(clamp(
        Number(this.project.background?.opacity_in_editor ?? 40) / 100, 0, 1,
      ));
    }

    const glowBack = document.createElement("canvas");
    glowBack.className = "viewer-glow viewer-glow-back";
    const glowFront = document.createElement("canvas");
    glowFront.className = "viewer-glow viewer-glow-front";
    this.display.append(background, glowBack);

    allWidgetItems(this.project).forEach((item) => {
      this.display.append(renderWidget(this.project, item, this.timers, warnings, this));
    });
    this.display.append(glowFront);

    const visibleStrokes = (this.project.glow_strokes || []).filter((stroke) => !stroke.hidden);
    const backDocument = { strokes: visibleStrokes.filter((stroke) => !stroke.parent_id) };
    const frontDocument = { strokes: visibleStrokes.filter((stroke) => stroke.parent_id) };
    const backContext = prepareCanvas(glowBack, width, height);
    const frontContext = prepareCanvas(glowFront, width, height);
    const startedAt = performance.now();
    const draw = (now) => {
      const phase = ((now - startedAt) / 1000) % 1;
      backContext.clearRect(0, 0, width, height);
      frontContext.clearRect(0, 0, width, height);
      drawDocument(backContext, backDocument, { phase });
      drawDocument(frontContext, frontDocument, { phase });
      if (hasFlow(backDocument) || hasFlow(frontDocument)) {
        this.animationFrame = window.requestAnimationFrame(draw);
      }
    };
    draw(startedAt);

    this.renderWarnings = warnings;
    this.refreshStatus();
    this.applyTransform();
  }
}
