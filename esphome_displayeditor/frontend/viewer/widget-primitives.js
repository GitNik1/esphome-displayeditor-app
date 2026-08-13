// @ts-check

import { viewerImageSource } from "./assets.js";
import { arcPoint, describeViewerArc, numericWidgetRange, viewerBarGeometry } from "./geometry.js";
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
