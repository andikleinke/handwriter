/**
 * Fitting a hand to a font.
 *
 * The font route recovers, for every glyph, the pen's path through the ink
 * (src/lib/strokeRecovery.js: ordered strokes in font units). This module
 * turns those paths into a hand for the pen model: dense waypoints per letter
 * in the letter frame (baseline 0, x-height 1, authored upright, see
 * hand/GUIDE.md) plus the style the font implies - slant from its stems, nib
 * from its stroke widths, letter widths from its advances. The pen model then
 * writes words in the font's forms with its own joins and dynamics.
 *
 * Everything here is pure: the UI collects the records and rasters, this
 * returns data. See docs/plan-font-fit.md for the reasoning behind the
 * choices.
 */

import { inkInfo } from '../lib/snap.js';
import { fontToRaster } from '../lib/raster.js';
import { cumulativeLengths, pointAtLength } from '../lib/geometry.js';
import { composeWord } from './compose.js';
import { letterFromWaypoints } from './letters.js';

export const FIT_VERSION = 1;

/** Waypoint spacing along the path, in x-heights; and the merge rules. */
const STEP_XH = 0.12;
const MERGE_TURN_DEG = 12;
const MERGE_MAX_XH = 0.4;
const CUSP_DEG = 150;
const SAMPLE_XH = 0.03;

/**
 * Dense samples of a glyph record's strokes with the ink's half-width at
 * each, from the raster's distance map (the record itself carries no radii).
 * Points stay in font units at the glyph origin.
 *
 * @returns {Array<{role:string, pts:number[][], radii:number[], retraces:Array}>}
 */
export function sampleChains(record, raster, xh) {
  const info = raster ? inkInfo(raster) : null;
  const step = SAMPLE_XH * xh;
  const fallback = record.stats?.strokeWidthPx?.median && record.stats?.rasterScale
    ? record.stats.strokeWidthPx.median / 2 / record.stats.rasterScale
    : 0;
  return (record.strokes || []).map((s) => {
    const src = s.points;
    const cum = cumulativeLengths(src);
    const L = cum[cum.length - 1];
    const n = Math.max(2, Math.round(L / step) + 1);
    const pts = new Array(n);
    const radii = new Array(n);
    for (let k = 0; k < n; k++) {
      const p = pointAtLength(src, cum, (L * k) / (n - 1));
      pts[k] = p;
      radii[k] = radiusAt(raster, info, p) || 0;
    }
    // a sample off the ink borrows its nearest inked neighbour
    for (let k = 0; k < n; k++) {
      if (radii[k] > 0) continue;
      let v = 0;
      for (let j = 1; j < n && !v; j++) {
        if (k - j >= 0 && radii[k - j] > 0) v = radii[k - j];
        else if (k + j < n && radii[k + j] > 0) v = radii[k + j];
      }
      radii[k] = v || fallback;
    }
    return { role: s.role || 'body', pts, radii, retraces: s.retraces || [], length: L };
  });
}

function radiusAt(raster, info, p) {
  if (!raster || !info) return 0;
  const [x, y] = fontToRaster(raster, p[0], p[1]);
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= raster.width || yi >= raster.height) return 0;
  return info.dist[yi * raster.width + xi] / raster.scale;
}

/**
 * The slant of the writing, in degrees from the vertical (positive leans
 * right): the length-weighted median direction of the thick, near-vertical
 * runs - the stems.
 */
