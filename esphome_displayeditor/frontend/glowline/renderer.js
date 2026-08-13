// @ts-check

// Rendering of glow lines and their flow markers, on a 2D canvas.
//
// Technique, unchanged from glowline/renderer.py: **multi-pass stroke glow**.
// The same path is stroked repeatedly with decreasing width and a matching
// opacity, rather than blurring a bitmap. It is resolution independent, so the
// on-screen preview and the exported PNG come out of the very same function.
//
// The opacity per pass is chosen so the *accumulated* opacity rises
// quadratically from 0 (outside) to `intensity` (at the core), which gives the
// soft, Gaussian-like falloff:
//
//     A(t) = intensity * (1 - t)^2         t = 1 outside ... 0 at core
//     a_i  = (A_i - A_i-1) / (1 - A_i-1)   opacity of this pass

import {
  angleAtLength,
  boundingBox,
  buildPath,
  measurePath,
  pointAtLength,
  toPath2D,
} from "./geometry.js";
import { cssFrom565 } from "./rgb565.js";

/** Glow passes per quality level. */
export const PASSES = { draft: 6, final: 18, export: 28 };

/** @typedef {"draft" | "final" | "export"} RenderQuality */
/** @typedef {number[]} Point */
/** @typedef {{enabled: boolean, radius: number, intensity: number, use_line_color: boolean, color565: number}} GlowStyle */
/** @typedef {{enabled: boolean, width: number, spacing: number, size: number, glow_radius: number,
 * glow_intensity: number, use_line_color: boolean, color565: number, reversed: boolean, mode: string}} FlowStyle */
/** @typedef {{points: Point[], corner_radius: number, mode: "polyline" | "smooth", closed: boolean,
 * width: number, color565: number, glow: GlowStyle, flow: FlowStyle}} GlowStroke */
/** @typedef {{strokes?: GlowStroke[]}} GlowDocument */
/** @typedef {{points: Point[], lengths: number[], length: number}} PathMeasure */
/** @typedef {{left: number, top: number, right: number, bottom: number}} Rect */
/** @typedef {{key: string, path: any, measure: PathMeasure, path2d: Path2D}} PathCacheEntry */

/** Cache of built paths and their measurements, keyed by the stroke object. */
/** @type {WeakMap<GlowStroke, PathCacheEntry>} */
const pathCache = new WeakMap();

/** @param {GlowStroke} stroke */
function cacheKey(stroke) {
  return JSON.stringify([stroke.points, stroke.corner_radius, stroke.mode, stroke.closed]);
}

/** @param {GlowStroke} stroke @returns {PathCacheEntry} */
export function strokePath(stroke) {
  const key = cacheKey(stroke);
  const cached = pathCache.get(stroke);
  if (cached && cached.key === key) return cached;

  const path = buildPath(stroke.points, stroke.corner_radius, stroke.mode, stroke.closed);
  const entry = { key, path, measure: measurePath(path), path2d: toPath2D(path) };
  pathCache.set(stroke, entry);
  return entry;
}

/** @param {number} intensity @param {RenderQuality} [quality] @returns {Array<[number, number]>} */
export function glowPasses(intensity, quality = "final") {
  const n = PASSES[quality] ?? PASSES.final;
  /** @type {Array<[number, number]>} */
  const out = [];
  let acc = 0;
  for (let i = 1; i <= n; i += 1) {
    const t = (n - i) / n;
    const target = intensity * (1 - t) ** 2;
    if (target <= acc) continue;
    const alpha = acc < 1 ? (target - acc) / (1 - acc) : 1;
    acc = target;
    out.push([t, Math.max(0, Math.min(1, alpha))]);
  }
  return out;
}

/**
 * Marker count and the *actual* spacing for a seamless loop.
 *
 * The requested spacing is adjusted to divide the path length exactly. Only
 * then is phase 1.0 identical to phase 0.0 again and the exported image
 * sequence runs through without a jump.
 */
/** @param {PathMeasure} measure @param {number} spacing @returns {[number, number]} */
export function flowLayout(measure, spacing) {
  const length = measure.length;
  if (length <= 0 || spacing <= 0) return [0, 0];
  const count = Math.max(1, Math.round(length / spacing));
  return [count, length / count];
}

