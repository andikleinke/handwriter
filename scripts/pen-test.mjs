#!/usr/bin/env node
/**
 * Invariant tests for the pen model. Run with `npm test`.
 *
 * These check the properties the even script is meant to have, on raw
 * coordinates (no box normalisation):
 *   1. repeated letters are identical (same context, even mode);
 *   2. the visible ink never dips below the baseline beyond the optical
 *      overshoot allowed to round bottoms, and every foot bounce lands on it;
 *   3. a connector is tangent-continuous with both glyphs it joins and never
 *      bends tighter than the bounce radius allows;
 *   4. a connector never crosses the letter it enters (protected counters);
 *   5. times are monotonic and every stop is a true dwell;
 *   6. a pair matrix (aa .. zz) matches its snapshot - informational unless
 *      --strict; --update rewrites the snapshot.
 *
 * Exit code 1 when any check fails.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { composeWord } from '../src/pen/compose.js';
import { STYLES } from '../src/pen/grammar.js';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const update = args.includes('--update');
const style = { ...STYLES.school, variability: 0 }; // even mode
const xh = style.xHeight;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const letterSamples = (r, chainIdx, letterIdx) => {
  const c = r.chains[chainIdx];
  const L = c.letters[letterIdx];
  return c.pts.slice(L.from, L.to);
};
const maxDeviation = (A, B) => {
  let md = 0;
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) md = Math.max(md, Math.hypot((A[i][0] - A[0][0]) - (B[i][0] - B[0][0]), (A[i][1] - A[0][1]) - (B[i][1] - B[0][1])));
  return Math.abs(A.length - B.length) > 0 ? Infinity : md;
};
const dir = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const wrap = (t) => Math.atan2(Math.sin(t), Math.cos(t));
const inkLow = (c, from = 0, to = c.pts.length - 1) => {
  let low = Infinity;
  for (let i = from; i <= to; i++) {
    const a = c.pts[Math.max(0, i - 1)], b = c.pts[Math.min(c.pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    low = Math.min(low, c.pts[i][1] - Math.abs(dx / len) * (c.widths[i] / 2));
  }
  return low;
};

// 1. repeated letters ----------------------------------------------------------
for (const word of ['lllll', 'nnnnn', 'aaaaa', 'ooooo', 'eeeee', 'iiiii']) {
  const r = composeWord(word, style);
  const A = letterSamples(r, 0, 2), B = letterSamples(r, 0, 3);
  const md = maxDeviation(A, B);
  check(`repeat ${word[0]}: letter 3 = letter 4`, md < 1e-6 * xh, `max deviation ${(md / xh).toExponential(1)} xh`);
}

// 2. baseline ------------------------------------------------------------------
const overshoot = 0.02 * xh; // optical overshoot allowed to round bottoms
for (const word of ['hello', 'minimum', 'llama', 'once', 'coda', 'unwind']) {
  const r = composeWord(word, style);
  for (const c of r.chains) {
    if (c.mark) continue;
    const low = inkLow(c);
    check(`baseline ${word}: ink edge >= -2% xh`, low >= -overshoot - 1e-6, `min ${(low / xh).toFixed(4)} xh`);
    for (const j of c.joins) {
      if (j.kind !== 'base') continue;
      const dip = j.baseY - inkLow(c, j.from, j.to);
      check(`baseline ${word}: foot bounce ${j.id} on the line`, Math.abs(dip) <= 0.006 * xh, `dip ${(dip / xh).toFixed(4)} xh`);
    }
  }
}

// 3. connector continuity and curvature ----------------------------------------
for (const word of ['hello', 'minimum', 'oblong', 'coda', 'wolf', 'jumps']) {
  const r = composeWord(word, style);
  for (const c of r.chains) {
    for (const j of c.joins) {
      const s = j.from, e = j.to;
      if (s < 1 || e + 1 >= c.pts.length) continue;
      // at a stop the pen halts and may leave in any direction
      const stopAtExit = c.stops.includes(s) || c.stops.includes(s - 1);
      const inA = stopAtExit ? 0 : wrap(dir(c.pts[s - 1], c.pts[s]) - dir(c.pts[s], c.pts[s + 1]));
      const stopAtEntry = c.stops.includes(e);
      const outA = stopAtEntry ? 0 : wrap(dir(c.pts[e - 1], c.pts[e]) - dir(c.pts[e], c.pts[e + 1]));
      check(`join ${word} #${j.id}: tangent-continuous`, Math.abs(inA) < 0.26 && Math.abs(outA) < 0.26, `leave ${(inA * 57.3).toFixed(1)}°, arrive ${(outA * 57.3).toFixed(1)}°`);
      // curvature over a window of 0.03 x-heights either side; a doubled stop sample is not a turn
      let kmax = 0;
      const stepLen = (i, k) => Math.hypot(c.pts[k][0] - c.pts[i][0], c.pts[k][1] - c.pts[i][1]);
      for (let i = s + 1; i < e; i++) {
        let a = i, b = i;
        while (a > s && stepLen(a, i) < 0.03 * xh) a--;
        while (b < e && stepLen(i, b) < 0.03 * xh) b++;
        if (stepLen(a, i) < 1e-9 || stepLen(i, b) < 1e-9) continue;
        const t = wrap(dir(c.pts[i], c.pts[b]) - dir(c.pts[a], c.pts[i]));
        const ds = (stepLen(a, i) + stepLen(i, b)) / 2;
        kmax = Math.max(kmax, Math.abs(t) / ds);
      }
      check(`join ${word} #${j.id}: curvature bounded`, kmax <= 1 / (0.05 * xh), `min radius ${(1 / Math.max(kmax, 1e-9) / xh).toFixed(3)} xh`);
    }
  }
}

// 4. protected counters ---------------------------------------------------------
const intersects = (p, q, r2, s2) => {
  const d = (q[0] - p[0]) * (s2[1] - r2[1]) - (q[1] - p[1]) * (s2[0] - r2[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((r2[0] - p[0]) * (s2[1] - r2[1]) - (r2[1] - p[1]) * (s2[0] - r2[0])) / d;
  const u = ((r2[0] - p[0]) * (q[1] - p[1]) - (r2[1] - p[1]) * (q[0] - p[0])) / d;
  return t > 0 && t < 1 && u > 0 && u < 1;
};
for (const pair of ['lo', 'la', 'ld', 'lg', 'lq', 'no', 'na', 'nd', 'ng', 'iq']) {
  const r = composeWord(pair, style);
  const c = r.chains[0];
  const j = c.joins[0];
  if (!j) { check(`counter ${pair}: joined`, false, 'no join'); continue; }
  const conn = c.pts.slice(j.from, j.to + 1);
  const entry = c.pts[j.to];
  // the letter's own path may pass back over its entry (an oval closing on it); that is not a crossing of its counter
  const body = c.pts.slice(j.to + 3, c.letters[1].to).filter((p) => Math.hypot(p[0] - entry[0], p[1] - entry[1]) > 0.2 * xh);
  let hits = 0;
  for (let i = 1; i < conn.length; i++) {
    if (Math.hypot(conn[i][0] - entry[0], conn[i][1] - entry[1]) < 0.2 * xh) continue;
    for (let k = 1; k < body.length; k++) if (intersects(conn[i - 1], conn[i], body[k - 1], body[k])) hits++;
  }
  check(`counter ${pair}: connector stays out of the letter`, hits === 0, `${hits} crossing(s)`);
}

// 5. time --------------------------------------------------------------------------
for (const word of ['hello', 'minimum', 'its', 'Zoe']) {
  const r = composeWord(word, style);
  for (const c of r.chains) {
    let mono = true;
    for (let i = 1; i < c.times.length; i++) if (c.times[i] < c.times[i - 1] - 1e-9) mono = false;
    check(`time ${word} chain ${c.id}: monotonic`, mono);
    for (const s of c.stops) {
      const same = Math.hypot(c.pts[s + 1][0] - c.pts[s][0], c.pts[s + 1][1] - c.pts[s][1]) < 1e-9;
      const dwell = c.times[s + 1] - c.times[s];
      check(`time ${word} chain ${c.id}: dwell at stop ${s}`, same && dwell >= 0.02, `${(dwell * 1000).toFixed(0)} ms, ${same ? 'stationary' : 'moving'}`);
    }
  }
}

// 6. pair matrix snapshot ------------------------------------------------------
const snapPath = new URL('./pen-snapshots.json', import.meta.url);
const snap = {};
const alphabet = 'abcdefghijklmnopqrstuvwxyz';
for (const a of alphabet) for (const b of alphabet) {
  const r = composeWord(a + b, style);
  const h = createHash('sha1');
  for (const c of r.chains) for (const p of c.pts) h.update(`${p[0].toFixed(1)},${p[1].toFixed(1)};`);
  snap[a + b] = h.digest('hex').slice(0, 12);
}
if (update || !existsSync(snapPath)) {
  writeFileSync(snapPath, JSON.stringify(snap, null, 0));
  check('pairs: snapshot written', true, `${Object.keys(snap).length} pairs`);
} else {
  const old = JSON.parse(readFileSync(snapPath, 'utf8'));
  const changed = Object.keys(snap).filter((k) => old[k] !== snap[k]);
  check(`pairs: ${changed.length} of ${Object.keys(snap).length} changed since the snapshot`, !strict || changed.length === 0, changed.slice(0, 20).join(' ') + (changed.length > 20 ? ' …' : ''));
}

// report -------------------------------------------------------------------------
let failures = 0;
for (const r of results) {
  if (!r.ok) failures++;
  if (!r.ok || args.includes('--verbose')) console.log(`${r.ok ? 'ok ' : '!! '} ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
}
console.log(`${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
