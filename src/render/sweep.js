/**
 * Reveal maps: which pass of the pen uncovers each pixel of a glyph, and at
 * what arc length along that pass it does so.
 *
 * The nib is a disk whose radius follows the ink's half-width, read from the
 * distance map as a running minimum over 0.16 em of path, so a crossing or a
 * knot - which inflates the distance map for a stroke-width or two - cannot
 * widen it and reveal a piece of a stroke still to come. The passes are replayed in pen order and every pixel the disk
 * touches for the first time is claimed by that pass at that arc length -
 * first pass wins, exactly as ink on paper. The disk grows through the ink
 * only, so it never reaches across a counter to the far side of a loop.
 *
 * Whatever the disks never touch - a wedge, the flare of a foot, the far side
 * of a merge, a taper beyond the path's end - is handed to the nearest
 * claimed pixel and appears just after it, like ink spreading from the nib.
 * So a frame is always the font's own outline, cut by a round front, and
 * nothing has to pop in when a stroke completes.
 *
 * The one exception is a join between letters. Where the pen flows from one
 * letter into the next, the plan trims the first letter's exit hairline and
 * bridges the gap; the font's own tail beyond that cut, and any entry
 * hairline before the next letter's entry point, still exist as ink - two
 * shapes overlapping at a slight angle, with a notch where they cross. That
 * ink is never travelled, so it is hidden here (unless a real pass covers
 * it), and the animator paints the bridge as one smooth ribbon in its place.
 * The ribbon runs a short way (BLEND_EM) into both letters, reproducing the
 * ink's own cross-section there, so it merges into the letters seamlessly.
 */

import { fontToRaster } from '../lib/raster.js';
import { inkInfo } from '../lib/snap.js';
import { pointAtLength, polylineLength } from '../lib/geometry.js';

export const NIB_MIN_EM = 0.08;     // the nib's radius is read from the ink over this much path either way (past any knot)
export const NIB_PERCENTILE = 0.75; // ...at this percentile of it: a crossing's swell is outvoted, a shade's own is not
export const CROSS_CAP = 1.8;       // how far past that radius the measured cross-section may reach
export const CROSS_SLEW = 0.35;     // ...and how fast it may widen along the path (font units per unit travelled)
export const NIB_SLACK_PX = 1.0;    // the nib reaches this far past the measured half-width
export const EDGE_RING_PX = 2;      // background this close to ink joins the map (the outline clips it)
export const HIDDEN = -2;           // chain id of ink that is never shown (an untravelled tail at a join)
export const BLEND_EM = 0.08;       // how far the join ribbon runs into each letter

/**
 * @param {object} analysis  glyphs with rasters and word offsets
 * @param {Array}  chains    pen-down chains in time order (see timing.planChains)
 * @param {number} upem
 */
export function buildRevealMaps(analysis, chains, upem) {
  const glyphs = analysis.glyphs;
  let scaleMin = Infinity;
  for (const g of glyphs) if (g.raster && g.raster.scale < scaleMin) scaleMin = g.raster.scale;
  if (!Number.isFinite(scaleMin)) return { glyphs: [], unassigned: 0 };
  const step = 1 / scaleMin; // one raster pixel, in font units
  const sampled = chains.map((c) => sampleChain(c, step, glyphs, upem));
  capWidthsAtJunctions(sampled, step, upem);
  const out = [];
  let unassigned = 0;
  glyphs.forEach((g, gi) => {
    const m = g.raster ? buildGlyphMap(g, gi, chains, sampled, upem) : null;
    out[gi] = m;
    if (m) unassigned += m.unassigned;
  });
  return { glyphs: out, unassigned, sampled }; // sampled: for inspection
}

