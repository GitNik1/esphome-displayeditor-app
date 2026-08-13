// @ts-check

import { drawDocument, hasFlow } from "../glowline/renderer.js";
import { t } from "../i18n/runtime.js";
import { applyRuntimeBinding } from "./runtime.js";
import { allWidgetItems, surfaceProject, viewerSurfaces, viewerWidgetRoots } from "./surfaces.js";
import { findViewerWidget as findWidget, navigateViewerPage as navigatePage } from "./action-model.js";
import { applyViewerAction } from "./action-interpreter.js";
import { VIEWER_FONT_LOADED_EVENT } from "./assets.js";
import {
  applyViewerStyle as applyStyle,
  applyViewerStyleObject as applyStyleObject,
} from "./dom-style.js";
import {
  renderViewerImage as renderImage, updateViewerArc as updateArcVisual,
} from "./widget-primitives.js";
import { viewerWidgetText as textContent } from "./widget-content.js";
import {
  prepareViewerCanvas as prepareCanvas, renderViewerMessageBox as renderMsgboxOverlay,
  renderViewerWidget as renderWidget,
} from "./dom-renderer.js";
import {
  clamp,
} from "./style.js";
export { applyRuntimeBinding, entityMatchesRuntimeTarget, formatRuntimeValue, runtimeBindingHealth, runtimeBoolean } from "./runtime.js";
export { applyViewerAction } from "./action-interpreter.js";
export { describeViewerArc, viewerBarGeometry } from "./geometry.js";
export { effectiveViewerPartStyle, effectiveViewerStyle, resolveViewerColor, viewerGradientBackground, viewerTextAlign } from "./style.js";

/** @typedef {Record<string, any>} ViewerProject */
/** @typedef {{kind: string, message: string, time: Date}} ViewerLogEntry */
/** @typedef {{activePageId: string, activeTiles: Record<string, string>, activeTabs: Record<string, string>}} ViewerRuntime */
/** @typedef {Record<string, any>} ViewerWidget */
/** @typedef {Record<string, any>} ViewerEvent */
/** @typedef {{dialog: HTMLDialogElement, stage: HTMLElement, frame: HTMLElement,
 * display: HTMLElement, title: HTMLElement, status: HTMLElement, zoomLabel: HTMLElement,
 * rotationControl: HTMLInputElement, eventLog: HTMLElement, eventCount: HTMLElement,
 * pageControls: HTMLElement, pageSelect: HTMLSelectElement, pagePrevious: HTMLButtonElement,
 * pageNext: HTMLButtonElement}} ViewerElements */

/** @param {any} project @returns {any} */
export function cloneViewerProject(project) {
  return JSON.parse(JSON.stringify(project || {}));
}

