/**
 * Chain ends to the ink's tips.
 *
 * A thinned skeleton stops about half a stroke width short of a rounded tip,
 * and a tail the spur pruning took is gone altogether; the coverage repair
 * (strokeRecovery.js) brings back the tails a round pen would miss, but
 * anything shorter than that stays untravelled. The outline reveal hid this
 * under "nearest band"; the stroke renderer draws only what the pen travels,
 * so a free end of a chain - a pen-down or a pen-up, never a bridge cut - is
 * walked on along its tangent, one raster pixel at a time, re-centred on the
 * ink's cross-section, until the ink ends, widens into something else, or
 * runs into another stroke. The plan item's path is lengthened in place, so
 * the reveal maps, the timing, the pen tip and both renderers see one path.
 */

import { fontToRaster } from './raster.js';

export const EXTEND_MAX_EM = 0.12;   // an end is walked on at most this far
export const EXTEND_WIDEN = 1.35;    // ...and stops where the ink grows this much wider than at the end
export const EXTEND_PROBE = 1.6;     // the cross-section is read this many end widths either way

/**
 * @param {{items: Array}} plan  from buildPenPlan (items mutated: points)
 * @param {Array} glyphs  analysis glyphs with rasters
 * @param {number} upem
 * @returns {Array<{glyphIndex:number, strokeIndex:number, at:'head'|'tail', units:number}>}
 */
export function extendChainEnds(plan, glyphs, upem) {
  const out = [];
  // the first and last stroke item of every chain
  const first = new Map(), last = new Map();
  for (const it of plan.items) {
    if (it.type !== 'stroke' || it.role === 'dot') continue; // a dot is a dab, not a stroke with tips
    if (!first.has(it.chain)) first.set(it.chain, it);
    last.set(it.chain, it);
  }
  for (const [chain, it] of first) {
    if (it._extended?.head != null) continue;
    const g = glyphs[it.glyphIndex];
    const ext = g?.raster && it.points.length >= 2 ? walk(it, g, glyphs, upem, 'head') : [];
    it._extended = { ...(it._extended || {}), head: ext.length };
    if (ext.length) { it.points.unshift(...ext); out.push({ glyphIndex: it.glyphIndex, strokeIndex: it.strokeIndex, at: 'head', units: Math.round(polyLen(ext.concat([it.points[ext.length]]))) }); }
  }
  for (const [chain, it] of last) {
    if (it._extended?.tail != null) continue;
    const g = glyphs[it.glyphIndex];
    const ext = g?.raster && it.points.length >= 2 ? walk(it, g, glyphs, upem, 'tail') : [];
    it._extended = { ...(it._extended || {}), tail: ext.length };
    if (ext.length) { const n = it.points.length; it.points.push(...ext); out.push({ glyphIndex: it.glyphIndex, strokeIndex: it.strokeIndex, at: 'tail', units: Math.round(polyLen([it.points[n - 1]].concat(ext))) }); }
  }
  return out;
}

function polyLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }

/** The points past one end of the item's path, in walking order, or []. */
function walk(it, g, glyphs, upem, at) {
  const r = g.raster, W = r.width, H = r.height, fill = r.fill;
  const px1 = 1 / r.scale;
  const pts = at === 'tail' ? it.points : [...it.points].reverse();
  const n = pts.length;
  const p0 = pts[n - 1];
  // the tangent out of the end: from a point 0.02 em back
  let back = n - 2;
  while (back > 0 && Math.hypot(pts[back][0] - p0[0], pts[back][1] - p0[1]) < 0.02 * upem) back--;
  let tx = p0[0] - pts[back][0], ty = p0[1] - pts[back][1];
  const tl = Math.hypot(tx, ty);
  if (!(tl > 0)) return [];
  tx /= tl; ty /= tl;
  const ink = (x, y) => {
    const [rx, ry] = fontToRaster(r, x - g.x, y - g.y);
    const xi = Math.round(rx), yi = Math.round(ry);
    return xi >= 0 && yi >= 0 && xi < W && yi < H && fill[yi * W + xi] ? 1 : 0;
  };
  // ink extent along the normal from (x, y), either way, up to `cap`
  const section = (x, y, nx, ny, cap) => {
    let a = 0, b = 0;
    while (a < cap && ink(x + nx * (a + px1), y + ny * (a + px1))) a += px1;
    while (b < cap && ink(x - nx * (b + px1), y - ny * (b + px1))) b += px1;
    return [a, b];
  };
  let nx = -ty, ny = tx;
  const cap0 = 0.2 * upem;
  const [a0, b0] = section(p0[0], p0[1], nx, ny, cap0);
  const w0 = a0 + b0 + px1;
  if (!ink(p0[0], p0[1]) || w0 <= 2 * px1) return [];
  const cap = EXTEND_PROBE * w0;
  // other ink the walk must not run into: every other stroke of the glyph,
  // and this stroke's own points away from the end
  const others = [];
  for (const s of g.record?.strokes || []) {
    const own = s === it.stroke;
    s.points.forEach((q, i) => {
      if (own) { const k = at === 'tail' ? s.points.length - 1 - i : i; if (k < 6) return; }
      others.push([q[0] + g.x, q[1] + g.y]);
    });
  }
  const tooClose = (x, y) => {
    const lim = 0.6 * w0;
    for (const q of others) if (Math.hypot(q[0] - x, q[1] - y) < lim) return true;
    return false;
  };
  const out = [];
  let x = p0[0], y = p0[1];
  const step = 2 * px1;
  const maxSteps = Math.floor((EXTEND_MAX_EM * upem) / step);
  for (let k = 0; k < maxSteps; k++) {
    let qx = x + tx * step, qy = y + ty * step;
    if (!ink(qx, qy)) {
      // a pixel past the tip, or off-centre on a bending tail: look across
      const [a, b] = section(qx, qy, nx, ny, cap);
      if (a + b < px1) break;
      qx += nx * (a - b) / 2; qy += ny * (a - b) / 2;
      if (!ink(qx, qy)) break;
    }
    const [a, b] = section(qx, qy, nx, ny, cap);
    const w = a + b + px1;
    if (w > EXTEND_WIDEN * w0) break;             // into a junction or a bowl
    if (tooClose(qx, qy)) break;                   // onto another stroke
    // re-centre, and let the tangent follow the ink
    qx += nx * (a - b) / 2; qy += ny * (a - b) / 2;
    let dx = qx - x, dy = qy - y;
    const dl = Math.hypot(dx, dy);
    if (!(dl > 0)) break;
    dx /= dl; dy /= dl;
    if (dx * tx + dy * ty < 0.7) break;            // the ink turns away: not this stroke's tail
    tx = 0.6 * tx + 0.4 * dx; ty = 0.6 * ty + 0.4 * dy;
    const l = Math.hypot(tx, ty); tx /= l; ty /= l;
    nx = -ty; ny = tx;
    x = qx; y = qy;
    out.push([x, y]);
  }
  // the last point sits a pixel inside the tip; the nib's disc covers the rest
  return at === 'tail' ? out : out.reverse();
}
