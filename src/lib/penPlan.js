/**
 * Word-level pen plan.
 *
 * Glyph records say how each letter is written on its own. This layer decides
 * how the pen moves through the whole word: the order strokes are visited,
 * where the pen lifts, and where it flows straight from one letter into the
 * next, where a hand would never lift.
 *
 * Two ways of joining consecutive strokes:
 *   - trim: the exit hairline of one letter and the entry hairline of the
 *     next overlap or nearly touch. Both are cut back to the pair of points
 *     the pen can pass between most naturally and joined with a short
 *     Hermite curve; the trimmed hairline ink is still revealed (it lies
 *     within the pen's width).
 *   - mid-entry: the previous stroke lands on the next stroke's body rather
 *     than on a hairline (an exit swash meeting an 'l' mid-stem). The pen
 *     enters there, writes back to the stroke's start (up the stem), retraces
 *     to the entry point and carries on - exactly what a hand does.
 *
 * Dots, accents and crossbars are written after their word, left to right.
 *
 * Everything here is derived from the records and is recomputed freely; it
 * is never cached and never mutates a record.
 */

import { leadingTangent, trailingTangent, cumulativeLengths, polylineLength } from './geometry.js';
import { fontToRaster } from './raster.js';
import { inkWidthAt } from './snap.js';

const MARK_ROLES = new Set(['dot', 'accent', 'crossbar']);

/**
 * @param {Array} glyphs  analysis glyphs (record + position)
 * @param {{connect?:boolean, maxGapEm?:number, trimWindowEm?:number, entryWindowEm?:number, minFlow?:number}} opts
 */
export function buildPenPlan(glyphs, opts = {}) {
  const {
    connect = true,
    maxGapEm = 0.14,      // largest gap the pen will bridge
    trimWindowEm = 0.22,  // a head/tail shorter than this is a hairline: skip it
    entryWindowEm = 0.9,  // how far along a stroke the pen may enter mid-way
    minFlow = 0.15,       // tangents must at least loosely agree with the join
  } = opts;
  const upem = glyphs.find((g) => g.record)?.record.unitsPerEm || 1000;
  const cfg = {
    maxGap: maxGapEm * upem,
    trimWindow: trimWindowEm * upem,
    entryWindow: entryWindowEm * upem,
    minFlow,
  };
  const items = [];
  const bridges = [];
  const notes = [];
  let chain = -1;

  splitWords(glyphs).forEach((word, wordIndex) => {
    const bodies = [];
    const marks = [];
    for (const gi of word) {
      const g = glyphs[gi];
      g.record.strokes.forEach((s, si) => {
        (MARK_ROLES.has(s.role) ? marks : bodies).push(strokeEntry(g, gi, si, s, wordIndex));
      });
    }
    marks.sort((a, b) => a.minX - b.minX);

    let prev = null;
    for (const e of bodies) {
      let bridge = null;
      if (connect && prev) {
        bridge = tryBridge(prev, e, cfg);
        if (bridge) {
          bridge.chain = chain;
          bridge.word = wordIndex;
          items.push(bridge);
          bridges.push(bridge);
          notes.push({
            severity: 'info',
            code: 'bridge',
            glyphIndex: prev.glyphIndex,
            message: bridge.to.entryAt != null
              ? `${prev.label} → ${e.label}: the pen flows straight on, landing mid-stroke (gap ${bridge.gap}u); it writes back to the stroke's start first, retraces, and carries on`
              : `${prev.label} → ${e.label}: the pen flows straight on (gap ${bridge.gap}u, hairlines trimmed ${bridge.from.trimmed}u / ${bridge.to.trimmed}u to meet smoothly)`,
          });
        } else if (prev.glyphIndex !== e.glyphIndex) {
          const a = prev.full[prev.tailCut], b = e.full[e.headCut];
          const gap = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (gap < 0.35 * upem) {
            notes.push({
              severity: 'info',
              code: 'lift',
              glyphIndex: prev.glyphIndex,
              message: `${prev.label} → ${e.label}: the pen lifts (endpoints ${Math.round(gap)}u apart, but the strokes do not flow into each other)`,
            });
          }
        }
      }
      if (!bridge) chain++;
      e.chain = chain;
      items.push(e);
      prev = e;
    }
    for (const m of marks) {
      chain++;
      m.chain = chain;
      items.push(m);
    }
  });

  // Cuts are final now: derive each stroke's pen path and number the strokes.
  const penOrder = [];
  let n = 0;
  for (const it of items) {
    if (it.type !== 'stroke') continue;
    if (it.entryAt != null) {
      it.runs = [[it.entryAt, 0], [0, it.tailCut]];
      it.entry = { seg: it.entryAt, t: it.entryT || 0 };
    } else {
      it.runs = [[it.headCut, it.tailCut]];
      it.entry = null;
    }
    it.points = pathFromRuns(it.full, it.runs, it.entry);
    it.n = ++n;
    penOrder.push({
      n,
      glyphIndex: it.glyphIndex,
      strokeIndex: it.strokeIndex,
      role: it.role,
      length: it.stroke.lengthFontUnits,
      chain: it.chain,
    });
  }

  return { items, bridges, notes, penOrder, connect };
}

