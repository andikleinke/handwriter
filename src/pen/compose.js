/**
 * From text to a written word.
 *
 * Geometry first, and frozen: every letter is drawn on its own, once, as
 * Hobby's spline through its waypoints (spline.js) - so two l's are the same
 * l wherever they stand - and the composer only lays the frozen glyphs out
 * and writes the connectors between them. A connector runs from the previous
 * letter's exit anchor (the bottom of its last downstroke, cut at the height
 * that puts the visible ink exactly on the baseline) to the next letter's
 * entry anchor, as a tight bounce, a straight run and a wide entry turn,
 * tangent-continuous with both glyphs; the word is never re-solved as a
 * whole. Width comes from the nib along the fixed path; pace comes last
 * (pace.js). Looseness varies timing and letter spacing only - never a shape.
 */

import { LETTERS } from './grammar.js';
import { cumulativeLengths } from '../lib/geometry.js';
import { sampleChain, arcSamples } from './spline.js';
import { paceChain } from './pace.js';

const STEP_XH = 0.015;      // sample spacing along the path, in x-heights
const BOUNCE_R = 0.15;      // radius of the turn out of a foot, in x-heights
const ENTRY_R = 0.4;        // radius of the turn into the next letter
const BOUNCE_R_MID = 0.12;
const ENTRY_R_MID = 0.3;
const DWELL = 0.03;         // seconds the pen rests at a stop

/**
 * @returns {{
 *   text:string, chains:Array, lifts:Array, total:number, bounds:object,
 *   unitsPerEm:number, xHeight:number, notes:Array
 * }}
 */
export function composeWord(text, style) {
  return build(text, style);
}

