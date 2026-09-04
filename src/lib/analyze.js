/**
 * Word-level orchestration: shape, recover strokes per glyph, then build the
 * pen plan (order, lifts, bridges) across the whole word.
 *
 * Still no DOM rendering here - the result is data the debug view and the
 * animation both consume.
 */

import { shapeText } from './shaping.js';
import { recoverGlyphStrokes, rasterStrokesFromRecord } from './strokeRecovery.js';
import { rasterizeGlyph } from './raster.js';
import { fontKeyOf } from './cache.js';
import { buildPenPlan, planToJSON } from './penPlan.js';

export function analyzeWord(fontCtx, text, store, opts = {}) {
  const t0 = performance.now();
  const shaping = shapeText(fontCtx, text);
  const fontKey = fontKeyOf(fontCtx);
  const glyphs = [];
  const byGid = new Map(); // repeated letters share one raster and one recovery

  for (const g of shaping.glyphs) {
    let hit = byGid.get(g.gid);
    if (!hit) {
      let record = opts.ignoreCache ? null : store?.get(fontKey, g.gid) ?? null;
      let raster = null;
      let rasterStrokes = [];
      let cached = false;

      if (record) {
        cached = true;
        if (!g.isBlank && g.path) {
          raster = rasterizeGlyph(g.path, g.bbox, {
            unitsPerEm: fontCtx.unitsPerEm,
            rasterEm: opts.rasterEm ?? 512,
          });
          rasterStrokes = rasterStrokesFromRecord(record, raster);
        }
      } else {
        const res = recoverGlyphStrokes(g, fontCtx, opts);
        record = res.record;
        raster = res.raster;
        rasterStrokes = res.rasterStrokes ?? [];
        store?.set(fontKey, g.gid, record);
      }
      hit = { record, raster, rasterStrokes, cached };
      byGid.set(g.gid, hit);
    }
    glyphs.push({ ...g, ...hit });
  }

  // per-glyph notes, once per distinct glyph
  const glyphNotes = [];
  const noted = new Set();
  glyphs.forEach((gl, gi) => {
    if (noted.has(gl.gid)) return;
    noted.add(gl.gid);
    for (const note of gl.record.notes) glyphNotes.push({ ...note, glyphIndex: gi, gid: gl.gid });
  });

  const analysis = {
    text,
    fontKey,
    shaping,
    glyphs,
    glyphNotes,
    bounds: wordBounds(glyphs, fontCtx),
    plan: null,
    penOrder: [],
    notes: [],
    msElapsed: 0,
  };
  rebuildPlan(analysis, opts);
  analysis.msElapsed = Math.round(performance.now() - t0);
  return analysis;
}

/**
 * Recompute everything derived from the records: pen order, bridges, lifts.
 * Cheap, so it runs after every manual edit and whenever the connect option
 * changes.
 */
export function rebuildPlan(analysis, opts = {}) {
  analysis.plan = buildPenPlan(analysis.glyphs, { connect: opts.connect ?? true });
  analysis.penOrder = analysis.plan.penOrder;
  analysis.notes = analysis.glyphNotes.concat(analysis.plan.notes);
  return analysis.plan;
}

/**
 * After a record changed, refresh every glyph instance that shares it (the
 * same letter appearing twice shares one record and one raster).
 */
export function refreshGlyphRecord(analysis, gid, record) {
  for (const g of analysis.glyphs) {
    if (g.gid !== gid) continue;
    g.record = record;
    g.rasterStrokes = g.raster ? rasterStrokesFromRecord(record, g.raster) : [];
  }
}

function wordBounds(glyphs, fontCtx) {
  let x1 = 0, y1 = 0, x2 = 0, y2 = 0, any = false;
  for (const g of glyphs) {
    if (g.isBlank) continue;
    const bx1 = g.x + g.bbox.x1;
    const bx2 = g.x + g.bbox.x2;
    const by1 = g.y + g.bbox.y1;
    const by2 = g.y + g.bbox.y2;
    if (!any) { x1 = bx1; x2 = bx2; y1 = by1; y2 = by2; any = true; }
    else {
      x1 = Math.min(x1, bx1); x2 = Math.max(x2, bx2);
      y1 = Math.min(y1, by1); y2 = Math.max(y2, by2);
    }
  }
  if (!any) {
    x1 = 0; x2 = 100;
    y1 = fontCtx.descender; y2 = fontCtx.ascender;
  }
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

/** Everything a cache/AI step would want to persist, and nothing more. */
export function toJSON(analysis) {
  return {
    text: analysis.text,
    font: analysis.fontKey,
    shaped: analysis.shaping.glyphs.map((g) => ({
      gid: g.gid, name: g.name, chars: g.chars, x: g.x, y: g.y, advance: g.xAdvance,
    })),
    plan: planToJSON(analysis.plan),
    glyphs: analysis.glyphs.map((g) => g.record),
  };
}
