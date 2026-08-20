// @ts-check

/** @typedef {[number, number]} Point */
/** @param {number} value @param {number} minimum @param {number} maximum */
const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

/** @param {number} value @param {number} gridSize */
const snapToGrid = (value, gridSize) => (gridSize > 0 ? Math.round(value / gridSize) * gridSize : value);

/**
 * @param {{clientX: number, clientY: number, x: number, y: number}} origin
 * @param {{clientX: number, clientY: number}} pointer
 * @param {number} zoom
 * @param {{width: number, height: number, itemWidth: number, itemHeight: number}} bounds
 * @param {number} [gridSize] Rounds the dragged position to the nearest multiple of this
 *   many px before clamping; 0 (the default) leaves free-pixel positioning untouched.
 */
export function dragPosition(origin, pointer, zoom, bounds, gridSize = 0) {
  const deltaX = (pointer.clientX - origin.clientX) / zoom;
  const deltaY = (pointer.clientY - origin.clientY) / zoom;
  return {
    x: clamp(Math.round(snapToGrid(origin.x + deltaX, gridSize)), 0, bounds.width - bounds.itemWidth),
    y: clamp(Math.round(snapToGrid(origin.y + deltaY, gridSize)), 0, bounds.height - bounds.itemHeight),
  };
}

/**
 * @param {{clientX: number, clientY: number, width: number, height: number}} origin
 * @param {{clientX: number, clientY: number}} pointer
 * @param {number} zoom
 * @param {{minimum?: number, maximum?: number, gridSize?: number}} limits
 */
export function resizeDimensions(origin, pointer, zoom, { minimum = 8, maximum = 4096, gridSize = 0 } = {}) {
  return {
    width: clamp(Math.round(snapToGrid(origin.width + ((pointer.clientX - origin.clientX) / zoom), gridSize)), minimum, maximum),
    height: clamp(Math.round(snapToGrid(origin.height + ((pointer.clientY - origin.clientY) / zoom), gridSize)), minimum, maximum),
  };
}

/** @param {Point[]} points @param {number} dx @param {number} dy @returns {Point[]} */
export function translatePoints(points, dx, dy) {
  return points.map(([x, y]) => /** @type {Point} */ ([x + dx, y + dy]));
}

/** @typedef {{left: number, top: number, width: number, height: number}} Box */
/** @typedef {"left"|"right"|"center"} XEdgeName */
/** @typedef {"top"|"bottom"|"center"} YEdgeName */

/**
 * Finds the closest edge/center alignment between a moving box and a set of
 * reference boxes on each axis independently, within `threshold` px, and
 * returns the delta that would snap the moving box onto it - the canvas
 * equivalent of a word processor's paragraph-alignment guides, computed
 * once per drag tick rather than drawn by hand.
 *
 * `xEdges`/`yEdges` restrict which of the box's own edges are allowed to be
 * the one that moves - a drag can slide any of left/right/center onto a
 * match (the default, all three), but a resize anchored at the top-left
 * only ever moves the right/bottom edges, so aligning "center" there would
 * require a two-sided expansion this function does not attempt.
 * @param {Box} box
 * @param {Box[]} others
 * @param {number} [threshold]
 * @param {{xEdges?: XEdgeName[], yEdges?: YEdgeName[]}} [options]
 */
export function alignmentSnap(box, others, threshold = 4, options = {}) {
  const { xEdges: xEdgeNames = ["left", "right", "center"], yEdges: yEdgeNames = ["top", "bottom", "center"] } = options;

  /** @param {number} value @param {number[]} candidates
   * @returns {{delta: number, guide: number} | null} */
  const closest = (value, candidates) => {
    /** @type {{delta: number, guide: number} | null} */
    let best = null;
    candidates.forEach((candidate) => {
      const delta = candidate - value;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, guide: candidate };
      }
    });
    return best;
  };

  /** @type {number[]} */
  const xCandidates = [];
  /** @type {number[]} */
  const yCandidates = [];
  others.forEach((other) => {
    xCandidates.push(other.left, other.left + other.width, other.left + other.width / 2);
    yCandidates.push(other.top, other.top + other.height, other.top + other.height / 2);
  });

  /** @type {Record<XEdgeName, number>} */
  const xEdgeValues = { left: box.left, right: box.left + box.width, center: box.left + box.width / 2 };
  /** @type {Record<YEdgeName, number>} */
  const yEdgeValues = { top: box.top, bottom: box.top + box.height, center: box.top + box.height / 2 };

  /** @type {{delta: number, guide: number} | null} */
  let bestX = null;
  for (const name of xEdgeNames) {
    const match = closest(xEdgeValues[name], xCandidates);
    if (match && (!bestX || Math.abs(match.delta) < Math.abs(bestX.delta))) bestX = match;
  }
  /** @type {{delta: number, guide: number} | null} */
  let bestY = null;
  for (const name of yEdgeNames) {
    const match = closest(yEdgeValues[name], yCandidates);
    if (match && (!bestY || Math.abs(match.delta) < Math.abs(bestY.delta))) bestY = match;
  }

  return {
    dx: bestX ? bestX.delta : 0,
    dy: bestY ? bestY.delta : 0,
    guideX: bestX ? bestX.guide : null,
    guideY: bestY ? bestY.guide : null,
  };
}

/**
 * The whole-canvas rectangle as one more alignment candidate, so a widget
 * lines up with the display's own edges and center the same way it already
 * does with a sibling - it is just another Box as far as alignmentSnap is
 * concerned.
 * @param {number} width @param {number} height @returns {Box}
 */