function build(text, style) {
  const xh = style.xHeight;
  const letters = style.letters ?? LETTERS; // a fitted hand brings its own letters
  const shear = Math.tan((style.slant * Math.PI) / 180);
  const lineHeight = (style.lineHeight ?? 3.6) * xh;
  const wrapWidth = (style.wrapEm ?? 0) > 0 ? style.wrapEm * style.unitsPerEm : Infinity;
  const wordWidth = (chars, i) => {
    let w = 0;
    for (; i < chars.length && !/\s/.test(chars[i]); i++) w += ((letters[chars[i]]?.width ?? 0.6 - style.spacing) + style.spacing) * xh;
    return w;
  };
  const notes = [];
  const rnd = mulberry32(style.seed ?? 1);
  const v = style.variability ?? 0.5;
  const spacingWobble = v * 0.02 * xh; // looseness in the spacing only
  const glyphCache = new Map();
  const step = STEP_XH * xh;
  // the ink's half-width where a bounce bottoms out (a hairline, a little of
  // the stem's shade still in it): the centreline sits that much above the line
  const nib = style.nib;
  const hwBottom = nib.type === 'mono' ? (nib.wMin * xh) / 2 : nib.type === 'broad' ? ((nib.wMin + nib.wMax) * xh) / 4 : ((nib.wMin + 0.3 * (nib.wMax - nib.wMin)) * xh) / 2;

  // a letter's frozen path, in letter-frame units sheared and scaled to font
  // units with its origin at x = 0
  const glyph = (ch, def, entryKind, exitTrim) => {
    const key = `${ch}|${def === letters[ch] ? '' : (def === letters[ch].variants?.base ? 'b' : 'm')}|${entryKind}|${exitTrim ? 1 : 0}`;
    let g = glyphCache.get(key);
    if (g) return g;
    const wp = def.targets.map((t) => [(t[0] + t[1] * shear) * xh, t[1] * xh]);
    const A = def.anchors;
    const start = entryKind === 'none' ? 0 : (A.entry[entryKind] ?? 0);
    let end = exitTrim ? A.exit.at : wp.length - 1;
    let run = wp.slice(start, end + 1);
    let stops = new Set(A.stops.filter((s) => s >= start && s <= end).map((s) => s - start));
    let exitCutDir = null;
    let tickDir = null;
    if (exitTrim && def.exit === 'mid' && A.exit.at + 1 < wp.length) {
      // the checkstroke's own tick sets the direction the bridge dips off in
      tickDir = Math.atan2(wp[A.exit.at + 1][1] - wp[A.exit.at][1], wp[A.exit.at + 1][0] - wp[A.exit.at][0]);
    }
    if (exitTrim && def.exit === 'base' && A.exit.cut && run.length >= 2) {
      // cut the last downstroke where a bounce of radius R bottoms on the baseline
      const P = run[run.length - 1], F = run[run.length - 2];
      const dir = Math.atan2(P[1] - F[1], P[0] - F[0]);
      if (dir < -0.3) {
        const targetY = BOUNCE_R * (1 - Math.cos(dir)) * xh + hwBottom;
        if (P[1] < targetY) {
          let j = run.length - 1;
          while (j > 0 && run[j - 1][1] < targetY) j--;
          if (j > 0) {
            const a = run[j - 1], b = run[j];
            const u = (targetY - a[1]) / ((b[1] - a[1]) || 1e-9);
            run = run.slice(0, j);
            run.push([a[0] + (b[0] - a[0]) * u, targetY]);
            stops = new Set([...stops].filter((s) => s < j));
            exitCutDir = Math.atan2(b[1] - a[1], b[0] - a[0]);
          }
        } else if (P[1] > targetY + 0.01 * xh && dir < -0.5) {
          const u = (targetY - P[1]) / Math.sin(dir);
          run.push([P[0] + u * Math.cos(dir), targetY]);
          exitCutDir = dir;
        }
      }
    }
    // The spline's open ends would curl on their own; a phantom knot a little
    // beyond each end pins the tangent - along the first stroke at a joined
    // entry, along the stem at a cut exit - and its samples are dropped.
    const ext = run.slice();
    let off = 0;
    const startIsStop = stops.has(0);
    if (entryKind !== 'none' && run.length >= 2 && !startIsStop) {
      const d = Math.atan2(run[1][1] - run[0][1], run[1][0] - run[0][0]);
      ext.unshift([run[0][0] - 0.08 * xh * Math.cos(d), run[0][1] - 0.08 * xh * Math.sin(d)]);
      off = 1;
    }
    if (exitCutDir != null) {
      const last = run[run.length - 1];
      ext.push([last[0] + 0.08 * xh * Math.cos(exitCutDir), last[1] + 0.08 * xh * Math.sin(exitCutDir)]);
    }
    const sampled = sampleChain(ext, new Set([...stops].map((s) => s + off)), step);
    const i0 = sampled.anchor[off], i1 = sampled.anchor[off + run.length - 1];
    const pts = sampled.pts.slice(i0, i1 + 1);
    const stopAt = sampled.stopAt.filter((s) => s > i0 && s < i1).map((s) => s - i0);
    const anchor = sampled.anchor.slice(off, off + run.length).map((a) => Math.min(Math.max(a - i0, 0), pts.length - 1));
    const n = pts.length;
    const d0 = n > 1 ? Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) : 0;
    const d1 = tickDir ?? (n > 1 ? Math.atan2(pts[n - 1][1] - pts[n - 2][1], pts[n - 1][0] - pts[n - 2][0]) : 0);
    // a checkstroke hands over at its stop: the last sample is one
    const endIsStop = tickDir != null;
    g = { pts, stopAt: [...(startIsStop ? [0] : []), ...stopAt, ...(endIsStop ? [n - 1] : [])], anchor, entryDir: d0, exitDir: d1, wp, first: start, cut: exitCutDir != null };
    glyphCache.set(key, g);
    return g;
  };

  // ---- layout -----------------------------------------------------------------
  const chains = []; // {pts, stops:Set, targets, letters, joins, baseY, dot?, mark?}
  let cur = null;
  let prev = null; // {def, exitDir, exitKind}
  let pendingMarks = [];
  let joinId = 0;
  let x = 0, line = 0;
  const baseY = () => -line * lineHeight;
  const markChain = (mt, ch, mi) => (mt.length > 1
    ? { pts: mt, stops: new Set(), targets: mt.slice(), letters: [{ ch, from: 0, to: mt.length }], joins: [], mark: mi + 1, baseY: baseY() }
    : { pts: [mt[0]], stops: new Set(), targets: [mt[0]], letters: [{ ch, from: 0, to: 1 }], joins: [], dot: true, mark: mi + 1, baseY: baseY() });
  const finishWord = () => {
    if (cur) chains.push(cur);
    cur = null;
    prev = null;
    for (const m of pendingMarks) chains.push(m);
    pendingMarks = [];
  };
  const chars = Array.from(text);
  const nextJoins = (i, g) => {
    // does the letter after i join on from this one?
    if (g.exit === 'none') return false;
    const nx = chars[i + 1];
    return !!(nx && !/\s/.test(nx) && letters[nx]);
  };
  for (let ci = 0; ci < chars.length; ci++) {
    const ch = chars[ci];
    if (ch === '\n') { finishWord(); x = 0; line++; continue; }
    if (ch === '\r') continue;
    if (/\s/.test(ch)) {
      finishWord();
      if (x > 0 && x + 0.8 * xh + wordWidth(chars, ci + 1) > wrapWidth) { x = 0; line++; }
      else x += 0.8 * xh;
      continue;
    }
    const g = letters[ch];
    if (!g) {
      notes.push({ severity: 'warn', code: 'no-grammar', message: `“${ch}”: no grammar yet - skipped` });
      finishWord();
      x += 0.6 * xh;
      continue;
    }
    const ox = x + (rnd() - 0.5) * 2 * spacingWobble;
    const oy = baseY();
    const joining = !!(cur && prev && (prev.exitKind === 'base' || prev.exitKind === 'mid'));
    const entryKind = joining ? prev.exitKind : 'none';
    const def = (joining && g.variants?.[entryKind]) || g;
    const joinsOn = nextJoins(ci, def);
    // a letter with a foot always has it written by the composer: joined on,
    // or ending in the air after the same bounce - so both sit on the line
    const exitTrim = joinsOn || (def.exit === 'base' && def.anchors.exit.cut);
    const gl = glyph(ch, def, entryKind, exitTrim);
    const placed = gl.pts.map((p) => [p[0] + ox, p[1] + oy]);
    const targets = gl.wp.map((p) => [p[0] + ox, p[1] + oy]);
    if (joining) {
      const P0 = cur.pts[cur.pts.length - 1];
      const toPt = placed[0];
      const landsOnStop = gl.stopAt.includes(0);
      const entryDir = landsOnStop ? Math.atan2(toPt[1] - P0[1], toPt[0] - P0[0]) : clampEntry(gl.entryDir, P0, toPt);
      const conn = connectorPoints(prev.exitKind, P0, toPt, prev.exitDir, entryDir, xh);
      const from = cur.pts.length - 1;
      for (let i = 0; i < conn.length - 1; i++) cur.pts.push(conn[i]);
      cur.joins.push({ id: joinId, kind: prev.exitKind, from, to: cur.pts.length, baseY: oy, bounce: prev.exitKind === 'base' });
      joinId++;
    } else {
      if (cur) chains.push(cur);
      cur = { pts: [], stops: new Set(), targets: [], letters: [], joins: [], baseY: oy };
    }
    const first = cur.pts.length;
    for (const p of placed) cur.pts.push(p);
    for (const s of gl.stopAt) cur.stops.add(first + s);
    cur.targets.push(...targets);
    if (exitTrim && !joinsOn && gl.cut) {
      // the tail: bounce off the cut stem and run out to the provisional exit
      const P0 = cur.pts[cur.pts.length - 1];
      const toPt = targets[targets.length - 1];
      const dirE = Math.atan2(toPt[1] - P0[1], toPt[0] - P0[0]);
      const tail = connectorPoints('base', P0, toPt, gl.exitDir, dirE, xh);
      const from = cur.pts.length - 1;
      for (const p of tail) cur.pts.push(p);
      cur.joins.push({ id: joinId, kind: 'base', from, to: cur.pts.length - 1, baseY: oy, bounce: true, tail: true });
      joinId++;
    }
    cur.letters.push({ ch, from: first, to: cur.pts.length });
    (def.marks || []).forEach((m, mi) => {
      const mt = m.map((t) => [(t[0] + t[1] * shear) * xh + ox, t[1] * xh + oy]);
      const chain = markChain(mt, ch, mi);
      if (def.marksAfterWord) pendingMarks.push(chain);
      else { if (cur) chains.push(cur); cur = null; chains.push(chain); prev = null; }
    });
    prev = def.exit === 'none' || !joinsOn ? null : { def, exitDir: gl.exitDir, exitKind: def.exit };
    if (def.exit === 'none') { if (cur) chains.push(cur); cur = null; }
    x += (g.width + style.spacing) * xh;
  }
  finishWord();

  // ---- ink, dwell, pace -------------------------------------------------------
  let clock = 0;
  const lifts_ = [];
  const out = [];
  let prevEnd = null;
  chains.forEach((c, ci) => {
    let basePts = c.pts;
    let stops = [...c.stops].filter((s) => s > 0 && s < basePts.length - 1).sort((a, b) => a - b);
    let letterRanges = c.letters, joinRanges = c.joins;
    if (c.dot) { basePts = [c.pts[0], [c.pts[0][0] + 0.06 * xh, c.pts[0][1] - 0.04 * xh]]; stops = []; }
    else if (c.mark) {
      const s = sampleChain(basePts, new Set(), step);
      basePts = s.pts; stops = [];
      letterRanges = [{ ch: c.letters[0].ch, from: 0, to: basePts.length }];
    } else if (basePts.length === 1) {
      basePts = [basePts[0], basePts[0]];
    }
    // the pen rests at a stop: the sample is doubled and the pair carries the dwell
    const pts = [], stopAt = [];
    const remap = new Array(basePts.length);
    const stopSet = new Set(stops);
    for (let i = 0; i < basePts.length; i++) {
      remap[i] = pts.length;
      pts.push(basePts[i]);
      if (stopSet.has(i)) { stopAt.push(pts.length - 1); pts.push(basePts[i].slice()); }
    }
    const rangeMap = (r) => ({ ...r, from: remap[Math.min(r.from, basePts.length - 1)], to: r.to >= basePts.length ? pts.length : remap[r.to] });
    let cum = cumulativeLengths(pts);
    const { widths, pressure } = nibWidths(pts, cum, style, xh, c.mark ? { shade: 0.45, taper: 0.2 } : {});
    if (!c.mark && !c.dot) {
      const jr = (joinRanges || []).map(rangeMap);
      for (let round = 0; round < 2; round++) { snapToBaseline(pts, cum, widths, c.baseY, xh, jr); cum = cumulativeLengths(pts); }
    }
    const times = paceChain(pts, cum, stopAt, pressure, style, rnd);
    const L = cum[cum.length - 1];
    if (prevEnd) {
      const d = Math.hypot(pts[0][0] - prevEnd[0], pts[0][1] - prevEnd[1]);
      const dur = style.lift + Math.min(d / (4 * style.unitsPerEm), 0.6);
      lifts_.push({ t0: clock, t1: clock + dur, from: prevEnd, to: pts[0] });
      clock += dur;
    }
    const duration = times[times.length - 1];
    out.push({
      id: ci,
      word: 0,
      pts,
      times: Array.from(times),
      pressure: Array.from(pressure),
      widths,
      targets: c.targets,
      letters: letterRanges.map(rangeMap),
      joins: (joinRanges || []).map(rangeMap),
      stops: stopAt,
      dot: !!c.dot,
      mark: c.mark ?? 0,
      strokeTimes: Array.from(times, (t) => ({ t0: t, t1: t })),
      t0: clock,
      t1: clock + duration,
      L,
    });
    clock += duration;
    prevEnd = pts[pts.length - 1];
  });

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const c of out) for (const [px, py] of c.pts) { if (px < x1) x1 = px; if (py < y1) y1 = py; if (px > x2) x2 = px; if (py > y2) y2 = py; }
  if (!out.length) { x1 = 0; y1 = 0; x2 = xh; y2 = xh; }
  const pad = style.nib.wMax * xh;
  const bounds = { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad, w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad };
  return { text, chains: out, lifts: lifts_, total: Math.max(clock, 1e-3), bounds, unitsPerEm: style.unitsPerEm, xHeight: xh, notes, style };
}

