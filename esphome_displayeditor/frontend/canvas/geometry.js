// @ts-check

/** @typedef {[number, number]} Point */
/** @typedef {{left: number, top: number, width: number, height: number}} Box */

/**
 * @param {number} clientX @param {number} clientY
 * @param {{left: number, top: number}} rect @param {number} zoom
 * @returns {Point}
 */
export function pointFromClient(clientX, clientY, rect, zoom) {
  return [(clientX - rect.left) / zoom, (clientY - rect.top) / zoom];
}

/** @param {Point} origin @param {Point} point @param {number} step @returns {Point} */
export function snapAngle(origin, point, step) {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) return point;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [origin[0] + Math.cos(angle) * distance, origin[1] + Math.sin(angle) * distance];
}

/** @param {Box} box */
export function widgetBoxStyle(box) {
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${Math.max(1, box.width)}px`,
    height: `${Math.max(1, box.height)}px`,
  };
}
