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
import { buildRevealMaps, HIDDEN, BLEND_EM } from './sweep.js';

// The pen model's native tempo maps to this slider value; the slider scales it.
const PEN_NOMINAL_SPEED = 2.2;

// Soft leading edge of the reveal, in raster px: enough to anti-alias the
// front, never enough to show ink ahead of the nib.
const FRONT_FEATHER_PX = 1.5;

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
    this.pen = null;                        // a written word from the pen model, instead of an analysis
  }

  get duration() {
    return this.timeline?.total ?? 0;
  }

  /** Ink pixels no pen pass reaches; they appear when the run completes. */
  get unreachedInk() {
    return this.pen ? 0 : this.maps?.unassigned ?? 0;
  }

  /** Show a word written by the pen model (see pen/compose.js). */
  loadPen(result) {
    this.stop();
    this.analysis = null;
    this.maps = null;
    this.layers = [];
    this.chains = [];
    this._paths = [];
    this._ribbons = [];
    this.pen = result;
    // the ink each chain lays down: a ribbon at the nib's width
    for (const c of this.pen.chains) {
      const n = c.pts.length;
      c.left = new Array(n);
      c.right = new Array(n);
      for (let k = 0; k < n; k++) {
        const a = c.pts[Math.max(0, k - 1)], b = c.pts[Math.min(n - 1, k + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l, ny = dx / l;
        const hw = c.widths[k] / 2;
        c.left[k] = [c.pts[k][0] + nx * hw, c.pts[k][1] + ny * hw];
        c.right[k] = [c.pts[k][0] - nx * hw, c.pts[k][1] - ny * hw];
      }
      c.cum = cumulativeLengths(c.pts);
    }
    this.rebuildTimeline(false);
    this.resize();
  }

  /** Build the reveal maps and the timeline. Call after analysis / replan. */
  load(analysis) {
    this.stop();
    this.pen = null;
    this.analysis = analysis;
    this.chains = planChains(analysis.plan);
    this.maps = buildRevealMaps(analysis, this.chains, this._upem());
    this._paths = analysis.glyphs.map((g) => (g.path ? new Path2D(g.path) : null));
    this.layers = analysis.glyphs.map((g, gi) => makeLayer(this.maps.glyphs[gi], this.ink));
    this.rebuildTimeline(false);
    this.resize();
  }

  rebuildTimeline(keepPosition) {
    if (this.pen) {
      // the model has its own clock; the speed slider scales it
      const frac = keepPosition && this.timeline ? this.time / this.timeline.total : 0;
      const k = PEN_NOMINAL_SPEED / this.speed;
      const chains = this.pen.chains.map((c) => ({
        id: c.id, t0: c.t0 * k, t1: c.t1 * k, L: c.L, poly: c.pts, cum: c.cum,
        items: [], sTab: c.cum, tTab: c.times.map((t) => t * k), pen: c,
      }));
      const lifts = this.pen.lifts.map((l) => ({ ...l, t0: l.t0 * k, t1: l.t1 * k }));
      this.timeline = { chains, lifts, total: this.pen.total * k, unitsPerEm: this.pen.unitsPerEm };
      this.time = frac * this.timeline.total;
      return;
    }
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
    if (!this.analysis && !this.pen) return;
    const cssW = this.canvas.clientWidth || 900;
    const cssH = this.canvas.clientHeight || 320;
    this.ctx = setupHiDPI(this.canvas, cssW, cssH);
    const bounds = this.pen ? this.pen.bounds : this.analysis.bounds;
    this.layout = computeLayout(bounds, cssW, Math.max(80, cssH - this.bottomInset), 40);
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

  _upem() {
    if (this.pen) return this.pen.unitsPerEm;
    return this.analysis?.glyphs.find((g) => g.record)?.record.unitsPerEm || 1000;
  }

  /** @param {number} T seconds into the timeline */
  drawAt(T) {
    const { ctx, analysis, layout, timeline } = this;
    if (!ctx || !timeline || (!analysis && !this.pen)) return;
    const cssW = layout.cssWidth, cssH = layout.cssHeight;
    ctx.clearRect(0, 0, cssW, cssH);
    if (this.pen) {
      // the word is the ink the nib lays down along the model's trajectory
      for (const chain of timeline.chains) {
        const revealed = T < chain.t0 ? 0 : T >= chain.t1 ? chain.L : arcAt(chain, T);
        if (revealed > 0) this._paintRibbon({ pts: chain.pen.pts, cum: chain.cum, left: chain.pen.left, right: chain.pen.right }, revealed);
      }
      if (this.showPen && T < timeline.total) {
        const st = penState(timeline, T);
        if (st) this._drawPen(this._toCss(st.at), st.kind === 'up');
      }
      return;
    }
    const dpr = this.canvas.width / cssW;

    // how far along each chain the nib is, in font units
    const prog = timeline.chains.map((c) => (T < c.t0 ? -Infinity : T >= c.t1 ? Infinity : arcAt(c, T)));
    const done = T >= timeline.total;

    analysis.glyphs.forEach((g, gi) => {
      const layer = this.layers[gi];
      const map = this.maps.glyphs[gi];
      if (!layer || !map) return;
      const key = map.chainsUsed.map((ci) => prog[ci]).join(',') + (done ? '|end' : '');
      if (layer.key !== key) {
        revealLayer(layer, map, prog, done, FRONT_FEATHER_PX / g.raster.scale);
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
      ctx.restore();
    });

    for (const rb of this._ribbons) {
      const p = prog[rb.chain];
      const revealed = p === Infinity ? rb.L : p === -Infinity ? 0 : Math.min(rb.L, p - rb.s0);
      if (revealed > 0) this._paintRibbon(rb, revealed);
    }

    if (this.showPen && T < timeline.total) {
      const st = penState(timeline, T);
      if (st) this._drawPen(this._toCss(st.at), st.kind === 'up');
    }
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
function revealLayer(layer, map, prog, done, featherUnits) {
  const { chain, s, domain } = map;
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
      if (p === Infinity) a = 255;
      else if (p === -Infinity) a = 0;
      else {
        const f = (p - s[i]) / featherUnits + 1;
        a = f <= 0 ? 0 : f >= 1 ? 255 : (f * 255) | 0;
      }
    }
    d[i * 4 + 3] = a;
  }
  layer.ctx.putImageData(layer.img, 0, 0);
}