/**
 * Alignment to the baseline, on the visible ink. Wherever the ink's lower
 * edge has a local minimum near the line - a foot bounce, the cusp of an m,
 * the bottom of a bowl - the path is shifted vertically, with a smooth
 * falloff over 0.15 x-heights of arc either side, so that the edge lands
 * exactly on the line; a round bottom (gentle curvature) is allowed the
 * typographic overshoot of 1.5 % below it. Deterministic, so the same
 * letter gets the same correction wherever it stands.
 */
function snapToBaseline(pts, cum, widths, baseY, xh, joins = []) {
  const n = pts.length;
  if (n < 5) return;
  const edge = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    edge[i] = pts[i][1] - Math.abs(dx / len) * (widths[i] / 2);
  }
  // index of the sample about `d` font units before / after i along the path
  const back = (i, d) => { let j = i; while (j > 0 && cum[i] - cum[j] < d) j--; return j; };
  const fwd = (i, d) => { let j = i; while (j < n - 1 && cum[j] - cum[i] < d) j++; return j; };
  const inJoin = (i) => joins.some((j) => i >= j.from && i <= j.to);
  const reach = 0.15 * xh;
  const shifts = new Float64Array(n);
  let skipTo = -1;
  for (let i = 1; i < n - 1; i++) {
    if (i < skipTo) continue;
    if (edge[i] > baseY + 0.06 * xh || edge[i] < baseY - 0.1 * xh) continue;
    const lo = back(i, 0.06 * xh), hi = fwd(i, 0.06 * xh);
    let isMin = true;
    for (let j = lo; j <= hi && isMin; j++) if (edge[j] < edge[i] - 1e-9) isMin = false;
    if (!isMin) continue;
    // a bounce the composer wrote is tight by definition; elsewhere a tight
    // turn (a cusp, a small foot) is told from a round bottom by its curvature
    let round = false;
    if (!inJoin(i)) {
      const a = pts[back(i, 0.1 * xh)], b = pts[fwd(i, 0.1 * xh)];
      const t1 = Math.atan2(pts[i][1] - a[1], pts[i][0] - a[0]), t2 = Math.atan2(b[1] - pts[i][1], b[0] - pts[i][0]);
      const turn = Math.abs(Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1)));
      const ds = (cum[fwd(i, 0.1 * xh)] - cum[back(i, 0.1 * xh)]) || 1e-9;
      round = (turn / ds) * xh < 4;
    }
    const target = baseY - (round ? 0.015 * xh : 0);
    const delta = target - edge[i];
    if (Math.abs(delta) >= 0.001 * xh) {
      const join = joins.find((j) => i >= j.from && i <= j.to);
      if (join) {
        // the connector rides up or down as a whole; the ramps straddle each
        // junction over half an x-height, so no tangent is tilted by more than
        // a fraction of a degree, and a tail's free end stays where it was
        const ramp = 0.25 * xh, rampIn = 0.1 * xh;
        const s0 = cum[join.from], s1 = cum[join.to];
        const wAt = (s) => {
          let w = 1;
          if (s < s0 + rampIn) w = Math.min(w, 0.5 * (1 - Math.cos((Math.PI * Math.max(0, s - (s0 - rampIn))) / (2 * rampIn))));
          if (join.tail) w = Math.min(w, s > s1 - ramp ? 0.5 * (1 - Math.cos((Math.PI * Math.max(0, s1 - s)) / ramp)) : 1);
          else if (s > s1 - ramp) w = Math.min(w, 0.5 * (1 - Math.cos((Math.PI * Math.max(0, (s1 + ramp) - s)) / (2 * ramp))));
          return Math.max(0, w);
        };
        for (let j = back(join.from, rampIn); j <= fwd(join.to, ramp); j++) {
          const w = wAt(cum[j]);
          if (Math.abs(delta * w) > Math.abs(shifts[j])) shifts[j] = delta * w;
        }
        skipTo = join.to + 1;
        continue;
      }
      for (let j = back(i, reach); j <= fwd(i, reach); j++) {
        const d = Math.abs(cum[j] - cum[i]);
        const w = 0.5 * (1 + Math.cos((Math.PI * Math.min(d, reach)) / reach));
        if (Math.abs(delta * w) > Math.abs(shifts[j])) shifts[j] = delta * w;
      }
    }
    skipTo = hi + 1; // one correction per feature
  }
  for (let j = 0; j < n; j++) pts[j][1] += shifts[j];
}