/** Samples along one chain with the nib radius (font units) at each. */
function sampleChain(chain, step, glyphs, upem) {
  const { poly, cum, L } = chain;
  const n = Math.max(2, Math.floor(L / step) + 2);
  const pts = new Array(n);
  const s = new Float32Array(n);
  const raw = new Float32Array(n);
  const item = new Int16Array(n);
  // which plan item (stroke or bridge) each arc length belongs to
  const items = chain.items;
  const ends = [];
  let acc = 0;
  for (const it of items) { acc += polylineLength(it.points); ends.push(acc); }
  let ii = 0;
  for (let k = 0; k < n; k++) {
    const sk = Math.min(L, k * step);
    s[k] = sk;
    while (ii < ends.length - 1 && sk > ends[ii]) ii++;
    item[k] = ii;
    const p = pointAtLength(poly, cum, sk);
    pts[k] = p;
    let best = 0;
    for (const g of glyphs) {
      const r = g.raster;
      if (!r) continue;
      const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) continue;
      const d = inkInfo(r).dist[yi * r.width + xi] / r.scale;
      if (d > best) best = d;
    }
    raw[k] = best;
  }
  // a sample off the ink (a bridge over a gap, a smoothed path leaving a
  // hairline) borrows its nearest inked neighbour
  for (let k = 0; k < n; k++) {
    if (raw[k] > 0) continue;
    for (let j = 1; k - j >= 0 || k + j < n; j++) {
      if (k - j >= 0 && raw[k - j] > 0) { raw[k] = raw[k - j]; break; }
      if (k + j < n && raw[k + j] > 0) { raw[k] = raw[k + j]; break; }
    }
  }
  // The radius is a running minimum: a crossing or a knot inflates the
  // distance map for a stroke-width or so, and the window reaches past it to
  // the band's own half-width on either side. It can only under-estimate -
  // along a taper, by the taper's slope - and ink the nib misses follows it
  // a moment later within the same pass (pass 2 below), which is invisible;
  // over-estimating would sweep a piece of a crossing stroke still to come.
  const W = Math.max(2, Math.round((NIB_MIN_EM * upem) / step));
  const R = runningPercentile(raw, W, NIB_PERCENTILE);

  // The ink's real cross-section: how far it reaches perpendicular to travel
  // on each side. A disc of radius R is only ever an inscribed circle - it
  // under-reads wherever the stroke is wider than it is round (a shade, a
  // taper) - and the ink it misses ends up owned by whichever pass is
  // nearest, which at a crossing is the one still to come.
  const halfL = new Float32Array(n);
  const halfR = new Float32Array(n);
  const tan = new Float32Array(2 * n);
  for (let k = 0; k < n; k++) {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    tan[2 * k] = dx / l;
    tan[2 * k + 1] = dy / l;
    const nx = -dy / l, ny = dx / l;
    const cap = Math.max(R[k] * CROSS_CAP, R[k] + 1 / (glyphs[0]?.raster?.scale || 1));
    halfL[k] = reachAcross(glyphs, pts[k], nx, ny, cap, R[k]);
    halfR[k] = reachAcross(glyphs, pts[k], -nx, -ny, cap, R[k]);
  }
  // A pen widens as it is pressed, not in one step. Where the path runs into
  // ink that is locally thick for a reason of its own - a join landing in the
  // eye of an `e`, where the loop crosses - the measurement jumps from a
  // hairline to a shade between one sample and the next, and the band claims
  // the whole crossing at once: a black wedge on the join. Limiting how fast
  // the cross-section may grow along the path leaves the swell of a real
  // shade untouched (it takes a fifth of an em) and clips the jump.
  slewLimit(halfL, s, CROSS_SLEW);
  slewLimit(halfR, s, CROSS_SLEW);
  return { pts, s, R, n, item, halfL, halfR, tan };
}

/**
 * Through a junction a stroke keeps the width it arrived with.
 *
 * The cross-section is measured perpendicular to the path, out to the ink's
 * edge or to the valley between two cores. Where two strokes cross at a
 * shallow angle there is no valley - their edges simply merge - and the
 * measurement runs on into the other stroke. That was the square nub on the
 * `L` and `J`: 356 of 358 pixels of the stem shown during the bowl were
 * claimed by the bowl's band where `hr` had grown to 13.8 px against a nib
 * radius of 10.
 *
 * Holding the band to the nib radius there removed the nub, and starved every
 * shaded stroke that crosses another: a pointed pen's shade is wider than the
 * circle inscribed in it, so the `z` and `b` lost ink at their crossings and
 * it came back late. The right bound is the stroke's own width as it enters
 * the junction - the pen does not change width because another stroke is
 * near - taken as the median over a short run of clean samples just before
 * the junction stretch (after it, for a stretch at the start of a chain), and
 * never less than the nib radius. Inside the stretch the measured width may
 * fall below that (a taper), never exceed it.
 *
 * Only the side that faces the other stroke. The inflation is one-sided -
 * on the `L` it was `hr` that grew while `hl` never moved - and a shade
 * swells through a crossing on its own convex side, which is a real width,
 * not a measurement running into something. Capping both sides starved the
 * `z` and `b` at their crossings; capping the facing side leaves the swell.
 *
 * "Another pass" is another chain, or the same chain far enough along to be
 * the stroke crossing itself; neighbouring samples are always within reach
 * and do not count. The reach is generous - half as much again as the two
 * half-widths - because edges merge well before centrelines meet.
 */
