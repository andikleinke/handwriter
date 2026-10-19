/**
 * Reveal maps: which pass of the pen uncovers each pixel of a glyph, and at
 * what arc length along that pass it does so.
 *
 * The nib is a disk whose radius follows the ink's half-width, read from the
 * distance map as a running minimum over 0.16 em of path, so a crossing or a
 * knot - which inflates the distance map for a stroke-width or two - cannot
 * widen it and reveal a piece of a stroke still to come. The passes are replayed in pen order and every pixel the disk
 * touches for the first time is claimed by that pass at that arc length -
 * first pass wins, exactly as ink on paper. The disk grows through the ink
 * only, so it never reaches across a counter to the far side of a loop.
 *
 * Whatever the disks never touch - a wedge, the flare of a foot, the far side
 * of a merge, a taper beyond the path's end - is handed to the nearest
 * claimed pixel and appears just after it, like ink spreading from the nib.
 * So a frame is always the font's own outline, cut by a round front, and
 * nothing has to pop in when a stroke completes.
 *
 * The one exception is a join between letters. Where the pen flows from one
 * letter into the next, the plan trims the first letter's exit hairline and
 * bridges the gap; the font's own tail beyond that cut, and any entry
 * hairline before the next letter's entry point, still exist as ink - two
 * shapes overlapping at a slight angle, with a notch where they cross. That
 * ink is never travelled, so it is hidden here (unless a real pass covers
 * it), and the animator paints the bridge as one smooth ribbon in its place.
 * The ribbon runs a short way (BLEND_EM) into both letters, reproducing the
 * ink's own cross-section there, so it merges into the letters seamlessly.
 */

import { fontToRaster } from '../lib/raster.js';
import { inkInfo } from '../lib/snap.js';
import { pointAtLength, polylineLength } from '../lib/geometry.js';

export const NIB_MIN_EM = 0.08;     // the nib's radius is read from the ink over this much path either way (past any knot)
export const NIB_PERCENTILE = 0.75; // ...at this percentile of it: a crossing's swell is outvoted, a shade's own is not
export const CROSS_CAP = 1.8;       // how far past that radius the measured cross-section may reach
export const CROSS_SLEW = 0.35;     // ...and how fast it may widen along the path (font units per unit travelled)
export const JUNCTION_MAX_EM = 0.3;  // a crossing this short is redrawn straight through; longer is a retrace
export const JUNCTION_NEAR_EM = 0.15; // this far into a retrace the pen still has the width it arrived with
export const JUNCTION_EDGE_EM = 0.05; // ...and this far in, its clean edge continues as a straight line
export const THIN_IN_THICK = 1.5;    // ink this many times thicker than where a pointed pen's upstroke came in is a shade around a hairline
export const NIB_SLACK_PX = 1.0;    // the nib reaches this far past the measured half-width
export const PASS_GAP_EM = 0.08;    // arc length that separates two passes of one chain over the same ink
export const EDGE_BIAS_PX = 0.5;    // a reading runs to the first background sample; the ink's last sample is this much short of it
export const EDGE_RING_PX = 2;      // background this close to ink joins the map (the outline clips it)
export const HIDDEN = -2;           // chain id of ink that is never shown (an untravelled tail at a join)
export const BLEND_EM = 0.08;       // how far the join ribbon runs into each letter

/**
 * @param {object} analysis  glyphs with rasters and word offsets
 * @param {Array}  chains    pen-down chains in time order (see timing.planChains)
 * @param {number} upem
 */
export function buildRevealMaps(analysis, chains, upem) {
  const glyphs = analysis.glyphs;
  let scaleMin = Infinity;
  for (const g of glyphs) if (g.raster && g.raster.scale < scaleMin) scaleMin = g.raster.scale;
  if (!Number.isFinite(scaleMin)) return { glyphs: [], unassigned: 0 };
  const step = 1 / scaleMin; // one raster pixel, in font units
  const sampled = chains.map((c) => sampleChain(c, step, glyphs, upem));
  capWidthsAtJunctions(sampled, step, upem, glyphs, chains);
  joinWidths(sampled, chains);
  const out = [];
  let unassigned = 0;
  glyphs.forEach((g, gi) => {
    const m = g.raster ? buildGlyphMap(g, gi, chains, sampled, upem) : null;
    out[gi] = m;
    if (m) unassigned += m.unassigned;
  });
  return { glyphs: out, unassigned, sampled }; // sampled: for inspection
}

/** Samples along one chain with the nib radius (font units) at each. */
function sampleChain(chain, step, glyphs, upem) {
  const { poly, cum, L } = chain;
  const n = Math.max(2, Math.floor(L / step) + 2);
  const pts = new Array(n);
  const s = new Float32Array(n);
  const raw = new Float32Array(n);
  const item = new Int16Array(n);
  // which plan item (stroke or bridge) each arc length belongs to
  const items = chain.items;
  const ends = [];
  let acc = 0;
  for (const it of items) { acc += polylineLength(it.points); ends.push(acc); }
  let ii = 0;
  for (let k = 0; k < n; k++) {
    const sk = Math.min(L, k * step);
    s[k] = sk;
    while (ii < ends.length - 1 && sk > ends[ii]) ii++;
    item[k] = ii;
    const p = pointAtLength(poly, cum, sk);
    pts[k] = p;
    let best = 0;
    for (const g of glyphs) {
      const r = g.raster;
      if (!r) continue;
      const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) continue;
      const d = inkInfo(r).dist[yi * r.width + xi] / r.scale;
      if (d > best) best = d;
    }
    raw[k] = best;
  }
  // a sample off the ink (a bridge over a gap, a smoothed path leaving a
  // hairline) borrows its nearest inked neighbour
  for (let k = 0; k < n; k++) {
    if (raw[k] > 0) continue;
    for (let j = 1; k - j >= 0 || k + j < n; j++) {
      if (k - j >= 0 && raw[k - j] > 0) { raw[k] = raw[k - j]; break; }
      if (k + j < n && raw[k + j] > 0) { raw[k] = raw[k + j]; break; }
    }
  }
  // The radius is a running minimum: a crossing or a knot inflates the
  // distance map for a stroke-width or so, and the window reaches past it to
  // the band's own half-width on either side. It can only under-estimate -
  // along a taper, by the taper's slope - and ink the nib misses follows it
  // a moment later within the same pass (pass 2 below), which is invisible;
  // over-estimating would sweep a piece of a crossing stroke still to come.
  const W = Math.max(2, Math.round((NIB_MIN_EM * upem) / step));
  const R = runningPercentile(raw, W, NIB_PERCENTILE);

  // The ink's real cross-section: how far it reaches perpendicular to travel
  // on each side. A disc of radius R is only ever an inscribed circle - it
  // under-reads wherever the stroke is wider than it is round (a shade, a
  // taper) - and the ink it misses ends up owned by whichever pass is
  // nearest, which at a crossing is the one still to come.
  const halfL = new Float32Array(n);
  const halfR = new Float32Array(n);
  const edge = new Uint8Array(2 * n); // [left, right]: did the reading end at background?
  const hit = { edge: false };
  const tan = new Float32Array(2 * n);
  for (let k = 0; k < n; k++) {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    tan[2 * k] = dx / l;
    tan[2 * k + 1] = dy / l;
    const nx = -dy / l, ny = dx / l;
    const cap = Math.max(R[k] * CROSS_CAP, R[k] + 1 / (glyphs[0]?.raster?.scale || 1));
    halfL[k] = reachAcross(glyphs, pts[k], nx, ny, cap, R[k], hit);
    edge[2 * k] = hit.edge ? 1 : 0;
    halfR[k] = reachAcross(glyphs, pts[k], -nx, -ny, cap, R[k], hit);
    edge[2 * k + 1] = hit.edge ? 1 : 0;
  }
  // A pen widens as it is pressed, not in one step. Where the path runs into
  // ink that is locally thick for a reason of its own - a join landing in the
  // eye of an `e`, where the loop crosses - the measurement jumps from a
  // hairline to a shade between one sample and the next, and the band claims
  // the whole crossing at once: a black wedge on the join. Limiting how fast
  // the cross-section may grow along the path leaves the swell of a real
  // shade untouched (it takes a fifth of an em) and clips the jump.
  slewLimit(halfL, s, CROSS_SLEW);
  slewLimit(halfR, s, CROSS_SLEW);
  return { pts, s, R, n, item, halfL, halfR, tan, edge };
}

