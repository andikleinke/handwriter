/**
 * The stroke renderer (prototype, 2026-10-18): the pen's path IS the letter.
 *
 * Every pen-down chain becomes one continuous ribbon - the recovered
 * centreline with a left and a right profile, the measured cross-sections
 * after the junction and join rules of sweep.js - and a frame is simply that
 * ribbon filled up to the pen's arc length, with the nib's round footprint at
 * either end. No outline is uncovered, no raster map decides who owns a
 * pixel, nothing is clipped: a later pass paints over an earlier one, as ink
 * does, and the finished frame is the same renderer at full progress.
 *
 * What this costs: the silhouette is the ribbon's, not the font's outline.
 * The outline is kept as the design and layout reference and as the target
 * the ribbon is measured against (scripts/inspect.js silhouette()); the
 * recovered path and profiles are the authoring starting point, to be refined
 * against it.
 */

/** @typedef {{ chain: number, s: Float32Array, pts: Array<[number, number]>, left: Array<[number, number]>, right: Array<[number, number]>, r0: number, r1: number }} StrokeRibbon */

const SMOOTH_EM = 0.02; // the profiles are smoothed over this much path (a measurement jitters sample to sample; a pen does not)

/**
 * Build one ribbon per chain from the sampled chains the reveal maps hold.
 * @param {{sampled: Array}} maps  from buildRevealMaps
 * @param {number} upem
 * @returns {StrokeRibbon[]}
 */
export function buildStrokeProgram(maps, upem, scale = 0.512) {
  const out = [];
  // a cross-section reading runs to the centre of the first background pixel,
  // half a raster pixel past the ink: the ribbon stops at the ink
  const bias = 0.5 / scale;
  maps.sampled.forEach((sc, ci) => {
    const n = sc.n;
    if (n < 2) return;
    const step = sc.s[1] - sc.s[0] || 1;
    const win = Math.max(1, Math.round((SMOOTH_EM * upem) / step));
    const smooth = (arr) => {
      const o = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        let sum = 0, c = 0;
        for (let j = Math.max(0, k - win); j <= Math.min(n - 1, k + win); j++) { sum += arr[j]; c++; }
        o[k] = sum / c;
      }
      return o;
    };
    const hl = smooth(sc.halfL).map((v) => Math.max(0.5 / scale, v - bias));
    const hr = smooth(sc.halfR).map((v) => Math.max(0.5 / scale, v - bias));
    // the nib's radius along the chain (sweep.js: the running minimum of the
    // ink's half-width, which a crossing or a knot does not inflate)
    const nib = sc.R ? Float32Array.from(sc.R).map((v) => Math.max(0.5 / scale, v - bias)) : null;
    const rb = { chain: ci, s: sc.s, pts: sc.pts.map((p) => [p[0], p[1]]), tan: sc.tan, hl, hr, nib, rad: null, left: null, right: null, _cache: null };
    rebuildEdges(rb);
    out.push(rb);
  });
  return out;
}

/** The ribbon's left and right edges from its centreline and profiles. */
export function rebuildEdges(rb) {
  const n = rb.pts.length;
  rb.left = new Array(n); rb.right = new Array(n);
  rb.rad = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const [x, y] = rb.pts[k];
    const nx = -rb.tan[2 * k + 1], ny = rb.tan[2 * k]; // the left normal
    rb.left[k] = [x + nx * rb.hl[k], y + ny * rb.hl[k]];
    rb.right[k] = [x - nx * rb.hr[k], y - ny * rb.hr[k]];
    // The disc at a sample is the nib's footprint: its radius, clamped to the
    // two half-widths. Where the halves differ - the outside of a sharp turn
    // reads wide, the inside narrow - the smaller half alone left the turn's
    // outer round cut flat by the straight edge between the legs' offsets.
    // (the nib's radius was tried here: it spilled wherever a half had been
    // cut on purpose at a junction, +2 % XOR; the corners are rounded by the
    // joins in piece() instead)
    rb.rad[k] = Math.min(rb.hl[k], rb.hr[k]);
  }
  rb._cache = null;
}

const CHUNK = 24; // samples per cached piece of ribbon