export function canvasAlignmentBox(width, height) {
  return { left: 0, top: 0, width, height };
}

/**
 * New left/top for each box so every one lines up on the requested edge or
 * center - "left"/"right"/"top"/"bottom" align to the extreme edge across
 * the whole set (matching what every mainstream design tool does with no
 * explicit anchor selected), "centerX"/"centerY" align to the overall
 * bounding box's center.
 * @param {Box[]} boxes
 * @param {"left"|"right"|"centerX"|"top"|"bottom"|"centerY"} edge
 * @returns {{left: number, top: number}[]}
 */
export function alignBoxes(boxes, edge) {
  if (!boxes.length) return [];
  if (edge === "left" || edge === "right" || edge === "centerX") {
    let target = 0;
    if (edge === "left") target = Math.min(...boxes.map((box) => box.left));
    else if (edge === "right") target = Math.max(...boxes.map((box) => box.left + box.width));
    else {
      const minLeft = Math.min(...boxes.map((box) => box.left));
      const maxRight = Math.max(...boxes.map((box) => box.left + box.width));
      target = (minLeft + maxRight) / 2;
    }
    return boxes.map((box) => ({
      left: edge === "left" ? target : edge === "right" ? target - box.width : target - box.width / 2,
      top: box.top,
    }));
  }
  let target = 0;
  if (edge === "top") target = Math.min(...boxes.map((box) => box.top));
  else if (edge === "bottom") target = Math.max(...boxes.map((box) => box.top + box.height));
  else {
    const minTop = Math.min(...boxes.map((box) => box.top));
    const maxBottom = Math.max(...boxes.map((box) => box.top + box.height));
    target = (minTop + maxBottom) / 2;
  }
  return boxes.map((box) => ({
    left: box.left,
    top: edge === "top" ? target : edge === "bottom" ? target - box.height : target - box.height / 2,
  }));
}

/**
 * New left/top for each box so the gaps between them become equal, with the
 * two extreme boxes (by position) left in place - a no-op below 3 boxes,
 * since two boxes have only a single gap and nothing to make equal.
 * @param {Box[]} boxes
 * @param {"horizontal"|"vertical"} axis
 * @returns {{left: number, top: number}[]}
 */
export function distributeBoxes(boxes, axis) {
  if (boxes.length < 3) return boxes.map((box) => ({ left: box.left, top: box.top }));
  const key = axis === "horizontal" ? "left" : "top";
  const sizeKey = axis === "horizontal" ? "width" : "height";
  const sorted = [...boxes].sort((a, b) => a[key] - b[key]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalSpan = (last[key] + last[sizeKey]) - first[key];
  const totalSize = sorted.reduce((sum, box) => sum + box[sizeKey], 0);
  const gap = (totalSpan - totalSize) / (sorted.length - 1);
  /** @type {Map<Box, number>} */
  const positionByBox = new Map();
  let cursor = first[key];
  sorted.forEach((box) => {
    positionByBox.set(box, cursor);
    cursor += box[sizeKey] + gap;
  });
  return boxes.map((box) => {
    const position = /** @type {number} */ (positionByBox.get(box));
    return axis === "horizontal" ? { left: position, top: box.top } : { left: box.left, top: position };
  });
}

/**
 * The nearest neighbour's gap on each of the four sides, counting only
 * neighbours that actually sit beside/above/below the box (overlapping it
 * on the other axis) rather than merely being closest in a straight line -
 * the "12px" spacing readout a design tool shows even when nothing lines up
 * closely enough to snap.
 * @param {Box} box @param {Box[]} others @param {number} [maxDistance]
 */
export function nearestGaps(box, others, maxDistance = 300) {
  const boxTop = box.top, boxBottom = box.top + box.height;
  const boxLeft = box.left, boxRight = box.left + box.width;

  /** @type {{gap: number, from: number, to: number} | null} */
  let right = null;
  /** @type {{gap: number, from: number, to: number} | null} */
  let left = null;
  /** @type {{gap: number, from: number, to: number} | null} */
  let bottom = null;
  /** @type {{gap: number, from: number, to: number} | null} */
  let top = null;

  others.forEach((other) => {
    const otherTop = other.top, otherBottom = other.top + other.height;
    const otherLeft = other.left, otherRight = other.left + other.width;
    const verticalOverlap = Math.min(boxBottom, otherBottom) - Math.max(boxTop, otherTop) > 0;
    const horizontalOverlap = Math.min(boxRight, otherRight) - Math.max(boxLeft, otherLeft) > 0;

    if (verticalOverlap && otherLeft >= boxRight) {
      const gap = otherLeft - boxRight;
      if (gap <= maxDistance && (!right || gap < right.gap)) right = { gap, from: boxRight, to: otherLeft };
    }
    if (verticalOverlap && otherRight <= boxLeft) {
      const gap = boxLeft - otherRight;
      if (gap <= maxDistance && (!left || gap < left.gap)) left = { gap, from: otherRight, to: boxLeft };
    }
    if (horizontalOverlap && otherTop >= boxBottom) {
      const gap = otherTop - boxBottom;
      if (gap <= maxDistance && (!bottom || gap < bottom.gap)) bottom = { gap, from: boxBottom, to: otherTop };
    }
    if (horizontalOverlap && otherBottom <= boxTop) {
      const gap = boxTop - otherBottom;
      if (gap <= maxDistance && (!top || gap < top.gap)) top = { gap, from: otherBottom, to: boxTop };
    }
  });

  return { left, right, top, bottom };
}
