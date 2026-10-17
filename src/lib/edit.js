/**
 * Record surgery for manual corrections. Pure data - operates on the JSON
 * stroke records (plus, for drawing and snapping, the glyph's transient
 * raster); callers persist via the StrokeStore and rebuild whatever they
 * derive from the record.
 */

import { polylineLength, resample, smoothPolyline, simplifyRDP, roundPts } from './geometry.js';
import { fontToRaster, rasterToFont } from './raster.js';
import { snapToInk, inkWidthAt } from './snap.js';

/**
 * Split a stroke into two at one of its points. Both halves keep the role
 * and component of the original. Returns false if the index is not an
 * interior point.
 */
export function splitStroke(record, strokeIndex, pointIndex) {
  const s = record.strokes[strokeIndex];
  if (!s || pointIndex <= 0 || pointIndex >= s.points.length - 1) return false;
  const first = s.points.slice(0, pointIndex + 1);
  const second = s.points.slice(pointIndex);
  const make = (points, from) => ({
    ...s,
    points,
    widths: s.widths ? s.widths.slice(from, from + points.length) : undefined,
    widthEdits: s.widthEdits ? remapWidthEdits(s.widthEdits, (i) => (i >= from && i < from + points.length ? i - from : null)) : undefined,
    lengthFontUnits: round2(polylineLength(points)),
  });
  const a = make(first, 0);
  const b = make(second, pointIndex);
  // the cut is mid-ink; neither half knows its width there
  a.endWidth = null;
  b.startWidth = null;
  record.strokes.splice(strokeIndex, 1, a, b);
  return true;
}

/**
 * Remove a stroke from the record. Its ink is not deleted - the region
 * builder reassigns every ink pixel to the nearest remaining stroke, so the
 * glyph still renders completely; only the pen pass disappears.
 */
export function deleteStroke(record, strokeIndex) {
  if (strokeIndex < 0 || strokeIndex >= record.strokes.length) return false;
  record.strokes.splice(strokeIndex, 1);
  return true;
}

/** Insert a stroke at `atIndex` (default: append). Returns its index. */
export function addStroke(record, stroke, atIndex = record.strokes.length) {
  const i = Math.max(0, Math.min(record.strokes.length, atIndex));
  record.strokes.splice(i, 0, stroke);
  return i;
}

/**
 * Turn a hand-drawn path (glyph-local font units) into a stroke record:
 * optionally snapped onto the ink's centreline, then smoothed like a
 * recovered stroke would be. Returns null if there is not enough to it.
 */
export function strokeFromDrawing(glyph, localPts, { snap = true } = {}) {
  const raster = glyph.raster;
  if (!raster || localPts.length < 2) return null;
  const emPx = glyph.record.unitsPerEm * raster.scale;
  let pts = localPts.map((p) => fontToRaster(raster, p[0], p[1]));
  if (snap) pts = snapToInk(raster, pts, Math.max(4, glyph.record.penWidth * raster.scale * 0.75));
  pts = resample(pts, Math.max(2, emPx * 0.006));
  pts = smoothPolyline(pts, 2, 2);
  pts = simplifyRDP(pts, Math.max(0.4, emPx * 0.002));
  if (pts.length < 2 || polylineLength(pts) < emPx * 0.02) return null;
  const toFont = (p) => rasterToFont(raster, p[0], p[1]);
  return {
    index: 0,
    role: 'body',
    component: -1,
    manual: true,
    lengthFontUnits: round2(polylineLength(pts) / raster.scale),
    startWidth: round1(inkWidthAt(raster, pts[0]) / raster.scale) || null,
    endWidth: round1(inkWidthAt(raster, pts[pts.length - 1]) / raster.scale) || null,
    retraces: [],
    points: roundPts(pts.map(toFont), 2),
    widths: pts.map((p) => round1(inkWidthAt(raster, p) / raster.scale)),
  };
}

/**
 * Move one point of a stroke to (x, y) font units, carrying its neighbours
 * along with a smooth falloff over `radius` font units of arc length either
 * side (radius 0 moves the one point).
 *
 * The move is absolute and always computed from `base` - the stroke's points
 * as they were when the drag began - so the result depends only on where the
 * pointer is now, not on how it got there. Applying deltas to the live points
 * instead made a slow drag and a fast one end up in different places, and
 * left the grabbed point away from the cursor.
 *
 * A stroke's points are dense samples of the path, a raster pixel or two
 * apart, so moving a single one puts a spike in it; the falloff is what makes
 * a drag reshape the curve rather than dent it.
 *
 * Mutates the record; returns the affected index range.
 */
