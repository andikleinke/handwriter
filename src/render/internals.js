/**
 * Internals strip: for each glyph, the binary raster the pipeline actually saw
 * with its skeleton painted on top. This is the view that tells you whether a
 * bad stroke order is a heuristics problem or a rasterisation problem.
 */

import { zhangSuenThin } from '../lib/thinning.js';

export function renderInternals(container, analysis, { height = 190 } = {}) {
  container.innerHTML = '';
  for (const g of analysis.glyphs) {
    if (!g.raster) continue;
    const { width: w, height: h, fill } = g.raster;
    const skel = zhangSuenThin(fill, w, h);

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0, p = 0; i < fill.length; i++, p += 4) {
      if (skel[i]) { d[p] = 224; d[p + 1] = 56; d[p + 2] = 45; d[p + 3] = 255; }
      else if (fill[i]) { d[p] = 200; d[p + 1] = 205; d[p + 2] = 215; d[p + 3] = 255; }
    }
    ctx.putImageData(img, 0, 0);

    const wrap = document.createElement('figure');
    wrap.className = 'internal';
    c.style.height = `${height}px`;
    c.style.width = `${Math.round((w / h) * height)}px`;
    wrap.appendChild(c);
    const cap = document.createElement('figcaption');
    let skelCount = 0;
    for (let i = 0; i < skel.length; i++) skelCount += skel[i];
    cap.textContent = `${g.chars?.trim() || g.name} · ${w}×${h} · ${skelCount}px skeleton`;
    wrap.appendChild(cap);
    container.appendChild(wrap);
  }
}
