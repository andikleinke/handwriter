/**
 * Fit the ribbons' profiles to the font's outline.
 *
 * The profiles the stroke renderer starts from are measurements: a
 * cross-section read along each sample's normal, replaced by rules where
 * strokes cross or join. Against the outline they are off by the half-pixel
 * a reading overshoots, by whatever the rules decided, and by every place a
 * font's stroke is not a swept nib. This snaps every edge to the outline,
 * iteratively: a point just outside an edge that is ink no ribbon covers
 * pulls the edge out, a point just inside that is background pushes it in.
 * The test is against the UNION of all ribbons, so a stroke never grows to
 * cover ink another stroke already draws - at a crossing each keeps its own
 * width, which is the rule the whole project runs on - and the growth is
 * bounded, so a fillet is absorbed as a smooth swell rather than a nub.
 * Profiles are smoothed after every pass; bridges take the mean of the two
 * strokes they join.
 */

import { fontToRaster } from '../lib/raster.js';
import { piece, rebuildEdges } from './strokeRender.js';

export const FIT_ITERATIONS = 12;
export const FIT_SMOOTH_EM = 0.011;   // profile smoothing per pass (0.015 blurred a stem edge that leaves the path within 0.03 em into a tilt)
export const FIT_MAX_GROW = 0.6;      // a profile may grow this fraction past where it started (the sweep reads a junction narrow; growth only goes into ink no ribbon covers)
export const FIT_STEP_PX = 0.5;       // raster pixels an edge moves per pass

/**
 * @param {Array} ribbons  from buildStrokeProgram (mutated: hl, hr, edges)
 * @param {Array} sampled  maps.sampled (for the item each sample is on)
 * @param {Array} chains   the plan's chains (items with type/glyphIndex)
 * @param {Array} glyphs   analysis.glyphs with rasters
 * @param {number} upem
 */
export function fitProfiles(ribbons, sampled, chains, glyphs, upem, opts = {}) {
  const iterations = opts.iterations ?? globalThis.__fitIter ?? FIT_ITERATIONS;
  const canvases = glyphs.map((g) => {
    if (!g.raster) return null;
    const c = document.createElement('canvas');
    c.width = g.raster.width; c.height = g.raster.height;
    return c;
  });
  // the glyph each sample belongs to (-1 on a bridge)
  const glyphOf = ribbons.map((rb) => {
    const sc = sampled[rb.chain], items = chains[rb.chain].items;
    const g = new Int16Array(sc.n);
    for (let k = 0; k < sc.n; k++) { const it = items[sc.item[k]]; g[k] = it.type === 'stroke' ? it.glyphIndex : -1; }
    return g;
  });
  const start = ribbons.map((rb) => ({ hl: Float32Array.from(rb.hl), hr: Float32Array.from(rb.hr) }));
  let moved = 0;
  for (let iter = 0; iter < iterations; iter++) {
    // the union of every ribbon, per glyph raster
    const masks = glyphs.map((g, gi) => {
      const c = canvases[gi];
      if (!c) return null;
      const r = g.raster, ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#000';
      const toR = (p) => fontToRaster(r, p[0] - g.x, p[1] - g.y);
      for (const rb of ribbons) {
        const L = rb.left.map(toR), R = rb.right.map(toR), C = rb.pts.map(toR);
        ctx.fill(piece(L, R, C, 0, L.length - 1, rb.rad ? Array.from(rb.rad, (v) => v * r.scale) : null), 'nonzero');
      }
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const m = new Uint8Array(c.width * c.height);
      for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
      return m;
    });
    moved = 0;
    ribbons.forEach((rb, ri) => {
      const sc = sampled[rb.chain];
      const n = sc.n;
      for (let k = 0; k < n; k++) {
        const gi = glyphOf[ri][k];
        if (gi < 0 || !masks[gi]) continue;
        const g = glyphs[gi], r = g.raster, mask = masks[gi], W = r.width, H = r.height;
        const px1 = 1 / r.scale; // one raster pixel, in font units
        const at = (p) => {
          const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
          const xi = Math.round(x), yi = Math.round(y);
          if (xi < 0 || yi < 0 || xi >= W || yi >= H) return [0, 0];
          const i = yi * W + xi;
          return [r.fill[i], mask[i]];
        };
        const nx = -sc.tan[2 * k + 1], ny = sc.tan[2 * k];
        for (const side of [0, 1]) {
          const sgn = side === 0 ? 1 : -1;
          const prof = side === 0 ? rb.hl : rb.hr;
          const h = prof[k];
          const [cx, cy] = rb.pts[k];
          const outP = [cx + sgn * nx * (h + px1), cy + sgn * ny * (h + px1)];
          const inP = [cx + sgn * nx * (h - px1), cy + sgn * ny * (h - px1)];
          const [fillOut, unionOut] = at(outP);
          const [fillIn] = at(inP);
          const cap = (side === 0 ? start[ri].hl : start[ri].hr)[k] * (1 + FIT_MAX_GROW);
          if (fillOut && !unionOut && h + FIT_STEP_PX * px1 <= cap) { prof[k] = h + FIT_STEP_PX * px1; moved++; }
          else if (!fillIn && h - FIT_STEP_PX * px1 >= 0.5 * px1) { prof[k] = h - FIT_STEP_PX * px1; moved++; }
        }
      }
      // bridges: the mean profile of the samples either side
      let k = 0;
      while (k < n) {
        if (glyphOf[ri][k] >= 0) { k++; continue; }
        let e = k; while (e + 1 < n && glyphOf[ri][e + 1] < 0) e++;
        const a = k > 0 ? k - 1 : null, b = e + 1 < n ? e + 1 : null;
        for (let j = k; j <= e; j++) {
          const t = a !== null && b !== null ? (sc.s[j] - sc.s[a]) / (sc.s[b] - sc.s[a] || 1) : 0;
          for (const prof of [rb.hl, rb.hr]) {
            const v0 = a !== null ? prof[a] : prof[b], v1 = b !== null ? prof[b] : prof[a];
            prof[j] = v0 + (v1 - v0) * t;
          }
        }
        k = e + 1;
      }
      // smooth and rebuild
      const step = sc.s[1] - sc.s[0] || 1;
      const win = Math.max(1, Math.round((FIT_SMOOTH_EM * upem) / step));
      for (const key of ['hl', 'hr']) {
        const src = rb[key], o = new Float32Array(n);
        for (let i = 0; i < n; i++) { let sum = 0, c = 0; for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) { sum += src[j]; c++; } o[i] = sum / c; }
        rb[key] = o;
      }
      rebuildEdges(rb);
    });
    if (!moved) break;
  }
  return { iterations, lastMoved: moved };
}

