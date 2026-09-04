/**
 * Zhang-Suen thinning and a chamfer distance transform.
 *
 * Both operate on flat Uint8Array bitmaps (1 = ink) of dimensions w x h.
 * The caller guarantees at least a 1px empty border, so neighbour lookups
 * never need bounds checks on the interior loop.
 */

const NB = [
  // P2..P9, clockwise from north, matching the Zhang-Suen paper's numbering
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

function neighbours(img, w, idx, out) {
  for (let k = 0; k < 8; k++) {
    out[k] = img[idx + NB[k][1] * w + NB[k][0]];
  }
  return out;
}

/** Number of 0 -> 1 transitions around the ring P2..P9,P2. */
function crossings(n) {
  let a = 0;
  for (let k = 0; k < 8; k++) {
    if (n[k] === 0 && n[(k + 1) & 7] === 1) a++;
  }
  return a;
}

function popcount(n) {
  let b = 0;
  for (let k = 0; k < 8; k++) b += n[k];
  return b;
}

/**
 * @returns {Uint8Array} a new bitmap holding the 1px-wide skeleton.
 */
export function zhangSuenThin(src, w, h) {
  const img = Uint8Array.from(src);
  const n = new Uint8Array(8);
  const doomed = [];
  let changed = true;
  let guard = 0;

  while (changed && guard++ < 200) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      doomed.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = y * w + x;
          if (!img[idx]) continue;
          neighbours(img, w, idx, n);
          const b = popcount(n);
          if (b < 2 || b > 6) continue;
          if (crossings(n) !== 1) continue;
          // n[0]=P2 n[1]=P3 n[2]=P4 n[3]=P5 n[4]=P6 n[5]=P7 n[6]=P8 n[7]=P9
          if (step === 0) {
            if (n[0] * n[2] * n[4] !== 0) continue; // P2*P4*P6
            if (n[2] * n[4] * n[6] !== 0) continue; // P4*P6*P8
          } else {
            if (n[0] * n[2] * n[6] !== 0) continue; // P2*P4*P8
            if (n[0] * n[4] * n[6] !== 0) continue; // P2*P6*P8
          }
          doomed.push(idx);
        }
      }
      if (doomed.length) {
        changed = true;
        for (const idx of doomed) img[idx] = 0;
      }
    }
  }

  breakSquares(img, w, h);
  return img;
}

/**
 * Zhang-Suen occasionally leaves a 2x2 block, which vectorisation would read
 * as a spurious 4-way junction. Delete one corner where it is safe to do so.
 */
function breakSquares(img, w, h) {
  const n = new Uint8Array(8);
  for (let y = 1; y < h - 2; y++) {
    for (let x = 1; x < w - 2; x++) {
      const i = y * w + x;
      if (!(img[i] && img[i + 1] && img[i + w] && img[i + w + 1])) continue;
      for (const idx of [i + w + 1, i + w, i + 1, i]) {
        neighbours(img, w, idx, n);
        if (crossings(n) === 1 && popcount(n) >= 2) {
          img[idx] = 0;
          break;
        }
      }
    }
  }
}

/**
 * Drop ink blobs smaller than `minArea`. Anti-aliasing along a hairline curve
 * leaves stray one- and two-pixel islands that would otherwise each become a
 * spurious "dot" stroke. Mutates `img` in place; returns the new ink count.
 */
export function removeSmallComponents(img, w, h, minArea) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  const blob = [];
  let total = 0;
  for (let i = 0; i < img.length; i++) {
    if (!img[i] || seen[i]) continue;
    blob.length = 0;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      blob.push(p);
      const px = p % w, py = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (!img[q] || seen[q]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (blob.length < minArea) {
      for (const p of blob) img[p] = 0;
    } else {
      total += blob.length;
    }
  }
  return total;
}

/**
 * Chamfer 3-4 distance transform of the ink, normalised back to pixel units.
 * Used to estimate local stroke thickness (and therefore the mask pen width).
 */
export function distanceTransform(src, w, h) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? INF : 0;

  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      const a = d[i - w - 1] + 4, b = d[i - w] + 3, c = d[i - w + 1] + 4, e = d[i - 1] + 3;
      if (a < m) m = a;
      if (b < m) m = b;
      if (c < m) m = c;
      if (e < m) m = e;
      d[i] = m;
    }
  }
  for (let y = h - 2; y >= 0; y--) {
    for (let x = w - 2; x >= 1; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      const a = d[i + w + 1] + 4, b = d[i + w] + 3, c = d[i + w - 1] + 4, e = d[i + 1] + 3;
      if (a < m) m = a;
      if (b < m) m = b;
      if (c < m) m = c;
      if (e < m) m = e;
      d[i] = m;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i] === INF ? 0 : d[i] / 3;
  return d;
}

/**
 * Stroke thickness statistics measured along the skeleton.
 * `p85` is a robust "typical half-width"; `max` catches bowls and swashes.
 */
export function strokeWidthStats(dist, skel) {
  const samples = [];
  for (let i = 0; i < skel.length; i++) if (skel[i]) samples.push(dist[i]);
  if (!samples.length) return { median: 1, p85: 1, max: 1, count: 0 };
  samples.sort((a, b) => a - b);
  const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return {
    median: at(0.5),
    p85: at(0.85),
    max: samples[samples.length - 1],
    count: samples.length,
  };
}
