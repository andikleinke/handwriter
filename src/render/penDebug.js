/**
 * Debug view for the pen model: the generated trajectory per chain, the
 * virtual targets it was aimed at, the baseline and the x-height.
 */

import { setupHiDPI, computeLayout, strokeColor } from './layout.js';

export function renderPenDebug(canvas, result, view = null) {
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 360;
  const ctx = setupHiDPI(canvas, cssW, cssH);
  const L = computeLayout(result.bounds, cssW, cssH, 32, view);
  const X = (x) => L.originX + x * L.s;
  const Y = (y) => L.baselineY - y * L.s;
  ctx.clearRect(0, 0, cssW, cssH);

  // guide lines: baseline and x-height
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = 'rgba(0,0,0,.18)';
  ctx.lineWidth = 1;
  for (const y of [0, result.xHeight]) {
    ctx.beginPath();
    ctx.moveTo(0, Y(y));
    ctx.lineTo(cssW, Y(y));
    ctx.stroke();
  }
  ctx.restore();

  result.chains.forEach((c, i) => {
    const col = strokeColor(i);
    // the trajectory
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    c.pts.forEach((p, k) => (k ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
    ctx.stroke();
    // arrowheads every so often
    const step = Math.max(2, Math.floor(c.pts.length / 8));
    for (let k = step; k < c.pts.length - 2; k += step) {
      const a = c.pts[k - 2], b = c.pts[k + 2];
      const ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
      const px = X(c.pts[k][0]), py = Y(c.pts[k][1]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - 7 * Math.cos(ang - 0.45), py - 7 * Math.sin(ang - 0.45));
      ctx.lineTo(px - 7 * Math.cos(ang + 0.45), py - 7 * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
    }
    // the targets
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 1.5;
    for (const t of c.targets) {
      ctx.beginPath();
      ctx.arc(X(t[0]), Y(t[1]), 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // the chain number where it starts
    const s0 = c.pts[0];
    ctx.beginPath();
    ctx.arc(X(s0[0]), Y(s0[1]), 9, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), X(s0[0]), Y(s0[1]) + 0.5);
    ctx.restore();
  });
  return L;
}