export function dragPoint(record, strokeIndex, pointIndex, base, x, y, radius) {
  const s = record.strokes[strokeIndex];
  if (!s || !base[pointIndex]) return null;
  const pts = s.points;
  const dx = x - base[pointIndex][0], dy = y - base[pointIndex][1];
  pts[pointIndex] = [round2(x), round2(y)];
  let lo = pointIndex, hi = pointIndex;
  if (radius > 0) {
    for (const dir of [-1, 1]) {
      let acc = 0;
      for (let i = pointIndex + dir; i >= 0 && i < pts.length; i += dir) {
        acc += Math.hypot(base[i][0] - base[i - dir][0], base[i][1] - base[i - dir][1]);
        if (acc >= radius) break;
        const t = 1 - acc / radius;
        const w = t * t * (3 - 2 * t);
        pts[i] = [round2(base[i][0] + dx * w), round2(base[i][1] + dy * w)];
        if (dir < 0) lo = i; else hi = i;
      }
    }
  }
  s.lengthFontUnits = round2(polylineLength(pts));
  return [lo, hi];
}

/**
 * Remove one point from a stroke. The ends are kept - they are where the pen
 * lands and leaves, and the word-level joins are measured from them - and a
 * stroke is never left with fewer than three points.
 */
export function deletePoint(record, strokeIndex, pointIndex) {
  const s = record.strokes[strokeIndex];
  if (!s || s.points.length <= 3) return false;
  if (pointIndex <= 0 || pointIndex >= s.points.length - 1) return false;
  s.points.splice(pointIndex, 1);
  if (s.widths) s.widths.splice(pointIndex, 1);
  if (s.widthEdits) s.widthEdits = remapWidthEdits(s.widthEdits, (i) => (i === pointIndex ? null : i > pointIndex ? i - 1 : i));
  s.lengthFontUnits = round2(polylineLength(s.points));
  return true;
}

/** Hand-set widths follow their points through a split or a delete. */
export function remapWidthEdits(edits, map) {
  const out = {};
  for (const [k, w] of Object.entries(edits)) { const j = map(Number(k)); if (j != null && j >= 0) out[j] = w; }
  return Object.keys(out).length ? out : undefined;
}

/** Set (or with `width` null, clear) the hand-set width at one point. */
export function setPointWidth(record, strokeIndex, pointIndex, width) {
  const s = record.strokes[strokeIndex];
  if (!s || pointIndex < 0 || pointIndex >= s.points.length) return false;
  const edits = { ...(s.widthEdits || {}) };
  if (width == null) delete edits[pointIndex]; else edits[pointIndex] = round1(Math.max(1, width));
  s.widthEdits = Object.keys(edits).length ? edits : undefined;
  return true;
}

/** Snap a range of a stroke's points onto the ink centreline (after a drag). */
export function snapStrokeRange(glyph, record, strokeIndex, lo, hi) {
  const raster = glyph.raster;
  const s = record.strokes[strokeIndex];
  if (!raster || !s) return;
  const maxDist = Math.max(4, glyph.record.penWidth * raster.scale * 0.6);
  const slice = s.points.slice(lo, hi + 1).map((p) => fontToRaster(raster, p[0], p[1]));
  const snapped = snapToInk(raster, slice, maxDist).map((p) => rasterToFont(raster, p[0], p[1]));
  for (let i = lo; i <= hi; i++) s.points[i] = roundPts([snapped[i - lo]], 2)[0];
  s.lengthFontUnits = round2(polylineLength(s.points));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Recompute the ink width under every point of every stroke, and drop the
 * pen-order search's verdict on strokes the hand has touched.
 *
 * The width per point is what the join logic and the invariant check read to
 * tell a shade from a hairline (`penPlan.js`, `fontCheck.js`), so it has to
 * follow the points wherever they are moved, split or drawn. `againstRule`
 * cannot be recomputed here - only the search knows it - so an edited record
 * carries none, and the check judges it by its widths alone.
 *
 * Call once after any edit, with the glyph's transient raster; a record
 * without one keeps whatever widths it had.
 */
export function refreshWidths(glyph, record) {
  const raster = glyph?.raster;
  if (!raster) return false;
  for (const s of record.strokes) {
    s.widths = s.points.map((p) => round1(inkWidthAt(raster, fontToRaster(raster, p[0], p[1])) / raster.scale));
    // a width the hand set by hand stays set
    for (const [i, w] of Object.entries(s.widthEdits || {})) if (i < s.widths.length) s.widths[i] = w;
    delete s.againstRule;
  }
  return true;
}
