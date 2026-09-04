/**
 * A letter grammar for the pen model: each letter as the strokes a hand
 * makes, in a letter frame with the baseline at 0 and the x-height at 1
 * (ascenders near 2, descenders near -1), x in x-height units.
 *
 * A letter is a list of targets. The first is where the pen lands; each
 * further one ends a stroke: [x, y, arc, gap, pressure] - the stroke turns
 * through `arc` radians on the way (counter-clockwise positive), starts
 * `gap` of the previous stroke's duration after it (1 = no overlap, a sharp
 * corner; 0.4 = strong overlap, a rounded one), and is written with
 * `pressure` 0 (hairline) .. 1 (full shade). The last target is the exit
 * stroke, provisional: when the letter joins the next, that stroke is aimed
 * at the next letter's join target instead. `joinTarget` is the index of the
 * target a join lands on - the top of the lead-in for letters entered from
 * the baseline (whose own lead-in is then dropped), the start point for an
 * oval entered at the top right. `exit` is where the exit stroke leaves from:
 * the baseline, or mid-height for the checkstroke letters (b o v w).
 *
 * Sequences follow the teaching literature (Zaner-Bloser stroke words,
 * Palmer, Spencerian): ascender loops counter-clockwise, ovals counter-
 * clockwise from the top right, shade on the downstrokes only.
 *
 * The alphabet is derived from the taught waypoints (letters.js) and then
 * overridden, letter by letter, by the hand-authored groups in hand/ (see
 * hand-letters.js and hand/GUIDE.md); the italic hand brings its own
 * lowercase from hand/italic.js.
 */

import { alphabet, letterFromWaypoints } from './letters.js';
import { HAND_WAYPOINTS } from './hand-letters.js';
import { italic } from './hand/italic.js';


const refined = Object.fromEntries(Object.entries(HAND_WAYPOINTS).map(([ch, spec]) => [ch, letterFromWaypoints(ch, spec)]));
export const LETTERS = { ...alphabet(), ...refined };

// the italic hand brings its own lowercase; what it lacks it borrows
const italicRefined = {};
for (const [ch, def] of Object.entries(italic)) italicRefined[ch] = letterFromWaypoints(ch, def);
export const ITALIC_LETTERS = { ...LETTERS, ...italicRefined };

/**
 * Hands. The letter grammar is the same; a hand is slant, tempo, nib and
 * pressure. Values follow the teaching literature: Zaner-Bloser slants about
 * 20-25° from the vertical; Palmer is unshaded and quick; Copperplate is
 * written at 55° from the baseline (35° from the vertical) with shade on the
 * downstrokes only, "slow and deliberate", hairlines quick; a broad edge at
 * 45° takes its thick and thin from the direction of travel.
 */
const BASE = {
  unitsPerEm: 1000,
  xHeight: 200,          // font units, so the page's layout code is reused as is
  spacing: 0.06,         // between letters, in x-heights
  skew: 0.1,             // lognormal asymmetry: peak early in the stroke
  lift: 0.16,            // seconds in the air between chains
  slowShade: 0,          // how much longer a fully shaded stroke takes
  variability: 0.5,      // 0 = a machine, 1 = a loose hand
  seed: 1,
};
export const STYLES = {
  school: { ...BASE, id: 'school', name: 'looped school hand', slant: 20, tempo: 0.1, nib: { type: 'pointed', wMin: 0.03, wMax: 0.15 } },
  palmer: { ...BASE, id: 'palmer', name: 'Palmer (unshaded, brisk)', slant: 25, tempo: 0.085, nib: { type: 'mono', wMin: 0.07, wMax: 0.07 } },
  copperplate: { ...BASE, id: 'copperplate', name: 'Copperplate (shaded, 55°)', slant: 35, tempo: 0.12, slowShade: 0.7, nib: { type: 'pointed', wMin: 0.03, wMax: 0.22 } },
  broad: { ...BASE, id: 'broad', name: 'broad-edge nib at 45°', slant: 10, tempo: 0.1, nib: { type: 'broad', wMin: 0.03, wMax: 0.17, angle: 45 } },
  italic: { ...BASE, id: 'italic', name: 'italic (loop-free, branching)', slant: 8, tempo: 0.09, spacing: 0.08, nib: { type: 'mono', wMin: 0.08, wMax: 0.08 }, letters: ITALIC_LETTERS },
};
export const DEFAULT_STYLE = STYLES.school;
