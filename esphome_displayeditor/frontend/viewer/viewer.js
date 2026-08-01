import { computeLayout } from "../layout.js";
import { drawDocument, hasFlow } from "../glowline/renderer.js";

const SUPPORTED_WIDGETS = new Set([
  "obj", "container", "label", "button", "switch", "slider", "bar", "arc", "image", "animimg",
]);
const STYLE_BRANCHES = new Set([
  "states", "indicator", "knob", "items", "ticks", "selected", "scrollbar", "cursor",
]);
const RUNTIME_STYLE_KEYS = new Set([
  "bg_color", "text_color", "border_color", "opa", "bg_opa", "border_width", "radius",
]);

const clamp = (value, minimum, maximum) => (
  Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum)
);

export function cloneViewerProject(project) {
  return JSON.parse(JSON.stringify(project || {}));
}

export function viewerTextAlign(value) {
  const align = String(value || "").trim().toUpperCase();
  return ({ LEFT: "left", CENTER: "center", RIGHT: "right", AUTO: "start" })[align] || "";
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

export function viewerGradientBackground(project, style) {
  const background = resolveViewerColor(project, style?.bg_color);
  const gradient = resolveViewerColor(project, style?.bg_grad_color);
  const direction = String(style?.bg_grad_dir || "").toUpperCase();
  if (!background || !gradient || !["HOR", "VER"].includes(direction)) return "";
  const cssDirection = direction === "HOR" ? "to right" : "to bottom";
  const opacity = viewerOpacity(style?.bg_opa);
  return `linear-gradient(${cssDirection}, ${colorWithOpacity(background, opacity)}, ${colorWithOpacity(gradient, opacity)})`;
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

function viewerWidgetRoots(project) {
  const roots = [...(project.widgets || [])];
  (project.pages || []).forEach((page) => roots.push(...(page.widgets || [])));
  roots.push(...(project.bottom_layer?.widgets || []));
  roots.push(...(project.top_layer?.widgets || []));
  return roots;
}

function surfaceProject(project, surface) {
  return {
    ...project,
    widgets: surface.widgets || [],
    extra_lvgl: { ...(surface.style_tree || {}), layout: surface.layout || {} },
  };
}

function viewerSurfaces(project, activePageId) {
  const surfaces = [];
  if (project.bottom_layer) {
    surfaces.push({ kind: "bottom", surface: project.bottom_layer });
  }
  if ((project.pages || []).length) {
    const active = project.pages.find((page) => page.id === activePageId) || project.pages[0];
    if (active) surfaces.push({ kind: "page", surface: active });
  } else {
    surfaces.push({
      kind: "root",
      surface: {
        widgets: project.widgets || [],
        layout: project.extra_lvgl?.layout || {},
        style_tree: project.extra_lvgl || {},
      },
    });
  }
  if (project.top_layer) {
    surfaces.push({ kind: "top", surface: project.top_layer });
  }
  return surfaces;
}

function applyStyleObject(node, project, style) {
  const background = resolveViewerColor(project, style.bg_color);
  const border = resolveViewerColor(project, style.border_color);
  const shadow = resolveViewerColor(project, style.shadow_color);
  const text = resolveViewerColor(project, style.text_color);
  const opacity = viewerOpacity(style.opa);
  const backgroundOpacity = viewerOpacity(style.bg_opa);
  const shadowOpacity = viewerOpacity(style.shadow_opa);

  if (background) node.style.backgroundColor = colorWithOpacity(background, backgroundOpacity);
  const gradientBackground = viewerGradientBackground(project, style);
  if (gradientBackground) node.style.backgroundImage = gradientBackground;
  if (border) node.style.borderColor = border;
  if (style.border_width !== undefined) node.style.borderWidth = `${Math.max(0, Number(style.border_width) || 0)}px`;
  if (style.radius !== undefined) node.style.borderRadius = `${Math.max(0, Number(style.radius) || 0)}px`;
  if (text) node.style.color = text;
  const textAlign = viewerTextAlign(style.text_align);
  if (textAlign) node.style.textAlign = textAlign;
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
  visit(viewerWidgetRoots(project));
  return found;
}

const RUNTIME_TARGET_WIDGET = {
  text: new Set(["label"]),
  value: new Set(["slider", "bar", "arc"]),
  state_checked: new Set(["switch"]),
};

export function runtimeBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "an", "ein", "locked"].includes(normalized)) return true;
  if (["0", "false", "off", "no", "aus", "unlocked"].includes(normalized)) return false;
  return null;
}

