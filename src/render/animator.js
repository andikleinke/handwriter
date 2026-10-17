/**
 * Ink-reveal animation on the timing model.
 *
 * What is drawn is always the font's own outline. Each glyph carries a reveal
 * map (render/sweep.js): for every pixel of its ink, which pen-down chain
 * uncovers it and at what arc length along that chain. A frame turns each
 * chain's progress into per-pixel alpha - a soft round front just behind the
 * nib - and paints the outline through it. Nothing is approximated, and
 * nothing pops in: a pixel the nib never reaches appears with the nearest one
 * it does.
 *
 * A join between letters is the exception: the font's untravelled tails
 * there are hidden by the map, and the join is painted as one ribbon that
 * carries the ink's own cross-section out of one letter, across the bridge,
 * and into the next, revealed with the nib like everything else.
 *
 * Time is the clock: the timing model decides how fast the pen moves where
 * (see lib/timing.js).
 */

import { setupHiDPI, computeLayout, rasterPlacement } from './layout.js';
import { buildTimeline, planChains, arcAt, penState, DEFAULT_SPEED_MODEL } from '../lib/timing.js';
import { cumulativeLengths, pointAtLength } from '../lib/geometry.js';
import { fontToRaster } from '../lib/raster.js';
import { buildRevealMaps, HIDDEN, BLEND_EM, NIB_SLACK_PX } from './sweep.js';

// Soft leading edge of the reveal, in raster px: enough to anti-alias the
// front, never enough to show ink ahead of the nib.
const FRONT_FEATHER_PX = 1.5;
// How far behind the pen the raster map fills in what a stroke's band claimed
// (font em). Zero: the map's edge pixels carry fractional coverage, so the
// two agree to the sub-pixel and holding the map back only left slivers
// along a shade's free edge until the pen had moved on.
const BAND_LAG_EM = 0;

