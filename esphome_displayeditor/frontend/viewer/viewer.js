import { computeLayout } from "../layout.js";
import { drawDocument, hasFlow } from "../glowline/renderer.js";

const SUPPORTED_WIDGETS = new Set([
  "obj", "container", "label", "button", "switch", "slider", "image", "animimg",
]);

const clamp = (value, minimum, maximum) => (
  Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum)
);

export function cloneViewerProject(project) {
  return JSON.parse(JSON.stringify(project || {}));
}

function mergeStyle(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target;
  Object.entries(source).forEach(([key, value]) => {
    if (key !== "states") target[key] = value;
  });
  return target;
}

export function effectiveViewerStyle(project, widget, activeState = "") {
  const result = {};
  const theme = project.theme?.[widget.widget_type];
  mergeStyle(result, theme);

  if (widget.style_mode === "named") {
    (widget.style_refs || []).forEach((reference) => {
      const entry = (project.styles || []).find((style) => style.id === reference);
      mergeStyle(result, entry?.style_tree);
    });
  } else {
    mergeStyle(result, widget.style_tree);
  }

  if (activeState) {
    mergeStyle(result, theme?.states?.[activeState]);
    if (widget.style_mode === "named") {
      (widget.style_refs || []).forEach((reference) => {
        const entry = (project.styles || []).find((style) => style.id === reference);
        mergeStyle(result, entry?.style_tree?.states?.[activeState]);
      });
    } else {
      mergeStyle(result, widget.style_tree?.states?.[activeState]);
    }
  }
  return result;
}