function capWidthsAtJunctions(sampled, step, upem) {
  const margin = 2 * step;
  const minGap = 0.12 * upem;
  let cell = margin;
  for (const sc of sampled) for (let k = 0; k < sc.n; k++) cell = Math.max(cell, sc.halfL[k], sc.halfR[k]);
  cell *= 3;
  const grid = new Map();
  sampled.forEach((sc, ci) => {
    for (let k = 0; k < sc.n; k++) {
      const key = `${Math.floor(sc.pts[k][0] / cell)},${Math.floor(sc.pts[k][1] / cell)}`;
      const b = grid.get(key);
      if (b) b.push(ci, k); else grid.set(key, [ci, k]);
    }
  });
  sampled.forEach((sc, ci) => {
    // which side of the path the other pass lies on, per sample
    const sides = [new Uint8Array(sc.n), new Uint8Array(sc.n)]; // [left, right]
    const junction = new Uint8Array(sc.n);
    for (let k = 0; k < sc.n; k++) {
      const [x, y] = sc.pts[k];
      const tx = sc.tan[2 * k], ty = sc.tan[2 * k + 1];
      const reach = Math.max(sc.halfL[k], sc.halfR[k]);
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const b = grid.get(`${gx},${gy}`);
          if (!b) continue;
          for (let i = 0; i < b.length; i += 2) {
            const cj = b[i], j = b[i + 1];
            const o = sampled[cj];
            if (cj === ci && Math.abs(o.s[j] - sc.s[k]) < minGap) continue;
            const dx = o.pts[j][0] - x, dy = o.pts[j][1] - y;
            const limit = 1.5 * (reach + Math.max(o.halfL[j], o.halfR[j])) + margin;
            if (dx * dx + dy * dy >= limit * limit) continue;
            // the normal (-ty, tx) points to the left of travel
            const across = dx * -ty + dy * tx;
            sides[across >= 0 ? 0 : 1][k] = 1;
            junction[k] = 1;
          }
        }
      }
    }
    sc.junction = junction;
    // the width the pen brought into each junction stretch
    const window = 0.08 * upem;
    const entering = (half, from, dir) => {
      const vals = [];
      const flagged = half === sc.halfL ? sides[0] : sides[1];
      for (let i = from; i >= 0 && i < sc.n && Math.abs(sc.s[i] - sc.s[from]) <= window; i += dir) {
        if (flagged[i]) break;
        vals.push(half[i]);
      }
      if (!vals.length) return null;
      vals.sort((p, q) => p - q);
      return vals[vals.length >> 1];
    };
    [sc.halfL, sc.halfR].forEach((half, side) => {
      const flagged = sides[side];
      let k = 0;
      while (k < sc.n) {
        if (!flagged[k]) { k++; continue; }
        let e = k;
        while (e + 1 < sc.n && flagged[e + 1]) e++;
        const before = k > 0 ? entering(half, k - 1, -1) : null;
        const after = e + 1 < sc.n ? entering(half, e + 1, 1) : null;
        const own = before ?? after;
        for (let i = k; i <= e; i++) {
          const cap = Math.max(sc.R[i], own ?? sc.R[i]);
          half[i] = Math.min(half[i], cap);
        }
        k = e + 1;
      }
    });
  });
}

/**
 * Clip a width profile so it never grows faster than `slew` per unit of arc,
 * from either direction. Only ever reduces: a spike is cut down to what its
 * neighbours can reach, a slope is left alone.
 */
function slewLimit(half, s, slew) {
  const n = half.length;
  for (let k = 1; k < n; k++) {
    const ds = Math.abs(s[k] - s[k - 1]);
    half[k] = Math.min(half[k], half[k - 1] + slew * ds);
  }
  for (let k = n - 2; k >= 0; k--) {
    const ds = Math.abs(s[k + 1] - s[k]);
    half[k] = Math.min(half[k], half[k + 1] + slew * ds);
  }
}

/**
 * How far the ink reaches from `p` along the unit direction (dx, dy), in font
 * units, stopping at the ink's edge, at `cap`, or in the valley between this
 * stroke and one crossing it.
 *
 * The valley is what keeps the measurement honest where two strokes overlap:
 * marching out of one stroke's core into a crossing, the distance to the
 * outline falls to a minimum between the two cores and rises again toward the
 * other one. Stopping at that minimum takes the stroke's own half-width and
 * leaves the rest of the union to the pass it belongs to. Where there is no
 * crossing there is no minimum, and the march simply runs to the edge.
 */