/** @param {GlowStroke} stroke */
function flowWidth(stroke) {
  return stroke.flow.width > 0 ? stroke.flow.width : stroke.width;
}

/** @param {CanvasRenderingContext2D} ctx @param {string} color @param {number} width */
function applyStrokeStyle(ctx, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.1, width);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/** @param {number} px @param {number} py @param {number} dx @param {number} dy @param {number} ca @param {number} sa @returns {Point} */
function rotated(px, py, dx, dy, ca, sa) {
  return [px + dx * ca - dy * sa, py + dx * sa + dy * ca];
}

/**
 * All chevrons of a line collected into *one* path.
 *
 * A shared path rather than a stroke per marker: the glow then costs as many
 * passes as the line itself, not passes x marker count.
 */
/** @param {GlowStroke} stroke @param {PathMeasure} measure @param {number} phase @param {number} direction */
function arrowPath(stroke, measure, phase, direction) {
  const out = new Path2D();
  const [count, step] = flowLayout(measure, stroke.flow.spacing);
  if (count === 0) return out;
  const half = Math.max(1, stroke.flow.size) * 0.5;

  for (let i = 0; i < count; i += 1) {
    const d = (((i + direction * phase) % count) + count) % count * step;
    const [px, py] = pointAtLength(measure, d);
    // Qt reports the angle in the mathematical convention (y upwards); the
    // screen's y points down, hence the sign flip carried over from the
    // original. angleAtLength keeps that same convention.
    const angle = ((-angleAtLength(measure, d) + (direction < 0 ? 180 : 0)) * Math.PI) / 180;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);

    // Chevron: two legs converging towards the front (+x)
    const a = rotated(px, py, -half, -half, ca, sa);
    const b = rotated(px, py, half, 0, ca, sa);
    const c = rotated(px, py, -half, half, ca, sa);
    out.moveTo(a[0], a[1]);
    out.lineTo(b[0], b[1]);
    out.lineTo(c[0], c[1]);
  }
  return out;
}

/** @param {CanvasRenderingContext2D} ctx @param {string} color @param {number} width
 * @param {number} dash @param {number} step @param {number} phase @param {number} direction */
function applyDashStyle(ctx, color, width, dash, step, phase, direction) {
  applyStrokeStyle(ctx, color, width);
  // Qt expresses dash lengths as multiples of the pen width, so the pattern
  // has to be recomputed per glow width or the dashes would grow with the
  // glow. Canvas takes absolute lengths, so the multiplication cancels out -
  // but the offset still has to follow the phase.
  ctx.setLineDash([dash, step - dash]);
  ctx.lineDashOffset = -direction * phase * step;
}

/** @param {CanvasRenderingContext2D} ctx @param {GlowStroke} stroke @param {number} [phase] @param {RenderQuality} [quality] */
export function drawFlow(ctx, stroke, phase = 0, quality = "final") {
  const flow = stroke.flow;
  if (!flow.enabled || (stroke.points || []).length < 2) return;
  const { measure, path2d } = strokePath(stroke);
  const [count, step] = flowLayout(measure, flow.spacing);
  if (count === 0) return;

  const color565 = flow.use_line_color ? stroke.color565 : flow.color565;
  const direction = flow.reversed ? -1 : 1;
  phase = ((phase % 1) + 1) % 1;
  const width = flowWidth(stroke);
  const hasGlow = flow.glow_radius > 0.5 && flow.glow_intensity > 0.001;

  ctx.save();
  if (flow.mode === "dashes") {
    const dash = Math.max(0.05, Math.min(flow.size, step * 0.95));
    if (hasGlow) {
      for (const [t, alpha] of glowPasses(flow.glow_intensity, quality)) {
        applyDashStyle(ctx, cssFrom565(color565, alpha),
                       width + 2 * flow.glow_radius * t, dash, step, phase, direction);
        ctx.stroke(path2d);
      }
    }
    applyDashStyle(ctx, cssFrom565(color565), width, dash, step, phase, direction);
    ctx.stroke(path2d);
    ctx.restore();
    return;
  }

  const markers = arrowPath(stroke, measure, phase, direction);
  ctx.setLineDash([]);
  if (hasGlow) {
    for (const [t, alpha] of glowPasses(flow.glow_intensity, quality)) {
      applyStrokeStyle(ctx, cssFrom565(color565, alpha), width + 2 * flow.glow_radius * t);
      ctx.stroke(markers);
    }
  }
  applyStrokeStyle(ctx, cssFrom565(color565), width);
  ctx.stroke(markers);
  ctx.restore();
}