export function resolveViewerColor(project, value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  const libraryEntry = (project.colors || []).find((entry) => entry.id === raw);
  const candidate = String(libraryEntry?.hex || raw).trim()
    .replace(/^#/, "")
    .replace(/^0x/i, "");
  if (/^[0-9a-f]{6}$/i.test(candidate)) return `#${candidate.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(candidate)) return `#${candidate.toUpperCase()}`;
  return null;
}

function viewerOpacity(value) {
  if (value === null || value === undefined || value === "") return null;
  const upper = String(value).trim().toUpperCase();
  if (upper === "COVER") return 1;
  if (upper === "TRANSP") return 0;
  const number = Number.parseFloat(upper.replace("%", ""));
  if (!Number.isFinite(number)) return null;
  return clamp(number > 1 ? number / 100 : number, 0, 1);
}

function imageSource(project, id) {
  const entry = (project.images || []).find((image) => image.id === id);
  const source = String(entry?.file_path || "");
  return /^https?:\/\//i.test(source) ? source : null;
}

function allWidgetItems(project) {
  const boxes = computeLayout(project);
  const result = [];
  const visit = (widgets, ancestorHidden = false) => {
    (widgets || []).forEach((widget) => {
      const hidden = ancestorHidden || Boolean(widget.hidden);
      const box = boxes.get(widget) || {
        left: Number(widget.x) || 0,
        top: Number(widget.y) || 0,
        width: Number(widget.width) || 100,
        height: Number(widget.height) || 40,
      };
      result.push({ widget, box, hidden });
      visit(widget.children, hidden);
    });
  };
  visit(project.widgets);
  return result;
}

function applyStyle(node, project, widget, activeState = "") {
  const style = effectiveViewerStyle(project, widget, activeState);
  const background = resolveViewerColor(project, style.bg_color);
  const gradient = resolveViewerColor(project, style.bg_grad_color);
  const border = resolveViewerColor(project, style.border_color);
  const shadow = resolveViewerColor(project, style.shadow_color);
  const text = resolveViewerColor(project, style.text_color);
  const opacity = viewerOpacity(style.opa);
  const backgroundOpacity = viewerOpacity(style.bg_opa);

  if (background) node.style.backgroundColor = background;
  if (background && gradient && ["HOR", "VER"].includes(String(style.bg_grad_dir).toUpperCase())) {
    const direction = String(style.bg_grad_dir).toUpperCase() === "HOR" ? "to right" : "to bottom";
    node.style.backgroundImage = `linear-gradient(${direction}, ${background}, ${gradient})`;
  }
  if (backgroundOpacity !== null) node.style.setProperty("--viewer-bg-opacity", String(backgroundOpacity));
  if (border) node.style.borderColor = border;
  if (style.border_width !== undefined) node.style.borderWidth = `${Math.max(0, Number(style.border_width) || 0)}px`;
  if (style.radius !== undefined) node.style.borderRadius = `${Math.max(0, Number(style.radius) || 0)}px`;
  if (text) node.style.color = text;
  if (style.text_align) node.style.textAlign = String(style.text_align).toLowerCase();
  if (opacity !== null) node.style.opacity = String(opacity);
  if (shadow && Number(style.shadow_width) > 0) {
    const x = Number(style.shadow_offset_x) || 0;
    const y = Number(style.shadow_offset_y) || 0;
    const blur = Math.max(0, Number(style.shadow_width) || 0);
    const spread = Math.max(0, Number(style.shadow_spread) || 0);
    node.style.boxShadow = `${x}px ${y}px ${blur}px ${spread}px ${shadow}`;
  }
}

function textContent(widget) {
  return String(widget.properties?.text || widget.name || widget.id || "");
}

function renderImage(project, widget, sourceId) {
  const source = imageSource(project, sourceId);
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

function renderWidgetContent(project, widget, timers) {
  if (["label", "button"].includes(widget.widget_type)) {
    const text = document.createElement("span");
    text.className = "viewer-widget-text";
    text.textContent = textContent(widget);
    return text;
  }
  if (widget.widget_type === "switch") {
    const indicator = document.createElement("span");
    indicator.className = "viewer-switch-indicator";
    const knob = document.createElement("span");
    knob.className = "viewer-switch-knob";
    indicator.append(knob);
    if (widget.properties?.state_checked) indicator.classList.add("checked");
    return indicator;
  }
  if (widget.widget_type === "slider") {
    const minimum = Number(widget.properties?.min_value) || 0;
    const maximum = Number(widget.properties?.max_value) || 100;
    const value = clamp(Number(widget.properties?.value) || 0, minimum, maximum);
    const percentage = maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 100;
    const track = document.createElement("span");
    track.className = "viewer-slider-track";
    const fill = document.createElement("span");
    fill.className = "viewer-slider-fill";
    fill.style.width = `${percentage}%`;
    const knob = document.createElement("span");
    knob.className = "viewer-slider-knob";
    knob.style.left = `${percentage}%`;
    track.append(fill, knob);
    return track;
  }
  if (widget.widget_type === "image") {
    return renderImage(project, widget, widget.properties?.src);
  }
  if (widget.widget_type === "animimg") {
    const frames = Array.isArray(widget.properties?.src) ? widget.properties.src : [];
    const holder = document.createElement("span");
    holder.className = "viewer-animimg";
    let index = 0;
    const showFrame = () => {
      holder.replaceChildren(renderImage(project, widget, frames[index]));
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

function renderWidget(project, item, timers, warnings) {
  const { widget, box, hidden } = item;
  const node = document.createElement("div");
  node.className = "viewer-widget";
  node.dataset.type = widget.widget_type;
  node.dataset.widgetId = widget.id || "";
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${Math.max(1, box.width)}px`;
  node.style.height = `${Math.max(1, box.height)}px`;
  node.hidden = hidden;
  applyStyle(node, project, widget);

  if (!SUPPORTED_WIDGETS.has(widget.widget_type)) {
    warnings.add(`Widgettyp „${widget.widget_type}“ wird noch nicht dargestellt.`);
    node.classList.add("unsupported");
    node.textContent = `${widget.widget_type}: ${widget.id || "ohne ID"}`;
    return node;
  }

  const content = renderWidgetContent(project, widget, timers);
  if (content) node.append(content);
  return node;
}

function prepareCanvas(canvas, width, height) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

export class ViewerController {
  constructor({ dialog, stage, frame, display, title, status, zoomLabel, rotationControl }) {
    this.dialog = dialog;
    this.stage = stage;
    this.frame = frame;
    this.display = display;
    this.title = title;
    this.status = status;
    this.zoomLabel = zoomLabel;
    this.rotationControl = rotationControl;
    this.sourceProject = null;
    this.project = null;
    this.name = "";
    this.backgroundPreview = null;
    this.zoom = 1;
    this.rotation = 0;
    this.fitMode = true;
    this.timers = [];
    this.animationFrame = null;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.dialog.open && this.fitMode) this.fit();
    });
    this.resizeObserver.observe(this.stage);
  }

  open(project, { name = "Lokales Projekt", backgroundPreview = null } = {}) {
    this.stopAnimations();
    this.sourceProject = cloneViewerProject(project);
    this.project = cloneViewerProject(this.sourceProject);
    this.name = name;
    this.backgroundPreview = backgroundPreview;
    this.zoom = 1;
    this.rotation = 0;
    this.rotationControl.value = "0";
    this.fitMode = true;
    this.title.textContent = name;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    window.requestAnimationFrame(() => this.fit());
  }

  close() {
    this.stopAnimations();
    this.sourceProject = null;
    this.project = null;
    this.display.replaceChildren();
    if (this.dialog.open) this.dialog.close();
  }

  reset() {
    if (!this.sourceProject) return;
    this.stopAnimations();
    this.project = cloneViewerProject(this.sourceProject);
    this.render();
  }

  stopAnimations() {
    this.timers.forEach((timer) => window.clearInterval(timer));
    this.timers = [];
    if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  setZoom(value) {
    this.zoom = clamp(value, 0.25, 4);
    this.fitMode = false;
    this.applyTransform();
  }

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

    allWidgetItems(this.project).forEach((item) => {
      this.display.append(renderWidget(this.project, item, this.timers, warnings));
    });
    this.display.append(glowFront);

    const visibleStrokes = (this.project.glow_strokes || []).filter((stroke) => !stroke.hidden);
    const backDocument = { strokes: visibleStrokes.filter((stroke) => !stroke.parent_id) };
    const frontDocument = { strokes: visibleStrokes.filter((stroke) => stroke.parent_id) };
    const backContext = prepareCanvas(glowBack, width, height);
    const frontContext = prepareCanvas(glowFront, width, height);
    const startedAt = performance.now();
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

    this.status.textContent = warnings.size
      ? `Browser-Simulation · ${warnings.size} Hinweis(e)`
      : "Browser-Simulation · nicht pixelgenau";
    this.status.title = [...warnings].join("\n");
    this.applyTransform();
  }
}
