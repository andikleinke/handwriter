/**
 * SVG export of a word written by the pen model.
 *
 * The ink is exactly what the preview paints: for every pen-down chain a
 * ribbon at the nib's width around the trajectory, filled as one closed path
 * (left side forward, right side back). Units are the pen model's font units
 * scaled to pixels; y is flipped so the baseline sits where the eye expects.
 */

/**
 * @param {object} result   the word from composeWord()
 * @param {object} [opts]
 * @param {number} [opts.pxPerEm=120]   scale of the drawing
 * @param {string} [opts.ink='#16191f']  fill colour of the ink
 * @param {string|null} [opts.paper=null] background colour, null for none
 * @param {boolean} [opts.guides=false]  draw baseline and x-height lines
 * @returns {string} the SVG document
 */
export function penToSvg(result, opts = {}) {
  const pxPerEm = opts.pxPerEm ?? 120;
  const ink = opts.ink ?? '#16191f';
  const paper = opts.paper ?? null;
  const S = pxPerEm / result.unitsPerEm;
  const b = result.bounds;
  const W = Math.ceil(b.w * S), H = Math.ceil(b.h * S);
  const X = (x) => ((x - b.x1) * S).toFixed(2);
  const Y = (y) => ((b.y2 - y) * S).toFixed(2);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" data-hand="${escapeAttr(result.style?.name ?? '')}">`);
  parts.push(`<title>${escapeText(result.text)}</title>`);
  if (paper) parts.push(`<rect width="${W}" height="${H}" fill="${paper}"/>`);
  if (opts.guides) {
    parts.push(`<line x1="0" y1="${Y(0)}" x2="${W}" y2="${Y(0)}" stroke="#c8c8c8" stroke-dasharray="4 4"/>`);
    parts.push(`<line x1="0" y1="${Y(result.xHeight)}" x2="${W}" y2="${Y(result.xHeight)}" stroke="#dedede" stroke-dasharray="4 4"/>`);
  }
  parts.push(`<g fill="${ink}" fill-rule="nonzero">`);
  for (const c of result.chains) {
    const d = ribbonPath(c, X, Y);
    if (d) parts.push(`<path id="chain-${c.id}" d="${d}"/>`);
  }
  parts.push('</g></svg>');
  return parts.join('\n');
}

/** One chain's ink as a closed ribbon path. */
function ribbonPath(c, X, Y) {
  const n = c.pts.length;
  if (n < 2) return '';
  const left = new Array(n), right = new Array(n);
  for (let k = 0; k < n; k++) {
    const a = c.pts[Math.max(0, k - 1)], b = c.pts[Math.min(n - 1, k + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l, hw = c.widths[k] / 2;
    left[k] = [c.pts[k][0] + nx * hw, c.pts[k][1] + ny * hw];
    right[k] = [c.pts[k][0] - nx * hw, c.pts[k][1] - ny * hw];
  }
  let d = `M${X(left[0][0])} ${Y(left[0][1])}`;
  for (let k = 1; k < n; k++) d += `L${X(left[k][0])} ${Y(left[k][1])}`;
  for (let k = n - 1; k >= 0; k--) d += `L${X(right[k][0])} ${Y(right[k][1])}`;
  return d + 'Z';
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}
