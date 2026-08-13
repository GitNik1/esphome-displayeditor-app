// @ts-check

/** @typedef {{id: string, widget_type?: string, children?: Widget[], [key: string]: any}} Widget */
/** @typedef {{widgets?: Widget[], layout?: Record<string, any>, style_tree?: Record<string, any>,
 * extra?: Record<string, any>, [key: string]: any}} Surface */
/** @typedef {{id: string, buttons?: Widget[], header_buttons?: Widget[],
 * body?: Record<string, any>, title?: string, close_button?: boolean,
 * extra?: Record<string, any>, [key: string]: any}} MessageBox */
/** @typedef {{widgets?: Widget[], pages?: Surface[], top_layer?: Surface | null,
 * bottom_layer?: Surface | null, page_wrap?: boolean, msgboxes?: MessageBox[],
 * reserved_ids?: string[], [key: string]: any}} Project */

/** @returns {Project} */
export function freshProject() {
  return {
    format: "esphome-lvgl-designer-project",
    format_version: 3,
    canvas: { width: 480, height: 480 },
    background: {
      path: "",
      export_as_lvgl_image: false,
      image_id: "bg_image",
      opacity_in_editor: 40,
    },
    display_id_placeholder: "my_display",
    default_font: "",
    widgets: [],
    pages: [],
    top_layer: null,
    bottom_layer: null,
    page_wrap: true,
    msgboxes: [],
    styles: [],
    fonts: [],
    images: [],
    colors: [],
    theme: {},
    extra_lvgl: {},
    canvas_source: "default",
    export_sections: ["color", "font", "image", "lvgl"],
    import_source: {},
    glow_strokes: [],
  };
}

/** @param {Project} project @returns {Project} */
export function normalizeProjectSurfaces(project) {
  if (!Array.isArray(project.widgets)) project.widgets = [];
  if (!Array.isArray(project.pages)) project.pages = [];
  if (typeof project.page_wrap !== "boolean") project.page_wrap = true;

  [project.top_layer, project.bottom_layer, ...project.pages]
    .filter((surface) => surface !== null && surface !== undefined)
    .forEach((surface) => {
      if (!Array.isArray(surface.widgets)) surface.widgets = [];
      if (!surface.layout || typeof surface.layout !== "object" || Array.isArray(surface.layout)) {
        surface.layout = {};
      }
      if (!surface.style_tree || typeof surface.style_tree !== "object" || Array.isArray(surface.style_tree)) {
        surface.style_tree = {};
      }
      if (!surface.extra || typeof surface.extra !== "object" || Array.isArray(surface.extra)) {
        surface.extra = {};
      }
    });

  if (!Array.isArray(project.msgboxes)) project.msgboxes = [];
  project.msgboxes.forEach((msgbox) => {
    if (!Array.isArray(msgbox.buttons)) msgbox.buttons = [];
    if (!Array.isArray(msgbox.header_buttons)) msgbox.header_buttons = [];
    if (!msgbox.body || typeof msgbox.body !== "object" || Array.isArray(msgbox.body)) msgbox.body = {};
    if (typeof msgbox.body.text !== "string") msgbox.body.text = "";
    if (!msgbox.body.style_tree || typeof msgbox.body.style_tree !== "object") msgbox.body.style_tree = {};
    if (!msgbox.body.extra || typeof msgbox.body.extra !== "object") msgbox.body.extra = {};
    if (typeof msgbox.title !== "string") msgbox.title = "";
    if (typeof msgbox.close_button !== "boolean") msgbox.close_button = true;
    if (!msgbox.extra || typeof msgbox.extra !== "object" || Array.isArray(msgbox.extra)) msgbox.extra = {};
  });
  return project;
}

/** @param {Project} project @returns {Widget[]} */
export function collectProjectWidgets(project) {
  normalizeProjectSurfaces(project);
  /** @type {Widget[]} */
  const result = [];
  /** @param {Widget[] | undefined} nodes */
  const visit = (nodes) => (nodes || []).forEach((widget) => {
    result.push(widget);
    visit(widget.children || []);
  });
  visit(project.widgets || []);
  (project.pages || []).forEach((page) => visit(page.widgets));
  visit(project.bottom_layer?.widgets);
  visit(project.top_layer?.widgets);
  (project.msgboxes || []).forEach((msgbox) => {
    visit(msgbox.buttons);
    visit(msgbox.header_buttons);
  });
  return result;
}

/** @param {Project} project @returns {Widget[]} */
export function projectWidgetEntries(project) {
  normalizeProjectSurfaces(project);
  /** @type {Widget[]} */
  const result = [];
  /** @param {Widget[] | undefined} nodes */
  const visit = (nodes) => (nodes || []).forEach((widget) => {
    result.push(widget);
    visit(widget.children || []);
  });
  visit(project.widgets || []);
  (project.pages || []).forEach((page) => visit(page.widgets));
  visit(project.top_layer?.widgets);
  visit(project.bottom_layer?.widgets);
  (project.msgboxes || []).forEach((msgbox) => {
    result.push({ id: msgbox.id, widget_type: "msgbox" });
    visit(msgbox.buttons);
    visit(msgbox.header_buttons);
  });
  return result;
}

/** @param {Project} project @param {string} base @returns {string} */
export function uniqueProjectWidgetId(project, base) {
  const ids = new Set([
    ...collectProjectWidgets(project).map((widget) => widget.id),
    ...(project.reserved_ids || []),
  ]);
  let number = 1;
  let candidate = `${base}_${number}`;
  while (ids.has(candidate)) candidate = `${base}_${++number}`;
  return candidate;
}

/** @param {string} id */
export function freshGlowStroke(id) {
  return {
    id,
    points: [],
    name: "",
    color565: 0x07ff,
    width: 5,
    corner_radius: 12,
    mode: "polyline",
    closed: false,
    glow: {
      enabled: true,
      radius: 14,
      intensity: 0.85,
      use_line_color: true,
      color565: 0x07ff,
    },
    flow: {
      enabled: false,
      mode: "arrows",
      reversed: false,
      spacing: 40,
      size: 14,
      width: 0,
      use_line_color: false,
      color565: 0xffff,
      glow_radius: 0,
      glow_intensity: 0.9,
      bidirectional: false,
      bake_frame_count: 6,
      bake_crop: true,
    },
    parent_id: "",
    hidden: false,
    locked: false,
  };
}