/**
 * Concatenate index runs of `pts`; a run [i0, i1] is walked in either
 * direction. `entry` = {seg, t} starts the path part-way along segment
 * seg→seg+1 (a mid-stroke landing) before the first run begins at seg.
 */
export function pathFromRuns(pts, runs, entry = null) {
  const out = [];
  if (entry && entry.t > 0 && entry.seg + 1 < pts.length) {
    const a = pts[entry.seg], b = pts[entry.seg + 1];
    out.push([a[0] + (b[0] - a[0]) * entry.t, a[1] + (b[1] - a[1]) * entry.t]);
  }
  for (const [i0, i1] of runs) {
    const step = i1 >= i0 ? 1 : -1;
    for (let i = i0; ; i += step) {
      const p = pts[i];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
      if (i === i1) break;
    }
  }
  return out;
}

/** Glyph indices grouped into words; whitespace splits, empty glyphs are skipped. */
function splitWords(glyphs) {
  const words = [];
  let cur = [];
  glyphs.forEach((g, gi) => {
    if (g.isBlank) {
      if (cur.length) words.push(cur);
      cur = [];
      return;
    }
    if (g.record?.strokes?.length) cur.push(gi);
  });
  if (cur.length) words.push(cur);
  return words;
}

function labelOf(g) {
  return g.chars?.trim() || g.name;
}

function strokeEntry(g, gi, si, s, word) {
  const full = s.points.map((p) => [p[0] + g.x, p[1] + g.y]);
  let minX = Infinity;
  for (const p of full) if (p[0] < minX) minX = p[0];
  return {
    type: 'stroke',
    word,
    glyphIndex: gi,
    strokeIndex: si,
    role: s.role,
    stroke: s,
    record: g.record,
    glyph: g,
    label: labelOf(g),
    full,                        // whole stroke, word coordinates
    headCut: 0,                  // points before this were trimmed away (hairline)
    tailCut: full.length - 1,    // points after this were trimmed away
    entryAt: null,               // segment where the pen enters mid-stroke, if it does
    entryT: 0,                   // ...and how far along that segment
    entry: null,                 // {seg, t} for pathFromRuns, once cuts are final
    runs: null,                  // index runs the pen walks, once cuts are final
    points: null,                // the pen path, once cuts are final
    minX,
    chain: -1,
    n: 0,
  };
}

/**
 * Best way for the pen to get from the tail of `prev` onto `next`. Candidate
 * pairs are scored on gap, agreement with the direction of travel, and how
 * much hairline is skipped or stem is retraced. Returns a bridge item and
 * records the cuts on both entries, or null when the strokes do not flow.
 */
