/**
 * Stroke recovery pipeline: outline -> raster -> skeleton -> graph -> pen order.
 *
 * The product is a plain JSON record per glyph, in font units (y-up, origin on
 * the baseline at the glyph origin), which is the only thing downstream code
 * or a future AI-correction pass needs to care about. Rendering never reaches
 * back into the raster except through `raster`, which is transient and
 * deliberately not part of the record.
 */

import { rasterizeGlyph, rasterToFont, mapPolylineToRaster } from './raster.js';
import {
  zhangSuenThin,
  distanceTransform,
  strokeWidthStats,
  removeSmallComponents,
} from './thinning.js';
import { buildSkeletonGraph } from './graph.js';
import { orderStrokes } from './strokeOrder.js';
import { resample, smoothPreservingCorners, simplifyRDP, polylineLength, roundPts, cumulativeLengths } from './geometry.js';

export const RECORD_VERSION = 21;

/**
 * @param {{gid:number,name:string,path:string,bbox:object,xAdvance:number,chars:string}} glyph
 * @param {{unitsPerEm:number}} fontCtx
 * @param {{rasterEm?:number}} [opts]
 * @returns {{record: object, raster: object|null}}
 */
export function recoverGlyphStrokes(glyph, fontCtx, opts = {}) {
  const upem = fontCtx.unitsPerEm;
  const label = glyph.chars?.trim() ? `“${glyph.chars}” (${glyph.name})` : glyph.name;

  // Whitespace having no outline is expected, not an uncertainty - no note.
  if (glyph.isBlank || !glyph.path) {
    return { raster: null, record: emptyRecord(glyph, upem, label, null) };
  }

  const t0 = performance.now();
  const raster = rasterizeGlyph(glyph.path, glyph.bbox, {
    unitsPerEm: upem,
    rasterEm: opts.rasterEm ?? 512,
  });

  if (raster.fillCount < 8) {
    return { raster, record: emptyRecord(glyph, upem, label, 'outline rasterised to almost nothing') };
  }

  const { width: w, height: h, fill, scale } = raster;
  const emPx = upem * scale;

  // Anti-aliased hairlines shed stray islands; clear them before thinning so
  // they never become phantom components.
  raster.fillCount = removeSmallComponents(fill, w, h, Math.max(6, Math.round(emPx * 0.05)));

  const skel = zhangSuenThin(fill, w, h);
  const distMap = distanceTransform(fill, w, h);
  const widths = strokeWidthStats(distMap, skel);

  const graphOpts = {
    simplifyEps: 0.55,
    distMap,
    spurFactor: 2.2,
    maxSpurLength: emPx * 0.06,
    spurRounds: 3,
    minDotRadius: Math.max(2.5, widths.median * 0.55),
  };
  const graph = buildSkeletonGraph(skel, w, h, graphOpts);

  // A font built from overlapping contours carries a hint of how the letter
  // was drawn: each outer contour is one drawing gesture, and a pen follows
  // a gesture to its end before it turns off into another. Label every
  // skeleton edge with the contour whose ink it runs through, for the
  // pen-order search to lean on. (A contour is a hint, not a stroke: the
  // legs of an A are separate contours and one pen movement.)
  const contours = splitContours(glyph.path);
  let contourStrokes = 0;
  if (contours.outers.length >= 2) {
    const fills = [];
    for (const outer of contours.outers) {
      const part = rasterizeGlyph(outer + contours.counters.join(''), glyph.bbox, {
        unitsPerEm: upem,
        rasterEm: opts.rasterEm ?? 512,
      });
      fills.push(part.fill);
    }
    for (const e of graph.edges) {
      const counts = new Array(fills.length).fill(0);
      for (const p of e.pts) {
        const x = Math.round(p[0]), y = Math.round(p[1]);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        fills.forEach((f, k) => { if (f[y * w + x]) counts[k]++; });
      }
      let best = -1, bestN = 0;
      counts.forEach((n, k) => { if (n > bestN) { bestN = n; best = k; } });
      e.contour = bestN > 0 ? best : -1;
    }
    contourStrokes = fills.length;
  }

  const chars = glyph.chars?.trim() ?? '';
  const lowercase = chars.length > 0 && chars === chars.toLowerCase() && chars !== chars.toUpperCase();
  const { strokes: ordered, notes, debug: orderDebug } = orderStrokes(graph, {
    em: emPx,
    label,
    chars,
    lowercase,
    medianRadius: Math.max(widths.median, 0.5),
    // the glyph's bbox in raster px, for letterform templates
    frame: { x0: raster.pad, y0: raster.pad, w: w - 2 * raster.pad, h: h - 2 * raster.pad },
  });
  if (contourStrokes) {
    notes.push({
      severity: 'info',
      code: 'contours',
      message: `${label}: the outline is ${contourStrokes} overlapping contours; the pen prefers to follow one to its end before turning off into another`,
    });
  }

  // --- smooth and thin out, still in raster space --------------------------
  // Thinning leaves a pixel-staircase wobble; average it out over about
  // 0.03 em, then keep the curve dense enough to still look like a curve.
  const step = Math.max(1.5, emPx * 0.004);
  const rdpEps = Math.max(0.3, emPx * 0.0012);
  const minLen = Math.max(emPx * 0.03, widths.p85 * 1.8);

  const rasterStrokes = [];
  const kept = [];
  const perComponent = new Map();
  // A component with a substantial stroke does not also need its crumbs:
  // short leftover edges at crossings are noise the pen would never write.
  const longestByComp = new Map();
  for (const s of ordered) {
    longestByComp.set(s.comp, Math.max(longestByComp.get(s.comp) ?? 0, s.inkLength ?? s.length));
  }
  for (const s of ordered) {
    let pts = s.pts;
    if (!s.tittle && polylineLength(pts) > step * 2) {
      pts = resample(pts, step);
      // heavy smoothing between corners (about ±0.02 em), none across them
      pts = smoothPreservingCorners(pts, 6, 5, 60, 3);
      // inside a knot the skeleton is an artefact: take the smoothest path through
      pts = blendKnots(pts, distMap, raster.width, raster.height, emPx);
      pts = simplifyRDP(pts, rdpEps);
    }
    const len = polylineLength(pts);
    if (pts.length < 2) continue;
    // The min-length filter exists to drop fragments of a letter body. Dots
    // and accents are meant to be short, so they only face a hard floor.
    const isMark = s.tittle || s.role === 'dot' || s.role === 'accent';
    const crumb = !isMark && len < emPx * 0.1 && (longestByComp.get(s.comp) ?? 0) > emPx * 0.5;
    if (len < (isMark ? emPx * 0.004 : minLen) || crumb) continue;

    const seen = perComponent.get(s.comp) ?? { count: 0, min: s.minStrokes ?? 1 };
    seen.count++;
    perComponent.set(s.comp, seen);

    rasterStrokes.push(pts);
    kept.push(s);
  }

  if (!rasterStrokes.length) {
    return { raster, record: emptyRecord(glyph, upem, label, 'no centreline survived thinning') };
  }

  // Mask pen must be at least as fat as the thickest place in the glyph,
  // otherwise the reveal leaves ink behind.
  const penWidthPx = Math.max(2, widths.max * 2 * 1.15);

  // Pruning and smoothing can leave real ink (typically a stem's tapered
  // tail) beyond the pen's reach; it would pop in when its stroke completes.
  // Send the pen there and back instead.
  const repairs = repairCoverage(rasterStrokes, raster, penWidthPx, emPx, distMap);
  for (const rep of repairs) {
    notes.push({
      severity: 'info',
      code: 'tail-retrace',
      message: `${label}: the pen path was extended into an ink ${
        rep.kind
      } (${rep.pixels}px of ink lay beyond the pen's reach and would have appeared abruptly)`,
      at: rep.at,
    });
  }

  // --- lift into font units ------------------------------------------------
  const toFont = (p) => rasterToFont(raster, p[0], p[1]);
  const strokes = rasterStrokes.map((pts, i) => ({
    index: i,
    role: kept[i].role,
    component: kept[i].comp,
    lengthFontUnits: round(polylineLength(pts) / scale, 2),
    // ink thickness where the pen lands and leaves - the word-level bridges
    // between letters are drawn at this width
    startWidth: round(inkWidthAt(distMap, raster, pts, false) / scale, 1),
    endWidth: round(inkWidthAt(distMap, raster, pts, true) / scale, 1),
    // spans where the pen doubles back over ink it has just written; kept as
    // coordinates (not indices) so smoothing and editing cannot invalidate them
    retraces: (kept[i].retraces || []).map((r) => ({
      from: roundPts([toFont(r.from)], 1)[0],
      to: roundPts([toFont(r.to)], 1)[0],
      lengthFontUnits: round(r.length / scale, 1),
    })),
    points: roundPts(pts.map(toFont), 2),
  }));

  for (const [, { count, min }] of perComponent) {
    if (count <= min) continue;
    notes.push({
      severity: 'info',
      code: 'stroke-count',
      message: `${label}: written as ${count} strokes although ${min} would suffice topologically - the smoothest-continuation walk chose to lift the pen`,
      at: null,
    });
  }

  const record = {
    version: RECORD_VERSION,
    source: 'heuristic',
    gid: glyph.gid,
    name: glyph.name,
    chars: glyph.chars,
    unitsPerEm: upem,
    advance: glyph.xAdvance,
    bbox: {
      x1: round(glyph.bbox.x1, 2), y1: round(glyph.bbox.y1, 2),
      x2: round(glyph.bbox.x2, 2), y2: round(glyph.bbox.y2, 2),
    },
    penWidth: round(penWidthPx / scale, 2),
    strokes,
    notes: notes.map((n) => ({
      severity: n.severity,
      code: n.code,
      message: n.message,
      at: n.at ? roundPts([rasterToFont(raster, n.at[0], n.at[1])], 1)[0] : null,
    })),
    stats: {
      rasterWidth: w,
      rasterHeight: h,
      rasterScale: round(scale, 4),
      inkPixels: raster.fillCount,
      skeletonPixels: widths.count,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      components: graph.components.length,
      strokeWidthPx: { median: round(widths.median * 2, 2), max: round(widths.max * 2, 2) },
      coverageRepairs: repairs.length,
      msElapsed: round(performance.now() - t0, 1),
      // why this pen order won: the top candidates per component with their
      // score terms (raster px), for tuning the heuristics
      candidates: orderDebug,
    },
  };

  return { record, raster, rasterStrokes };
}

