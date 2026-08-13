// @ts-check

// Control points to a drawable path.
//
// Two modes, ported from glowline/geometry.py:
//  * polyline - straight segments with a real circular arc of the requested
//    radius at every interior corner (cubic Bezier approximation)
//  * smooth   - Catmull-Rom spline through all points, as cubic Beziers
//
// Qt hands its QPainterPath an arc-length API for free (length,
// pointAtPercent, angleAtPercent) which the flow markers depend on. Path2D has
// nothing of the sort, so a path here is kept as a *segment list*: it can be
// turned into a Path2D for stroking, and flattened into a polyline with
// cumulative lengths for every positional query.

const EPS = 1e-9;

// Target length of one flattened piece of a curve, in path units. Small enough
// that the arc length is accurate to well under a pixel, large enough that a
// full-screen drawing stays cheap to measure.
const FLATTEN_STEP = 0.4;

/** @typedef {number[]} Point */
/** @typedef {{type: "M", to: Point} | {type: "L", to: Point} | {type: "C", c1: Point, c2: Point, to: Point}} PathSegment */
/** @typedef {{segments: PathSegment[], closed: boolean}} MeasuredPath */
/** @typedef {{points: Point[], lengths: number[], length: number}} PathMeasure */
/** @typedef {[Point, Point, Point, Point]} CornerFillet */

/** @param {Point} a @param {Point} b @returns {Point} */
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

/** @param {Point} v @returns {[Point, number]} */
function unit(v) {
  const length = Math.hypot(v[0], v[1]);
  if (length < EPS) return [[0, 0], 0];
  return [[v[0] / length, v[1] / length], length];
}

/** @param {Point[]} points @returns {Point[]} */
function dedup(points) {
  /** @type {Point[]} */
  const out = [];
  for (const p of points) {
    const q = [Number(p[0]), Number(p[1])];
    if (!out.length || Math.hypot(q[0] - out[out.length - 1][0],
                                  q[1] - out[out.length - 1][1]) > 1e-6) {
      out.push(q);
    }
  }
  return out;
}

/**
 * Fillet at corner `p` between neighbours `a` and `b`.
 * Returns [t1, c1, c2, t2], or null for a degenerate corner.
 */
/**
 * @param {Point} a
 * @param {Point} p
 * @param {Point} b
 * @param {number} radius
 * @returns {CornerFillet | null}
 */
function fillet(a, p, b, radius) {
  const [u1, la] = unit(sub(a, p));
  const [u2, lb] = unit(sub(b, p));
  if (la < EPS || lb < EPS) return null;

  const dot = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const theta = Math.acos(dot);
  if (theta < 1e-3 || theta > Math.PI - 1e-3) return null;

  const half = theta / 2;
  let d = radius / Math.tan(half);
  // Never cut back more than half an edge, or neighbouring fillets overlap.
  const dMax = Math.min(la, lb) * 0.5;
  if (d > dMax) {
    d = dMax;
    radius = d * Math.tan(half);
  }
  if (d < EPS || radius < EPS) return null;

  const t1 = [p[0] + u1[0] * d, p[1] + u1[1] * d];
  const t2 = [p[0] + u2[0] * d, p[1] + u2[1] * d];
  // Cubic approximation of a circular arc: h = 4/3 * tan(sweep/4) * r
  const sweep = Math.PI - theta;
  const h = (4 / 3) * Math.tan(sweep / 4) * radius;
  return [
    t1,
    [t1[0] - u1[0] * h, t1[1] - u1[1] * h],
    [t2[0] - u2[0] * h, t2[1] - u2[1] * h],
    t2,
  ];
}

