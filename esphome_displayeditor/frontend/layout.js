// Approximates LVGL's layout so an imported config shows up in a recognisable
// arrangement instead of stacking at the origin.
//
// A hand-written config rarely gives absolute coordinates: widgets are placed
// by grid cells and flex flow, and their sizes come out of the layout. This
// module resolves that into concrete boxes for the canvas.
//
// It is an approximation, not an emulation. LVGL is not CSS: it computes on
// the device with its own font metrics, which we do not have. Positions are
// plausible, not pixel-exact - check the real thing with an SDL preview.

const ALIGN_ANCHORS = {
  TOP_LEFT: [0, 0], TOP_MID: [0.5, 0], TOP_RIGHT: [1, 0],
  LEFT_MID: [0, 0.5], CENTER: [0.5, 0.5], RIGHT_MID: [1, 0.5],
  BOTTOM_LEFT: [0, 1], BOTTOM_MID: [0.5, 1], BOTTOM_RIGHT: [1, 1],
};

// Where a widget sits relative to another one it is aligned to.
const OUT_ANCHORS = {
  OUT_TOP_LEFT: [0, -1, 0, 0], OUT_TOP_MID: [0.5, -1, 0.5, 0], OUT_TOP_RIGHT: [1, -1, 1, 0],
  OUT_BOTTOM_LEFT: [0, 1, 0, 1], OUT_BOTTOM_MID: [0.5, 1, 0.5, 1], OUT_BOTTOM_RIGHT: [1, 1, 1, 1],
  OUT_LEFT_TOP: [-1, 0, 0, 0], OUT_LEFT_MID: [-1, 0.5, 0, 0.5], OUT_LEFT_BOTTOM: [-1, 1, 0, 1],
  OUT_RIGHT_TOP: [1, 0, 1, 0], OUT_RIGHT_MID: [1, 0.5, 1, 0.5], OUT_RIGHT_BOTTOM: [1, 1, 1, 1],
};

const DEFAULT_SIZE = { width: 100, height: 40 };
const DEFAULT_FONT_SIZE = 16;

let measureContext = null;

function measureText(text, fontSize) {
  if (!measureContext) measureContext = document.createElement("canvas").getContext("2d");
  measureContext.font = `${fontSize}px sans-serif`;
  const lines = String(text).split("\n");
  const width = Math.max(...lines.map((line) => measureContext.measureText(line).width));
  return { width: Math.ceil(width), height: Math.ceil(lines.length * fontSize * 1.25) };
}

// --- value helpers ----------------------------------------------------------

export function parseTrack(value) {
  if (typeof value === "number") return { px: value };
  const text = String(value ?? "").trim().toUpperCase();
  const fr = text.match(/^FR\((\d+(?:\.\d+)?)\)$/);
  if (fr) return { fr: Number(fr[1]) };
  if (text === "CONTENT") return { content: true };
  const number = Number(text);
  return Number.isFinite(number) ? { px: number } : { content: true };
}

function resolveSize(value, parentExtent, intrinsic, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return value;
  const text = String(value).trim();
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    return Number.isFinite(percent) ? (parentExtent * percent) / 100 : fallback;
  }
  if (text.toUpperCase() === "SIZE_CONTENT") return intrinsic;
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function styleOf(project, widget) {
  // A named style lives in the library; inline overrides sit on the widget.
  const merged = {};
  if (widget.style_mode === "named") {
    (widget.style_refs || []).forEach((ref) => {
      const entry = (project.styles || []).find((s) => s.id === ref);
      if (entry) Object.assign(merged, entry.style_tree || {});
    });
  }
  const theme = (project.theme || {})[widget.widget_type];
  return { ...(theme || {}), ...merged, ...(widget.style_tree || {}) };
}

function padding(style) {
  const all = Number(style.pad_all) || 0;
  return {
    top: Number(style.pad_top ?? all) || 0,
    right: Number(style.pad_right ?? all) || 0,
    bottom: Number(style.pad_bottom ?? all) || 0,
    left: Number(style.pad_left ?? all) || 0,
  };
}

function fontSize(project, style) {
  const id = style.text_font || project.default_font;
  const font = (project.fonts || []).find((f) => f.id === id);
  if (font?.size) return Number(font.size);
  // ESPHome's builtin fonts are named montserrat_<size>; nothing else to go on.
  const guess = String(id || "").match(/_(\d+)$/);
  return guess ? Number(guess[1]) : DEFAULT_FONT_SIZE;
}

function imageSize(project, srcId) {
  const id = Array.isArray(srcId) ? srcId[0] : srcId;
  const entry = (project.images || []).find((i) => i.id === id);
  // `resize: 560x680` states the final size exactly - no image load needed.
  const resize = String(entry?.resize || "").match(/^(\d+)\s*x\s*(\d+)$/i);
  if (resize) return { width: Number(resize[1]), height: Number(resize[2]) };
  return null;
}

