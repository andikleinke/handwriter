/**
 * Curves for the pen model.
 *
 * The pen's path is geometry first: a centripetal Catmull-Rom spline through
 * the waypoints - it passes through every one of them exactly, never
 * overshoots and rounds smoothly between them - split wherever the pen
 * stops (a cusp, an explicit stop), so a reversal stays a point. Connectors
 * between letters are circular arcs and straight runs sampled into
 * waypoints of the same chain, so the spline carries them too.
 *
 * Dynamics are applied afterwards, along this fixed path (pace.js): the
 * shape of a letter never depends on how fast it was written.
 */

import { createHobbyBezier } from './hobby.js';

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Hobby's spline through `points` (METAFONT's curve: interpolating, with
 * near-continuous curvature and no overshoot in practice), sampled about
 * `step` apart. Falls back to the Catmull-Rom spline if the solve misbehaves.
 */
export function hobbySpline(points, step) {
  const pts = dedupe(points);
  const n = pts.length;
  if (n < 3) return catmullRom(pts, step);
  let segs;
  try {
    segs = createHobbyBezier(pts.map(([x, y]) => ({ x, y })), { tension: 1, cyclic: false });
  } catch {
    return catmullRom(pts, step);
  }
  const out = [pts[0].slice()];
  for (let i = 0; i < segs.length; i++) {
    const p0 = pts[i], c1 = segs[i].startControl, c2 = segs[i].endControl, p3 = pts[i + 1];
    if (![c1.x, c1.y, c2.x, c2.y].every(Number.isFinite)) return catmullRom(pts, step);
    const approx = dist(p0, [c1.x, c1.y]) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + dist([c2.x, c2.y], p3);
    const m = Math.max(2, Math.ceil(approx / step));
    for (let k = 1; k <= m; k++) {
      const t = k / m, u = 1 - t;
      out.push(k === m ? p3.slice() : [
        u * u * u * p0[0] + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3[1],
      ]);
    }
  }
  return out;
}

/** Drop consecutive duplicates (they would break the knot spacing). */
function dedupe(points) {
  const out = [];
  for (const p of points) if (!out.length || dist(out[out.length - 1], p) > 1e-6) out.push([p[0], p[1]]);
  return out;
}

/** Barry-Goldman evaluation of the Catmull-Rom segment p1..p2 at knot value t. */
function crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const mix = (a, b, ta, tb) => {
    const u = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  const A1 = mix(p0, p1, t0, t1), A2 = mix(p1, p2, t1, t2), A3 = mix(p2, p3, t2, t3);
  const B1 = mix(A1, A2, t0, t2), B2 = mix(A2, A3, t1, t3);
  return mix(B1, B2, t1, t2);
}

/**
 * A centripetal Catmull-Rom spline through `points`, sampled about `step`
 * apart (font units). The ends are open: the curve leaves the first point
 * and arrives at the last along the direction of its neighbour.
 */
export function catmullRom(points, step, alpha = 0.5) {
  const pts = dedupe(points);
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [pts[0].slice()];
  if (n === 2) {
    const m = Math.max(1, Math.ceil(dist(pts[0], pts[1]) / step));
    const out = [];
    for (let k = 0; k <= m; k++) out.push(lerp(pts[0], pts[1], k / m));
    return out;
  }
  const P = [
    [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]],
    ...pts,
    [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]],
  ];
  const out = [pts[0].slice()];
  for (let i = 1; i < n; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const t0 = 0;
    const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-9), alpha);
    const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-9), alpha);
    const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-9), alpha);
    const m = Math.max(2, Math.ceil(dist(p1, p2) / step));
    for (let k = 1; k <= m; k++) {
      const t = t1 + ((t2 - t1) * k) / m;
      out.push(k === m ? p2.slice() : crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t));
    }
  }
  return out;
}

/**
 * One pen-down chain of waypoints as a dense path: a spline through each run
 * between stops, joined at the stop points.
 *
 * @param {number[][]} points  waypoints in font units
 * @param {Set<number>} stops  indices of waypoints where the pen halts
 * @param {number} step        sample spacing, font units
 * @returns {{pts:number[][], anchor:number[], stopAt:number[]}}
 *   pts: the samples; anchor[i]: the sample index nearest waypoint i;
 *   stopAt: sample indices of the interior stops
 */
export function sampleChain(points, stops, step) {
  const n = points.length;
  if (n === 0) return { pts: [], anchor: [], stopAt: [] };
  const cuts = [0, ...[...stops].filter((i) => i > 0 && i < n - 1).sort((a, b) => a - b), n - 1];
  const pts = [];
  const anchor = new Array(n).fill(0);
  const stopAt = [];
  for (let r = 0; r < cuts.length - 1; r++) {
    const a = cuts[r], b = cuts[r + 1];
    if (b <= a) continue;
    const seg = hobbySpline(points.slice(a, b + 1), step);
    const base = Math.max(0, pts.length - 1);
    if (pts.length && seg.length) seg.shift(); // the stop point is already there
    for (const p of seg) pts.push(p);
    for (let j = a; j <= b; j++) anchor[j] = nearestIndex(pts, points[j], base);
    if (r < cuts.length - 2) stopAt.push(pts.length - 1);
  }
  if (!pts.length) pts.push(points[0].slice());
  return { pts, anchor, stopAt };
}

function nearestIndex(pts, p, from) {
  let best = from, bd = Infinity;
  for (let i = from; i < pts.length; i++) {
    const d = (pts[i][0] - p[0]) ** 2 + (pts[i][1] - p[1]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Points along the circular arc from `from` to `to` that turns through
 * `sweep` radians (positive = counter-clockwise; it leaves at chord -
 * sweep/2 and arrives at chord + sweep/2), `n` of them after `from`, the
 * last being `to`. A tiny sweep gives a straight line.
 */
export function arcSamples(from, to, sweep, n) {
  const out = [];
  const chord = dist(from, to);
  if (Math.abs(sweep) < 1e-3 || chord < 1e-9) {
    for (let k = 1; k <= n; k++) out.push(lerp(from, to, k / n));
    return out;
  }
  const chordAngle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const thetaS = chordAngle - sweep / 2;
  const R = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const s = Math.sign(sweep);
  // the centre lies to the left of the start direction for a left turn
  const C = [from[0] - s * R * Math.sin(thetaS), from[1] + s * R * Math.cos(thetaS)];
  for (let k = 1; k <= n; k++) {
    const phi = thetaS + (sweep * k) / n;
    out.push(k === n ? [to[0], to[1]] : [C[0] + s * R * Math.sin(phi), C[1] - s * R * Math.cos(phi)]);
  }
  return out;
}

/** Signed turning per unit length at each sample, lightly smoothed. */
export function curvature(pts, cum) {
  const n = pts.length;
  const k = new Float64Array(n);
  if (n < 3) return k;
  const ang = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    ang[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
  }
  const wrap = (t) => Math.atan2(Math.sin(t), Math.cos(t));
  for (let i = 1; i < n - 1; i++) {
    const ds = cum[i + 1] - cum[i - 1];
    k[i] = ds > 1e-9 ? wrap(ang[i + 1] - ang[i - 1]) / ds : 0;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) { s += k[j]; c++; }
    out[i] = s / c;
  }
  return out;
}