/**
 * The pieces of a ribbon: samples [k0, k1] as consistently wound triangles
 * plus a disc at each sample, as one Path2D in CSS space. The ribbon as a
 * single left-edge/right-edge polygon folded over itself where the inner
 * offset reverses on a tight hook, and the fold's winding cancelled the
 * ribbon's, punching a hole that moved with the pen (Autography's `x` lost
 * thousands of pixels over a run); pieces wound the same way union cleanly
 * under a nonzero fill, and the discs fill the outer wedge of every turn and
 * round the start and the front.
 */
export function piece(L, R, C, k0, k1, RAD = null) {
  const path = new Path2D();
  const tri = (a, b, c) => {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-6) return;
    if (area < 0) { const t = b; b = c; c = t; }
    path.moveTo(a[0], a[1]); path.lineTo(b[0], b[1]); path.lineTo(c[0], c[1]); path.closePath();
  };
  const disc = (c, l, r, k) => {
    const rad = RAD ? RAD[k] : Math.min(Math.hypot(l[0] - c[0], l[1] - c[1]), Math.hypot(r[0] - c[0], r[1] - c[1]));
    if (rad > 0.3) { path.moveTo(c[0] + rad, c[1]); path.arc(c[0], c[1], rad, 0, Math.PI * 2); }
  };
  // a round join at every turn: where the path bends by more than a few
  // degrees between samples, the straight edge between the two offsets cuts
  // the outside of the bend (a corner of the recovered path, a sharp arch)
  // and the disc, centred on the path, cannot reach it. A pie at the vertex,
  // of that side's own half-width, from the normal before to the normal
  // after, is what a round nib leaves there. Both sides get one: the inner
  // pie lies within the two legs' ink anyway.
  const pie = (v, a, b, r) => {
    if (r < 0.3) return;
    let a0 = Math.atan2(a[1] - v[1], a[0] - v[0]), a1 = Math.atan2(b[1] - v[1], b[0] - v[0]);
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(d) / (Math.PI / 18)));
    const pts = [v];
    for (let i = 0; i <= steps; i++) { const t = a0 + (d * i) / steps; pts.push([v[0] + r * Math.cos(t), v[1] + r * Math.sin(t)]); }
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
    if (Math.abs(area) < 1e-6) return;
    if (area < 0) pts.reverse();
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
  };
  for (let k = k0; k < k1; k++) {
    tri(L[k], L[k + 1], R[k + 1]);
    tri(L[k], R[k + 1], R[k]);
  }
  for (let k = k0; k <= k1; k++) disc(C[k], L[k], R[k], k);
  for (let k = Math.max(1, k0); k < k1; k++) {
    const ax = C[k][0] - C[k - 1][0], ay = C[k][1] - C[k - 1][1], bx = C[k + 1][0] - C[k][0], by = C[k + 1][1] - C[k][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cos = (ax * bx + ay * by) / (la * lb);
    if (cos > JOIN_COS) continue; // a gentle bend: the samples' own offsets trace it
    pie(C[k], L[k - 1], L[k + 1], Math.hypot(L[k][0] - C[k][0], L[k][1] - C[k][1]));
    pie(C[k], R[k - 1], R[k + 1], Math.hypot(R[k][0] - C[k][0], R[k][1] - C[k][1]));
  }
  return path;
}
const JOIN_COS = Math.cos((8 * Math.PI) / 180); // a bend sharper than this between samples gets a round join

/**
 * Fill one ribbon up to arc length `p` (font units; Infinity = whole).
 * The finished part is cached per layout as Path2D chunks (a word's ribbons
 * are thousands of triangles; rebuilding them every frame cost 30 ms);
 * only the chunk the front is in is built for the frame.
 * @param {CanvasRenderingContext2D} ctx
 * @param {StrokeRibbon} rb
 * @param {number} p
 * @param {(q: [number, number]) => [number, number]} toCss
 * @param {string} ink
 * @param {object} cacheKey  anything that changes when the CSS mapping does
 */
