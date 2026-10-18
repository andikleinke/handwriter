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
 *     to the entry point and carries on - what a monoline hand does.
 *
 * A pointed pen never pushes up a shade. Where a letter's exit hairline runs
 * into the next letter's shade (Copperplate joins every stem and oval that
 * way), the hairline is written up to the shade's edge and the pen lifts:
 * the next letter is then written from the top of its own stroke, and the
 * hairline's tip, hidden under the shade, appears with the shade. A hairline
 * that meets the next letter's own entry hairline still flows straight on.
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
const LOOP_GAP_EM = 0.08; // a stroke whose start lies this close to a mid-stroke landing is entered as a loop: run backwards to its start, then on
const LOOP_HEAD_EM = 0.03; // ...and what the loop leaves out before its closing point must be no more than this: a crossing is not a loop
const LOOP_LEAD_EM = 0.35; // ...and the stroke must lead on this far past the landing (an e's eye into its bowl)...
const LOOP_AWAY_EM = 0.15; // ...and by this far past it have left the loop by LOOP_AWAY_BY: an o runs on along its own bowl, and is worse entered as a loop
const LOOP_AWAY_BY = 0.05;
const LOOP_CLOSE_EM = 0.25; // a head is a loop when the stroke's start lies within LOOP_GAP_EM of the path again within this much path past the landing
const LOOP_MAX_EM = 0.45;   // ...and a loop entered this way is an eye, a small loop (an e's is 0.23 em; an o's bowl, 0.75 em, reads worse run backwards)

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
    loopGapEm = LOOP_GAP_EM, // 0 turns loop entries off
  } = opts;
  const upem = glyphs.find((g) => g.record)?.record.unitsPerEm || 1000;
  const cfg = {
    maxGap: maxGapEm * upem,
    trimWindow: trimWindowEm * upem,
    entryWindow: entryWindowEm * upem,
    loopGap: loopGapEm * upem,
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

    // the stroke a letter hands over from is the one ending on its exit
    // hairline (a t's flag, written after the exit, is not it): the tail
    // nearest the exit the recovery found, else the rightmost tail
    const exitOf = new Map();
    const tailScore = (e) => {
      const t = e.full[e.tailCut];
      const ex = e.record?.stats?.hand?.exit;
      if (ex) return -Math.hypot(t[0] - (ex[0] + e.glyph.x), t[1] - (ex[1] + e.glyph.y));
      return t[0] - 1e6;
    };
    for (const e of bodies) {
      const cur = exitOf.get(e.glyphIndex);
      if (!cur || tailScore(e) > tailScore(cur)) exitOf.set(e.glyphIndex, e);
    }
    let prev = null;
    for (const e of bodies) {
      let bridge = null;
      if (prev && prev.glyphIndex !== e.glyphIndex) prev = exitOf.get(prev.glyphIndex) || prev;
      if (connect && prev) {
        const pointed = !!e.record?.stats?.hand?.pointed;
        if (pointed && prev.glyphIndex !== e.glyphIndex) tuckTail(prev, e, cfg);
        bridge = tryBridge(prev, e, cfg, !pointed, pointed);
        if (bridge) {
          bridge.chain = chain;
          bridge.word = wordIndex;
          items.push(bridge);
          bridges.push(bridge);
          notes.push({
            severity: 'info',
            code: 'bridge',
            glyphIndex: prev.glyphIndex,
            message: bridge.to.loop
              ? `${prev.label} → ${e.label}: the pen flows straight on into the ${e.label}'s loop (gap ${bridge.gap}u), runs it the way it arrived back round to its start, and carries on`
              : bridge.to.entryAt != null
              ? `${prev.label} → ${e.label}: the pen flows straight on, landing mid-stroke (gap ${bridge.gap}u); it writes back to the stroke's start first, retraces, and carries on`
              : `${prev.label} → ${e.label}: the pen flows straight on (gap ${bridge.gap}u, hairlines trimmed ${bridge.from.trimmed}u / ${bridge.to.trimmed}u to meet smoothly)`,
          });
        } else if (prev.glyphIndex !== e.glyphIndex) {
          const a = prev.full[prev.tailCut], b = e.full[e.headCut];
          const gap = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (prev.tucked) {
            notes.push({
              severity: 'info',
              code: 'lift-join',
              glyphIndex: prev.glyphIndex,
              message: `${prev.label} → ${e.label}: the hairline runs under the ${e.label}'s shade (${Math.round(prev.tucked)}u of it hidden until the shade is written); the pen lifts at the shade's edge and writes the ${e.label} from the top of its stroke`,
            });
          } else if (gap < 0.35 * upem) {
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
    derivePath(it);
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
 * The pen path of one stroke item, from its record and its cuts. Split out so
 * the editor can refresh a single item while a point is being dragged, without
 * re-planning the whole word on every pointer move.
 */
export function derivePath(it) {
  const g = it.glyph;
  it.full = it.stroke.points.map((p) => [p[0] + g.x, p[1] + g.y]);
  const last = it.full.length - 1;
  it.tailCut = Math.min(it.tailCut, last);
  it.headCut = Math.min(it.headCut, it.tailCut);
  if (it.entryAt != null && it.entryAt <= last) {
    if (it.loopEntry) {
      // the head closes a loop back next to the landing: the pen runs it
      // backwards to where it closes and continues from just past the
      // landing, so the loop is drawn once, the way the tail arrived. The
      // stroke's own entry before the closing point (an e's entry stub) is
      // what the tail replaced, and is left out
      const resume = Math.min(it.entryAt + 1, it.tailCut);
      it.runs = [[it.entryAt, loopClose(it.full, it.entryAt, resume)], [resume, it.tailCut]];
      it.entry = { seg: it.entryAt, t: 0 };
      // the two runs meet where the loop's last stretch crosses the way on:
      // the pen turns there, instead of overshooting to the loop's start
      // (a round cap poking past the stroke it runs into) and hopping back
      it.points = joinRuns(pathFromRuns(it.full, [it.runs[0]]), pathFromRuns(it.full, [it.runs[1]]));
      return it;
    } else {
      // landed mid-stroke: write back to the start. Where the way on from
      // just past the landing retraces the head (a stem the stroke writes
      // up and back down anyway), carry on from there rather than writing
      // the head a third time; elsewhere retrace it to the landing
      const j = it.entryAt, nxt = Math.min(j + 1, it.tailCut);
      const hw = 0.5 * (it.stroke.widths?.[nxt] || (it.record?.penWidth || 40) * 0.4);
      let under = Infinity;
      for (let i = 1; i <= j; i++) under = Math.min(under, distToSegment(it.full[nxt][0], it.full[nxt][1], it.full[i - 1], it.full[i]));
      it.runs = nxt > j && under <= hw ? [[j, 0], [nxt, it.tailCut]] : [[j, 0], [0, it.tailCut]];
      it.entry = { seg: it.entryAt, t: it.entryT || 0 };
    }
  } else {
    it.entryAt = it.entryAt != null && it.entryAt > last ? null : it.entryAt;
    it.runs = [[it.headCut, it.tailCut]];
    it.entry = null;
  }
  it.points = pathFromRuns(it.full, it.runs, it.entry);
  return it;
}

/**
 * Join a backward loop run to the way on at their closest approach: the
 * last few segments of `back` against the first few of `fwd`, an
 * intersection if there is one. `back` is cut at that point and `fwd`
 * picked up from it.
 */
function joinRuns(back, fwd) {
  let best = null;
  const nb = back.length, nf = fwd.length;
  for (let a = Math.max(1, nb - 4); a < nb; a++) {
    for (let b = 1; b < Math.min(nf, 5); b++) {
      const r = closestOnSegments(back[a - 1], back[a], fwd[b - 1], fwd[b]);
      if (!best || r.d < best.d) best = { ...r, a, b };
    }
  }
  if (!best) return back.concat(fwd);
  const out = back.slice(0, best.a);
  out.push(best.p);
  if (Math.hypot(best.q[0] - best.p[0], best.q[1] - best.p[1]) > 1e-6) out.push(best.q);
  for (let i = best.b; i < nf; i++) out.push(fwd[i]);
  return out;
}

/** Closest points p (on a0→a1) and q (on b0→b1), and their distance; the crossing itself if they cross. */
function closestOnSegments(a0, a1, b0, b1) {
  const d1x = a1[0] - a0[0], d1y = a1[1] - a0[1], d2x = b1[0] - b0[0], d2y = b1[1] - b0[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) > 1e-9) {
    const ex = b0[0] - a0[0], ey = b0[1] - a0[1];
    const t = (ex * d2y - ey * d2x) / den, u = (ex * d1y - ey * d1x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const p = [a0[0] + d1x * t, a0[1] + d1y * t];
      return { d: 0, p, q: p };
    }
  }
  const proj = (p, s0, s1) => {
    const sx = s1[0] - s0[0], sy = s1[1] - s0[1], l2 = sx * sx + sy * sy;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - s0[0]) * sx + (p[1] - s0[1]) * sy) / l2)) : 0;
    return [s0[0] + sx * t, s0[1] + sy * t];
  };
  let best = null;
  for (const [p, onB] of [[a0, true], [a1, true]]) {
    const q = proj(p, b0, b1); const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!best || d < best.d) best = { d, p, q };
  }
  for (const q of [b0, b1]) {
    const p = proj(q, a0, a1); const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!best || d < best.d) best = { d, p, q };
  }
  return best;
}