/** @param {Point[]} pts @param {number} radius @param {boolean} closed @returns {MeasuredPath} */
function roundedPolyline(pts, radius, closed) {
  /** @type {PathSegment[]} */
  const segments = [];
  const n = pts.length;

  if (radius <= 0.01 || n < 3) {
    segments.push({ type: "M", to: pts[0] });
    for (const p of pts.slice(1)) segments.push({ type: "L", to: p });
    return { segments, closed };
  }

  const indices = closed
    ? [...Array(n).keys()]
    : [...Array(Math.max(0, n - 2)).keys()].map((i) => i + 1);
  /** @type {Array<[number, CornerFillet | null]>} */
  const fillets = indices.map((i) => [
    i,
    fillet(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n], radius),
  ]);

  if (!closed) {
    segments.push({ type: "M", to: pts[0] });
    for (const [i, f] of fillets) {
      if (f === null) {
        segments.push({ type: "L", to: pts[i] });
      } else {
        segments.push({ type: "L", to: f[0] });
        segments.push({ type: "C", c1: f[1], c2: f[2], to: f[3] });
      }
    }
    segments.push({ type: "L", to: pts[n - 1] });
    return { segments, closed: false };
  }

  const active = fillets.filter((entry) => entry[1] !== null);
  if (!active.length) {
    segments.push({ type: "M", to: pts[0] });
    for (const p of pts.slice(1)) segments.push({ type: "L", to: p });
    return { segments, closed: true };
  }

  // Closed: start behind the first fillet so the ring joins seamlessly.
  const [startIndex, nullableStartFillet] = active[0];
  if (nullableStartFillet === null) return { segments, closed: true };
  const startFillet = nullableStartFillet;
  segments.push({ type: "M", to: startFillet[3] });
  const order = [
    ...Array.from({ length: n - startIndex - 1 }, (_, k) => startIndex + 1 + k),
    ...Array.from({ length: startIndex + 1 }, (_, k) => k),
  ];
  const lookup = new Map(fillets);
  for (const i of order) {
    const f = lookup.get(i);
    if (f === undefined || f === null) {
      segments.push({ type: "L", to: pts[i] });
    } else {
      segments.push({ type: "L", to: f[0] });
      segments.push({ type: "C", c1: f[1], c2: f[2], to: f[3] });
    }
  }
  return { segments, closed: true };
}

/** @param {Point[]} pts @param {boolean} closed @returns {MeasuredPath} */
function catmullRom(pts, closed) {
  /** @type {PathSegment[]} */
  const segments = [{ type: "M", to: pts[0] }];
  const n = pts.length;
  if (n === 2) {
    segments.push({ type: "L", to: pts[1] });
    return { segments, closed: false };
  }
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i += 1) {
    const p0 = closed ? pts[(i - 1 + n) % n] : pts[Math.max(i - 1, 0)];
    const p1 = pts[i % n];
    const p2 = pts[(i + 1) % n];
    const p3 = closed ? pts[(i + 2) % n] : pts[Math.min(i + 2, n - 1)];
    segments.push({
      type: "C",
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      to: p2,
    });
  }
  return { segments, closed };
}

/**
 * Control points to a path description.
 * @param {Point[]} points
 * @param {number} [cornerRadius]
 * @param {"polyline" | "smooth"} [mode]
 * @param {boolean} [closed]
 * @returns {MeasuredPath}
 */
export function buildPath(points, cornerRadius = 0, mode = "polyline", closed = false) {
  const pts = dedup(points || []);
  if (!pts.length) return { segments: [], closed: false };
  if (pts.length === 1) {
    // A hair of a segment, so the round cap paints a dot.
    return {
      segments: [
        { type: "M", to: pts[0] },
        { type: "L", to: [pts[0][0] + 0.01, pts[0][1]] },
      ],
      closed: false,
    };
  }
  return mode === "smooth"
    ? catmullRom(pts, closed)
    : roundedPolyline(pts, cornerRadius, closed);
}

/** @param {MeasuredPath} path @returns {Path2D} */
export function toPath2D(path) {
  const out = new Path2D();
  for (const seg of path.segments) {
    if (seg.type === "M") out.moveTo(seg.to[0], seg.to[1]);
    else if (seg.type === "L") out.lineTo(seg.to[0], seg.to[1]);
    else out.bezierCurveTo(seg.c1[0], seg.c1[1], seg.c2[0], seg.c2[1], seg.to[0], seg.to[1]);
  }
  if (path.closed) out.closePath();
  return out;
}

