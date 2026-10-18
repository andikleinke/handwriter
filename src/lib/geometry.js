/**
 * Pure polyline geometry helpers.
 * No DOM, no font knowledge - just arrays of [x, y] pairs.
 */

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** Cumulative arc length, same length as pts, cum[0] === 0. */
export function cumulativeLengths(pts) {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + dist(pts[i - 1], pts[i]);
  return cum;
}

/** Point at arc length L along the polyline (clamped at both ends). */
export function pointAtLength(pts, cum, L) {
  if (pts.length === 0) return null;
  if (pts.length === 1 || L <= 0) return pts[0].slice();
  const total = cum[cum.length - 1];
  if (L >= total) return pts[pts.length - 1].slice();
  // binary search for the segment containing L
  let lo = 0, hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= L) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (L - cum[lo]) / seg;
  return [
    pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t,
    pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t,
  ];
}

/**
 * The prefix of `pts` up to arc length L, with an interpolated final point.
 * This is the arc-length parameterisation the mask animation rides on.
 */
export function truncateToLength(pts, cum, L) {
  if (pts.length === 0) return [];
  if (L <= 0) return [pts[0].slice()];
  const total = cum[cum.length - 1];
  if (L >= total) return pts.map((p) => p.slice());
  const out = [pts[0].slice()];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] <= L) {
      out.push(pts[i].slice());
    } else {
      const seg = cum[i] - cum[i - 1] || 1;
      const t = (L - cum[i - 1]) / seg;
      out.push([
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      ]);
      break;
    }
  }
  return out;
}

/** Ramer-Douglas-Peucker. Kills the pixel staircase left by thinning. */
export function simplifyRDP(pts, eps) {
  if (pts.length < 3) return pts.map((p) => p.slice());
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 <= i0 + 1) continue;
    const [x0, y0] = pts[i0];
    const [x1, y1] = pts[i1];
    const dx = x1 - x0, dy = y1 - y0;
    const segLen = Math.hypot(dx, dy);
    let best = -1, bestD = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = pts[i];
      let d;
      if (segLen < 1e-9) {
        d = Math.hypot(px - x0, py - y0);
      } else {
        d = Math.abs(dy * px - dx * py + x1 * y0 - y1 * x0) / segLen;
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (bestD > eps) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i].slice());
  return out;
}

/** Uniform arc-length resampling at `step` spacing. Endpoints are preserved. */
export function resample(pts, step) {
  if (pts.length < 2) return pts.map((p) => p.slice());
  const cum = cumulativeLengths(pts);
  const total = cum[cum.length - 1];
  if (total < 1e-9) return [pts[0].slice()];
  const n = Math.max(1, Math.round(total / step));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(pointAtLength(pts, cum, (total * i) / n));
  return out;
}

/**
 * Moving-average smoothing with fixed endpoints. Loops (start === end) are
 * smoothed cyclically so the seam does not develop a corner.
 */
export function smoothPolyline(pts, iterations = 2, radius = 2) {
  if (pts.length < 3) return pts.map((p) => p.slice());
  const closed = dist(pts[0], pts[pts.length - 1]) < 1e-6;
  let cur = pts.map((p) => p.slice());
  for (let it = 0; it < iterations; it++) {
    const next = cur.map((p) => p.slice());
    const n = cur.length;
    const m = closed ? n - 1 : n; // drop duplicated last point while cycling
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      let sx = 0, sy = 0, c = 0;
      for (let k = -radius; k <= radius; k++) {
        let j = i + k;
        if (closed) {
          j = ((j % m) + m) % m;
        } else if (j < 0 || j >= n) {
          continue;
        }
        sx += cur[j][0]; sy += cur[j][1]; c++;
      }
      next[i] = [sx / c, sy / c];
    }
    if (closed) next[n - 1] = next[0].slice();
    cur = next;
  }
  return cur;
}

export function bboxOf(pts) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
  }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

/** Unit tangent leaving pts[0], averaged over roughly `span` units of arc. */
export function leadingTangent(pts, span = 6) {
  if (pts.length < 2) return [0, 0];
  let acc = 0;
  let i = 1;
  for (; i < pts.length && acc < span; i++) acc += dist(pts[i - 1], pts[i]);
  const dx = pts[i - 1][0] - pts[0][0];
  const dy = pts[i - 1][1] - pts[0][1];
  const m = Math.hypot(dx, dy) || 1;
  return [dx / m, dy / m];
}

/** Unit tangent arriving at the last point. */
export function trailingTangent(pts, span = 6) {
  if (pts.length < 2) return [0, 0];
  const last = pts.length - 1;
  let acc = 0;
  let i = last - 1;
  for (; i > 0 && acc < span; i--) acc += dist(pts[i], pts[i + 1]);
  const dx = pts[last][0] - pts[i][0];
  const dy = pts[last][1] - pts[i][1];
  const m = Math.hypot(dx, dy) || 1;
  return [dx / m, dy / m];
}