function reachAcross(glyphs, p, dx, dy, cap, R) {
  let raster = null, best = -1;
  for (const g of glyphs) {
    const r = g.raster;
    if (!r) continue;
    const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) continue;
    const d = inkInfo(r).dist[yi * r.width + xi];
    if (d > best) { best = d; raster = { r, x, y }; }
  }
  if (!raster || best <= 0) return R;
  const { r, x, y } = raster;
  const info = inkInfo(r);
  const stepPx = 0.5;
  // raster y grows downward, font y upward
  const ux = dx * stepPx, uy = -dy * stepPx;
  let prev = best, rising = false;
  const capPx = cap * r.scale;
  for (let t = stepPx; t <= capPx; t += stepPx) {
    const xi = Math.round(x + ux * (t / stepPx)), yi = Math.round(y + uy * (t / stepPx));
    if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) return t / r.scale;
    if (!r.fill[yi * r.width + xi]) return t / r.scale;
    const d = info.dist[yi * r.width + xi];
    // a valley: the distance fell away from this core and has started to climb
    // toward another. Half a pixel of noise is not a valley.
    if (d > prev + 0.5) rising = true;
    else if (rising && d < prev - 0.5) rising = false;
    if (rising && prev < best * 0.75) return (t - stepPx) / r.scale;
    prev = d;
  }
  return cap;
}

/**
 * The ink's half-width along the path, smoothed by taking a low percentile of
 * a window either side.
 *
 * Where strokes cross, the distance map balloons to the half-width of the
 * union, and a nib that followed it would sweep a piece of a stroke still to
 * come. The minimum of the window is immune to that, but it also drags the
 * nib down to the thinnest ink within a whole 0.08 em - and a pointed pen's
 * shade swells and tapers over about that distance, so the minimum leaves the
 * shade systematically narrower than the ink it is writing. The ink it misses
 * then belongs to whichever pass is nearest, which at a crossing is the one
 * still to come: the stroke was written with pieces broken out of it, filled
 * in a moment later when the crossing arrived.
 *
 * A high percentile sits between. A crossing inflates only the samples inside
 * it - a minority of a 0.16 em window - so the 75th percentile passes over
 * them and lands on the largest uninflated half-width, which is the stroke's
 * own. Only where a crossing is so shallow that it fills more than a quarter
 * of the window does the nib start to follow the union again.
 */
function runningPercentile(a, W, q) {
  const n = a.length;
  const out = new Float32Array(n);
  const buf = new Float32Array(2 * W + 1);
  for (let k = 0; k < n; k++) {
    const lo = Math.max(0, k - W), hi = Math.min(n - 1, k + W);
    let m = 0;
    for (let j = lo; j <= hi; j++) buf[m++] = a[j];
    const win = buf.subarray(0, m).slice().sort();
    out[k] = win[Math.min(m - 1, Math.floor(q * m))];
  }
  return out;
}

/** Ink plus a thin ring of background around it, so the map covers the outline's edge. */
function dilate(fill, w, h, rad) {
  const out = new Uint8Array(fill);
  const r2 = rad * rad;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (fill[i]) continue;
      let hit = false;
      for (let dy = -rad; dy <= rad && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w || dx * dx + dy * dy > r2) continue;
          if (fill[ny * w + nx]) { hit = true; break; }
        }
      }
      if (hit) out[i] = 1;
    }
  }
  return out;
}

/** The domain pixel nearest a sample, within a couple of pixels; -1 if none. */
function seedPixel(dom, w, h, xi, yi) {
  for (let rad = 0; rad <= 2; rad++) {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        const x = xi + dx, y = yi + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (dom[y * w + x]) return y * w + x;
      }
    }
  }
  return -1;
}