/** Whether Q[0] lies within `gap` of the path between the landing `j` and `within` of path past it. */
function startReturns(Q, qc, j, gap, within) {
  for (let i = j + 1; i < Q.length && qc[i] <= qc[j + 1] + within; i++) {
    if (distToSegment(Q[0][0], Q[0][1], Q[i - 1], Q[i]) <= gap) return true;
  }
  return false;
}

/** Whether the path, `ahead` past the landing at `j`, is more than `by` away from the loop Q[k..j]. */
function leavesLoop(Q, qc, k, j, ahead, by) {
  const target = qc[j + 1] + ahead;
  let p = Q[Q.length - 1];
  for (let i = j + 1; i + 1 < Q.length; i++) {
    if (qc[i + 1] >= target) {
      const t = (target - qc[i]) / Math.max(1e-9, qc[i + 1] - qc[i]);
      p = [Q[i][0] + (Q[i + 1][0] - Q[i][0]) * t, Q[i][1] + (Q[i + 1][1] - Q[i][1]) * t];
      break;
    }
  }
  let best = Infinity;
  for (let i = k + 1; i <= j; i++) {
    const d = distToSegment(p[0], p[1], Q[i - 1], Q[i]);
    if (d < best) best = d;
  }
  return best > by;
}

/** The head point (before `j`) nearest to `resume`: where a loop entered at `j` closes. */
function loopClose(pts, j, resume) {
  let best = 0, bd = Infinity;
  const r = pts[resume];
  for (let k = 0; k < j; k++) {
    const d = (pts[k][0] - r[0]) ** 2 + (pts[k][1] - r[1]) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
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
    tucked: 0,                   // hairline length hidden under the next letter's shade (pointed pen)
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
    loopEntry: false,            // ...and whether the head is a loop: run backwards to the start, then on past the landing (not there and back)
    entry: null,                 // {seg, t} for pathFromRuns, once cuts are final
    runs: null,                  // index runs the pen walks, once cuts are final
    points: null,                // the pen path, once cuts are final
    minX,
    chain: -1,
    n: 0,
  };
}