export function entityMatchesRuntimeTarget(entity, target, runtimeState = null) {
  if (!entity || target === "text") return Boolean(entity);
  const type = String(entity.type || "").toLowerCase();
  if (target === "value") {
    if (["sensor", "number"].includes(type)) return true;
    const value = Number(runtimeState?.state);
    return runtimeState?.state !== "" && runtimeState?.state !== null
      && runtimeState?.state !== undefined && Number.isFinite(value);
  }
  if (target === "state_checked") {
    if (["binary_sensor", "switch", "light", "fan", "lock"].includes(type)) return true;
    return runtimeState && runtimeBoolean(runtimeState.state) !== null;
  }
  return false;
}

export function runtimeBindingHealth(binding, runtimeSnapshot, { now = Date.now() } = {}) {
  if (!binding?.device_id || !binding?.entity_id) {
    return { status: "unconfigured", device: null, state: null, stale: false };
  }
  const device = (runtimeSnapshot?.devices || []).find((item) => item.id === binding.device_id) || null;
  if (!device) return { status: "missing_device", device: null, state: null, stale: false };
  const runtimeState = (device.states || []).find((item) => item.entity_id === binding.entity_id) || null;
  if (device.status !== "ready") {
    return { status: "offline", device, state: runtimeState, stale: false };
  }
  if (!runtimeState) return { status: "missing_entity", device, state: null, stale: false };
  const receivedAt = Date.parse(runtimeState.received_at || "");
  const staleAfter = Math.max(0, Number(binding.stale_after) || 0);
  const stale = staleAfter > 0 && Number.isFinite(receivedAt) && now - receivedAt > staleAfter * 1000;
  if (stale) return { status: "stale", device, state: runtimeState, stale: true };
  if (runtimeState.available === false || runtimeState.state === undefined || runtimeState.state === null) {
    return { status: "unavailable", device, state: runtimeState, stale: false };
  }
  return { status: "online", device, state: runtimeState, stale: false };
}

export function formatRuntimeValue(value, template = "{state}") {
  const source = String(template || "{state}");
  return source.replace(/\{state(?::\.(\d)f)?\}/g, (_match, decimals) => {
    if (decimals === undefined) return String(value ?? "");
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(Number(decimals)) : String(value ?? "");
  });
}

export function applyRuntimeBinding(
  project,
  sourceProject,
  binding,
  runtimeState,
  { deviceAvailable = true, now = Date.now() } = {},
) {
  const widget = findWidget(project, binding?.widget_id);
  const sourceWidget = findWidget(sourceProject, binding?.widget_id);
  const target = String(binding?.target || "");
  if (!widget || !sourceWidget || !RUNTIME_TARGET_WIDGET[target]?.has(widget.widget_type)) return false;
  const receivedAt = Date.parse(runtimeState?.received_at || "");
  const staleAfter = Math.max(0, Number(binding.stale_after) || 0);
  const stale = staleAfter > 0 && Number.isFinite(receivedAt) && now - receivedAt > staleAfter * 1000;
  const available = Boolean(deviceAvailable && runtimeState?.available !== false && !stale
    && runtimeState && runtimeState.state !== undefined && runtimeState.state !== null);
  widget.properties ||= {};

  if (!available) {
    if (target !== "text") return false; // Numeric/boolean widgets deliberately retain their last value.
    const next = binding.fallback !== "" && binding.fallback !== undefined
      ? String(binding.fallback)
      : String(sourceWidget.properties?.text ?? "");
    if (widget.properties.text === next) return false;
    widget.properties.text = next;
    return true;
  }

  let next;
  if (target === "text") next = formatRuntimeValue(runtimeState.state, binding.value_format);
  else if (target === "value") {
    next = Number(runtimeState.state);
    if (!Number.isFinite(next)) return false;
  } else {
    next = runtimeBoolean(runtimeState.state);
    if (next === null) return false;
  }
  if (widget.properties[target] === next) return false;
  widget.properties[target] = next;
  return true;
}

function pageActionId(payload) {
  return actionIds(payload)[0] || "";
}

