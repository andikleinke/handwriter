/**
 * The alphabet check, off the page.
 *
 * Letter Studio checks every letter of the alphabet against the pointed-pen
 * rules, and reaching a verdict is a full recovery of the glyph: a swash
 * capital takes seconds, during which a page doing it itself cannot
 * respond. So the recovery runs here, in a worker, with its own copy of
 * the font (HarfBuzz and opentype.js both load here), its own stroke store
 * (not persisted; the page keeps what it learns) and OffscreenCanvas in
 * place of the page's canvases. The page sends a letter and the record it
 * holds for that glyph, if any, and gets back the verdict and, for a glyph
 * recovered here, the record, so it never recovers that glyph again.
 */

// The handler goes in before anything is imported: HarfBuzz loads its wasm
// under a top-level await, and a message arriving while a static import
// graph is still being evaluated finds no handler and is dropped - the
// page's font message went that way, and the check never started.
const fonts = new Map(); // font id -> fontCtx
let queue = Promise.resolve();
const libs = Promise.all([
  import('../lib/shaping.js'),
  import('../lib/analyze.js'),
  import('../lib/fontCheck.js'),
  import('../lib/cache.js'),
]).then(([shaping, analyze, fontCheck, cache]) => ({
  loadFont: shaping.loadFont,
  analyzeWord: analyze.analyzeWord,
  checkAnalysis: fontCheck.checkAnalysis,
  fontKeyOf: cache.fontKeyOf,
  store: new cache.StrokeStore({ persist: false }),
}));

self.onmessage = (e) => {
  const m = e.data;
  queue = queue
    .then(() => handle(m))
    .catch((err) => self.postMessage({ type: 'error', id: m.id, message: err?.message || String(err) }));
};

async function handle(m) {
  const { loadFont, analyzeWord, checkAnalysis, fontKeyOf, store } = await libs;
  if (m.type === 'font') {
    fonts.set(m.font, await loadFont(m.bytes, m.name));
    self.postMessage({ type: 'font', id: m.id, font: m.font });
  } else if (m.type === 'forget') {
    fonts.delete(m.font);
  } else if (m.type === 'check') {
    const fontCtx = fonts.get(m.font);
    if (!fontCtx) throw new Error('the font is not loaded in the worker');
    const key = fontKeyOf(fontCtx);
    // the page's record for this glyph wins (hand-edited, bundled, or a
    // heuristic it already has); without one the glyph is recovered here
    if (m.gid) {
      store.delete(key, m.gid);
      if (m.record) store.override(key, m.gid, m.record, m.record.source || 'manual');
    }
    const a = analyzeWord(fontCtx, m.ch, store, { rasterEm: m.rasterEm, connect: false });
    const chk = checkAnalysis(a);
    const g = a.glyphs.find((gl) => gl.record);
    const fresh = g && !g.cached ? { gid: g.gid, record: g.record } : null;
    self.postMessage({ type: 'verdict', id: m.id, ch: m.ch, failures: chk.failures, strokes: chk.glyphs[0]?.strokes ?? 0, fresh });
  }
}