/**
 * Through a junction a stroke keeps the width it arrived with, and its line.
 *
 * A pen does not change because another stroke is near: eight pixels wide
 * going into a crossing and eight coming out, it is eight pixels wide all the
 * way through. The measurements say otherwise on both counts. The
 * cross-section is read perpendicular to the path, out to the ink's edge or
 * to the valley between two cores; where two strokes meet at a shallow angle
 * there is no valley and the reading runs on into the other stroke (the
 * square nub on the `L`: 356 of 358 pixels of the stem shown during the
 * bowl), and where the valley is sharp the reading falls short of the
 * stroke's own edge (the notch in the `J`'s stem where the loop crosses: the
 * facing half-width dropped from 11 to 7 px). And the path itself swerves:
 * the skeleton of two merged strokes bends toward their union, so the band
 * tilts through the crossing, bulging on one side and leaving a step on the
 * other.
 *
 * So a short junction stretch - a crossing, up to JUNCTION_MAX_EM of path -
 * is redrawn from its clean approach and departure: the centreline follows a
 * Hermite curve from the last clean sample before to the first after, with
 * the tangents the pen had there, and each half-width runs linearly from the
 * median it had just before to the median just after. On the side that faces
 * the other stroke that replaces the measurement, and the band stops half a
 * pixel inside it rather than the nib's usual pixel beyond (a measured
 * half-width runs to the first background pixel; claiming past it bit a
 * pixel or two out of the other stroke, the serrated lip under the `J`'s
 * bar) - except for pixels on the ink's own free edge, which are claimed to
 * the full reach, since nothing but background lies beyond them. On the
 * other side the measurement may still exceed it, provided the reading ran
 * out to background: a shade swells through a crossing on its own convex
 * side, and that is real width. A reading cut short inside other ink is
 * not - a hairline entering the `e`'s shade from below read the shade's
 * width on its far side and ended in a knob. The centreline
 * is redrawn only for a short stretch, and only if the new one lies on ink
 * throughout; a long stretch (a retrace running beside itself for hundreds
 * of units, where no chord describes the path) keeps its measured line, but
 * its widths follow the same rule - the `J`'s bar, retraced, had read 4.5 px
 * where it passed over the stem and left a ragged lip there until the return
 * pass. Never less than the nib radius, which is the one measurement a
 * crossing cannot inflate.
 *
 * "Another pass" is another chain, or the same chain far enough along to be
 * the stroke crossing itself; neighbouring samples are always within reach
 * and do not count. The reach is generous - half as much again as the two
 * half-widths - because edges merge well before centrelines meet.
 */
