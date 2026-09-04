/**
 * Per-font, per-glyph store for recovered stroke records.
 *
 * This is the seam a later version plugs into: records carry a `source` field
 * ("heuristic" today, "ai" or "manual" later), so an AI-assisted correction
 * pass can overwrite individual glyph entries without any rendering code
 * knowing that anything changed.
 */

import { RECORD_VERSION } from './strokeRecovery.js';

const LS_KEY = 'handwriter.strokes.v1';

export function fontKeyOf(fontCtx) {
  return [
    fontCtx.familyName || fontCtx.sourceName,
    fontCtx.numGlyphs,
    fontCtx.unitsPerEm,
  ].join('|');
}

export class StrokeStore {
  constructor({ persist = true } = {}) {
    this.persist = persist;
    this.mem = new Map();
    this.hits = 0;
    this.misses = 0;
    this.flushTimer = 0;
    this.disk = this.#load();
    if (persist && typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.#writeNow());
    }
  }

  #load() {
    if (!this.persist) return {};
    try {
      const raw = localStorage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed.version === RECORD_VERSION ? parsed.fonts || {} : {};
    } catch {
      return {};
    }
  }

  /** Coalesce writes: one analysis sets a record per glyph in a tight loop. */
  #flush() {
    if (!this.persist || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = 0;
      this.#writeNow();
    }, 0);
  }

  #writeNow() {
    if (!this.persist) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ version: RECORD_VERSION, fonts: this.disk }));
    } catch {
      /* quota - the cache is an optimisation, never a requirement */
    }
  }

  get(fontKey, gid) {
    const k = `${fontKey}#${gid}`;
    if (this.mem.has(k)) { this.hits++; return this.mem.get(k); }
    const rec = this.disk[fontKey]?.[gid];
    if (rec) { this.hits++; this.mem.set(k, rec); return rec; }
    this.misses++;
    return null;
  }

  set(fontKey, gid, record) {
    this.mem.set(`${fontKey}#${gid}`, record);
    (this.disk[fontKey] ||= {})[gid] = record;
    this.#flush();
  }

  /** Point where an AI/manual correction would land. */
  override(fontKey, gid, record, source = 'manual') {
    this.set(fontKey, gid, { ...record, source });
  }

  /** Drop one glyph's record so the next analyze re-runs the heuristics. */
  delete(fontKey, gid) {
    this.mem.delete(`${fontKey}#${gid}`);
    if (this.disk[fontKey]) {
      delete this.disk[fontKey][gid];
      this.#flush();
    }
  }

  clear() {
    this.mem.clear();
    this.disk = {};
    this.hits = 0;
    this.misses = 0;
    this.#flush();
  }

  stats() {
    return { hits: this.hits, misses: this.misses, fonts: Object.keys(this.disk).length };
  }
}
