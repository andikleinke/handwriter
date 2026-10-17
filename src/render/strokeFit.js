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
export const FIT_SMOOTH_EM = 0.015;   // profile smoothing per pass
export const FIT_MAX_GROW = 0.6;      // a profile may grow this fraction past where it started
export const FIT_STEP_PX = 0.5;       // raster pixels an edge moves per pass

/**
 * @param {Array} ribbons  from buildStrokeProgram (mutated: hl, hr, edges)
 * @param {Array} sampled  maps.sampled (for the item each sample is on)
 * @param {Array} chains   the plan's chains (items with type/glyphIndex)
 * @param {Array} glyphs   analysis.glyphs with rasters
 * @param {number} upem
 */
export function fitProfiles(ribbons, sampled, chains, glyphs, upem, opts = {}) {
  const iterations = opts.iterations ?? FIT_ITERATIONS;
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
        ctx.fill(piece(L, R, C, 0, L.length - 1), 'nonzero');
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
