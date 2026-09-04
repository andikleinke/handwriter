/**
 * The italic hand's lowercase n to z: a loop-free, branching cursive (in the
 * manner of Getty-Dubay italic handwriting) as dense waypoints in the pen
 * model's letter frame, each entry { width, exit?, joinTarget?, stops?,
 * waypoints, marks? }. See GUIDE.md.
 *
 * The vocabulary is the one of italic-am.js, so that the two halves agree:
 * authored upright, x-height 1, descenders straight to -0.9; a letter entered
 * from the baseline starts with one straight diagonal lead-in to its join
 * target (a join replaces it); the first stem at 0.26 and the arches spanning
 * 0.46; a tight foot turning out into the exit, which for a letter written
 * last is a short flick at about 60 degrees to a third of the x-height (the
 * composer aims that stroke at the next letter instead when it joins).
 * The arched letters n r (and p's bowl) *branch*: the stem comes down to a
 * stop at the baseline, the pen goes back up the same line to 0.6 and swings
 * out over half an ellipse. The u y are the same shape upside down, a narrow
 * turn at the baseline and a diagonal branching up to the next stem's top;
 * v w are the pointed version, leaving from a check at the top like b: a
 * stop and a short dip, then level. The o closes on its own first stroke at
 * an explicit stop and leaves level from there. The q carries the a-bowl of
 * italic-am.js and y its hooked descender. Nothing loops: q ends in a tick,
 * t is a short stem with a bar.
 *
 * s x z are entered at the top like c and e, without a lead-in: a join lands
 * on their first waypoint. The corners of x and z are explicit stops - the
 * model rounds any turn gentler than 150 degrees and would bend the straight
 * strokes next to it otherwise.
 */

// a straight lead-in from the baseline to the join target at [x, y]; a join replaces it
const LEAD = (x, y = 1.0) => [[0, 0], [x, y]];

// the foot of a stem at x: the stem ends just above the baseline and turns tightly out to the right, into the exit
const FOOT = (x) => [[x, 0.06], [x + 0.05, 0.0]];

// the branching arch: from the retrace's top on the stem at x, out and over half an ellipse (its top aimed a shade
// above x-height, as the pen never quite reaches a target between overlapping strokes) into the next stem at x + w
const BRANCH = (x, w) => [[x, 0.6], [x + 0.08 * w, 0.8], [x + 0.3 * w, 0.95], [x + 0.6 * w, 1.02], [x + 0.8 * w, 0.95], [x + 0.946 * w, 0.8], [x + w, 0.6]];

// the bowl of q (the a-bowl of italic-am.js): from the top of the stem at s over the top to the left, down the
// left side, round the bottom, up the straight right side (the stem line) back to the top, where the pen stops
const A_BOWL = (s) => [[s, 0.9], [s - 0.16, 0.99], [s - 0.34, 0.95], [s - 0.5, 0.8], [s - 0.58, 0.58], [s - 0.58, 0.34], [s - 0.5, 0.13], [s - 0.34, 0.02], [s - 0.16, 0.04], [s - 0.03, 0.16], [s, 0.4], [s, 0.9]];

// the descender of y (as g and j): straight down from the stem at x to -0.9, then a hook to the left
const HOOK = (x) => [[x, -0.5], [x - 0.02, -0.74], [x - 0.1, -0.88], [x - 0.22, -0.9], [x - 0.34, -0.8]];

// the u-turn: the stem at x down to the baseline, a narrow elliptical turn, and the diagonal branching up to a
// stop at the top of the next stem at x + w
const U_TURN = (x, w) => [[x, 0.08], [x + 0.03, 0.01], [x + 0.11, 0.0], [x + 0.22, 0.1], [x + w - 0.08, 0.55], [x + w, 1.0]];

// the v-dip: a straight diagonal from the top of the stem at x down to a narrow, rounded point at the baseline
// and the diagonal back up toward the top at x + w (the top itself follows: a stop, or the hook)
const V_DIP = (x, w) => [[x + 0.08, 0.6], [x + 0.16, 0.14], [x + 0.2, 0.02], [x + 0.25, 0.06], [x + w - 0.08, 0.55]];

// the check of v w at the top of the last upstroke: a sharp turn at x and a short dip to the right, out level
// (two points only: a rounder hook fills in to a knot under the nib)
const CHECK = (x) => [[x, 0.98], [x + 0.08, 0.9]];

