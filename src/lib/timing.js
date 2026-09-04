/**
 * Pen timing.
 *
 * Turns the pen plan's geometry into a clock. Constant speed is available,
 * but the default follows the handwriting-kinematics literature:
 *
 *   - handwriting is a chain of strokes, one per turning point (the top of an
 *     arch, the bottom of a bowl, a cusp), and each stroke has a bell-shaped
 *     velocity (Plamondon's sigma-lognormal model; minimum jerk, Flash &
 *     Hogan 1985): the pen accelerates out of a turn and slows into the next
 *   - the two-thirds power law (Lacquaniti, Terzuolo & Viviani 1983):
 *     tangential speed ∝ curvature^(-1/3), so tight bends are slow on top of
 *     that
 *   - isochrony between strokes: long strokes get a higher peak speed, short
 *     ones are unhurried, so their durations are more alike than their lengths
 *   - an asymmetry between downstrokes (flexion) and upstrokes (extension)
 *   - an ease in from rest and out into the lift at each pen-down chain, and
 *     short, quick in-air movements between chains
 *
 * The average-speed slider keeps its meaning: each chain's profile is
 * normalised so the chain still takes exactly L / v0 seconds.
 *
 * Parameters live in DEFAULT_SPEED_MODEL; see README for their sources.
 */

import { cumulativeLengths, pointAtLength, polylineLength } from './geometry.js';

/**
 * Defaults come from the handwriting-kinematics literature (see README,
 * "Speed model" for sources and the numbers behind each value):
 *   - curvature exponent 1/3: Lacquaniti, Terzuolo & Viviani 1983, replicated
 *     for handwriting piecewise (Viviani & Flash 1995)
 *   - upstrokes ≈ 13–15% faster than downstrokes in adult cursive
 *     (Thomassen & Meulenbroek 1993: 42 vs 37 mm/s) → ±7% around the mean
 *   - stroke duration ∝ size^≈0.25 (isochrony; Viviani & Flash 1995,
 *     Pagliarini et al. 2017), so dots and short marks are quick (~100 ms)
 *   - bell-shaped velocity per stroke, dipping to roughly a third of the peak
 *     where strokes meet (Plamondon & Guerfali 1998; Flash & Hogan 1985)
 *   - pen-up intervals ≈ 90–155 ms within a word, ≈ 250 ms between words
 *     (Kandel et al. 2008; Chenu et al. 2014); in-air speed unmeasured
 */
export const DEFAULT_SPEED_MODEL = Object.freeze({
  natural: true,
  curvatureExponent: 1 / 3,  // speed ∝ curvature^(-1/3): the two-thirds power law
  curvatureRefEm: 0.1,       // radius (in em) at which the curvature factor is 1
  curvatureSigmaEm: 0.02,    // curvature is measured over this much path
  minFactor: 0.55,           // slowest the curvature law gets in a cusp, relative to nominal
  maxFactor: 1.4,            // fastest on a straight run
  upstrokeBias: 0.07,        // ±7% around the mean: upstrokes faster, downstrokes slower
  easeEm: 0.15,              // length of the ease-in / ease-out at chain ends
  easeFloor: 0.15,           // speed at the very start / end, relative
  sizeExponent: 0.25,        // below sizeRefEm, chain duration ∝ length^0.25
  sizeRefEm: 1.0,            // chains this long or longer run at the average speed
  minChainSeconds: 0.08,     // floor on any pen-down movement
  liftBase: 0.12,            // seconds in the air between strokes of one word
  liftWordBase: 0.25,        // seconds in the air between words
  liftSpeedFactor: 1.5,      // in-air travel relative to average on-paper speed
  // the stroke rhythm
  turnRadiusEm: 0.035,       // a bend tighter than this radius is a cusp, hence a turning point
  minStrokeEm: 0.1,          // turning points closer than this merge into one
  strokeFloor: 0.45,         // speed at a turning point, relative to the stroke's peak
  strokePower: 1.0,          // bell shape: 1 = parabola, 2 ≈ minimum jerk
  strokeIsochrony: 0.5,      // peak speed ∝ stroke length^0.5
  peakMin: 0.75,             // bounds on that peak, relative to the chain's mean stroke
  peakMax: 1.35,
  jitter: 0.06,              // ±6% per-stroke variation of the peak (seeded: a take repeats exactly)
  minSpeed: 0.12,            // floor on the combined factor
});

