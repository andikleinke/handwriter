/**
 * Hand-refined letters, group "arches": dense waypoints in the pen model's
 * letter frame (baseline 0, x-height 1, x in x-heights), each entry
 * { width, exit?, joinTarget?, waypoints, marks? }. See ../hand-letters.js
 * for the format and the rules; an entry here overrides the derived letter
 * of the same name.
 *
 * The short letters i t u v w share one vocabulary: an undercurve lead-in,
 * flat off the baseline and steep at the top, ending in a cusp at x-height
 * (a reversal well over 150°, so the pen stops and turns); a straight,
 * shaded downstroke; a round bottom made of three short strokes turning
 * about 50° each. A join lands on the cusp itself (`joinTarget` 3): from the
 * baseline it is then one straight undercurve out of the previous letter's
 * round bottom, from a checkstroke (b o v w) a level bridge at x-height,
 * and the letter written alone keeps its whole curved lead-in.
 *
 * The arched letters m n x rise over a round arch drawn through seven
 * points of a circle, come straight down, and (m n) retrace exactly up the
 * same line from a cusp at the baseline into the next arch.
 */

// the undercurve lead-in up to a cusp at x-height above the stem at x
const LEAD_IN = (x) => [[0, 0], [x - 0.2, 0.15], [x - 0.1, 0.5], [x, 1.0]];

// a straight stem at x, down to the baseline, and its round bottom turning out to the right
const STEM_BOTTOM = (x) => [[x, 0.12], [x + 0.03, 0.03], [x + 0.09, 0.0], [x + 0.16, 0.1]];

// a round arch of half-width r centred on cx: from the left leg at three quarters height, over the top in 30° steps, down the right leg.
// The peak is aimed a shade above x-height: the pen never quite reaches a target between overlapping strokes, so it lands on the line.
const ARCH = (cx, r = 0.24) => [
  [cx - r, 0.76], [cx - 0.87 * r, 0.89], [cx - 0.5 * r, 0.985], [cx, 1.02], [cx + 0.5 * r, 0.985], [cx + 0.87 * r, 0.89], [cx + r, 0.76],
];

// the entrance overcurve of m n x: steeply up (a join lands on the second point), then over a round arch whose right leg is the first stem at x
const OVER_IN = (x) => [[0, 0], [x - 0.34, 0.72], [x - 0.31, 0.88], [x - 0.25, 0.98], [x - 0.17, 1.02], [x - 0.08, 0.975], [x - 0.02, 0.87], [x, 0.76]];

// the checkstroke of v w at the top of the last upstroke: a sharp turn and a short dip to the right, then out level at 0.9
const CHECK = (x) => [[x, 0.98], [x + 0.1, 0.9]];

export const arches = {
  // undercurve up to the cusp; straight down; round the bottom; out. The dot above the stem.
  i: { width: 0.5, exit: 'base', joinTarget: 3, waypoints: [...LEAD_IN(0.28), ...STEM_BOTTOM(0.28), [0.5, 0.9]], marks: [[[0.28, 1.45]]] },
  // as i, but the upstroke goes on up the stem to three quarters of the ascender; the bar crosses the stem a little above x-height
  t: { width: 0.6, exit: 'base', joinTarget: 3, waypoints: [...LEAD_IN(0.32), [0.34, 1.6], ...STEM_BOTTOM(0.34), [0.6, 0.9]], marks: [[[0.06, 1.15], [0.6, 1.15]]] },
  // two stems with sharp tops and round bottoms, the undercurve between them rising to the second cusp
  u: { width: 1.15, exit: 'base', joinTarget: 3, waypoints: [...LEAD_IN(0.36), ...STEM_BOTTOM(0.36), [0.66, 0.45], [0.8, 0.82], [0.84, 1.0], ...STEM_BOTTOM(0.84), [1.15, 0.9]] },
  // one stem, a bottom sharper than u's, the diagonal up to x-height, the checkstroke
  v: { width: 0.9, exit: 'mid', joinTarget: 3, waypoints: [...LEAD_IN(0.32), [0.36, 0.1], [0.4, 0.01], [0.46, 0.06], [0.56, 0.36], [0.66, 0.7], ...CHECK(0.74), [0.9, 0.9]] },
  // u, then a third upstroke to x-height and the checkstroke
  w: { width: 1.4, exit: 'mid', joinTarget: 3, waypoints: [...LEAD_IN(0.34), ...STEM_BOTTOM(0.34), [0.64, 0.45], [0.78, 0.82], [0.82, 1.0], ...STEM_BOTTOM(0.82), [1.1, 0.45], [1.2, 0.8], ...CHECK(1.26), [1.4, 0.9]] },
  // the entrance arch and stem; from a cusp at the baseline back up the stem into the second arch; the second stem; out
  n: { width: 1.15, exit: 'base', joinTarget: { base: 1, mid: 2 }, waypoints: [...OVER_IN(0.36), [0.36, 0], ...ARCH(0.6), ...STEM_BOTTOM(0.84), [1.15, 0.9]] },
  // as n with three arches
  m: { width: 1.7, exit: 'base', joinTarget: { base: 1, mid: 2 }, waypoints: [...OVER_IN(0.36), [0.36, 0], ...ARCH(0.6), [0.84, 0], ...ARCH(1.08), ...STEM_BOTTOM(1.32), [1.7, 0.9]] },
  // the first half of an n with a wider arch, the stem at the middle; out. The second slant crosses the stem at mid height.
  x: { width: 0.9, exit: 'base', joinTarget: 1, waypoints: [[0, 0], [0.03, 0.72], [0.07, 0.9], [0.15, 0.99], [0.25, 1.02], [0.36, 0.975], [0.44, 0.88], [0.47, 0.76], ...STEM_BOTTOM(0.47), [0.9, 0.9]], marks: [[[0.85, 0.95], [0.1, 0.05]]] },
};
