/**
 * Cubic Béziers over a stroke's polyline, for the hand editor.
 *
 * A stroke's points are dense samples of its path (see README, "Manual
 * corrections"); the curve is a view over them: fitted on demand with
 * Schneider's algorithm (Graphics Gems, "An Algorithm for Automatically
 * Fitting Digitized Curves"), edited by its anchors and handles, and sampled
 * back into points. The record keeps the points as the contract and the
 * curve beside them once a hand has shaped it.
 *
 * A curve is a list of anchors: {p: [x, y], in: [x, y] | null, out: [x, y] | null}
 * with absolute handle positions; segment k runs p_k, out_k, in_{k+1}, p_{k+1}.
 */

import { resample } from './geometry.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; };

/** Fit cubic segments [p0, c1, c2, p3] to `points` within `maxError` (same units). */
export function fitCubics(points, maxError) {
  const pts = [];
  for (const p of points) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push([p[0], p[1]]);
  }
  const n = pts.length;
  if (n < 2) return [];
  const out = [];
  const tHat1 = norm(sub(pts[1], pts[0]));
  const tHat2 = norm(sub(pts[n - 2], pts[n - 1]));
  fitCubic(pts, 0, n - 1, tHat1, tHat2, maxError, out);
  return out;
}

function fitCubic(pts, first, last, tHat1, tHat2, error, out) {
  const n = last - first + 1;
  if (n === 2) {
    const d = len(sub(pts[last], pts[first])) / 3;
    out.push([pts[first], add(pts[first], mul(tHat1, d)), add(pts[last], mul(tHat2, d)), pts[last]]);
    return;
  }
  let u = chordLengthParameterize(pts, first, last);
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2);
  let { maxErr, split } = computeMaxError(pts, first, last, bez, u);
  if (maxErr < error) { out.push(bez); return; }
  if (maxErr < error * error) {
    for (let i = 0; i < 20; i++) {
      const uPrime = reparameterize(pts, first, last, u, bez);
      bez = generateBezier(pts, first, last, uPrime, tHat1, tHat2);
      ({ maxErr, split } = computeMaxError(pts, first, last, bez, uPrime));
      if (maxErr < error) { out.push(bez); return; }
      u = uPrime;
    }
  }
  const tHatCenter = norm(sub(pts[split - 1], pts[split + 1]));
  fitCubic(pts, first, split, tHat1, tHatCenter, error, out);
  fitCubic(pts, split, last, mul(tHatCenter, -1), tHat2, error, out);
}

function chordLengthParameterize(pts, first, last) {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(pts, first, last, u, tHat1, tHat2) {
  const n = last - first + 1;
  const p0 = pts[first], p3 = pts[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < n; i++) {
    const t = u[i], b0 = (1 - t) ** 3, b1 = 3 * t * (1 - t) ** 2, b2 = 3 * t * t * (1 - t), b3 = t ** 3;
    const a0 = mul(tHat1, b1), a1 = mul(tHat2, b2);
    c00 += dot(a0, a0); c01 += dot(a0, a1); c11 += dot(a1, a1);
    const tmp = sub(pts[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a0, tmp); x1 += dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alphaL = 0, alphaR = 0;
  if (Math.abs(det) > 1e-12) { alphaL = (x0 * c11 - x1 * c01) / det; alphaR = (c00 * x1 - c01 * x0) / det; }
  const segLength = len(sub(p3, p0));
  const epsilon = 1e-6 * segLength;
  if (alphaL < epsilon || alphaR < epsilon) { alphaL = alphaR = segLength / 3; }
  return [p0, add(p0, mul(tHat1, alphaL)), add(p3, mul(tHat2, alphaR)), p3];
}

function computeMaxError(pts, first, last, bez, u) {
  let maxErr = 0, split = Math.floor((last - first + 1) / 2) + first;
  for (let i = first + 1; i < last; i++) {
    const d = len(sub(cubicAt(bez, u[i - first]), pts[i]));
    const e = d * d;
    if (e >= maxErr) { maxErr = e; split = i; }
  }
  return { maxErr: Math.sqrt(maxErr), split };
}

function reparameterize(pts, first, last, u, bez) {
  return u.map((t, i) => newtonRaphson(bez, pts[first + i], t));
}

function newtonRaphson(bez, p, u) {
  const q = cubicAt(bez, u);
  const q1 = [sub(bez[1], bez[0]), sub(bez[2], bez[1]), sub(bez[3], bez[2])].map((v) => mul(v, 3));
  const q2 = [sub(q1[1], q1[0]), sub(q1[2], q1[1])].map((v) => mul(v, 2));
  const qu1 = quadAt(q1, u), qu2 = linAt(q2, u);
  const d = sub(q, p);
  const num = dot(d, qu1), den = dot(qu1, qu1) + dot(d, qu2);
  if (Math.abs(den) < 1e-12) return u;
  return Math.min(1, Math.max(0, u - num / den));
}

/** Point on a cubic [p0, c1, c2, p3] at t. */
export function cubicAt(b, t) {
  const s = 1 - t;
  const w0 = s * s * s, w1 = 3 * s * s * t, w2 = 3 * s * t * t, w3 = t * t * t;
  return [b[0][0] * w0 + b[1][0] * w1 + b[2][0] * w2 + b[3][0] * w3, b[0][1] * w0 + b[1][1] * w1 + b[2][1] * w2 + b[3][1] * w3];
}
function quadAt(b, t) { const s = 1 - t; return add(add(mul(b[0], s * s), mul(b[1], 2 * s * t)), mul(b[2], t * t)); }
function linAt(b, t) { return add(mul(b[0], 1 - t), mul(b[1], t)); }

/** Segments -> anchors {p, in, out}. */
export function anchorsFromSegments(segs) {
  if (!segs.length) return [];
  const a = [{ p: segs[0][0], in: null, out: segs[0][1] }];
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k], next = segs[k + 1];
    a.push({ p: s[3], in: s[2], out: next ? next[1] : null });
  }
  return a;
}

/** Anchors -> segments. */
export function segmentsFromAnchors(anchors) {
  const segs = [];
  for (let k = 0; k + 1 < anchors.length; k++) {
    const a = anchors[k], b = anchors[k + 1];
    segs.push([a.p, a.out || a.p, b.in || b.p, b.p]);
  }
  return segs;
}

/** Sample a curve into points about `step` apart, ends exact. */
export function curveToPolyline(anchors, step) {
  const segs = segmentsFromAnchors(anchors);
  if (!segs.length) return anchors.map((a) => [a.p[0], a.p[1]]);
  const fine = [];
  for (const b of segs) {
    const hull = len(sub(b[1], b[0])) + len(sub(b[2], b[1])) + len(sub(b[3], b[2]));
    const n = Math.max(2, Math.ceil(hull / (step / 3)));
    for (let i = 0; i < n; i++) fine.push(cubicAt(b, i / n));
  }
  const last = segs[segs.length - 1][3];
  fine.push([last[0], last[1]]);
  const pts = resample(fine, step);
  if (pts.length < 2) return [[anchors[0].p[0], anchors[0].p[1]], [last[0], last[1]]];
  pts[0] = [anchors[0].p[0], anchors[0].p[1]];
  pts[pts.length - 1] = [last[0], last[1]];
  return pts;
}
