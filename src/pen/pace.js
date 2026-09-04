/**
 * The pen's pace along a fixed path.
 *
 * Geometry is settled before this runs (spline.js); here each sample gets a
 * time. The path is cut into strokes the way a hand makes them - at every
 * stop, and at every vertical reversal (the top of an arch, the bottom of a
 * bowl) or sharp turn - and each stroke gets one asymmetric bell of speed
 * (the lognormal profile of a human stroke, peaking early). Between strokes
 * the pen slows but does not halt; at a stop it comes to rest and dwells.
 * On top of that the two-thirds power law slows the pen into tight curves
 * (v ∝ κ^(-1/3)), and in a shaded hand a full downstroke is written more
 * slowly than a hairline. A stroke lasts longer the further it reaches, but
 * not in proportion (isochrony), and a little longer or shorter with the
 * hand's looseness.
 */

import { lognormalParams } from './lognormal.js';
import { curvature } from './spline.js';

/**
 * @param {number[][]} pts        samples of the path (font units)
 * @param {number[]} cum          cumulative arc length per sample
 * @param {number[]} stopAt       sample indices where the pen halts
 * @param {Float64Array} pressure shade per sample, 0..1 (may be null)
 * @param {object} style          tempo (s), xHeight, variability, skew, slowShade
 * @param {() => number} rnd      the hand's random source
 * @returns {Float64Array} time of each sample, seconds from the chain's start
 */
export function paceChain(pts, cum, stopAt, pressure, style, rnd) {
  const n = pts.length;
  const times = new Float64Array(n);
  if (n < 2) return times;
  const xh = style.xHeight;
  const v = style.variability ?? 0.5;
  const tempoScale = (style.tempo || 0.1) / 0.1;
  const hardStops = new Set(stopAt.filter((i) => i > 0 && i < n - 1));

  // the bell, normalised to its peak, over the stroke's arc fraction
  const { mu, sigma } = lognormalParams(1, style.skew ?? 0.1);
  const pdf = (t) => (t <= 0 ? 0 : Math.exp(-((Math.log(t) - mu) ** 2) / (2 * sigma * sigma)) / (t * sigma));
  const peak = pdf(Math.exp(mu - sigma * sigma));
  const bell = (tau) => pdf(0.02 + 1.1 * tau) / peak;

  // stroke boundaries: stops, vertical reversals, sharp turns - at least a
  // twelfth of an x-height apart
  const cuts = [0];
  const minGap = 0.08 * xh;
  const dyAt = (i) => pts[Math.min(n - 1, i + 2)][1] - pts[Math.max(0, i - 2)][1];
  let lastCut = 0;
  for (let i = 3; i < n - 3; i++) {
    let cut = hardStops.has(i);
    if (!cut) {
      const a = dyAt(i - 2), b = dyAt(i + 2);
      if ((a > 0 && b < 0) || (a < 0 && b > 0)) cut = true; // a vertical reversal
    }
    if (!cut) {
      const p0 = pts[Math.max(0, i - 3)], p1 = pts[i], p2 = pts[Math.min(n - 1, i + 3)];
      const a1 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), a2 = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
      const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      if (turn > 1.9) cut = true; // sharper than about 110 degrees
    }
    if (cut && (cum[i] - cum[lastCut] >= minGap || hardStops.has(i))) { cuts.push(i); lastCut = i; }
  }
  if (cuts[cuts.length - 1] !== n - 1) cuts.push(n - 1);

  const kappa = curvature(pts, cum);
  let clock = 0;
  times[0] = 0;
  for (let b = 0; b < cuts.length - 1; b++) {
    const i0 = cuts[b], i1 = cuts[b + 1];
    const L = cum[i1] - cum[i0];
    if (L <= 1e-9) { for (let i = i0 + 1; i <= i1; i++) times[i] = clock; continue; }
    const lenXh = L / xh;
    // a stroke's duration: a floor for the shortest, then growing with its reach
    let T = (0.05 + 0.1 * lenXh) * tempoScale;
    T *= 1 + 0.3 * v * (rnd() - 0.5);
    const startsAtStop = b === 0 || hardStops.has(i0);
    const endsAtStop = b === cuts.length - 2 || hardStops.has(i1);
    const weights = new Float64Array(i1 - i0);
    let sum = 0;
    for (let i = i0 + 1; i <= i1; i++) {
      const ds = cum[i] - cum[i - 1];
      const tau = (cum[i] - cum[i0]) / L;
      // between strokes the pen keeps a third of its peak speed; into a stop it
      // slows further, but never to a crawl
      let floor = 0.33;
      if (startsAtStop && tau < 0.5) floor = 0.1;
      if (endsAtStop && tau > 0.5) floor = 0.1;
      const kf = Math.min(1, Math.max(0.35, Math.pow(Math.max(Math.abs(kappa[i]) * xh, 1), -1 / 3)));
      const sf = 1 / (1 + (style.slowShade || 0) * (pressure ? pressure[i] : 0));
      const speed = Math.max(floor, bell(tau)) * kf * sf;
      const w = ds / speed;
      weights[i - i0 - 1] = w;
      sum += w;
    }
    for (let i = i0 + 1; i <= i1; i++) {
      clock += (weights[i - i0 - 1] / sum) * T;
      times[i] = clock;
    }
    if (hardStops.has(i1)) clock += 0.03; // the dwell at a stop
  }
  return times;
}