/** Distance from point (x, y) to segment a-b, and where along it the foot falls (0..1). */
function distToSegment(x, y, a, b) {
  const sx = b[0] - a[0], sy = b[1] - a[1];
  const l2 = sx * sx + sy * sy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a[0]) * sx + (y - a[1]) * sy) / l2)) : 0;
  return Math.hypot(x - (a[0] + t * sx), y - (a[1] + t * sy));
}

/**
 * Pointed pen: the tail of an exit hairline that runs on under the next
 * letter's shade is not written - the shade will cover it - so the pen stops
 * where the hairline meets the ink and lifts there. A tail point is under a
 * shade when it lies within half the ink's width of a body stroke of the
 * next glyph where that ink is shade-wide (the records carry the width
 * under every point). Where the next letter's own entry hairline meets the
 * tail nothing is tucked, and the two flow into each other.
 */
function tuckTail(prev, next, { maxGap }) {
  const hand = next.record?.stats?.hand;
  if (!hand?.pointed) return;
  const g = next.glyph;
  // the next letter picks the pen up where the hairline ends (an e's eye, an
  // n's overturn): that is a flowing join, nothing to hide
  const tip = prev.full[prev.tailCut], head = next.full[next.headCut];
  if (Math.hypot(head[0] - tip[0], head[1] - tip[1]) <= maxGap) return;
  const strokes = (g.record?.strokes || []).filter((s) => !MARK_ROLES.has(s.role) && s.widths);
  const shadeMin = 0.75 * hand.shade;
  const under = (p) => {
    const x = p[0] - g.x, y = p[1] - g.y;
    for (const s of strokes) {
      const pts = s.points, ws = s.widths;
      for (let i = 1; i < pts.length; i++) {
        const wd = Math.max(ws[i - 1], ws[i]);
        if (wd < shadeMin) continue;
        if (distToSegment(x, y, pts[i - 1], pts[i]) <= 0.55 * wd) return true;
      }
    }
    return false;
  };
  const P = prev.full;
  let cut = prev.tailCut;
  while (cut > prev.headCut + 2 && under(P[cut])) cut--;
  if (cut === prev.tailCut) return;
  let hidden = 0;
  for (let i = cut + 1; i <= prev.tailCut; i++) hidden += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  prev.tucked = hidden;
  prev.tailCut = cut;
}

