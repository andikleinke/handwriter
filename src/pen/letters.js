/**
 * The alphabet of the pen model, derived from the taught stroke sequences in
 * lib/templates.js (Zaner-Bloser, Palmer, Spencerian waypoints in the glyph
 * box) by placing them in the pen model's letter frame: baseline 0, x-height
 * 1, x in x-height units. Every waypoint becomes a virtual target; the arc
 * of each stroke is read off the local turning of the sequence, its overlap
 * off the sharpness of the corner it starts from, and its pressure off its
 * direction (shade on the downstrokes only).
 *
 * A letter's later template strokes are marks - a dot, a t-bar, the second
 * slant of an x - written after the word, or, for a capital, the further
 * strokes of the letter written straight after it with a lift.
 */

import { templateFor } from '../lib/templates.js';

// how each letter's glyph box maps onto the frame: y' = a * y + b (in x-heights)
const FRAME = {
  X: [1, 0],          // baseline letters: box = baseline..x-height
  A: [2, 0],          // ascenders: box = baseline..ascender (x-height at .5)
  D: [2, -1],         // descenders: box = descender..x-height
  F: [3, -1],         // f: descender..ascender
  T: [1.5, 0],        // t: baseline..three quarters of the ascender
  I: [1.45, 0],       // i: baseline..the dot
  J: [2.4, -1],       // j: descender..the dot
  C: [1.5, 0],        // capitals: baseline..cap height (one and a half x-heights)
  CT: [2.025, -0.525], // capitals with a tail below the baseline (J Y Z)
  CQ: [1.575, -0.075], // Q: a short tail
};
const CLASS = {
  a: 'X', b: 'A', c: 'X', d: 'A', e: 'X', f: 'F', g: 'D', h: 'A', i: 'I', j: 'J', k: 'A', l: 'A', m: 'X',
  n: 'X', o: 'X', p: 'D', q: 'D', r: 'X', s: 'X', t: 'T', u: 'X', v: 'X', w: 'X', x: 'X', y: 'D', z: 'D',
  J: 'CT', Y: 'CT', Z: 'CT', Q: 'CQ',
};
// letter widths in x-heights (the box's x runs over the width)
const WIDTH = {
  a: 0.9, b: 0.9, c: 0.85, d: 1.0, e: 0.9, f: 0.8, g: 1.0, h: 1.15, i: 0.5, j: 0.6, k: 1.1, l: 0.7, m: 1.7,
  n: 1.15, o: 0.9, p: 1.0, q: 1.0, r: 0.75, s: 0.75, t: 0.6, u: 1.15, v: 0.9, w: 1.4, x: 0.9, y: 1.0, z: 0.9,
};
const CAP_WIDTH = 1.5;
const MID_EXIT = new Set(['b', 'o', 'v', 'w']);

const angle = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const wrap = (t) => Math.atan2(Math.sin(t), Math.cos(t));

/** One pen-down sequence of waypoints (frame units) into targets with arcs, overlaps and pressure. */
function targetsFromWaypoints(W, stops = []) {
  const n = W.length;
  const stopAt = new Set(stops);
  const out = [W[0].slice()];
  // tangent at each waypoint: central difference where possible
  const tangent = (i) => {
    const a = W[Math.max(0, i - 1)], b = W[Math.min(n - 1, i + 1)];
    return angle(a, b);
  };
  // the turn at each waypoint; a near-reversal is a cusp (a retraced stem, the
  // top of an i), where the pen stops and turns instead of rounding
  const turnAt = (i) => (i <= 0 || i >= n - 1 ? 0 : Math.abs(wrap(angle(W[i], W[i + 1]) - angle(W[i - 1], W[i]))));
  // an explicit stop is a cusp too: the pen halts there whatever the turn
  const cusp = (i) => stopAt.has(i) || turnAt(i) > 2.6;
  for (let i = 1; i < n; i++) {
    const from = W[i - 1], to = W[i];
    const chord = angle(from, to);
    const tIn = i === 1 || cusp(i - 1) ? chord : tangent(i - 1);
    const tOut = i === n - 1 || cusp(i) ? chord : tangent(i);
    // a circular arc from `from` to `to` leaves at chord - arc/2 and arrives at chord + arc/2
    let arc = wrap(tOut - tIn);
    arc = Math.max(-2.6, Math.min(2.6, arc));
    // how sharp the corner at the start is decides how little the strokes overlap
    const turn = turnAt(i - 1);
    // at a cusp the pen stops: the next stroke starts only once this one is over
    const gap = cusp(i - 1) ? 1.1 : 0.45 + 0.35 * Math.min(1, turn / Math.PI);
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1e-6;
    const down = -(to[1] - from[1]) / len;
    // shade only on clearly downward travel, and less on a tiny stroke (the
    // downward half of a small eye or tie would fill it in)
    const p = Math.max(0, Math.min(1, (down - 0.3) / 0.6)) * Math.max(0.35, Math.min(1, len / 0.2));
    out.push([to[0], to[1], +arc.toFixed(3), +gap.toFixed(2), +p.toFixed(2)]);
  }
  return out;
}

