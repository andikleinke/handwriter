/**
 * Inspection helpers for the reveal engine, loaded into the running page from
 * the browser console (or an automation script):
 *
 *   const I = await import('/scripts/inspect.js');
 *   await I.setup('autography');          // a bundled font
 *   await I.setText('J');
 *   I.metrics();                           // late ink, pop-in, unassigned
 *   await I.atArc([700, 1010], [0.55, 0.05, 0.8, 0.3]);   // frames at arc lengths, cropped
 *   I.mapZoom(240, 0, 340, 80, 6);         // the reveal map, hue = arc, dots = samples
 *   I.rowsAt(1500, 240, 330, 262, 296);    // the rendered frame as text, in raster pixels
 *
 * Everything reads window.__animator / window.__analysis, which main.js
 * exposes. Nothing here runs in the app itself.
 */

import { arcAt } from '../src/lib/timing.js';
import { computeLayout, rasterPlacement } from '../src/render/layout.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = () => window.__animator;
const G = () => window.__analysis.glyphs;

export async function setup(font = 'pinyon') {
  const pick = document.getElementById('fontpick');
  if (pick.value !== font) { pick.value = font; pick.dispatchEvent(new Event('change')); await sleep(6000); }
  return { font: pick.value, info: document.getElementById('fontinfo')?.textContent?.slice(0, 60) };
}

export async function setText(t) {
  document.getElementById('text').value = t;
  document.getElementById('analyze').click();
  await sleep(3500);
  A().pause();
}