// A local path (e.g. from an imported config's own `image:`/`font:` entry)
// isn't something the browser can fetch directly - it lives on the HA host,
// not the web. Route it through the read-only asset endpoint instead, the
// same one the main editor canvas already uses for this exact case (see
// assetUrl()/displayableImageSource() in app.js) - without this, an
// imported image is selectable in the editor (only the id/path string is
// needed for that) but the Viewer, which needs the actual bytes, could only
// ever show its "image not found" fallback for anything but an http(s) URL.
// Mirrors ensureFontLoaded() in app.js's Designer canvas. Without this, a
// project font backed by a real file (uploaded, imported, or a pinned
// web/MDI revision) never got its actual glyphs in the Viewer - only Google
// Fonts (by family name) and LVGL builtin bitmap fonts (by name, only ever
// approximated) got a font-family at all; anything else silently fell back
// to the browser's default font. Invisible for ordinary prose text, but it
// turns an inserted MDI icon glyph into a tofu box instead of the icon.
// One attempt per font id - "failed" is sticky, matching the canvas's
// fontLoadState cache.
//: The `tile` a `tileview` currently shows - explicit `lvgl.tileview.select`
//: choice if any, else the tile at row 0/col 0 (ESPHome's own default start
//: position), else simply its first tile.
//: The `tab` a `tabview` currently shows - explicit choice (tab-bar click or
//: `lvgl.tabview.select`) if any, else its first tab (ESPHome's own default).
export class ViewerController {
  /** @param {ViewerElements} elements */
  constructor({
    dialog, stage, frame, display, title, status, zoomLabel, rotationControl,
    eventLog, eventCount, pageControls, pageSelect, pagePrevious, pageNext,
  }) {
    this.dialog = dialog;
    this.stage = stage;
    this.frame = frame;
    this.display = display;
    this.title = title;
    this.status = status;
    this.zoomLabel = zoomLabel;
    this.rotationControl = rotationControl;
    this.eventLog = eventLog;
    this.eventCount = eventCount;
    this.pageControls = pageControls;
    this.pageSelect = pageSelect;
    this.pagePrevious = pagePrevious;
    this.pageNext = pageNext;
    /** @type {ViewerProject | null} */ this.sourceProject = null;
    /** @type {ViewerProject | null} */ this.project = null;
    this.name = "";
    /** @type {string | null} */ this.backgroundPreview = null;
    this.zoom = 1;
    this.rotation = 0;
    this.fitMode = true;
    /** @type {number[]} */ this.timers = [];
    /** @type {ViewerLogEntry[]} */ this.logEntries = [];
    /** @type {Set<string>} */ this.renderWarnings = new Set();
    /** @type {ViewerRuntime} */ this.runtime = { activePageId: "", activeTiles: {}, activeTabs: {} };
    /** @type {any[]} */ this.runtimeBindings = [];
    /** @type {Map<string, any>} */ this.runtimeStates = new Map();
    /** @type {Map<string, any>} */ this.runtimeDevices = new Map();
    /** @type {number | null} */ this.runtimeTimer = null;
    /** @type {number | null} */ this.animationFrame = null;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.dialog.open && this.fitMode) this.fit();
    });
    this.resizeObserver.observe(this.stage);
    // ensureViewerFontLoaded() above resolves asynchronously (it has no
    // access to this controller instance from inside a plain render
    // helper) - it announces a finished font load on the document instead,
    // and re-renders here so the widget that triggered it picks up the
    // real glyphs without the user having to reopen the dialog.
    document.addEventListener(VIEWER_FONT_LOADED_EVENT, () => {
      if (this.dialog.open) this.render();
    });
  }

  /** @param {ViewerProject} project @param {{name?: string, backgroundPreview?: string | null,
   * runtimeBindings?: any[], runtimeSnapshot?: any}} [options] */
  open(project, {
    name = "Lokales Projekt", backgroundPreview = null, runtimeBindings = [], runtimeSnapshot = null,
  } = {}) {
    this.stopAnimations();
    this.stopRuntimeTimer();
    this.sourceProject = cloneViewerProject(project);
    const activeProject = /** @type {ViewerProject} */ (cloneViewerProject(this.sourceProject));
    this.project = activeProject;
    // Real ESPHome msgboxes always start hidden - there is no "visible at
    // boot" config option, only lvgl.widget.show/.hide at runtime.
    (activeProject.msgboxes || []).forEach((/** @type {any} */ msgbox) => { msgbox.hidden = true; });
    this.name = name;
    this.backgroundPreview = backgroundPreview;
    this.zoom = 1;
    this.rotation = 0;
    this.rotationControl.value = "0";
    this.fitMode = true;
    this.logEntries = [];
    this.runtime = { activePageId: activeProject.pages?.[0]?.id || "", activeTiles: {}, activeTabs: {} };
    this.runtimeBindings = cloneViewerProject(runtimeBindings);
    this.runtimeStates = new Map();
    this.runtimeDevices = new Map();
    if (runtimeSnapshot) this.setRuntimeSnapshot(runtimeSnapshot, { render: false });
    this.applyAllRuntimeBindings({ render: false });
    this.renderEventLog();
    this.title.textContent = name;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    if (this.runtimeBindings.length) {
      this.runtimeTimer = window.setInterval(() => this.applyAllRuntimeBindings(), 5000);
    }
    window.requestAnimationFrame(() => this.fit());
  }

  close() {
    this.stopAnimations();
    this.stopRuntimeTimer();
    this.sourceProject = null;
    this.project = null;
    this.runtimeBindings = [];
    this.runtimeStates.clear();
    this.runtimeDevices.clear();
    this.display.replaceChildren();
    if (this.dialog.open) this.dialog.close();
  }

  reset() {
    if (!this.sourceProject) return;
    this.stopAnimations();
    const activeProject = /** @type {ViewerProject} */ (cloneViewerProject(this.sourceProject));
    this.project = activeProject;
    (activeProject.msgboxes || []).forEach((/** @type {any} */ msgbox) => { msgbox.hidden = true; });
    this.runtime = { activePageId: activeProject.pages?.[0]?.id || "", activeTiles: {}, activeTabs: {} };
    this.logEntries = [];
    this.applyAllRuntimeBindings({ render: false });
    this.renderEventLog();
    this.render();
  }

  stopRuntimeTimer() {
    if (this.runtimeTimer !== null) window.clearInterval(this.runtimeTimer);
    this.runtimeTimer = null;
  }

  /** @param {any} snapshot @param {{render?: boolean}} [options] */
  setRuntimeSnapshot(snapshot, { render = true } = {}) {
    this.runtimeStates = new Map();
    this.runtimeDevices = new Map();
    (snapshot?.devices || []).forEach((/** @type {any} */ device) => {
      this.runtimeDevices.set(device.id, {
        id: device.id, name: device.name, status: device.status, last_seen: device.last_seen,
      });
      (device.states || []).forEach((/** @type {any} */ item) => {
        if (item.entity_id) this.runtimeStates.set(`${device.id}:${item.entity_id}`, item);
      });
    });
    this.applyAllRuntimeBindings({ render });
  }

  /** @param {ViewerEvent} event */
  applyRuntimeEvent(event) {
    if (!this.project || !event || event.type === "heartbeat") return;
    if (event.type === "snapshot") {
      this.setRuntimeSnapshot(event);
      return;
    }
    if (event.type === "device_snapshot" && event.device?.id) {
      const device = event.device;
      this.runtimeDevices.set(device.id, {
        id: device.id, name: device.name, status: device.status, last_seen: device.last_seen,
      });
      [...this.runtimeStates.keys()].filter((key) => key.startsWith(`${device.id}:`))
        .forEach((key) => this.runtimeStates.delete(key));
      (device.states || []).forEach((/** @type {any} */ item) => {
        if (item.entity_id) this.runtimeStates.set(`${device.id}:${item.entity_id}`, item);
      });
    } else if (event.type === "state" && event.device_id && event.state?.entity_id) {
      this.runtimeStates.set(`${event.device_id}:${event.state.entity_id}`, event.state);
      const device = this.runtimeDevices.get(event.device_id);
      if (device) device.last_seen = event.state.received_at;
    } else if (event.type === "connection" && event.device_id) {
      const device = this.runtimeDevices.get(event.device_id) || { id: event.device_id, name: event.device_id };
      device.status = event.status;
      this.runtimeDevices.set(event.device_id, device);
    } else if (event.type === "device_removed" && event.device_id) {
      this.runtimeDevices.delete(event.device_id);
    } else {
      return;
    }
    this.applyAllRuntimeBindings();
  }

  /** @param {{render?: boolean}} [options] */
  applyAllRuntimeBindings({ render = true } = {}) {
    if (!this.project || !this.sourceProject) return false;
    let changed = false;
    this.runtimeBindings.forEach((binding) => {
      const device = this.runtimeDevices.get(binding.device_id);
      const runtimeState = this.runtimeStates.get(`${binding.device_id}:${binding.entity_id}`);
      changed = applyRuntimeBinding(this.project, this.sourceProject, binding, runtimeState, {
        deviceAvailable: device?.status === "ready",
      }) || changed;
    });
    if (changed && render) this.render();
    else this.refreshStatus();
    return changed;
  }

  /** @param {string} kind @param {string} message */
  recordEvent(kind, message) {
    this.logEntries.push({ kind, message, time: new Date() });
    if (this.logEntries.length > 100) this.logEntries.shift();
    this.renderEventLog();
    this.refreshStatus();
  }

  refreshStatus() {
    if (!this.status) return;
    const runtimeWarnings = this.logEntries.filter((entry) => entry.kind === "warning");
    const warningCount = this.renderWarnings.size + runtimeWarnings.length;
    const liveDevices = new Set(this.runtimeBindings.map((binding) => binding.device_id));
    const online = [...liveDevices].filter((id) => this.runtimeDevices.get(id)?.status === "ready").length;
    const live = this.runtimeBindings.length
      ? t("viewer.status.liveSuffix", { online, total: liveDevices.size, bindings: this.runtimeBindings.length })
      : "";
    this.status.textContent = warningCount
      ? `${t("viewer.status.prefix")}${live} · ${t("viewer.status.warnings", { count: warningCount })}`
      : `${t("viewer.status.prefix")}${live} · ${t("viewer.status.pixelNote")}`;
    this.status.title = [
      ...this.renderWarnings,
      ...runtimeWarnings.map((entry) => entry.message),
    ].join("\n");
  }

  renderEventLog() {
    if (!this.eventLog || !this.eventCount) return;
    this.eventCount.textContent = String(this.logEntries.length);
    this.eventLog.replaceChildren();
    if (!this.logEntries.length) {
      const empty = document.createElement("p");
      empty.className = "viewer-event-empty";
      empty.textContent = t("viewer.noEvents");
      this.eventLog.append(empty);
      return;
    }
    [...this.logEntries].reverse().forEach((entry) => {
      const row = document.createElement("div");
      row.className = `viewer-event viewer-event-${entry.kind}`;
      const time = document.createElement("time");
      time.dateTime = entry.time.toISOString();
      time.textContent = entry.time.toLocaleTimeString("de-DE", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const text = document.createElement("span");
      text.textContent = entry.message;
      row.append(time, text);
      this.eventLog.append(row);
    });
  }

  /** @param {ViewerWidget} widget @param {string} eventName @param {Record<string, any>} [context] */
  runEvent(widget, eventName, context = {}) {
    const raw = widget.events?.[eventName];
    if (raw === undefined || raw === null) return false;
    const actions = Array.isArray(raw) ? raw : [raw];
    this.recordEvent("trigger", `${widget.id || widget.widget_type}: ${eventName}`);
    let changed = false;
    actions.forEach((action) => {
      const result = applyViewerAction(this.project, action, this.runtime, context);
      changed ||= result.changed;
      this.recordEvent(result.handled && !result.warning ? "action" : "warning", result.message);
    });
    return changed;
  }

  /** @param {ViewerWidget | null} [transientWidget] @param {string[]} [transientStates] */
  refreshActionVisuals(transientWidget = null, transientStates = []) {
    this.display.querySelectorAll("[data-widget-id]").forEach((rawNode) => {
      const node = /** @type {HTMLElement} */ (rawNode);
      const widget = findWidget(this.project, node.dataset.widgetId);
      if (!widget) return;
      node.hidden = Boolean(widget.hidden);
      const states = widget.properties?.state_checked ? ["checked"] : [];
      if (document.activeElement === node) states.push("focused");
      if (widget === transientWidget) states.push(...transientStates);
      applyStyle(node, this.project, widget, states);
      if (["label", "button", "checkbox"].includes(widget.widget_type)) {
        const text = node.querySelector(".viewer-widget-text");
        if (text) text.textContent = textContent(widget);
      } else if (widget.widget_type === "image") {
        const content = node.querySelector(".viewer-image, .viewer-image-fallback");
        const replacement = renderImage(this.project, widget, widget.properties?.src);
        if (content) content.replaceWith(replacement);
        else node.prepend(replacement);
      } else if (widget.widget_type === "textarea") {
        const el = node.querySelector(".viewer-textarea");
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (document.activeElement !== el) el.value = String(widget.properties?.text ?? "");
        }
      }
    });
  }

  /** @param {HTMLElement} node @param {ViewerWidget} widget */
  bindWidget(node, widget) {
    if (widget.properties?.disabled || widget.extra?.disabled) return;
    if (widget.widget_type === "button") {
      node.classList.add("viewer-interactive");
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      if (widget.properties?.checkable) {
        node.setAttribute("aria-pressed", String(Boolean(widget.properties?.state_checked)));
      }
      const baseStyle = node.getAttribute("style") || "";
      /** @param {...string} extraStates */
      const setTransientStates = (...extraStates) => {
        node.setAttribute("style", baseStyle);
        const states = widget.properties?.state_checked ? ["checked"] : [];
        if (document.activeElement === node) states.push("focused");
        states.push(...extraStates);
        applyStyle(node, this.project, widget, states);
      };
      const actionContext = () => ({ x: Boolean(widget.properties?.state_checked) });
      const releaseVisual = () => {
        setTransientStates();
        node.classList.remove("viewer-pressed");
      };
      const activate = ({ render = true } = {}) => {
        let changed = false;
        widget.properties ||= {};
        if (widget.properties.checkable) {
          widget.properties.state_checked = !Boolean(widget.properties.state_checked);
          this.recordEvent("state", `${widget.id || "button"}: ${widget.properties.state_checked ? t("viewer.event.stateActive") : t("viewer.event.stateInactive")}`);
          changed = this.runEvent(widget, "on_value", actionContext()) || changed;
        }
        changed = this.runEvent(widget, "on_change", actionContext()) || changed;
        changed = this.runEvent(widget, "on_click", actionContext()) || changed;
        if (render && (changed || widget.properties.checkable)) this.render();
        return changed;
      };
      const press = ({ renderChanges = true } = {}) => {
        setTransientStates("pressed");
        node.classList.add("viewer-pressed");
        const changed = this.runEvent(widget, "on_press", actionContext());
        if (changed && renderChanges) {
          this.refreshActionVisuals(widget, ["pressed"]);
        }
        return changed;
      };
      const release = () => {
        releaseVisual();
        const changed = this.runEvent(widget, "on_release", actionContext());
        if (changed) this.refreshActionVisuals(widget);
      };
      node.addEventListener("focus", () => setTransientStates());
      node.addEventListener("blur", () => {
        node.setAttribute("style", baseStyle);
        node.classList.remove("viewer-pressed");
      });
      node.addEventListener("pointerdown", () => press());
      node.addEventListener("pointerup", release);
      node.addEventListener("pointercancel", releaseVisual);
      node.addEventListener("pointerleave", releaseVisual);
      node.addEventListener("click", () => activate());
      node.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key) && !event.repeat) {
          event.preventDefault();
          press({ renderChanges: false });
        }
      });
      node.addEventListener("keyup", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          releaseVisual();
          this.runEvent(widget, "on_release", actionContext());
          activate();
        }
      });
      return;
    }

    if (widget.widget_type === "switch") {
      node.classList.add("viewer-interactive");
      node.tabIndex = 0;
      node.setAttribute("role", "switch");
      node.setAttribute("aria-checked", String(Boolean(widget.properties?.state_checked)));
      const baseStyle = node.getAttribute("style") || "";
      node.addEventListener("focus", () => {
        node.setAttribute("style", baseStyle);
        applyStyle(node, this.project, widget, [
          ...(widget.properties?.state_checked ? ["checked"] : []), "focused",
        ]);
      });
      node.addEventListener("blur", () => node.setAttribute("style", baseStyle));
      const activate = () => {
        widget.properties ||= {};
        widget.properties.state_checked = !Boolean(widget.properties.state_checked);
        this.recordEvent("state", `${widget.id || "switch"}: ${widget.properties.state_checked ? t("viewer.event.stateOn") : t("viewer.event.stateOff")}`);
        const context = { x: Boolean(widget.properties.state_checked) };
        const valueChanged = this.runEvent(widget, "on_value", context);
        const clickChanged = this.runEvent(widget, "on_click", context);
        this.render();
        return valueChanged || clickChanged;
      };
      node.addEventListener("click", activate);
      node.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          activate();
        }
      });
      return;
    }

    if (widget.widget_type === "checkbox") {
      node.classList.add("viewer-interactive");
      node.tabIndex = 0;
      node.setAttribute("role", "checkbox");
      node.setAttribute("aria-checked", String(Boolean(widget.properties?.state_checked)));
      const baseStyle = node.getAttribute("style") || "";
      node.addEventListener("focus", () => {
        node.setAttribute("style", baseStyle);
        applyStyle(node, this.project, widget, [
          ...(widget.properties?.state_checked ? ["checked"] : []), "focused",
        ]);
      });
      node.addEventListener("blur", () => node.setAttribute("style", baseStyle));
      const activate = () => {
        widget.properties ||= {};
        widget.properties.state_checked = !Boolean(widget.properties.state_checked);
        this.recordEvent("state", `${widget.id || "checkbox"}: ${widget.properties.state_checked ? t("viewer.event.stateOn") : t("viewer.event.stateOff")}`);
        const context = { x: Boolean(widget.properties.state_checked) };
        const valueChanged = this.runEvent(widget, "on_value", context);
        const clickChanged = this.runEvent(widget, "on_click", context);
        this.render();
        return valueChanged || clickChanged;
      };
      node.addEventListener("click", activate);
      node.addEventListener("keydown", (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          activate();
        }
      });
      return;
    }

    if (widget.widget_type === "tabview") {
      node.classList.add("viewer-interactive");
      node.querySelectorAll(".viewer-tab-button").forEach((rawButton) => {
        const button = /** @type {HTMLElement} */ (rawButton);
        button.addEventListener("click", () => {
          const tabId = button.dataset.tabId;
          if (!tabId || this.runtime.activeTabs?.[widget.id] === tabId) return;
          this.runtime.activeTabs ||= {};
          this.runtime.activeTabs[widget.id] = tabId;
          this.recordEvent("state", `${widget.id || "tabview"}: ${tabId}`);
          const context = { tab: tabId };
          this.runEvent(widget, "on_value", context);
          this.runEvent(widget, "on_change", context);
          this.render();
        });
      });
      return;
    }

    if (widget.widget_type === "dropdown" || widget.widget_type === "roller") {
      node.classList.add("viewer-interactive");
      const select = /** @type {HTMLSelectElement | null} */ (node.querySelector(`select.viewer-${widget.widget_type}`));
      if (!select) return;
      select.addEventListener("change", () => {
        widget.properties ||= {};
        widget.properties.selected_index = Number(select.value);
        this.recordEvent("state", `${widget.id || widget.widget_type}: ${select.value}`);
        const context = { x: Number(select.value) };
        const valueChanged = this.runEvent(widget, "on_value", context);
        const changeChanged = this.runEvent(widget, "on_change", context);
        if (valueChanged || changeChanged) this.render();
      });
      return;
    }

    if (widget.widget_type === "textarea") {
      node.classList.add("viewer-interactive");
      const el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (node.querySelector(".viewer-textarea"));
      if (!el) return;
      el.addEventListener("input", () => {
        widget.properties ||= {};
        widget.properties.text = el.value;
        this.runEvent(widget, "on_value", { text: el.value });
      });
      if (Boolean(widget.properties?.one_line)) {
        el.addEventListener("keydown", (event) => {
          if (/** @type {KeyboardEvent} */ (event).key === "Enter") {
            event.preventDefault();
            this.runEvent(widget, "on_ready", { text: el.value });
          }
        });
      }
      return;
    }

    if (widget.widget_type === "slider") {
      node.classList.add("viewer-interactive");
      const input = /** @type {HTMLInputElement | null} */ (node.querySelector(".viewer-slider-input"));
      const fill = /** @type {HTMLElement | null} */ (node.querySelector(".viewer-slider-fill"));
      const knob = /** @type {HTMLElement | null} */ (node.querySelector(".viewer-slider-knob"));
      if (!input) return;
      input.addEventListener("input", () => {
        const minimum = Number(input.min);
        const maximum = Number(input.max);
        const value = Number(input.value);
        const percentage = maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 100;
        widget.properties ||= {};
        widget.properties.value = value;
        if (fill) fill.style.width = `${percentage}%`;
        if (knob) knob.style.left = `${percentage}%`;
      });
      input.addEventListener("change", () => {
        this.recordEvent("state", `${widget.id || "slider"}: ${input.value}`);
        const changed = this.runEvent(widget, "on_value", { x: Number(input.value) });
        if (changed) this.render();
      });
      return;
    }

    if (widget.widget_type === "arc" && widget.properties?.adjustable) {
      node.classList.add("viewer-interactive");
      const input = /** @type {HTMLInputElement | null} */ (node.querySelector(".viewer-arc-input"));
      const control = /** @type {HTMLElement | null} */ (node.querySelector(".viewer-arc-control"));
      if (!input || !control) return;
      input.addEventListener("input", () => {
        widget.properties ||= {};
        widget.properties.value = Number(input.value);
        updateArcVisual(control, this.project, widget);
      });
      input.addEventListener("change", () => {
        this.recordEvent("state", `${widget.id || "arc"}: ${input.value}`);
        const context = { x: Number(input.value) };
        const valueChanged = this.runEvent(widget, "on_value", context);
        const changeChanged = this.runEvent(widget, "on_change", context);
        if (valueChanged || changeChanged) this.render();
      });
    }
  }

  /** @param {string} id @param {{record?: boolean}} [options] */
  setActivePage(id, { record = true } = {}) {
    const page = (this.project?.pages || []).find((/** @type {any} */ entry) => entry.id === id);
    if (!page || page.id === this.runtime.activePageId) return false;
    this.runtime.activePageId = page.id;
    if (record) this.recordEvent("state", `Seite: ${page.id}`);
    this.render();
    return true;
  }

  /** @param {number} direction */
  changePage(direction) {
    if (!this.project) return false;
    const page = navigatePage(this.project, this.runtime, direction);
    if (!page || page.id === this.runtime.activePageId) return false;
    this.runtime.activePageId = page.id;
    this.recordEvent("state", `Seite: ${page.id}`);
    this.render();
    return true;
  }

  updatePageControls() {
    if (!this.pageControls || !this.pageSelect) return;
    const pages = this.project?.pages || [];
    this.pageControls.hidden = pages.length === 0;
    this.pageSelect.replaceChildren();
    pages.forEach((/** @type {any} */ page) => {
      const option = new Option(`${page.id}${page.skip ? t("surface.pageSkippedSuffix") : ""}`, page.id);
      this.pageSelect.append(option);
    });
    if (pages.length) this.pageSelect.value = this.runtime.activePageId || pages[0].id;
    if (this.pagePrevious) this.pagePrevious.disabled = pages.length < 2;
    if (this.pageNext) this.pageNext.disabled = pages.length < 2;
  }

  stopAnimations() {
    this.timers.forEach((timer) => window.clearInterval(timer));
    this.timers = [];
    if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  /** @param {number} value */
  setZoom(value) {
    this.zoom = clamp(value, 0.25, 4);
    this.fitMode = false;
    this.applyTransform();
  }

  /** @param {unknown} value */
  setRotation(value) {
    this.rotation = ((Number(value) % 360) + 360) % 360;
    this.rotationControl.value = String(this.rotation);
    if (this.fitMode) this.fit();
    else this.applyTransform();
  }

  fit() {
    if (!this.project || !this.stage.clientWidth || !this.stage.clientHeight) return;
    const width = Number(this.project.canvas?.width) || 480;
    const height = Number(this.project.canvas?.height) || 480;
    const rotated = this.rotation % 180 === 0
      ? { width, height }
      : { width: height, height: width };
    const styles = getComputedStyle(this.stage);
    const availableWidth = this.stage.clientWidth
      - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    const availableHeight = this.stage.clientHeight
      - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
    this.zoom = clamp(Math.min(availableWidth / rotated.width, availableHeight / rotated.height), 0.25, 4);
    this.fitMode = true;
    this.applyTransform();
  }

  applyTransform() {
    if (!this.project) return;
    const width = Number(this.project.canvas?.width) || 480;
    const height = Number(this.project.canvas?.height) || 480;
    const rotatedWidth = this.rotation % 180 === 0 ? width : height;
    const rotatedHeight = this.rotation % 180 === 0 ? height : width;
    this.frame.style.width = `${rotatedWidth * this.zoom}px`;
    this.frame.style.height = `${rotatedHeight * this.zoom}px`;
    this.display.style.transform = `rotate(${this.rotation}deg) scale(${this.zoom})`;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)} %`;
  }

  render() {
    if (!this.project) return;
    this.stopAnimations();
    const warnings = new Set();
    const width = Number(this.project.canvas?.width) || 480;
    const height = Number(this.project.canvas?.height) || 480;
    this.display.style.width = `${width}px`;
    this.display.style.height = `${height}px`;
    this.display.replaceChildren();

    const background = document.createElement("div");
    background.className = "viewer-background";
    const configuredBackground = String(this.project.background?.path || "");
    const source = /^https?:\/\//i.test(configuredBackground)
      ? configuredBackground
      : this.backgroundPreview;
    if (source) {
      background.style.backgroundImage = `url(${JSON.stringify(String(source))})`;
      background.style.opacity = String(clamp(
        Number(this.project.background?.opacity_in_editor ?? 40) / 100, 0, 1,
      ));
    }

    const glowBack = document.createElement("canvas");
    glowBack.className = "viewer-glow viewer-glow-back";
    const glowFront = document.createElement("canvas");
    glowFront.className = "viewer-glow viewer-glow-front";
    this.display.append(background, glowBack);

    viewerSurfaces(this.project, this.runtime.activePageId).forEach(({ kind, surface }) => {
      const layer = document.createElement("div");
      layer.className = `viewer-surface viewer-surface-${kind}`;
      layer.dataset.surfaceId = surface.id || kind;
      applyStyleObject(layer, this.project, surface.style_tree || {});
      // Layout padding is already consumed by computeLayout. Keeping it on
      // the absolutely-positioned surface would offset children a second time.
      layer.style.padding = "0";
      layer.style.rowGap = "0";
      layer.style.columnGap = "0";
      const scopedProject = surfaceProject(this.project, surface);
      allWidgetItems(scopedProject, this.runtime.activeTiles, this.runtime.activeTabs).forEach((item) => {
        layer.append(renderWidget(scopedProject, item, this.timers, warnings, this));
      });
      this.display.append(layer);
    });
    this.display.append(glowFront);

    (this.project.msgboxes || []).forEach((/** @type {any} */ msgbox) => {
      this.display.append(renderMsgboxOverlay(this.project, msgbox, this.timers, warnings, this));
    });

    const visibleStrokes = (this.project.glow_strokes || []).filter((/** @type {any} */ stroke) => !stroke.hidden);
    const backDocument = { strokes: visibleStrokes.filter((/** @type {any} */ stroke) => !stroke.parent_id) };
    const frontDocument = { strokes: visibleStrokes.filter((/** @type {any} */ stroke) => stroke.parent_id) };
    const backContext = prepareCanvas(glowBack, width, height);
    const frontContext = prepareCanvas(glowFront, width, height);
    const startedAt = performance.now();
    /** @param {number} now */
    const draw = (now) => {
      const phase = ((now - startedAt) / 1000) % 1;
      backContext.clearRect(0, 0, width, height);
      frontContext.clearRect(0, 0, width, height);
      drawDocument(backContext, backDocument, { phase });
      drawDocument(frontContext, frontDocument, { phase });
      if (hasFlow(backDocument) || hasFlow(frontDocument)) {
        this.animationFrame = window.requestAnimationFrame(draw);
      }
    };
    draw(startedAt);

    this.renderWarnings = warnings;
    this.updatePageControls();
    this.refreshStatus();
    this.applyTransform();
  }
}