// --- pass 1: intrinsic sizes -----------------------------------------------

function intrinsicSize(project, widget, cache) {
  if (cache.has(widget)) return cache.get(widget);
  const style = styleOf(project, widget);
  let size;

  if (widget.widget_type === "label") {
    size = measureText(widget.properties?.text ?? "", fontSize(project, style));
  } else if (widget.widget_type === "image" || widget.widget_type === "animimg") {
    size = imageSize(project, widget.properties?.src) || { ...DEFAULT_SIZE };
  } else if ((widget.children || []).length) {
    // A container is as big as the arrangement of its children.
    const pad = padding(style);
    const boxes = new Map();
    placeChildren(project, widget.children, widget.layout || {}, style,
                  { x: 0, y: 0, width: 0, height: 0 }, boxes, cache);
    let width = 0;
    let height = 0;
    boxes.forEach((box) => {
      width = Math.max(width, box.left + box.width);
      height = Math.max(height, box.top + box.height);
    });
    size = { width: width + pad.left + pad.right, height: height + pad.top + pad.bottom };
  } else {
    size = { ...DEFAULT_SIZE };
  }

  cache.set(widget, size);
  return size;
}

// --- pass 2: placement ------------------------------------------------------

function trackSizes(specs, extent, gap, contentSizes) {
  const parsed = specs.map(parseTrack);
  const sizes = parsed.map((track, index) => {
    if (track.px !== undefined) return track.px;
    if (track.content) return contentSizes[index] || 0;
    return 0;
  });
  const used = sizes.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, specs.length - 1);
  const totalFr = parsed.reduce((sum, track) => sum + (track.fr || 0), 0);
  const free = Math.max(0, extent - used);
  if (totalFr > 0) {
    parsed.forEach((track, index) => {
      if (track.fr) sizes[index] = (free * track.fr) / totalFr;
    });
  }
  return sizes;
}

function trackOffsets(sizes, gap) {
  const offsets = [];
  let running = 0;
  sizes.forEach((size) => {
    offsets.push(running);
    running += size + gap;
  });
  return offsets;
}

function placeGrid(project, children, layout, style, box, boxes, cache) {
  const gapX = Number(style.pad_column ?? layout.pad_column) || 0;
  const gapY = Number(style.pad_row ?? layout.pad_row) || 0;
  const columnSpecs = layout.grid_columns || ["FR(1)"];
  const rowSpecs = layout.grid_rows || ["FR(1)"];

  // A CONTENT track is as wide as the widest child that occupies it alone;
  // spanning children are ignored, which is where this is an approximation.
  const contentW = columnSpecs.map(() => 0);
  const contentH = rowSpecs.map(() => 0);
  children.forEach((child) => {
    const cell = child.grid_cell || {};
    const intrinsic = intrinsicSize(project, child, cache);
    if ((cell.column_span ?? 1) === 1) {
      const column = cell.column_pos ?? 0;
      contentW[column] = Math.max(contentW[column] || 0, intrinsic.width);
    }
    if ((cell.row_span ?? 1) === 1) {
      const row = cell.row_pos ?? 0;
      contentH[row] = Math.max(contentH[row] || 0, intrinsic.height);
    }
  });

  const columns = trackSizes(columnSpecs, box.width, gapX, contentW);
  const rows = trackSizes(rowSpecs, box.height, gapY, contentH);
  const columnAt = trackOffsets(columns, gapX);
  const rowAt = trackOffsets(rows, gapY);

  children.forEach((child) => {
    const cell = child.grid_cell || {};
    const column = Math.min(cell.column_pos ?? 0, columns.length - 1);
    const row = Math.min(cell.row_pos ?? 0, rows.length - 1);
    const columnSpan = Math.max(1, cell.column_span ?? 1);
    const rowSpan = Math.max(1, cell.row_span ?? 1);

    let cellWidth = 0;
    for (let i = column; i < Math.min(column + columnSpan, columns.length); i += 1) {
      cellWidth += columns[i] + (i > column ? gapX : 0);
    }
    let cellHeight = 0;
    for (let i = row; i < Math.min(row + rowSpan, rows.length); i += 1) {
      cellHeight += rows[i] + (i > row ? gapY : 0);
    }

    const intrinsic = intrinsicSize(project, child, cache);
    const xAlign = cell.x_align ?? layout.grid_cell_x_align ?? "START";
    const yAlign = cell.y_align ?? layout.grid_cell_y_align ?? "START";
    let width = resolveSize(child.width, cellWidth, intrinsic.width,
                            xAlign === "STRETCH" ? cellWidth : intrinsic.width);
    let height = resolveSize(child.height, cellHeight, intrinsic.height,
                             yAlign === "STRETCH" ? cellHeight : intrinsic.height);
    if (xAlign === "STRETCH" && child.width == null) width = cellWidth;
    if (yAlign === "STRETCH" && child.height == null) height = cellHeight;

    const cellX = box.x + columnAt[column];
    const cellY = box.y + rowAt[row];
    // x/y are offsets on top of the cell placement, not replacements for it -
    // which is how an absolutely positioned widget can live inside a grid.
    boxes.set(child, {
      left: cellX + alignOffset(xAlign, cellWidth, width) + (Number(child.x) || 0),
      top: cellY + alignOffset(yAlign, cellHeight, height) + (Number(child.y) || 0),
      width, height, managed: true, originX: cellX, originY: cellY,
    });
  });
}