function tryBridge(prev, next, { maxGap, trimWindow, entryWindow, minFlow }) {
  const P = prev.full, Q = next.full;
  const pc = cumulativeLengths(P), qc = cumulativeLengths(Q);
  const b0 = prev.tailCut;

  let iMin = b0;
  while (iMin - 1 >= prev.headCut + 1 && pc[b0] - pc[iMin - 1] <= trimWindow) iMin--;
  let jMax = 0;
  while (jMax + 1 <= next.tailCut - 1 && qc[jMax + 1] <= entryWindow) jMax++;

  const tangentOut = new Map(); // direction the pen travels after entering at j
  const entering = (j) => {
    let t = tangentOut.get(j);
    if (!t) {
      if (qc[j] <= trimWindow) {
        t = leadingTangent(Q.slice(j), 12);
      } else {
        const back = trailingTangent(Q.slice(0, j + 1), 12); // arriving at j from the start
        t = [-back[0], -back[1]];                             // so the pen heads back toward it
      }
      tangentOut.set(j, t);
    }
    return t;
  };

  const consider = (state, i, ti, trimP, target, arc, tj, midEntry, j, t) => {
    const dx = target[0] - P[i][0], dy = target[1] - P[i][1];
    const d = Math.hypot(dx, dy);
    if (d > maxGap) return state;
    const u = d > 1e-6 ? [dx / d, dy / d] : ti;
    // landing mid-stroke the pen turns after touching down, so only the
    // approach counts; joining a hairline both ends must agree with the hop
    const flow = midEntry
      ? ti[0] * u[0] + ti[1] * u[1]
      : (ti[0] * u[0] + ti[1] * u[1] + u[0] * tj[0] + u[1] * tj[1]) / 2;
    if (flow < minFlow) return state;
    // A kink costs far more than distance: two parallel hairlines a little
    // apart are joined by a long shallow S, not a short jog. Skipping a
    // hairline costs a little; writing a stem twice a little more.
    const headCost = midEntry ? 0.25 * trimWindow + 0.15 * (arc - trimWindow) : 0.25 * arc;
    const cost = 0.2 * d + 150 * (1 - flow) + 0.25 * trimP + headCost;
    if (state && cost >= state.cost) return state;
    return { i, j, t, d, flow, cost, ti, tj, trimP, midEntry, target };
  };

  let best = null;
  for (let i = b0; i >= iMin; i--) {
    const ti = trailingTangent(P.slice(0, i + 1), 12);
    const trimP = pc[b0] - pc[i];
    for (let j = 0; j <= jMax; j++) {
      // the vertex itself
      best = consider(best, i, ti, trimP, Q[j], qc[j], entering(j), qc[j] > trimWindow, j, 0);
      // and, for a mid-entry, the closest point along the segment after it -
      // a straight stem has few vertices, and the pen should land on the
      // stem exactly where the previous stroke arrives
      if (j + 1 > next.tailCut) continue;
      const sx = Q[j + 1][0] - Q[j][0], sy = Q[j + 1][1] - Q[j][1];
      const l2 = sx * sx + sy * sy;
      if (l2 < 1e-6) continue;
      let t = ((P[i][0] - Q[j][0]) * sx + (P[i][1] - Q[j][1]) * sy) / l2;
      if (t <= 0.02 || t >= 0.98) continue;
      const arc = qc[j] + t * Math.sqrt(l2);
      if (arc <= trimWindow || arc > entryWindow) continue;
      const len = Math.sqrt(l2);
      const tj = [-sx / len, -sy / len]; // heading back toward the stroke's start
      best = consider(best, i, ti, trimP, [Q[j][0] + t * sx, Q[j][1] + t * sy], arc, tj, true, j, t);
    }
  }
  if (!best) return null;

  const p0 = P[best.i], p1 = best.target;
  const m = Math.max(best.d, 1);
  const points = hermite(
    p0, [best.ti[0] * m, best.ti[1] * m],
    p1, [best.tj[0] * m, best.tj[1] * m],
    Math.max(3, Math.ceil(best.d / 6))
  );
  prev.tailCut = best.i;
  if (best.midEntry) {
    next.entryAt = best.j;
    next.entryT = best.t;
  } else {
    next.headCut = best.j;
  }

  const fallback = (rec) => (rec.penWidth || 40) * 0.4;
  const w0 = prev.stroke.endWidth || fallback(prev.record);
  let w1 = next.stroke.startWidth || fallback(next.record);
  if (best.midEntry) {
    // the ink's width where the pen lands on the stem
    const g = next.glyph;
    const r = g?.raster;
    if (r) {
      const at = fontToRaster(r, p1[0] - g.x, p1[1] - g.y);
      const wIn = inkWidthAt(r, at) / r.scale;
      w1 = wIn > 0 ? wIn : w0;
    } else w1 = w0;
  }

  return {
    type: 'bridge',
    points,
    width: Math.max(2, Math.min(w0, w1)),
    widthFrom: Math.max(2, w0), // the painted bridge tapers from one ink width to the other
    widthTo: Math.max(2, w1),
    from: { glyphIndex: prev.glyphIndex, strokeIndex: prev.strokeIndex, trimmed: round1(best.trimP) },
    to: {
      glyphIndex: next.glyphIndex,
      strokeIndex: next.strokeIndex,
      trimmed: best.midEntry ? 0 : round1(qc[best.j]),
      entryAt: best.midEntry ? best.j + Math.round(best.t * 100) / 100 : null,
    },
    gap: round1(best.d),
    flow: Math.round(best.flow * 100) / 100,
    chain: -1,
  };
}

function hermite(p0, m0, p1, m1, n) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    out.push([
      h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0],
      h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1],
    ]);
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;

/** Compact, JSON-friendly view of the plan for the data panel. */
export function planToJSON(plan) {
  return {
    connect: plan.connect,
    penOrder: plan.penOrder,
    bridges: plan.bridges.map((b) => ({
      from: b.from,
      to: b.to,
      gap: b.gap,
      flow: b.flow,
      width: round1(b.width),
      lengthFontUnits: round1(polylineLength(b.points)),
      points: b.points.map((p) => [round1(p[0]), round1(p[1])]),
    })),
  };
}
