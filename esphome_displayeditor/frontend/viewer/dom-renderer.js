// @ts-check

import { t } from "../i18n/runtime.js";
import { applyViewerStyle } from "./dom-style.js";
import { activeTabFor } from "./surfaces.js";
import { renderViewerWidgetContent } from "./widget-content.js";

const SUPPORTED_WIDGETS = new Set([
  "obj", "container", "label", "button", "switch", "slider", "bar", "arc", "image", "animimg",
  "checkbox", "dropdown", "roller", "textarea", "keyboard", "tileview", "tabview",
  "led", "spinner", "qrcode", "spinbox",
]);

/** @param {any} project @param {any} item @param {number[]} timers
 * @param {Set<string>} warnings @param {any} controller */
export function renderViewerWidget(project, item, timers, warnings, controller) {
  const { widget, box, hidden, parent } = item;
  const node = document.createElement("div");
  node.className = "viewer-widget";
  node.dataset.type = widget.widget_type;
  node.dataset.widgetId = widget.id || "";
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${Math.max(1, box.width)}px`;
  node.style.height = `${Math.max(1, box.height)}px`;
  node.hidden = hidden;
  if (parent?.widget_type === "button" && ["image", "label"].includes(widget.widget_type)) {
    node.classList.add("viewer-button-content");
    node.style.pointerEvents = "none";
  }
  /** @type {string[]} */
  const activeStates = [];
  if (["switch", "button"].includes(widget.widget_type) && widget.properties?.state_checked) activeStates.push("checked");
  if (widget.properties?.disabled || widget.extra?.disabled) activeStates.push("disabled");
  applyViewerStyle(node, project, widget, activeStates);
  if (!SUPPORTED_WIDGETS.has(widget.widget_type)) {
    warnings.add(t("viewer.event.unsupportedWidgetType", { type: widget.widget_type }));
    node.classList.add("unsupported");
    node.textContent = `${widget.widget_type}: ${widget.id || t("viewer.event.noId")}`;
    return node;
  }
  const content = renderViewerWidgetContent(project, widget, timers, activeStates);
  if (content) node.append(content);
  if (widget.widget_type === "tabview") {
    const active = activeTabFor(widget, controller.runtime?.activeTabs);
    node.querySelectorAll(".viewer-tab-button").forEach((button) => {
      button.classList.toggle("active", Boolean(active) && /** @type {HTMLElement} */ (button).dataset.tabId === active.id);
    });
  }
  if (activeStates.includes("disabled")) {
    node.classList.add("viewer-disabled");
    node.setAttribute("aria-disabled", "true");
  }
  controller.bindWidget(node, widget);
  return node;
}

/** @param {any} project @param {any} button @param {number[]} timers
 * @param {Set<string>} warnings @param {any} controller */
function renderMessageButton(project, button, timers, warnings, controller) {
  const box = { left: 0, top: 0, width: Number(button.width) || 90, height: Number(button.height) || 36 };
  const node = renderViewerWidget(project, { widget: button, box, hidden: false, parent: null }, timers, warnings, controller);
  node.style.position = "static";
  node.style.width = "auto";
  node.style.height = "auto";
  return node;
}

/** @param {any} project @param {any} msgbox @param {number[]} timers
 * @param {Set<string>} warnings @param {any} controller */
export function renderViewerMessageBox(project, msgbox, timers, warnings, controller) {
  const dialog = document.createElement("div");
  dialog.className = "viewer-msgbox";
  dialog.dataset.widgetId = msgbox.id || "";
  dialog.hidden = msgbox.hidden !== false;
  const header = document.createElement("div");
  header.className = "viewer-msgbox-header";
  const title = document.createElement("span");
  title.className = "viewer-msgbox-title";
  title.textContent = String(msgbox.title || "");
  header.append(title);
  (msgbox.header_buttons || []).forEach((/** @type {any} */ button) => {
    header.append(renderMessageButton(project, button, timers, warnings, controller));
  });
  if (msgbox.close_button !== false) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "viewer-msgbox-close";
    close.textContent = "✕";
    close.addEventListener("click", () => {
      msgbox.hidden = true;
      controller.recordEvent("state", `${msgbox.id || "msgbox"}: ${t("viewer.event.stateInactive")}`);
      controller.render();
    });
    header.append(close);
  }
  dialog.append(header);
  if (msgbox.body?.text) {
    const body = document.createElement("div");
    body.className = "viewer-msgbox-body";
    body.textContent = String(msgbox.body.text);
    dialog.append(body);
  }
  if ((msgbox.buttons || []).length) {
    const footer = document.createElement("div");
    footer.className = "viewer-msgbox-footer";
    msgbox.buttons.forEach((/** @type {any} */ button) => {
      footer.append(renderMessageButton(project, button, timers, warnings, controller));
    });
    dialog.append(footer);
  }
  return dialog;
}

/** @param {HTMLCanvasElement} canvas @param {number} width @param {number} height */
export function prepareViewerCanvas(canvas, width, height) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("viewer_canvas_context_unavailable");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}