/**
 * The direction the connector arrives with: the glyph's own first direction,
 * so the join is tangent-continuous - unless that direction points back or
 * past the vertical, which no connector can reach without a hook.
 */
function clampEntry(dir, from, to) {
  const chord = Math.atan2(to[1] - from[1], to[0] - from[0]);
  let d = Math.min(dir, chord + 1.3, 1.31);
  return Math.max(d, chord - 0.3);
}

const wrapAngle = (t) => Math.atan2(Math.sin(t), Math.cos(t));

/**
 * The connector's points after `from` up to and including `to`. It begins
 * with the bounce: a circular arc of radius R turning (counter-clockwise, out
 * of a foot; either way, off a checkstroke) from the direction the pen was
 * travelling until it points at the target - so a foot's bounce bottoms out
 * exactly R (1 - cos heading) below the cut, which is on the baseline by
 * construction - and continues as one cubic Hermite blend into the target,
 * arriving along the next glyph's own direction. Tangent-continuous
 * throughout, whatever the gap.
 */
function connectorPoints(exitKind, from, to, dirS, dirE, xh) {
  const R = (exitKind === 'mid' ? BOUNCE_R_MID : BOUNCE_R) * xh;
  const step = STEP_XH * xh;
  const out = [];
  let p = [from[0], from[1]];
  let h = dirS;
  const dtheta = step / R;
  const aim = () => Math.atan2(to[1] - p[1], to[0] - p[0]);
  // which way to turn: toward the target
  const turnSign = wrapAngle(aim() - h) >= 0 ? 1 : -1;
  for (let k = 0; k < 400; k++) {
    const gap = Math.hypot(to[0] - p[0], to[1] - p[1]);
    if (gap < 2 * step) break;
    const want = aim();
    const diff = wrapAngle(want - h);
    if (Math.sign(diff) !== turnSign || Math.abs(diff) < dtheta) break;
    // one step along the arc: the heading turns by dtheta, the point moves along it
    const hMid = h + (turnSign * dtheta) / 2;
    p = [p[0] + step * Math.cos(hMid), p[1] + step * Math.sin(hMid)];
    h += turnSign * dtheta;
    out.push(p);
  }
  for (const q of hermitePoints(p, to, h, dirE, xh)) out.push(q);
  return out;
}