function capWidthsAtJunctions(sampled, step, upem, glyphs, chains) {
  const items = (sc, k) => chains[sampled.indexOf(sc)]?.items[sc.item[k]]?.type;
  const margin = 2 * step;
  const minGap = 0.12 * upem;
  let cell = margin;
  for (const sc of sampled) for (let k = 0; k < sc.n; k++) cell = Math.max(cell, sc.halfL[k], sc.halfR[k]);
  cell *= 3;
  const grid = new Map();
  sampled.forEach((sc, ci) => {
    for (let k = 0; k < sc.n; k++) {
      const key = `${Math.floor(sc.pts[k][0] / cell)},${Math.floor(sc.pts[k][1] / cell)}`;
      const b = grid.get(key);
      if (b) b.push(ci, k); else grid.set(key, [ci, k]);
    }
  });
  const onInk = (p) => {
    for (const g of glyphs) {
      const r = g.raster;
      if (!r) continue;
      const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) continue;
      if (inkInfo(r).dist[yi * r.width + xi] > 0) return true;
    }
    return false;
  };
  const pointed = glyphs.some((g) => g.record?.stats?.hand?.pointed);
  sampled.forEach((sc, ci) => {
    // which side of the path the other pass lies on, per sample
    const sides = [new Uint8Array(sc.n), new Uint8Array(sc.n)]; // [left, right]
    const junction = new Uint8Array(sc.n);
    for (let k = 0; k < sc.n; k++) {
      const [x, y] = sc.pts[k];
      const tx = sc.tan[2 * k], ty = sc.tan[2 * k + 1];
      const reach = Math.max(sc.halfL[k], sc.halfR[k]);
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const b = grid.get(`${gx},${gy}`);
          if (!b) continue;
          for (let i = 0; i < b.length; i += 2) {
            const cj = b[i], j = b[i + 1];
            const o = sampled[cj];
            if (cj === ci && Math.abs(o.s[j] - sc.s[k]) < minGap) continue;
            const dx = o.pts[j][0] - x, dy = o.pts[j][1] - y;
            const limit = 1.5 * (reach + Math.max(o.halfL[j], o.halfR[j])) + margin;
            if (dx * dx + dy * dy >= limit * limit) continue;
            junction[k] = 1;
            // a side faces the other pass only if this sample's reading on
            // that side runs across the other pass's centreline: the ink out
            // there is the other stroke's. The normal (-ty, tx) points left.
            const along = dx * tx + dy * ty, across = dx * -ty + dy * tx;
            if (Math.abs(along) > margin) continue;
            if (across >= 0 && across <= sc.halfL[k] + step) sides[0][k] = 1;
            if (across <= 0 && -across <= sc.halfR[k] + step) sides[1][k] = 1;
          }
        }
      }
    }
    // A stretch no sample of which faces the other pass is no junction: the
    // readings there never ran into other ink (the inside of a bowl sees its
    // far side within reach, seventy units away across empty counter). Left
    // flagged, a two-sample stretch on the `a`'s bowl was redrawn from its
    // edges and the centreline stepped sideways by a quarter of the width.
    for (let k = 0; k < sc.n; ) {
      if (!junction[k]) { k++; continue; }
      let e = k, faces = false;
      for (; e < sc.n && junction[e]; e++) if (sides[0][e] || sides[1][e]) faces = true;
      if (!faces) for (let i = k; i < e; i++) junction[i] = 0;
      k = e;
    }
    sc.junction = junction;
    // per sample, [left, right]: is there ink beyond the band's edge on that
    // side (so the band should stop short of it)? Outside a junction stretch
    // that is simply a reading that never reached background.
    const facing = new Uint8Array(2 * sc.n);
    for (let k = 0; k < 2 * sc.n; k++) facing[k] = sc.edge[k] ? 0 : 1;
    sc.facing = facing;
    const halves = [sc.halfL, sc.halfR];
    // what the pen brought into a stretch (dir -1 from just before it) or
    // took out of it (dir +1 from just after): the median half-width over a
    // short run of clean samples, and the mean tangent there
    const window = 0.08 * upem;
    const clean = (from, dir) => {
      const vals = [[], [], []];
      let tx = 0, ty = 0;
      for (let i = from; i >= 0 && i < sc.n && Math.abs(sc.s[i] - sc.s[from]) <= window; i += dir) {
        if (junction[i]) break;
        // a turn ends the run: past it the pen is on another stroke
        if (sc.tan[2 * i] * sc.tan[2 * from] + sc.tan[2 * i + 1] * sc.tan[2 * from + 1] < 0.5) break;
        vals[0].push(sc.halfL[i]);
        vals[1].push(sc.halfR[i]);
        vals[2].push(sc.R[i]);
        tx += sc.tan[2 * i]; ty += sc.tan[2 * i + 1];
      }
      // a run shorter than half the window (the tip of a hairpin) is no measure
      if (vals[0].length * step < window / 2) return null;
      const l = Math.hypot(tx, ty) || 1;
      const med = vals.map((v) => { v.sort((p, q) => p - q); return v[v.length >> 1]; });
      return { half: [med[0], med[1]], R: med[2], tan: [tx / l, ty / l] };
    };
    const hermite = (p0, t0, p1, t1, t) => {
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const h00 = (1 + 2 * t) * (1 - t) * (1 - t), h10 = t * (1 - t) * (1 - t);
      const h01 = t * t * (3 - 2 * t), h11 = t * t * (t - 1);
      return [
        h00 * p0[0] + h10 * L * t0[0] + h01 * p1[0] + h11 * L * t1[0],
        h00 * p0[1] + h10 * L * t0[1] + h01 * p1[1] + h11 * L * t1[1],
      ];
    };
    // the measurements as taken, before any stretch is rewritten
    const raw = [Float32Array.from(sc.halfL), Float32Array.from(sc.halfR)];
    sc.raw = raw; sc.sides = sides; // for inspection
    const win = Math.max(1, Math.round(window / step));
    const medianOf = (side, i, k, e, edgeOnly = false) => {
      const vals = [];
      for (let j = Math.max(k, i - win); j <= Math.min(e, i + win); j++) {
        if (edgeOnly && !sc.edge[2 * j + side]) continue;
        vals.push(raw[side][j]);
      }
      if (!vals.length) return null;
      vals.sort((p, q) => p - q);
      return vals[vals.length >> 1];
    };
    // a stretch is cut where the pen turns back on itself (the foot of a
    // retraced stem) or round a corner (the `J`'s bar into its stem): the
    // legs are different strokes, each with its own width and its own line
    const turn = Math.max(2, Math.round((0.04 * upem) / step));
    let k = 0;
    while (k < sc.n) {
      if (!junction[k]) { k++; continue; }
      let e = k;
      while (e + 1 < sc.n && junction[e + 1]) e++;
      const legs = [];
      let start = k, hairpin = false;
      for (let i = k + 1; i <= e; i++) {
        // a new plan item (a bridge, or the stroke it lands on) is a new leg
        // with nothing carried over: the letter's entry has its own width
        if (sc.item[i] !== sc.item[i - 1]) { legs.push([start, i - 1, hairpin]); start = i; hairpin = true; continue; }
        if (i < k + turn || i - turn < start) continue;
        const dot = sc.tan[2 * i] * sc.tan[2 * (i - turn)] + sc.tan[2 * i + 1] * sc.tan[2 * (i - turn) + 1];
        if (dot >= 0.5) continue;
        const cut = i - (turn >> 1);
        if (cut > start) { legs.push([start, cut - 1, hairpin]); start = cut; hairpin = dot < -0.5; i = cut + turn; }
      }
      legs.push([start, e, hairpin]);
      let carriedR = null, carriedHalf = null;
      // the direction a leg runs in, end to end: past a corner inside the
      // stretch the sample's own tangent is mid-turn (the `a`'s stem, cut
      // just under the apex, read a tangent 60 degrees off the stem and the
      // Hermite through it bowed the whole stem fifteen units sideways)
      const chordOf = (i, j) => {
        const dx = sc.pts[j][0] - sc.pts[i][0], dy = sc.pts[j][1] - sc.pts[i][1];
        const l = Math.hypot(dx, dy) || 1;
        return [dx / l, dy / l];
      };
      if (globalThis.__legTrace) (globalThis.__legLog ||= []).push(['legs', ci, k, e, JSON.stringify(legs)].join(' '));
      for (const [a, b, afterHairpin] of legs) {
        // what the leg brings in: the clean run before the stretch, or, past
        // a corner (not a hairpin: there the pen is on another stroke), the
        // width the previous leg ended with - a hairline that bends stays a
        // hairline
        const after = b === e && e + 1 < sc.n ? clean(e + 1, 1) : null;
        // Past a corner the leg keeps the width its stroke brought into the
        // stretch, not the halves the previous leg ended with: those are
        // readings of the union where the legs merge, floored by a nib
        // radius read in the same union (the `a`'s stem, starting under the
        // apex, came in 55 wide for a stroke of 33). Where nothing was
        // brought in (the previous leg was a hairpin's, on another stroke),
        // the width the pen takes out is the stroke's: eight pixels coming
        // out, eight all the way through.
        const before = a === k ? (k > 0 ? clean(k - 1, -1) : null)
          : afterHairpin ? null
            : { half: carriedHalf || after?.half || [sc.halfL[a - 1], sc.halfR[a - 1]], R: carriedR, tan: chordOf(a - 1, Math.min(b + 1, sc.n - 1)) };
        // the nib radius where this stroke came in, carried through its corners
        if (before) { carriedR = before.R; carriedHalf = before.half; } else carriedHalf = null;
        const s0 = sc.s[a > 0 ? a - 1 : a], s1 = sc.s[b + 1 < sc.n ? b + 1 : b];
        const short = before && after && sc.s[b] - sc.s[a] <= JUNCTION_MAX_EM * upem;
        // Through a crossing each EDGE of the stroke continues as a line
        // from where it was last clean to where it is clean again (a Hermite
        // curve with the pen's tangents there): the user's rule, taken
        // literally - eight pixels wide going in and coming out, eight all
        // the way through, and on the same line. The centreline and widths
        // are then read off the two edges. Only if both edges stay on ink;
        // a pointed pen's hairline inside a shade is handled below instead.
        let edged = false;
        if (short) {
          const edgeAt = (i, side) => {
            const nx = -sc.tan[2 * i + 1], ny = sc.tan[2 * i];
            const h = side === 0 ? sc.halfL[i] : -sc.halfR[i];
            return [sc.pts[i][0] + nx * h, sc.pts[i][1] + ny * h];
          };
          const thinIn = pointed && before.half[0] + before.half[1] < THIN_IN_THICK * 2 * sc.R[a];
          if (!thinIn) {
            const L0 = edgeAt(a - 1, 0), L1 = edgeAt(b + 1, 0), R0 = edgeAt(a - 1, 1), R1 = edgeAt(b + 1, 1);
            const P0 = sc.pts[a - 1], P1 = sc.pts[b + 1];
            const fresh = [];
            for (let i = a; i <= b; i++) {
              const t = (sc.s[i] - s0) / (s1 - s0);
              // the centreline is the path's own Hermite, so it meets the
              // path at both ends: the edges' midpoint sat off the path by
              // half the difference of the halves wherever the path runs
              // off the stroke's axis (a skeleton hugging a bowl's inner
              // edge), a step at each end of every stretch
              const mid = hermite(P0, before.tan, P1, after.tan, t);
              if (!onInk(mid)) break;
              fresh.push({ mid, l: hermite(L0, before.tan, L1, after.tan, t), r: hermite(R0, before.tan, R1, after.tan, t) });
            }
            if (fresh.length === b - a + 1) {
              edged = true;
              if (globalThis.__legTrace) (globalThis.__legLog ||= []).push(['edged', ci, a, b, 'before', JSON.stringify(before), 'after', JSON.stringify(after)].join(' '));
              for (let i = a; i <= b; i++) sc.pts[i] = fresh[i - a].mid;
              for (let i = Math.max(1, a - 1); i <= Math.min(sc.n - 2, b + 1); i++) {
                const q0 = sc.pts[i - 1], q1 = sc.pts[i + 1];
                const dx = q1[0] - q0[0], dy = q1[1] - q0[1];
                const l = Math.hypot(dx, dy) || 1;
                sc.tan[2 * i] = dx / l;
                sc.tan[2 * i + 1] = dy / l;
              }
              // each half is the edge's distance from the new centreline
              for (let i = a; i <= b; i++) {
                const f = fresh[i - a], nx = -sc.tan[2 * i + 1], ny = sc.tan[2 * i];
                sc.halfL[i] = Math.max(0.5 * step, (f.l[0] - f.mid[0]) * nx + (f.l[1] - f.mid[1]) * ny);
                sc.halfR[i] = Math.max(0.5 * step, (f.mid[0] - f.r[0]) * nx + (f.mid[1] - f.r[1]) * ny);
                facing[2 * i] = facing[2 * i + 1] = 1;
              }
            }
          }
        }
        if (short && !edged) {
          const p0 = sc.pts[a - 1], p1 = sc.pts[b + 1];
          const fresh = [];
          for (let i = a; i <= b; i++) {
            const p = hermite(p0, before.tan, p1, after.tan, (sc.s[i] - s0) / (s1 - s0));
            if (!onInk(p)) break;
            fresh.push(p);
          }
          if (fresh.length === b - a + 1) {
            if (globalThis.__legTrace) (globalThis.__legLog ||= []).push(['midline', ci, a, b].join(' '));
            for (let i = a; i <= b; i++) sc.pts[i] = fresh[i - a];
            for (let i = Math.max(1, a - 1); i <= Math.min(sc.n - 2, b + 1); i++) {
              const q0 = sc.pts[i - 1], q1 = sc.pts[i + 1];
              const dx = q1[0] - q0[0], dy = q1[1] - q0[1];
              const l = Math.hypot(dx, dy) || 1;
              sc.tan[2 * i] = dx / l;
              sc.tan[2 * i + 1] = dy / l;
            }
          }
        }
        if (edged) continue;
        halves.forEach((half, side) => {
          for (let i = a; i <= b; i++) {
            const w0 = before?.half[side], w1 = after?.half[side];
            const other = sides[side][i], atEdge = sc.edge[2 * i + side], read = raw[side][i];
            // how far this sample is from the leg's clean approach / departure
            const dIn = before ? sc.s[i] - sc.s[a] : Infinity, dOut = after ? sc.s[b] - sc.s[i] : Infinity;
            const near = short || Math.min(dIn, dOut) <= JUNCTION_NEAR_EM * upem;
            // through a crossing: the width brought in, running to the width
            // taken out; just inside a long stretch: the clean edge continued
            // as a straight line (the bar of a `J` keeps its edge where it
            // passes over the stem, whatever its centreline does there)
            let own = null;
            if (short) own = w0 + (w1 - w0) * ((sc.s[i] - s0) / (s1 - s0 || 1));
            else if (near) {
              const fromStart = dIn <= dOut;
              const ref = fromStart ? before : after;
              own = ref.half[side];
              if (Math.min(dIn, dOut) <= JUNCTION_EDGE_EM * upem) {
                // close to the clean run its edge is continued as a straight
                // line (further out the run may be curving away)
                const j = fromStart ? a - 1 : b + 1;
                const nx = -ref.tan[1], ny = ref.tan[0]; // left normal of the clean run
                const h = (side === 0 ? ref.half[0] : -ref.half[1]) - EDGE_BIAS_PX * step * (side === 0 ? 1 : -1);
                const ex = sc.pts[j][0] + nx * h, ey = sc.pts[j][1] + ny * h;
                const d = ((ex - sc.pts[i][0]) * nx + (ey - sc.pts[i][1]) * ny) * (side === 0 ? 1 : -1);
                own = Math.max(0.5 * step, d) + EDGE_BIAS_PX * step; // the bias is taken off again below
              }
            }
            let v;
            if (pointed && w0 !== undefined && before.R && sc.R[i] > THIN_IN_THICK * before.R && sc.tan[2 * i + 1] > -0.3) {
              // a pointed pen's upstroke, come in where the ink was much thinner
              // than it is here: a hairline running inside a shade keeps its width -
              // the ink around it is the shade's, drawn on its own pass. It
              // stays thin through the turn at the top, however far that is;
              // the shade begins as the pen heads down and presses. Never past
              // a valley, though: between two cores the valley is this
              // hairline's own edge, and it may be thinner than it came in
              // (the `e`'s eye is a finer hairline than the entry it grows from)
              v = Math.min(w0, read);
            } else if (short || near) {
              // through a crossing, or just inside a long stretch, the pen
              // keeps the width it brought (the readings there are of the
              // union; even one that reaches background may have got there
              // through the other stroke's ink, in the hollow where the two
              // outlines meet), or its own free edge if that reads wider. The
              // nib's radius is a floor only for a stroke that is at least
              // that wide on its free side - a pointed pen's shade swelling to
              // its full width inside the join - because the radius itself
              // reads the union near a crossing (the `J`'s bar is 8.5 px
              // where it crosses the stem and the radius says 9: a tab)
              const freeRead = sc.edge[2 * i + (1 - side)] ? raw[1 - side][i] : 0;
              const floor = freeRead >= sc.R[i] ? sc.R[i] : 0;
              // a reading runs to the centre of the first background pixel,
              // a quarter pixel past the edge on average: on a side facing
              // another stroke that quarter is the other stroke's
              v = Math.max(floor, other || !atEdge ? own - EDGE_BIAS_PX * step : Math.max(read, own));
            } else if (other || !atEdge) {
              // deep in a retrace or a merge, with nothing clean to hold to: the
              // reading, smoothed, and never less than the nib's own radius -
              // except at a letter's entry from a bridge, where the radius is
              // the merged ink's (an `e`'s entry runs along its own eye) and
              // the readings that do reach background are the stroke's width
              const entry = a > 0 && sc.item[a] !== sc.item[a - 1] && items(sc, a) === 'stroke';
              v = entry ? (medianOf(side, i, a, b, true) ?? medianOf(side, i, a, b)) : Math.max(sc.R[i], medianOf(side, i, a, b));
            } else {
              v = read; // this stroke's own edge, however wide
            }
            // never past a reading that reached background: whatever lifted
            // the width above it (the nib's radius, the width brought in) is
            // an estimate, the background is a fact. The readings that reach
            // it are taken together over the window, not one by one: along a
            // shallow crossing a reading finds background through the hollow
            // at one sample and not the next, and sample by sample that cut
            // a serrated edge into the first stroke of Pinyon's `x`
            const bg = atEdge ? medianOf(side, i, a, b, true) : null;
            half[i] = bg !== null ? Math.min(v, bg) : v;
            // in a junction the band stops half a pixel inside its width on
            // both sides instead of reaching a pixel past it: what lies past
            // it may be the other stroke, even past a reading that found
            // background (a one-pixel hollow where two outlines meet). Pixels
            // on a real free edge are still claimed, by the band itself.
            facing[2 * i + side] = 1;
          }
        });
      }
      k = e + 1;
    }
  });
}

