/**
 * Hand-refined capitals (A to M): dense waypoints in the pen model's letter
 * frame, each entry { width, waypoints, marks? }. See GUIDE.md; an entry here
 * overrides the derived letter of the same name.
 *
 * Zaner-Bloser cursive capitals, authored upright: cap height 1.5, tails to
 * about -0.5. Capitals never join, so the last waypoint is simply where the
 * ink ends. Every loop is drawn through at least four points so the model
 * keeps it open; every retrace turns through more than 149° so the pen stops
 * there (a cusp) instead of rounding into a blob. Further strokes of a
 * letter (F H K) are marks, written straight after it with a lift.
 */

// a capital's left stem: a small hook forward at the top, straight down, a small curl to the left at the foot
const CAP_STEM = [[0.08, 1.4], [0.28, 1.5], [0.42, 1.3], [0.35, 0.65], [0.28, 0.06], [0.18, 0.0], [0.1, 0.1]];

export const capitalsAM = {
  // an enlarged a: the oval from its top right, down the left, round the bottom and up the right side to
  // the top of the stem (a cusp), straight back down it to the baseline, a short undercurve out
  A: { width: 1.5, waypoints: [
    [1.05, 1.4], [0.75, 1.5], [0.4, 1.35], [0.12, 0.95], [0.06, 0.5], [0.2, 0.15], [0.5, 0.0], [0.85, 0.1], [1.06, 0.45], [1.13, 0.95],
    [1.16, 1.45], [1.13, 0.9], [1.11, 0.45], [1.1, 0.0], [1.26, 0.08], [1.5, 0.5],
  ] },
  // the hooked stem down to a stop at the baseline; back up it; the upper bowl clockwise, returning to the
  // stem at mid height where a small loop climbs over the returning line; the larger lower bowl round to
  // the baseline, curling up into a small loop inside the letter
  B: { width: 1.5, waypoints: [
    [0.08, 1.4], [0.28, 1.5], [0.42, 1.3], [0.35, 0.65], [0.28, 0.0],
    [0.36, 0.65], [0.46, 1.32],
    [0.78, 1.5], [1.08, 1.34], [1.12, 1.05], [0.9, 0.86], [0.5, 0.8],
    [0.34, 0.86], [0.36, 1.0], [0.52, 1.0], [0.68, 0.86],
    [1.05, 0.76], [1.3, 0.52], [1.3, 0.2], [1.02, 0.02], [0.62, 0.0],
    [0.38, 0.1], [0.4, 0.3], [0.6, 0.32],
  ] },
  // the hook: landing below the top right, curling up and over to the left; the big open oval down the
  // left and round the bottom, rising to end at half height
  C: { width: 1.5, waypoints: [
    [1.12, 1.2], [1.22, 1.4], [1.08, 1.5], [0.85, 1.48], [0.5, 1.35], [0.18, 1.0], [0.05, 0.6], [0.14, 0.22], [0.45, 0.0], [0.85, 0.05], [1.15, 0.3], [1.36, 0.6],
  ] },
  // the stem from the top; at the foot a small loop swinging left along the baseline, up and back right
  // across the stem; the bowl along the baseline, up the right and over the top; a small loop closing on
  // the stem's top
  D: { width: 1.5, waypoints: [
    [0.52, 1.48], [0.44, 0.95], [0.36, 0.4], [0.3, 0.06], [0.16, 0.0], [0.03, 0.1], [0.04, 0.26], [0.2, 0.34], [0.46, 0.26],
    [0.8, 0.05], [1.2, 0.15], [1.44, 0.55], [1.42, 1.05], [1.18, 1.4], [0.82, 1.5], [0.5, 1.47],
    [0.24, 1.42], [0.14, 1.3], [0.28, 1.2], [0.58, 1.26],
  ] },
  // from a curl inside the top right, over the top and down the upper bowl counter-clockwise, back to the
  // middle; a small loop up and over to the left; the larger lower bowl down the left and round the bottom,
  // rising to end at the right
  E: { width: 1.4, waypoints: [
    [1.06, 1.26], [1.14, 1.42], [1.0, 1.5], [0.66, 1.46], [0.36, 1.28], [0.26, 1.02], [0.38, 0.84], [0.62, 0.76],
    [0.7, 0.86], [0.58, 0.96], [0.4, 0.86], [0.32, 0.64],
    [0.12, 0.34], [0.16, 0.1], [0.48, 0.0], [0.88, 0.04], [1.18, 0.2], [1.32, 0.42],
  ] },
  // the stem, built like the T's (capitals-nz.js): from the right below the cap line up into a small
  // loop over the top, straight down, a curl to the left at the foot. Marks: the wave across the cap
  // line (the T's), then the tick across the stem at mid height.
  F: { width: 1.5, waypoints: [
    [0.7, 1.28], [0.82, 1.42], [0.74, 1.51], [0.6, 1.47], [0.55, 1.34], [0.54, 1.0], [0.51, 0.5], [0.49, 0.15], [0.43, 0.03], [0.31, 0.03], [0.24, 0.12],
  ], marks: [
    [[0.12, 1.3], [0.1, 1.42], [0.22, 1.5], [0.5, 1.48], [0.8, 1.42], [1.1, 1.44], [1.35, 1.44], [1.45, 1.35]],
    [[0.34, 0.72], [0.52, 0.8], [0.72, 0.74]],
  ] },
  // as the C: the hook landing below the top right, curling up and over to the left, the big open oval down
  // the left and round the bottom; up the right side to 0.62, then a short horizontal to the left (the bar)
  // into a small clockwise loop at mid height, and out down to the right, just clear of the upstroke; the
  // tail stops short of the next letter's lead-in and eases to the right as it ends so the shade fades
  G: { width: 1.5, waypoints: [
    [1.14, 1.24], [1.22, 1.4], [1.08, 1.5], [0.85, 1.48], [0.5, 1.35], [0.18, 1.0], [0.06, 0.6], [0.14, 0.22], [0.45, 0.0], [0.8, 0.04], [1.04, 0.26], [1.14, 0.48], [1.12, 0.62],
    [0.98, 0.72], [0.8, 0.76], [0.68, 0.88], [0.76, 1.04], [0.96, 1.06], [1.14, 0.94], [1.26, 0.72], [1.34, 0.54], [1.4, 0.42], [1.46, 0.36],
  ] },
  // the left stem; then from a hook at the top right down the right stem to mid height, across to the
  // left stem as the bar, a tight turn there and back along it, on down to the baseline and out
  H: { width: 1.5, waypoints: CAP_STEM, marks: [
    [[0.95, 1.4], [1.18, 1.5], [1.3, 1.3], [1.22, 0.86], [0.95, 0.82], [0.55, 0.78], [0.34, 0.7], [0.36, 0.6], [0.6, 0.62], [1.0, 0.66], [1.18, 0.6], [1.14, 0.3], [1.1, 0.0], [1.26, 0.08], [1.5, 0.55]],
  ] },
  // a small curl down to the baseline at the left, then the undercurve, bulging right, up to the top right;
  // the hood, wide and round, over to the left; straight down the stem to the baseline into a small
  // clockwise loop to the left (its left side over the curl), back across the stem and a short undercurve out
  I: { width: 1.3, waypoints: [
    [0.16, 0.14], [0.26, 0.04], [0.44, 0.02], [0.64, 0.08], [0.86, 0.36], [1.04, 0.76], [1.14, 1.14], [1.14, 1.38], [1.06, 1.53], [0.9, 1.57], [0.74, 1.5], [0.64, 1.34],
    [0.62, 0.95], [0.59, 0.55], [0.56, 0.12], [0.44, 0.02], [0.26, 0.02], [0.12, 0.14], [0.12, 0.32], [0.28, 0.46], [0.54, 0.44], [0.76, 0.3], [0.96, 0.26], [1.14, 0.42],
  ] },
  // the undercurve up to the top right, over to the left and straight down through the baseline; the tail
  // loops to the left and comes back up across the stem at the baseline; out to the right
  J: { width: 1.2, waypoints: [
    [0.12, 0.05], [0.45, 0.5], [0.78, 1.1], [1.0, 1.4], [1.0, 1.52], [0.84, 1.57], [0.66, 1.44], [0.6, 1.1], [0.58, 0.5], [0.55, 0.0], [0.48, -0.35], [0.36, -0.5], [0.22, -0.4], [0.24, -0.18], [0.45, 0.0], [0.72, 0.1], [1.0, 0.45],
  ] },
  // the stem; then from the top right down to the stem's middle, a small loop climbing clockwise over
  // the incoming line, the leg down and right to the baseline and the undercurve out
  K: { width: 1.5, waypoints: CAP_STEM, marks: [
    [[1.4, 1.5], [1.14, 1.22], [0.85, 0.95], [0.62, 0.8], [0.46, 0.74], [0.4, 0.84], [0.5, 0.94], [0.66, 0.84], [0.9, 0.45], [1.05, 0.0], [1.22, 0.1], [1.5, 0.6]],
  ] },
  // a tall narrow loop from the baseline; down the stem into a small loop at the foot crossing to the
  // right; the wave along the baseline ending in a small hook
  L: { width: 1.5, waypoints: [
    [0.1, 0.05], [0.42, 0.5], [0.8, 1.12], [1.02, 1.44], [0.92, 1.52], [0.72, 1.44], [0.6, 1.08], [0.5, 0.55], [0.42, 0.14],
    [0.28, 0.0], [0.16, 0.1], [0.26, 0.24], [0.5, 0.18], [0.78, 0.04], [1.08, 0.0], [1.3, 0.1], [1.44, 0.28], [1.36, 0.4],
  ] },
  // an overcurve up to the rounded top of the first stem, straight down, a stop; back up the stem into a
  // round hump and down the second stem; the same again; the undercurve out
  M: { width: 1.8, waypoints: [
    [0.04, 1.15], [0.16, 1.44], [0.32, 1.5], [0.42, 1.36], [0.34, 0.7], [0.26, 0.0],
    [0.32, 0.55], [0.42, 1.08], [0.58, 1.42], [0.76, 1.5], [0.92, 1.38], [0.9, 0.7], [0.86, 0.0],
    [0.92, 0.55], [1.02, 1.08], [1.18, 1.42], [1.36, 1.5], [1.52, 1.38], [1.48, 0.7], [1.44, 0.0],
    [1.58, 0.08], [1.8, 0.5],
  ] },
};