export const MANUAL_BLEND_EM = 0.04; // a hand-set width blends into the fitted profile over this much path either way

/**
 * Widths the hand set in the editor (record.strokes[].widthEdits, full
 * widths in font units at a point of the stroke) override the fitted
 * profiles around the nearest sample, blending in over MANUAL_BLEND_EM.
 * Applied after the fit, so an authored width is never "corrected" back.
 */
export function applyManualWidths(ribbons, sampled, chains, glyphs, upem) {
  let applied = 0;
  ribbons.forEach((rb) => {
    const sc = sampled[rb.chain], items = chains[rb.chain].items;
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      if (it.type !== 'stroke') continue;
      const g = glyphs[it.glyphIndex], rec = g?.record?.strokes?.[it.strokeIndex];
      if (!rec?.widthEdits) continue;
      for (const [j, w] of Object.entries(rec.widthEdits)) {
        const P = rec.points[j];
        if (!P) continue;
        const px = P[0] + g.x, py = P[1] + g.y;
        // the nearest sample of this item
        let best = -1, bd = Infinity;
        for (let k = 0; k < sc.n; k++) {
          if (sc.item[k] !== ii) continue;
          const d = (rb.pts[k][0] - px) ** 2 + (rb.pts[k][1] - py) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
        if (best < 0) continue;
        const half = w / 2, span = MANUAL_BLEND_EM * upem;
        for (let k = 0; k < sc.n; k++) {
          const d = Math.abs(sc.s[k] - sc.s[best]);
          if (d > span) continue;
          const t = 1 - d / span;
          rb.hl[k] += (half - rb.hl[k]) * t;
          rb.hr[k] += (half - rb.hr[k]) * t;
        }
        applied++;
      }
    }
    if (applied) rebuildEdges(rb);
  });
  return applied;
}

export const TIP_TURN = -0.5; // tangents this far reversed across a short arc mark a hairpin's apex

/**
 * Round the tips a round nib leaves: the free ends of its strokes and the
 * apex of every hairpin (a detour into a taper runs up to the tip and back
 * over the same line). The cross-section readings there are chords of the
 * tip's circle and narrow to nothing, so the ribbon's edges converge and the
 * tip comes out as a chisel. Here the room along the path from the tip
 * sample to the ink's edge is read off the raster, and the samples within
 * that much path are held to at least that half-width: the ribbon ends in
 * the nib's disc, which reaches the ink's edge exactly. Pointed pens are
 * left alone: their ends taper, and they should. Runs after the fit and the
 * hand's widths, since the fit would shrink the held samples back.
 */