function alignOffset(align, available, size) {
  if (align === "CENTER") return (available - size) / 2;
  if (align === "END") return available - size;
  return 0;
}

const MAIN_DISTRIBUTIONS = {
  START: 0, END: 1, CENTER: 0.5,
};

function placeFlex(project, children, layout, style, box, boxes, cache) {
  const flow = String(layout.flex_flow || "ROW").toUpperCase();
  const horizontal = flow.startsWith("ROW");
  const reverse = flow.includes("REVERSE");
  const wrap = flow.includes("WRAP");
  const gapMain = Number(horizontal ? style.pad_column : style.pad_row) || 0;
  const gapCross = Number(horizontal ? style.pad_row : style.pad_column) || 0;

  const mainExtent = horizontal ? box.width : box.height;
  const crossExtent = horizontal ? box.height : box.width;

  const items = children.map((child) => {
    const intrinsic = intrinsicSize(project, child, cache);
    const width = resolveSize(child.width, box.width, intrinsic.width, intrinsic.width);
    const height = resolveSize(child.height, box.height, intrinsic.height, intrinsic.height);
    return {
      child, width, height,
      main: horizontal ? width : height,
      cross: horizontal ? height : width,
      grow: Number((child.style_tree || {}).flex_grow) || 0,
    };
  });
  if (reverse) items.reverse();

  const tracks = [];
  let current = [];
  let used = 0;
  items.forEach((item) => {
    if (wrap && current.length && used + gapMain + item.main > mainExtent) {
      tracks.push({ items: current, used });
      current = [];
      used = 0;
    }
    used += (current.length ? gapMain : 0) + item.main;
    current.push(item);
  });
  if (current.length) tracks.push({ items: current, used });

  const trackCross = tracks.map((track) => Math.max(0, ...track.items.map((i) => i.cross)));
  const totalCross = trackCross.reduce((sum, v) => sum + v, 0) + gapCross * Math.max(0, tracks.length - 1);
  let crossCursor = distributionStart(layout.flex_align_track, crossExtent, totalCross);

  tracks.forEach((track, trackIndex) => {
    const grow = track.items.reduce((sum, i) => sum + i.grow, 0);
    const free = Math.max(0, mainExtent - track.used);
    if (grow > 0) {
      track.items.forEach((item) => { item.main += (free * item.grow) / grow; });
      track.used = mainExtent;
    }
    const spacing = distribution(layout.flex_align_main, track.items.length,
                                 mainExtent, track.used, gapMain);
    let mainCursor = spacing.start;

    track.items.forEach((item) => {
      const crossSize = String(layout.flex_align_cross).toUpperCase() === "STRETCH"
        ? trackCross[trackIndex]
        : item.cross;
      const crossOffset = crossCursor + alignOffset(
        String(layout.flex_align_cross || "START").toUpperCase(),
        trackCross[trackIndex], crossSize);

      const left = box.x + (horizontal ? mainCursor : crossOffset);
      const top = box.y + (horizontal ? crossOffset : mainCursor);
      const width = horizontal ? item.main : crossSize;
      const height = horizontal ? crossSize : item.main;

      boxes.set(item.child, {
        left: left + (Number(item.child.x) || 0),
        top: top + (Number(item.child.y) || 0),
        width, height, managed: true, originX: left, originY: top,
      });
      mainCursor += item.main + spacing.gap;
    });
    crossCursor += trackCross[trackIndex] + gapCross;
  });
}

function distributionStart(align, extent, total) {
  const fraction = MAIN_DISTRIBUTIONS[String(align || "START").toUpperCase()] ?? 0;
  return (extent - total) * fraction;
}

function distribution(align, count, extent, used, gap) {
  const key = String(align || "START").toUpperCase();
  const free = Math.max(0, extent - used);
  if (key === "SPACE_BETWEEN" && count > 1) return { start: 0, gap: gap + free / (count - 1) };
  if (key === "SPACE_AROUND" && count > 0) {
    const share = free / count;
    return { start: share / 2, gap: gap + share };
  }
  if (key === "SPACE_EVENLY" && count > 0) {
    const share = free / (count + 1);
    return { start: share, gap: gap + share };
  }
  return { start: distributionStart(key, extent, used), gap };
}

