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
  const make = (points) => ({
    ...s,
    points,
    lengthFontUnits: round2(polylineLength(points)),
  });
  const a = make(first);
  const b = make(second);
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
  };
}

/**
 * Drag one point of a stroke by (dx, dy) font units, carrying its
 * neighbours along with a smooth falloff over `radius` font units of arc
 * length either side. Mutates the record; returns the affected index range.
 */
export function nudgeStroke(record, strokeIndex, pointIndex, dx, dy, radius) {
  const s = record.strokes[strokeIndex];
  if (!s || !s.points[pointIndex]) return null;
  const pts = s.points;
  const move = (i, w) => { pts[i] = [pts[i][0] + dx * w, pts[i][1] + dy * w]; };
  move(pointIndex, 1);
  let lo = pointIndex, hi = pointIndex;
  for (const dir of [-1, 1]) {
    let acc = 0;
    for (let i = pointIndex + dir; i >= 0 && i < pts.length; i += dir) {
      acc += Math.hypot(pts[i][0] - pts[i - dir][0], pts[i][1] - pts[i - dir][1]);
      if (acc >= radius) break;
      const t = 1 - acc / radius;
      move(i, t * t * (3 - 2 * t));
      if (dir < 0) lo = i; else hi = i;
    }
  }
  s.lengthFontUnits = round2(polylineLength(pts));
  return [lo, hi];
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