export function roundTips(ribbons, sampled, chains, glyphs) {
  let n = 0;
  ribbons.forEach((rb) => {
    const items = chains[rb.chain].items;
    const sc = sampled[rb.chain];
    const m = rb.hl.length;
    if (m < 4) return;
    const step = Math.abs(rb.s[1] - rb.s[0]) || 1;
    const glyphAt = (k) => { const it = items[sc.item[k]]; return it && it.type === 'stroke' ? it : null; };
    const width = (k) => rb.hl[k] + rb.hr[k];
    // the stroke's width a little way from sample `a` in direction `dir`
    const widthNear = (a, dir) => {
      const w0 = width(a) || step;
      const from = Math.round((0.6 * w0) / step), to = Math.round((1.4 * w0) / step);
      const ws = [];
      for (let j = from; j <= to; j++) { const k = a + dir * j; if (k >= 0 && k < m) ws.push(width(k)); }
      if (!ws.length) return w0;
      ws.sort((x, y) => x - y);
      return ws[Math.floor(ws.length / 2)];
    };
    // ink along `u` from the sample, in font units
    const room = (it, p, u, cap) => {
      const g = glyphs[it.glyphIndex], r = g.raster;
      if (!r) return 0;
      const px1 = 1 / r.scale;
      let d = 0;
      while (d < cap) {
        const [x, y] = fontToRaster(r, p[0] + u[0] * (d + px1) - g.x, p[1] + u[1] * (d + px1) - g.y);
        const xi = Math.round(x), yi = Math.round(y);
        if (!(xi >= 0 && yi >= 0 && xi < r.width && yi < r.height && r.fill[yi * r.width + xi])) break;
        d += px1;
      }
      return d;
    };
    // The tip is the nib's disc: of the stroke's radius R, centred where
    // the path is still R from the ink's edge. The pen runs on past that
    // point (a detour goes almost to the edge, a skeleton end less far), and
    // over that last bit the readings are chords of the same disc, which the
    // ribbon's rotating offsets only cut corners from: so the samples past
    // the disc's centre are given no width, and the centre the full radius.
    const hold = (a, dirs, u) => {
      const it = glyphAt(a);
      if (!it || it.role === 'dot' || it.record?.stats?.hand?.pointed) return;
      // each leg's own radius: at a hairpin where two strokes merge (the
      // `a`'s bowl closing into its stem) the legs differ in width, and one
      // disc of the wider's radius bulged past the narrower's edge
      const ws = dirs.map((d) => widthNear(a, d));
      const w = Math.max(...ws);
      if (!(w / 2 > 0)) return;
      const d = room(it, rb.pts[a], u, w);
      for (const [di, dir] of dirs.entries()) {
        const R = ws[di] / 2;
        if (!(R > 0)) continue;
        const back = Math.round(Math.max(0, R - d) / step);
        const c = Math.max(0, Math.min(m - 1, a + dir * back));
        for (let k = a; k !== c; k += dir) {
          // at a start the nib's footprint grows from the touch-down point: a
          // disc that just reaches the ink's edge at every sample, each inside
          // the next, so the ink never pops in; past an end or an apex the
          // disc at the centre already covers everything and the width is 0
          const r = a === 0 && dir === 1 ? Math.min(R, d + Math.abs(rb.s[k] - rb.s[a])) : 0;
          rb.hl[k] = r; rb.hr[k] = r;
        }
        // The disc is centred between the ribbon's edges, not on the path:
        // where the path runs off the stroke's axis (the skeleton of a stem
        // a bowl closes into) a disc on the path left the far edge stepping
        // out below it. Its radius is the stroke's, read a little way from
        // the tip, not the halves here: at a hairpin those are the union of
        // the two legs (the `a`'s apex: 24 each for a stroke of 16), and a
        // disc of the union's radius bulged past the stem's edge under it.
        const shift = (rb.hl[c] - rb.hr[c]) / 2;
        const nx = -rb.tan[2 * c + 1], ny = rb.tan[2 * c];
        rb.pts[c] = [rb.pts[c][0] + nx * shift, rb.pts[c][1] + ny * shift];
        rb.hl[c] = R; rb.hr[c] = R;
      }
      n++;
    };
    const tanAt = (k) => [rb.tan[2 * k], rb.tan[2 * k + 1]];
    // the free ends: outward along the tangent
    const t0 = tanAt(0), t1 = tanAt(m - 1);
    hold(0, [1], [-t0[0], -t0[1]]);
    hold(m - 1, [-1], t1);
    // the hairpins: the apex is the sample where the tangents either side are most reversed
    const j = Math.max(2, Math.round((0.15 * width(Math.floor(m / 2))) / step));
    let k = j;
    while (k < m - j) {
      const a0 = tanAt(k - j), a1 = tanAt(k + j);
      if (a0[0] * a1[0] + a0[1] * a1[1] < TIP_TURN) {
        // the most reversed sample within reach
        let best = k, bestDot = 1;
        for (let q = k; q < Math.min(m - j, k + 2 * j); q++) {
          const b0 = tanAt(q - j), b1 = tanAt(q + j);
          const dot = b0[0] * b1[0] + b0[1] * b1[1];
          if (dot < bestDot) { bestDot = dot; best = q; }
        }
        const back = rb.pts[best - j], fwd = rb.pts[best + j], apex = rb.pts[best];
        let ux = apex[0] - (back[0] + fwd[0]) / 2, uy = apex[1] - (back[1] + fwd[1]) / 2;
        const ul = Math.hypot(ux, uy);
        if (ul > 1e-6) hold(best, [-1, 1], [ux / ul, uy / ul]);
        k = best + 2 * j;
      } else k++;
    }
    rebuildEdges(rb);
  });
  return n;
}

