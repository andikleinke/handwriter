/**
 * Hand-refined letters, group "loops": dense waypoints in the pen model's
 * letter frame (baseline 0, x-height 1, x in x-heights), each entry
 * { width, exit?, waypoints, marks? }. See ../hand-letters.js for the format
 * and the rules; an entry here overrides the derived letter of the same name.
 *
 * The ascender letters share one loop: an undercurve lead-in from the
 * baseline (a join lands on its second point) rising through the stem line at
 * x-height, on up and to the right, over the top at 2 and down the left side
 * as a straight shaded stem. Authored upright, so the loop's left side is
 * the vertical stem line and its bulge is all on the right; the composer's
 * slant leans the whole thing into the usual pointed teardrop. Five points
 * round the top keep its height and its eye against the model's corner
 * cutting.
 */

// the loop from the baseline to mid-stem: lead-in, up through the crossing, round the top, down the left
const LOOP = [[0, 0], [0.19, 0.3], [0.33, 1.0], [0.52, 1.58], [0.56, 1.84], [0.47, 2.02], [0.36, 1.98], [0.28, 1.76], [0.29, 1.18]];

export const loops = {
  // the loop; straight down; round the bottom; undercurve out
  l: { width: 0.7, exit: 'base', joinTarget: 2, waypoints: [...LOOP, [0.3, 0.3], [0.33, 0.05], [0.44, 0.0], [0.55, 0.1], [0.7, 0.9]] },
  // the loop; down to the baseline; retrace up the stem; the overcurve arch; down the far side; out
  h: { width: 1.15, exit: 'base', joinTarget: 2, waypoints: [...LOOP, [0.3, 0.0], [0.33, 0.7], [0.42, 0.95], [0.55, 1.03], [0.68, 1.0], [0.78, 0.86], [0.86, 0.0], [0.97, 0.12], [1.15, 0.9]] },
  // the loop; down through the baseline; the lower loop to the right, closing on the stem at the baseline; out
  f: { width: 0.8, exit: 'base', joinTarget: 2, waypoints: [...LOOP, [0.3, 0.3], [0.3, -0.9], [0.4, -1.05], [0.55, -0.9], [0.6, -0.55], [0.48, -0.25], [0.28, 0.02], [0.5, 0.14], [0.8, 0.9]] },
  // up and to the right; over the top to the left; down the left side; round the bottom; out
  e: { width: 0.9, exit: 'base', joinTarget: { base: 2, mid: 4 }, waypoints: [[0, 0], [0.22, 0.2], [0.45, 0.5], [0.6, 0.78], [0.62, 0.88], [0.54, 1.02], [0.41, 1.04], [0.24, 0.9], [0.13, 0.56], [0.16, 0.22], [0.32, 0.04], [0.5, 0.0], [0.68, 0.12], [0.9, 0.9]] },
  // the loop; round the bottom into the bowl; up its right side; closing at the top; the check: a stop and a tie out at x-height
  b: { width: 0.9, exit: 'mid', joinTarget: 2, stops: [15], waypoints: [...LOOP, [0.3, 0.3], [0.34, 0.04], [0.5, 0.0], [0.74, 0.15], [0.87, 0.5], [0.84, 0.8], [0.72, 0.98], [0.78, 0.88], [0.9, 0.9]] },
  // the loop; down to the baseline; retrace up the stem; the arm out and round into the eye, back to the stem; the leg; out
  k: { width: 1.1, exit: 'base', joinTarget: 2, waypoints: [...LOOP, [0.3, 0.0], [0.33, 0.6], [0.4, 0.92], [0.55, 1.04], [0.72, 0.98], [0.77, 0.82], [0.62, 0.66], [0.42, 0.58], [0.88, 0.0], [0.98, 0.12], [1.1, 0.9]] },
};