/**
 * Coverage repair: find ink the round pen would never pass over, and splice a
 * there-and-back detour into the nearest stroke so the pen visits it.
 *
 * The classic case is a stem's tapered tail: its skeleton branch reads as a
 * prunable spur, so the centreline stops short and the tail would otherwise
 * pop in the moment its stroke completes. A human pen dips into the taper and
 * comes back out - that is exactly the path this reconstructs. Mutates
 * `strokesPx` in place; returns one entry per repair for the log.
 */
function repairCoverage(strokesPx, raster, penWidthPx, emPx, distMap) {
  const { width: w, height: h, fill } = raster;

  // Paint the pen's coverage with the same stroker the animation uses.
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.strokeStyle = cx.fillStyle = '#000';
  cx.lineWidth = penWidthPx;
  cx.lineCap = 'round';
  cx.lineJoin = 'round';
  for (const pts of strokesPx) {
    cx.beginPath();
    cx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) cx.lineTo(pts[i][0], pts[i][1]);
    cx.stroke();
  }
  const covered = cx.getImageData(0, 0, w, h).data;

  const missed = new Uint8Array(w * h);
  let missedCount = 0;
  for (let i = 0; i < missed.length; i++) {
    if (fill[i] && covered[i * 4 + 3] < 40) {
      missed[i] = 1;
      missedCount++;
    }
  }
  if (!missedCount) return [];

  const minBlob = 24;
  const maxReach = emPx * 0.3;
  const repairs = [];
  const seen = new Uint8Array(w * h);
  const stack = [];

  for (let start = 0; start < missed.length; start++) {
    if (!missed[start] || seen[start]) continue;

    // flood-fill one blob of missed ink
    const blob = [];
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      blob.push(p);
      const px = p % w, py = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (missed[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    if (blob.length < minBlob) continue;

    // nearest stroke vertex = where the pen leaves its path to visit the blob
    let best = null;
    for (let si = 0; si < strokesPx.length; si++) {
      const pts = strokesPx[si];
      for (let vi = 0; vi < pts.length; vi++) {
        const [vx, vy] = pts[vi];
        for (let bi = 0; bi < blob.length; bi += 3) {
          const bx = blob[bi] % w, by = (blob[bi] / w) | 0;
          const d2 = (bx - vx) ** 2 + (by - vy) ** 2;
          if (!best || d2 < best.d2) best = { si, vi, d2 };
        }
      }
    }
    if (!best) continue;

    const pts = strokesPx[best.si];
    const v = pts[best.vi];
    // aim for the far extremity of the blob so the whole taper is covered
    let tip = null, tipD2 = -1;
    for (const p of blob) {
      const bx = p % w, by = (p / w) | 0;
      const d2 = (bx - v[0]) ** 2 + (by - v[1]) ** 2;
      if (d2 > tipD2) { tipD2 = d2; tip = [bx, by]; }
    }
    if (Math.sqrt(tipD2) > maxReach) continue; // suspicious - leave it alone

    // A sliver, a pointed corner, or the outer bulge of a wedge where two
    // strokes merge - things a round nib simply rounds off - are not worth a
    // detour: the pen would visibly spike into them and back. Only a body of
    // ink as thick as the stroke it hangs off (a foot, a heavy tail) earns one.
    let blobMax = 0;
    for (const p of blob) if (distMap[p] > blobMax) blobMax = distMap[p];
    const localR = Math.max(1, distMap[Math.round(v[1]) * w + Math.round(v[0])] || 0);
    if (blobMax < 0.9 * localR) continue;

    // pull the target back from the ink edge so the round cap just covers it
    const reach = Math.sqrt(tipD2) || 1;
    const inset = Math.min(penWidthPx * 0.25, reach * 0.5);
    const target = [
      tip[0] + ((v[0] - tip[0]) / reach) * inset,
      tip[1] + ((v[1] - tip[1]) / reach) * inset,
    ];

    const leg = [];
    const legLen = Math.hypot(target[0] - v[0], target[1] - v[1]);
    const n = Math.max(2, Math.ceil(legLen / 3));
    for (let k = 1; k <= n; k++) {
      leg.push([v[0] + ((target[0] - v[0]) * k) / n, v[1] + ((target[1] - v[1]) * k) / n]);
    }

    if (best.vi === pts.length - 1) {
      pts.push(...leg); // stroke ends in the taper
    } else if (best.vi === 0) {
      pts.unshift(...[...leg].reverse()); // stroke starts at the taper tip
    } else {
      const back = leg.slice(0, -1).reverse();
      back.push([v[0], v[1]]);
      pts.splice(best.vi + 1, 0, ...leg, ...back); // there and back again
    }

    repairs.push({ kind: 'taper', pixels: blob.length, at: [v[0], v[1]] });
  }

  return repairs;
}

/** Full ink width (raster px) around one end of a polyline, from the distance map. */
function inkWidthAt(distMap, raster, pts, atEnd) {
  const { width: w, height: h } = raster;
  let best = 0;
  const n = Math.min(4, pts.length);
  for (let k = 0; k < n; k++) {
    const p = atEnd ? pts[pts.length - 1 - k] : pts[k];
    const x = Math.round(p[0]), y = Math.round(p[1]);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    best = Math.max(best, distMap[y * w + x]);
  }
  return best * 2;
}

/** Re-derive raster-space polylines from a record (e.g. one restored from cache). */
export function rasterStrokesFromRecord(record, raster) {
  return record.strokes.map((s) => mapPolylineToRaster(raster, s.points));
}

function emptyRecord(glyph, upem, label, reason) {
  return {
    version: RECORD_VERSION,
    source: 'heuristic',
    gid: glyph.gid,
    name: glyph.name,
    chars: glyph.chars,
    unitsPerEm: upem,
    advance: glyph.xAdvance,
    bbox: glyph.bbox,
    penWidth: 0,
    strokes: [],
    notes: reason
      ? [{ severity: 'info', code: 'empty', message: `${label}: ${reason}`, at: null }]
      : [],
    stats: {},
  };
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/**
 * Inside a knot - where two or three strokes merge into one blob of ink and
 * the distance map reads far wider than the stroke's own half-width - the
 * skeleton is an artefact of thinning: it detours through the blob's centre,
 * or runs along the other stroke for a while (the hook of an `A` arriving on
 * the crossbar and only then turning up into the eye). Any curve inside the
 * blob is inside ink, so the pen is free to take the smoothest one: a cubic
 * blend on the entry and exit directions. The blend starts and ends a little
 * outside the knot, where the skeleton is undisturbed - taken right at its
 * edge, the entry and exit already lean into the blob and the blend has to
 * snake between them. Knots close together blend as one. A run that touches
 * a stroke's end, is longer than a third of an em, or contains a reversal (a
 * retrace turning inside the knot) is left as it is.
 */
function blendKnots(pts, distMap, w, h, emPx) {
  const n = pts.length;
  if (n < 4) return pts;
  const cum = cumulativeLengths(pts);
  const at = (p) => {
    const x = Math.round(p[0]), y = Math.round(p[1]);
    return x < 0 || y < 0 || x >= w || y >= h ? 0 : distMap[y * w + x];
  };
  const d = pts.map(at);
  // the stroke's own half-width: the median within ±0.15 em of path, which
  // neither a knot nor a thin neck (both much shorter than that) can move
  const win = emPx * 0.15;
  const nominal = new Float64Array(n);
  const buf = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let j = i; j >= 0 && cum[i] - cum[j] <= win; j--) buf.push(d[j]);
    for (let j = i + 1; j < n && cum[j] - cum[i] <= win; j++) buf.push(d[j]);
    buf.sort((p, q) => p - q);
    nominal[i] = buf[buf.length >> 1];
  }
  const knot = new Uint8Array(n);
  for (let i = 0; i < n; i++) knot[i] = d[i] > 1.2 * nominal[i] + 1 ? 1 : 0;

  // knot runs, each widened by a margin on both sides, merged where they meet
  const margin = emPx * 0.04;
  const runs = [];
  for (let i = 0; i < n; ) {
    if (!knot[i]) { i++; continue; }
    let j = i;
    while (j < n && knot[j]) j++;
    let a = i - 1, b = j;
    while (a > 1 && cum[i] - cum[a] < margin) a--;
    while (b < n - 2 && cum[b] - cum[j - 1] < margin) b++;
    const last = runs[runs.length - 1];
    if (last && a <= last.b) last.b = Math.max(last.b, b);
    else runs.push({ a, b, touchesEnd: i === 0 || j >= n });
    i = j;
  }

  const unit = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const turnAt = (k) => {
    const p = pts[k - 1], q = pts[k], r = pts[k + 1];
    const u = unit([q[0] - p[0], q[1] - p[1]]), v = unit([r[0] - q[0], r[1] - q[1]]);
    return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
  };
  // direction over about 0.02 em ending at k (or starting there)
  const dirInto = (k) => { let j = k; while (j > 0 && cum[k] - cum[j] < emPx * 0.02) j--; return unit([pts[k][0] - pts[j][0], pts[k][1] - pts[j][1]]); };
  const dirOut = (k) => { let j = k; while (j < n - 1 && cum[j] - cum[k] < emPx * 0.02) j++; return unit([pts[j][0] - pts[k][0], pts[j][1] - pts[k][1]]); };

  const out = [];
  let next = 0; // first original index not yet emitted
  for (const run of runs) {
    const { a, b } = run;
    if (run.touchesEnd || a < 1 || b > n - 2 || a >= b - 1) continue;
    const runLen = cum[b] - cum[a];
    let reversal = false;
    for (let k = a + 1; k < b; k++) if (turnAt(k) > (100 * Math.PI) / 180) { reversal = true; break; }
    if (reversal || runLen > emPx * 0.34) continue;
    const pa = pts[a], pb = pts[b];
    const ta = dirInto(a), tb = dirOut(b);
    // the tip of a loop is thick too, but the pen turns right round there:
    // that is a shape, not a knot
    if (ta[0] * tb[0] + ta[1] * tb[1] < Math.cos((110 * Math.PI) / 180)) continue;
    for (let k = next; k <= a; k++) out.push(pts[k]);
    const m = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const steps = Math.max(2, Math.ceil(runLen / Math.max(1, emPx * 0.01)));
    for (let k = 1; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push([
        h00 * pa[0] + h10 * ta[0] * m + h01 * pb[0] + h11 * tb[0] * m,
        h00 * pa[1] + h10 * ta[1] * m + h01 * pb[1] + h11 * tb[1] * m,
      ]);
    }
    next = b;
  }
  for (let k = next; k < n; k++) out.push(pts[k]);
  return out;
}

/**
 * The outline's contours, told apart into outer contours and counters (the
 * holes of an o or an e): the largest contour is certainly an outer one, and
 * a counter winds the other way.
 */
function splitContours(pathData) {
  const parts = pathData.match(/M[^M]*/g) || [];
  const areaOf = (d) => {
    const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g)?.map(Number) || [];
    let area = 0;
    for (let i = 0; i + 3 < nums.length; i += 2) area += nums[i] * nums[i + 3] - nums[i + 2] * nums[i + 1];
    return area / 2;
  };
  const areas = parts.map(areaOf);
  let big = 0;
  for (let i = 1; i < areas.length; i++) if (Math.abs(areas[i]) > Math.abs(areas[big])) big = i;
  const outerSign = Math.sign(areas[big] || 1);
  const outers = [], counters = [];
  parts.forEach((d, i) => { (Math.sign(areas[i]) === outerSign || areas[i] === 0 ? outers : counters).push(d); });
  return { outers, counters };
}