/** Seconds into the timeline at which chain `ci` has travelled `arc` font units. */
export function timeAtArc(arc, ci = 0) {
  const chain = A().timeline.chains[ci];
  if (arc === 'end') return A().timeline.total;
  let lo = chain.t0, hi = chain.t1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (arcAt(chain, mid) < arc) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Render the word at the given times (or arcs of chain 0) offscreen, like a movie frame. */
function renderAt(times, width) {
  const a = A();
  a.pause();
  const bounds = a.analysis.bounds;
  const W = width - (width % 2), pad = Math.round(W * 0.06);
  let H = Math.round((W - 2 * pad) * (Math.max(bounds.h, 1) / Math.max(bounds.w, 1)) + 2 * pad);
  H += H % 2;
  const saved = { canvas: a.canvas, ctx: a.ctx, layout: a.layout, time: a.time, showPen: a.showPen };
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  a.canvas = canvas; a.ctx = canvas.getContext('2d'); a.showPen = false;
  a.layout = computeLayout(bounds, W, H, pad);
  for (const layer of a.layers) if (layer) layer.key = null;
  const frames = [];
  try {
    for (const T of times) {
      a.drawAt(T);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.getContext('2d').drawImage(canvas, 0, 0);
      frames.push(c);
    }
  } finally {
    Object.assign(a, saved);
    for (const layer of a.layers) if (layer) layer.key = null;
    a.drawAt(a.time);
  }
  return { frames, W, H, layout: computeLayout(bounds, W, H, pad) };
}

function show(canvas) {
  document.getElementById('mapdbg')?.remove();
  canvas.id = 'mapdbg';
  canvas.style.cssText = 'width:100%;max-width:980px;display:block;background:#fff';
  document.querySelector('.topbar').appendChild(canvas);
  window.scrollTo(0, 0);
}

/** Frames at arcs of chain 0, cropped to `box` (fractions of the frame), side by side at the top of the page. */
export async function atArc(arcs, box, width = 2400, ci = 0) {
  const times = arcs.map((arc) => timeAtArc(arc, ci));
  const { frames, W, H } = renderAt(times, width);
  const sx = box[0] * W, sy = box[1] * H, sw = (box[2] - box[0]) * W, sh = (box[3] - box[1]) * H;
  const ow = Math.round(960 / frames.length), oh = Math.round(ow * sh / sw);
  const out = document.createElement('canvas');
  out.width = ow * frames.length; out.height = oh;
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = false;
  frames.forEach((c, i) => {
    o.fillStyle = '#f3efe6'; o.fillRect(i * ow, 0, ow, oh);
    o.drawImage(c, sx, sy, sw, sh, i * ow, 0, ow, oh);
    o.strokeStyle = '#999'; o.strokeRect(i * ow + 0.5, 0.5, ow - 1, oh - 1);
  });
  show(out);
  return { times: times.map((t) => +t.toFixed(3)), W, H };
}

/** Whole frames at fractions of the timeline's total time, side by side. */
export async function atTime(fracs, box = [0, 0, 1, 1], width = 1600) {
  const total = A().timeline.total;
  const { frames, W, H } = renderAt(fracs.map((f) => f * total), width);
  const sx = box[0] * W, sy = box[1] * H, sw = (box[2] - box[0]) * W, sh = (box[3] - box[1]) * H;
  const ow = Math.round(960 / frames.length), oh = Math.round(ow * sh / sw);
  const out = document.createElement('canvas');
  out.width = ow * frames.length; out.height = oh;
  const o = out.getContext('2d');
  frames.forEach((c, i) => {
    o.fillStyle = '#f3efe6'; o.fillRect(i * ow, 0, ow, oh);
    o.drawImage(c, sx, sy, sw, sh, i * ow, 0, ow, oh);
    o.strokeStyle = '#999'; o.strokeRect(i * ow + 0.5, 0.5, ow - 1, oh - 1);
  });
  show(out);
  return { total };
}

/**
 * The stroke renderer's finished silhouette against the font's outline, as
 * alpha masks at `width` px: XOR, missing and extra as fractions of the
 * outline's ink. Also checks that the last animated frame equals the finished
 * frame (no geometry change at completion) for the renderer given.
 */
export function silhouette(width = 1920, renderer = 'stroke') {
  const a = A();
  const saved = a.renderer;
  const mask = (mode, T) => {
    a.renderer = mode;
    const { frames, W, H } = renderAt([T], width);
    const d = frames[0].getContext('2d').getImageData(0, 0, W, H).data;
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    return { m, W, H };
  };
  const total = a.timeline.total;
  const target = mask('outline', total);           // the font's outline, complete
  const got = mask(renderer, total);               // the renderer, finished
  const last = mask(renderer, total - 1e-4);       // the last animated frame
  a.renderer = saved; a.drawAt(a.time);
  let ink = 0, xor = 0, missing = 0, extra = 0, swap = 0;
  for (let i = 0; i < target.m.length; i++) {
    if (target.m[i]) ink++;
    if (target.m[i] !== got.m[i]) { xor++; if (target.m[i]) missing++; else extra++; }
    if (got.m[i] !== last.m[i]) swap++;
  }
  return { ink, xor: +(xor / ink).toFixed(4), missing: +(missing / ink).toFixed(4), extra: +(extra / ink).toFixed(4), completionChange: swap };
}

/**
 * Continuity of a run of `steps` frames for the given renderer: ink that
 * appears in a frame must touch ink that was already there (within `reach`
 * px) unless a chain starts in that step, and ink must never vanish. Returns
 * the counts of detached new pixels and vanished pixels, with the worst
 * frames, so a clean run reads detached 0, vanished ~0.
 */
export function continuity(steps = 40, width = 960, renderer = A().renderer, reach = 3) {
  const a = A();
  const saved = a.renderer; a.renderer = renderer;
  const total = a.timeline.total;
  const times = []; for (let i = 0; i <= steps; i++) times.push((i / steps) * total);
  const { frames, W, H } = renderAt(times, width);
  a.renderer = saved; a.drawAt(a.time);
  const masks = frames.map((c) => { const d = c.getContext('2d').getImageData(0, 0, W, H).data; const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0; return m; });
  const starts = (f) => a.timeline.chains.some((c) => c.t0 > times[f - 1] && c.t0 <= times[f]);
  let detached = 0, vanished = 0; const worst = [];
  for (let f = 1; f < masks.length; f++) {
    const prev = masks[f - 1], cur = masks[f];
    let n = 0, v = 0;
    for (let i = 0; i < W * H; i++) {
      if (prev[i] && !cur[i]) v++;
      if (!cur[i] || prev[i]) continue;
      // new ink: does anything within `reach` belong to the previous frame
      // or to new ink that does (flood through the new ink from old ink)?
      n++;
    }
    // connected-component test: new pixels reachable from old ink
    if (n) {
      const seen = new Uint8Array(W * H); const q = [];
      for (let i = 0; i < W * H; i++) if (!cur[i] || prev[i]) continue; else {
        // seed: new pixels adjacent (within reach) to old ink
        const px = i % W, py = (i - px) / W; let near = false;
        for (let dy = -reach; dy <= reach && !near; dy++) for (let dx = -reach; dx <= reach; dx++) { const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue; if (prev[y * W + x]) { near = true; break; } }
        if (near) { seen[i] = 1; q.push(i); }
      }
      while (q.length) { const i = q.pop(); const px = i % W, py = (i - px) / W; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue; const j = y * W + x; if (cur[j] && !prev[j] && !seen[j]) { seen[j] = 1; q.push(j); } } }
      let det = 0; for (let i = 0; i < W * H; i++) if (cur[i] && !prev[i] && !seen[i]) det++;
      if (det && !starts(f)) { detached += det; worst.push([f, det]); }
    }
    vanished += v;
  }
  return { steps, detached, vanished, worstFrames: worst.sort((p, q) => q[1] - p[1]).slice(0, 5) };
}

