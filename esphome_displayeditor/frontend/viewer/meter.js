// @ts-check

import { clamp } from "./style.js";

/** @param {unknown} raw */
export function meterScales(raw) {
  if (Array.isArray(raw)) return raw.filter((item) => item && typeof item === "object");
  return raw && typeof raw === "object" ? [raw] : [];
}

/** @param {any} scale @param {unknown} value */
export function meterValueAngle(scale, value) {
  const minimum = Number(scale.range_from ?? 0);
  const maximum = Number(scale.range_to ?? 100);
  const fraction = maximum === minimum ? 0 : clamp((Number(value) - minimum) / (maximum - minimum), 0, 1);
  return Number(scale.rotation ?? 0) + Number(scale.angle_range ?? 270) * fraction;
}

/** @param {unknown} value @param {number} radius */
export function meterLength(value, radius) {
  const text = String(value ?? "100%").trim();
  if (text.endsWith("%")) return radius * (Number(text.slice(0, -1)) || 0) / 100;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : radius;
}

/** @param {any} scale @param {number} [radius] */
export function meterTickGeometry(scale, radius = 44) {
  const ticks = scale.ticks && typeof scale.ticks === "object" ? scale.ticks : {};
  const count = Math.min(200, Math.max(0, Math.floor(Number(ticks.count ?? 12))));
  if (count < 2) return [];
  const major = ticks.major && typeof ticks.major === "object" ? ticks.major : {};
  const stride = Math.max(1, Math.floor(Number(major.stride ?? 3)));
  const minimum = Number(scale.range_from ?? 0);
  const maximum = Number(scale.range_to ?? 100);
  return Array.from({ length: count }, (_, index) => {
    const fraction = index / (count - 1);
    const isMajor = index % stride === 0;
    const config = isMajor ? major : ticks;
    const outer = radius - Number(config.radial_offset ?? 0);
    const length = meterLength(config.length ?? (isMajor ? "15%" : 10), radius);
    return {
      index, fraction, isMajor,
      angle: Number(scale.rotation ?? 0) + Number(scale.angle_range ?? 270) * fraction,
      value: minimum + (maximum - minimum) * fraction,
      inner: outer - length,
      outer,
      width: Number(config.width ?? (isMajor ? 5 : 2)),
      labelGap: Number(major.label_gap ?? 4),
    };
  });
}

/** @param {any} scale @param {any} config @param {number} [radius] */
export function meterLineGeometry(scale, config, radius = 44) {
  const angle = meterValueAngle(scale, config.value ?? 0);
  const start = meterLength(config.radial_offset ?? 0, radius);
  const end = start + meterLength(config.length ?? "100%", radius);
  return { angle, start, end };
}

/** @param {any} scale @param {number} value */
export function meterTickStyle(scale, value) {
  const minimum = Number(scale.range_from ?? 0);
  const maximum = Number(scale.range_to ?? 100);
  for (const entry of scale.indicators || []) {
    const style = entry?.tick_style;
    if (!style) continue;
    const start = Number(style.start_value ?? minimum);
    const end = Number(style.end_value ?? maximum);
    if (value < Math.min(start, end) || value > Math.max(start, end)) continue;
    const domainStart = style.local ? start : minimum;
    const domainEnd = style.local ? end : maximum;
    const fraction = domainEnd === domainStart ? 0 : clamp((value - domainStart) / (domainEnd - domainStart), 0, 1);
    return { ...style, fraction };
  }
  return null;
}
