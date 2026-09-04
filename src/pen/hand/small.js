/**
 * Hand-refined letters, group "small": r, s and x as dense waypoints in the
 * pen model's letter frame (baseline 0, x-height 1, x in x-heights), each
 * entry { width, exit?, joinTarget?, waypoints, marks? }. See GUIDE.md; an
 * entry here overrides every other group's letter of the same name.
 *
 * The vocabulary is the one of the short letters (arches.js): an undercurve
 * lead-in, flat off the baseline and steep at the top; a straight shaded
 * stem; a round bottom of three short strokes; the exit rising from it.
 *
 * The pointed tops of r and s are explicit stops (`stops`): the pen halts on
 * the point whether the letter is written alone or joined, without a
 * retrace that would show as a spur after a level bridge.
 */

// the undercurve lead-in up to x-height above x
const LEAD_IN = (x) => [[0, 0], [x - 0.2, 0.15], [x - 0.1, 0.5], [x, 1.0]];

// a straight stem at x, down to the baseline, and its round bottom turning out to the right
const STEM_BOTTOM = (x) => [[x, 0.12], [x + 0.03, 0.03], [x + 0.09, 0.0], [x + 0.16, 0.1]];

export const small = {
  // the lead-in up to a point at the top left, where the pen stops and retraces a little; the shoulder, flat
  // and a shade rising, to the right, rounding over into the dip; the stem, shorter than an i's, straight down;
  // round the bottom; out
  r: {
    width: 0.75, exit: 'base', joinTarget: 3, stops: [3],
    waypoints: [
      ...LEAD_IN(0.3),
      [0.42, 1.02], [0.54, 1.0], [0.6, 0.9],
      [0.57, 0.5],
      ...STEM_BOTTOM(0.55),
      [0.75, 0.9],
    ],
  },
  // the lead-in to the pointed top, where the pen stops and retraces a little; down the back, bulging to the
  // right and round a full bottom, closing to the left on the lead-in (the tie, a second stop); from the tie
  // back along the baseline underneath the bowl, so the exit leaves from the bottom right like every other
  // letter's; out
  s: {
    width: 0.75, exit: 'base', joinTarget: 4, stops: [4, 11],
    waypoints: [
      [0, 0], [0.14, 0.12], [0.28, 0.38], [0.38, 0.68], [0.45, 1.0],
      [0.5, 0.86], [0.59, 0.7], [0.66, 0.5], [0.62, 0.28], [0.5, 0.15], [0.34, 0.12], [0.22, 0.18],
      [0.3, 0.04], [0.44, 0.02], [0.58, 0.07],
      [0.75, 0.9],
    ],
  },
  // the overcurve entrance (a join lands on its second point), over a round arch into the stem; round the bottom;
  // out. The mark is the crossing slant, written after the word from the lower left up to the right: an upstroke,
  // so a hairline, crossing the stem at mid height.
  x: {
    width: 0.9, exit: 'base', joinTarget: { base: 1, mid: 2 },
    waypoints: [
      [0, 0], [0.1, 0.7], [0.13, 0.86], [0.19, 0.97], [0.29, 1.02], [0.4, 0.99], [0.49, 0.9], [0.54, 0.76],
      ...STEM_BOTTOM(0.55),
      [0.9, 0.9],
    ],
    // the crossing slant leans left by as much as the stem leans right once the hand's slant is applied
    // the crossing slant, a downstroke leaning left by as much as the stem leans right once the slant is applied
    marks: [[[0.16, 0.88], [0.76, 0.08]]],
  },
};