/**
 * The pen-down chains of a plan: consecutive items that share a chain id,
 * each as one polyline in word coordinates. The animation's reveal maps and
 * the timeline both index chains by their position in this list.
 */
export function planChains(plan) {
  const groups = [];
  for (const it of plan.items) {
    const last = groups[groups.length - 1];
    if (last && last.id === it.chain) last.items.push(it);
    else groups.push({ id: it.chain, word: it.word, items: [it] });
  }
  const out = [];
  for (const g of groups) {
    const poly = concatPolylines(g.items.map((it) => it.points));
    if (poly.length < 2) continue;
    const cum = cumulativeLengths(poly);
    const L = cum[cum.length - 1];
    if (!(L > 0)) continue;
    out.push({ id: g.id, word: g.word, items: g.items, poly, cum, L });
  }
  return out;
}

/**
 * @param {object} plan  from buildPenPlan
 * @param {{unitsPerEm:number, avgSpeed:number, model?:object}} cfg
 *        avgSpeed in font units per second
 */
export function buildTimeline(plan, { unitsPerEm, avgSpeed, model = DEFAULT_SPEED_MODEL }) {
  const chains = [];
  const lifts = [];
  let t = 0;
  let prevEnd = null;
  let prevWord = -1;

  planChains(plan).forEach((g, ci) => {
    const { poly, cum, L } = g;

    let s = 0;
    const items = g.items.map((it) => {
      const len = polylineLength(it.points);
      const r = { ref: it, s0: s, s1: s + len, L: len, tEnd: 0 };
      s += len;
      return r;
    });

    const prof = model.natural
      ? naturalProfile(poly, cum, L, unitsPerEm, avgSpeed, model, ci)
      : constantProfile(L, avgSpeed);

    if (prevEnd) {
      const d = Math.hypot(poly[0][0] - prevEnd[0], poly[0][1] - prevEnd[1]);
      const base = g.word !== prevWord ? model.liftWordBase : model.liftBase;
      const dur = model.natural
        ? base + d / (avgSpeed * model.liftSpeedFactor)
        : Math.max(0.05, d / avgSpeed);
      lifts.push({ t0: t, t1: t + dur, from: prevEnd, to: poly[0] });
      t += dur;
    }
    prevWord = g.word;

    const chain = {
      id: g.id, t0: t, t1: t + prof.T, L, poly, cum, items, sTab: prof.sTab, tTab: prof.tTab,
      strokes: prof.strokes || null,          // sample indices of the turning points (inspection)
      speedFactor: prof.speedFactor || null,  // relative speed per sample (inspection)
    };
    for (const r of items) r.tEnd = chain.t0 + timeAt(chain, r.s1);
    chains.push(chain);
    t = chain.t1;
    prevEnd = poly[poly.length - 1];
  });

  return { chains, lifts, total: Math.max(t, 1e-3), unitsPerEm };
}

/** Seconds into the chain at which the pen reaches arc length s. */
export function timeAt(chain, s) {
  return interp(chain.sTab, chain.tTab, s);
}

/** Arc length along the chain at absolute time T. */
export function arcAt(chain, T) {
  return interp(chain.tTab, chain.sTab, T - chain.t0);
}