/** @param {Point} p0 @param {Point} c1 @param {Point} c2 @param {Point} p1 @param {number} t @returns {Point} */
function cubicAt(p0, c1, c2, p1, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

/**
 * Flatten a path into a polyline with cumulative arc lengths.
 *
 * This is what stands in for QPainterPath.length()/pointAtPercent()/
 * angleAtPercent(): every marker position and dash offset is derived from it.
 */
/** @param {MeasuredPath} path @returns {PathMeasure} */
export function measurePath(path) {
  /** @type {Point[]} */
  const points = [];
  const lengths = [0];
  /** @type {Point | null} */
  let cursor = null;
  /** @type {Point | null} */
  let start = null;

  /** @param {Point} p */
  const push = (p) => {
    if (points.length) {
      const prev = points[points.length - 1];
      const step = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      if (step < 1e-12) return;
      lengths.push(lengths[lengths.length - 1] + step);
    }
    points.push(p);
  };

  for (const seg of path.segments) {
    if (seg.type === "M") {
      cursor = seg.to;
      start = seg.to;
      if (!points.length) points.push(seg.to);
      continue;
    }
    if (seg.type === "L") {
      push(seg.to);
      cursor = seg.to;
      continue;
    }
    // Subdivide by the control polygon's length, so a long curve gets more
    // pieces than a short one and the measured length stays accurate.
    if (cursor === null) {
      cursor = seg.to;
      start ??= seg.to;
      push(seg.to);
      continue;
    }
    const rough = Math.hypot(seg.c1[0] - cursor[0], seg.c1[1] - cursor[1])
      + Math.hypot(seg.c2[0] - seg.c1[0], seg.c2[1] - seg.c1[1])
      + Math.hypot(seg.to[0] - seg.c2[0], seg.to[1] - seg.c2[1]);
    const steps = Math.max(4, Math.min(256, Math.ceil(rough / FLATTEN_STEP)));
    for (let i = 1; i <= steps; i += 1) {
      push(cubicAt(cursor, seg.c1, seg.c2, seg.to, i / steps));
    }
    cursor = seg.to;
  }
  if (path.closed && start && cursor && (start[0] !== cursor[0] || start[1] !== cursor[1])) {
    push(start);
  }

  return {
    points,
    lengths,
    length: lengths[lengths.length - 1] || 0,
  };
}

/** @param {PathMeasure} measure @param {number} distance @returns {{index: number, t: number}} */
function locate(measure, distance) {
  const total = measure.length;
  if (total <= 0) return { index: 0, t: 0 };
  let d = distance;
  // The flow loop runs past the end by design; wrapping keeps it seamless.
  d = ((d % total) + total) % total;
  const { lengths } = measure;
  let low = 0;
  let high = lengths.length - 1;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (lengths[mid] <= d) low = mid;
    else high = mid;
  }
  const span = lengths[low + 1] - lengths[low];
  return { index: low, t: span > EPS ? (d - lengths[low]) / span : 0 };
}

/** Point at an absolute distance along the path. */
/** @param {PathMeasure} measure @param {number} distance @returns {Point} */
export function pointAtLength(measure, distance) {
  if (!measure.points.length) return [0, 0];
  const { index, t } = locate(measure, distance);
  const a = measure.points[index];
  const b = measure.points[Math.min(index + 1, measure.points.length - 1)];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Tangent angle in degrees at an absolute distance, in Qt's convention:
 * counter-clockwise with y pointing up, which is the opposite of the
 * screen's y axis. Kept identical so the marker maths ports unchanged.
 */
/** @param {PathMeasure} measure @param {number} distance @returns {number} */
export function angleAtLength(measure, distance) {
  if (measure.points.length < 2) return 0;
  const { index } = locate(measure, distance);
  const a = measure.points[index];
  const b = measure.points[Math.min(index + 1, measure.points.length - 1)];
  return (-Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}

/** @param {PathMeasure} measure @returns {{left: number, top: number, right: number, bottom: number} | null} */
export function boundingBox(measure) {
  if (!measure.points.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of measure.points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { left: x0, top: y0, right: x1, bottom: y1 };
}

/**
 * Segment closest to `pos`, for editing.
 * Returns {index, distance, point} where index is the insert position.
 */
/**
 * @param {Point[]} points
 * @param {Point} pos
 * @param {boolean} [closed]
 * @returns {{index: number | null, distance: number, point: Point | null}}
 */
export function nearestSegment(points, pos, closed = false) {
  /** @type {{index: number | null, distance: number, point: Point | null}} */
  let best = { index: null, distance: Infinity, point: null };
  const n = points.length;
  if (n < 2) return best;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const l2 = vx * vx + vy * vy;
    if (l2 < EPS) continue;
    let t = ((pos[0] - a[0]) * vx + (pos[1] - a[1]) * vy) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + vx * t;
    const py = a[1] + vy * t;
    const d = Math.hypot(pos[0] - px, pos[1] - py);
    if (d < best.distance) best = { index: i + 1, distance: d, point: [px, py] };
  }
  return best;
}
