/**
 * The looped school hand's letters, authored by eye as dense waypoints in
 * the pen model's letter frame (baseline 0, x-height 1, x in x-heights) and
 * kept in groups under hand/ (see hand/GUIDE.md). They go through the same
 * derivation as the taught alphabet (letters.js), so arcs, overlaps and
 * pressure follow the same rules; only the shapes are ours. Dense is the
 * point: the kinematic model cuts every corner it is given, and a loop drawn
 * as one long stroke loses half its height, while one drawn through five
 * waypoints keeps it.
 *
 * Later groups override earlier ones letter by letter; "small" has the last
 * word.
 */

import { ovals } from './hand/ovals.js';
import { arches } from './hand/arches.js';
import { loops } from './hand/loops.js';
import { descenders } from './hand/descenders.js';
import { capitalsAM } from './hand/capitals-am.js';
import { capitalsNZ } from './hand/capitals-nz.js';
import { small } from './hand/small.js';

export const HAND_WAYPOINTS = { ...ovals, ...arches, ...loops, ...descenders, ...capitalsAM, ...capitalsNZ, ...small };