/**
 * Two consecutive frames of a run (of `steps`), shown as: frame f in grey,
 * ink new in frame f over f-1 in red, ink that vanished in blue; the view is
 * cropped to the changes and magnified.
 */
export async function diffFrames(f, steps = 40, width = 960, renderer = A().renderer) {
  const a = A();
  const saved = a.renderer; a.renderer = renderer;
  const total = a.timeline.total;
  const { frames, W, H } = renderAt([((f - 1) / steps) * total, (f / steps) * total], width);
  a.renderer = saved; a.drawAt(a.time);
  const d0 = frames[0].getContext('2d').getImageData(0, 0, W, H).data, d1 = frames[1].getContext('2d').getImageData(0, 0, W, H).data;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const o = out.getContext('2d'); const img = o.createImageData(W, H); const d = img.data;
  let x0 = W, y0 = H, x1 = 0, y1 = 0, added = 0, gone = 0;
  for (let i = 0; i < W * H; i++) {
    const was = d0[i * 4 + 3] > 127, is = d1[i * 4 + 3] > 127;
    let r = 243, g = 239, b = 230;
    if (is && was) { r = g = b = 120; }
    else if (is) { r = 224; g = 30; b = 40; added++; }
    else if (was) { r = 30; g = 80; b = 220; gone++; }
    if (is !== was) { const px = i % W, py = (i - px) / W; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  if (x1 < x0) { show(out); return { added, gone }; }
  const pad = 20; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const Z = Math.max(1, Math.min(4, Math.floor(960 / (x1 - x0 + 1))));
  const crop = document.createElement('canvas'); crop.width = (x1 - x0 + 1) * Z; crop.height = (y1 - y0 + 1) * Z;
  const c = crop.getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(out, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, crop.width, crop.height);
  show(crop);
  return { added, gone, box: [x0, y0, x1, y1], Z };
}

/** The frame box (fractions) that shows raster pixels x0..x1, y0..y1 of glyph gi at the given render width. */
export function boxOfRaster(x0, y0, x1, y1, width = 2400, gi = 0) {
  const a = A();
  const bounds = a.analysis.bounds;
  const W = width - (width % 2), pad = Math.round(W * 0.06);
  let H = Math.round((W - 2 * pad) * (Math.max(bounds.h, 1) / Math.max(bounds.w, 1)) + 2 * pad);
  H += H % 2;
  const g = G()[gi];
  const place = rasterPlacement(computeLayout(bounds, W, H, pad), g);
  const sx = place.dw / g.raster.width, sy = place.dh / g.raster.height;
  return [(place.dx + x0 * sx) / W, (place.dy + y0 * sy) / H, (place.dx + x1 * sx) / W, (place.dy + y1 * sy) / H];
}

/** The rendered frame at an arc, as text rows in raster pixels: # ink, + partial, . none. */
export function rowsAt(arc, x0, x1, y0, y1, step = 2, gi = 0, ci = 0) {
  const { frames, W, layout } = renderAt([timeAtArc(arc, ci)], 2400);
  const g = G()[gi];
  const place = rasterPlacement(layout, g);
  const img = frames[0].getContext('2d').getImageData(0, 0, frames[0].width, frames[0].height).data;
  const sx = place.dw / g.raster.width, sy = place.dh / g.raster.height;
  const rows = [];
  for (let ry = y0; ry <= y1; ry += step) {
    const py = Math.round(place.dy + (ry + 0.5) * sy);
    let line = `y${ry} `;
    for (let rx = x0; rx < x1; rx++) {
      const px = Math.round(place.dx + (rx + 0.5) * sx);
      const al = img[(py * W + px) * 4 + 3];
      line += al > 200 ? '#' : al > 30 ? '+' : '.';
    }
    rows.push(line);
  }
  return rows;
}

const toPx = (r, p) => [(p[0] - r.bx1) * r.scale + r.pad, (r.by2 - p[1]) * r.scale + r.pad];

/** Paint a region of glyph gi's reveal map: hue = arc, dark = nearest-path, pale = wedge, grey = unassigned; dots = samples (white where flagged as a junction). */
export function mapZoom(x0, y0, x1, y1, Z = 6, gi = 0, upTo = Infinity) {
  const a = A(), g = G()[gi], r = g.raster, m = a.maps.glyphs[gi], fill = r.fill, W = m.w;
  const sampled = a.maps.sampled;
  const total = sampled.reduce((t, sc) => t + sc.s[sc.n - 1], 0);
  const c = document.createElement('canvas');
  c.width = (x1 - x0) * Z; c.height = (y1 - y0) * Z;
  const o = c.getContext('2d');
  o.fillStyle = '#fff'; o.fillRect(0, 0, c.width, c.height);
  const counts = {};
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    if (!fill[i]) continue;
    const ch = m.chain[i];
    let col;
    if (ch === -1) col = '#bbb';
    else if (ch < -1) col = '#000';
    else if (upTo !== Infinity) col = m.s[i] <= upTo ? '#111' : '#ddd';
    else { const f = m.s[i] / total; const p = m.prov[i]; col = `hsl(${Math.round(f * 300)},90%,${p === 4 ? 25 : p === 5 ? 80 : p === 2 ? 45 : 60}%)`; }
    const key = ch === -1 ? 'unassigned' : ch < -1 ? 'hidden' : `p${m.prov[i]}`;
    counts[key] = (counts[key] || 0) + 1;
    o.fillStyle = col; o.fillRect((x - x0) * Z, (y - y0) * Z, Z, Z);
    // late ink (red) and pop-in (blue) from the last metrics() call
    const mk = window.__marks?.[gi]?.[i];
    if (mk) { o.fillStyle = mk === 1 ? '#e0162b' : '#1b4fd8'; o.fillRect((x - x0) * Z + 1, (y - y0) * Z + 1, Z - 2, Z - 2); }
  }
  for (const sc of sampled) for (let k = 0; k < sc.n; k++) {
    const [px, py] = toPx(r, [sc.pts[k][0] - g.x, sc.pts[k][1] - g.y]);
    if (px < x0 || px >= x1 || py < y0 || py >= y1) continue;
    o.fillStyle = sc.junction?.[k] ? '#fff' : '#000';
    o.fillRect((px - x0) * Z + Z / 2 - 1, (py - y0) * Z + Z / 2 - 1, 2, 2);
  }
  show(c);
  return counts;
}

/** mapZoom over the whole of glyph gi. */
export function mapAll(gi = 0, Z = 3) {
  const g = G()[gi], r = g.raster;
  return mapZoom(0, 0, r.width, r.height, Z, gi);
}

/** One chain's samples as text: position (raster px), tangent, half-widths (px), junction flag. */
export function profile(ci, from, to, every = 5, gi = 0) {
  const a = A(), g = G()[gi], r = g.raster, sc = a.maps.sampled[ci];
  const rows = [];
  for (let k = from; k <= Math.min(to, sc.n - 1); k += every) {
    const [x, y] = toPx(r, [sc.pts[k][0] - g.x, sc.pts[k][1] - g.y]);
    const px = (v) => (v * r.scale).toFixed(1);
    rows.push(`${k} s${Math.round(sc.s[k])} x${x.toFixed(1)} y${y.toFixed(1)} t${sc.tan[2 * k].toFixed(2)},${sc.tan[2 * k + 1].toFixed(2)} L${px(sc.halfL[k])}(${px(sc.raw?.[0][k])}${sc.edge?.[2 * k] ? 'e' : ''}${sc.sides?.[0][k] ? 'f' : ''}) R${px(sc.halfR[k])}(${px(sc.raw?.[1][k])}${sc.edge?.[2 * k + 1] ? 'e' : ''}${sc.sides?.[1][k] ? 'f' : ''}) R${px(sc.R[k])} j${sc.junction?.[k] ?? '-'}`);
  }
  return rows;
}

/**
 * How well the reveal follows the pen, over every glyph of the current word:
 *   late     ink pixels under the nib's own radius at some sample (and
 *            within the band it claims there), revealed more than LATE_EM
 *            of arc after that sample (or by a later chain)
 *   popin    pixels revealed more than POP_EM from any sample within
 *            WINDOW_EM of arc of their own reveal arc: ink appearing away
 *            from the pen
 *   unassigned / hidden  as the maps report them
 */
export function metrics({ LATE_EM = 0.15, POP_EM = 0.22, WINDOW_EM = 0.05 } = {}) {
  const a = A();
  const upem = a._upem();
  let late = 0, popin = 0, unassigned = 0, hidden = 0, ink = 0;
  const perGlyph = [];
  G().forEach((g, gi) => {
    const m = a.maps.glyphs[gi];
    if (!m) return;
    const before = { late, popin };
    const r = g.raster, W = m.w, fill = r.fill;
    unassigned += m.unassigned; hidden += m.hidden;
    const seen = new Uint8Array(W * m.h);
    const mark = new Uint8Array(W * m.h); // 1 late, 2 pop-in: for mapZoom
    (window.__marks = window.__marks || [])[gi] = mark;
    a.maps.sampled.forEach((sc, ci) => {
      for (let k = 0; k < sc.n; k++) {
        const [x, y] = toPx(r, [sc.pts[k][0] - g.x, sc.pts[k][1] - g.y]);
        // the nib's radius, but no further than the band the pen claims on
        // that side: a hairline running inside a shade reads a shade-sized
        // radius there, and the shade's ink is the shade's to reveal
        const rad = sc.R[k] * r.scale;
        const tx = sc.tan[2 * k], ty = -sc.tan[2 * k + 1];
        const hl = sc.halfL[k] * r.scale, hr = sc.halfR[k] * r.scale;
        const x0 = Math.max(0, Math.floor(x - rad)), x1 = Math.min(W - 1, Math.ceil(x + rad));
        const y0 = Math.max(0, Math.floor(y - rad)), y1 = Math.min(m.h - 1, Math.ceil(y + rad));
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
          if ((px - x) ** 2 + (py - y) ** 2 > rad * rad) continue;
          const across = (px - x) * -ty + (py - y) * tx;
          if (across > hl + 0.5 || -across > hr + 0.5) continue;
          const i = py * W + px;
          if (!fill[i] || seen[i]) continue;
          seen[i] = 1;
          const ch = m.chain[i];
          if (ch < 0) continue;
          if (ch > ci || (ch === ci && m.s[i] - sc.s[k] > LATE_EM * upem)) { late++; mark[i] = 1; }
        }
      }
    });
    // pop-in: distance from each pixel to the path within WINDOW_EM of its own arc
    const win = WINDOW_EM * upem, far = POP_EM * upem * r.scale;
    for (let i = 0; i < W * m.h; i++) {
      if (!fill[i]) continue;
      ink++;
      const ch = m.chain[i];
      if (ch < 0) continue;
      const sc = a.maps.sampled[ch];
      const px = i % W, py = (i - px) / W;
      // samples are evenly spaced in arc: the window is a contiguous run
      const step = sc.s[1] - sc.s[0];
      const k0 = Math.max(0, Math.floor((m.s[i] - win) / step)), k1 = Math.min(sc.n - 1, Math.ceil((m.s[i] + win) / step));
      let best = Infinity;
      for (let k = k0; k <= k1; k++) {
        const [x, y] = toPx(r, [sc.pts[k][0] - g.x, sc.pts[k][1] - g.y]);
        const d2 = (px - x) ** 2 + (py - y) ** 2;
        if (d2 < best) best = d2;
      }
      if (best > far * far) { popin++; mark[i] = 2; }
    }
    perGlyph.push(`${g.chars ?? g.name ?? gi}:${late - before.late}/${popin - before.popin}`);
  });
  return { late, popin, unassigned, hidden, ink, perGlyph: perGlyph.join(' ') };
}

