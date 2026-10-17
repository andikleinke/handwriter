/**
 * Inspection helpers for the reveal engine, loaded into the running page from
 * the browser console (or an automation script):
 *
 *   const I = await import('/scripts/inspect.js');
 *   await I.setup('autography');          // font route, a bundled font
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
  const s = document.getElementById('source');
  if (s.value !== 'font') { s.value = 'font'; s.dispatchEvent(new Event('change')); await sleep(5000); }
  const pick = document.getElementById('fontpick');
  if (pick.value !== font) { pick.value = font; pick.dispatchEvent(new Event('change')); await sleep(6000); }
  return { source: s.value, font: pick.value, info: document.getElementById('fontinfo')?.textContent?.slice(0, 60) };
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
