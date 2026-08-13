// @ts-check

import { clamp } from "./style.js";

/** @typedef {{properties?: Record<string, any>, width?: number | string,
 * height?: number | string, [key: string]: any}} ViewerWidget */

/** @param {ViewerWidget} widget */
export function numericWidgetRange(widget) {
  const minimum = Number(widget.properties?.min_value) || 0;
  const rawMaximum = Number(widget.properties?.max_value);
  const maximum = Number.isFinite(rawMaximum) && rawMaximum !== minimum ? rawMaximum : 100;
  const value = clamp(Number(widget.properties?.value) || 0, Math.min(minimum, maximum), Math.max(minimum, maximum));
  const percentage = maximum === minimum ? 0 : clamp((value - minimum) / (maximum - minimum), 0, 1);
  return { minimum, maximum, value, percentage };
}

/** @param {ViewerWidget} widget */
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

/** @param {number} angle @param {number} [radius] */
export function arcPoint(angle, radius = 40) {
  const radians = angle * Math.PI / 180;
  return { x: 50 + radius * Math.cos(radians), y: 50 + radius * Math.sin(radians) };
}

/** @param {number} startAngle @param {number} sweepAngle @param {number} [radius] */
export function describeViewerArc(startAngle, sweepAngle, radius = 40) {
  const sweep = Math.max(-359.999, Math.min(359.999, Number(sweepAngle) || 0));
  const start = arcPoint(Number(startAngle) || 0, radius);
  const end = arcPoint((Number(startAngle) || 0) + sweep, radius);
  return [
    `M ${start.x.toFixed(3)} ${start.y.toFixed(3)}`,
    `A ${radius} ${radius} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep >= 0 ? 1 : 0} ${end.x.toFixed(3)} ${end.y.toFixed(3)}`,
  ].join(" ");
}