/** metrics() for each word in turn; the page is left on the last. */
export async function suite(words) {
  const out = {};
  for (const w of words) { await setText(w); out[w] = metrics(); }
  return out;
}

/**
 * Ink of glyph `gi` that no ribbon covers, as blobs: size, bounding box
 * (raster px), distance from the blob's farthest pixel to the nearest chain
 * END (a pen-down or pen-up point) and to the nearest chain sample at all.
 * A blob near an end is a tail the chain stops short of; one far from any
 * end but near a sample is width error; one far from both is untravelled.
 */
export async function missing(gi = 0, minBlob = 8) {
  const { fontToRaster } = await import('/src/lib/raster.js');
  const { piece } = await import('/src/render/strokeRender.js');
  const g = G()[gi], r = g.raster, W = r.width, H = r.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  const toR = (p) => fontToRaster(r, p[0] - g.x, p[1] - g.y);
  const ends = [], samples = [];
  for (const rb of A()._strokes) {
    const L = rb.left.map(toR), R = rb.right.map(toR), C = rb.pts.map(toR);
    ctx.fill(piece(L, R, C, 0, L.length - 1), 'nonzero');
    ends.push({ ci: rb.chain, at: 'start', p: C[0], w: rb.hl[0] + rb.hr[0] }, { ci: rb.chain, at: 'end', p: C[C.length - 1], w: rb.hl[rb.hl.length - 1] + rb.hr[rb.hr.length - 1] });
    for (let k = 0; k < C.length; k += 2) samples.push(C[k]);
  }
  const d = ctx.getImageData(0, 0, W, H).data;
  const fill = r.fill;
  const miss = new Uint8Array(W * H);
  let total = 0, missed = 0;
  for (let i = 0; i < miss.length; i++) { if (fill[i]) { total++; if (d[i * 4 + 3] < 128) { miss[i] = 1; missed++; } } }
  const seen = new Uint8Array(W * H), blobs = [];
  for (let s0 = 0; s0 < miss.length; s0++) {
    if (!miss[s0] || seen[s0]) continue;
    const stack = [s0], blob = []; seen[s0] = 1;
    while (stack.length) {
      const p = stack.pop(); blob.push(p);
      const px = p % W, py = (p / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (miss[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (blob.length < minBlob) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (const p of blob) { const px = p % W, py = (p / W) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    const near = (pts) => { let best = Infinity, who = -1; for (const p of blob) { const px = p % W, py = (p / W) | 0; for (let i = 0; i < pts.length; i++) { const q = pts[i].p || pts[i]; const dd = Math.hypot(q[0] - px, q[1] - py); if (dd < best) { best = dd; who = i; } } } return { d: best, i: who }; };
    const e = near(ends), s = near(samples);
    const far = (() => { let best = -1; for (const p of blob) { const px = p % W, py = (p / W) | 0; const q = ends[e.i].p; const dd = Math.hypot(q[0] - px, q[1] - py); if (dd > best) best = dd; } return best; })();
    blobs.push({ px: blob.length, box: [x0, y0, x1, y1], end: ends[e.i] ? `${ends[e.i].ci}/${ends[e.i].at}` : null, endDist: +e.d.toFixed(1), endReach: +far.toFixed(1), endWidth: +(ends[e.i]?.w * r.scale).toFixed(1), sampleDist: +s.d.toFixed(1) });
  }
  blobs.sort((a, b) => b.px - a.px);
  return { gi, total, missed, pct: +((100 * missed) / total).toFixed(1), blobs: blobs.slice(0, 12) };
}

/** Show glyph `gi`'s raster with the ribbons' union and the missed ink (red) in the page's corner. */
export async function missingImage(gi = 0, Z = 2) {
  const { fontToRaster } = await import('/src/lib/raster.js');
  const { piece } = await import('/src/render/strokeRender.js');
  const g = G()[gi], r = g.raster, W = r.width, H = r.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#000';
  const toR = (p) => fontToRaster(r, p[0] - g.x, p[1] - g.y);
  for (const rb of A()._strokes) ctx.fill(piece(rb.left.map(toR), rb.right.map(toR), rb.pts.map(toR), 0, rb.left.length - 1), 'nonzero');
  const d = ctx.getImageData(0, 0, W, H).data;
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const ink = r.fill[i], rib = d[i * 4 + 3] > 127;
    let col = [245, 242, 236];
    if (ink && rib) col = [60, 60, 60]; else if (ink) col = [220, 40, 40]; else if (rib) col = [40, 120, 220];
    img.data.set([...col, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  let el = document.getElementById('__missing');
  if (!el) { el = document.createElement('canvas'); el.id = '__missing'; el.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#fff'; document.body.appendChild(el); }
  el.width = W * Z; el.height = H * Z; el.style.width = `${W * Z}px`; el.style.height = `${H * Z}px`;
  const e = el.getContext('2d'); e.imageSmoothingEnabled = false; e.drawImage(c, 0, 0, W * Z, H * Z);
  return { W, H, Z };
}
export function hideMissing() { document.getElementById('__missing')?.remove(); }

/** One frame at fraction `frac` of the timeline as a PNG data URL (for saving outside the page). */
export function framePNG(frac = 1, width = 900, renderer = A().renderer, box = null) {
  const a = A();
  const saved = a.renderer; a.renderer = renderer;
  const { frames, W, H } = renderAt([frac * a.timeline.total], width);
  a.renderer = saved; a.drawAt(a.time);
  if (!box) return frames[0].toDataURL('image/png');
  // box = [x0, y0, x1, y1] as fractions of the frame
  const x0 = Math.floor(box[0] * W), y0 = Math.floor(box[1] * H), w = Math.ceil((box[2] - box[0]) * W), h = Math.ceil((box[3] - box[1]) * H);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(frames[0], x0, y0, w, h, 0, 0, w, h);
  return c.toDataURL('image/png');
}

/** The missing-ink overlay of glyph `gi` (see missingImage) as a PNG data URL. */
export async function missingPNG(gi = 0, Z = 2) {
  await missingImage(gi, Z);
  const el = document.getElementById('__missing');
  const url = el.toDataURL('image/png');
  hideMissing();
  return url;
}