function navigatePage(project, runtime, direction) {
  const pages = project.pages || [];
  if (!pages.length) return null;
  const current = Math.max(0, pages.findIndex((page) => page.id === runtime.activePageId));
  for (let distance = 1; distance <= pages.length; distance += 1) {
    let candidate = current + (distance * direction);
    if (project.page_wrap !== false) {
      candidate = ((candidate % pages.length) + pages.length) % pages.length;
    } else if (candidate < 0 || candidate >= pages.length) {
      return null;
    }
    if (!pages[candidate].skip) return pages[candidate];
  }
  return null;
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

function viewerConditionValue(condition, context) {
  const expression = String(condition?.lambda || "").replace(/\s+/g, "").toLowerCase();
  if (expression === "returnx;") return { supported: true, value: Boolean(context.x) };
  if (expression === "return!x;") return { supported: true, value: !Boolean(context.x) };
  return { supported: false, value: false };
}

export function applyViewerAction(project, action, runtime = {}, context = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { handled: false, changed: false, message: "Ungültiger Aktionseintrag übersprungen." };
  }
  const entries = Object.entries(action);
  if (entries.length !== 1) {
    return { handled: false, changed: false, message: "Mehrdeutiger Aktionseintrag übersprungen." };
  }
  const [name, payload] = entries[0];

  if (name === "if") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { handled: false, changed: false, message: "Ungültige Bedingung übersprungen." };
    }
    const condition = viewerConditionValue(payload.condition, context);
    if (!condition.supported) {
      return { handled: false, changed: false, message: "Diese Bedingung wird im Browser nicht ausgeführt." };
    }
    const selected = condition.value ? payload.then : payload.else;
    const actions = selected === undefined ? [] : Array.isArray(selected) ? selected : [selected];
    let changed = false;
    let warning = false;
    const messages = [];
    actions.forEach((nested) => {
      const result = applyViewerAction(project, nested, runtime, context);
      changed ||= result.changed;
      warning ||= Boolean(result.warning || !result.handled);
      messages.push(result.message);
    });
    return {
      handled: true,
      changed,
      warning,
      message: `if (${condition.value ? "wahr" : "falsch"})${messages.length ? `: ${messages.join("; ")}` : ""}`,
    };
  }

  if (name === "lvgl.page.show") {
    const id = pageActionId(payload);
    const page = (project.pages || []).find((entry) => entry.id === id);
    if (!page) return {
      handled: true, changed: false, warning: true,
      message: `lvgl.page.show: Seite ${id || "ohne ID"} nicht gefunden.`,
    };
    const changed = runtime.activePageId !== page.id;
    runtime.activePageId = page.id;
    return { handled: true, changed, message: `lvgl.page.show: ${page.id}` };
  }

  if (["lvgl.page.next", "lvgl.page.previous"].includes(name)) {
    const direction = name.endsWith(".next") ? 1 : -1;
    const page = navigatePage(project, runtime, direction);
    if (!page) return {
      handled: true, changed: false, warning: true,
      message: `${name}: keine erreichbare Seite.`,
    };
    const changed = runtime.activePageId !== page.id;
    runtime.activePageId = page.id;
    return { handled: true, changed, message: `${name}: ${page.id}` };
  }

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
    "lvgl.widget.update": new Set(["hidden", "text", "value", "state_checked", ...RUNTIME_STYLE_KEYS]),
    "lvgl.label.update": new Set(["text", ...RUNTIME_STYLE_KEYS]),
    "lvgl.button.update": new Set(["text", ...RUNTIME_STYLE_KEYS]),
    "lvgl.slider.update": new Set(["value", ...RUNTIME_STYLE_KEYS]),
    "lvgl.bar.update": new Set(["value", "start_value", "min_value", "max_value", "mode", "animated", ...RUNTIME_STYLE_KEYS]),
    "lvgl.arc.update": new Set([
      "value", "min_value", "max_value", "mode", "start_angle", "end_angle",
      "rotation", "adjustable", "change_rate", ...RUNTIME_STYLE_KEYS,
    ]),
    "lvgl.switch.update": new Set(["state_checked", ...RUNTIME_STYLE_KEYS]),
  };
  const updateWidgetTypes = {
    "lvgl.label.update": "label",
    "lvgl.button.update": "button",
    "lvgl.slider.update": "slider",
    "lvgl.bar.update": "bar",
    "lvgl.arc.update": "arc",
    "lvgl.switch.update": "switch",
  };
  const numericUpdateKeys = new Set([
    "value", "start_value", "min_value", "max_value", "start_angle", "end_angle",
    "rotation", "change_rate",
  ]);
  const booleanUpdateKeys = new Set(["hidden", "state_checked", "animated", "adjustable"]);
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
      if (updateWidgetTypes[name] && widget.widget_type !== updateWidgetTypes[name]) {
        notes.push(`${update.id}: kein ${updateWidgetTypes[name]}-Widget`);
        return;
      }
      Object.entries(update).forEach(([key, value]) => {
        if (key === "id") return;
        if (!updateKeys[name].has(key) || !safeLiteral(value)) {
          notes.push(`${widget.id}.${key}: nicht erlaubt`);
          return;
        }
        if (booleanUpdateKeys.has(key) && typeof value !== "boolean") {
          notes.push(`${widget.id}.${key}: Boolescher Wert erwartet`);
          return;
        }
        if (numericUpdateKeys.has(key) && !Number.isFinite(Number(value))) {
          notes.push(`${widget.id}.${key}: numerischer Wert erwartet`);
          return;
        }
        if (key === "hidden") widget.hidden = value;
        else if (RUNTIME_STYLE_KEYS.has(key)) {
          widget.style_tree ||= {};
          widget.style_tree[key] = value;
        }
        else {
          widget.properties ||= {};
          if (booleanUpdateKeys.has(key)) widget.properties[key] = value;
          else if (numericUpdateKeys.has(key)) widget.properties[key] = Number(value);
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

function numericWidgetRange(widget) {
  const minimum = Number(widget.properties?.min_value) || 0;
  const rawMaximum = Number(widget.properties?.max_value);
  const maximum = Number.isFinite(rawMaximum) && rawMaximum !== minimum ? rawMaximum : 100;
  const value = clamp(Number(widget.properties?.value) || 0, Math.min(minimum, maximum), Math.max(minimum, maximum));
  const percentage = maximum === minimum ? 0 : clamp((value - minimum) / (maximum - minimum), 0, 1);
  return { minimum, maximum, value, percentage };
}

export function viewerBarGeometry(widget) {
  const { minimum, maximum, percentage } = numericWidgetRange(widget);
  const mode = String(widget.properties?.mode || "NORMAL").toUpperCase();
  const startValue = mode === "RANGE"
    ? clamp(Number(widget.properties?.start_value) || 0, Math.min(minimum, maximum), Math.max(minimum, maximum))
    : mode === "SYMMETRICAL" ? (minimum + maximum) / 2 : minimum;
  const start = maximum === minimum ? 0 : clamp((startValue - minimum) / (maximum - minimum), 0, 1);
  const lower = Math.min(start, percentage);
  const upper = Math.max(start, percentage);
  const vertical = Number(widget.height) > Number(widget.width);
  return { lower, upper, vertical, percentage };
}

function renderBar(project, widget, activeStates) {
  const { lower, upper, vertical } = viewerBarGeometry(widget);
  const control = document.createElement("span");
  control.className = `viewer-bar-control${vertical ? " vertical" : ""}`;
  const track = document.createElement("span");
  track.className = "viewer-bar-track";
  const fill = document.createElement("span");
  fill.className = "viewer-bar-fill";
  if (vertical) {
    fill.style.bottom = `${lower * 100}%`;
    fill.style.height = `${(upper - lower) * 100}%`;
  } else {
    fill.style.left = `${lower * 100}%`;
    fill.style.width = `${(upper - lower) * 100}%`;
  }
  applyPartStyle(fill, project, widget, "indicator", activeStates);
  track.append(fill);
  control.append(track);
  return control;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function arcPoint(angle, radius = 40) {
  const radians = angle * Math.PI / 180;
  return { x: 50 + radius * Math.cos(radians), y: 50 + radius * Math.sin(radians) };
}

export function describeViewerArc(startAngle, sweepAngle, radius = 40) {
  const sweep = Math.max(-359.999, Math.min(359.999, Number(sweepAngle) || 0));
  const start = arcPoint(Number(startAngle) || 0, radius);
  const end = arcPoint((Number(startAngle) || 0) + sweep, radius);
  return [
    `M ${start.x.toFixed(3)} ${start.y.toFixed(3)}`,
    `A ${radius} ${radius} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep >= 0 ? 1 : 0} ${end.x.toFixed(3)} ${end.y.toFixed(3)}`,
  ].join(" ");
}

function viewerArcOpacity(value) {
  const opacity = viewerOpacity(value);
  return opacity === null ? 1 : opacity;
}

function updateArcVisual(control, project, widget, activeStates = []) {
  const { percentage } = numericWidgetRange(widget);
  const start = Number(widget.properties?.start_angle ?? 135) + Number(widget.properties?.rotation || 0);
  const end = Number(widget.properties?.end_angle ?? 45) + Number(widget.properties?.rotation || 0);
  const sweep = ((end - start) % 360 + 360) % 360 || 360;
  const mode = String(widget.properties?.mode || "NORMAL").toUpperCase();
  let indicatorStart = start;
  let indicatorSweep = sweep * percentage;
  if (mode === "REVERSE") {
    indicatorStart = start + sweep;
    indicatorSweep = -sweep * (1 - percentage);
  } else if (mode === "SYMMETRICAL") {
    indicatorStart = start + sweep / 2;
    indicatorSweep = sweep * (percentage - 0.5);
  }
  const mainStyle = effectiveViewerStyle(project, widget, activeStates);
  const indicatorStyle = effectiveViewerPartStyle(project, widget, "indicator", activeStates);
  const knobStyle = effectiveViewerPartStyle(project, widget, "knob", activeStates);
  const nominalSize = Math.max(1, Math.min(Number(widget.width) || 120, Number(widget.height) || 120));
  const mainWidth = clamp((Number(mainStyle.arc_width) || 10) * 100 / nominalSize, 1, 30);
  const indicatorWidth = clamp((Number(indicatorStyle.arc_width) || Number(mainStyle.arc_width) || 10) * 100 / nominalSize, 1, 30);
  const background = control.querySelector(".viewer-arc-background");
  const indicator = control.querySelector(".viewer-arc-indicator");
  const knob = control.querySelector(".viewer-arc-knob");
  background.setAttribute("d", describeViewerArc(start, sweep));
  background.setAttribute("stroke", resolveViewerColor(project, mainStyle.arc_color) || "#657386");
  background.setAttribute("stroke-width", String(mainWidth));
  background.setAttribute("stroke-linecap", mainStyle.arc_rounded === false ? "butt" : "round");
  background.setAttribute("opacity", String(viewerArcOpacity(mainStyle.arc_opa)));
  indicator.setAttribute("d", describeViewerArc(indicatorStart, indicatorSweep));
  indicator.setAttribute("stroke", resolveViewerColor(project, indicatorStyle.arc_color)
    || resolveViewerColor(project, indicatorStyle.bg_color) || "#20c7b7");
  indicator.setAttribute("stroke-width", String(indicatorWidth));
  indicator.setAttribute("stroke-linecap", indicatorStyle.arc_rounded === false ? "butt" : "round");
  indicator.setAttribute("opacity", String(viewerArcOpacity(indicatorStyle.arc_opa)));
  const currentPoint = arcPoint(start + sweep * percentage);
  knob.setAttribute("cx", currentPoint.x.toFixed(3));
  knob.setAttribute("cy", currentPoint.y.toFixed(3));
  knob.setAttribute("r", String(Math.max(3, indicatorWidth * 0.75)));
  knob.setAttribute("fill", resolveViewerColor(project, knobStyle.bg_color) || "#ffffff");
  knob.hidden = !widget.properties?.adjustable;
}

function renderArc(project, widget, activeStates) {
  const control = document.createElement("span");
  control.className = "viewer-arc-control";
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.classList.add("viewer-arc-svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  const background = document.createElementNS(SVG_NAMESPACE, "path");
  background.classList.add("viewer-arc-background");
  background.setAttribute("fill", "none");
  const indicator = document.createElementNS(SVG_NAMESPACE, "path");
  indicator.classList.add("viewer-arc-indicator");
  indicator.setAttribute("fill", "none");
  const knob = document.createElementNS(SVG_NAMESPACE, "circle");
  knob.classList.add("viewer-arc-knob");
  svg.append(background, indicator, knob);
  control.append(svg);
  if (widget.properties?.adjustable) {
    const { minimum, maximum, value } = numericWidgetRange(widget);
    const input = document.createElement("input");
    input.className = "viewer-arc-input";
    input.type = "range";
    input.min = String(minimum);
    input.max = String(maximum);
    input.value = String(value);
    input.setAttribute("aria-label", widget.name || widget.id || "Arc");
    control.append(input);
  }
  updateArcVisual(control, project, widget, activeStates);
  return control;
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
  if (widget.widget_type === "bar") return renderBar(project, widget, activeStates);
  if (widget.widget_type === "arc") return renderArc(project, widget, activeStates);
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
    eventLog, eventCount, pageControls, pageSelect, pagePrevious, pageNext,
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
    this.pageControls = pageControls;
    this.pageSelect = pageSelect;
    this.pagePrevious = pagePrevious;
    this.pageNext = pageNext;
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
    this.runtime = { activePageId: "" };
    this.runtimeBindings = [];
    this.runtimeStates = new Map();
    this.runtimeDevices = new Map();
    this.runtimeTimer = null;
    this.animationFrame = null;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.dialog.open && this.fitMode) this.fit();
    });
    this.resizeObserver.observe(this.stage);
  }

  open(project, {
    name = "Lokales Projekt", backgroundPreview = null, runtimeBindings = [], runtimeSnapshot = null,
  } = {}) {
    this.stopAnimations();
    this.stopRuntimeTimer();
    this.sourceProject = cloneViewerProject(project);
    this.project = cloneViewerProject(this.sourceProject);
    this.name = name;
    this.backgroundPreview = backgroundPreview;
    this.zoom = 1;
    this.rotation = 0;
    this.rotationControl.value = "0";
    this.fitMode = true;
    this.logEntries = [];
    this.runtime = { activePageId: this.project.pages?.[0]?.id || "" };
    this.runtimeBindings = cloneViewerProject(runtimeBindings);
    this.runtimeStates = new Map();
    this.runtimeDevices = new Map();
    if (runtimeSnapshot) this.setRuntimeSnapshot(runtimeSnapshot, { render: false });
    this.applyAllRuntimeBindings({ render: false });
    this.renderEventLog();
    this.title.textContent = name;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    if (this.runtimeBindings.length) {
      this.runtimeTimer = window.setInterval(() => this.applyAllRuntimeBindings(), 5000);
    }
    window.requestAnimationFrame(() => this.fit());
  }

  close() {
    this.stopAnimations();
    this.stopRuntimeTimer();
    this.sourceProject = null;
    this.project = null;
    this.runtimeBindings = [];
    this.runtimeStates.clear();
    this.runtimeDevices.clear();
    this.display.replaceChildren();
    if (this.dialog.open) this.dialog.close();
  }

  reset() {
    if (!this.sourceProject) return;
    this.stopAnimations();
    this.project = cloneViewerProject(this.sourceProject);
    this.runtime = { activePageId: this.project.pages?.[0]?.id || "" };
    this.logEntries = [];
    this.applyAllRuntimeBindings({ render: false });
    this.renderEventLog();
    this.render();
  }

  stopRuntimeTimer() {
    if (this.runtimeTimer !== null) window.clearInterval(this.runtimeTimer);
    this.runtimeTimer = null;
  }

  setRuntimeSnapshot(snapshot, { render = true } = {}) {
    this.runtimeStates = new Map();
    this.runtimeDevices = new Map();
    (snapshot?.devices || []).forEach((device) => {
      this.runtimeDevices.set(device.id, {
        id: device.id, name: device.name, status: device.status, last_seen: device.last_seen,
      });
      (device.states || []).forEach((item) => {
        if (item.entity_id) this.runtimeStates.set(`${device.id}:${item.entity_id}`, item);
      });
    });
    this.applyAllRuntimeBindings({ render });
  }

  applyRuntimeEvent(event) {
    if (!this.project || !event || event.type === "heartbeat") return;
    if (event.type === "snapshot") {
      this.setRuntimeSnapshot(event);
      return;
    }
    if (event.type === "device_snapshot" && event.device?.id) {
      const device = event.device;
      this.runtimeDevices.set(device.id, {
        id: device.id, name: device.name, status: device.status, last_seen: device.last_seen,
      });
      [...this.runtimeStates.keys()].filter((key) => key.startsWith(`${device.id}:`))
        .forEach((key) => this.runtimeStates.delete(key));
      (device.states || []).forEach((item) => {
        if (item.entity_id) this.runtimeStates.set(`${device.id}:${item.entity_id}`, item);
      });
    } else if (event.type === "state" && event.device_id && event.state?.entity_id) {
      this.runtimeStates.set(`${event.device_id}:${event.state.entity_id}`, event.state);
      const device = this.runtimeDevices.get(event.device_id);
      if (device) device.last_seen = event.state.received_at;
    } else if (event.type === "connection" && event.device_id) {
      const device = this.runtimeDevices.get(event.device_id) || { id: event.device_id, name: event.device_id };
      device.status = event.status;
      this.runtimeDevices.set(event.device_id, device);
    } else if (event.type === "device_removed" && event.device_id) {
      this.runtimeDevices.delete(event.device_id);
    } else {
      return;
    }
    this.applyAllRuntimeBindings();
  }

  applyAllRuntimeBindings({ render = true } = {}) {
    if (!this.project || !this.sourceProject) return false;
    let changed = false;
    this.runtimeBindings.forEach((binding) => {
      const device = this.runtimeDevices.get(binding.device_id);
      const runtimeState = this.runtimeStates.get(`${binding.device_id}:${binding.entity_id}`);
      changed = applyRuntimeBinding(this.project, this.sourceProject, binding, runtimeState, {
        deviceAvailable: device?.status === "ready",
      }) || changed;
    });
    if (changed && render) this.render();
    else this.refreshStatus();
    return changed;
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
    const liveDevices = new Set(this.runtimeBindings.map((binding) => binding.device_id));
    const online = [...liveDevices].filter((id) => this.runtimeDevices.get(id)?.status === "ready").length;
    const live = this.runtimeBindings.length
      ? ` · Live ${online}/${liveDevices.size} Gerät(e) · ${this.runtimeBindings.length} Bindung(en)`
      : "";
    this.status.textContent = warningCount
      ? `Browser-Simulation${live} · ${warningCount} Hinweis(e)`
      : `Browser-Simulation${live} · nicht pixelgenau`;
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

  runEvent(widget, eventName, context = {}) {
    const raw = widget.events?.[eventName];
    if (raw === undefined || raw === null) return false;
    const actions = Array.isArray(raw) ? raw : [raw];
    this.recordEvent("trigger", `${widget.id || widget.widget_type}: ${eventName}`);
    let changed = false;
    actions.forEach((action) => {
      const result = applyViewerAction(this.project, action, this.runtime, context);
      changed ||= result.changed;
      this.recordEvent(result.handled && !result.warning ? "action" : "warning", result.message);
    });
    return changed;
  }

  refreshActionVisuals(transientWidget = null, transientStates = []) {
    this.display.querySelectorAll("[data-widget-id]").forEach((node) => {
      const widget = findWidget(this.project, node.dataset.widgetId);
      if (!widget) return;
      node.hidden = Boolean(widget.hidden);
      const states = widget.properties?.state_checked ? ["checked"] : [];
      if (document.activeElement === node) states.push("focused");
      if (widget === transientWidget) states.push(...transientStates);
      applyStyle(node, this.project, widget, states);
      if (["label", "button"].includes(widget.widget_type)) {
        const text = node.querySelector(".viewer-widget-text");
        if (text) text.textContent = textContent(widget);
      }
    });
  }

  bindWidget(node, widget) {
    if (widget.properties?.disabled || widget.extra?.disabled) return;
    if (widget.widget_type === "button") {
      node.classList.add("viewer-interactive");
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      if (widget.properties?.checkable) {
        node.setAttribute("aria-pressed", String(Boolean(widget.properties?.state_checked)));
      }
      const baseStyle = node.getAttribute("style") || "";
      const setTransientStates = (...extraStates) => {
        node.setAttribute("style", baseStyle);
        const states = widget.properties?.state_checked ? ["checked"] : [];
        if (document.activeElement === node) states.push("focused");
        states.push(...extraStates);
        applyStyle(node, this.project, widget, states);
      };
      const actionContext = () => ({ x: Boolean(widget.properties?.state_checked) });
      const releaseVisual = () => {
        setTransientStates();
        node.classList.remove("viewer-pressed");
      };
      const activate = ({ render = true } = {}) => {
        let changed = false;
        widget.properties ||= {};
        if (widget.properties.checkable) {
          widget.properties.state_checked = !Boolean(widget.properties.state_checked);
          this.recordEvent("state", `${widget.id || "button"}: ${widget.properties.state_checked ? "aktiv" : "inaktiv"}`);
          changed = this.runEvent(widget, "on_value", actionContext()) || changed;
        }
        changed = this.runEvent(widget, "on_change", actionContext()) || changed;
        changed = this.runEvent(widget, "on_click", actionContext()) || changed;
        if (render && (changed || widget.properties.checkable)) this.render();
        return changed;
      };
      const press = ({ renderChanges = true } = {}) => {
        setTransientStates("pressed");
        node.classList.add("viewer-pressed");
        const changed = this.runEvent(widget, "on_press", actionContext());
        if (changed && renderChanges) {
          this.refreshActionVisuals(widget, ["pressed"]);
        }
        return changed;
      };
      const release = () => {
        releaseVisual();
        const changed = this.runEvent(widget, "on_release", actionContext());
        if (changed) this.refreshActionVisuals(widget);
      };
      node.addEventListener("focus", () => setTransientStates());
      node.addEventListener("blur", () => {
        node.setAttribute("style", baseStyle);
        node.classList.remove("viewer-pressed");
      });
      node.addEventListener("pointerdown", press);
      node.addEventListener("pointerup", release);
      node.addEventListener("pointercancel", releaseVisual);
      node.addEventListener("pointerleave", releaseVisual);
      node.addEventListener("click", () => activate());
      node.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key) && !event.repeat) {
          event.preventDefault();
          press({ renderChanges: false });
        }
      });
      node.addEventListener("keyup", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          releaseVisual();
          this.runEvent(widget, "on_release", actionContext());
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
        const context = { x: Boolean(widget.properties.state_checked) };
        const valueChanged = this.runEvent(widget, "on_value", context);
        const clickChanged = this.runEvent(widget, "on_click", context);
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
        const changed = this.runEvent(widget, "on_value", { x: Number(input.value) });
        if (changed) this.render();
      });
      return;
    }

    if (widget.widget_type === "arc" && widget.properties?.adjustable) {
      node.classList.add("viewer-interactive");
      const input = node.querySelector(".viewer-arc-input");
      const control = node.querySelector(".viewer-arc-control");
      if (!input || !control) return;
      input.addEventListener("input", () => {
        widget.properties ||= {};
        widget.properties.value = Number(input.value);
        updateArcVisual(control, this.project, widget);
      });
      input.addEventListener("change", () => {
        this.recordEvent("state", `${widget.id || "arc"}: ${input.value}`);
        const context = { x: Number(input.value) };
        const valueChanged = this.runEvent(widget, "on_value", context);
        const changeChanged = this.runEvent(widget, "on_change", context);
        if (valueChanged || changeChanged) this.render();
      });
    }
  }

  setActivePage(id, { record = true } = {}) {
    const page = (this.project?.pages || []).find((entry) => entry.id === id);
    if (!page || page.id === this.runtime.activePageId) return false;
    this.runtime.activePageId = page.id;
    if (record) this.recordEvent("state", `Seite: ${page.id}`);
    this.render();
    return true;
  }

  changePage(direction) {
    if (!this.project) return false;
    const page = navigatePage(this.project, this.runtime, direction);
    if (!page || page.id === this.runtime.activePageId) return false;
    this.runtime.activePageId = page.id;
    this.recordEvent("state", `Seite: ${page.id}`);
    this.render();
    return true;
  }

  updatePageControls() {
    if (!this.pageControls || !this.pageSelect) return;
    const pages = this.project?.pages || [];
    this.pageControls.hidden = pages.length === 0;
    this.pageSelect.replaceChildren();
    pages.forEach((page) => {
      const option = new Option(`${page.id}${page.skip ? " (überspringen)" : ""}`, page.id);
      this.pageSelect.append(option);
    });
    if (pages.length) this.pageSelect.value = this.runtime.activePageId || pages[0].id;
    if (this.pagePrevious) this.pagePrevious.disabled = pages.length < 2;
    if (this.pageNext) this.pageNext.disabled = pages.length < 2;
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

    viewerSurfaces(this.project, this.runtime.activePageId).forEach(({ kind, surface }) => {
      const layer = document.createElement("div");
      layer.className = `viewer-surface viewer-surface-${kind}`;
      layer.dataset.surfaceId = surface.id || kind;
      applyStyleObject(layer, this.project, surface.style_tree || {});
      // Layout padding is already consumed by computeLayout. Keeping it on
      // the absolutely-positioned surface would offset children a second time.
      layer.style.padding = "0";
      layer.style.rowGap = "0";
      layer.style.columnGap = "0";
      const scopedProject = surfaceProject(this.project, surface);
      allWidgetItems(scopedProject).forEach((item) => {
        layer.append(renderWidget(scopedProject, item, this.timers, warnings, this));
      });
      this.display.append(layer);
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
    this.updatePageControls();
    this.refreshStatus();
    this.applyTransform();
  }
}
