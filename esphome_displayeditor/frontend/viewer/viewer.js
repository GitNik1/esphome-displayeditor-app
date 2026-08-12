import { computeLayout, fontFamilyId, resolvedFontFamily } from "../layout.js";
import { drawDocument, hasFlow } from "../glowline/renderer.js";
import { t } from "../i18n.js";

const SUPPORTED_WIDGETS = new Set([
  "obj", "container", "label", "button", "switch", "slider", "bar", "arc", "image", "animimg",
  "checkbox", "dropdown", "roller", "textarea", "keyboard", "tileview", "tabview",
  "led", "spinner", "qrcode", "spinbox",
]);
const STYLE_BRANCHES = new Set([
  "states", "indicator", "knob", "items", "ticks", "selected", "scrollbar", "cursor", "list",
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

// A local path (e.g. from an imported config's own `image:`/`font:` entry)
// isn't something the browser can fetch directly - it lives on the HA host,
// not the web. Route it through the read-only asset endpoint instead, the
// same one the main editor canvas already uses for this exact case (see
// assetUrl()/displayableImageSource() in app.js) - without this, an
// imported image is selectable in the editor (only the id/path string is
// needed for that) but the Viewer, which needs the actual bytes, could only
// ever show its "image not found" fallback for anything but an http(s) URL.
function resolveImageUrl(filePath) {
  const path = String(filePath || "");
  if (/^https?:\/\//i.test(path)) return path;
  if (!path) return null;
  const appBase = window.location.pathname.endsWith("/")
    ? window.location.pathname
    : `${window.location.pathname}/`;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${appBase}api/v1/designer/assets/read/${encoded}`;
}

// Mirrors ensureFontLoaded() in app.js's Designer canvas. Without this, a
// project font backed by a real file (uploaded, imported, or a pinned
// web/MDI revision) never got its actual glyphs in the Viewer - only Google
// Fonts (by family name) and LVGL builtin bitmap fonts (by name, only ever
// approximated) got a font-family at all; anything else silently fell back
// to the browser's default font. Invisible for ordinary prose text, but it
// turns an inserted MDI icon glyph into a tofu box instead of the icon.
// One attempt per font id - "failed" is sticky, matching the canvas's
// fontLoadState cache.
const viewerFontLoadState = new Map();
const VIEWER_FONT_LOADED_EVENT = "esphome-viewer-font-loaded";

function ensureViewerFontLoaded(project, fontId) {
  if (!fontId || viewerFontLoadState.has(fontId)) return;
  const entry = (project.fonts || []).find((font) => font.id === fontId);
  // A `font: file: {type: web, url: ...}` entry keeps its URL in web_url,
  // not file_path (which stays empty for that source kind) - web_url is
  // already a full http(s) URL, so resolveImageUrl() returns it as-is.
  const source = entry?.file_path || entry?.web_url;
  if (!source) return;
  viewerFontLoadState.set(fontId, "loading");
  const face = new FontFace(fontFamilyId(fontId), `url(${JSON.stringify(resolveImageUrl(source))})`);
  face.load().then((loaded) => {
    document.fonts.add(loaded);
    viewerFontLoadState.set(fontId, "loaded");
    document.dispatchEvent(new CustomEvent(VIEWER_FONT_LOADED_EVENT));
  }).catch(() => {
    viewerFontLoadState.set(fontId, "failed");
  });
}

function viewerFont(project, reference) {
  if (!reference) return null;
  const raw = String(reference);
  const entry = (project.fonts || []).find((font) => font.id === raw);
  const inferredSize = Number.parseInt(raw.match(/(\d+)(?!.*\d)/)?.[1] || "", 10);
  const namedFamily = entry?.gfonts_family || entry?.builtin_name || null;
  const hasRealFile = Boolean(entry?.file_path || entry?.web_url);
  if (!namedFamily && hasRealFile) ensureViewerFontLoaded(project, raw);
  // Plain family names (Google/builtin) still need JSON.stringify at the
  // call site to become a valid CSS value; resolvedFontFamily() already
  // returns one (with its own sans-serif fallback baked in), so it is
  // marked pre-formatted here to tell applyStyleObject not to quote it
  // again.
  return {
    family: namedFamily,
    familyCss: namedFamily ? null : (hasRealFile ? resolvedFontFamily(raw) : null),
    size: Number(entry?.size) || inferredSize || null,
    weight: Number(entry?.gfonts_weight) || null,
    italic: Boolean(entry?.gfonts_italic),
  };
}

function imageSource(project, id) {
  const entry = (project.images || []).find((image) => image.id === id);
  return resolveImageUrl(entry?.file_path);
}

//: The `tile` a `tileview` currently shows - explicit `lvgl.tileview.select`
//: choice if any, else the tile at row 0/col 0 (ESPHome's own default start
//: position), else simply its first tile.
function activeTileFor(tileviewWidget, activeTiles) {
  const children = tileviewWidget.children || [];
  if (!children.length) return null;
  const explicitId = activeTiles?.[tileviewWidget.id];
  const explicit = explicitId && children.find((tile) => tile.id === explicitId);
  if (explicit) return explicit;
  return children.find((tile) => (tile.tile_row || 0) === 0 && (tile.tile_col || 0) === 0)
    || children[0];
}

//: The `tab` a `tabview` currently shows - explicit choice (tab-bar click or
//: `lvgl.tabview.select`) if any, else its first tab (ESPHome's own default).
function activeTabFor(tabviewWidget, activeTabs) {
  const children = tabviewWidget.children || [];
  if (!children.length) return null;
  const explicitId = activeTabs?.[tabviewWidget.id];
  const explicit = explicitId && children.find((tab) => tab.id === explicitId);
  return explicit || children[0];
}

function allWidgetItems(project, activeTiles = {}, activeTabs = {}) {
  const boxes = computeLayout(project);
  const result = [];
  const visit = (widgets, ancestorHidden = false, parent = null) => {
    (widgets || []).forEach((widget) => {
      const hidden = ancestorHidden || Boolean(widget.hidden);
      const box = boxes.get(widget) || {
        left: Number(widget.x) || 0,
        top: Number(widget.y) || 0,
        width: Number(widget.width) || 100,
        height: Number(widget.height) || 40,
      };
      // `tile`/`tab` are synthetic pseudo-widgets (see widgetschema.py) -
      // they never get their own visible box. Only the tileview's/tabview's
      // currently active tile/tab contributes its children to the render;
      // the rest stay hidden, which is this MVP's stand-in for real swipe
      // navigation (see the plan doc).
      if (widget.widget_type === "tile" || widget.widget_type === "tab") {
        visit(widget.children, hidden, parent);
        return;
      }
      result.push({ widget, box, hidden, parent });
      if (widget.widget_type === "tileview") {
        const active = activeTileFor(widget, activeTiles);
        (widget.children || []).forEach((tile) => {
          visit([tile], hidden || tile !== active, widget);
        });
      } else if (widget.widget_type === "tabview") {
        const active = activeTabFor(widget, activeTabs);
        (widget.children || []).forEach((tab) => {
          visit([tab], hidden || tab !== active, widget);
        });
      } else {
        visit(widget.children, hidden, widget);
      }
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
  (project.msgboxes || []).forEach((msgbox) => {
    roots.push(...(msgbox.buttons || []));
    roots.push(...(msgbox.header_buttons || []));
  });
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
  // bg_image_src wins over a gradient, same as real LVGL (it is the actual
  // visual background, not a fallback) and the same order the Designer
  // canvas already applies these two in (see renderWidget() in app.js).
  if (style.bg_image_src) {
    const source = imageSource(project, style.bg_image_src);
    if (source) {
      // `cover` is an approximation - LVGL's own bg_image scaling isn't
      // modeled here, same "plausible, not pixel-exact" spirit as the rest
      // of the layout engine.
      node.style.backgroundImage = `url("${source}")`;
      node.style.backgroundSize = "cover";
      node.style.backgroundPosition = "center";
    }
  }
  if (border) node.style.borderColor = border;
  if (style.border_width !== undefined) node.style.borderWidth = `${Math.max(0, Number(style.border_width) || 0)}px`;
  if (style.radius !== undefined) node.style.borderRadius = `${Math.max(0, Number(style.radius) || 0)}px`;
  if (text) node.style.color = text;
  const textAlign = viewerTextAlign(style.text_align);
  if (textAlign) node.style.textAlign = textAlign;
  const font = viewerFont(project, style.text_font);
  if (font?.family) node.style.fontFamily = JSON.stringify(font.family);
  else if (font?.familyCss) node.style.fontFamily = font.familyCss;
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
  if (found) return found;
  // A message box itself is not a WidgetNode (see msgbox_support.py) - it
  // only ever appears as a plain id target for lvgl.widget.show/.hide, so it
  // is looked up separately, as the actual mutable object from
  // project.msgboxes (not a copy), so `widget.hidden = ...` persists.
  return (project.msgboxes || []).find((msgbox) => String(msgbox.id || "") === String(id)) || null;
}

const RUNTIME_TARGET_WIDGET = {
  text: new Set(["label", "textarea"]),
  value: new Set(["slider", "bar", "arc"]),
  state_checked: new Set(["switch", "checkbox"]),
  selected_index: new Set(["dropdown", "roller"]),
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
  if (target === "value" || target === "selected_index") {
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
  else if (target === "value" || target === "selected_index") {
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

//: The one exception to "actions only ever carry literal values": an
//: options list is how ESPHome's own `lvgl.dropdown.update`/
//: `lvgl.roller.update` replace a dropdown/roller's choices at runtime.
function safeStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

//: Beyond the plain `return x;`/`return !x;` checked/unchecked pair, the
//: "Energiefluss" widget action (frontend/app.js's addWidgetAction(), type
//: "flow") generates two more lambda shapes for its threshold checks:
//: `return abs((int)x) <= N;` and `return x > 0;` (with any of
//: <, <=, >, >=). Both are simple enough to evaluate directly instead of
//: falling back to "not executed in the browser".
const ABS_COMPARE_RE = /^returnabs\(\(int\)x\)([<>]=?)(-?\d+(?:\.\d+)?);$/;
const VALUE_COMPARE_RE = /^returnx([<>]=?)(-?\d+(?:\.\d+)?);$/;

function compare(op, value, threshold) {
  if (op === "<=") return value <= threshold;
  if (op === "<") return value < threshold;
  if (op === ">=") return value >= threshold;
  return value > threshold;
}

function viewerConditionValue(condition, context) {
  const expression = String(condition?.lambda || "").replace(/\s+/g, "").toLowerCase();
  if (expression === "returnx;") return { supported: true, value: Boolean(context.x) };
  if (expression === "return!x;") return { supported: true, value: !Boolean(context.x) };
  const x = Number(context.x);
  if (Number.isFinite(x)) {
    const abs = expression.match(ABS_COMPARE_RE);
    if (abs) return { supported: true, value: compare(abs[1], Math.abs(x), Number(abs[2])) };
    const plain = expression.match(VALUE_COMPARE_RE);
    if (plain) return { supported: true, value: compare(plain[1], x, Number(plain[2])) };
  }
  return { supported: false, value: false };
}

export function applyViewerAction(project, action, runtime = {}, context = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { handled: false, changed: false, message: t("viewer.event.invalidAction") };
  }
  const entries = Object.entries(action);
  if (entries.length !== 1) {
    return { handled: false, changed: false, message: t("viewer.event.ambiguousAction") };
  }
  const [name, payload] = entries[0];

  if (name === "if") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { handled: false, changed: false, message: t("viewer.event.invalidCondition") };
    }
    const condition = viewerConditionValue(payload.condition, context);
    if (!condition.supported) {
      return { handled: false, changed: false, message: t("viewer.event.conditionNotExecuted") };
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
      message: `if (${condition.value ? t("viewer.event.true") : t("viewer.event.false")})${messages.length ? `: ${messages.join("; ")}` : ""}`,
    };
  }

  if (name === "lvgl.page.show") {
    const id = pageActionId(payload);
    const page = (project.pages || []).find((entry) => entry.id === id);
    if (!page) return {
      handled: true, changed: false, warning: true,
      message: t("viewer.event.pageNotFound", { id: id || t("viewer.event.noId") }),
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
      message: t("viewer.event.noReachablePage", { name }),
    };
    const changed = runtime.activePageId !== page.id;
    runtime.activePageId = page.id;
    return { handled: true, changed, message: `${name}: ${page.id}` };
  }

  if (name === "lvgl.tileview.select") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { handled: false, changed: false, message: t("viewer.event.invalidAction") };
    }
    const tileviewId = String(payload.id || "");
    const tileview = findWidget(project, tileviewId);
    if (!tileview || tileview.widget_type !== "tileview") {
      return {
        handled: true, changed: false, warning: true,
        message: t("viewer.event.updateNotFound", { id: tileviewId || t("viewer.event.noId") }),
      };
    }
    const children = tileview.children || [];
    let target = payload.tile_id
      ? children.find((tile) => tile.id === String(payload.tile_id))
      : null;
    if (!target && (payload.row !== undefined || payload.column !== undefined)) {
      const row = Number(payload.row) || 0;
      const column = Number(payload.column) || 0;
      target = children.find((tile) => (tile.tile_row || 0) === row && (tile.tile_col || 0) === column);
    }
    if (!target) {
      return {
        handled: true, changed: false, warning: true,
        message: t("viewer.event.updateNotFound", { id: tileviewId }),
      };
    }
    runtime.activeTiles ||= {};
    const changed = runtime.activeTiles[tileviewId] !== target.id;
    runtime.activeTiles[tileviewId] = target.id;
    return { handled: true, changed, message: `lvgl.tileview.select: ${target.id}` };
  }

  if (name === "lvgl.tabview.select") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { handled: false, changed: false, message: t("viewer.event.invalidAction") };
    }
    const tabviewId = String(payload.id || "");
    const tabview = findWidget(project, tabviewId);
    if (!tabview || tabview.widget_type !== "tabview") {
      return {
        handled: true, changed: false, warning: true,
        message: t("viewer.event.updateNotFound", { id: tabviewId || t("viewer.event.noId") }),
      };
    }
    const children = tabview.children || [];
    const index = Number(payload.index);
    const target = Number.isInteger(index) ? children[index] : undefined;
    if (!target) {
      return {
        handled: true, changed: false, warning: true,
        message: t("viewer.event.updateNotFound", { id: tabviewId }),
      };
    }
    runtime.activeTabs ||= {};
    const changed = runtime.activeTabs[tabviewId] !== target.id;
    runtime.activeTabs[tabviewId] = target.id;
    return { handled: true, changed, message: `lvgl.tabview.select: ${target.id}` };
  }

  if (["lvgl.spinbox.increment", "lvgl.spinbox.decrement"].includes(name)) {
    const direction = name.endsWith(".increment") ? 1 : -1;
    const ids = actionIds(payload);
    let changed = false;
    const rejected = [];
    ids.forEach((id) => {
      const widget = findWidget(project, id);
      if (!widget || widget.widget_type !== "spinbox") {
        rejected.push(id);
        return;
      }
      widget.properties ||= {};
      const decimals = Number(widget.properties.decimal_places) || 0;
      const step = decimals > 0 ? 1 / (10 ** decimals) : 1;
      widget.properties.value = Number(widget.properties.value || 0) + direction * step;
      changed = true;
    });
    if (!ids.length) return {
      handled: true, changed: false, warning: true, message: t("viewer.event.noValidWidgetId", { name }),
    };
    const detail = rejected.length ? t("viewer.event.notFoundSuffix", { ids: rejected.join(", ") }) : "";
    return {
      handled: true, changed, warning: Boolean(rejected.length),
      message: `${name}: ${ids.join(", ")}${detail}`,
    };
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
      handled: true, changed: false, warning: true, message: t("viewer.event.noValidWidgetId", { name }),
    };
    const suffix = missing.length ? t("viewer.event.notFoundSuffix", { ids: missing.join(", ") }) : "";
    return {
      handled: true, changed, warning: Boolean(missing.length),
      message: `${name}: ${ids.join(", ")}${suffix}`,
    };
  }

  if (["lvgl.animation.start", "lvgl.animation.stop", "lvgl.animimg.start", "lvgl.animimg.stop"].includes(name)) {
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
    const detail = rejected.length ? t("viewer.event.notAnimimgSuffix", { ids: rejected.join(", ") }) : "";
    return {
      handled: true,
      changed,
      warning: Boolean(rejected.length || !ids.length),
      message: `${name}: ${ids.join(", ") || t("viewer.event.noValidWidgetIdFallback")}${detail}`,
    };
  }

  const updateKeys = {
    "lvgl.widget.update": new Set(["hidden", "text", "value", "state_checked", ...RUNTIME_STYLE_KEYS]),
    "lvgl.label.update": new Set(["text", ...RUNTIME_STYLE_KEYS]),
    "lvgl.button.update": new Set(["text", ...RUNTIME_STYLE_KEYS]),
    "lvgl.image.update": new Set(["src", ...RUNTIME_STYLE_KEYS]),
    "lvgl.slider.update": new Set(["value", ...RUNTIME_STYLE_KEYS]),
    "lvgl.bar.update": new Set(["value", "start_value", "min_value", "max_value", "mode", "animated", ...RUNTIME_STYLE_KEYS]),
    "lvgl.arc.update": new Set([
      "value", "min_value", "max_value", "mode", "start_angle", "end_angle",
      "rotation", "adjustable", "change_rate", ...RUNTIME_STYLE_KEYS,
    ]),
    "lvgl.switch.update": new Set(["state_checked", ...RUNTIME_STYLE_KEYS]),
    "lvgl.dropdown.update": new Set(["selected_index", "options", ...RUNTIME_STYLE_KEYS]),
    "lvgl.roller.update": new Set(["selected_index", "options", ...RUNTIME_STYLE_KEYS]),
    "lvgl.textarea.update": new Set(["text", ...RUNTIME_STYLE_KEYS]),
    "lvgl.keyboard.update": new Set(["mode", "textarea", ...RUNTIME_STYLE_KEYS]),
    "lvgl.led.update": new Set(["color", "brightness", ...RUNTIME_STYLE_KEYS]),
    "lvgl.spinner.update": new Set(["arc_color", "arc_width", "arc_length", "arc_rounded", "spin_time"]),
    "lvgl.qrcode.update": new Set(["text", "size", "dark_color", "light_color", ...RUNTIME_STYLE_KEYS]),
    "lvgl.spinbox.update": new Set(["value"]),
    "lvgl.animimg.update": new Set(["duration", "repeat_count", ...RUNTIME_STYLE_KEYS]),
  };
  const updateWidgetTypes = {
    "lvgl.label.update": "label",
    "lvgl.button.update": "button",
    "lvgl.image.update": "image",
    "lvgl.slider.update": "slider",
    "lvgl.bar.update": "bar",
    "lvgl.arc.update": "arc",
    "lvgl.switch.update": "switch",
    "lvgl.dropdown.update": "dropdown",
    "lvgl.roller.update": "roller",
    "lvgl.textarea.update": "textarea",
    "lvgl.keyboard.update": "keyboard",
    "lvgl.led.update": "led",
    "lvgl.spinner.update": "spinner",
    "lvgl.qrcode.update": "qrcode",
    "lvgl.spinbox.update": "spinbox",
    "lvgl.animimg.update": "animimg",
  };
  const numericUpdateKeys = new Set([
    "value", "start_value", "min_value", "max_value", "start_angle", "end_angle",
    "rotation", "change_rate", "selected_index", "size", "arc_width", "arc_length",
  ]);
  const booleanUpdateKeys = new Set(["hidden", "state_checked", "animated", "adjustable", "arc_rounded"]);
  const listUpdateKeys = new Set(["options"]);
  if (updateKeys[name]) {
    let changed = false;
    const notes = [];
    const updates = updatePayloads(payload);
    updates.forEach((update) => {
      if (!safeLiteral(update.id)) {
        notes.push(t("viewer.event.missingId"));
        return;
      }
      const widget = findWidget(project, update.id);
      if (!widget) {
        notes.push(t("viewer.event.updateNotFound", { id: update.id }));
        return;
      }
      if (updateWidgetTypes[name] && widget.widget_type !== updateWidgetTypes[name]) {
        notes.push(t("viewer.event.notWidgetType", { id: update.id, type: updateWidgetTypes[name] }));
        return;
      }
      Object.entries(update).forEach(([key, value]) => {
        if (key === "id") return;
        const isListKey = listUpdateKeys.has(key);
        if (!updateKeys[name].has(key) || (isListKey ? !safeStringList(value) : !safeLiteral(value))) {
          notes.push(t("viewer.event.notAllowed", { ref: `${widget.id}.${key}` }));
          return;
        }
        if (booleanUpdateKeys.has(key) && typeof value !== "boolean") {
          notes.push(t("viewer.event.expectedBoolean", { ref: `${widget.id}.${key}` }));
          return;
        }
        if (numericUpdateKeys.has(key) && !Number.isFinite(Number(value))) {
          notes.push(t("viewer.event.expectedNumeric", { ref: `${widget.id}.${key}` }));
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
          else if (isListKey) widget.properties[key] = value.map(String);
          else widget.properties[key] = String(value ?? "");
        }
        changed = true;
      });
    });
    if (!updates.length) notes.push(t("viewer.event.noValidUpdateData"));
    const detail = notes.length ? ` (${notes.join("; ")})` : "";
    return { handled: true, changed, warning: Boolean(notes.length), message: `${name}${detail}` };
  }

  return { handled: false, changed: false, message: t("viewer.event.notExecutedInBrowser", { name }) };
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
  if (widget.widget_type === "label"
      || (widget.widget_type === "button" && Object.hasOwn(widget.properties || {}, "text"))) {
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
  if (widget.widget_type === "checkbox") {
    const wrapper = document.createElement("span");
    wrapper.className = "viewer-checkbox";
    const indicator = document.createElement("span");
    indicator.className = "viewer-checkbox-indicator";
    if (widget.properties?.state_checked) indicator.classList.add("checked");
    applyPartStyle(indicator, project, widget, "indicator", activeStates);
    const text = document.createElement("span");
    text.className = "viewer-widget-text";
    text.textContent = textContent(widget);
    wrapper.append(indicator, text);
    return wrapper;
  }
  if (widget.widget_type === "dropdown" || widget.widget_type === "roller") {
    const options = Array.isArray(widget.properties?.options) ? widget.properties.options : [];
    const select = document.createElement("select");
    select.className = widget.widget_type === "dropdown" ? "viewer-dropdown" : "viewer-roller";
    options.forEach((label, index) => select.append(new Option(String(label), String(index))));
    if (widget.widget_type === "roller") {
      select.size = Math.max(1, Number(widget.properties?.visible_row_count) || 3);
    }
    const selectedIndex = clamp(Number(widget.properties?.selected_index) || 0, 0, Math.max(0, options.length - 1));
    select.value = String(selectedIndex);
    return select;
  }
  if (widget.widget_type === "textarea") {
    const props = widget.properties || {};
    const oneLine = Boolean(props.one_line);
    const el = document.createElement(oneLine ? "input" : "textarea");
    el.className = "viewer-textarea";
    if (oneLine) el.type = props.password_mode ? "password" : "text";
    el.value = String(props.text ?? "");
    if (props.placeholder_text) el.placeholder = String(props.placeholder_text);
    if (Number(props.max_length) > 0) el.maxLength = Number(props.max_length);
    return el;
  }
  if (widget.widget_type === "keyboard") {
    // The real device has no physical keyboard, but the browser Viewer's
    // textarea is a normal HTML control - typing already works directly on
    // it via the host's actual keyboard, so this only needs to exist as a
    // visual placeholder, not a functional on-screen key-press simulator.
    const box = document.createElement("span");
    box.className = "viewer-keyboard";
    box.textContent = "⌨";
    return box;
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
  if (widget.widget_type === "tabview") {
    // Deliberately simplified MVP (see plan doc 3a.6): a real tab bar, but
    // always along the top regardless of `position`, no swipe gesture
    // support - the same "functionally correct base simulation, not a full
    // LVGL rebuild" approach already used for `keyboard`/`tileview`.
    const bar = document.createElement("span");
    bar.className = "viewer-tabview-bar";
    (widget.children || []).forEach((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "viewer-tab-button";
      button.dataset.tabId = tab.id || "";
      button.textContent = tab.tab_title || tab.id || "";
      bar.append(button);
    });
    return bar;
  }
  if (widget.widget_type === "led") {
    const props = widget.properties || {};
    const dot = document.createElement("span");
    dot.className = "viewer-led";
    const color = resolveViewerColor(project, props.color) || "#ff0000";
    const brightness = viewerOpacity(props.brightness) ?? 1;
    dot.style.background = color;
    dot.style.opacity = String(Math.max(0.1, brightness));
    return dot;
  }
  if (widget.widget_type === "spinner") {
    // CSS-animated ring instead of the SVG arc machinery `arc` uses - a
    // spinner never needs drag interaction or precise sweep math, only a
    // colour and a rotation speed.
    const props = widget.properties || {};
    const ring = document.createElement("span");
    ring.className = "viewer-spinner";
    const color = resolveViewerColor(project, props.arc_color) || "#20c7b7";
    ring.style.borderTopColor = color;
    ring.style.borderRightColor = color;
    const spinTime = String(props.spin_time || "2s");
    ring.style.animationDuration = /^[\d.]+$/.test(spinTime) ? `${spinTime}ms` : spinTime;
    return ring;
  }
  if (widget.widget_type === "qrcode") {
    // No QR-generation library is bundled (self-contained artifact policy) -
    // a labelled placeholder showing the encoded text is the same
    // "functionally indicative, not pixel-real" simplification already used
    // for `keyboard`.
    const box = document.createElement("span");
    box.className = "viewer-qrcode";
    box.textContent = textContent(widget) || "QR";
    return box;
  }
  if (widget.widget_type === "spinbox") {
    const props = widget.properties || {};
    const decimals = clamp(Number(props.decimal_places) || 0, 0, 6);
    const value = Number(props.value) || 0;
    const el = document.createElement("span");
    el.className = "viewer-spinbox";
    el.textContent = value.toFixed(decimals);
    return el;
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
  const { widget, box, hidden, parent } = item;
  const node = document.createElement("div");
  node.className = "viewer-widget";
  node.dataset.type = widget.widget_type;
  node.dataset.widgetId = widget.id || "";
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${Math.max(1, box.width)}px`;
  node.style.height = `${Math.max(1, box.height)}px`;
  node.hidden = hidden;
  // The layout preview uses flat absolutely-positioned siblings. In LVGL the
  // image/label really are children of the button and a click reaches the
  // parent button. Let pointer hit-testing pass through those visual children
  // so the browser viewer behaves the same way.
  if (parent?.widget_type === "button" && ["image", "label"].includes(widget.widget_type)) {
    node.classList.add("viewer-button-content");
    node.style.pointerEvents = "none";
  }
  const activeStates = [];
  if (["switch", "button"].includes(widget.widget_type) && widget.properties?.state_checked) {
    activeStates.push("checked");
  }
  if (widget.properties?.disabled || widget.extra?.disabled) activeStates.push("disabled");
  applyStyle(node, project, widget, activeStates);

  if (!SUPPORTED_WIDGETS.has(widget.widget_type)) {
    warnings.add(t("viewer.event.unsupportedWidgetType", { type: widget.widget_type }));
    node.classList.add("unsupported");
    node.textContent = `${widget.widget_type}: ${widget.id || t("viewer.event.noId")}`;
    return node;
  }

  const content = renderWidgetContent(project, widget, timers, activeStates);
  if (content) node.append(content);
  if (widget.widget_type === "tabview") {
    const active = activeTabFor(widget, controller.runtime?.activeTabs);
    node.querySelectorAll(".viewer-tab-button").forEach((button) => {
      button.classList.toggle("active", Boolean(active) && button.dataset.tabId === active.id);
    });
  }
  if (activeStates.includes("disabled")) {
    node.classList.add("viewer-disabled");
    node.setAttribute("aria-disabled", "true");
  }
  controller.bindWidget(node, widget);
  return node;
}

//: Renders one button (a plain WidgetNode-shaped entry, see msgbox_support.py)
//: as an in-flow flex child instead of an absolutely-positioned canvas box -
//: a msgbox footer/header row auto-lays its buttons out, real x/y on the
//: button entries is not meaningful there.
function renderMsgboxButton(project, button, timers, warnings, controller) {
  const box = { left: 0, top: 0, width: Number(button.width) || 90, height: Number(button.height) || 36 };
  const node = renderWidget(project, { widget: button, box, hidden: false, parent: null }, timers, warnings, controller);
  node.style.position = "static";
  node.style.width = "auto";
  node.style.height = "auto";
  return node;
}

function renderMsgboxOverlay(project, msgbox, timers, warnings, controller) {
  const dialog = document.createElement("div");
  dialog.className = "viewer-msgbox";
  dialog.dataset.widgetId = msgbox.id || "";
  dialog.hidden = msgbox.hidden !== false;

  const header = document.createElement("div");
  header.className = "viewer-msgbox-header";
  const title = document.createElement("span");
  title.className = "viewer-msgbox-title";
  title.textContent = String(msgbox.title || "");
  header.append(title);
  (msgbox.header_buttons || []).forEach((button) => {
    header.append(renderMsgboxButton(project, button, timers, warnings, controller));
  });
  if (msgbox.close_button !== false) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "viewer-msgbox-close";
    close.textContent = "✕";
    close.addEventListener("click", () => {
      msgbox.hidden = true;
      controller.recordEvent("state", `${msgbox.id || "msgbox"}: ${t("viewer.event.stateInactive")}`);
      controller.render();
    });
    header.append(close);
  }
  dialog.append(header);

  const bodyText = msgbox.body?.text;
  if (bodyText) {
    const body = document.createElement("div");
    body.className = "viewer-msgbox-body";
    body.textContent = String(bodyText);
    dialog.append(body);
  }

  if ((msgbox.buttons || []).length) {
    const footer = document.createElement("div");
    footer.className = "viewer-msgbox-footer";
    msgbox.buttons.forEach((button) => {
      footer.append(renderMsgboxButton(project, button, timers, warnings, controller));
    });
    dialog.append(footer);
  }

  return dialog;
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
    this.runtime = { activePageId: "", activeTiles: {}, activeTabs: {} };
    this.runtimeBindings = [];
    this.runtimeStates = new Map();
    this.runtimeDevices = new Map();
    this.runtimeTimer = null;
    this.animationFrame = null;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.dialog.open && this.fitMode) this.fit();
    });
    this.resizeObserver.observe(this.stage);
    // ensureViewerFontLoaded() above resolves asynchronously (it has no
    // access to this controller instance from inside a plain render
    // helper) - it announces a finished font load on the document instead,
    // and re-renders here so the widget that triggered it picks up the
    // real glyphs without the user having to reopen the dialog.
    document.addEventListener(VIEWER_FONT_LOADED_EVENT, () => {
      if (this.dialog.open) this.render();
    });
  }

  open(project, {
    name = "Lokales Projekt", backgroundPreview = null, runtimeBindings = [], runtimeSnapshot = null,
  } = {}) {
    this.stopAnimations();
    this.stopRuntimeTimer();
    this.sourceProject = cloneViewerProject(project);
    this.project = cloneViewerProject(this.sourceProject);
    // Real ESPHome msgboxes always start hidden - there is no "visible at
    // boot" config option, only lvgl.widget.show/.hide at runtime.
    (this.project.msgboxes || []).forEach((msgbox) => { msgbox.hidden = true; });
    this.name = name;
    this.backgroundPreview = backgroundPreview;
    this.zoom = 1;
    this.rotation = 0;
    this.rotationControl.value = "0";
    this.fitMode = true;
    this.logEntries = [];
    this.runtime = { activePageId: this.project.pages?.[0]?.id || "", activeTiles: {}, activeTabs: {} };
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
    (this.project.msgboxes || []).forEach((msgbox) => { msgbox.hidden = true; });
    this.runtime = { activePageId: this.project.pages?.[0]?.id || "", activeTiles: {}, activeTabs: {} };
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
      ? t("viewer.status.liveSuffix", { online, total: liveDevices.size, bindings: this.runtimeBindings.length })
      : "";
    this.status.textContent = warningCount
      ? `${t("viewer.status.prefix")}${live} · ${t("viewer.status.warnings", { count: warningCount })}`
      : `${t("viewer.status.prefix")}${live} · ${t("viewer.status.pixelNote")}`;
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
      empty.textContent = t("viewer.noEvents");
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
      if (["label", "button", "checkbox"].includes(widget.widget_type)) {
        const text = node.querySelector(".viewer-widget-text");
        if (text) text.textContent = textContent(widget);
      } else if (widget.widget_type === "image") {
        const content = node.querySelector(".viewer-image, .viewer-image-fallback");
        const replacement = renderImage(this.project, widget, widget.properties?.src);
        if (content) content.replaceWith(replacement);
        else node.prepend(replacement);
      } else if (widget.widget_type === "textarea") {
        const el = node.querySelector(".viewer-textarea");
        if (el && document.activeElement !== el) el.value = String(widget.properties?.text ?? "");
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
          this.recordEvent("state", `${widget.id || "button"}: ${widget.properties.state_checked ? t("viewer.event.stateActive") : t("viewer.event.stateInactive")}`);
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
        this.recordEvent("state", `${widget.id || "switch"}: ${widget.properties.state_checked ? t("viewer.event.stateOn") : t("viewer.event.stateOff")}`);
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

    if (widget.widget_type === "checkbox") {
      node.classList.add("viewer-interactive");
      node.tabIndex = 0;
      node.setAttribute("role", "checkbox");
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
        this.recordEvent("state", `${widget.id || "checkbox"}: ${widget.properties.state_checked ? t("viewer.event.stateOn") : t("viewer.event.stateOff")}`);
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

    if (widget.widget_type === "tabview") {
      node.classList.add("viewer-interactive");
      node.querySelectorAll(".viewer-tab-button").forEach((button) => {
        button.addEventListener("click", () => {
          const tabId = button.dataset.tabId;
          if (!tabId || this.runtime.activeTabs?.[widget.id] === tabId) return;
          this.runtime.activeTabs ||= {};
          this.runtime.activeTabs[widget.id] = tabId;
          this.recordEvent("state", `${widget.id || "tabview"}: ${tabId}`);
          const context = { tab: tabId };
          this.runEvent(widget, "on_value", context);
          this.runEvent(widget, "on_change", context);
          this.render();
        });
      });
      return;
    }

    if (widget.widget_type === "dropdown" || widget.widget_type === "roller") {
      node.classList.add("viewer-interactive");
      const select = node.querySelector(`select.viewer-${widget.widget_type}`);
      if (!select) return;
      select.addEventListener("change", () => {
        widget.properties ||= {};
        widget.properties.selected_index = Number(select.value);
        this.recordEvent("state", `${widget.id || widget.widget_type}: ${select.value}`);
        const context = { x: Number(select.value) };
        const valueChanged = this.runEvent(widget, "on_value", context);
        const changeChanged = this.runEvent(widget, "on_change", context);
        if (valueChanged || changeChanged) this.render();
      });
      return;
    }

    if (widget.widget_type === "textarea") {
      node.classList.add("viewer-interactive");
      const el = node.querySelector(".viewer-textarea");
      if (!el) return;
      el.addEventListener("input", () => {
        widget.properties ||= {};
        widget.properties.text = el.value;
        this.runEvent(widget, "on_value", { text: el.value });
      });
      if (Boolean(widget.properties?.one_line)) {
        el.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.runEvent(widget, "on_ready", { text: el.value });
          }
        });
      }
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
      const option = new Option(`${page.id}${page.skip ? t("surface.pageSkippedSuffix") : ""}`, page.id);
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
      allWidgetItems(scopedProject, this.runtime.activeTiles, this.runtime.activeTabs).forEach((item) => {
        layer.append(renderWidget(scopedProject, item, this.timers, warnings, this));
      });
      this.display.append(layer);
    });
    this.display.append(glowFront);

    (this.project.msgboxes || []).forEach((msgbox) => {
      this.display.append(renderMsgboxOverlay(this.project, msgbox, this.timers, warnings, this));
    });

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