/**
 * A cubic Hermite blend from `from` (leaving along dirS) to `to` (arriving
 * along dirE), for a gap too short to hold a bounce and an entry turn:
 * tangent-continuous at both ends, handles two fifths of the gap.
 */
function hermitePoints(from, to, dirS, dirE, xh) {
  const gap = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const h = 0.4 * gap;
  const p1 = [from[0] + h * Math.cos(dirS), from[1] + h * Math.sin(dirS)];
  const p2 = [to[0] - h * Math.cos(dirE), to[1] - h * Math.sin(dirE)];
  const m = Math.max(4, Math.ceil(gap / (STEP_XH * xh)));
  const out = [];
  for (let k = 1; k <= m; k++) {
    const t = k / m, u = 1 - t;
    out.push(k === m ? [to[0], to[1]] : [
      u * u * u * from[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * to[0],
      u * u * u * from[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * to[1],
    ]);
  }
  return out;
}

/**
 * The nib's width along the path, from the direction of travel: a pointed
 * pen spreads under the shade's pressure on downward travel; a broad edge
 * held at a fixed angle is thick across its edge and thin along it; a
 * monoline pen is the same everywhere. The width swells and fades over a
 * short distance along the path, and the ends of a chain taper.
 *
 * @returns {{widths:Float64Array, pressure:Float64Array}}
 */
function nibWidths(pts, cum, style, xh, opts = {}) {
  const { nib } = style;
  const shade = opts.shade ?? 1;
  const n = pts.length;
  const pressure = new Float64Array(n);
  const widths = new Float64Array(n);
  if (nib.type === 'mono') { widths.fill(nib.wMin * xh); return { widths, pressure }; }
  const edge = ((nib.angle ?? 45) * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    if (nib.type === 'broad') pressure[i] = Math.abs(Math.sin(Math.atan2(dy, dx) - edge));
    else {
      const down = -dy / l;
      pressure[i] = Math.max(0, Math.min(1, (down - 0.2) / 0.6));
    }
  }
  const win = Math.max(1, Math.round((0.05 * xh) / Math.max(1e-6, cum[n - 1] / Math.max(1, n - 1))));
  let cur = pressure;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) { s += cur[j]; c++; }
      out[i] = s / c;
    }
    cur = out;
  }
  const taper = (opts.taper ?? 0.1) * xh;
  for (let i = 0; i < n; i++) {
    const fromStart = cum[i], fromEnd = cum[n - 1] - cum[i];
    const t = Math.min(1, fromStart / taper, fromEnd / taper);
    const p = cur[i] * shade * (0.3 + 0.7 * t);
    pressure[i] = p;
    widths[i] = (nib.wMin + (nib.wMax - nib.wMin) * p) * xh;
  }
  return { widths, pressure };
}

/** Deterministic small PRNG so a hand's deviations repeat run to run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