/** The letter grammar for one character, or null when there is no template. */
export function letterFromTemplate(ch) {
  const tpl = templateFor(ch);
  if (!tpl) return null;
  const upper = ch !== ch.toLowerCase();
  const [a, b] = FRAME[CLASS[ch] ?? (upper ? 'C' : 'X')];
  const width = upper ? CAP_WIDTH : WIDTH[ch] ?? 1;
  const place = (wp) => [+(wp[0] * width).toFixed(3), +(a * wp[1] + b).toFixed(3)];
  const strokes = tpl.map((s) => s.map(place));
  const body = targetsFromWaypoints(strokes[0]);
  const first = strokes[0][0];
  // entered from the baseline at the left: a join lands on the top of the lead-in;
  // an oval entered at the top right: on its start
  const joinTarget = !upper && first[1] < 0.2 && first[0] < 0.15 * width ? 1 : 0;
  const marks = strokes.slice(1).map((s) => (s.length === 1 ? [s[0].slice()] : targetsFromWaypoints(s)));
  return {
    width,
    joinTarget,
    exit: upper ? 'none' : MID_EXIT.has(ch) ? 'mid' : 'base',
    targets: body,
    marks,               // written after the word (lowercase) or straight after the letter (capitals)
    marksAfterWord: !upper,
  };
}

/** A letter from hand-authored waypoints already in the frame (see hand-letters.js). */
/**
 * Capitals that run on into the next letter in the school hand (Zaner-Bloser
 * joins from A C E J L M N R U Y Z; the others, and any capital whose last
 * stroke is a separate mark, end with a lift).
 */
const JOINING_CAPITALS = new Set('ACEJLMNRUYZ');

export function letterFromWaypoints(ch, { width, exit = 'base', waypoints, marks = [], joinTarget, stops = [] }) {
  const body = targetsFromWaypoints(waypoints, stops);
  const first = waypoints[0];
  const upper = ch !== ch.toLowerCase();
  // a join lands on the second waypoint when the letter begins with a lead-in
  // from the baseline (which the join replaces), else on the first; an
  // authored letter may say so explicitly, as one index or as { base, mid }:
  // an undercurve from the baseline and a level bridge from a checkstroke
  // want different landings
  const lead = !upper && first[1] < 0.2 && first[0] < 0.15 * width;
  return {
    width,
    joinTarget: joinTarget ?? (lead ? 1 : 0),
    exit: upper ? (JOINING_CAPITALS.has(ch) && !marks.length && exit !== 'none' ? 'base' : 'none') : exit,
    targets: body,
    marks: marks.map((m) => (m.length === 1 ? [m[0].slice()] : targetsFromWaypoints(m))),
    marksAfterWord: !upper,
  };
}

/** Every letter the templates know. */
export function alphabet() {
  const out = {};
  for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const g = letterFromTemplate(ch);
    if (g) out[ch] = g;
  }
  return out;
}