export function paintRibbon(ctx, rb, p, toCss, ink, cacheKey = null) {
  const { s, pts, left, right } = rb;
  const n = s.length;
  if (p === -Infinity || p < s[0]) return;
  if (!rb._cache || rb._cache.key !== cacheKey) {
    const L = left.map(toCss), R = right.map(toCss), C = pts.map(toCss);
    // the CSS scale, for the discs' radii
    const o = toCss(pts[0]), ox = toCss([pts[0][0] + 1, pts[0][1]]);
    const sc = Math.hypot(ox[0] - o[0], ox[1] - o[1]);
    const RAD = rb.rad ? Array.from(rb.rad, (v) => v * sc) : null;
    rb._cache = { key: cacheKey, L, R, C, RAD, sc, chunks: new Map() };
  }
  const { L, R, C, RAD, sc, chunks } = rb._cache;
  let m = 0;
  const whole = p === Infinity || p >= s[n - 1];
  if (whole) m = n - 1;
  else { while (m + 1 < n && s[m + 1] <= p) m++; }
  ctx.save();
  ctx.fillStyle = ink;
  // the finished chunks
  const full = Math.floor(m / CHUNK);
  for (let c = 0; c < full; c++) {
    let path = chunks.get(c);
    if (!path) { path = piece(L, R, C, c * CHUNK, Math.min(n - 1, (c + 1) * CHUNK), RAD); chunks.set(c, path); }
    ctx.fill(path, 'nonzero');
  }
  // the chunk the front is in, with the front interpolated between samples
  const k0 = full * CHUNK;
  let lF = L[m], rF = R[m], cF = C[m];
  if (!whole && m + 1 < n) {
    const t = (p - s[m]) / (s[m + 1] - s[m] || 1);
    const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    lF = lerp(L[m], L[m + 1]); rF = lerp(R[m], R[m + 1]); cF = lerp(C[m], C[m + 1]);
  }
  const Lp = L.slice(k0, m + 1).concat([lF]), Rp = R.slice(k0, m + 1).concat([rF]), Cp = C.slice(k0, m + 1).concat([cF]);
  const Rp2 = RAD ? RAD.slice(k0, m + 1).concat([RAD[Math.min(n - 1, m + 1)] != null && !whole && m + 1 < n ? RAD[m] + (RAD[m + 1] - RAD[m]) * ((p - s[m]) / (s[m + 1] - s[m] || 1)) : RAD[m]]) : null;
  ctx.fill(piece(Lp, Rp, Cp, 0, Lp.length - 1, Rp2), 'nonzero');
  // The nib's front: the ribbon's own next half-width of path, clipped to
  // the disc that spans the cross-section at the front. The per-sample disc
  // is centred on the path with the smaller half-width, so where the profile
  // is asymmetric (one side cut at a junction, a shade) the front was a
  // straight edge with a smaller round on it; a bare full-width disc bulged
  // past the outer edge on a bend and vanished again as the pen moved on.
  // Clipping the ink still to come keeps the front round and inside the
  // stroke, so nothing shows that is not drawn for good a moment later.
  if (!whole && m + 1 < n) {
    const mx = (lF[0] + rF[0]) / 2, my = (lF[1] + rF[1]) / 2;
    const r = Math.hypot(lF[0] - rF[0], lF[1] - rF[1]) / 2;
    if (r > 0.3) {
      const ahead = Math.min(s[n - 1], p + r / sc);
      let m2 = m;
      while (m2 + 1 < n && s[m2 + 1] <= ahead) m2++;
      let lA = L[m2], rA = R[m2], cA = C[m2];
      if (m2 + 1 < n) {
        const t2 = (ahead - s[m2]) / (s[m2 + 1] - s[m2] || 1);
        const lerp2 = (a, b) => [a[0] + (b[0] - a[0]) * t2, a[1] + (b[1] - a[1]) * t2];
        lA = lerp2(L[m2], L[m2 + 1]); rA = lerp2(R[m2], R[m2 + 1]); cA = lerp2(C[m2], C[m2 + 1]);
      }
      const La = [lF, ...L.slice(m + 1, m2 + 1), lA], Ra = [rF, ...R.slice(m + 1, m2 + 1), rA], Ca = [cF, ...C.slice(m + 1, m2 + 1), cA];
      const clip = new Path2D();
      clip.arc(mx, my, r, 0, Math.PI * 2);
      ctx.save();
      ctx.clip(clip);
      ctx.fill(piece(La, Ra, Ca, 0, La.length - 1), 'nonzero');
      ctx.restore();
    }
  }
  ctx.restore();
}