export function measureSlant(chainsByLetter, xh) {
  const samples = []; // [angle, weight]
  const all = [];
  for (const chains of chainsByLetter) for (const c of chains) for (const r of c.radii) if (r > 0) all.push(r);
  const med = median(all);
  const cos25 = Math.cos((25 * Math.PI) / 180);
  for (const chains of chainsByLetter) {
    for (const c of chains) {
      // runs of near-vertical, thick travel at least 0.3 x-heights long
      let run = null;
      const flush = () => {
        if (run && run.len >= 0.3 * xh) samples.push([Math.atan2(run.dx, run.dy), run.len]);
        run = null;
      };
      for (let k = 1; k < c.pts.length; k++) {
        let dx = c.pts[k][0] - c.pts[k - 1][0], dy = c.pts[k][1] - c.pts[k - 1][1];
        const len = Math.hypot(dx, dy);
        if (!len) continue;
        const thick = (c.radii[k] + c.radii[k - 1]) / 2 >= 0.9 * med;
        const vertical = Math.abs(dy) / len >= cos25;
        if (!thick || !vertical) { flush(); continue; }
        if (dy < 0) { dx = -dx; dy = -dy; } // orient upward
        if (!run) run = { dx: 0, dy: 0, len: 0 };
        run.dx += dx; run.dy += dy; run.len += len;
      }
      flush();
    }
  }
  if (!samples.length) return 0;
  samples.sort((a, b) => a[0] - b[0]);
  const total = samples.reduce((s, x) => s + x[1], 0);
  let acc = 0;
  for (const [a, w] of samples) { acc += w; if (acc >= total / 2) return Math.round((a * 180) / Math.PI * 10) / 10; }
  return 0;
}

/**
 * The nib the font's stroke widths imply, in the pen model's terms (widths
 * in x-heights): unshaded if down- and upstrokes are alike, a pointed pen
 * when the downstrokes are thicker, a broad edge when the width follows the
 * direction of travel.
 */
export function nibFromRadii(chainsByLetter, xh) {
  const all = [], up = [], down = [], dirs = [];
  for (const chains of chainsByLetter) for (const c of chains) {
    for (let k = 1; k < c.pts.length; k++) {
      const r = c.radii[k];
      if (!(r > 0)) continue;
      const dx = c.pts[k][0] - c.pts[k - 1][0], dy = c.pts[k][1] - c.pts[k - 1][1];
      if (!Math.hypot(dx, dy)) continue;
      all.push(r); dirs.push([Math.atan2(dy, dx), r]);
      if (dy < -Math.abs(dx) * 0.3) down.push(r); else if (dy > Math.abs(dx) * 0.3) up.push(r);
    }
  }
  const wAll = (2 * median(all)) / xh;
  const wUp = up.length ? (2 * median(up)) / xh : wAll;
  const wDown = down.length ? (2 * median(down)) / xh : wAll;
  const ratio = wUp > 0 ? wDown / wUp : 1;
  // a broad edge: width ∝ |sin(direction - angle)|; try the angles
  let best = { corr: 0, angle: 45 };
  if (dirs.length > 50) {
    for (let phi = 0; phi < 180; phi += 15) {
      const f = (phi * Math.PI) / 180;
      const corr = correlation(dirs.map(([t]) => Math.abs(Math.sin(t - f))), dirs.map(([, r]) => r));
      if (corr > best.corr) best = { corr, angle: phi };
    }
  }
  const p = (arr, q) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
  const r2 = (v) => Math.round(v * 1000) / 1000;
  if (best.corr > 0.55 && ratio < 1.6) {
    return { type: 'broad', wMin: r2((2 * p(all, 0.1)) / xh), wMax: r2((2 * p(all, 0.9)) / xh), angle: best.angle, ratio: r2(ratio), corr: r2(best.corr) };
  }
  if (ratio < 1.25) return { type: 'mono', wMin: r2(wAll), wMax: r2(wAll), ratio: r2(ratio) };
  return { type: 'pointed', wMin: r2(wUp), wMax: r2(wDown), ratio: r2(ratio) };
}

/**
 * One letter from its sampled chains: the first body chain is the letter,
 * every other chain a mark. Returns the entry the hand stores (waypoints in
 * the letter frame), or null when there is nothing to fit.
 */