/** Where the pen is at time T: on paper (with chain + arc length) or in the air. */
export function penState(timeline, T) {
  for (const c of timeline.chains) {
    if (T >= c.t0 && T < c.t1) {
      const s = arcAt(c, T);
      return { kind: 'down', at: pointAtLength(c.poly, c.cum, s), chain: c, s };
    }
  }
  for (const l of timeline.lifts) {
    if (T >= l.t0 && T < l.t1) {
      const u = (T - l.t0) / (l.t1 - l.t0);
      const e = u * u * (3 - 2 * u);
      return { kind: 'up', at: [l.from[0] + (l.to[0] - l.from[0]) * e, l.from[1] + (l.to[1] - l.from[1]) * e] };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */

function constantProfile(L, v0) {
  const T = Math.max(L / v0, 1e-3);
  return { T, sTab: [0, L], tTab: [0, T] };
}

/**
 * The speed profile of one pen-down chain. Returns the profile as a
 * lookup table between arc length and time; `speedFactor` is exposed for
 * inspection (relative speed per sample, mean 1 in the harmonic sense).
 */
function naturalProfile(poly, cum, L, upem, v0, m, seed = 0) {
  if (L < 1e-6) return { T: 0.02, sTab: [0, L], tTab: [0, 0.02] };

  const n = Math.max(3, Math.ceil(L / Math.max(1.5, upem * 0.004)) + 1);
  const step = L / (n - 1);
  const pts = new Array(n);
  for (let k = 0; k < n; k++) pts[k] = pointAtLength(poly, cum, step * k);

  // unit tangents by central difference; curvature from the turning rate
  const tx = new Float64Array(n), ty = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    tx[k] = dx / l;
    ty[k] = dy / l;
  }
  const raw = new Float64Array(n);
  for (let k = 1; k < n - 1; k++) {
    const d = clamp(tx[k - 1] * tx[k + 1] + ty[k - 1] * ty[k + 1], -1, 1);
    raw[k] = Math.acos(d) / (2 * step);
  }
  raw[0] = raw[1];
  raw[n - 1] = raw[n - 2];
  // curvature over ~0.02 em: the bends of the letter, not the wobble of the
  // recovered polyline, which would otherwise put a twitch into every stroke
  const kappa = gaussianSmooth(raw, (m.curvatureSigmaEm * upem) / step);

  // the chain as a sequence of strokes between turning points, each with a
  // bell-shaped speed and its own peak
  const bounds = strokeBoundaries(ty, kappa, n, step, upem, m);
  const segs = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    segs.push({ k0: bounds[i], k1: bounds[i + 1], L: (bounds[i + 1] - bounds[i]) * step });
  }
  const Lmean = L / segs.length;
  segs.forEach((sg, i) => {
    let pk = Math.pow(Math.max(sg.L, 1e-6) / Lmean, m.strokeIsochrony);
    pk = clamp(pk, m.peakMin, m.peakMax);
    pk *= 1 + m.jitter * (hash01(seed, i) * 2 - 1);
    sg.peak = pk;
  });

  const kRef = 1 / (m.curvatureRefEm * upem);
  const easeLen = Math.min(m.easeEm * upem, L / 2);
  const f = new Float64Array(n);
  let invMean = 0;
  let si = 0;
  for (let k = 0; k < n; k++) {
    while (si < segs.length - 1 && k > segs[si].k1) si++;
    const sg = segs[si];
    const u = (k - sg.k0) / Math.max(1, sg.k1 - sg.k0);
    const bell = m.strokeFloor + (1 - m.strokeFloor) * Math.pow(Math.max(0, 4 * u * (1 - u)), m.strokePower);
    const curv = clamp(Math.pow(kRef / Math.max(kappa[k], 1e-9), m.curvatureExponent), m.minFactor, m.maxFactor);
    const dir = 1 + m.upstrokeBias * ty[k]; // y-up: upward travel has ty > 0
    const s = step * k;
    const edge = Math.min(s, L - s);
    const ramp = edge >= easeLen ? 1 : smoothstep(edge / easeLen);
    const ease = m.easeFloor + (1 - m.easeFloor) * ramp;
    f[k] = Math.max(m.minSpeed, curv * dir * ease * bell * sg.peak);
    invMean += 1 / f[k];
  }
  invMean /= n;

  // Harmonic normalisation: with v = v0 · f · mean(1/f), the total time
  // Σ ds / v comes out to exactly L / v0 - then isochrony shortens small
  // movements (duration ∝ length^sizeExponent below the reference size).
  const sTab = new Float64Array(n), tTab = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    const vA = v0 * f[k - 1] * invMean, vB = v0 * f[k] * invMean;
    sTab[k] = step * k;
    tTab[k] = tTab[k - 1] + step / (0.5 * (vA + vB));
  }
  const Lref = m.sizeRefEm * upem;
  let target = L / v0;
  if (L < Lref) target = (Lref / v0) * Math.pow(L / Lref, m.sizeExponent);
  target = Math.max(target, m.minChainSeconds);
  const scale = target / tTab[n - 1];
  for (let k = 1; k < n; k++) tTab[k] *= scale;
  return { T: target, sTab, tTab, speedFactor: f, strokes: bounds };
}

