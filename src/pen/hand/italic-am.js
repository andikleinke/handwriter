/**
 * The italic hand's lowercase a to m: a loop-free, branching cursive (in the
 * manner of Getty-Dubay italic handwriting) as dense waypoints in the pen
 * model's letter frame, each entry { width, exit?, joinTarget?, stops?,
 * waypoints, marks? }. See GUIDE.md.
 *
 * Authored upright (the hand's slant is the composer's): x-height 1,
 * ascenders plain stems to 1.8, descenders straight to -0.9 with a hook to
 * the left, no loops anywhere. A letter entered from the baseline starts with
 * one straight diagonal lead-in to its join target; the ascender stems of
 * b d h k l are entered at x-height and retraced (up to the top, a stop,
 * straight back down). The arches of h and m branch from the stem: the pen
 * comes down, reverses at the baseline, goes back up the same line to just
 * over half height and swings out over an elliptical arch, peaking right of
 * centre, into the next stem. First stems at 0.28, arches spanning 0.46,
 * as in the n-z half (italic-nz.js), which shares the a-bowl and the hook.
 *
 * Every stem foot is a round bounce of radius about 0.09: with the monoline
 * nib 0.08 wide, a tighter turn folds the ink ribbon over itself. The exit
 * of a letter written last is a short flick at about 60° rising to a third
 * of the x-height (the italic exit serif), which may overhang the advance
 * width a little; when the letter joins, the composer aims that stroke at
 * the next letter's join target instead, so the flick never shows in a word.
 */

// a straight lead-in from the baseline to the join target at [x, y]; a join replaces it
const LEAD = (x, y = 1.0) => [[0, 0], [x, y]];

// the foot of a stem at x: straight down to the baseline and a round bounce out to the right, into the exit
const FOOT = (x) => [[x, 0.14], [x + 0.03, 0.04], [x + 0.1, 0.0], [x + 0.16, 0.05]];

// the exit flick after the foot of a stem at x
const FLICK = (x) => [x + 0.3, 0.3];

// the branching arch: from the retrace's top on the stem at x, out and over an elliptical arch peaking right of
// centre (a shade above x-height, since the pen never quite reaches a target between overlapping strokes) and down
// into the next stem at x + w, which is straight from 0.62 on
const BRANCH = (x, w) => [[x, 0.58], [x + 0.18 * w, 0.8], [x + 0.45 * w, 0.96], [x + 0.73 * w, 1.02], [x + 0.93 * w, 0.94], [x + w, 0.8], [x + w, 0.62]];

// the bowl of a d g: from the top right (the top of the stem at s) over the top to the left, down the left side,
// round the bottom, up the straight right side (the stem line) back to the top, where the pen stops
const A_BOWL = (s) => [[s, 0.9], [s - 0.16, 0.99], [s - 0.34, 0.95], [s - 0.5, 0.8], [s - 0.58, 0.58], [s - 0.58, 0.34], [s - 0.5, 0.13], [s - 0.34, 0.02], [s - 0.16, 0.04], [s - 0.03, 0.16], [s, 0.4], [s, 0.9]];

// the lower body of c and e: down the left side, round the bottom, out of the bottom right
const C_BODY = [[0.07, 0.72], [0.05, 0.48], [0.1, 0.24], [0.24, 0.06], [0.42, 0.01], [0.56, 0.08], [0.62, 0.18]];

// the descender of g and j: straight down from the stem at x to -0.9, then a hook to the left
const HOOK = (x) => [[x, -0.5], [x - 0.02, -0.74], [x - 0.1, -0.88], [x - 0.24, -0.9], [x - 0.36, -0.8]];

