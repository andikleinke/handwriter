/**
 * Per-font, per-glyph store for recovered stroke records.
 *
 * Records carry a `source` field ("heuristic", or "manual" once a hand has
 * edited the glyph), so a correction pass can overwrite individual entries
 * without any rendering code knowing that anything changed.
 *
 * The two sources are kept apart on disk, because they are worth different
 * things. A heuristic record is an optimisation: it is derived from the code,
 * so a new `RECORD_VERSION` makes it stale and it is thrown away. A manual
 * record is *work the user did*, so it survives a version bump and a "clear
 * the cache", and only reverting that glyph removes it. It carries the
 * version it was made under, so a reader can tell what may be missing from
 * it (`analyzeWord` refills the per-point widths of an older one).
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
    const { fonts, manual } = this.#load();
    this.disk = fonts;
    this.manual = manual;
    if (persist && typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.#writeNow());
    }
  }

  #load() {
    if (!this.persist) return { fonts: {}, manual: {} };
    try {
      const raw = localStorage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        // heuristics are derived from the code: a new version makes them stale
        fonts: parsed.version === RECORD_VERSION ? parsed.fonts || {} : {},
        // hand-edited glyphs are not, and outlive every version
        manual: parsed.manual || {},
      };
    } catch {
      return { fonts: {}, manual: {} };
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
      localStorage.setItem(LS_KEY, JSON.stringify({ version: RECORD_VERSION, fonts: this.disk, manual: this.manual }));
    } catch {
      /* quota - the cache is an optimisation, never a requirement */
    }
  }

  get(fontKey, gid) {
    const k = `${fontKey}#${gid}`;
    if (this.mem.has(k)) { this.hits++; return this.mem.get(k); }
    // a hand-edited glyph wins over anything the heuristics left behind
    const rec = this.manual[fontKey]?.[gid] ?? this.disk[fontKey]?.[gid];
    if (rec) { this.hits++; this.mem.set(k, rec); return rec; }
    this.misses++;
    return null;
  }

  set(fontKey, gid, record) {
    this.mem.set(`${fontKey}#${gid}`, record);
    (this.disk[fontKey] ||= {})[gid] = record;
    this.#flush();
  }

  /**
   * A corrected glyph, kept apart from the heuristics: it survives a version
   * bump and `clear()`, and is stamped with the version it was made under.
   */
  override(fontKey, gid, record, source = 'manual') {
    const stored = { ...record, source, editedUnderVersion: RECORD_VERSION };
    this.mem.set(`${fontKey}#${gid}`, stored);
    (this.manual[fontKey] ||= {})[gid] = stored;
    this.#flush();
  }

  /** Is this glyph hand-edited? */
  isManual(fontKey, gid) {
    return !!this.manual[fontKey]?.[gid];
  }

  /** Every hand-edited glyph of a font, as {gid: record}. */
  manualOf(fontKey) {
    return { ...(this.manual[fontKey] || {}) };
  }

  /** Replace a font's hand-edited glyphs wholesale (importing a saved hand). */
  setManual(fontKey, records) {
    this.manual[fontKey] = { ...records };
    for (const gid of Object.keys(records)) this.mem.delete(`${fontKey}#${gid}`);
    this.#flush();
  }

  /** Drop one glyph's record, hand-edited or not, so the heuristics run again. */
  delete(fontKey, gid) {
    this.mem.delete(`${fontKey}#${gid}`);
    if (this.disk[fontKey]) delete this.disk[fontKey][gid];
    if (this.manual[fontKey]) delete this.manual[fontKey][gid];
    this.#flush();
  }

  /** Throw away the derived records. Hand-edited glyphs stay unless `alsoManual`. */
  clear({ alsoManual = false } = {}) {
    this.mem.clear();
    this.disk = {};
    if (alsoManual) this.manual = {};
    this.hits = 0;
    this.misses = 0;
    this.#flush();
  }

  stats() {
    const manual = Object.values(this.manual).reduce((n, f) => n + Object.keys(f).length, 0);
    return { hits: this.hits, misses: this.misses, fonts: Object.keys(this.disk).length, manual };
  }
}