export function letterFromChains(ch, chains, frame) {
  const { xh, shear, advance } = frame;
  const toFrame = (p) => [r3((p[0] - p[1] * shear) / xh), r3(p[1] / xh)];
  const upper = ch !== ch.toLowerCase();
  const usable = chains.filter((c) => c.pts.length >= 2);
  if (!usable.length) return null;
  const bodies = usable.filter((c) => c.role === 'body');
  const main = bodies.length ? bodies.reduce((a, b) => (b.length > a.length * 1.5 && bodies.indexOf(b) < 2 ? b : a)) : usable[0];
  const rest = usable.filter((c) => c !== main);

  const medR = median(main.radii.filter((r) => r > 0)) || 1;
  const ends = findEnds(main, medR, xh);
  const cusps = cuspIndices(main, xh);
  // the body between entry stub and exit hairline, densified; the stub and
  // the hairline collapse to one waypoint each
  const core = densify(main.pts, cusps, xh, ends.entryEnd, ends.exitStart);
  const waypoints = [];
  if (ends.entryEnd > 0) waypoints.push(toFrame(main.pts[0]));
  for (const p of core) waypoints.push(toFrame(p));
  if (ends.exitStart < main.pts.length - 1) waypoints.push(toFrame(main.pts[main.pts.length - 1]));
  // a fitted lowercase joins on its first body point when there is a stub to
  // replace, else where it starts
  const joinTarget = !upper && ends.entryEnd > 0 ? 1 : 0;
  const last = main.pts[main.pts.length - 1];
  const exit = upper ? 'none' : last[1] / xh > 0.45 ? 'mid' : 'base';

  const marks = rest.map((c) => {
    const isDot = c.role === 'dot' || c.length < 0.2 * xh;
    if (isDot) {
      const mid = c.pts[c.pts.length >> 1];
      return [toFrame(mid)];
    }
    const mc = cuspIndices(c, xh);
    return densify(c.pts, mc, xh, 0, c.pts.length - 1).map(toFrame);
  });

  const first = main.pts[0];
  const width = r3(advance / xh);
  // how much to trust it: the pen should travel rightward on the whole and
  // come in on the left
  const netRight = (last[0] - first[0]) / Math.max(advance, xh);
  const entryLeft = first[0] < 0.55 * Math.max(advance, xh);
  let confidence = 1;
  if (!entryLeft) confidence -= 0.3;
  if (netRight < 0.15 && !upper) confidence -= 0.3;
  if (waypoints.length < 4) confidence -= 0.3;
  return {
    width,
    exit,
    joinTarget,
    waypoints,
    marks,
    confidence: r3(Math.max(0, confidence)),
    hairlineExit: ends.hairline,
    source: { chains: usable.map((c) => ({ role: c.role, pts: c.pts.filter((_, i) => i % 3 === 0).map((p) => [r1(p[0]), r1(p[1])]) })) },
  };
}

/**
 * Where the letter proper begins and ends: an entry stub (the head up to the
 * first turn, at most 0.22 em) and an exit hairline (a thin tail, at most
 * 0.3 em) or, failing a thin tail, nothing.
 */
function findEnds(chain, medR, xh) {
  const { pts, radii } = chain;
  const n = pts.length;
  const cum = cumulativeLengths(pts);
  const em = xh * 5; // the stub and tail caps are quoted in em; five x-heights stands in for one
  // exit: the tail where the ink is thinner than half the median
  let exitStart = n - 1;
  let hairline = false;
  {
    let k = n - 1, thin = 0;
    while (k > 0 && radii[k] < 0.5 * medR) { k--; thin++; }
    const tailLen = cum[n - 1] - cum[k];
    if (thin >= 3 && tailLen > 0.05 * xh) {
      exitStart = k;
      hairline = true;
      // cap the tail at 0.3 em: further back it is body
      while (exitStart < n - 1 && cum[n - 1] - cum[exitStart] > 0.3 * em) exitStart++;
    }
  }
  // entry: the head up to the first turn (> 60° over 0.1 xh), capped at 0.22 em
  let entryEnd = 0;
  {
    const span = Math.max(1, Math.round((0.1 * xh) / Math.max(1e-6, cum[n - 1] / (n - 1))));
    const d0 = dir(pts, 0, Math.min(n - 1, span));
    let k = span;
    while (k < n - 1) {
      const d = dir(pts, k - span < 0 ? 0 : k - span, Math.min(n - 1, k + span));
      const turn = angleBetween(d0, d);
      if (turn > (60 * Math.PI) / 180 || cum[k] > 0.22 * em) break;
      k++;
    }
    if (cum[k] >= 0.06 * xh && k < exitStart - 1) entryEnd = k;
  }
  return { entryEnd, exitStart, hairline };
}

