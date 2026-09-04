/**
 * Hand-refined letters, group "ovals": dense waypoints in the pen model's
 * letter frame (baseline 0, x-height 1, x in x-heights), each entry
 * { width, exit?, waypoints, marks? }. See ../hand-letters.js for the format
 * and the rules; an entry here overrides the derived letter of the same name.
 *
 * All four are authored upright and drawn counter-clockwise from the top
 * right, where a join lands. The a and d share one oval: round on the left,
 * the top and the bottom, its right side the straight line of the stem, which
 * is retraced (the up-stroke and the stem lie on one vertical, x = 0.78 /
 * 0.80). Every stem foot turns through more than 149 degrees into the exit,
 * so the model stops the pen there (a cusp) instead of rounding the corner
 * into a blob.
 *
 * The first stroke of a letter always overlaps the join heavily (its gap is
 * fixed by the composer), so an oval that turned left straight off its start
 * lost its top-right corner to the join. Each letter therefore lands a little
 * short of the corner and runs a tiny first stroke up along the join's own
 * direction; the corner itself is waypoint 1, whose gap follows the real
 * turn. On a and d that tick lies on the stem line and is retraced by it.
 */

// the a/d oval: a short tick up the stem line to the top right; over the
// top, down the left, round the bottom, up the straight right side to the top
// right again
// the same oval entered at its bottom by a connector from the baseline: along the
// bottom, up the right side, over the top, down the left, along the bottom to the
// entry, then up the right side once more (a hairline over a hairline) to the top
const A_OVAL_B = (r) => [
  [r - 0.35, 0.02], [r - 0.23, 0.02], [r - 0.06, 0.18], [r, 0.45], [r, 0.84], [r, 0.92], [r - 0.18, 1.0], [r - 0.42, 0.95], [r - 0.62, 0.76], [r - 0.7, 0.5],
  [r - 0.64, 0.22], [r - 0.46, 0.03], [r - 0.35, 0.02], [r - 0.23, 0.02], [r - 0.06, 0.18], [r, 0.45], [r, 0.92],
];

const A_OVAL = (r) => [
  [r, 0.45], [r, 0.84], [r, 0.92], [r - 0.18, 1.0], [r - 0.42, 0.95], [r - 0.62, 0.76], [r - 0.7, 0.5],
  [r - 0.64, 0.22], [r - 0.46, 0.03], [r - 0.23, 0.02], [r - 0.06, 0.18], [r, 0.45], [r, 0.92],
];

export const ovals = {
  // the oval; a stop at the top; the stem down its right side to the
  // baseline; a stop; the undercurve out
  a: { width: 0.9, exit: 'base', joinTarget: { base: 0, mid: 2 }, waypoints: [...A_OVAL(0.78), [0.78, 0], [0.84, 0.12], [0.9, 0.9]],
    variants: {
      base: { joinTarget: 0, waypoints: [...A_OVAL_B(0.78), [0.78, 0], [0.84, 0.12], [0.9, 0.9]] },
      // a bridge from a checkstroke lands on the top right, where the pen halts and turns back over the oval
      mid: { joinTarget: 0, stops: [0], waypoints: [...A_OVAL(0.78).slice(2), [0.78, 0], [0.84, 0.12], [0.9, 0.9]] },
    } },
  // the hook: landing a little below and inside the top right, curling up and
  // over to the left; the open oval down the left and round the bottom; out.
  // The point before the exit stays low so a join to a letter entered from
  // the baseline does not sag
  c: { width: 0.85, exit: 'base', waypoints: [[0.66, 0.84], [0.72, 0.91], [0.64, 0.99], [0.45, 1.0], [0.22, 0.9], [0.08, 0.64], [0.08, 0.36], [0.2, 0.1], [0.42, 0], [0.64, 0.08], [0.74, 0.17], [0.85, 0.9]] },
  // the oval; straight on up the same line to the ascender, a stop, straight
  // back down to the baseline; a stop; the undercurve out
  d: { width: 1.0, exit: 'base', joinTarget: { base: 0, mid: 2 }, waypoints: [...A_OVAL(0.8).slice(0, -1), [0.8, 1.9], [0.8, 0], [0.87, 0.14], [1.0, 0.9]],
    variants: {
      base: { joinTarget: 0, waypoints: [...A_OVAL_B(0.8).slice(0, -1), [0.8, 1.9], [0.8, 0], [0.87, 0.14], [1.0, 0.9]] },
      mid: { joinTarget: 0, stops: [0], waypoints: [...A_OVAL(0.8).slice(2, -1), [0.8, 1.9], [0.8, 0], [0.87, 0.14], [1.0, 0.9]] },
    } },
  // the closed oval, round, entered on its right side a little below the top
  // right; back up the right side and over the top to close on the start; the
  // checkstroke: right and down to 0.85 and out (a turn of 147 degrees at the
  // closure: just short of a cusp, so the top stays a small round loop)
  // the oval closes with a stop at the top rather than a small loop, then the check out
  o: { width: 0.9, exit: 'mid', joinTarget: { base: 0, mid: 2 }, stops: [13], waypoints: [[0.74, 0.45], [0.72, 0.74], [0.66, 0.86], [0.44, 1.0], [0.22, 0.9], [0.09, 0.66], [0.08, 0.38], [0.19, 0.13], [0.4, 0.02], [0.6, 0.07], [0.74, 0.3], [0.76, 0.58], [0.68, 0.9], [0.62, 0.97], [0.7, 0.92], [0.84, 0.9]],
    // from the baseline the o is entered at its bottom: round once counter-clockwise, then up the right side again to the check
    variants: {
      base: { joinTarget: 0, stops: [16], waypoints: [[0.4, 0.02], [0.6, 0.035], [0.74, 0.3], [0.76, 0.58], [0.72, 0.8], [0.6, 0.95], [0.44, 1.0], [0.22, 0.9], [0.09, 0.66], [0.08, 0.38], [0.19, 0.13], [0.4, 0.02], [0.6, 0.07], [0.74, 0.3], [0.76, 0.58], [0.68, 0.9], [0.62, 0.97], [0.7, 0.92], [0.84, 0.9]] },
      mid: { joinTarget: 0, stops: [0, 11], waypoints: [[0.66, 0.86], [0.44, 1.0], [0.22, 0.9], [0.09, 0.66], [0.08, 0.38], [0.19, 0.13], [0.4, 0.02], [0.6, 0.07], [0.74, 0.3], [0.76, 0.58], [0.68, 0.9], [0.62, 0.97], [0.7, 0.92], [0.84, 0.9]] },
    } },
};