/**
 * A bridge's samples lie on no ink of their own: their width runs linearly
 * from the last cross-section of the stroke the pen leaves to the first of
 * the stroke it lands on, so the join is one taper and not three pieces.
 */
function joinWidths(sampled, chains) {
  sampled.forEach((sc, ci) => {
    const items = chains[ci].items;
    let k = 0;
    while (k < sc.n) {
      if (items[sc.item[k]].type !== 'bridge') { k++; continue; }
      let e = k;
      while (e + 1 < sc.n && sc.item[e + 1] === sc.item[k]) e++;
      const a0 = k > 0 ? k - 1 : k, b0 = e + 1 < sc.n ? e + 1 : e;
      const s0 = sc.s[a0], s1 = sc.s[b0];
      for (let i = k; i <= e; i++) {
        const t = s1 > s0 ? (sc.s[i] - s0) / (s1 - s0) : 0;
        sc.halfL[i] = sc.halfL[a0] + (sc.halfL[b0] - sc.halfL[a0]) * t;
        sc.halfR[i] = sc.halfR[a0] + (sc.halfR[b0] - sc.halfR[a0]) * t;
        sc.facing[2 * i] = sc.facing[2 * i + 1] = 0;
      }
      k = e + 1;
    }
  });
}

/**
 * Clip a width profile so it never grows faster than `slew` per unit of arc,
 * from either direction. Only ever reduces: a spike is cut down to what its
 * neighbours can reach, a slope is left alone.
 */