/** Sample indices where the path reverses (the pen stops and turns). */
function cuspIndices(chain, xh) {
  const { pts, retraces } = chain;
  const n = pts.length;
  const cum = cumulativeLengths(pts);
  const spacing = Math.max(1e-6, cum[n - 1] / Math.max(1, n - 1));
  const w = Math.max(1, Math.round((0.06 * xh) / spacing));
  const cusps = new Set();
  for (let k = w; k < n - w; k++) {
    const a = dir(pts, k - w, k), b = dir(pts, k, k + w);
    if (angleBetween(a, b) > (CUSP_DEG * Math.PI) / 180) {
      // keep the sharpest sample of a run
      let best = k, bestTurn = angleBetween(a, b);
      for (let j = k + 1; j < Math.min(n - w, k + w); j++) {
        const t = angleBetween(dir(pts, j - w, j), dir(pts, j, j + w));
        if (t > bestTurn) { bestTurn = t; best = j; }
      }
      cusps.add(best);
      k = best + w;
    }
  }
  for (const r of retraces) {
    for (const p of [r.from, r.to]) {
      if (!p) continue;
      let best = -1, bd = Infinity;
      for (let k = 0; k < n; k++) {
        const d = (pts[k][0] - p[0]) ** 2 + (pts[k][1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      if (best > 0 && best < n - 1 && bd < (0.15 * xh) ** 2) cusps.add(best);
    }
  }
  return cusps;
}

/**
 * Waypoints along a sampled path between two indices: one every 0.12
 * x-heights, but straight runs merge (a turn under 12° and under 0.4
 * x-heights since the last kept point drops the point), and cusps are always
 * kept with their neighbours close so the reversal survives.
 */
function densify(pts, cusps, xh, from, to) {
  const out = [];
  if (to <= from) return [pts[from].slice()];
  const cum = cumulativeLengths(pts);
  let lastIdx = from;
  let lastDir = dir(pts, from, Math.min(to, from + 1));
  out.push(pts[from].slice());
  for (let k = from + 1; k <= to; k++) {
    const isCusp = cusps.has(k);
    const arc = cum[k] - cum[lastIdx];
    const d = dir(pts, k - 1, k);
    const turn = angleBetween(lastDir, d);
    const due = arc >= STEP_XH * xh && (turn >= (MERGE_TURN_DEG * Math.PI) / 180 || arc >= MERGE_MAX_XH * xh);
    const keep = k === to || isCusp || due || (cusps.has(k + 1) && arc > 0.04 * xh) || (cusps.has(k - 1) && arc > 0.04 * xh);
    if (!keep) continue;
    out.push(pts[k].slice());
    lastIdx = k;
    lastDir = dir(pts, k, Math.min(to, k + 1));
  }
  return out;
}

/**
 * The hand: letters fitted one by one and the style the font implies.
 *
 * @param {{name:string, fontKey:string, metrics:object, letters:Array<{ch:string, record:object, raster:object, xAdvance:number}>}} input
 *   metrics: { unitsPerEm, xHeight, capHeight?, ascender?, descender?, italicAngle? }
 * @returns {{hand:object, report:Array<{severity:string, code:string, message:string}>}}
 */
export function fitHand(input) {
  const { metrics } = input;
  const xh = metrics.xHeight;
  const report = [];
  const sampled = input.letters.map((l) => ({ ...l, chains: l.record ? sampleChains(l.record, l.raster, xh) : [] }));
  const lower = sampled.filter((l) => l.ch === l.ch.toLowerCase());
  const slant = measureSlant(lower.map((l) => l.chains), xh);
  const shear = Math.tan((slant * Math.PI) / 180);
  const nib = nibFromRadii(lower.map((l) => l.chains), xh);
  const letters = {};
  let hairlines = 0, fitted = 0;
  let pathXh = 0, wayCount = 0;
  for (const l of sampled) {
    if (!l.chains.length) {
      report.push({ severity: 'warn', code: 'fit-missing', message: `“${l.ch}”: no strokes recovered - the built-in letter stands in` });
      continue;
    }
    const entry = letterFromChains(l.ch, l.chains, { xh, shear, advance: l.xAdvance });
    if (!entry) continue;
    letters[l.ch] = entry;
    fitted++;
    if (entry.hairlineExit) hairlines++;
    for (const c of l.chains) pathXh += c.length / xh;
    wayCount += entry.waypoints.length + entry.marks.reduce((s, m) => s + m.length, 0);
    // recovery doubts worth passing on (a start-point note is routine in a script face)
    const codes = (l.record.notes || []).filter((n) => n.severity === 'warn' && n.code !== 'start-point').map((n) => n.code);
    if (entry.confidence < 0.7 || codes.length) {
      report.push({ severity: entry.confidence < 0.5 ? 'warn' : 'info', code: 'fit-doubt',
        message: `“${l.ch}”: confidence ${entry.confidence}${codes.length ? `, recovery notes: ${[...new Set(codes)].join(', ')}` : ''} - check the glyph in the font route and refit if it is wrong` });
    }
  }
  // join when the face has lead-out hairlines; a print face is written letter by letter
  const join = lower.length ? hairlines / Math.max(1, lower.filter((l) => letters[l.ch]).length) >= 0.5 : false;
  if (!join) for (const [ch, e] of Object.entries(letters)) if (ch === ch.toLowerCase()) e.exit = 'none';
  // tempo: the school hand writes about 3.7 waypoints per x-height of path
  const density = wayCount / Math.max(1e-6, pathXh);
  const tempo = Math.min(0.14, Math.max(0.05, 0.1 * (3.7 / Math.max(1, density))));
  const style = {
    unitsPerEm: 1000,
    xHeight: Math.round((1000 * xh) / metrics.unitsPerEm),
    spacing: 0,
    skew: 0.1,
    lift: 0.16,
    slowShade: nib.type === 'pointed' && nib.ratio > 2.5 ? 0.4 : 0,
    variability: 0.5,
    seed: 1,
    slant,
    tempo: Math.round(tempo * 1000) / 1000,
    nib: { type: nib.type, wMin: nib.wMin, wMax: nib.wMax, ...(nib.angle != null ? { angle: nib.angle } : {}) },
    join,
  };
  // how faithful the pen model's rendering is to the font's paths: the
  // symmetric Chamfer distance between the trajectory of each letter written
  // alone and the recovered chains, in em
  const dist = validateLetters(letters, style, sampled, xh, metrics.unitsPerEm);
  const worst = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const mean = Object.values(dist).reduce((s, v) => s + v, 0) / Math.max(1, Object.keys(dist).length);
  for (const [ch, d] of Object.entries(dist)) {
    letters[ch].fitDistanceEm = d;
    if (d > 0.06) report.push({ severity: 'warn', code: 'fit-far', message: `“${ch}”: the pen model strays ${(d * 1000).toFixed(0)}‰ em from the font's path on average - a corner it cuts or a loop it shrinks; more waypoints or a corrected glyph would help` });
  }
  report.unshift({ severity: mean > 0.05 ? 'warn' : 'ok', code: 'fit-distance', message: `mean distance to the font's paths ${(mean * 1000).toFixed(0)}‰ em${worst.length ? `; farthest ${worst.map(([ch, d]) => `${ch} ${(d * 1000).toFixed(0)}‰`).join(', ')}` : ''}` });
  report.unshift({ severity: 'ok', code: 'fit', message: `fitted ${fitted} letters: slant ${slant}°, ${nib.type} nib ${nib.wMin}–${nib.wMax} xh (down/up ${nib.ratio}), x-height ${style.xHeight}‰ em, ${join ? 'joined' : 'unjoined'} (${hairlines} lead-out hairlines), ${density.toFixed(1)} waypoints per x-height of path, tempo ${Math.round(tempo * 1000)} ms` });
  const hand = {
    version: FIT_VERSION,
    name: input.name,
    fontKey: input.fontKey,
    metrics: {
      unitsPerEm: metrics.unitsPerEm,
      xHeight: xh,
      capHeightXh: metrics.capHeight ? r3(metrics.capHeight / xh) : null,
      ascenderXh: metrics.ascender ? r3(metrics.ascender / xh) : null,
      descenderXh: metrics.descender ? r3(metrics.descender / xh) : null,
    },
    style,
    letters,
    report,
  };
  return { hand, report };
}

/**
 * Per-letter distance between the pen model's trajectory (the letter written
 * alone, without variability) and the font's recovered paths: the symmetric
 * Chamfer distance, in em. Both are sampled every 0.04 x-heights.
 */
function validateLetters(letters, style, sampled, xh, upem) {
  const built = {};
  for (const [ch, e] of Object.entries(letters)) built[ch] = letterFromWaypoints(ch, e);
  const probeStyle = { ...style, letters: built, variability: 0, name: 'probe', slant: style.slant };
  const out = {};
  const step = 0.04 * xh;
  for (const l of sampled) {
    if (!letters[l.ch] || !l.chains.length) continue;
    let r;
    try { r = composeWord(l.ch, probeStyle); } catch { continue; }
    // the model's ink, in font units at the glyph origin
    const k = xh / style.xHeight;
    const model = [];
    for (const c of r.chains) {
      const pts = c.pts.map((p) => [p[0] * k, p[1] * k]);
      const cum = cumulativeLengths(pts);
      const n = Math.max(2, Math.round(cum[cum.length - 1] / step) + 1);
      for (let i = 0; i < n; i++) model.push(pointAtLength(pts, cum, (cum[cum.length - 1] * i) / (n - 1)));
    }
    const font = [];
    for (const c of l.chains) {
      const cum = cumulativeLengths(c.pts);
      const n = Math.max(2, Math.round(cum[cum.length - 1] / step) + 1);
      for (let i = 0; i < n; i++) font.push(pointAtLength(c.pts, cum, (cum[cum.length - 1] * i) / (n - 1)));
    }
    if (!model.length || !font.length) continue;
    out[l.ch] = r3((chamfer(model, font) + chamfer(font, model)) / 2 / upem);
  }
  return out;
}

/** Mean distance from each point of a to its nearest point of b. */
function chamfer(a, b) {
  // a coarse grid over b keeps this linear-ish
  const cell = 8;
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const p of b) { const k = key(p[0], p[1]); (grid.get(k) || grid.set(k, []).get(k)).push(p); }
  let total = 0;
  for (const p of a) {
    let best = Infinity;
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
    for (let ring = 0; ring < 40 && best === Infinity; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cellPts = grid.get(`${cx + dx},${cy + dy}`);
        if (!cellPts) continue;
        for (const q of cellPts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < best) best = d; }
      }
      // a hit in this ring may still be beaten by the next ring's corner: look one further
      if (best < Infinity && ring < 39) {
        const r2 = ring + 1;
        for (let dx = -r2; dx <= r2; dx++) for (let dy = -r2; dy <= r2; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r2) continue;
          const cellPts = grid.get(`${cx + dx},${cy + dy}`);
          if (!cellPts) continue;
          for (const q of cellPts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < best) best = d; }
        }
      }
    }
    total += best === Infinity ? 0 : best;
  }
  return total / a.length;
}

/* ---------------------------------------------------------------- utils -- */

function dir(pts, i, j) {
  const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}
function angleBetween(a, b) {
  const c = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
  return Math.acos(c);
}
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const r3 = (v) => Math.round(v * 1000) / 1000;
const r1 = (v) => Math.round(v * 10) / 10;
