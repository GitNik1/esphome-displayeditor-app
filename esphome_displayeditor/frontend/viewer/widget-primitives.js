// @ts-check

import { viewerImageSource } from "./assets.js";
import { arcPoint, describeViewerArc, numericWidgetRange, viewerBarGeometry } from "./geometry.js";
import { meterLineGeometry, meterScales, meterTickGeometry, meterTickStyle, meterValueAngle } from "./meter.js";
import { applyViewerPartStyle } from "./dom-style.js";
import { clamp, effectiveViewerPartStyle, effectiveViewerStyle, resolveViewerColor, viewerOpacity } from "./style.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** @param {any} project @param {any} widget @param {unknown} sourceId */
export function renderViewerImage(project, widget, sourceId) {
  const source = viewerImageSource(project, sourceId);
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

/** @param {any} project @param {any} widget @param {string[]} activeStates */
export function renderViewerBar(project, widget, activeStates) {
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
  applyViewerPartStyle(fill, project, widget, "indicator", activeStates);
  track.append(fill);
  control.append(track);
  return control;
}

/** @param {unknown} value */
function arcOpacity(value) {
  const opacity = viewerOpacity(value);
  return opacity === null ? 1 : opacity;
}

/** @param {HTMLElement} control @param {any} project @param {any} widget
 * @param {string[]} [activeStates] */
export function updateViewerArc(control, project, widget, activeStates = []) {
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
  const mainStyle = /** @type {Record<string, any>} */ (effectiveViewerStyle(project, widget, activeStates));
  const indicatorStyle = /** @type {Record<string, any>} */ (effectiveViewerPartStyle(project, widget, "indicator", activeStates));
  const knobStyle = /** @type {Record<string, any>} */ (effectiveViewerPartStyle(project, widget, "knob", activeStates));
  const nominalSize = Math.max(1, Math.min(Number(widget.width) || 120, Number(widget.height) || 120));
  const mainWidth = clamp((Number(mainStyle.arc_width) || 10) * 100 / nominalSize, 1, 30);
  const indicatorWidth = clamp((Number(indicatorStyle.arc_width) || Number(mainStyle.arc_width) || 10) * 100 / nominalSize, 1, 30);
  const background = /** @type {SVGPathElement} */ (control.querySelector(".viewer-arc-background"));
  const indicator = /** @type {SVGPathElement} */ (control.querySelector(".viewer-arc-indicator"));
  const knob = /** @type {SVGCircleElement} */ (control.querySelector(".viewer-arc-knob"));
  background.setAttribute("d", describeViewerArc(start, sweep));
  background.setAttribute("stroke", resolveViewerColor(project, mainStyle.arc_color) || "#657386");
  background.setAttribute("stroke-width", String(mainWidth));
  background.setAttribute("stroke-linecap", mainStyle.arc_rounded === false ? "butt" : "round");
  background.setAttribute("opacity", String(arcOpacity(mainStyle.arc_opa)));
  indicator.setAttribute("d", describeViewerArc(indicatorStart, indicatorSweep));
  indicator.setAttribute("stroke", resolveViewerColor(project, indicatorStyle.arc_color)
    || resolveViewerColor(project, indicatorStyle.bg_color) || "#20c7b7");
  indicator.setAttribute("stroke-width", String(indicatorWidth));
  indicator.setAttribute("stroke-linecap", indicatorStyle.arc_rounded === false ? "butt" : "round");
  indicator.setAttribute("opacity", String(arcOpacity(indicatorStyle.arc_opa)));
  const current = arcPoint(start + sweep * percentage);
  knob.setAttribute("cx", current.x.toFixed(3));
  knob.setAttribute("cy", current.y.toFixed(3));
  knob.setAttribute("r", String(Math.max(3, indicatorWidth * 0.75)));
  knob.setAttribute("fill", resolveViewerColor(project, knobStyle.bg_color) || "#ffffff");
  knob.toggleAttribute("hidden", !widget.properties?.adjustable);
}

/** @param {any} project @param {any} widget @param {string[]} activeStates */
export function renderViewerArc(project, widget, activeStates) {
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
  updateViewerArc(control, project, widget, activeStates);
  return control;
}

/** @param {string} first @param {string} second @param {number} fraction */
function interpolateMeterColor(first, second, fraction) {
  /** @param {string} value */
  const parse = (value) => /^#[0-9a-f]{6}$/i.test(value)
    ? [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) : null;
  const a = parse(first);
  const b = parse(second);
  if (!a || !b) return first || second;
  return `#${a.map((channel, index) => Math.round(channel + (b[index] - channel) * fraction)
    .toString(16).padStart(2, "0")).join("")}`;
}

/** @param {SVGElement} parent @param {string} name */
function meterSvgElement(parent, name) {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  parent.append(element);
  return element;
}

/** @param {any} project @param {SVGElement} group @param {any} scale */
function renderMeterTicks(project, group, scale) {
  const ticks = scale.ticks || {};
  meterTickGeometry(scale).forEach((tick) => {
    const start = arcPoint(tick.angle, tick.inner);
    const end = arcPoint(tick.angle, tick.outer);
    const style = meterTickStyle(scale, tick.value);
    const baseColor = tick.isMajor ? ticks.major?.color : ticks.color;
    const first = resolveViewerColor(project, style?.color_start) || resolveViewerColor(project, baseColor) || "#808080";
    const second = resolveViewerColor(project, style?.color_end) || first;
    const line = meterSvgElement(group, "line");
    line.setAttribute("x1", start.x.toFixed(3));
    line.setAttribute("y1", start.y.toFixed(3));
    line.setAttribute("x2", end.x.toFixed(3));
    line.setAttribute("y2", end.y.toFixed(3));
    line.setAttribute("stroke", interpolateMeterColor(first, second, style?.fraction ?? 0));
    line.setAttribute("stroke-width", String(style?.width ?? tick.width));
    if (tick.isMajor && ticks.major) {
      const position = arcPoint(tick.angle, Math.max(4, tick.inner - tick.labelGap));
      const label = meterSvgElement(group, "text");
      label.setAttribute("x", position.x.toFixed(3));
      label.setAttribute("y", position.y.toFixed(3));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "middle");
      label.setAttribute("font-size", "5");
      label.textContent = Number.isInteger(tick.value) ? String(tick.value) : tick.value.toFixed(1);
    }
  });
}