function placeAbsolute(project, children, box, boxes, cache) {
  const pending = [];
  children.forEach((child) => {
    const intrinsic = intrinsicSize(project, child, cache);
    const width = resolveSize(child.width, box.width, intrinsic.width, intrinsic.width);
    const height = resolveSize(child.height, box.height, intrinsic.height, intrinsic.height);
    const align = String(child.align || "TOP_LEFT").toUpperCase();

    if (align.startsWith("OUT_") && child.align_to) {
      pending.push({ child, width, height, align });
      return;
    }
    const [ax, ay] = ALIGN_ANCHORS[align] || ALIGN_ANCHORS.TOP_LEFT;
    boxes.set(child, {
      left: box.x + (box.width - width) * ax + (Number(child.x) || 0),
      top: box.y + (box.height - height) * ay + (Number(child.y) || 0),
      width, height, managed: false, originX: box.x, originY: box.y,
    });
  });

  // Anchored widgets need their reference resolved first; one extra pass is
  // enough unless they chain, and a chain that never resolves falls back to
  // the parent box rather than looping.
  pending.forEach(({ child, width, height, align }) => {
    const target = children.find((c) => c.id === child.align_to);
    const anchor = target ? boxes.get(target) : null;
    const [tx, ty, sx, sy] = OUT_ANCHORS[align] || [0, 0, 0, 0];
    const base = anchor
      ? { x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height }
      : { x: box.x, y: box.y, width: box.width, height: box.height };
    boxes.set(child, {
      left: base.x + base.width * Math.max(0, tx) + (tx < 0 ? -width : 0)
            - width * sx * (tx === 0 ? 1 : 0) + (Number(child.x) || 0),
      top: base.y + base.height * Math.max(0, ty) + (ty < 0 ? -height : 0)
           - height * sy * (ty === 0 ? 1 : 0) + (Number(child.y) || 0),
      width, height, managed: false, originX: box.x, originY: box.y,
    });
  });
}

function placeChildren(project, children, layout, style, box, boxes, cache) {
  const type = String(layout.type || "NONE").toUpperCase();
  if (!children.length) return;
  if (type === "GRID") placeGrid(project, children, layout, style, box, boxes, cache);
  else if (type === "FLEX") placeFlex(project, children, layout, style, box, boxes, cache);
  else placeAbsolute(project, children, box, boxes, cache);
}

function descend(project, nodes, boxes, cache) {
  nodes.forEach((node) => {
    const outer = boxes.get(node);
    if (!outer || !(node.children || []).length) return;
    const style = styleOf(project, node);
    const pad = padding(style);
    const inner = {
      x: outer.left + pad.left,
      y: outer.top + pad.top,
      width: Math.max(0, outer.width - pad.left - pad.right),
      height: Math.max(0, outer.height - pad.top - pad.bottom),
    };
    placeChildren(project, node.children, node.layout || {}, style, inner, boxes, cache);
    descend(project, node.children, boxes, cache);
  });
}

/**
 * Resolve every widget in the project to an absolute box on the canvas.
 *
 * Returns a Map keyed by the widget object, with {left, top, width, height,
 * managed, originX, originY}. `managed` means a parent layout decided the
 * position, so dragging it would write an x/y offset that fights the layout.
 * `originX/originY` is the origin its x/y is relative to.
 */
export function computeLayout(project) {
  const boxes = new Map();
  const cache = new Map();
  // The screen carries its own layout and padding in ESPHome; here it lives in
  // the preserved lvgl block, because nothing in the model represents it.
  const screen = project.extra_lvgl || {};
  const pad = padding(screen);
  const box = {
    x: pad.left,
    y: pad.top,
    width: Math.max(0, project.canvas.width - pad.left - pad.right),
    height: Math.max(0, project.canvas.height - pad.top - pad.bottom),
  };

  placeChildren(project, project.widgets || [], screen.layout || {}, screen, box, boxes, cache);
  descend(project, project.widgets || [], boxes, cache);
  return boxes;
}

/**
 * The origin a *new* child of `container` would place its own x/y against -
 * i.e. the container's content box after padding. Used to convert an
 * absolute canvas point into a relative x/y before appending something to
 * `container.children`, without having to duplicate the padding math that
 * `descend()` already applies to existing children.
 */
export function contentOrigin(project, container) {
  const boxes = computeLayout(project);
  const outer = boxes.get(container);
  if (!outer) return { x: 0, y: 0 };
  const pad = padding(styleOf(project, container));
  return { x: outer.left + pad.left, y: outer.top + pad.top };
}