export function centroid(pts) {
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}

/**
 * Moving-average smoothing that keeps corners. A corner is where the path's
 * direction changes by more than cornerDeg over a short window (so a real
 * corner drawn as a few gentle samples is still one corner, while a curve is
 * not); runs between corners are smoothed separately with their ends fixed.
 * That keeps the point of a tail, a retrace, or the pointed eye of an 'e',
 * while the curves between lose the pixel wobble of thinning.
 */
export function smoothPreservingCorners(pts, iterations = 4, radius = 3, cornerDeg = 60, window = 3) {
  if (pts.length < 3) return pts.map((p) => p.slice());
  const n = pts.length;
  const cosLimit = Math.cos((cornerDeg * Math.PI) / 180);
  // turning angle at each point, measured over ±window samples
  const turn = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const i0 = Math.max(0, i - window), i1 = Math.min(n - 1, i + window);
    const ax = pts[i][0] - pts[i0][0], ay = pts[i][1] - pts[i0][1];
    const bx = pts[i1][0] - pts[i][0], by = pts[i1][1] - pts[i][1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    const c = (ax * bx + ay * by) / (la * lb);
    turn[i] = c < cosLimit ? 1 - c : 0; // 0 = no corner; larger = sharper
  }
  // one corner per cluster: the sharpest within ±window
  const corners = [0];
  for (let i = 1; i < n - 1; i++) {
    if (!turn[i]) continue;
    let best = true;
    for (let j = Math.max(1, i - window); j <= Math.min(n - 2, i + window); j++) {
      if (turn[j] > turn[i] || (turn[j] === turn[i] && j < i)) { best = false; break; }
    }
    if (best) corners.push(i);
  }
  corners.push(n - 1);
  const out = [];
  for (let c = 0; c + 1 < corners.length; c++) {
    const run = smoothPolyline(pts.slice(corners[c], corners[c + 1] + 1), iterations, radius);
    if (out.length) run.shift();
    out.push(...run);
  }
  return out;
}

export function roundPts(pts, decimals = 2) {
  const f = 10 ** decimals;
  return pts.map(([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f]);
}

/**
 * A smooth, dense polyline through `pts`: a centripetal Catmull-Rom spline
 * through the points, sampled about `step` apart, broken at any vertex
 * where the path turns by more than `cornerDeg` so a real corner stays one.
 * A stroke record keeps sparse points (thinned to 0.0012 em); a ribbon or a
 * reveal map built straight along that polygon shows every vertex as a kink
 * in its edges, where the pen's path was smooth.
 */
export function smoothThroughPoints(pts, step, cornerDeg = 60) {
  const n = pts.length;
  if (n < 3) return pts.map((p) => [p[0], p[1]]);
  const cosLimit = Math.cos((cornerDeg * Math.PI) / 180);
  // split at corners
  const runs = [];
  let run = [pts[0]];
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[i][0] - pts[i - 1][0], ay = pts[i][1] - pts[i - 1][1];
    const bx = pts[i + 1][0] - pts[i][0], by = pts[i + 1][1] - pts[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    run.push(pts[i]);
    if (la > 1e-9 && lb > 1e-9 && (ax * bx + ay * by) / (la * lb) < cosLimit) { runs.push(run); run = [pts[i]]; }
  }
  run.push(pts[n - 1]);
  runs.push(run);
  const out = [];
  for (const r of runs) {
    const seg = catmullRom(r, step);
    if (out.length) seg.shift(); // the corner itself is shared
    out.push(...seg);
  }
  return out;
}

/** Centripetal Catmull-Rom through `p`, each span sampled about `step` apart (ends exact). */
function catmullRom(p, step) {
  const m = p.length;
  if (m < 2) return p.map((q) => [q[0], q[1]]);
  if (m === 2) return [[p[0][0], p[0][1]], [p[1][0], p[1][1]]];
  const out = [[p[0][0], p[0][1]]];
  const ext = [reflect(p[1], p[0]), ...p, reflect(p[m - 2], p[m - 1])];
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const span = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(1, Math.ceil(span / step));
    const t0 = 0, t1 = t0 + Math.sqrt(dist(p0, p1)), t2 = t1 + Math.sqrt(dist(p1, p2)), t3 = t2 + Math.sqrt(dist(p2, p3));
    for (let j = 1; j <= k; j++) {
      const t = t1 + ((t2 - t1) * j) / k;
      out.push(j === k ? [p2[0], p2[1]] : crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t));
    }
  }
  return out;
}
function reflect(a, about) { return [2 * about[0] - a[0], 2 * about[1] - a[1]]; }
function crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const lerp = (a, b, ta, tb) => (tb - ta < 1e-12 ? a : [a[0] + ((b[0] - a[0]) * (t - ta)) / (tb - ta), a[1] + ((b[1] - a[1]) * (t - ta)) / (tb - ta)]);
  const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}
