/**
 * Snapping hand-placed points onto the ink's centreline.
 *
 * The skeleton and distance map of a raster are recomputed on demand and
 * cached per raster object, so manual edits get the same centreline the
 * automatic recovery worked from.
 */

import { zhangSuenThin, distanceTransform } from './thinning.js';

const cache = new WeakMap();

export function inkInfo(raster) {
  let info = cache.get(raster);
  if (info) return info;
  const { width: w, height: h, fill } = raster;
  const skel = zhangSuenThin(fill, w, h);
  const dist = distanceTransform(fill, w, h);
  const pts = [];
  for (let i = 0; i < skel.length; i++) if (skel[i]) pts.push([i % w, (i / w) | 0]);
  info = { skel, dist, pts };
  cache.set(raster, info);
  return info;
}

/** Move each raster-space point to the nearest skeleton pixel within maxDist. */
export function snapToInk(raster, rasterPts, maxDist) {
  const { pts } = inkInfo(raster);
  const max2 = maxDist * maxDist;
  return rasterPts.map((p) => {
    let best = null, bestD = max2;
    for (const q of pts) {
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d < bestD) { bestD = d; best = q; }
    }
    return best ? [best[0], best[1]] : p;
  });
}

/** Full ink width (raster px) at a raster-space point, 0 outside the ink. */
export function inkWidthAt(raster, p) {
  const { dist } = inkInfo(raster);
  const x = Math.round(p[0]), y = Math.round(p[1]);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  return dist[y * raster.width + x] * 2;
}