/** @param {any} project @param {SVGElement} group @param {any} scale */
function renderMeterIndicators(project, group, scale) {
  for (const entry of scale.indicators || []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.arc) {
      const config = entry.arc;
      const start = meterValueAngle(scale, config.start_value ?? scale.range_from ?? 0);
      const end = meterValueAngle(scale, config.end_value ?? scale.range_to ?? 100);
      const radius = 40 + Number(config.padding ?? config.r_mod ?? 0);
      const path = meterSvgElement(group, "path");
      path.setAttribute("d", describeViewerArc(start, end - start, radius));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", resolveViewerColor(project, config.color) || "#000000");
      path.setAttribute("stroke-width", String(config.width ?? 4));
      path.setAttribute("stroke-linecap", config.rounded ? "round" : "butt");
      path.setAttribute("opacity", String(arcOpacity(config.opa)));
    } else if (entry.line) {
      const config = entry.line;
      const geometry = meterLineGeometry(scale, config);
      const start = arcPoint(geometry.angle, geometry.start);
      const end = arcPoint(geometry.angle, geometry.end);
      const line = meterSvgElement(group, "line");
      line.setAttribute("x1", start.x.toFixed(3));
      line.setAttribute("y1", start.y.toFixed(3));
      line.setAttribute("x2", end.x.toFixed(3));
      line.setAttribute("y2", end.y.toFixed(3));
      line.setAttribute("stroke", resolveViewerColor(project, config.color) || "#000000");
      line.setAttribute("stroke-width", String(config.width ?? 4));
      line.setAttribute("stroke-linecap", config.rounded ? "round" : "butt");
      line.setAttribute("opacity", String(arcOpacity(config.opa)));
      if (config.dash_width) line.setAttribute("stroke-dasharray", `${config.dash_width} ${config.dash_gap ?? config.dash_width}`);
    } else if (entry.image) {
      const config = entry.image;
      const source = viewerImageSource(project, config.src);
      if (!source) continue;
      const image = meterSvgElement(group, "image");
      const pivotX = Number(config.pivot_x ?? 0);
      const pivotY = Number(config.pivot_y ?? 10);
      image.setAttribute("href", source);
      image.setAttribute("x", String(50 - pivotX));
      image.setAttribute("y", String(50 - pivotY));
      image.setAttribute("width", "40");
      image.setAttribute("height", "20");
      image.setAttribute("preserveAspectRatio", "xMinYMid meet");
      image.setAttribute("transform", `rotate(${meterValueAngle(scale, config.value ?? 0)} 50 50)`);
      image.setAttribute("opacity", String(arcOpacity(config.opa)));
    }
  }
}

/** @param {any} project @param {any} widget @param {string[]} activeStates */
export function renderViewerMeter(project, widget, activeStates) {
  const control = document.createElement("span");
  control.className = "viewer-meter-control";
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.classList.add("viewer-meter-svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  meterScales(widget.properties?.scales).forEach((scale) => {
    const group = meterSvgElement(svg, "g");
    if (scale.draw_ticks_on_top === false) renderMeterTicks(project, group, scale);
    renderMeterIndicators(project, group, scale);
    if (scale.draw_ticks_on_top !== false) renderMeterTicks(project, group, scale);
  });
  const pivot = meterSvgElement(svg, "circle");
  pivot.setAttribute("cx", "50");
  pivot.setAttribute("cy", "50");
  pivot.setAttribute("r", "2.5");
  const indicatorStyle = /** @type {Record<string, any>} */ (
    effectiveViewerPartStyle(project, widget, "indicator", activeStates)
  );
  pivot.setAttribute("fill", resolveViewerColor(project, indicatorStyle.bg_color) || "#20252b");
  pivot.setAttribute("opacity", String(arcOpacity(indicatorStyle.bg_opa)));
  control.append(svg);
  return control;
}
