/**
 * Hand-refined letters, group "descenders": dense waypoints in the pen model's
 * letter frame (baseline 0, x-height 1, x in x-heights), each entry
 * { width, exit?, waypoints, marks? }. See ../hand-letters.js for the format
 * and the rules; an entry here overrides the derived letter of the same name.
 *
 * The descender loops all follow one recipe: the stem straight down through
 * the baseline, three or four waypoints round the bottom at -1 so the model
 * keeps the depth, the upstroke back to cross the stem exactly at the
 * baseline, and the exit rising from that crossing. g and y loop to the
 * left, q to the right; j is the narrow one with a dot; p has no loop but a
 * retrace and a bowl; z hangs its loop from a small knot at the baseline.
 * The tops borrow their proportions from the other groups so the families
 * agree: g and q carry the a-oval, y is a u, j and p start like an i.
 */

// the a-oval (the proportions of the a of the ovals group): from the top right
// over the top, down the left, round the bottom, up the straight right side to the
// top right again, 0.7 wide; the stem then retraces that right side
// the same oval entered at its bottom by a connector from the baseline (see ovals.js)
const OVAL_B = [[0.44, 0.02], [0.55, 0.02], [0.72, 0.18], [0.78, 0.45], [0.78, 0.92], [0.6, 1.0], [0.36, 0.95], [0.16, 0.76], [0.08, 0.5], [0.14, 0.22], [0.32, 0.03], [0.44, 0.02], [0.55, 0.02], [0.72, 0.18], [0.78, 0.45], [0.78, 0.92]];
const OVAL = [[0.78, 0.45], [0.78, 0.92], [0.6, 1.0], [0.36, 0.95], [0.16, 0.76], [0.08, 0.5], [0.14, 0.22], [0.32, 0.03], [0.55, 0.02], [0.72, 0.18], [0.78, 0.45], [0.78, 0.92]];

// the undercurve lead-in of i t u: flat off the baseline, steep at the top, up to a cusp at x-height above the stem at x
const LEAD_IN = (x) => [[0, 0], [x - 0.2, 0.22], [x - 0.08, 0.62], [x, 1.0]];

// a straight stem at x down to the baseline and its round bottom turning out to the right (as in u)
const STEM_BOTTOM = (x) => [[x, 0.12], [x + 0.03, 0.03], [x + 0.09, 0.0], [x + 0.16, 0.1]];

// a descender loop to the left of a stem at x: straight on through the baseline, round
// the bottom at -1, back up the left side to cross the stem exactly at the baseline
const LOOP_LEFT = (x) => [[x, 0.0], [x - 0.03, -0.5], [x - 0.12, -0.9], [x - 0.28, -1.03], [x - 0.43, -0.88], [x - 0.43, -0.55], [x - 0.26, -0.25], [x, 0.0]];

// the same loop to the right, rounder and returning flatter: the slant squeezes a loop on this side
const LOOP_RIGHT = (x) => [[x, 0.0], [x + 0.02, -0.5], [x + 0.1, -0.9], [x + 0.26, -1.03], [x + 0.41, -0.84], [x + 0.39, -0.5], [x + 0.22, -0.15], [x, 0.0]];

export const descenders = {
  // the oval; the stem straight down through the baseline; the loop to the left; the crossing; out
  g: { width: 1.0, exit: 'base', joinTarget: { base: 0, mid: 1 }, waypoints: [...OVAL, ...LOOP_LEFT(0.78), [1.0, 0.9]],
    variants: { base: { joinTarget: 0, waypoints: [...OVAL_B, ...LOOP_LEFT(0.78), [1.0, 0.9]] },
      mid: { joinTarget: 0, stops: [0], waypoints: [...OVAL.slice(1), ...LOOP_LEFT(0.78), [1.0, 0.9]] } } },
  // the oval; the stem down; the loop to the right; the crossing; out
  q: { width: 1.0, exit: 'base', joinTarget: { base: 0, mid: 1 }, waypoints: [...OVAL, ...LOOP_RIGHT(0.78), [1.0, 0.9]],
    variants: { base: { joinTarget: 0, waypoints: [...OVAL_B, ...LOOP_RIGHT(0.78), [1.0, 0.9]] },
      mid: { joinTarget: 0, stops: [0], waypoints: [...OVAL.slice(1), ...LOOP_RIGHT(0.78), [1.0, 0.9]] } } },
  // undercurve up to the cusp; straight down through the baseline; the loop to the left; the crossing; out. The dot above the stem.
  j: { width: 0.6, exit: 'base', joinTarget: 3, waypoints: [...LEAD_IN(0.36), [0.36, 0.5], ...LOOP_LEFT(0.36), [0.6, 0.9]], marks: [[[0.36, 1.45]]] },
  // undercurve up to the cusp; straight down to the descender; the stop; back up the same line past the baseline to
  // x-height; the bowl: out to the right, round and down, back to the stem at the baseline; the stop; the undercurve out
  p: { width: 1.0, exit: 'base', joinTarget: 3, waypoints: [...LEAD_IN(0.42), [0.41, 0.0], [0.4, -1.0], [0.41, 0.0], [0.44, 0.88], [0.62, 1.0], [0.84, 0.94], [0.98, 0.68], [0.98, 0.4], [0.92, 0.16], [0.78, 0.03], [0.6, 0.0], [0.44, 0.0], [0.64, 0.06], [1.0, 0.9]] },
  // a u (the same lead-in, stem, round bottom and second undercurve as the u of the arches group)
  // whose second stem runs on through the baseline into the loop to the left; the crossing; out
  y: { width: 1.0, exit: 'base', joinTarget: 3, waypoints: [...LEAD_IN(0.36), ...STEM_BOTTOM(0.36), [0.64, 0.45], [0.76, 0.82], [0.8, 1.0], ...LOOP_LEFT(0.8), [1.0, 0.9]] },
  // overcurve up over a round arch; the slant down to the right to the knot at the baseline: round to the left,
  // up, over and back down; the loop to the left at the descender, back up to cross at the knot; out
  // the arch; the slant down and to the LEFT to a knot at the bottom left; the descender hangs from the knot,
  // clear of the slant, so the knot shows and the z stays apart from g and y
  z: { width: 0.9, exit: 'base', joinTarget: 2, waypoints: [[0, 0], [0.1, 0.5], [0.16, 0.76], [0.23, 0.93], [0.38, 1.0], [0.53, 0.93], [0.6, 0.78], [0.56, 0.45], [0.46, 0.14], [0.4, 0.04], [0.32, 0.0], [0.26, 0.08], [0.3, 0.18], [0.44, 0.2], [0.52, 0.12], [0.56, -0.2], [0.54, -0.6], [0.44, -0.95], [0.3, -1.03], [0.18, -0.85], [0.2, -0.5], [0.38, -0.15], [0.6, 0.06], [0.9, 0.9]] },
};
