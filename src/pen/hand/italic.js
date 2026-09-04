/**
 * The italic hand's own lowercase, in two groups so that two authors can work
 * at once. Letters missing here fall back to the school hand's.
 */
import { italicAM } from './italic-am.js';
import { italicNZ } from './italic-nz.js';

export const italic = { ...italicAM, ...italicNZ };