export const italicNZ = {
  // lead-in to a stop at x-height; the stem down, a stop; back up the stem into the arch and down the second stem; the foot; out
  n: { width: 0.92, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.26), [0.26, 0.0], ...BRANCH(0.26, 0.46), ...FOOT(0.72), [0.92, 0.3]] },
  // the ellipse, counter-clockwise from the top right (a join lands there): over the top, down the left, round the
  // bottom, up the right and over to close on its own first stroke just below the top, where the pen stops
  // (an explicit stop: the turn is too gentle to halt the pen by itself, and a rounded closure blobs); the exit
  // leaves from there, level at x-height
  o: { width: 0.75, exit: 'mid', stops: [13], waypoints: [[0.62, 0.84], [0.52, 0.96], [0.36, 1.01], [0.2, 0.93], [0.08, 0.74], [0.05, 0.5], [0.1, 0.26], [0.24, 0.07], [0.42, 0.01], [0.57, 0.1], [0.65, 0.32], [0.66, 0.58], [0.63, 0.78], [0.57, 0.91], [0.75, 0.85]] },
  // lead-in to a stop at x-height; the stem straight down to the descender, a stop; back up the same line past the
  // baseline into the branch; the bowl out over the top, round the right and back to the stem at the baseline, a
  // stop; along the baseline under the bowl; out
  p: { width: 0.8, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.22), [0.22, 0.1], [0.22, -0.9], [0.22, 0.0], [0.22, 0.6], [0.26, 0.8], [0.36, 0.95], [0.5, 1.02], [0.61, 0.95], [0.68, 0.78], [0.7, 0.55], [0.66, 0.3], [0.56, 0.1], [0.42, 0.02], [0.27, 0.05], [0.6, 0.0], [0.8, 0.32]] },
  // the a-bowl; a stop at the top; the stem straight down to the descender and a small tick out to the right; a lift
  q: { width: 0.8, exit: 'none', waypoints: [...A_BOWL(0.64), [0.64, 0.1], [0.64, -0.84], [0.68, -0.92], [0.78, -0.85]] },
  // lead-in to a stop at x-height; the stem down, a stop; back up the stem and out into a short branching arm,
  // which ends in a slight downward hook at x-height, where the join leaves level
  r: { width: 0.55, exit: 'mid', joinTarget: 1, waypoints: [...LEAD(0.26), [0.26, 0.0], [0.26, 0.6], [0.3, 0.8], [0.4, 0.95], [0.52, 0.99], [0.55, 0.85]] },
  // from the top (a join lands there) a small curve over to the right; the straight spine down-left; round the
  // bottom to the right; out
  s: { width: 0.62, exit: 'base', waypoints: [[0.44, 1.0], [0.54, 0.99], [0.6, 0.91], [0.57, 0.81], [0.41, 0.62], [0.25, 0.45], [0.16, 0.28], [0.14, 0.14], [0.22, 0.04], [0.36, 0.0], [0.5, 0.05], [0.62, 0.3]] },
  // lead-in to x-height on the stem (a join lands there), straight on up to a stop short of ascender height, back
  // down the stem; round the bottom; out. The bar sits on the x-height line, mostly to the right of the stem.
  t: { width: 0.5, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.26, 0.9), [0.26, 1.3], [0.26, 0.1], [0.29, 0.02], [0.36, 0.0], [0.5, 0.3]], marks: [[[0.02, 1.0], [0.5, 1.0]]] },
  // lead-in to a stop at x-height; the stem down, the narrow turn and the diagonal up to a stop at the top of the
  // second stem; down; the foot; out
  u: { width: 0.92, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.26), ...U_TURN(0.26, 0.46), ...FOOT(0.72), [0.92, 0.3]] },
  // lead-in to a stop at x-height; the diagonal down to the point and up to the top right; the check and the
  // level exit
  v: { width: 0.75, exit: 'mid', joinTarget: 1, waypoints: [...LEAD(0.26), ...V_DIP(0.26, 0.38), ...CHECK(0.64), [0.75, 0.85]] },
  // two v's sharing a stop at x-height in the middle; the check and the level exit
  w: { width: 1.15, exit: 'mid', joinTarget: 1, waypoints: [...LEAD(0.26), ...V_DIP(0.26, 0.38), [0.64, 1.0], ...V_DIP(0.64, 0.38), ...CHECK(1.02), [1.15, 0.85]] },
  // from a stop at the top left (a join lands there) the straight diagonal down to the bottom right; out. The mark
  // is the other diagonal, from the top right down to the bottom left, crossing at mid height; the two are mirror
  // images upright, so they stay symmetric about the slanted axis once the hand's slant (a shear) is applied.
  x: { width: 0.75, exit: 'base', stops: [0], waypoints: [[0.14, 1.0], [0.38, 0.5], [0.58, 0.04], [0.62, 0.0], [0.75, 0.32]], marks: [[[0.64, 1.0], [0.12, 0.0]]] },
  // lead-in to a stop at x-height; the stem down, the narrow turn and the diagonal up to a stop at the top of the
  // second stem, which runs straight on down to the descender and hooks to the left; a lift
  y: { width: 0.8, exit: 'none', joinTarget: 1, waypoints: [...LEAD(0.26), ...U_TURN(0.26, 0.46), ...HOOK(0.72)] },
  // from a stop at the top left (a join lands there) the top bar; a stop; the diagonal down-left; a stop; the bottom
  // bar, turning up tightly into the flick out
  z: { width: 0.7, exit: 'base', stops: [0, 1, 2], waypoints: [[0.05, 1.0], [0.56, 1.0], [0.05, 0.0], [0.5, 0.0], [0.56, 0.0], [0.7, 0.3]] },
};