function slewLimit(half, s, slew) {
  const n = half.length;
  for (let k = 1; k < n; k++) {
    const ds = Math.abs(s[k] - s[k - 1]);
    half[k] = Math.min(half[k], half[k - 1] + slew * ds);
  }
  for (let k = n - 2; k >= 0; k--) {
    const ds = Math.abs(s[k + 1] - s[k]);
    half[k] = Math.min(half[k], half[k + 1] + slew * ds);
  }
}

/**
 * How far the ink reaches from `p` along the unit direction (dx, dy), in font
 * units, stopping at the ink's edge, at `cap`, or in the valley between this
 * stroke and one crossing it.
 *
 * The valley is what keeps the measurement honest where two strokes overlap:
 * marching out of one stroke's core into a crossing, the distance to the
 * outline falls to a minimum between the two cores and rises again toward the
 * other one. Stopping at that minimum takes the stroke's own half-width and
 * leaves the rest of the union to the pass it belongs to. Where there is no
 * crossing there is no minimum, and the march simply runs to the edge.
 * `hit.edge`, if a holder is given, says whether it did: a reading that ended
 * at background is this stroke's own edge; one cut short by a valley or the
 * cap is a guess made inside other ink.
 */
function reachAcross(glyphs, p, dx, dy, cap, R, hit) {
  let raster = null, best = -1;
  if (hit) hit.edge = false;
  for (const g of glyphs) {
    const r = g.raster;
    if (!r) continue;
    const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) continue;
    const d = inkInfo(r).dist[yi * r.width + xi];
    if (d > best) { best = d; raster = { r, x, y }; }
  }
  if (!raster || best <= 0) return R;
  const { r, x, y } = raster;
  const info = inkInfo(r);
  const stepPx = 0.5;
  // raster y grows downward, font y upward
  const ux = dx * stepPx, uy = -dy * stepPx;
  let prev = best, rising = false;
  const capPx = cap * r.scale;
  for (let t = stepPx; t <= capPx; t += stepPx) {
    const xi = Math.round(x + ux * (t / stepPx)), yi = Math.round(y + uy * (t / stepPx));
    if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) { if (hit) hit.edge = true; return t / r.scale; }
    if (!r.fill[yi * r.width + xi]) { if (hit) hit.edge = true; return t / r.scale; }
    const d = info.dist[yi * r.width + xi];
    // a valley: the distance fell away from this core and has started to climb
    // toward another. Half a pixel of noise is not a valley.
    if (d > prev + 0.5) rising = true;
    else if (rising && d < prev - 0.5) rising = false;
    if (rising && prev < best * 0.75) return (t - stepPx) / r.scale;
    prev = d;
  }
  return cap;
}

/**
 * The ink's half-width along the path, smoothed by taking a low percentile of
 * a window either side.
 *
 * Where strokes cross, the distance map balloons to the half-width of the
 * union, and a nib that followed it would sweep a piece of a stroke still to
 * come. The minimum of the window is immune to that, but it also drags the
 * nib down to the thinnest ink within a whole 0.08 em - and a pointed pen's
 * shade swells and tapers over about that distance, so the minimum leaves the
 * shade systematically narrower than the ink it is writing. The ink it misses
 * then belongs to whichever pass is nearest, which at a crossing is the one
 * still to come: the stroke was written with pieces broken out of it, filled
 * in a moment later when the crossing arrived.
 *
 * A high percentile sits between. A crossing inflates only the samples inside
 * it - a minority of a 0.16 em window - so the 75th percentile passes over
 * them and lands on the largest uninflated half-width, which is the stroke's
 * own. Only where a crossing is so shallow that it fills more than a quarter
 * of the window does the nib start to follow the union again.
 */
function runningPercentile(a, W, q) {
  const n = a.length;
  const out = new Float32Array(n);
  const buf = new Float32Array(2 * W + 1);
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - W), hi = Math.min(n - 1, k + W);
    let m = 0;
    for (let j = lo; j <= hi; j++) buf[m++] = a[j];
    const win = buf.subarray(0, m).slice().sort();
    out[k] = win[Math.min(m - 1, Math.floor(q * m))];
  }
  return out;
}

/** Ink plus a thin ring of background around it, so the map covers the outline's edge. */
function dilate(fill, w, h, rad) {
  const out = new Uint8Array(fill);
  const r2 = rad * rad;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (fill[i]) continue;
      let hit = false;
      for (let dy = -rad; dy <= rad && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || dx * dx + dy * dy > r2) continue;
          if (fill[ny * w + nx]) { hit = true; break; }
        }
      }
      if (hit) out[i] = 1;
    }
  }
  return out;
}

