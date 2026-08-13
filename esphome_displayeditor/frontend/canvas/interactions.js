// @ts-check

/** @typedef {[number, number]} Point */
/** @param {number} value @param {number} minimum @param {number} maximum */
const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

/**
 * @param {{clientX: number, clientY: number, x: number, y: number}} origin
 * @param {{clientX: number, clientY: number}} pointer
 * @param {number} zoom
 * @param {{width: number, height: number, itemWidth: number, itemHeight: number}} bounds
 */
export function dragPosition(origin, pointer, zoom, bounds) {
  const deltaX = (pointer.clientX - origin.clientX) / zoom;
  const deltaY = (pointer.clientY - origin.clientY) / zoom;
  return {
    x: clamp(Math.round(origin.x + deltaX), 0, bounds.width - bounds.itemWidth),
    y: clamp(Math.round(origin.y + deltaY), 0, bounds.height - bounds.itemHeight),
  };
}

/**
 * @param {{clientX: number, clientY: number, width: number, height: number}} origin
 * @param {{clientX: number, clientY: number}} pointer
 * @param {number} zoom
 * @param {{minimum?: number, maximum?: number}} limits
 */
export function resizeDimensions(origin, pointer, zoom, { minimum = 8, maximum = 4096 } = {}) {
  return {
    width: clamp(Math.round(origin.width + ((pointer.clientX - origin.clientX) / zoom)), minimum, maximum),
    height: clamp(Math.round(origin.height + ((pointer.clientY - origin.clientY) / zoom)), minimum, maximum),
  };
}

/** @param {Point[]} points @param {number} dx @param {number} dy @returns {Point[]} */
export function translatePoints(points, dx, dy) {
  return points.map(([x, y]) => /** @type {Point} */ ([x + dx, y + dy]));
}