/**
 * Sample indices where one stroke ends and the next begins: vertical
 * reversals (with hysteresis, so a wobble on a flat run is not a turn) and
 * cusps (local curvature maxima tighter than turnRadiusEm), merged when
 * closer than minStrokeEm.
 * The chain's ends are always included.
 */
function strokeBoundaries(ty, kappa, n, step, upem, m) {
  const marks = new Set();
  const H = 0.35;
  let dir = 0, pending = -1;
  for (let k = 0; k < n; k++) {
    const v = ty[k];
    if (dir === 0) {
      if (v > H) dir = 1; else if (v < -H) dir = -1;
      continue;
    }
    if (pending < 0) {
      if (v * dir < 0) pending = k;
      continue;
    }
    if (v * dir > 0) { pending = -1; continue; } // it came back: no reversal
    if (Math.abs(v) > H) { marks.add(pending); dir = -dir; pending = -1; }
  }
  const kMin = 1 / (m.turnRadiusEm * upem);
  const half = Math.max(3, Math.round((m.minStrokeEm * upem) / step / 2));
  for (let k = half; k < n - half; k++) {
    if (kappa[k] < kMin) continue;
    let top = true;
    for (let j = k - half; j <= k + half; j++) {
      if (kappa[j] > kappa[k] || (kappa[j] === kappa[k] && j < k)) { top = false; break; }
    }
    if (top) marks.add(k);
  }
  const gap = Math.max(1, Math.round((m.minStrokeEm * upem) / step));
  const out = [0];
  for (const k of [...marks].sort((a, b) => a - b)) {
    if (k - out[out.length - 1] < gap || n - 1 - k < gap) continue;
    out.push(k);
  }
  out.push(n - 1);
  return out;
}

/** Gaussian smoothing of a sampled profile, sigma in samples. */
function gaussianSmooth(a, sigma) {
  const n = a.length;
  const R = Math.max(1, Math.ceil(sigma * 3));
  const w = new Float64Array(2 * R + 1);
  for (let i = -R; i <= R; i++) w[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma));
  const o = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0, ws = 0;
    for (let i = -R; i <= R; i++) {
      const j = k + i;
      if (j < 0 || j >= n) continue;
      sum += a[j] * w[i + R];
      ws += w[i + R];
    }
    o[k] = sum / ws;
  }
  return o;
}

/** Deterministic pseudo-random in [0, 1) from two integers. */
function hash01(seed, i) {
  let h = Math.imul(seed + 1, 73856093) ^ Math.imul(i + 1, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function concatPolylines(lists) {
  const out = [];
  for (const pts of lists) {
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
      out.push(p);
    }
  }
  return out;
}

/** Piecewise-linear lookup on a monotonic table, clamped at both ends. */
function interp(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const span = xs[hi] - xs[lo] || 1;
  return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / span;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (x) => x * x * (3 - 2 * x);