/** The domain pixel nearest a sample, within a couple of pixels; -1 if none. */
function seedPixel(dom, w, h, xi, yi) {
  for (let rad = 0; rad <= 2; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        const x = xi + dx, y = yi + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (dom[y * w + x]) return y * w + x;
      }
    }
  }
  return -1;
}

function buildGlyphMap(g, gi, chains, sampled, upem) {
  const r = g.raster;
  const { width: w, height: h, fill } = r;
  const N = w * h;
  const dist = inkInfo(r).dist;
  const dom = dilate(fill, w, h, EDGE_RING_PX);
  const chain = new Int16Array(N).fill(-1);
  const sArc = new Float32Array(N);
  // the pen's own centreline: the pixel under each sample, with its pass and arc
  const centreChain = new Int16Array(N).fill(-1);
  const centreS = new Float32Array(N);
  // provenance, for inspection: 1 band, 2 disk, 4 nearest path, 5 wedge
  const prov = new Uint8Array(N);
  const claimS = new Float32Array(N); // the arc of the sample whose band or disk claimed it
  // how much of the pixel its owner's band covers (255 = whole), and the
  // later pass whose band covers it whole, which completes it
  const cover = new Uint8Array(N).fill(255);
  const chain2 = new Int16Array(N).fill(-1);
  const s2 = new Float32Array(N);
  const stamp = new Int32Array(N);
  const queue = new Int32Array(N);
  const used = new Set();
  let serial = 0;

  /**
   * Grow the nib's disk from (x, y) through the domain and claim pixels.
   * mode 'stroke': claims unclaimed and hidden pixels; 'bridge': unclaimed
   * only (a bridge never shows a join's untravelled ink); 'hide': marks
   * pixels hidden - unclaimed ones, and ones its own chain claimed (the
   * stroke's last nib disk reaching past the cut). With a `plane`, only
   * pixels on its far side are claimed or hidden (the rest are still
   * traversed): a hide stops at the cut, so the letter's real ink up to it
   * is untouched; a bridge claims this letter's ink only beyond its cut, or
   * only ahead of its entry, so a blunt entry end and whatever crosses it
   * wait for the letter's own passes.
   */
  /**
   * Claim the ink under one sample: the band the stroke's own cross-section
   * covers there, half a sample-spacing along the path either way. Like the
   * disc below it spreads through the ink only, so it cannot reach across a
   * counter, and the first pass to touch a pixel keeps it.
   *
   * Each pixel takes the arc length of its own place along the band, not the
   * sample's - a band is a rectangle, and giving the whole of it one arc made
   * the reveal front a staircase of square steps instead of a line drawn
   * across the stroke. It shows wherever the band is wide.
   *
   * The fill travels through any ink within reach but claims only what falls
   * inside the band. Letting it walk only where it may claim looks equivalent
   * and is not: the band is a straight rectangle laid on a curving stroke, so
   * ink at the outer edge of a bend is often reachable only by stepping
   * outside the rectangle and back in. Every band skipped those pixels, and
   * the next pass over that ink - the retrace of an `o`'s right side, hundreds
   * of units of arc later - collected them, which is what broke the stroke
   * into a comb of fragments as it was revealed.
   */
  // the pixel one step from (px, py) in a direction, clamped to the raster
  const idx = (fx, fy) => {
    const qx = Math.min(w - 1, Math.max(0, Math.round(fx))), qy = Math.min(h - 1, Math.max(0, Math.round(fy)));
    return qy * w + qx;
  };
  const band = (x, y, tx, ty, hl, hr, along, mode, ci, sk, plane, faceL = 0, faceR = 0) => {
    const reach = Math.max(hl, hr, along) + 2;
    if (x < -reach || y < -reach || x > w - 1 + reach || y > h - 1 + reach) return;
    const seed = seedPixel(dom, w, h, Math.round(x), Math.round(y));
    if (seed < 0) return;
    serial++;
    let head = 0, tail = 0;
    queue[tail++] = seed;
    stamp[seed] = serial;
    while (head < tail) {
      const i = queue[head++];
      const c = chain[i];
      const px = i % w, py = (i - px) / w;
      const beyond = !plane || (px - plane.x) * plane.dx + (py - plane.y) * plane.dy >= 0;
      const alongHere = (px - x) * tx + (py - y) * ty;
      const acrossI = (px - x) * -ty + (py - y) * tx;
      // inside the band itself? (the fill travels wider than it claims)
      // inside the band itself? On a side that faces another pass the band
      // stops short of its measured half-width - unless the pixel is on the
      // ink's own edge, with background beyond it, which is this stroke's and
      // nobody else's (the outline clips whatever is claimed past it)
      // On a side that faces another pass the band's edge is the width
      // itself, not the nib's slack past it, and a pixel straddling that
      // edge is claimed with the fraction of it the band covers (`cov`) -
      // the reveal draws it that much until the pass beyond completes it.
      // A pixel on the ink's own edge, with background beyond, is claimed
      // whole to the full reach: it is this stroke's and nobody else's (the
      // outline clips whatever is claimed past it).
      let inBand = Math.abs(alongHere) <= along;
      let cov = 255;
      if (inBand) {
        const left = acrossI >= 0;
        const a = left ? acrossI : -acrossI, h = left ? hl : hr, face = left ? faceL : faceR;
        if (!face) inBand = a <= h;
        else if (a <= h && !fill[left ? idx(px - ty, py + tx) : idx(px + ty, py - tx)]) inBand = true;
        else {
          const part = h - NIB_SLACK_PX - a + 0.5; // 1 fully inside the edge, 0 fully outside
          inBand = part > 0.02;
          if (part < 1) cov = Math.round(part * 255);
        }
      }
      if (!inBand) { /* travelled through, not claimed */ }
      else if (mode === 'hide') {
        if (beyond && (c === -1 || c === ci)) chain[i] = HIDDEN;
      } else if (beyond && (c === -1 || (c === HIDDEN && mode === 'stroke'))) {
        chain[i] = ci;
        sArc[i] = sk + alongHere / r.scale;
        prov[i] = 1; claimS[i] = sk;
        cover[i] = cov;
        used.add(ci);
      } else if (beyond && c >= 0 && cov === 255 && chain2[i] === -1 && (c !== ci || sk - claimS[i] > PASS_GAP_EM * upem)) {
        // a later pass covering the pixel whole: it completes whatever
        // fraction the first owner showed of it
        chain2[i] = ci;
        s2[i] = sk + alongHere / r.scale;
      }
      const acrossHere = Math.abs((px - x) * -ty + (py - y) * tx);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (stamp[j] === serial || !dom[j]) continue;
          const ex = nx - x, ey = ny - y;
          if (ex * ex + ey * ey > reach * reach) continue; // out of the band's neighbourhood
          const across = ex * -ty + ey * tx;
          // The valley: moving away from the path, the distance to the outline
          // falls while we are still in this stroke and climbs once we start up
          // the flank of one crossing it - so a step that goes both outward and
          // uphill leaves this stroke, and the ink beyond belongs to whichever
          // pass owns that core. Travel stops there; it is not just unclaimed.
          if (Math.abs(across) > acrossHere && dist[j] > dist[i] + 0.5) continue;
          stamp[j] = serial;
          queue[tail++] = j;
        }
      }
    }
  };

  const disk = (x, y, Rpx, mode, ci, sk, plane) => {
    if (x < -Rpx || y < -Rpx || x > w - 1 + Rpx || y > h - 1 + Rpx) return;
    const seed = seedPixel(dom, w, h, Math.round(x), Math.round(y));
    if (seed < 0) return;
    serial++;
    let head = 0, tail = 0;
    queue[tail++] = seed;
    stamp[seed] = serial;
    const R2 = Rpx * Rpx;
    while (head < tail) {
      const i = queue[head++];
      const c = chain[i];
      const px = i % w, py = (i - px) / w;
      const beyond = !plane || (px - plane.x) * plane.dx + (py - plane.y) * plane.dy >= 0;
      if (mode === 'hide') {
        if (beyond && (c === -1 || c === ci)) chain[i] = HIDDEN;
      } else if (beyond && (c === -1 || (c === HIDDEN && mode === 'stroke'))) {
        chain[i] = ci;
        sArc[i] = sk;
        prov[i] = 2; claimS[i] = sk;
        cover[i] = 255;
        used.add(ci);
      } else if (beyond && c >= 0 && chain2[i] === -1 && (c !== ci || sk - claimS[i] > PASS_GAP_EM * upem)) {
        chain2[i] = ci;
        s2[i] = sk;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (stamp[j] === serial || !dom[j]) continue;
          const ex = nx - x, ey = ny - y;
          if (ex * ex + ey * ey > R2) continue;
          stamp[j] = serial;
          queue[tail++] = j;
        }
      }
    }
  };

  // An untravelled hairline (raster px), from its cut point outward. The
  // stroke's own pass reclaims whatever its nib covers around the cut, so
  // the visible ink ends in the nib's round shape, never a corner; beyond
  // the hairline's last point the sweep runs on a little, to take the tip
  // (or a blunt end's corners) with it.
  const at = (p) => {
    const xi = Math.round(p[0]), yi = Math.round(p[1]);
    return xi < 0 || yi < 0 || xi >= w || yi >= h ? 0 : dist[yi * w + xi];
  };
  // `before` is the stroke point just inside the cut: it gives the direction
  // when the untravelled end is a single point (a blunt end with no hairline)
  const extend = (path, before) => {
    if (!path.length) return path;
    const b = path[path.length - 1];
    const a = path.length >= 2 ? path[path.length - 2] : before;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ext = at(path[0]) * 2 + 3;
    return path.concat([[b[0] + ((b[0] - a[0]) / len) * ext, b[1] + ((b[1] - a[1]) / len) * ext]]);
  };
  const hideTube = (path, ci) => {
    if (path.length < 2) return;
    const d0 = Math.hypot(path[1][0] - path[0][0], path[1][1] - path[0][1]) || 1;
    const plane = { x: path[0][0], y: path[0][1], dx: (path[1][0] - path[0][0]) / d0, dy: (path[1][1] - path[0][1]) / d0 };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let u = 0; u <= len; u += 1) {
        const t = len > 0 ? u / len : 0;
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        // generous: a hairline's centreline sits a pixel or two off its middle
        disk(x, y, at([x, y]) + NIB_SLACK_PX + 3, 'hide', ci, 0, plane);
      }
    }
  };
  // The untravelled hairlines of a stroke at a join, as raster-px paths from
  // the cut outward: the tail beyond the exit cut, and a trimmed head before
  // the entry point. A blunt entry (nothing trimmed) is not hidden: the
  // ribbon arrives at the letter's full width and covers its end face. A
  // stroke entered mid-way has no head either: the pen writes back over it.
  const strokes = g.rasterStrokes || [];
  const exitPath = (it) => {
    const s = strokes[it.strokeIndex];
    return extend(s.slice(it.tailCut), s[Math.max(0, it.tailCut - 1)]);
  };
  const entryPath = (it) => {
    if (it.entry || !(it.headCut > 0)) return [];
    const s = strokes[it.strokeIndex];
    return extend(s.slice(0, it.headCut + 1).reverse(), s[Math.min(s.length - 1, it.headCut + 1)]);
  };
  const inGlyph = (it) => it.type === 'stroke' && it.glyphIndex === gi && strokes[it.strokeIndex];
  const hasTail = (it) => inGlyph(it) && it.tailCut < strokes[it.strokeIndex].length - 1;
  const hasHead = (it) => inGlyph(it) && !it.entry && it.headCut > 0;

  // A bridge's claims in this raster stop at a plane: beyond the cut when
  // this is the letter it leaves, ahead of the entry when this is the letter
  // it enters (undefined: not this letter's bridge at all).
  const planeAt = (p, d) => {
    const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
    const dx = d[0] * r.scale, dy = -d[1] * r.scale;
    const l = Math.hypot(dx, dy) || 1;
    return { x, y, dx: dx / l, dy: dy / l };
  };
  const bridgePlane = (it) => {
    const pts = it.points;
    if (!pts || pts.length < 2) return undefined;
    const m = pts.length - 1;
    if (it.from.glyphIndex === gi) return planeAt(pts[0], [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]]);
    if (it.to.glyphIndex === gi) return planeAt(pts[m], [pts[m][0] - pts[m - 1][0], pts[m][1] - pts[m - 1][1]]);
    return undefined;
  };

  // pass 1: the nib's disk, in pen order; first touch wins. A stroke claims
  // only in its own glyph (overriding hidden ink there: a later pass crossing
  // a join). When the pen leaves a stroke for a bridge, the stroke's
  // untravelled tail and the next stroke's trimmed head are hidden before
  // the bridge's samples run.
  for (let ci = 0; ci < sampled.length; ci++) {
    const sc = sampled[ci];
    const items = chains[ci].items;
    const planes = items.map((it) => (it.type === 'bridge' ? bridgePlane(it) : null));
    let cur = -1;
    for (let k = 0; k < sc.n; k++) {
      const ii = sc.item[k];
      if (ii !== cur) {
        if (items[ii].type === 'bridge') {
          if (cur >= 0 && hasTail(items[cur])) hideTube(exitPath(items[cur]), ci);
          const next = items[ii + 1];
          if (next && hasHead(next)) hideTube(entryPath(next), ci);
        }
        cur = ii;
      }
      const it = items[ii];
      let mode, plane = null;
      if (it.type === 'stroke') {
        if (it.glyphIndex !== gi) continue;
        mode = 'stroke';
      } else {
        plane = planes[ii];
        if (plane === undefined) continue;
        mode = 'bridge';
      }
      const p = sc.pts[k];
      const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
      // the sample's own pixel: where pass 2 measures from
      const cx0 = Math.round(x), cy0 = Math.round(y);
      if (cx0 >= 0 && cy0 >= 0 && cx0 < w && cy0 < h && dom[cy0 * w + cx0] && centreChain[cy0 * w + cx0] < 0) {
        centreChain[cy0 * w + cx0] = ci;
        centreS[cy0 * w + cx0] = sc.s[k];
      }
      // the ends of a chain keep the nib's round tip; between them the band
      // of ink the stroke's own cross-section covers
      if (k === 0 || k === sc.n - 1) {
        disk(x, y, sc.R[k] * r.scale + NIB_SLACK_PX, mode, ci, sc.s[k], plane);
      } else {
        // raster y grows downward, so the tangent's y flips with it
        const tx = sc.tan[2 * k], ty = -sc.tan[2 * k + 1];
        // half the sample spacing either way, so consecutive bands tile
        const spacing = (sc.s[1] - sc.s[0]) * r.scale;
        band(x, y, tx, ty, sc.halfL[k] * r.scale + NIB_SLACK_PX, sc.halfR[k] * r.scale + NIB_SLACK_PX,
          spacing * 0.75 + 1, mode, ci, sc.s[k], plane, sc.facing[2 * k], sc.facing[2 * k + 1]);
      }
    }
  }

  // remember what the nibs themselves claimed, before anything spreads
  const nibChain = Int16Array.from(chain);
  const nibS = Float32Array.from(sArc);
  const corners = [];
  for (let i = 0; i < N; i++) if (fill[i] && chain[i] === -1) corners.push(i);

  // pass 2: everything else joins the nearest claimed pixel, a little later.
  // Hidden ink first hands itself to the background fringe around it (so the
  // outline's anti-aliased rim over a hidden tail stays hidden too), but never
  // to ink: ink the nib missed always follows a visible neighbour.
  const INF = 0x3fffffff;
  const unitPerPx = 1 / r.scale;
  const propagate = (isSeed, mayEnter, maxD, crossHidden) => {
    const dd = new Int32Array(N).fill(INF);
    // the visible pass a wave carries, even while crossing hidden pixels
    const src = new Int16Array(N).fill(-1);
    const srcS = new Float32Array(N);
    const buckets = [];
    const push = (d, i) => { (buckets[d] || (buckets[d] = [])).push(i); };
    for (let i = 0; i < N; i++) if (isSeed(i)) { dd[i] = 0; src[i] = chain[i]; srcS[i] = sArc[i]; push(0, i); }
    for (let d = 0; d < buckets.length && d <= maxD; d++) {
      const b = buckets[d];
      if (!b) continue;
      for (const i of b) {
        if (dd[i] !== d) continue;
        const px = i % w, py = (i - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (!dom[j]) continue;
            const nd = d + (dx && dy ? 4 : 3);
            if (nd >= dd[j]) continue;
            const free = chain[j] === -1 || dd[j] < INF;
            if (free && !mayEnter(j)) continue;
            if (!free && !(crossHidden && chain[j] === HIDDEN)) continue;
            dd[j] = nd;
            if (free) {
              chain[j] = src[i] >= 0 ? src[i] : chain[i];
              sArc[j] = srcS[i] + ((dx && dy ? 4 : 3) / 3) * unitPerPx;
              src[j] = chain[j];
              srcS[j] = sArc[j];
            } else {
              src[j] = src[i];
              srcS[j] = srcS[i] + ((dx && dy ? 4 : 3) / 3) * unitPerPx;
            }
            push(nd, j);
          }
        }
      }
    }
  };
  propagate((i) => chain[i] === HIDDEN, (j) => !fill[j], 3 * EDGE_RING_PX + 1, false);

  // Ink no nib reached joins the band it touches, at that band's arc plus
  // the distance. v0.19.0 measured from the centrelines instead, because a
  // band then could run into the stroke beside it and a leftover next to
  // that inflated claim joined the wrong stroke; with the bands held to
  // their own widths that is no longer so, and measuring from the
  // centrelines has the opposite fault: a hairline running inside a shade
  // is the nearest centreline to much of the shade, so specks of the shade
  // appeared beside the hairline as it was drawn. A pixel already claimed
  // is passed through and keeps its pass and arc.
  {
    const dd = new Int32Array(N).fill(INF);
    const src = new Int16Array(N).fill(-1);
    const srcS = new Float32Array(N);
    const buckets = [];
    const push = (d, i) => { (buckets[d] || (buckets[d] = [])).push(i); };
    for (let i = 0; i < N; i++) if (nibChain[i] >= 0) { dd[i] = 0; src[i] = nibChain[i]; srcS[i] = nibS[i]; push(0, i); }
    for (let d = 0; d < buckets.length; d++) {
      const b = buckets[d];
      if (!b) continue;
      for (const i of b) {
        if (dd[i] !== d) continue;
        const px = i % w, py = (i - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (!dom[j]) continue;
            const nd = d + (dx && dy ? 4 : 3);
            if (nd >= dd[j]) continue;
            dd[j] = nd;
            src[j] = src[i];
            srcS[j] = srcS[i] + ((dx && dy ? 4 : 3) / 3) * unitPerPx;
            if (chain[j] === -1) { chain[j] = src[j]; sArc[j] = srcS[j]; prov[j] = 4; }
            push(nd, j);
          }
        }
      }
    }
  }

  // pass 3: where two passes cross, the ink in the wedges between them
  // belongs to neither nib's tube. It exists only because both strokes are
  // there, so it appears with the later one - not as a knot on the first
  // stroke through the crossing, foreshadowing the one still to come.
  //
  // Any corner pixel with a later pass within reach is deferred to it. When
  // the band was the nib's inscribed disk, ink beside it was still the
  // stroke's own (a wide shade covers more than its nib radius) and deferring
  // it punched holes into a stroke as it was written; the band now claims
  // the measured cross-section, so what is left beside it is the union's -
  // the fillet where two outlines meet - and a pen leaves that with the
  // second stroke. Splitting it by nearest band instead drew the fillet as
  // a serrated edge on the first stroke of a shallow crossing (Pinyon's `x`).
  const CR = 8, CR2 = CR * CR;
  const WEDGE_SLACK_PX = CR;
  const timeOf = (c, s) => c * 1e7 + s;
  const passGap = PASS_GAP_EM * upem;
  for (const i of corners) {
    if (chain[i] < 0) continue;
    const px = i % w, py = (i - px) / w;
    let lateT = -Infinity, lateJ = -1, lateD2 = 0, nearD2 = Infinity;
    for (let dy = -CR; dy <= CR; dy++) {
      const ny = py + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -CR; dx <= CR; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > CR2) continue;
        const nx = px + dx;
        if (nx < 0 || nx >= w) continue;
        const j = ny * w + nx;
        if (nibChain[j] < 0) continue;
        if (d2 < nearD2) nearD2 = d2;
        const t = timeOf(nibChain[j], nibS[j]);
        if (t > lateT) { lateT = t; lateJ = j; lateD2 = d2; }
      }
    }
    if (lateJ < 0) continue;
    const own = timeOf(chain[i], sArc[i]);
    if (lateT - own <= passGap) continue; // the same pass: a bulge, not a wedge
    if (Math.sqrt(lateD2) > Math.sqrt(nearD2) + WEDGE_SLACK_PX) continue; // beside a pass, not between two
    chain[i] = nibChain[lateJ];
    sArc[i] = nibS[lateJ] + Math.sqrt(lateD2) * unitPerPx;
    prov[i] = 5;
  }

  let unassigned = 0, hidden = 0, count = 0;
  for (let i = 0; i < N; i++) {
    if (dom[i]) count++;
    if (fill[i] && chain[i] === -1) unassigned++;
    if (fill[i] && chain[i] === HIDDEN) hidden++;
  }
  const domain = new Int32Array(count);
  for (let i = 0, q = 0; i < N; i++) if (dom[i]) domain[q++] = i;

  return { w, h, chain, s: sArc, domain, chainsUsed: [...used].sort((a, b) => a - b), unassigned, hidden, prov, claimS, cover, chain2, s2 };
}
