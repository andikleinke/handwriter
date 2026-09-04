/**
 * Debug view: the shaped word drawn large, outlines in light grey, the pen
 * plan on top - strokes in pen order, numbered, with arrowheads for
 * direction; retraced spans dashed; bridges between letters as dotted grey
 * connectors; the parts a bridge trimmed away drawn faint.
 */

import { setupHiDPI, computeLayout, toCanvas, withGlyphTransform, strokeColor } from './layout.js';
import { cumulativeLengths, pointAtLength, polylineLength } from '../lib/geometry.js';

export function renderDebugView(canvas, analysis, options = {}) {
  const {
    padding = 40,
    showOutlines = true,
    showArrows = true,
    showNumbers = true,
    showNodes = true,
    highlight = null, // {glyphIndex, strokeIndex, pointIndex?} or null
    view = null,      // {zoom, panX, panY} shared with the animation
  } = options;

  const cssWidth = canvas.clientWidth || 900;
  const cssHeight = canvas.clientHeight || 320;
  const ctx = setupHiDPI(canvas, cssWidth, cssHeight);
  const layout = computeLayout(analysis.bounds, cssWidth, cssHeight, padding, view);
  const css = (p) => [layout.originX + p[0] * layout.s, layout.baselineY - p[1] * layout.s];

  ctx.clearRect(0, 0, cssWidth, cssHeight);

  // baseline
  ctx.save();
  ctx.strokeStyle = 'rgba(120,130,150,.28)';
  ctx.setLineDash([5, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, layout.baselineY);
  ctx.lineTo(cssWidth, layout.baselineY);
  ctx.stroke();
  ctx.restore();

  if (showOutlines) {
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--outline-ink').trim() || '#dfe2ea';
    for (const g of analysis.glyphs) {
      if (g.isBlank || !g.path) continue;
      const p2d = new Path2D(g.path);
      withGlyphTransform(ctx, layout, g, () => ctx.fill(p2d, 'nonzero'));
    }
  }

  // stroke endpoints, so junctions and pen lifts are visible
  if (showNodes) {
    ctx.fillStyle = 'rgba(30,40,60,.22)';
    for (const g of analysis.glyphs) {
      for (const s of g.record.strokes) {
        for (const p of [s.points[0], s.points[s.points.length - 1]]) {
          const [x, y] = toCanvas(layout, g, p[0], p[1]);
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  const plan = analysis.plan;

  // bridges under the strokes
  for (const b of plan.bridges) {
    const pts = b.points.map(css);
    ctx.save();
    ctx.globalAlpha = highlight ? 0.3 : 0.85;
    ctx.strokeStyle = '#3a4150';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.setLineDash([1.5, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
  }

  for (const it of plan.items) {
    if (it.type !== 'stroke') continue;
    const full = it.full.map(css);
    const selected =
      highlight && highlight.glyphIndex === it.glyphIndex && highlight.strokeIndex === it.strokeIndex;
    const dim = Boolean(highlight) && !selected;
    const color = strokeColor(it.n - 1);

    // ends trimmed away by a bridge: faint, so the font's own path stays visible
    if (it.headCut > 0) drawRun(ctx, full.slice(0, it.headCut + 1), color, dim ? 0.12 : 0.3, 1.5, [2, 3]);
    if (it.tailCut < full.length - 1) drawRun(ctx, full.slice(it.tailCut), color, dim ? 0.12 : 0.3, 1.5, [2, 3]);

    // the pen path: index runs over the full stroke (a mid-entry walks the
    // head backwards first, then forwards again - that second pass is a retrace)
    const { path, idx, secondPass } = walkRuns(full, it.runs, it.entry);
    if (path.length === 1 || polylineLength(path) < 1.5) {
      ctx.save();
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(path[0][0], path[0][1], 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      const spans = retraceSpans(it, analysis.glyphs[it.glyphIndex]);
      const flag = (k) => {
        const lo = Math.min(idx[k - 1], idx[k]), hi = Math.max(idx[k - 1], idx[k]);
        if (secondPass[k]) return true;
        return spans.some(([s0, s1]) => lo >= s0 && hi <= s1);
      };
      let k = 1;
      while (k < path.length) {
        const f = flag(k);
        let e = k;
        while (e + 1 < path.length && flag(e + 1) === f) e++;
        drawRun(ctx, path.slice(k - 1, e + 1), color, dim ? 0.25 : 1, dim ? 2 : 2.6, f ? [5, 4] : null);
        k = e + 1;
      }
      if (showArrows && !dim) drawArrowheads(ctx, path, color);
    }

    if (showNumbers) drawBadge(ctx, path[0], it.n, color, dim);

    // the selected stroke shows its vertices: they can be dragged
    if (selected) {
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      for (const p of full) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    if (
      selected &&
      highlight.pointIndex != null &&
      highlight.pointIndex > 0 &&
      highlight.pointIndex < full.length - 1
    ) {
      const m = full[highlight.pointIndex];
      ctx.save();
      ctx.beginPath();
      ctx.arc(m[0], m[1], 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([2.5, 2.5]);
      ctx.stroke();
      ctx.restore();
    }
  }

  return layout;
}

/**
 * Walk index runs over canvas points, keeping each path point's index into
 * the full stroke and whether it belongs to a second pass over the head.
 */
function walkRuns(full, runs, entry) {
  const path = [], idx = [], secondPass = [];
  if (entry && entry.t > 0 && entry.seg + 1 < full.length) {
    const a = full[entry.seg], b = full[entry.seg + 1];
    path.push([a[0] + (b[0] - a[0]) * entry.t, a[1] + (b[1] - a[1]) * entry.t]);
    idx.push(entry.seg + entry.t);
    secondPass.push(false);
  }
  runs.forEach(([i0, i1], r) => {
    const step = i1 >= i0 ? 1 : -1;
    for (let i = i0; ; i += step) {
      const last = idx[idx.length - 1];
      if (last !== i) {
        path.push(full[i]);
        idx.push(i);
        secondPass.push(r > 0 && i <= runs[0][0]);
      }
      if (i === i1) break;
    }
  });
  return { path, idx, secondPass };
}

/**
 * Index spans [i1, i2] of the full stroke that the record marks as retraced.
 * Retraces are stored as coordinate pairs; the "to" point occurs after the
 * "from" point unless the stroke has been reversed since.
 */
function retraceSpans(it, glyph) {
  const spans = [];
  const recs = it.stroke.retraces || [];
  if (!recs.length) return spans;
  const pts = it.full;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  // the last vertex near a point (the pen may pass a junction more than once,
  // and a retrace starts where the pen turned back, its final visit)
  const lastNear = (p) => {
    let best = -1;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i][0] - p[0]) ** 2 + (pts[i][1] - p[1]) ** 2;
      if (d < 144) best = i; // within 12 font units
    }
    return best;
  };
  // the vertex about `len` further along the path
  const advance = (i1, len) => {
    let best = i1, bestErr = Infinity;
    for (let k = i1 + 1; k < pts.length; k++) {
      const err = Math.abs(cum[k] - cum[i1] - len);
      if (err < bestErr) { bestErr = err; best = k; }
      if (cum[k] - cum[i1] > len) break;
    }
    return best;
  };
  for (const r of recs) {
    const from = [r.from[0] + glyph.x, r.from[1] + glyph.y];
    const len = r.lengthFontUnits || 0;
    const i1 = lastNear(from);
    if (i1 < 0 || len <= 0) continue;
    // smoothing may have dropped the vertex at the retrace's end: measure instead
    const i2 = advance(i1, len);
    if (i2 > i1) spans.push([i1, i2]);
  }
  return spans;
}

function drawRun(ctx, pts, color, alpha, width, dash) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.restore();
}

/**
 * Nearest recovered stroke to a point in canvas CSS-pixel space, or null.
 * Lets the page turn a click on the debug view into a stroke selection.
 * `pointIndex` indexes the record's points (the full, untrimmed stroke).
 */
export function hitTestStroke(layout, analysis, x, y, maxDist = 14) {
  let best = null;
  let bestD = maxDist;
  for (const it of analysis.plan.items) {
    if (it.type !== 'stroke') continue;
    const pts = it.full.map((p) => [layout.originX + p[0] * layout.s, layout.baselineY - p[1] * layout.s]);
    for (let i = 1; i < pts.length; i++) {
      const { d, t } = distToSegment(x, y, pts[i - 1], pts[i]);
      if (d < bestD) {
        bestD = d;
        best = {
          glyphIndex: it.glyphIndex,
          strokeIndex: it.strokeIndex,
          pointIndex: t < 0.5 ? i - 1 : i,
        };
      }
    }
  }
  return best;
}

function distToSegment(x, y, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { d: Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)), t };
}

function drawArrowheads(ctx, pts, color) {
  const cum = cumulativeLengths(pts);
  const total = cum[cum.length - 1];
  if (total < 24) return;
  const spacing = Math.max(38, total / 7);
  ctx.save();
  ctx.fillStyle = color;
  for (let d = spacing * 0.6; d < total - 4; d += spacing) {
    const p = pointAtLength(pts, cum, d);
    const q = pointAtLength(pts, cum, Math.min(total, d + 4));
    const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const size = 6;
    ctx.save();
    ctx.translate(p[0], p[1]);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(size * 0.9, 0);
    ctx.lineTo(-size * 0.6, size * 0.55);
    ctx.lineTo(-size * 0.6, -size * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawBadge(ctx, at, n, color, dim) {
  const r = 9;
  ctx.save();
  ctx.globalAlpha = dim ? 0.35 : 1;
  ctx.beginPath();
  ctx.arc(at[0], at[1], r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), at[0], at[1] + 0.5);
  ctx.restore();
}
