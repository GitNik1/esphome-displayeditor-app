// @ts-check

const STYLE_BRANCHES = new Set([
  "states", "indicator", "knob", "items", "ticks", "selected", "scrollbar", "cursor", "list",
]);

/** @param {number} value @param {number} minimum @param {number} maximum */
export const clamp = (value, minimum, maximum) => (
  Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum)
);

/** @param {unknown} value */
export function viewerTextAlign(value) {
  const align = String(value || "").trim().toUpperCase();
  return /** @type {Record<string, string>} */ ({ LEFT: "left", CENTER: "center", RIGHT: "right", AUTO: "start" })[align] || "";
}

/** @param {Record<string, any>} target @param {unknown} source */
function mergeStyle(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target;
  Object.entries(source).forEach(([key, value]) => {
    if (!STYLE_BRANCHES.has(key)) target[key] = value;
  });
  return target;
}

/** @param {any} project @param {any} widget @param {string | string[]} [activeState] */
export function effectiveViewerStyle(project, widget, activeState = "") {
  const result = {};
  const activeStates = Array.isArray(activeState) ? activeState.filter(Boolean) : [activeState].filter(Boolean);
  const theme = project.theme?.[widget.widget_type];
  mergeStyle(result, theme);
  if (widget.style_mode === "named") {
    (widget.style_refs || []).forEach((/** @type {string} */ reference) => {
      const entry = (project.styles || []).find((/** @type {any} */ style) => style.id === reference);
      mergeStyle(result, entry?.style_tree);
    });
  }
  mergeStyle(result, widget.style_tree);
  activeStates.forEach((state) => {
    mergeStyle(result, theme?.states?.[state]);
    if (widget.style_mode === "named") {
      (widget.style_refs || []).forEach((/** @type {string} */ reference) => {
        const entry = (project.styles || []).find((/** @type {any} */ style) => style.id === reference);
        mergeStyle(result, entry?.style_tree?.states?.[state]);
      });
    }
    mergeStyle(result, widget.style_tree?.states?.[state]);
  });
  return result;
}

/** @param {any} project @param {any} widget @param {string} part
 * @param {string | string[]} [activeState] */
export function effectiveViewerPartStyle(project, widget, part, activeState = "") {
  const result = {};
  const activeStates = Array.isArray(activeState) ? activeState.filter(Boolean) : [activeState].filter(Boolean);
  const theme = project.theme?.[widget.widget_type];
  mergeStyle(result, theme?.[part]);
  if (widget.style_mode === "named") {
    (widget.style_refs || []).forEach((/** @type {string} */ reference) => {
      const entry = (project.styles || []).find((/** @type {any} */ style) => style.id === reference);
      mergeStyle(result, entry?.style_tree?.[part]);
    });
  }
  mergeStyle(result, widget.style_tree?.[part]);
  activeStates.forEach((state) => {
    mergeStyle(result, theme?.states?.[state]?.[part]);
    if (widget.style_mode === "named") {
      (widget.style_refs || []).forEach((/** @type {string} */ reference) => {
        const entry = (project.styles || []).find((/** @type {any} */ style) => style.id === reference);
        mergeStyle(result, entry?.style_tree?.states?.[state]?.[part]);
      });
    }
    mergeStyle(result, widget.style_tree?.states?.[state]?.[part]);
  });
  return result;
}

/** @param {any} project @param {unknown} value */
export function resolveViewerColor(project, value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  const libraryEntry = (project.colors || []).find((/** @type {any} */ entry) => entry.id === raw);
  const candidate = String(libraryEntry?.hex || raw).trim().replace(/^#/, "").replace(/^0x/i, "");
  if (/^[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(candidate)) return `#${candidate.toUpperCase()}`;
  return null;
}

/** @param {unknown} value */
export function viewerOpacity(value) {
  if (value === null || value === undefined || value === "") return null;
  const upper = String(value).trim().toUpperCase();
  if (upper === "COVER") return 1;
  if (upper === "TRANSP") return 0;
  const number = Number.parseFloat(upper.replace("%", ""));
  if (!Number.isFinite(number)) return null;
  return clamp(number > 1 ? number / 100 : number, 0, 1);
}

/** @param {string | null} color @param {number | null} opacity */
export function colorWithOpacity(color, opacity) {
  if (!color || opacity === null || opacity >= 1) return color;
  const hex = color.replace("#", "");
  const expanded = hex.length === 3 ? hex.split("").map((character) => character + character).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return color;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${clamp(opacity, 0, 1)})`;
}

/** @param {any} project @param {any} style */
export function viewerGradientBackground(project, style) {
  const background = resolveViewerColor(project, style?.bg_color);
  const gradient = resolveViewerColor(project, style?.bg_grad_color);
  const direction = String(style?.bg_grad_dir || "").toUpperCase();
  if (!background || !gradient || !["HOR", "VER"].includes(direction)) return "";
  const cssDirection = direction === "HOR" ? "to right" : "to bottom";
  const opacity = viewerOpacity(style?.bg_opa);
  return `linear-gradient(${cssDirection}, ${colorWithOpacity(background, opacity)}, ${colorWithOpacity(gradient, opacity)})`;
}
