// @ts-check

import { viewerFont, viewerImageSource } from "./assets.js";
import {
  colorWithOpacity, effectiveViewerPartStyle, effectiveViewerStyle,
  resolveViewerColor, viewerGradientBackground, viewerOpacity, viewerTextAlign,
} from "./style.js";

/** @param {HTMLElement} node @param {any} project @param {Record<string, any>} style */
export function applyViewerStyleObject(node, project, style) {
  const background = resolveViewerColor(project, style.bg_color);
  const border = resolveViewerColor(project, style.border_color);
  const shadow = resolveViewerColor(project, style.shadow_color);
  const text = resolveViewerColor(project, style.text_color);
  const opacity = viewerOpacity(style.opa);
  const backgroundOpacity = viewerOpacity(style.bg_opa);
  const shadowOpacity = viewerOpacity(style.shadow_opa);
  if (background) node.style.backgroundColor = colorWithOpacity(background, backgroundOpacity) || "";
  const gradient = viewerGradientBackground(project, style);
  if (gradient) node.style.backgroundImage = gradient;
  if (style.bg_image_src) {
    const source = viewerImageSource(project, style.bg_image_src);
    if (source) {
      node.style.backgroundImage = `url("${source}")`;
      node.style.backgroundSize = "cover";
      node.style.backgroundPosition = "center";
    }
  }
  if (border) node.style.borderColor = border;
  if (style.border_width !== undefined) node.style.borderWidth = `${Math.max(0, Number(style.border_width) || 0)}px`;
  if (style.radius !== undefined) node.style.borderRadius = `${Math.max(0, Number(style.radius) || 0)}px`;
  if (text) node.style.color = text;
  const textAlign = viewerTextAlign(style.text_align);
  if (textAlign) node.style.textAlign = /** @type {any} */ (textAlign);
  const font = viewerFont(project, style.text_font);
  if (font?.family) node.style.fontFamily = JSON.stringify(font.family);
  else if (font?.familyCss) node.style.fontFamily = font.familyCss;
  if (font?.size) node.style.fontSize = `${font.size}px`;
  if (font?.weight) node.style.fontWeight = String(font.weight);
  if (font?.italic) node.style.fontStyle = "italic";
  if (style.text_letter_space !== undefined) node.style.letterSpacing = `${Number(style.text_letter_space) || 0}px`;
  if (style.text_line_space !== undefined) {
    const size = font?.size || Number.parseFloat(getComputedStyle(node).fontSize) || 16;
    node.style.lineHeight = `${Math.max(1, size + (Number(style.text_line_space) || 0))}px`;
  }
  const padding = Math.max(0, Number(style.pad_all) || 0);
  node.style.paddingTop = `${Math.max(0, Number(style.pad_top ?? padding) || 0)}px`;
  node.style.paddingRight = `${Math.max(0, Number(style.pad_right ?? padding) || 0)}px`;
  node.style.paddingBottom = `${Math.max(0, Number(style.pad_bottom ?? padding) || 0)}px`;
  node.style.paddingLeft = `${Math.max(0, Number(style.pad_left ?? padding) || 0)}px`;
  if (style.pad_row !== undefined) node.style.rowGap = `${Math.max(0, Number(style.pad_row) || 0)}px`;
  if (style.pad_column !== undefined) node.style.columnGap = `${Math.max(0, Number(style.pad_column) || 0)}px`;
  if (opacity !== null) node.style.opacity = String(opacity);
  if (shadow && Number(style.shadow_width) > 0) {
    const x = Number(style.shadow_offset_x) || 0;
    const y = Number(style.shadow_offset_y) || 0;
    const blur = Math.max(0, Number(style.shadow_width) || 0);
    const spread = Math.max(0, Number(style.shadow_spread) || 0);
    node.style.boxShadow = `${x}px ${y}px ${blur}px ${spread}px ${colorWithOpacity(shadow, shadowOpacity)}`;
  }
}

/** @param {HTMLElement} node @param {any} project @param {any} widget
 * @param {string | string[]} [activeState] */
export function applyViewerStyle(node, project, widget, activeState = "") {
  applyViewerStyleObject(node, project, effectiveViewerStyle(project, widget, activeState));
}

/** @param {HTMLElement} node @param {any} project @param {any} widget
 * @param {string} part @param {string | string[]} [activeState] */
export function applyViewerPartStyle(node, project, widget, part, activeState = "") {
  applyViewerStyleObject(node, project, effectiveViewerPartStyle(project, widget, part, activeState));
}