/**
 * One line with its glow and flow markers, in image coordinates.
 *
 * `withLine` / `withFlow` split the static part from the moving one - which is
 * what the "separate" export builds on: the background once, the markers as an
 * image sequence.
 */
/** @param {CanvasRenderingContext2D} ctx @param {GlowStroke} stroke @param {RenderQuality} [quality]
 * @param {number} [phase] @param {boolean} [withLine] @param {boolean} [withFlow] */
export function drawStroke(ctx, stroke, quality = "final", phase = 0,
                           withLine = true, withFlow = true) {
  if (!(stroke.points || []).length) return;
  if (!withLine) {
    if (withFlow) drawFlow(ctx, stroke, phase, quality);
    return;
  }

  const { path2d } = strokePath(stroke);
  const glow = stroke.glow;

  ctx.save();
  ctx.setLineDash([]);
  if (glow.enabled && glow.radius > 0.5 && glow.intensity > 0.001) {
    const glowColor = glow.use_line_color ? stroke.color565 : glow.color565;
    for (const [t, alpha] of glowPasses(glow.intensity, quality)) {
      applyStrokeStyle(ctx, cssFrom565(glowColor, alpha), stroke.width + 2 * glow.radius * t);
      ctx.stroke(path2d);
    }
  }
  // Core last and fully opaque.
  applyStrokeStyle(ctx, cssFrom565(stroke.color565), stroke.width);
  ctx.stroke(path2d);
  ctx.restore();

  if (withFlow) drawFlow(ctx, stroke, phase, quality);
}

/** @param {CanvasRenderingContext2D} ctx @param {GlowDocument} doc
 * @param {{quality?: RenderQuality, phase?: number, withLines?: boolean, withFlow?: boolean}} [options] */
export function drawDocument(ctx, doc, {
  quality = "final", phase = 0, withLines = true, withFlow = true,
} = {}) {
  for (const stroke of doc.strokes || []) {
    drawStroke(ctx, stroke, quality, phase, withLines, withFlow);
  }
}

/** @param {GlowDocument} doc */
export function hasFlow(doc) {
  return (doc.strokes || []).some((s) => s.flow.enabled && (s.points || []).length >= 2);
}

/**
 * Area the markers of a line occupy over one full period.
 *
 * Determined geometrically rather than by sampling pixels: the markers travel
 * along the *entire* line, so the occupied area is the path plus a margin from
 * marker size, stroke width and glow.
 */
/** @param {GlowStroke} stroke @returns {Rect | null} */
export function flowBounds(stroke) {
  const flow = stroke.flow;
  if (!flow.enabled || (stroke.points || []).length < 2) return null;
  const { measure } = strokePath(stroke);
  const [count] = flowLayout(measure, flow.spacing);
  if (count === 0) return null;

  let margin = flowWidth(stroke) / 2 + Math.max(0, flow.glow_radius) + 1;
  if (flow.mode !== "dashes") {
    // A chevron's corners sit furthest from its centre.
    margin += Math.max(1, flow.size) * 0.5 * Math.SQRT2;
  }
  const box = boundingBox(measure);
  if (!box) return null;
  return {
    left: box.left - margin, top: box.top - margin,
    right: box.right + margin, bottom: box.bottom + margin,
  };
}

/** @param {GlowDocument} doc @param {GlowStroke | null} [only] @returns {Rect | null} */
export function flowBoundsDocument(doc, only = null) {
  /** @type {Rect | null} */
  let rect = null;
  for (const stroke of doc.strokes || []) {
    if (only && stroke !== only) continue;
    const r = flowBounds(stroke);
    if (!r) continue;
    rect = rect ? {
      left: Math.min(rect.left, r.left), top: Math.min(rect.top, r.top),
      right: Math.max(rect.right, r.right), bottom: Math.max(rect.bottom, r.bottom),
    } : r;
  }
  return rect;
}
