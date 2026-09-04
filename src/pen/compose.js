/**
 * From text to a written word: letters laid out and joined by the grammar,
 * their path drawn as one smooth spline through the waypoints (spline.js),
 * given a width by the nib, and paced afterwards along that fixed path
 * (pace.js).
 *
 * Geometry first: a letter's shape never depends on how fast it is written,
 * every foot sits exactly on the baseline it was authored on, and two l's
 * are the same l. Looseness moves and scales a letter a little as a whole
 * and varies the timing; it never bends a stroke.
 */

import { LETTERS } from './grammar.js';
import { cumulativeLengths } from '../lib/geometry.js';
import { sampleChain, arcSamples } from './spline.js';
import { paceChain } from './pace.js';

/**
 * @returns {{
 *   text:string, chains:Array, lifts:Array, total:number, bounds:object,
 *   unitsPerEm:number, xHeight:number, notes:Array
 * }}
 */
export function composeWord(text, style) {
  const xh = style.xHeight;
  const letters = style.letters ?? LETTERS; // a fitted hand brings its own letters
  const shear = Math.tan((style.slant * Math.PI) / 180);
  // lines: the baseline of line n sits n line heights below the first
  const lineHeight = (style.lineHeight ?? 3.6) * xh;
  let line = 0;
  // the width a word will take, for wrapping (unknown letters count as a gap)
  const wrapWidth = (style.wrapEm ?? 0) > 0 ? style.wrapEm * style.unitsPerEm : Infinity;
  const wordWidth = (chars, i) => {
    let w = 0;
    for (; i < chars.length && !/\s/.test(chars[i]); i++) w += ((letters[chars[i]]?.width ?? 0.6 - style.spacing) + style.spacing) * xh;
    return w;
  };
  const notes = [];
  const rnd = mulberry32(style.seed ?? 1);
  const v = style.variability ?? 0.5;
  // looseness: a letter lands a little left or right of its place and comes
  // out a little larger or smaller as a whole; its baseline never moves
  const wobble = v * 0.03 * xh;
  let jit = { ox: 0, dx: 0, sx: 1, sy: 1 };
  const newLetterJitter = (ox) => {
    jit = { ox, dx: (rnd() - 0.5) * 2 * wobble, sx: 1 + (rnd() - 0.5) * 0.04 * v, sy: 1 + (rnd() - 0.5) * 0.02 * v };
  };
  let x = 0;
  const place = (t) => [jit.ox + (t[0] + t[1] * shear) * xh * jit.sx + jit.dx, t[1] * xh * jit.sy - line * lineHeight];

  const chains = []; // {pts:[[x,y]], stops:Set, targets:[], letters:[{ch, from, to}], dot?, mark?}
  let cur = null;
  let prevLetter = null;
  let pendingMarks = []; // dots, bars, second slants: written once the word is done
  const markChain = (mt, ch, mi) => (mt.length > 1
    ? { pts: mt, stops: new Set(), targets: mt.slice(), letters: [{ ch, from: 0, to: mt.length }], mark: mi + 1 }
    : { pts: [mt[0]], stops: new Set(), targets: [mt[0]], letters: [{ ch, from: 0, to: 1 }], dot: true, mark: mi + 1 });
  const finishWord = () => {
    if (cur) chains.push(cur);
    cur = null;
    prevLetter = null;
    for (const m of pendingMarks) chains.push(m);
    pendingMarks = [];
  };

  const chars = Array.from(text);
  for (let ci = 0; ci < chars.length; ci++) {
    const ch = chars[ci];
    if (ch === '\n') { finishWord(); x = 0; line++; continue; }
    if (ch === '\r') continue;
    if (/\s/.test(ch)) {
      finishWord();
      // wrap when the next word would run past the line's width
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
    newLetterJitter(x);
    const wp = g.targets.map((t) => place(t));
    // where the pen halts inside the letter: the grammar marks the stroke
    // after a stop with a full gap
    const stopsL = new Set();
    for (let j = 1; j < g.targets.length - 1; j++) if ((g.targets[j + 1][3] ?? 0) >= 1.05) stopsL.add(j);

    const joining = cur && prevLetter && (prevLetter.exit === 'base' || prevLetter.exit === 'mid');
    let from = 0;
    if (joining) {
      // The connector: the previous letter's foot (the provisional exit and the
      // short flat or rising strokes after its last downstroke) is dropped, and
      // from the bottom of that downstroke the composer writes a tight bounce
      // into the direction of the trip, a straight run, and a wider turn into
      // the direction this letter's lead-in would have had - tangent-continuous
      // throughout, and part of the same spline.
      const jt = g.joinTarget && typeof g.joinTarget === 'object'
        ? (prevLetter.exit === 'mid' ? g.joinTarget.mid ?? g.joinTarget.base : g.joinTarget.base ?? g.joinTarget.mid) ?? 0
        : g.joinTarget ?? 0;
      let k = cur.pts.length - 2;
      let dropped = 0;
      while (k > 0 && dropped < 3) {
        const dx = cur.pts[k][0] - cur.pts[k - 1][0], dy = cur.pts[k][1] - cur.pts[k - 1][1];
        if (Math.hypot(dx, dy) < 0.3 * xh && dy > -0.06 * xh) { k--; dropped++; } else break;
      }
      let P0 = cur.pts[k];
      let f0 = cur.pts[Math.max(0, k - 1)];
      let footDir = Math.atan2(P0[1] - f0[1], P0[0] - f0[0]);
      cur.pts.length = k + 1;
      for (const s of [...cur.stops]) if (s > k) cur.stops.delete(s);
      if (prevLetter.exit === 'base' && k > 0 && footDir < -0.3) {
        // (only off a downstroke: a descender loop crossing the baseline on
        // its way up is already heading into the run)
        // the bounce of radius R1 turning from the stem's heading through the
        // horizontal bottoms out R1 (1 - cos heading) below where it starts; so
        // the stem is cut where that puts the bottom exactly on the baseline
        const R1 = 0.15 * xh;
        const targetY = cur.baseY + R1 * (1 - Math.cos(footDir));
        if (P0[1] < targetY) {
          // walk back up the stem to the height
          let j = k;
          while (j > 0 && cur.pts[j - 1][1] < targetY) j--;
          if (j > 0) {
            const a = cur.pts[j - 1], b = cur.pts[j];
            const u = (targetY - a[1]) / ((b[1] - a[1]) || 1e-9);
            P0 = [a[0] + (b[0] - a[0]) * u, targetY];
            footDir = Math.atan2(b[1] - a[1], b[0] - a[0]);
            cur.pts.length = j;
            cur.pts.push(P0);
            for (const s of [...cur.stops]) if (s >= j) cur.stops.delete(s);
          }
        } else if (P0[1] > targetY + 0.01 * xh && footDir < -0.5) {
          // the stem stops short: carry it on down to the height
          const u = (targetY - P0[1]) / Math.sin(footDir);
          P0 = [P0[0] + u * Math.cos(footDir), targetY];
          cur.pts.push(P0);
        }
      }
      const toPt = wp[jt];
      const conn = connectorPoints(prevLetter.exit, P0, toPt, footDir, entryDirection(wp, jt, prevLetter.exit, P0), xh);
      for (const p of conn) cur.pts.push(p);
      if (stopsL.has(jt)) cur.stops.add(cur.pts.length - 1);
      from = jt;
    } else {
      if (cur) chains.push(cur);
      cur = { pts: [wp[0]], stops: new Set(), targets: [], letters: [], baseY: -line * lineHeight };
      if (stopsL.has(0)) cur.stops.add(0);
      from = 0;
    }
    const first = cur.pts.length - 1;
    for (let i = from + 1; i < wp.length; i++) {
      cur.pts.push(wp[i]);
      if (stopsL.has(i)) cur.stops.add(cur.pts.length - 1);
    }
    cur.targets.push(...wp);
    cur.letters.push({ ch, from: first, to: cur.pts.length });
    (g.marks || []).forEach((m, mi) => {
      const mt = m.map((t) => place(t));
      const chain = markChain(mt, ch, mi);
      if (g.marksAfterWord) pendingMarks.push(chain);
      else { if (cur) chains.push(cur); cur = null; chains.push(chain); prevLetter = null; }
    });
    prevLetter = g.exit === 'none' ? null : g;
    if (g.exit === 'none') { if (cur) chains.push(cur); cur = null; }
    x += (g.width + style.spacing) * xh;
  }
  finishWord();

  // the path, the ink and the pace of every chain; the clock runs on from one
  // chain to the next with a lift in between
  let clock = 0;
  const lifts = [];
  const out = [];
  let prevEnd = null;
  chains.forEach((c, ci) => {
    let points = c.pts;
    if (c.dot) points = [c.pts[0], [c.pts[0][0] + 0.06 * xh, c.pts[0][1] - 0.04 * xh]]; // a dab
    const { pts, anchor, stopAt } = sampleChain(points, c.stops, 0.015 * xh);
    const cum = cumulativeLengths(pts);
    // a mark (a bar, a crossing slant) is a lighter, more tapered stroke than a body
    const { widths, pressure } = nibWidths(pts, cum, style, xh, c.mark ? { shade: 0.45, taper: 0.2 } : {});
    const times = paceChain(pts, cum, stopAt, pressure, style, rnd);
    const L = cum[cum.length - 1];
    if (prevEnd) {
      const d = Math.hypot(pts[0][0] - prevEnd[0], pts[0][1] - prevEnd[1]);
      // travel at about four em a second, but a carriage return is not a trip
      const dur = style.lift + Math.min(d / (4 * style.unitsPerEm), 0.6);
      lifts.push({ t0: clock, t1: clock + dur, from: prevEnd, to: pts[0] });
      clock += dur;
    }
    const duration = times[times.length - 1];
    const lettersOut = c.letters.map((l) => ({ ch: l.ch, from: anchor[l.from] ?? 0, to: (anchor[Math.min(l.to, points.length) - 1] ?? pts.length - 1) + 1 }));
    out.push({
      id: ci,
      word: 0,
      pts,
      times: Array.from(times),
      pressure: Array.from(pressure),
      widths,
      targets: c.targets,
      letters: lettersOut,
      dot: !!c.dot,
      mark: c.mark ?? 0,
      // per sample, so a letter's span is the times of its first and last sample
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
  // room for the nib
  const pad = style.nib.wMax * xh;
  const bounds = { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad, w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad };

  return { text, chains: out, lifts, total: Math.max(clock, 1e-3), bounds, unitsPerEm: style.unitsPerEm, xHeight: xh, notes, style };
}

/**
 * The direction a connector should arrive with: along the lead-in it
 * replaces (the stroke into the join target), or, for a letter entered at its
 * first waypoint, the undercurve's steep arrival - rising well above the
 * chord but never past 75 degrees. From a checkstroke the bridge arrives more
 * gently.
 */
function entryDirection(wp, jt, exitKind, fromPt) {
  const to = wp[jt];
  const chord = Math.atan2(to[1] - fromPt[1], to[0] - fromPt[0]);
  let dir;
  if (jt > 0) {
    const a = wp[jt - 1];
    dir = Math.atan2(to[1] - a[1], to[0] - a[0]);
  } else if (wp.length > 1) {
    const b = wp[1];
    dir = Math.atan2(b[1] - to[1], b[0] - to[0]);
  } else {
    dir = chord + 0.6;
  }
  const lift = exitKind === 'mid' ? 0.7 : 1.1; // how far above the chord the arrival may point
  dir = Math.min(dir, chord + lift, 1.31);
  return Math.max(dir, chord - 0.3);
}

const wrapAngle = (t) => Math.atan2(Math.sin(t), Math.cos(t));

/**
 * The connector's points, after `from` up to and including `to`: a tight
 * bounce (radius R1) turning from the direction the pen was travelling into
 * the direction of the run, the straight run, and a wider turn (radius R2)
 * into the direction the next letter's lead-in would have had. The run's
 * direction depends on where the turns end, so it is settled by iteration.
 */
function connectorPoints(exitKind, from, to, dirS, dirE, xh) {
  let R1 = (exitKind === 'mid' ? 0.12 : 0.15) * xh;
  let R2 = (exitKind === 'mid' ? 0.3 : 0.4) * xh;
  const unit = (a) => [Math.cos(a), Math.sin(a)];
  let run = Math.atan2(to[1] - from[1], to[0] - from[0]);
  let P1, P2, d1, d2;
  for (let attempt = 0; attempt < 5; attempt++) {
    for (let it = 0; it < 8; it++) {
      d1 = wrapAngle(run - dirS);
      const c1 = 2 * R1 * Math.sin(Math.abs(d1) / 2);
      const u1 = unit(dirS + d1 / 2);
      P1 = [from[0] + c1 * u1[0], from[1] + c1 * u1[1]];
      d2 = wrapAngle(dirE - run);
      const c2 = 2 * R2 * Math.sin(Math.abs(d2) / 2);
      const u2 = unit(run + d2 / 2);
      P2 = [to[0] - c2 * u2[0], to[1] - c2 * u2[1]];
      const next = Math.atan2(P2[1] - P1[1], P2[0] - P1[0]);
      const done = Math.abs(wrapAngle(next - run)) < 1e-3;
      run = next;
      if (done) break;
    }
    // the run must go forward; if the two turns overlap, take them smaller
    const ur = unit(run);
    const forward = (P2[0] - P1[0]) * ur[0] + (P2[1] - P1[1]) * ur[1];
    if (forward > 0.02 * xh) break;
    R1 *= 0.6; R2 *= 0.6;
  }
  const out = [];
  for (const p of arcSamples(from, P1, d1, 6)) out.push(p);
  const runLen = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]);
  const runSteps = Math.max(1, Math.round(runLen / (0.25 * xh)));
  for (let k = 1; k <= runSteps; k++) out.push([P1[0] + ((P2[0] - P1[0]) * k) / runSteps, P1[1] + ((P2[1] - P1[1]) * k) / runSteps]);
  for (const p of arcSamples(P2, to, d2, 6)) out.push(p);
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
      // shade only on clearly downward travel
      const down = -dy / l;
      pressure[i] = Math.max(0, Math.min(1, (down - 0.2) / 0.6));
    }
  }
  // the swell: a short window along the path, twice, so the edge has no steps
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
  // the ends taper over a tenth of an x-height (a mark over a fifth)
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