export class Animator {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = null;
    this.layout = null;
    this.analysis = null;
    this.chains = [];
    this.maps = null;
    this.layers = [];
    this.timeline = null;
    this.raf = 0;
    this.playing = false;
    this.speed = 2.2;                       // average pen speed, em per second
    this.model = { ...DEFAULT_SPEED_MODEL };
    this.showPen = true;
    this.ink = '#101418';
    this.time = 0;                          // seconds into the timeline
    this.onProgress = null;
    this.loop = true;
    this.bottomInset = 0;                   // CSS px at the bottom kept free of the word (player controls)
    this._paths = [];
    this._ribbons = [];
    this._bands = [];
  }

  get duration() {
    return this.timeline?.total ?? 0;
  }

  /** Ink pixels no pen pass reaches; they appear when the run completes. */
  get unreachedInk() {
    return this.maps?.unassigned ?? 0;
  }

  /** Build the reveal maps and the timeline. Call after analysis / replan. */
  load(analysis) {
    this.stop();
    this.analysis = analysis;
    this.chains = planChains(analysis.plan);
    this.maps = buildRevealMaps(analysis, this.chains, this._upem());
    this._paths = analysis.glyphs.map((g) => (g.path ? new Path2D(g.path) : null));
    this.layers = analysis.glyphs.map((g, gi) => makeLayer(this.maps.glyphs[gi], this.ink));
    this._bands = buildBands(this.maps, this.chains, analysis.glyphs);
    this.rebuildTimeline(false);
    this.resize();
  }

  rebuildTimeline(keepPosition) {
    if (!this.analysis?.plan) return;
    const frac = keepPosition && this.timeline ? this.time / this.timeline.total : 0;
    const upem = this._upem();
    this.timeline = buildTimeline(this.analysis.plan, {
      unitsPerEm: upem,
      avgSpeed: this.speed * upem,
      model: this.model,
    });
    this.time = frac * this.timeline.total;
    this._ribbons = buildRibbons(this.timeline, this.analysis, upem);
  }

  resize() {
    if (!this.analysis) return;
    const cssW = this.canvas.clientWidth || 900;
    const cssH = this.canvas.clientHeight || 320;
    this.ctx = setupHiDPI(this.canvas, cssW, cssH);
    this.layout = computeLayout(this.analysis.bounds, cssW, Math.max(80, cssH - this.bottomInset), 40);
    this.drawAt(this.time);
  }

  play() {
    if (!this.timeline) return;
    if (this.time >= this.timeline.total) this.time = 0;
    this.playing = true;
    cancelAnimationFrame(this.raf);
    // Advance by a clamped per-frame delta rather than absolute elapsed time:
    // rAF stops in a background tab, and an absolute clock would jump to the
    // end the moment the tab regained focus.
    let last = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const total = this.timeline.total;
      let T = this.time + dt;
      if (T >= total) {
        // hand listeners the completed run first (the recorder stops on it)
        this.time = total;
        this.drawAt(total);
        this.onProgress?.(1, this.loop);
        if (!this.loop || !this.playing) {
          this.playing = false;
          return;
        }
        // loop: wrap straight into the next run, no pause at the end
        T = T - total;
        if (T >= total) T = 0;
      }
      this.time = T;
      this.drawAt(T);
      this.onProgress?.(T / total, true);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  stop() {
    this.pause();
    this.time = 0;
  }

  replay() {
    this.stop();
    this.play();
  }

  seekFraction(f) {
    if (!this.timeline) return;
    this.pause();
    this.time = f * this.timeline.total;
    this.drawAt(this.time);
    this.onProgress?.(f, false);
  }

  /** Average speed in em/s; the timeline is rebuilt around the current position. */
  setSpeed(emPerSecond) {
    this.speed = emPerSecond;
    if (this.timeline) {
      this.rebuildTimeline(true);
      this.drawAt(this.time);
    }
  }

  setModel(patch) {
    Object.assign(this.model, patch);
    if (this.timeline) {
      this.rebuildTimeline(true);
      this.drawAt(this.time);
    }
  }

  /**
   * Render the run frame by frame on a fixed clock into a canvas of its own,
   * for a movie: transparent background, the word fitted to `width` with a
   * margin, `fps` frames a second, then the finished word held for `hold`
   * seconds. Nothing is skipped or dropped the way a real-time capture drops
   * frames, and the preview canvas is left exactly as it was.
   *
   * `onFrame(canvas, index, count)` may be async and is awaited before the
   * next frame is drawn into the same canvas.
   */
  async renderFrames({ width = 1920, fps = 60, hold = 1, margin = 0.06, showPen = this.showPen } = {}, onFrame) {
    if (!this.timeline || !this.analysis) throw new Error('nothing to render yet');
    const bounds = this.analysis.bounds;
    const W = width - (width % 2);
    const pad = Math.round(W * margin);
    let H = Math.round((W - 2 * pad) * (Math.max(bounds.h, 1) / Math.max(bounds.w, 1)) + 2 * pad);
    H += H % 2; // video codecs want even sizes
    const saved = { canvas: this.canvas, ctx: this.ctx, layout: this.layout, time: this.time, showPen: this.showPen };
    this.pause();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layout = computeLayout(bounds, W, H, pad);
    this.showPen = showPen;
    // the glyph layers are cached by reveal progress: start them afresh
    for (const layer of this.layers) if (layer) layer.key = null;
    const total = this.timeline.total;
    const count = Math.ceil((total + hold) * fps) + 1;
    try {
      for (let f = 0; f < count; f++) {
        this.drawAt(Math.min(total, f / fps));
        await onFrame(canvas, f, count);
      }
    } finally {
      Object.assign(this, saved);
      for (const layer of this.layers) if (layer) layer.key = null;
      this.drawAt(this.time);
    }
    return { width: W, height: H, fps, count };
  }

  _upem() {
    return this.analysis?.glyphs.find((g) => g.record)?.record.unitsPerEm || 1000;
  }

  /** @param {number} T seconds into the timeline */
  drawAt(T) {
    const { ctx, analysis, layout, timeline } = this;
    if (!ctx || !timeline || !analysis) return;
    const cssW = layout.cssWidth, cssH = layout.cssHeight;
    ctx.clearRect(0, 0, cssW, cssH);
    const dpr = this.canvas.width / cssW;

    // how far along each chain the nib is, in font units
    const prog = timeline.chains.map((c) => (T < c.t0 ? -Infinity : T >= c.t1 ? Infinity : arcAt(c, T)));
    const done = T >= timeline.total;

    // the joins between letters first, under the letters: a bridge band is
    // drawn as it is, with the planner's taper from one ink width to the
    // other, and runs a few samples into each letter so the seam between it
    // and the letter's own band lies inside ink the letter draws over
    if (this._bands.bridges) {
      if (!done) for (const band of this._bands.bridges) this._paintBand(band, prog[band.chain]);
    } else {
      for (const rb of this._ribbons) {
        const p = prog[rb.chain];
        const revealed = p === Infinity ? rb.L : p === -Infinity ? 0 : Math.min(rb.L, p - rb.s0);
        if (revealed > 0) this._paintRibbon(rb, revealed);
      }
    }
    if (done) for (const rb of this._ribbons) this._paintRibbon(rb, rb.L);

    analysis.glyphs.forEach((g, gi) => {
      const layer = this.layers[gi];
      const map = this.maps.glyphs[gi];
      if (!layer || !map) return;
      const key = map.chainsUsed.map((ci) => prog[ci]).join(',') + (done ? '|end' : '');
      if (layer.key !== key) {
        revealLayer(layer, map, prog, done, FRONT_FEATHER_PX / g.raster.scale, BAND_LAG_EM * this._upem());
        layer.key = key;
      }
      const place = rasterPlacement(layout, g);
      const p2d = this._paths[gi];
      ctx.save();
      if (p2d) {
        // the outline itself is the edge; the layer only decides what is uncovered
        ctx.translate(layout.originX + g.x * layout.s, layout.baselineY - g.y * layout.s);
        ctx.scale(layout.s, layout.s);
        ctx.clip(p2d, 'nonzero');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.drawImage(layer.canvas, place.dx, place.dy, place.dw, place.dh);
      // the strokes themselves, as vector bands over the raster: their edges
      // through a junction are lines, not pixels
      if (!done) for (const band of this._bands[gi] || []) this._paintBand(band, prog[band.chain]);
      ctx.restore();
    });


    if (this.showPen && T < timeline.total) {
      const st = penState(timeline, T);
      if (st) this._drawPen(this._toCss(st.at), st.kind === 'up');
    }
  }

  /**
   * One stroke's band, filled up to the chain's progress `p` (font units of
   * arc) with the nib's round front at the pen. The band is the stroke's own
   * cross-section at every sample, as the reveal map measured it; on a free
   * edge it reaches a little past the ink and the outline clips it, on a side
   * facing another stroke it stops exactly at the width.
   */
  _paintBand(band, p) {
    if (p === -Infinity || p < band.s[0]) return;
    const { ctx } = this;
    const { s, left, right } = band;
    const n = s.length;
    let m = 0;
    if (p === Infinity || p >= s[n - 1]) m = n - 1;
    else { while (m + 1 < n && s[m + 1] <= p) m++; }
    let lF = left[m], rF = right[m];
    if (m + 1 < n && p !== Infinity && p < s[n - 1]) {
      const t = (p - s[m]) / (s[m + 1] - s[m] || 1);
      lF = [left[m][0] + (left[m + 1][0] - left[m][0]) * t, left[m][1] + (left[m + 1][1] - left[m][1]) * t];
      rF = [right[m][0] + (right[m + 1][0] - right[m][0]) * t, right[m][1] + (right[m + 1][1] - right[m][1]) * t];
    }
    ctx.save();
    ctx.fillStyle = this.ink;
    ctx.beginPath();
    const p0 = this._toCss(left[0]);
    ctx.moveTo(p0[0], p0[1]);
    for (let k = 1; k <= m; k++) { const q = this._toCss(left[k]); ctx.lineTo(q[0], q[1]); }
    const lc = this._toCss(lF), rc = this._toCss(rF);
    ctx.lineTo(lc[0], lc[1]);
    ctx.lineTo(rc[0], rc[1]);
    for (let k = m; k >= 0; k--) { const q = this._toCss(right[k]); ctx.lineTo(q[0], q[1]); }
    ctx.closePath();
    ctx.fill();
    // the nib is round: the front is a half-disc on the current cross-section
    if (p !== Infinity && p < s[n - 1]) {
      const cx = (lc[0] + rc[0]) / 2, cy = (lc[1] + rc[1]) / 2;
      const rad = Math.hypot(lc[0] - rc[0], lc[1] - rc[1]) / 2;
      if (rad > 0.3) { ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }

  /** The join ribbon, filled up to arc length `upTo` (font units) with a round front. */
  _paintRibbon(rb, upTo) {
    const { ctx } = this;
    const { pts, cum, left, right } = rb;
    let m = 0;
    while (m + 1 < pts.length && cum[m + 1] <= upTo) m++;
    let lF = left[m], rF = right[m];
    if (m + 1 < pts.length) {
      const t = (upTo - cum[m]) / (cum[m + 1] - cum[m] || 1);
      lF = [left[m][0] + (left[m + 1][0] - left[m][0]) * t, left[m][1] + (left[m + 1][1] - left[m][1]) * t];
      rF = [right[m][0] + (right[m + 1][0] - right[m][0]) * t, right[m][1] + (right[m + 1][1] - right[m][1]) * t];
    }
    ctx.save();
    ctx.fillStyle = this.ink;
    ctx.beginPath();
    const p0 = this._toCss(left[0]);
    ctx.moveTo(p0[0], p0[1]);
    for (let k = 1; k <= m; k++) { const p = this._toCss(left[k]); ctx.lineTo(p[0], p[1]); }
    const lc = this._toCss(lF), rc = this._toCss(rF);
    ctx.lineTo(lc[0], lc[1]);
    ctx.lineTo(rc[0], rc[1]);
    for (let k = m; k >= 0; k--) { const p = this._toCss(right[k]); ctx.lineTo(p[0], p[1]); }
    ctx.closePath();
    ctx.fill();
    // the nib's round front
    const cx = (lc[0] + rc[0]) / 2, cy = (lc[1] + rc[1]) / 2;
    const rad = Math.hypot(lc[0] - rc[0], lc[1] - rc[1]) / 2;
    if (rad > 0.3) {
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _toCss(p) {
    const L = this.layout;
    return [L.originX + p[0] * L.s, L.baselineY - p[1] * L.s];
  }

  _drawPen(at, lifted) {
    const { ctx, layout } = this;
    const emCss = this._upem() * layout.s;
    const r = Math.min(12, Math.max(5, emCss * 0.03));
    ctx.save();
    ctx.globalAlpha = lifted ? 0.55 : 1;
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = r * 0.6;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(at[0], at[1], r, 0, Math.PI * 2);
    ctx.fillStyle = '#e0562d';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = Math.max(1.5, r * 0.28);
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */

/** A glyph's reveal layer: raster-sized, ink-coloured, alpha written per frame. */
function makeLayer(map, ink) {
  if (!map) return null;
  const canvas = document.createElement('canvas');
  canvas.width = map.w;
  canvas.height = map.h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(map.w, map.h);
  const d = img.data;
  const rgb = parseInt(ink.slice(1), 16);
  const R = (rgb >> 16) & 255, G = (rgb >> 8) & 255, B = rgb & 255;
  for (let i = 0; i < d.length; i += 4) { d[i] = R; d[i + 1] = G; d[i + 2] = B; }
  return { canvas, ctx, img, key: '' };
}

/**
 * Every stroke of every chain as a vector band: per glyph, the runs of
 * samples that lie on one of the glyph's own strokes, with the left and
 * right edges the reveal map measured (word coordinates, font units). A
 * bridge is not a band - the join ribbons below paint those - and a run that
 * leaves a glyph ends where it leaves.
 *
 * Why bands on top of the raster map at all: the map is one cell per raster
 * pixel, and on a free edge the outline clips it to a vector edge, but
 * inside a junction there is no outline to clip against, so the step
 * between one stroke's claim and the next was a pixel edge however exactly
 * the widths were chosen. The band draws that same edge as a line.
 */
function buildBands(maps, chains, glyphs) {
  const out = glyphs.map(() => []);
  out.bridges = [];
  maps.sampled.forEach((sc, ci) => {
    const items = chains[ci].items;
    const glyphOf = (k) => { const it = items[sc.item[k]]; return it.type === 'stroke' ? it.glyphIndex : -1; };
    // a stroke's band lives in its glyph (and is clipped by its outline),
    // with the measured cross-section a raster pixel wider on a free side;
    // a bridge's is drawn as it is, so it carries no slack past the ink
    const edges = (k, hl, hr) => {
      const [x, y] = sc.pts[k];
      const nx = -sc.tan[2 * k + 1], ny = sc.tan[2 * k]; // the left normal
      return { l: [x + nx * hl, y + ny * hl], r: [x - nx * hr, y - ny * hr] };
    };
    const halves = (k, gi) => {
      const slack = gi < 0 ? 0 : NIB_SLACK_PX / glyphs[gi].raster.scale;
      return [sc.halfL[k] + (sc.facing[2 * k] ? 0 : slack), sc.halfR[k] + (sc.facing[2 * k + 1] ? 0 : slack)];
    };
    let run = null;
    const close = () => {
      if (run && run.s.length >= 2) (run.glyph < 0 ? out.bridges : out[run.glyph]).push(run);
      run = null;
    };
    const push = (k, hl, hr) => { const e = edges(k, hl, hr); run.s.push(sc.s[k]); run.left.push(e.l); run.right.push(e.r); };
    for (let k = 0; k < sc.n; k++) {
      const gi = glyphOf(k);
      if (gi >= 0 && !glyphs[gi]?.raster) { close(); continue; }
      if (run && run.glyph === gi) { push(k, ...halves(k, gi)); continue; }
      close();
      run = { chain: ci, glyph: gi, s: [], left: [], right: [] };
      if (gi >= 0) { push(k, ...halves(k, gi)); continue; }
      // A bridge: one polygon from the last sample of the letter it leaves to
      // the first sample of the letter it reaches, sharing those two
      // cross-sections with the letters' own bands so the three abut without
      // a gap, and its width running linearly from the one to the other (a
      // sample off the ink has no cross-section of its own to measure).
      let e = k;
      while (e + 1 < sc.n && glyphOf(e + 1) < 0) e++;
      const a0 = k > 0 ? k - 1 : k, b0 = e + 1 < sc.n ? e + 1 : e;
      const [l0, r0] = k > 0 ? halves(a0, glyphOf(a0)) : halves(k, -1);
      const [l1, r1] = e + 1 < sc.n ? halves(b0, glyphOf(b0)) : halves(e, -1);
      const s0 = sc.s[a0], s1 = sc.s[b0];
      for (let j = a0; j <= b0; j++) {
        const t = s1 > s0 ? (sc.s[j] - s0) / (s1 - s0) : 0;
        push(j, l0 + (l1 - l0) * t, r0 + (r1 - r0) * t);
      }
      close();
      k = e;
    }
    close();
  });
  return out;
}

/**
 * The joins of the timeline as paintable ribbons. A ribbon follows the chain
 * itself from BLEND_EM before a bridge to BLEND_EM after it - the letter's
 * own centreline on both sides, the bridge between - and carries the ink's
 * real cross-section: at every sample the left and right edges are found by
 * walking the normal through the letter's raster until the ink ends (held
 * to a running median, so a crossing cannot fling an edge out). Across the
 * bridge, which has no ink of its own, the edges interpolate between the two
 * sides. Inside a letter the ribbon therefore *is* the outline, and the
 * seams do not exist.
 */
function buildRibbons(timeline, analysis, upem) {
  const out = [];
  const blend = BLEND_EM * upem;
  const step = Math.max(1, upem * 0.004);
  const inkAt = (r, x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < r.width && yi < r.height && r.fill[yi * r.width + xi] === 1;
  };
  // distance (font units) from p along unit direction d to the ink's edge in glyph gi
  const reach = (gi, p, d) => {
    const g = analysis.glyphs[gi];
    const r = g?.raster;
    if (!r) return 0;
    const [x0, y0] = fontToRaster(r, p[0] - g.x, p[1] - g.y);
    // one font unit along d, in raster px (raster y points down)
    const dx = d[0] * r.scale, dy = -d[1] * r.scale;
    if (!inkAt(r, x0, y0)) return 0;
    const max = 0.25 * upem;
    const step = 0.5 / r.scale; // half a raster pixel, in font units
    let t = 0;
    while (t < max && inkAt(r, x0 + dx * (t + step), y0 + dy * (t + step))) t += step;
    return t;
  };
  timeline.chains.forEach((chain, ci) => {
    for (const item of chain.items) {
      const b = item.ref;
      if (b.type !== 'bridge') continue;
      const s0 = Math.max(0, item.s0 - blend);
      const s1 = Math.min(chain.L, item.s1 + blend);
      if (s1 - s0 <= 0) continue;
      const n = Math.max(3, Math.ceil((s1 - s0) / step) + 1);
      const pts = new Array(n), nrm = new Array(n), sAt = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        sAt[k] = s0 + ((s1 - s0) * k) / (n - 1);
        pts[k] = pointAtLength(chain.poly, chain.cum, sAt[k]);
      }
      for (let k = 0; k < n; k++) {
        const a = pts[Math.max(0, k - 1)], c = pts[Math.min(n - 1, k + 1)];
        const dx = c[0] - a[0], dy = c[1] - a[1];
        const l = Math.hypot(dx, dy) || 1;
        nrm[k] = [-dy / l, dx / l];
      }
      // which side of the join each sample is on. The exit side is measured
      // right up to the cut (the letter's stroke simply continues there);
      // on the entry side the first half-width is left out, since a blunt
      // entry end would pinch the ribbon.
      const gFrom = b.from.glyphIndex, gTo = b.to.glyphIndex;
      const margin = 0.5 * Math.max(b.widthTo ?? 0, 10);
      const eL = new Float64Array(n), eR = new Float64Array(n);
      const measured = new Uint8Array(n);
      // around the entry point (a half-width either side) the next letter's
      // ink is measured too, but only as a floor: a blunt end's corners must
      // be inside the ribbon, not beside it
      const inMargin = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        let gi = -1;
        if (sAt[k] <= item.s0) gi = gFrom;
        else if (sAt[k] >= item.s1 - margin) { gi = gTo; if (sAt[k] < item.s1 + margin) inMargin[k] = 1; }
        if (gi < 0) continue;
        const l = reach(gi, pts[k], nrm[k]);
        const rr = reach(gi, pts[k], [-nrm[k][0], -nrm[k][1]]);
        if (l + rr <= 0) continue;
        eL[k] = l; eR[k] = rr;
        if (!inMargin[k]) measured[k] = 1;
      }
      // hold each side close to its median: a crossing inside the blend
      // must not fling an edge out (a ribbon narrower than the ink is
      // harmless there, the ink itself is visible; wider would show)
      const floors = [new Float64Array(n), new Float64Array(n)];
      [eL, eR].forEach((e, side) => {
        const vals = [];
        for (let k = 0; k < n; k++) if (measured[k]) vals.push(e[k]);
        if (!vals.length) return;
        vals.sort((p, q) => p - q);
        const cap = vals[vals.length >> 1] + 1;
        for (let k = 0; k < n; k++) {
          if (e[k] > cap) e[k] = cap;
          if (inMargin[k]) { floors[side][k] = e[k]; e[k] = 0; }
        }
      });
      // The unmeasured stretch (the bridge and the entry margin) blends from
      // the exit's edges to the entry's with a smoothstep that arrives at the
      // entry point itself - so the ribbon reaches the next letter at that
      // letter's full width and covers a blunt end face, corners and all.
      for (const e of [eL, eR]) {
        let last = -1;
        for (let k = 0; k < n; k++) {
          if (!measured[k]) continue;
          if (last < k - 1) {
            const a = last >= 0 ? e[last] : e[k];
            for (let j = last + 1; j < k; j++) {
              const t = clamp01((sAt[j] - item.s0) / Math.max(1e-6, item.s1 - item.s0));
              e[j] = a + (e[k] - a) * (t * t * (3 - 2 * t));
            }
          }
          last = k;
        }
        if (last < 0) { const fb = ((b.widthFrom ?? b.width ?? 4) / 2); e.fill(fb); }
        else for (let k = last + 1; k < n; k++) e[k] = e[last];
      }
      // in the entry margin the ribbon is never narrower than the ink it
      // meets, so a blunt end's corner is inside it rather than beside it
      [eL, eR].forEach((e, side) => {
        for (let k = 0; k < n; k++) if (inMargin[k] && floors[side][k] > e[k]) e[k] = floors[side][k];
      });
      // a calm edge: moving average over 5 samples (~0.02 em)
      const smooth = (e) => {
        const o = new Float64Array(n);
        for (let k = 0; k < n; k++) {
          let sum = 0, c = 0;
          for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) { sum += e[j]; c++; }
          o[k] = Math.max(1, sum / c);
        }
        return o;
      };
      const L_ = smooth(eL), R_ = smooth(eR);
      const left = new Array(n), right = new Array(n);
      for (let k = 0; k < n; k++) {
        left[k] = [pts[k][0] + nrm[k][0] * L_[k], pts[k][1] + nrm[k][1] * L_[k]];
        right[k] = [pts[k][0] - nrm[k][0] * R_[k], pts[k][1] - nrm[k][1] * R_[k]];
      }
      const cum = cumulativeLengths(pts);
      out.push({ chain: ci, s0, pts, cum, L: cum[cum.length - 1], left, right });
    }
  });
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Write the per-pixel alpha for the chains' current progress. */
function revealLayer(layer, map, prog, done, featherUnits, bandLagUnits) {
  const { chain, s, domain, cover, chain2, s2, prov } = map;
  const d = layer.img.data;
  for (let q = 0; q < domain.length; q++) {
    const i = domain[q];
    const ci = chain[i];
    let a;
    if (ci === HIDDEN) {
      a = 0;
    } else if (ci < 0) {
      a = done ? 255 : 0;
    } else {
      const p = prog[ci];
      // a pixel a stroke's band claimed is drawn by the vector band while
      // the pen is near it; the raster fills in behind, once the pen has
      // moved on, so whatever sliver the two disagree on never shows as a
      // pixel step at the junction the band just drew
      const lag = prov[i] === 1 ? bandLagUnits : 0;
      if (p === Infinity) a = 255;
      else if (p === -Infinity) a = 0;
      else {
        const f = (p - lag - s[i]) / featherUnits + 1;
        a = f <= 0 ? 0 : f >= 1 ? 255 : (f * 255) | 0;
      }
      // a pixel on the edge of its owner's band, with another pass's ink
      // beyond it: shown by the fraction the band covers until that pass
      // completes it (the junction's edge lands between the pixels)
      if (a > cover[i] && chain2[i] >= 0 && !done) {
        const p2 = prog[chain2[i]];
        if (p2 !== Infinity && (p2 === -Infinity || p2 < s2[i])) a = cover[i];
      }
    }
    d[i * 4 + 3] = a;
  }
  layer.ctx.putImageData(layer.img, 0, 0);
}