export const RETRACE_NEAR = 0.3;   // a sample this close (fraction of the stroke width) to an earlier, opposite-running sample is a retrace of it
export const RETRACE_SKIP_EM = 0.08; // ...looking only at samples at least this much path earlier
export const RETRACE_SAME = 0.7;    // ...and only when the two passes are within this ratio of width (the same stroke, not a hairline over a shade)

/**
 * Where a chain runs back over its own ink (a stem written up and down, a
 * there-and-back entry), the two passes are the same stroke. Their
 * centrelines sit a few units apart, so their fitted profiles differ by as
 * much, and the second pass showed as a step in the edge where it left the
 * first. The later pass takes the earlier pass's edges: for a sample k on
 * an earlier sample j running the other way, the left edge of k is the
 * right edge of j and vice versa, the centreline offset accounted for.
 */
export function alignRetraces(ribbons, chains, upem) {
  let n = 0;
  for (const rb of ribbons) {
    // a pointed pen's passes over one line are a hairline and a shade: not one stroke
    const first = chains[rb.chain]?.items?.find((it) => it.type === 'stroke');
    if (first?.record?.stats?.hand?.pointed) continue;
    const m = rb.hl.length;
    const skip = RETRACE_SKIP_EM * upem;
    const prevL = Float32Array.from(rb.hl), prevR = Float32Array.from(rb.hr);
    let changed = false;
    for (let k = 0; k < m; k++) {
      const w = prevL[k] + prevR[k];
      if (!(w > 0)) continue;
      const near = RETRACE_NEAR * w;
      const tx = rb.tan[2 * k], ty = rb.tan[2 * k + 1];
      let best = -1, bd = near;
      for (let j = 0; j < m; j++) {
        if (rb.s[k] - rb.s[j] < skip) break; // samples are in path order
        const d = Math.hypot(rb.pts[j][0] - rb.pts[k][0], rb.pts[j][1] - rb.pts[k][1]);
        if (d < bd && tx * rb.tan[2 * j] + ty * rb.tan[2 * j + 1] < -0.8) { bd = d; best = j; }
      }
      if (best < 0) continue;
      const j = best;
      // the same stroke, not a hairline running back over a shade (a pointed
      // pen's upstroke over its downstroke): the two passes must be of a width
      const wj = prevL[j] + prevR[j];
      if (wj < RETRACE_SAME * w || w < RETRACE_SAME * wj) continue;
      const nx = -rb.tan[2 * j + 1], ny = rb.tan[2 * j];           // j's left normal
      const off = nx * (rb.pts[k][0] - rb.pts[j][0]) + ny * (rb.pts[k][1] - rb.pts[j][1]); // k's centre, measured from j's along j's left
      // k runs the other way: its left is j's right. Its left edge must land
      // on j's right edge, its right edge on j's left edge
      const hl = prevR[j] + off, hr = prevL[j] - off;
      if (hl > 0.5 && hr > 0.5) { rb.hl[k] = hl; rb.hr[k] = hr; changed = true; n++; }
    }
    if (changed) rebuildEdges(rb);
  }
  return n;
}
