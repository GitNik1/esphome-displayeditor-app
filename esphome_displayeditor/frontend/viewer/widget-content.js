// @ts-check

import { applyViewerPartStyle } from "./dom-style.js";
import { clamp, resolveViewerColor, viewerOpacity } from "./style.js";
import { renderViewerArc, renderViewerBar, renderViewerImage } from "./widget-primitives.js";

/** @param {any} widget */
export function viewerWidgetText(widget) {
  return String(widget.properties?.text || widget.name || widget.id || "");
}

/** @param {any} project @param {any} widget @param {number[]} timers
 * @param {string[]} [activeStates] @returns {HTMLElement | null} */
export function renderViewerWidgetContent(project, widget, timers, activeStates = []) {
  if (widget.widget_type === "label"
      || (widget.widget_type === "button" && Object.hasOwn(widget.properties || {}, "text"))) {
    const text = document.createElement("span");
    text.className = "viewer-widget-text";
    text.textContent = viewerWidgetText(widget);
    return text;
  }
  if (widget.widget_type === "switch") {
    const indicator = document.createElement("span");
    indicator.className = "viewer-switch-indicator";
    const knob = document.createElement("span");
    knob.className = "viewer-switch-knob";
    indicator.append(knob);
    if (widget.properties?.state_checked) indicator.classList.add("checked");
    applyViewerPartStyle(indicator, project, widget, "indicator", activeStates);
    applyViewerPartStyle(knob, project, widget, "knob", activeStates);
    return indicator;
  }
  if (widget.widget_type === "checkbox") {
    const wrapper = document.createElement("span");
    wrapper.className = "viewer-checkbox";
    const indicator = document.createElement("span");
    indicator.className = "viewer-checkbox-indicator";
    if (widget.properties?.state_checked) indicator.classList.add("checked");
    applyViewerPartStyle(indicator, project, widget, "indicator", activeStates);
    const text = document.createElement("span");
    text.className = "viewer-widget-text";
    text.textContent = viewerWidgetText(widget);
    wrapper.append(indicator, text);
    return wrapper;
  }
  if (widget.widget_type === "dropdown" || widget.widget_type === "roller") {
    const options = Array.isArray(widget.properties?.options) ? widget.properties.options : [];
    const select = document.createElement("select");
    select.className = widget.widget_type === "dropdown" ? "viewer-dropdown" : "viewer-roller";
    options.forEach((/** @type {unknown} */ label, /** @type {number} */ index) => {
      select.append(new Option(String(label), String(index)));
    });
    if (widget.widget_type === "roller") select.size = Math.max(1, Number(widget.properties?.visible_row_count) || 3);
    select.value = String(clamp(Number(widget.properties?.selected_index) || 0, 0, Math.max(0, options.length - 1)));
    return select;
  }
  if (widget.widget_type === "textarea") {
    const props = widget.properties || {};
    const element = props.one_line ? document.createElement("input") : document.createElement("textarea");
    element.className = "viewer-textarea";
    if (element instanceof HTMLInputElement) element.type = props.password_mode ? "password" : "text";
    element.value = String(props.text ?? "");
    if (props.placeholder_text) element.placeholder = String(props.placeholder_text);
    if (Number(props.max_length) > 0) element.maxLength = Number(props.max_length);
    return element;
  }
  if (widget.widget_type === "keyboard") {
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
    applyViewerPartStyle(fill, project, widget, "indicator", activeStates);
    applyViewerPartStyle(knob, project, widget, "knob", activeStates);
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
    const bar = document.createElement("span");
    bar.className = "viewer-tabview-bar";
    (widget.children || []).forEach((/** @type {any} */ tab) => {
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
    const dot = document.createElement("span");
    dot.className = "viewer-led";
    dot.style.background = resolveViewerColor(project, widget.properties?.color) || "#ff0000";
    dot.style.opacity = String(Math.max(0.1, viewerOpacity(widget.properties?.brightness) ?? 1));
    return dot;
  }
  if (widget.widget_type === "spinner") {
    const ring = document.createElement("span");
    ring.className = "viewer-spinner";
    const color = resolveViewerColor(project, widget.properties?.arc_color) || "#20c7b7";
    ring.style.borderTopColor = color;
    ring.style.borderRightColor = color;
    const spinTime = String(widget.properties?.spin_time || "2s");
    ring.style.animationDuration = /^[\d.]+$/.test(spinTime) ? `${spinTime}ms` : spinTime;
    return ring;
  }
  if (widget.widget_type === "qrcode") {
    const box = document.createElement("span");
    box.className = "viewer-qrcode";
    box.textContent = viewerWidgetText(widget) || "QR";
    return box;
  }
  if (widget.widget_type === "spinbox") {
    const decimals = clamp(Number(widget.properties?.decimal_places) || 0, 0, 6);
    const element = document.createElement("span");
    element.className = "viewer-spinbox";
    element.textContent = (Number(widget.properties?.value) || 0).toFixed(decimals);
    return element;
  }
  if (widget.widget_type === "bar") return renderViewerBar(project, widget, activeStates);
  if (widget.widget_type === "arc") return renderViewerArc(project, widget, activeStates);
  if (widget.widget_type === "image") return renderViewerImage(project, widget, widget.properties?.src);
  if (widget.widget_type === "animimg") {
    const frames = Array.isArray(widget.properties?.src) ? widget.properties.src : [];
    const holder = document.createElement("span");
    holder.className = "viewer-animimg";
    let index = 0;
    const showFrame = () => {
      holder.replaceChildren(renderViewerImage(project, widget, frames[index]));
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
