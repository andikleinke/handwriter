/**
 * Glyph rasterisation.
 *
 * Produces a high-resolution binary bitmap of a single glyph plus the affine
 * mapping between raster pixels and font units, so everything downstream can
 * move freely between the two spaces.
 *
 * Font units are y-up with the origin on the baseline at the glyph's left
 * side bearing point (i.e. opentype.js glyph space).
 * Raster pixels are y-down with (0, 0) at the top-left of the padded bitmap.
 */

const PAD = 6;

/**
 * A scratch canvas: the page's kind, or an OffscreenCanvas where there is
 * no document (the alphabet check's worker). Both give a 2D context that
 * fills Path2D paths and reads pixels back.
 */
export function makeCanvas(width, height) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  return new OffscreenCanvas(width, height);
}
const HAIRLINE_PX = 1.1;
const ALPHA_THRESHOLD = 100;

/**
 * @param {string} pathData  SVG path data in font units, already y-flipped by
 *                           opentype's getPath (i.e. pathY === -fontY).
 * @param {{x1:number,y1:number,x2:number,y2:number}} bbox glyph bbox, font units, y-up
 * @param {{unitsPerEm:number, rasterEm?:number, maxSide?:number}} opts
 */
export function rasterizeGlyph(pathData, bbox, opts) {
  const { unitsPerEm, rasterEm = 512, maxSide = 1600 } = opts;

  const bw = Math.max(1, bbox.x2 - bbox.x1);
  const bh = Math.max(1, bbox.y2 - bbox.y1);

  // Nominal scale, reduced if the glyph (e.g. a swash) would blow past maxSide.
  let scale = rasterEm / unitsPerEm;
  const cap = (maxSide - 2 * PAD) / Math.max(bw, bh);
  if (cap < scale) scale = cap;

  const width = Math.ceil(bw * scale) + 2 * PAD;
  const height = Math.ceil(bh * scale) + 2 * PAD;

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // font -> raster:  px = (fx - bbox.x1) * scale + PAD
  //                  py = (bbox.y2 - fy) * scale + PAD
  // The incoming path is already y-flipped, so pathY = -fy and the same
  // mapping is just translate(-x1, +y2) with a uniform positive scale.
  ctx.save();
  ctx.translate(PAD, PAD);
  ctx.scale(scale, scale);
  ctx.translate(-bbox.x1, bbox.y2);
  ctx.fillStyle = '#000';
  const p2d = new Path2D(pathData);
  ctx.fill(p2d, 'nonzero');

  // Cursive fonts join letters with hairlines that dip below one pixel.
  // Filling alone leaves those as a chain of anti-aliased islands, which the
  // skeleton would read as a row of stray dots. Tracing the contour with a
  // one-pixel pen guarantees every part of the shape is connected ink; it
  // fattens the glyph by half a pixel, which does not move the centreline.
  ctx.strokeStyle = '#000';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = HAIRLINE_PX / scale;
  ctx.stroke(p2d);
  ctx.restore();

  const img = ctx.getImageData(0, 0, width, height).data;
  const fill = new Uint8Array(width * height);
  let fillCount = 0;
  for (let i = 0, p = 3; i < fill.length; i++, p += 4) {
    if (img[p] >= ALPHA_THRESHOLD) { fill[i] = 1; fillCount++; }
  }

  return {
    canvas,
    path2d: p2d,
    width,
    height,
    pad: PAD,
    scale,
    bx1: bbox.x1,
    by2: bbox.y2,
    fill,
    fillCount,
  };
}

/** font units -> raster pixels (floating point) */
export function fontToRaster(r, fx, fy) {
  return [(fx - r.bx1) * r.scale + r.pad, (r.by2 - fy) * r.scale + r.pad];
}

/** raster pixels -> font units */
export function rasterToFont(r, px, py) {
  return [(px - r.pad) / r.scale + r.bx1, r.by2 - (py - r.pad) / r.scale];
}

export function mapPolylineToFont(r, pts) {
  return pts.map(([px, py]) => rasterToFont(r, px, py));
}

export function mapPolylineToRaster(r, pts) {
  return pts.map(([fx, fy]) => fontToRaster(r, fx, fy));
}
