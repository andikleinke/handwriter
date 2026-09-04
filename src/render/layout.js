/**
 * Mapping from word space (font units, y-up, origin at the run start on the
 * baseline) to canvas pixels.
 *
 *   canvasX = originX + fx * s
 *   canvasY = baselineY - fy * s
 */

export function setupHiDPI(canvas, cssWidth, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * Fit the word into the canvas, then apply the shared view: zoom about the
 * canvas centre plus a pan in CSS px. Both canvases use the same view, so
 * the debug view and the animation stay aligned at any zoom.
 */
export function computeLayout(bounds, cssWidth, cssHeight, padding = 32, view = null) {
  const w = Math.max(bounds.w, 1);
  const h = Math.max(bounds.h, 1);
  const s = Math.min((cssWidth - 2 * padding) / w, (cssHeight - 2 * padding) / h);
  const drawnW = w * s;
  const drawnH = h * s;
  const originX = (cssWidth - drawnW) / 2 - bounds.x1 * s;
  const baselineY = (cssHeight - drawnH) / 2 + bounds.y2 * s;
  if (view && (view.zoom !== 1 || view.panX || view.panY)) {
    const z = view.zoom, cx = cssWidth / 2, cy = cssHeight / 2;
    return {
      s: s * z,
      originX: cx + (originX - cx) * z + (view.panX || 0),
      baselineY: cy + (baselineY - cy) * z + (view.panY || 0),
      cssWidth,
      cssHeight,
    };
  }
  return { s, originX, baselineY, cssWidth, cssHeight };
}

export function toCanvas(layout, glyph, fx, fy) {
  return [
    layout.originX + (glyph.x + fx) * layout.s,
    layout.baselineY - (glyph.y + fy) * layout.s,
  ];
}

/** Placement of a glyph's raster bitmap on the word canvas. */
export function rasterPlacement(layout, glyph) {
  const r = glyph.raster;
  const k = layout.s / r.scale;
  return {
    dx: layout.originX + (glyph.x + r.bx1 - r.pad / r.scale) * layout.s,
    dy: layout.baselineY - (glyph.y + r.by2 + r.pad / r.scale) * layout.s,
    dw: r.width * k,
    dh: r.height * k,
    k,
  };
}

/** Apply the word-space transform, then draw a glyph's y-down outline path. */
export function withGlyphTransform(ctx, layout, glyph, fn) {
  ctx.save();
  ctx.translate(layout.originX + glyph.x * layout.s, layout.baselineY - glyph.y * layout.s);
  ctx.scale(layout.s, layout.s);
  fn();
  ctx.restore();
}

export const STROKE_COLORS = [
  '#2f6fed', '#e0562d', '#1f9d64', '#b6339c',
  '#c9a013', '#0f9bb5', '#8a52e0', '#d1365f',
  '#5c7a2b', '#8b5a2b',
];

export function strokeColor(i) {
  return STROKE_COLORS[i % STROKE_COLORS.length];
}