/**
 * Best way for the pen to get from the tail of `prev` onto `next`. Candidate
 * pairs are scored on gap, agreement with the direction of travel, and how
 * much hairline is skipped or stem is retraced. Returns a bridge item and
 * records the cuts on both entries, or null when the strokes do not flow.
 * `allowMidEntry` is off for a pointed pen, which never writes up a stem;
 * `allowHeadSkip` is on only for one, whose hairline head the tail replaces.
 */
function tryBridge(prev, next, { maxGap, trimWindow, entryWindow, loopGap, minFlow }, allowMidEntry = true, allowHeadSkip = false) {
  const P = prev.full, Q = next.full;
  const pc = cumulativeLengths(P), qc = cumulativeLengths(Q);
  const b0 = prev.tailCut;

  let iMin = b0;
  while (iMin - 1 >= prev.headCut + 1 && pc[b0] - pc[iMin - 1] <= trimWindow) iMin--;
  let jMax = 0;
  while (jMax + 1 <= next.tailCut - 1 && qc[jMax + 1] <= entryWindow) jMax++;

  const tangentOut = new Map(); // direction the pen travels after entering at j
  const entering = (j, mid) => {
    const key = mid ? -j - 1 : j;
    let t = tangentOut.get(key);
    if (!t) {
      if (!mid) {
        t = leadingTangent(Q.slice(j), 12);
      } else {
        const back = trailingTangent(Q.slice(0, j + 1), 12); // arriving at j from the start
        t = [-back[0], -back[1]];                             // so the pen heads back toward it
      }
      tangentOut.set(key, t);
    }
    return t;
  };

  // a trimmed tail is skipped ink unless the bridge runs over it: for any pen
  // but a pointed one (whose trimmed hairline is replaced by the next letter)
  // every trimmed point must lie under the bridge's ribbon
  const halfW = 0.5 * (prev.stroke.endWidth || (prev.record?.penWidth || 40) * 0.4);
  const nextHalfW = (j) => 0.5 * (next.stroke.widths?.[j] || (next.record?.penWidth || 40) * 0.4);
  const covered = (i, ti, target, tj, d, j) => {
    if (allowHeadSkip || i >= b0) return true;
    const m = Math.max(d, 1);
    const br = hermite(P[i], [ti[0] * m, ti[1] * m], target, [tj[0] * m, tj[1] * m], Math.max(3, Math.ceil(d / 6)));
    const hw = nextHalfW(j);
    for (let k = i + 1; k <= b0; k++) {
      let best = Infinity;
      for (let q = 1; q < br.length; q++) {
        const dd = distToSegment(P[k][0], P[k][1], br[q - 1], br[q]);
        if (dd < best) best = dd;
      }
      if (best <= halfW) continue;
      // or under the next stroke's own ink around the landing
      let under = Infinity;
      for (let q = Math.max(1, j - 4); q < Math.min(Q.length, j + 5); q++) {
        const dd = distToSegment(P[k][0], P[k][1], Q[q - 1], Q[q]);
        if (dd < under) under = dd;
      }
      if (under > hw) return false;
    }
    return true;
  };
  const consider = (state, i, ti, trimP, target, arc, tj, midEntry, j, t, loop = false) => {
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
    // a loop entry skips nothing and doubles nothing: no head cost
    const headCost = loop ? 0 : midEntry ? 0.25 * trimWindow + 0.15 * (arc - trimWindow) : 0.25 * arc;
    const cost = 0.2 * d + 150 * (1 - flow) + 0.25 * trimP + headCost;
    if (state && cost >= state.cost) return state;
    if (!covered(i, ti, target, tj, d, j)) return state;
    return { i, j, t, d, flow, cost, ti, tj, trimP, midEntry, loop, target };
  };

  // Loop entries are the last resort: an ordinary landing, where one flows,
  // reads better (an o entered as a loop and run backwards came out lumpier
  // than the same o landed on mid-stroke), but where nothing else flows (an
  // h's tail arriving on an e's eye) the loop is the join the writer makes.
  let best = search(false) || (allowMidEntry ? search(true) : null);

  function search(allowLoops) {
  let best = null;
  for (let i = b0; i >= iMin; i--) {
    const ti = trailingTangent(P.slice(0, i + 1), 12);
    const trimP = pc[b0] - pc[i];
    for (let j = 0; j <= jMax; j++) {
      // A round nib may land anywhere on the stroke and write back to its
      // start (an o's tail ends at the top of an n's stem, 0.14 em in: the
      // pen goes down the stem from there); a pointed pen only skips a
      // hairline head within the trim window
      const midVertex = allowMidEntry ? j > 0 : qc[j] > trimWindow;
      if (midVertex && !allowMidEntry) break; // only the hairline head is open
      // a skipped head is skipped ink: only a pointed pen's hairline head,
      // which the arriving tail stands in for, may be left out
      if (!midVertex && j > 0 && !allowHeadSkip) continue;
      // the vertex itself; a mid-stroke vertex whose head runs back round to
      // next to it (an e's eye, a loop) is entered as a loop
      let loop = false;
      if (midVertex) {
        // Writing a head there and back is for stems: the pen lands on the
        // stem, writes up to its top and comes back down over the same line.
        // A curved head written there and back is drawn twice for all to
        // see, so it is no ordinary landing. If it comes back round next to
        // the landing it is a loop, a loop entry if what it leaves out before
        // closing is a short entry and the stroke leads on, away from it.
        // the head is a loop when the stroke's start comes within reach of
        // the path again a little past the landing
        const upem = trimWindow / 0.22;
        const closes = loopGap > 0 && qc[j] >= 2 * loopGap && startReturns(Q, qc, j, loopGap, LOOP_CLOSE_EM * upem);
        if (closes) {
          if (!allowLoops) continue;
          const k = j + 1 <= next.tailCut ? loopClose(Q, j, j + 1) : -1;
          loop = k >= 0
            && Math.hypot(Q[k][0] - Q[j + 1][0], Q[k][1] - Q[j + 1][1]) <= loopGap
            && qc[j] - qc[k] <= LOOP_MAX_EM * upem
            && qc[k] <= LOOP_HEAD_EM * upem
            && qc[next.tailCut] - qc[j + 1] >= LOOP_LEAD_EM * upem
            && leavesLoop(Q, qc, k, j, LOOP_AWAY_EM * upem, LOOP_AWAY_BY * upem);
          if (!loop) continue;
        }
      }
      best = consider(best, i, ti, trimP, Q[j], qc[j], entering(j, midVertex), midVertex, j, 0, loop);
      // and, for a mid-entry, the closest point along the segment after it -
      // a straight stem has few vertices, and the pen should land on the
      // stem exactly where the previous stroke arrives
      if (!allowMidEntry || j + 1 > next.tailCut) continue;
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
  return best;
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
    next.loopEntry = !!best.loop;
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
      loop: !!best.loop,
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
