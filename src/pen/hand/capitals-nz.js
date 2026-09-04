/**
 * Hand-refined capitals (N to Z): dense waypoints in the pen model's letter
 * frame, each entry { width, waypoints, marks? }. See GUIDE.md; an entry here
 * overrides the derived letter of the same name.
 *
 * Zaner-Bloser cursive capitals, authored upright: cap height 1.5, tails to
 * -0.5, x from 0 to the width. Capitals never join, so the last waypoint is
 * simply where the pen lifts; further strokes (the top of the T, the second
 * slant of the X) are marks written straight after the letter with a lift.
 * Every loop runs through at least four points so the model keeps its eye
 * open; every retrace turns through more than 149° so the pen stops there.
 */

// the entrance undercurve of U V W Y: up from near the baseline to a cusp at the cap line
const UNDER_IN = [[0.0, 0.25], [0.1, 0.78], [0.27, 1.32], [0.34, 1.5]];
// the overcurve of N X Z: rising from mid-height on the left, over the top at the cap line
const OVER_IN = [[0.05, 1.18], [0.14, 1.4], [0.3, 1.5]];
// the stem of P and R: a small hook forward at the top, straight down, the foot a cusp,
// then the retrace up the same line to the top
const STEM = [[0.1, 1.4], [0.3, 1.5], [0.42, 1.3], [0.36, 0.7], [0.3, 0.0], [0.37, 0.72], [0.45, 1.32]];
// the bowl of P and R, from the top of the retraced stem out to the right and back to the stem at 0.7
const BOWL = [[0.58, 1.48], [0.85, 1.5], [1.12, 1.42], [1.3, 1.2], [1.28, 0.95], [1.08, 0.78], [0.8, 0.71], [0.55, 0.72]];
// the round bottom of U and Y: the first stem down, round the bottom, up the right side to a cusp at the cap line
const U_BOTTOM = [[0.3, 1.0], [0.27, 0.5], [0.26, 0.2], [0.34, 0.04], [0.55, 0.0], [0.78, 0.12], [0.95, 0.45], [1.06, 0.95], [1.14, 1.5]];