export const italicAM = {
  // the bowl; a stop at the top; the stem down its right side; the foot; the exit
  a: { width: 0.84, exit: 'base', waypoints: [...A_BOWL(0.64), ...FOOT(0.64), FLICK(0.64)] },
  // lead-in to x-height on the stem, on up to the top, a stop, straight down; round the bottom into the bowl, up its
  // right side and over the top back toward the stem, where the pen stops; the exit leaves level from there, over
  // the bowl's top right
  b: { width: 0.8, exit: 'mid', joinTarget: 1, waypoints: [...LEAD(0.22, 0.9), [0.22, 1.8], [0.22, 0.12], [0.24, 0.03], [0.36, 0.0], [0.54, 0.05], [0.66, 0.22], [0.7, 0.48], [0.66, 0.74], [0.57, 0.9], [0.46, 0.95], [0.8, 0.85]] },
  // from the top right over the top, down the left, round the bottom, out
  c: { width: 0.72, exit: 'base', waypoints: [[0.6, 0.82], [0.5, 0.95], [0.34, 1.0], [0.18, 0.92], ...C_BODY, [0.76, 0.42]] },
  // the bowl; straight on up the stem line to the top, a stop, straight down; the foot; the exit
  d: { width: 0.84, exit: 'base', waypoints: [...A_BOWL(0.64), [0.64, 1.8], ...FOOT(0.64), FLICK(0.64)] },
  // the crossbar from the left; up and over the top to the left; down the left side, round the bottom, out
  e: { width: 0.72, exit: 'base', waypoints: [[0.12, 0.58], [0.54, 0.58], [0.6, 0.76], [0.5, 0.94], [0.34, 1.0], [0.18, 0.92], ...C_BODY, [0.76, 0.42]] },
  // lead-in to x-height on the stem, up to a stop just short of the ascender, straight back down; the foot; out.
  // The hook at the top and the bar at x-height are written after the word (a join into a hook-first f closed the
  // hook into a loop): the hook leaves the stem top up and over to the right and drops to its tip.
  f: { width: 0.6, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.3, 0.9), [0.3, 1.72], ...FOOT(0.3), FLICK(0.3)], marks: [[[0.3, 1.72], [0.36, 1.82], [0.47, 1.86], [0.58, 1.8], [0.63, 1.66]], [[0.02, 1.0], [0.56, 1.0]]] },
  // the bowl; a stop at the top; the stem straight down to the descender and the hook to the left; a lift
  g: { width: 0.8, exit: 'none', waypoints: [...A_BOWL(0.64), ...HOOK(0.64)] },
  // lead-in to x-height on the stem, up to the top, a stop, straight down, a stop; back up the stem into the branch, over the arch, the second stem down; the foot; out
  h: { width: 0.94, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.28, 0.9), [0.28, 1.8], [0.28, 0.0], ...BRANCH(0.28, 0.46), ...FOOT(0.74), FLICK(0.74)] },
  // lead-in to a stop at x-height; straight down; the foot; out. The dot above the stem.
  i: { width: 0.48, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.28), ...FOOT(0.28), FLICK(0.28)], marks: [[[0.28, 1.4]]] },
  // as i, but straight on down to the descender and the hook to the left; a lift. The dot above the stem.
  j: { width: 0.46, exit: 'none', joinTarget: 1, waypoints: [...LEAD(0.36), ...HOOK(0.36)], marks: [[[0.36, 1.4]]] },
  // the ascender stem as h; back up the stem to mid height, a stop, and straight out along the arm to its tip,
  // a stop; straight back in to the stem (open: no eye), a stop; the straight leg out to the baseline, a round
  // foot; the exit
  k: { width: 0.86, exit: 'base', joinTarget: 1, stops: [4, 6], waypoints: [...LEAD(0.28, 0.9), [0.28, 1.8], [0.28, 0.0], [0.28, 0.55], [0.72, 0.95], [0.34, 0.5], [0.66, 0.08], [0.72, 0.0], [0.8, 0.05], [0.94, 0.3]] },
  // lead-in to x-height on the stem, up to the top, a stop, straight down; the foot; out
  l: { width: 0.46, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.26, 0.9), [0.26, 1.8], ...FOOT(0.26), FLICK(0.26)] },
  // lead-in to a stop at x-height; the first stem down, a stop; back up into the first arch and down the second stem, a stop; back up into the second arch and down the third; the foot; out
  m: { width: 1.4, exit: 'base', joinTarget: 1, waypoints: [...LEAD(0.28), [0.28, 0.0], ...BRANCH(0.28, 0.46), [0.74, 0.0], ...BRANCH(0.74, 0.46), ...FOOT(1.2), FLICK(1.2)] },
};