function buildGlyphMap(g, gi, chains, sampled, upem) {
  const r = g.raster;
  const { width: w, height: h, fill } = r;
  const N = w * h;
  const dist = inkInfo(r).dist;
  const dom = dilate(fill, w, h, EDGE_RING_PX);
  const chain = new Int16Array(N).fill(-1);
  const sArc = new Float32Array(N);
  // the pen's own centreline: the pixel under each sample, with its pass and arc
  const centreChain = new Int16Array(N).fill(-1);
  const centreS = new Float32Array(N);
  // provenance, for inspection: 1 band, 2 disk, 4 nearest path, 5 wedge
  const prov = new Uint8Array(N);
  const claimS = new Float32Array(N); // the arc of the sample whose band or disk claimed it
  const stamp = new Int32Array(N);
  const queue = new Int32Array(N);
  const used = new Set();
  let serial = 0;

  /**
   * Grow the nib's disk from (x, y) through the domain and claim pixels.
   * mode 'stroke': claims unclaimed and hidden pixels; 'bridge': unclaimed
   * only (a bridge never shows a join's untravelled ink); 'hide': marks
   * pixels hidden - unclaimed ones, and ones its own chain claimed (the
   * stroke's last nib disk reaching past the cut). With a `plane`, only
   * pixels on its far side are claimed or hidden (the rest are still
   * traversed): a hide stops at the cut, so the letter's real ink up to it
   * is untouched; a bridge claims this letter's ink only beyond its cut, or
   * only ahead of its entry, so a blunt entry end and whatever crosses it
   * wait for the letter's own passes.
   */
  /**
   * Claim the ink under one sample: the band the stroke's own cross-section
   * covers there, half a sample-spacing along the path either way. Like the
   * disc below it spreads through the ink only, so it cannot reach across a
   * counter, and the first pass to touch a pixel keeps it.
   *
   * Each pixel takes the arc length of its own place along the band, not the
   * sample's - a band is a rectangle, and giving the whole of it one arc made
   * the reveal front a staircase of square steps instead of a line drawn
   * across the stroke. It shows wherever the band is wide.
   *
   * The fill travels through any ink within reach but claims only what falls
   * inside the band. Letting it walk only where it may claim looks equivalent
   * and is not: the band is a straight rectangle laid on a curving stroke, so
   * ink at the outer edge of a bend is often reachable only by stepping
   * outside the rectangle and back in. Every band skipped those pixels, and
   * the next pass over that ink - the retrace of an `o`'s right side, hundreds
   * of units of arc later - collected them, which is what broke the stroke
   * into a comb of fragments as it was revealed.
   */
  const band = (x, y, tx, ty, hl, hr, along, mode, ci, sk, plane) => {
    const reach = Math.max(hl, hr, along) + 2;
    if (x < -reach || y < -reach || x > w - 1 + reach || y > h - 1 + reach) return;
    const seed = seedPixel(dom, w, h, Math.round(x), Math.round(y));
    if (seed < 0) return;
    serial++;
    let head = 0, tail = 0;
    queue[tail++] = seed;
    stamp[seed] = serial;
    while (head < tail) {
      const i = queue[head++];
      const c = chain[i];
      const px = i % w, py = (i - px) / w;
      const beyond = !plane || (px - plane.x) * plane.dx + (py - plane.y) * plane.dy >= 0;
      const alongHere = (px - x) * tx + (py - y) * ty;
      const acrossI = (px - x) * -ty + (py - y) * tx;
      // inside the band itself? (the fill travels wider than it claims)
      const inBand = Math.abs(alongHere) <= along
        && acrossI <= hl + NIB_SLACK_PX && -acrossI <= hr + NIB_SLACK_PX;
      if (!inBand) { /* travelled through, not claimed */ }
      else if (mode === 'hide') {
        if (beyond && (c === -1 || c === ci)) chain[i] = HIDDEN;
      } else if (beyond && (c === -1 || (c === HIDDEN && mode === 'stroke'))) {
        chain[i] = ci;
        sArc[i] = sk + alongHere / r.scale;
        prov[i] = 1; claimS[i] = sk;
        used.add(ci);
      }
      const acrossHere = Math.abs((px - x) * -ty + (py - y) * tx);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (stamp[j] === serial || !dom[j]) continue;
          const ex = nx - x, ey = ny - y;
          if (ex * ex + ey * ey > reach * reach) continue; // out of the band's neighbourhood
          const across = ex * -ty + ey * tx;
          // The valley: moving away from the path, the distance to the outline
          // falls while we are still in this stroke and climbs once we start up
          // the flank of one crossing it - so a step that goes both outward and
          // uphill leaves this stroke, and the ink beyond belongs to whichever
          // pass owns that core. Travel stops there; it is not just unclaimed.
          if (Math.abs(across) > acrossHere && dist[j] > dist[i] + 0.5) continue;
          stamp[j] = serial;
          queue[tail++] = j;
        }
      }
    }
  };

  const disk = (x, y, Rpx, mode, ci, sk, plane) => {
    if (x < -Rpx || y < -Rpx || x > w - 1 + Rpx || y > h - 1 + Rpx) return;
    const seed = seedPixel(dom, w, h, Math.round(x), Math.round(y));
    if (seed < 0) return;
    serial++;
    let head = 0, tail = 0;
    queue[tail++] = seed;
    stamp[seed] = serial;
    const R2 = Rpx * Rpx;
    while (head < tail) {
      const i = queue[head++];
      const c = chain[i];
      const px = i % w, py = (i - px) / w;
      const beyond = !plane || (px - plane.x) * plane.dx + (py - plane.y) * plane.dy >= 0;
      if (mode === 'hide') {
        if (beyond && (c === -1 || c === ci)) chain[i] = HIDDEN;
      } else if (beyond && (c === -1 || (c === HIDDEN && mode === 'stroke'))) {
        chain[i] = ci;
        sArc[i] = sk;
        prov[i] = 2; claimS[i] = sk;
        used.add(ci);
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (stamp[j] === serial || !dom[j]) continue;
          const ex = nx - x, ey = ny - y;
          if (ex * ex + ey * ey > R2) continue;
          stamp[j] = serial;
          queue[tail++] = j;
        }
      }
    }
  };

  // An untravelled hairline (raster px), from its cut point outward. The
  // stroke's own pass reclaims whatever its nib covers around the cut, so
  // the visible ink ends in the nib's round shape, never a corner; beyond
  // the hairline's last point the sweep runs on a little, to take the tip
  // (or a blunt end's corners) with it.
  const at = (p) => {
    const xi = Math.round(p[0]), yi = Math.round(p[1]);
    return xi < 0 || yi < 0 || xi >= w || yi >= h ? 0 : dist[yi * w + xi];
  };
  // `before` is the stroke point just inside the cut: it gives the direction
  // when the untravelled end is a single point (a blunt end with no hairline)
  const extend = (path, before) => {
    if (!path.length) return path;
    const b = path[path.length - 1];
    const a = path.length >= 2 ? path[path.length - 2] : before;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ext = at(path[0]) * 2 + 3;
    return path.concat([[b[0] + ((b[0] - a[0]) / len) * ext, b[1] + ((b[1] - a[1]) / len) * ext]]);
  };
  const hideTube = (path, ci) => {
    if (path.length < 2) return;
    const d0 = Math.hypot(path[1][0] - path[0][0], path[1][1] - path[0][1]) || 1;
    const plane = { x: path[0][0], y: path[0][1], dx: (path[1][0] - path[0][0]) / d0, dy: (path[1][1] - path[0][1]) / d0 };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let u = 0; u <= len; u += 1) {
        const t = len > 0 ? u / len : 0;
        const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
        // generous: a hairline's centreline sits a pixel or two off its middle
        disk(x, y, at([x, y]) + NIB_SLACK_PX + 3, 'hide', ci, 0, plane);
      }
    }
  };
  // The untravelled hairlines of a stroke at a join, as raster-px paths from
  // the cut outward: the tail beyond the exit cut, and a trimmed head before
  // the entry point. A blunt entry (nothing trimmed) is not hidden: the
  // ribbon arrives at the letter's full width and covers its end face. A
  // stroke entered mid-way has no head either: the pen writes back over it.
  const strokes = g.rasterStrokes || [];
  const exitPath = (it) => {
    const s = strokes[it.strokeIndex];
    return extend(s.slice(it.tailCut), s[Math.max(0, it.tailCut - 1)]);
  };
  const entryPath = (it) => {
    if (it.entry || !(it.headCut > 0)) return [];
    const s = strokes[it.strokeIndex];
    return extend(s.slice(0, it.headCut + 1).reverse(), s[Math.min(s.length - 1, it.headCut + 1)]);
  };
  const inGlyph = (it) => it.type === 'stroke' && it.glyphIndex === gi && strokes[it.strokeIndex];
  const hasTail = (it) => inGlyph(it) && it.tailCut < strokes[it.strokeIndex].length - 1;
  const hasHead = (it) => inGlyph(it) && !it.entry && it.headCut > 0;

  // A bridge's claims in this raster stop at a plane: beyond the cut when
  // this is the letter it leaves, ahead of the entry when this is the letter
  // it enters (undefined: not this letter's bridge at all).
  const planeAt = (p, d) => {
    const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
    const dx = d[0] * r.scale, dy = -d[1] * r.scale;
    const l = Math.hypot(dx, dy) || 1;
    return { x, y, dx: dx / l, dy: dy / l };
  };
  const bridgePlane = (it) => {
    const pts = it.points;
    if (!pts || pts.length < 2) return undefined;
    const m = pts.length - 1;
    if (it.from.glyphIndex === gi) return planeAt(pts[0], [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]]);
    if (it.to.glyphIndex === gi) return planeAt(pts[m], [pts[m][0] - pts[m - 1][0], pts[m][1] - pts[m - 1][1]]);
    return undefined;
  };

  // pass 1: the nib's disk, in pen order; first touch wins. A stroke claims
  // only in its own glyph (overriding hidden ink there: a later pass crossing
  // a join). When the pen leaves a stroke for a bridge, the stroke's
  // untravelled tail and the next stroke's trimmed head are hidden before
  // the bridge's samples run.
  for (let ci = 0; ci < sampled.length; ci++) {
    const sc = sampled[ci];
    const items = chains[ci].items;
    const planes = items.map((it) => (it.type === 'bridge' ? bridgePlane(it) : null));
    let cur = -1;
    for (let k = 0; k < sc.n; k++) {
      const ii = sc.item[k];
      if (ii !== cur) {
        if (items[ii].type === 'bridge') {
          if (cur >= 0 && hasTail(items[cur])) hideTube(exitPath(items[cur]), ci);
          const next = items[ii + 1];
          if (next && hasHead(next)) hideTube(entryPath(next), ci);
        }
        cur = ii;
      }
      const it = items[ii];
      let mode, plane = null;
      if (it.type === 'stroke') {
        if (it.glyphIndex !== gi) continue;
        mode = 'stroke';
      } else {
        plane = planes[ii];
        if (plane === undefined) continue;
        mode = 'bridge';
      }
      const p = sc.pts[k];
      const [x, y] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
      // the sample's own pixel: where pass 2 measures from
      const cx0 = Math.round(x), cy0 = Math.round(y);
      if (cx0 >= 0 && cy0 >= 0 && cx0 < w && cy0 < h && dom[cy0 * w + cx0] && centreChain[cy0 * w + cx0] < 0) {
        centreChain[cy0 * w + cx0] = ci;
        centreS[cy0 * w + cx0] = sc.s[k];
      }
      // the ends of a chain keep the nib's round tip; between them the band
      // of ink the stroke's own cross-section covers
      if (k === 0 || k === sc.n - 1) {
        disk(x, y, sc.R[k] * r.scale + NIB_SLACK_PX, mode, ci, sc.s[k], plane);
      } else {
        // raster y grows downward, so the tangent's y flips with it
        const tx = sc.tan[2 * k], ty = -sc.tan[2 * k + 1];
        // half the sample spacing either way, so consecutive bands tile
        const spacing = (sc.s[1] - sc.s[0]) * r.scale;
        band(x, y, tx, ty, sc.halfL[k] * r.scale, sc.halfR[k] * r.scale,
          spacing * 0.75 + 1, mode, ci, sc.s[k], plane);
      }
    }
  }

  // remember what the nibs themselves claimed, before anything spreads
  const nibChain = Int16Array.from(chain);
  const nibS = Float32Array.from(sArc);
  const corners = [];
  for (let i = 0; i < N; i++) if (fill[i] && chain[i] === -1) corners.push(i);

  // pass 2: everything else joins the nearest claimed pixel, a little later.
  // Hidden ink first hands itself to the background fringe around it (so the
  // outline's anti-aliased rim over a hidden tail stays hidden too), but never
  // to ink: ink the nib missed always follows a visible neighbour.
  const INF = 0x3fffffff;
  const unitPerPx = 1 / r.scale;
  const propagate = (isSeed, mayEnter, maxD, crossHidden) => {
    const dd = new Int32Array(N).fill(INF);
    // the visible pass a wave carries, even while crossing hidden pixels
    const src = new Int16Array(N).fill(-1);
    const srcS = new Float32Array(N);
    const buckets = [];
    const push = (d, i) => { (buckets[d] || (buckets[d] = [])).push(i); };
    for (let i = 0; i < N; i++) if (isSeed(i)) { dd[i] = 0; src[i] = chain[i]; srcS[i] = sArc[i]; push(0, i); }
    for (let d = 0; d < buckets.length && d <= maxD; d++) {
      const b = buckets[d];
      if (!b) continue;
      for (const i of b) {
        if (dd[i] !== d) continue;
        const px = i % w, py = (i - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (!dom[j]) continue;
            const nd = d + (dx && dy ? 4 : 3);
            if (nd >= dd[j]) continue;
            const free = chain[j] === -1 || dd[j] < INF;
            if (free && !mayEnter(j)) continue;
            if (!free && !(crossHidden && chain[j] === HIDDEN)) continue;
            dd[j] = nd;
            if (free) {
              chain[j] = src[i] >= 0 ? src[i] : chain[i];
              sArc[j] = srcS[i] + ((dx && dy ? 4 : 3) / 3) * unitPerPx;
              src[j] = chain[j];
              srcS[j] = sArc[j];
            } else {
              src[j] = src[i];
              srcS[j] = srcS[i] + ((dx && dy ? 4 : 3) / 3) * unitPerPx;
            }
            push(nd, j);
          }
        }
      }
    }
  };
  propagate((i) => chain[i] === HIDDEN, (j) => !fill[j], 3 * EDGE_RING_PX + 1, false);

  // Ink no nib reached joins the pass whose *path* is nearest through the
  // ink, at that path's arc plus the distance - not the nearest claimed
  // pixel. Measured from claimed pixels, a leftover beside a wide claim
  // joins that claim whichever stroke it lies on; measured from the
  // centrelines it joins the stroke it is part of. On the `L` that is the
  // difference between 27 pixels of the stem showing with the bowl and 2. A
  // pixel already claimed is passed through and keeps its pass and arc.
  {
    const dd = new Int32Array(N).fill(INF);
    const src = new Int16Array(N).fill(-1);
    const srcS = new Float32Array(N);
    const buckets = [];
    const push = (d, i) => { (buckets[d] || (buckets[d] = [])).push(i); };
    for (let i = 0; i < N; i++) if (centreChain[i] >= 0) { dd[i] = 0; src[i] = centreChain[i]; srcS[i] = centreS[i]; push(0, i); }
    for (let d = 0; d < buckets.length; d++) {
      const b = buckets[d];
      if (!b) continue;
      for (const i of b) {
        if (dd[i] !== d) continue;
        const px = i % w, py = (i - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (!dom[j]) continue;
            const nd = d + (dx && dy ? 4 : 3);
            if (nd >= dd[j]) continue;
            dd[j] = nd;
            src[j] = src[i];
            srcS[j] = srcS[i] + ((dx && dy ? 4 : 3) / 3) * unitPerPx;
            if (chain[j] === -1) { chain[j] = src[j]; sArc[j] = srcS[j]; prov[j] = 4; }
            push(nd, j);
          }
        }
      }
    }
  }

  // pass 3: where two passes cross, the ink in the wedges between them
  // belongs to neither nib's tube. It exists only because both strokes are
  // there, so it appears with the later one - not as a knot on the first
  // stroke through the crossing, foreshadowing the one still to come.
  //
  // Only ink that really lies *between* the two passes: a corner pixel is
  // deferred when the later pass is no further from it than the nearest pass
  // is. Ink that hugs the stroke under the pen is that stroke's own, however
  // soon another pass crosses beside it - a pen writing a wide shade covers
  // more than its own nib radius, and the ink either side of a crossing is
  // part of the shade, not of the wedge. Deferring that punched holes into a
  // stroke as it was written, which filled in when the crossing arrived.
  const CR = 8, CR2 = CR * CR;
  const WEDGE_SLACK_PX = 1.5;
  const timeOf = (c, s) => c * 1e7 + s;
  const passGap = 0.08 * upem; // arc length that separates two passes of one chain
  for (const i of corners) {
    if (chain[i] < 0) continue;
    const px = i % w, py = (i - px) / w;
    let lateT = -Infinity, lateJ = -1, lateD2 = 0, nearD2 = Infinity;
    for (let dy = -CR; dy <= CR; dy++) {
      const ny = py + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -CR; dx <= CR; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > CR2) continue;
        const nx = px + dx;
        if (nx < 0 || nx >= w) continue;
        const j = ny * w + nx;
        if (nibChain[j] < 0) continue;
        if (d2 < nearD2) nearD2 = d2;
        const t = timeOf(nibChain[j], nibS[j]);
        if (t > lateT) { lateT = t; lateJ = j; lateD2 = d2; }
      }
    }
    if (lateJ < 0) continue;
    const own = timeOf(chain[i], sArc[i]);
    if (lateT - own <= passGap) continue; // the same pass: a bulge, not a wedge
    if (Math.sqrt(lateD2) > Math.sqrt(nearD2) + WEDGE_SLACK_PX) continue; // beside a pass, not between two
    chain[i] = nibChain[lateJ];
    sArc[i] = nibS[lateJ] + Math.sqrt(lateD2) * unitPerPx;
    prov[i] = 5;
  }

  let unassigned = 0, hidden = 0, count = 0;
  for (let i = 0; i < N; i++) {
    if (dom[i]) count++;
    if (fill[i] && chain[i] === -1) unassigned++;
    if (fill[i] && chain[i] === HIDDEN) hidden++;
  }
  const domain = new Int32Array(count);
  for (let i = 0, q = 0; i < N; i++) if (dom[i]) domain[q++] = i;

  return { w, h, chain, s: sArc, domain, chainsUsed: [...used].sort((a, b) => a - b), unassigned, hidden, prov, claimS };
}