export const capitalsNZ = {
  // overcurve up and over the top; the first stem down; retrace up and over into a round hump; the second stem; undercurve out
  N: { width: 1.5, waypoints: [...OVER_IN, [0.44, 1.38], [0.38, 0.95], [0.33, 0.5], [0.28, 0.0], [0.35, 0.5], [0.5, 1.0], [0.7, 1.38], [0.88, 1.5], [1.05, 1.42], [1.12, 1.2], [1.06, 0.7], [1.0, 0.2], [1.0, 0.02], [1.12, 0.1], [1.5, 0.75]] },
  // the oval counter-clockwise from the top right; over the top a second time into a loop that turns down and out to the
  // right, the tail stopping short of the next letter (capitals never join)
  O: { width: 1.5, waypoints: [[1.05, 1.38], [0.82, 1.5], [0.5, 1.45], [0.25, 1.2], [0.1, 0.85], [0.1, 0.5], [0.25, 0.18], [0.55, 0.02], [0.85, 0.06], [1.1, 0.3], [1.22, 0.7], [1.18, 1.1], [1.04, 1.36], [0.88, 1.5], [0.7, 1.44], [0.63, 1.28], [0.74, 1.15], [0.98, 1.13], [1.34, 1.2]] },
  // the stem down and back up; the bowl out to the right and round to the stem at 0.7
  P: { width: 1.5, waypoints: [...STEM, ...BOWL, [0.4, 0.74]] },
  // a large figure 2: over the top and down the right side, down-left to the baseline into a small clockwise knot,
  // then a wave along the baseline to the right ending in a small hook up
  Q: { width: 1.5, waypoints: [[0.5, 1.32], [0.62, 1.46], [0.85, 1.5], [1.1, 1.44], [1.28, 1.25], [1.32, 1.0], [1.22, 0.72], [1.02, 0.5], [0.78, 0.3], [0.55, 0.14], [0.36, 0.04], [0.2, 0.06], [0.14, 0.2], [0.26, 0.32], [0.45, 0.28], [0.62, 0.14], [0.85, 0.04], [1.1, 0.02], [1.35, 0.05], [1.47, 0.16], [1.42, 0.3]] },
  // as P to the bowl's return; a small loop climbing clockwise over the returning line at the stem; the leg
  // down and right across it to the baseline and the undercurve out
  R: { width: 1.5, waypoints: [...STEM, ...BOWL, [0.42, 0.8], [0.42, 0.96], [0.58, 1.02], [0.74, 0.92], [0.82, 0.7], [0.95, 0.38], [1.05, 0.02], [1.18, 0.1], [1.5, 0.75]] },
  // undercurve up to the top right; a loop over to the left; down the spine crossing the upstroke; round the bottom
  // to the right and back along the baseline into a small loop at the bottom left inside the letter
  S: { width: 1.5, waypoints: [[0.05, 0.08], [0.22, 0.4], [0.46, 0.85], [0.74, 1.3], [0.94, 1.47], [0.9, 1.52], [0.76, 1.5], [0.64, 1.4], [0.58, 1.22], [0.58, 1.0], [0.64, 0.78], [0.82, 0.56], [1.04, 0.32], [1.1, 0.14], [0.98, 0.02], [0.7, 0.0], [0.42, 0.04], [0.24, 0.12], [0.2, 0.28], [0.32, 0.38], [0.5, 0.32], [0.66, 0.2]] },
  // the stem: a small loop under the cap line, straight down, a curl to the left at the baseline; the top is a mark: a shallow wave across the cap line
  T: { width: 1.5, waypoints: [[0.66, 1.1], [0.8, 1.24], [0.74, 1.36], [0.6, 1.34], [0.54, 1.22], [0.55, 1.0], [0.52, 0.5], [0.5, 0.15], [0.44, 0.03], [0.32, 0.03], [0.25, 0.12]],
    marks: [[[0.12, 1.3], [0.1, 1.42], [0.22, 1.5], [0.5, 1.48], [0.8, 1.42], [1.1, 1.44], [1.35, 1.44], [1.45, 1.35]]] },
  // undercurve to a cusp at the top; the first stem down; round the bottom and up the right side to a cusp; the second stem; undercurve out
  U: { width: 1.5, waypoints: [...UNDER_IN, ...U_BOTTOM, [1.1, 1.0], [1.06, 0.5], [1.02, 0.02], [1.16, 0.12], [1.5, 0.75]] },
  // undercurve to a cusp; down to a rounded point at the baseline; up the right side to the cap line and an open hook to the right
  V: { width: 1.5, waypoints: [...UNDER_IN, [0.37, 1.0], [0.44, 0.5], [0.52, 0.12], [0.6, 0.0], [0.72, 0.12], [0.9, 0.5], [1.1, 1.0], [1.2, 1.32], [1.3, 1.47], [1.42, 1.48], [1.5, 1.41]] },
  // as V twice over, the middle cusp at 1.2
  W: { width: 2.0, waypoints: [...UNDER_IN, [0.38, 1.0], [0.45, 0.45], [0.52, 0.1], [0.6, 0.0], [0.7, 0.1], [0.86, 0.55], [0.98, 1.05], [1.02, 1.2], [1.06, 0.75], [1.13, 0.3], [1.2, 0.05], [1.28, 0.0], [1.38, 0.1], [1.58, 0.6], [1.76, 1.12], [1.84, 1.34], [1.9, 1.47], [2.0, 1.48], [2.06, 1.41]] },
  // overcurve over the top, then down to the bottom right with a slight bow and a small undercurve; the second slant is a mark
  X: { width: 1.5, waypoints: [...OVER_IN, [0.44, 1.4], [0.6, 1.1], [0.79, 0.75], [1.0, 0.4], [1.18, 0.1], [1.28, 0.0], [1.4, 0.08], [1.46, 0.25]],
    marks: [[[1.4, 1.42], [1.12, 1.1], [0.83, 0.75], [0.55, 0.4], [0.3, 0.1], [0.18, 0.0]]] },
  // as U to the second cusp; the second stem straight down through the baseline into a descender loop to the left, back up crossing at the baseline, out
  Y: { width: 1.5, waypoints: [...UNDER_IN, ...U_BOTTOM, [1.1, 1.0], [1.05, 0.5], [1.0, 0.0], [0.93, -0.36], [0.76, -0.56], [0.54, -0.46], [0.52, -0.22], [0.72, -0.04], [1.02, 0.1], [1.5, 0.75]] },
  // overcurve up, along the top with a slight wave, down-left to the lower left into a small clockwise knot above the baseline,
  // then down into a descender loop to the left, back up crossing at the baseline, out
  Z: { width: 1.5, waypoints: [...OVER_IN, [0.55, 1.47], [0.8, 1.4], [1.05, 1.44], [1.25, 1.44], [1.32, 1.32], [1.12, 1.0], [0.85, 0.62], [0.62, 0.34], [0.48, 0.24], [0.38, 0.22], [0.34, 0.34], [0.46, 0.46], [0.64, 0.42], [0.74, 0.28], [0.76, 0.05], [0.72, -0.3], [0.58, -0.5], [0.4, -0.42], [0.36, -0.2], [0.52, -0.04], [0.8, 0.06], [1.5, 0.75]] },
};
