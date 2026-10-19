/**
 * UI wiring only. All analysis lives under src/lib, all drawing under
 * src/render.
 */

import autographyUrl from '../FONTFILE.otf?url';
import pinyonUrl from '../PinyonScript-Regular.ttf?url';
import msmadiUrl from '../MsMadi-Regular.ttf?url';
import { version } from '../package.json';
import versions from '../versions.json';
import { loadFont } from './lib/shaping.js';
import { fontStore } from './lib/fontStore.js';
import { analyzeWord, toJSON, rebuildPlan, refreshGlyphRecord } from './lib/analyze.js';
import { derivePath } from './lib/penPlan.js';
import { smoothThroughPoints } from './lib/geometry.js';
import { checkAnalysis } from './lib/fontCheck.js';
import {
  splitStroke,
  deleteStroke,
  addStroke,
  strokeFromDrawing,
  dragPoint,
  deletePoint,
  snapStrokeRange,
  refreshWidths, setPointWidth,
  strokeCurve, moveCurveHandle
} from './lib/edit.js';
import { StrokeStore } from './lib/cache.js';
import { RECORD_VERSION } from './lib/strokeRecovery.js';
import { renderDebugView, hitTestStroke } from './render/debugView.js';
import { Animator } from './render/animator.js';
import { CanvasRecorder } from './render/recorder.js';
import { downloadBlob } from './render/takes.js';
import { fontKeyOf } from './lib/cache.js';
import { renderInternals } from './render/internals.js';
import { strokeColor } from './render/layout.js';

const $ = (id) => document.getElementById(id);
const el = {
  text: $('text'),
  analyze: $('analyze'),
  fontfile: $('fontfile'),
  fontpick: $('fontpick'),
  fontremove: $('fontremove'),
  rasterEm: $('rasterEm'),
  outlines: $('outlines'),
  arrows: $('arrows'),
  numbers: $('numbers'),
  nodes: $('nodes'),
  internals: $('internals'),
  internalsview: $('internalsview'),
  connect: $('connect'),
  natural: $('natural'),
  clearcache: $('clearcache'),
  letterpanel: $('letterpanel'),
  letterstrip: $('letterstrip'),
  letterinfo: $('letterinfo'),
  handsave: $('handsave'),
  handfile: $('handfile'),
  fontinfo: $('fontinfo'),
  shapinginfo: $('shapinginfo'),
  debug: $('debug'),
  strokelist: $('strokelist'),
  edithint: $('edithint'),
  editcontrols: $('editcontrols'),
  editlabel: $('editlabel'),
  undoEdit: $('undoEdit'),
  redoEdit: $('redoEdit'),
  deletePoint: $('deletePoint'),
  moveEarlier: $('moveEarlier'),
  moveLater: $('moveLater'),
  reverseStroke: $('reverseStroke'),
  splitStroke: $('splitStroke'),
  deleteStroke: $('deleteStroke'),
  resetGlyph: $('resetGlyph'),
  deselect: $('deselect'),
  drawMode: $('drawMode'),
  placeMode: $('placeMode'),
  curveMode: $('curveMode'),
  snapInk: $('snapInk'),
  anim: $('anim'),
  playpause: $('playpause'),
  record: $('record'),
  takelink: $('takelink'),
  exportmovie: $('exportmovie'),
  movieformat: $('movieformat'),
  takeinfo: $('takeinfo'),
  speed: $('speed'),
  timecode: $('timecode'),
  speedval: $('speedval'),
  scrub: $('scrub'),
  showpen: $('showpen'),
  renderer: $('renderer'),
  loop: $('loop'),
  log: $('log'),
  logcount: $('logcount'),
  json: $('json'),
  copyjson: $('copyjson'),
  downloadjson: $('downloadjson'),
};

const store = new StrokeStore();
const animator = new Animator(el.anim);
window.__animator = animator; // handy from the console while tuning
animator.bottomInset = 48;  // the player controls sit over the bottom edge

/** The play button shows a state, not a word. */
const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.2v11.6L13.5 8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2" width="4" height="12" rx="1"/><rect x="9.5" y="2" width="4" height="12" rx="1"/></svg>',
  again: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8.6A5.4 5.4 0 1 1 8 2.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7.4 0.6l4 2-4 2z"/></svg>',
  record: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/></svg>',
};
// The buttons are re-labelled from the animation's progress callback, every
// frame while playing. Rewriting their markup that often swallowed clicks:
// the icon under the mouse at press time was gone by release, and the
// browser fires no click for a press and release on different elements. So
// the markup only changes when the state does.
let playState = null, recordState = null;
function setPlay(state) {
  const s = state === 'pause' ? 'pause' : state === 'again' ? 'again' : 'play';
  if (s === playState) return;
  playState = s;
  el.playpause.innerHTML = ICON[s];
  el.playpause.title = s === 'pause' ? 'pause' : s === 'again' ? 'play again' : 'play';
}
function setRecord(state, label) {
  const key = `${state}|${label}`;
  if (key === recordState) return;
  recordState = key;
  el.record.innerHTML = (state === 'stop' ? ICON.stop : ICON.record) + `<span>${label}</span>`;
}
const fmtSeconds = (t) => t.toFixed(1);
const recorder = new CanvasRecorder(el.anim);
let finishingRecording = false;
let takeUrl = null; // object URL of the last finished take

/** Forget the last take: it belongs to text or strokes that are gone. */
function clearTake() {
  if (takeUrl) {
    URL.revokeObjectURL(takeUrl);
    takeUrl = null;
  }
  el.takelink.hidden = true;
  el.takelink.removeAttribute('href');
  el.takeinfo.textContent = '';
}
let fontCtx = null;
let analysis = null;
let scrubbing = false;
let selection = null; // {glyphIndex, strokeIndex, pointIndex?} of the stroke being edited
let debugLayout = null;
let drawModeOn = false;
let placeModeOn = false; // a new path from clicked key points, a smooth curve through them
let placing = null;      // {pts: [[cssX, cssY], ...]} while points are being placed
const view = { zoom: 1, panX: 0, panY: 0 }; // debug view only; the animation stays fitted
let pan = null;         // {last} while the view is being dragged
let drawing = null;     // {pts: [[cssX, cssY], ...]} while a path is being drawn
let drag = null;        // {pointIndex, base, lo, hi} while a vertex is being dragged
let selectedPoint = null; // index of the highlighted point of the selected stroke
let curveModeOn = false;  // the selected stroke is edited by Bézier anchors and handles
let selectedHandle = null; // {anchor, which} last picked in curve mode
let pointerDown = null; // {at, moved} to tell a click from a drag

animator.onProgress = (f, playing) => {
  if (!scrubbing) {
    el.scrub.value = String(Math.round(f * 1000));
    el.scrub.style.setProperty('--p', `${(f * 100).toFixed(2)}%`);
  }
  el.timecode.textContent = `${fmtSeconds(f * animator.duration)} / ${fmtSeconds(animator.duration)} s`;
  setPlay(playing ? 'pause' : f >= 1 ? 'again' : 'play');
  if (recorder.recording && !finishingRecording && f >= 1) finishRecording();
};

/* ---------------------------------------------------------------- font --- */

// Adult cursive runs at roughly 11 x-heights per second (Thomassen &
// Meulenbroek 1993), so the default average speed follows the font's x-height.
const X_HEIGHTS_PER_SECOND = 11;

let fontBytes = null;   // the font file, for the alphabet check's worker
async function useFont(arrayBuffer, name) {
  fontCtx = await loadFont(arrayBuffer, name);
  fontBytes = arrayBuffer;
  fontCtx.surveyFont = `f${++surveyFontSeq}`;
  fontCtx.sourceLabel = name;
  const xh = fontCtx.xHeight / fontCtx.unitsPerEm;
  const defaultSpeed = Math.min(4, Math.max(0.3, Math.round(X_HEIGHTS_PER_SECOND * xh * 10) / 10));
  el.speed.value = String(defaultSpeed);
  el.speedval.textContent = defaultSpeed.toFixed(1);
  el.fontinfo.innerHTML = [
    `<code>${escapeHtml(name)}</code>`,
    `${fontCtx.familyName}`,
    `${fontCtx.numGlyphs} glyphs`,
    `${fontCtx.unitsPerEm} upem`,
    `x-height ${Math.round(xh * 100)}% em`,
    `GSUB: ${fontCtx.gsubFeatures.join(', ') || 'none'}`,
    `HarfBuzz ${fontCtx.harfbuzzVersion}`,
  ].join(' · ');
}

/**
 * The hand shipped with a bundled face (public/hands/*.hand.json, a file the
 * Letter Studio saves): its letters become every user's starting point for
 * that face, under their own edits. Saved under a face's family name, it is
 * ignored on any other.
 */
async function loadBundledHand(path) {
  if (!fontCtx) return;
  const key = fontKeyOf(fontCtx);
  if (!path) { store.setBundled(key, {}); return; }
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const hand = await res.json();
    const family = fontCtx.familyName || fontCtx.sourceName;
    if (hand.format !== 'handwriter-hand' || hand.font?.family !== family || hand.font?.unitsPerEm !== fontCtx.unitsPerEm) {
      store.setBundled(key, {});
      return;
    }
    const records = {};
    for (const [ch, record] of Object.entries(hand.letters || {})) {
      const gid = fontCtx.ot?.charToGlyphIndex(ch) ?? 0;
      if (gid && record?.strokes?.length) records[gid] = { ...record, gid, source: 'bundled' };
    }
    store.setBundled(key, records);
  } catch (err) {
    console.warn('bundled hand not loaded', err);
    store.setBundled(key, {});
  }
}

/* ---------------------------------------------------------- font picker -- */

// Fonts shipped with the page. Pinyon Script (SIL OFL) is the default: a
// formal Copperplate whose lowercase connects by design, every exit hairline
// ending at the same height and overlapping the next letter's entry.
const BUNDLED = {
  pinyon: { url: pinyonUrl, file: 'PinyonScript-Regular.ttf', label: 'Pinyon Script (default)' },
  autography: { url: autographyUrl, file: 'FONTFILE.otf', label: 'Autography', hand: 'hands/autography.hand.json' },
  msmadi: { url: msmadiUrl, file: 'MsMadi-Regular.ttf', label: 'Ms Madi' },
};
const DEFAULT_FONT = 'pinyon';
// Older pages stored the one bundled face as 'default', which meant "I never
// picked one" - so it follows the current default rather than pinning to the
// face that used to hold that slot.
const fontId = (id) => (id === 'default' ? DEFAULT_FONT : id);

/** Offer the bundled fonts first, then every saved one; keep the current choice selected. */
async function refreshFontPicker(selectedId) {
  const saved = await fontStore.list();
  el.fontpick.innerHTML = '';
  const opt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; el.fontpick.appendChild(o); };
  for (const [id, b] of Object.entries(BUNDLED)) opt(id, b.label);
  for (const f of saved) opt(f.id, f.family && f.family !== f.name ? `${f.family} · ${f.name}` : f.name);
  const want = fontId(selectedId ?? fontStore.choice);
  el.fontpick.value = BUNDLED[want] || saved.some((f) => f.id === want) ? want : DEFAULT_FONT;
  el.fontremove.hidden = !!BUNDLED[el.fontpick.value];
}

/** Load the picked font (bundled, or from the browser's store) and analyse the text with it. */
async function pickFont(id) {
  id = fontId(id);
  try {
    if (BUNDLED[id]) {
      const res = await fetch(BUNDLED[id].url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await useFont(await res.arrayBuffer(), BUNDLED[id].file);
    } else {
      const bytes = await fontStore.bytes(id);
      if (!bytes) throw new Error('that font is no longer stored');
      const meta = (await fontStore.list()).find((f) => f.id === id);
      await useFont(bytes, meta?.name || 'font');
    }
    fontStore.choice = id;
    el.fontremove.hidden = !!BUNDLED[id];
    await loadBundledHand(BUNDLED[id]?.hand);
    await run();
    refreshStudio();
  } catch (err) {
    console.error(err);
    el.fontinfo.innerHTML = `<span class="err">Could not load the font: ${escapeHtml(String(err))}</span>`;
  }
}

(async () => {
  await refreshFontPicker();
  await pickFont(el.fontpick.value);
})();

el.fontpick.addEventListener('change', () => pickFont(el.fontpick.value));

el.fontfile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const bytes = await file.arrayBuffer();
    // load it first, so a broken file is refused before it is stored
    await useFont(bytes, file.name);
    const id = await fontStore.add(file.name, fontCtx.familyName || '', bytes);
    await refreshFontPicker(id);
    fontStore.choice = id;
    el.fontremove.hidden = false;
    await run();
    refreshStudio();
  } catch (err) {
    console.error(err);
    el.fontinfo.innerHTML = `<span class="err">${escapeHtml(String(err))}</span>`;
  } finally {
    e.target.value = '';
  }
});

el.fontremove.addEventListener('click', async () => {
  const id = el.fontpick.value;
  if (BUNDLED[id]) return;
  const name = el.fontpick.selectedOptions[0]?.textContent || 'this font';
  if (!confirm(`Forget ${name}? Its stroke cache stays until you clear it.`)) return;
  await fontStore.remove(id);
  await refreshFontPicker(DEFAULT_FONT);
  await pickFont(DEFAULT_FONT);
});

/* ---------------------------------------------------------- letter mode -- */

/*
 * Correcting a hand letter by letter.
 *
 * A pen path belongs to a glyph, not to a word: fixing the `z` once fixes it
 * in every word that uses it. So the strip below the debug view walks the
 * alphabet - click a letter and the view shows that letter alone, large,
 * with its pen order and every editing control that a word gives; the edit is
 * stored against the glyph and applies everywhere.
 *
 * A chip is marked when the letter is hand-edited, and outlined when the
 * invariant check (fontCheck.js) has something to say about it, so the letters
 * still worth looking at are visible at a glance. Those verdicts are computed
 * one letter at a time in the background, because the first analysis of a
 * glyph is a full recovery; a later pass reads them from the store.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
// what the last save or load did; kept beside the survey's own line so a
// background check finishing cannot swallow the answer to a button press
let letterNote = '';
let letterNoteError = false;
function sayLetters(line, note = letterNote, error = letterNoteError) {
  letterNote = note;
  letterNoteError = note ? error : false;
  const parts = [];
  if (note) parts.push(error ? `<span class="err">${escapeHtml(note)}</span>` : escapeHtml(note));
  if (line) parts.push(escapeHtml(line));
  el.letterinfo.innerHTML = parts.join(' · ');
}
let letterMode = null;            // the letter being edited on its own, or null
let surveyGeneration = 0;         // bumped to abandon a survey in flight
const letterVerdicts = new Map(); // `${fontKey}|${letter}` -> {failures, strokes}

/*
 * A verdict is kept across sessions, since reaching it is a full recovery
 * of the glyph (about a second for a swash capital, with the page frozen
 * meanwhile), and it only changes when the record does: the heuristic
 * record with the recovery's version and the raster size, a corrected
 * record with its own contents.
 */
const VERDICT_STORE = 'handwriter.verdicts';
const CHECK_VERSION = 1; // bump when fontCheck.js changes what it reports
let verdictCache = null;
function loadVerdictCache() {
  if (verdictCache) return verdictCache;
  try { verdictCache = JSON.parse(localStorage.getItem(VERDICT_STORE) || '{}'); } catch { verdictCache = {}; }
  return verdictCache;
}
let verdictSaveTimer = 0;
function saveVerdictCache() {
  clearTimeout(verdictSaveTimer);
  verdictSaveTimer = setTimeout(() => {
    try { localStorage.setItem(VERDICT_STORE, JSON.stringify(verdictCache)); } catch { /* storage may be off or full */ }
  }, 500);
}
function hashText(t) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
/** What a letter's verdict depends on; the verdict is stale when this changes. */
function verdictStamp(key, ch, rasterEm) {
  const gid = fontCtx.ot?.charToGlyphIndex(ch) ?? 0;
  const own = store.isManual(key, gid) || store.isBundled(key, gid) ? hashText(JSON.stringify(store.get(key, gid))) : 'auto';
  return `${CHECK_VERSION}|${RECORD_VERSION}|${rasterEm}|${own}`;
}
function rememberVerdict(key, ch, rasterEm, v) {
  letterVerdicts.set(`${key}|${ch}`, v);
  const cache = loadVerdictCache();
  (cache[key] ||= {})[ch] = { stamp: verdictStamp(key, ch, rasterEm), ...v };
  saveVerdictCache();
}
function recallVerdict(key, ch, rasterEm) {
  const hit = loadVerdictCache()[key]?.[ch];
  if (!hit || hit.stamp !== verdictStamp(key, ch, rasterEm)) return null;
  return { failures: hit.failures, strokes: hit.strokes };
}

/** The chip's look for one letter: its classes and the tooltip. */
function chipState(key, ch) {
  const gid = fontCtx.ot?.charToGlyphIndex(ch) ?? 0;
  if (!gid) return null;
  const edited = store.isManual(key, gid);
  const bundled = !edited && store.isBundled(key, gid);
  const v = letterVerdicts.get(`${key}|${ch}`);
  const cls = ['lchip'];
  if (ch === letterMode) cls.push('sel');
  if (edited) cls.push('edited');
  if (bundled) cls.push('bundled');
  if (!v) cls.push('pending');
  else if (v.failures.length) cls.push('bad');
  const title = [
    edited ? 'hand-edited' : bundled ? 'corrected in the bundled hand' : 'as recovered',
    v ? `${v.strokes} stroke${v.strokes === 1 ? '' : 's'}` : 'not checked yet',
    ...(v?.failures ?? []),
  ].join(' · ');
  return { cls: cls.join(' '), title };
}

/**
 * The strip is built once per font and its chips are then updated in
 * place: rebuilding it while the survey runs replaced the button under the
 * pointer between pointerdown and pointerup, and the click went nowhere.
 */
function paintLetterStrip() {
  if (el.letterpanel.hidden || !fontCtx) return;
  const key = fontKeyOf(fontCtx);
  if (el.letterstrip.dataset.key !== key) {
    el.letterstrip.dataset.key = key;
    el.letterstrip.innerHTML = [...LETTERS]
      .map((ch) => (chipState(key, ch) ? `<button class="lchip" data-ch="${ch}">${ch}</button>` : ''))
      .join('');
  }
  for (const ch of LETTERS) paintChip(ch, key);
}
function paintChip(ch, key = fontKeyOf(fontCtx)) {
  const b = el.letterstrip.querySelector(`button[data-ch="${ch}"]`);
  if (!b) return;
  const st = chipState(key, ch);
  if (!st) return;
  if (b.className !== st.cls) b.className = st.cls;
  if (b.title !== st.title) b.title = st.title;
}

/** Re-check one letter after it was edited, so its chip tells the truth again. */
function refreshLetterVerdict(ch) {
  if (!fontCtx || !ch || ch.length !== 1 || !LETTERS.includes(ch)) return;
  const k = `${fontKeyOf(fontCtx)}|${ch}`;
  letterVerdicts.delete(k);
  if (el.letterpanel.hidden) return;
  const rasterEm = clampInt(el.rasterEm.value, 128, 1024, 512);
  try {
    const a = analyzeWord(fontCtx, ch, store, { rasterEm, connect: false });
    const chk = checkAnalysis(a);
    rememberVerdict(fontKeyOf(fontCtx), ch, rasterEm, { failures: chk.failures, strokes: chk.glyphs[0]?.strokes ?? 0 });
  } catch (err) {
    console.error(err);
  }
  paintChip(ch);
}

// The survey waits while the user is at the page: a pointer down in the
// workbench, a key, a letter open for editing. Each letter's recovery is
// synchronous and freezes the page for up to a second, so it is only run
// when the browser reports idle time and nothing has happened for a moment.
let userBusyUntil = 0;
const noteUserActivity = () => { userBusyUntil = performance.now() + 600; };
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel']) document.addEventListener(ev, noteUserActivity, { passive: true, capture: true });
const whenIdle = () => new Promise((resolve) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 400 });
  else setTimeout(resolve, 16);
});
async function surveyPause(gen) {
  for (;;) {
    await whenIdle();
    if (gen !== surveyGeneration) return false;
    if (!letterMode && performance.now() >= userBusyUntil && !document.hidden) return true;
    await new Promise((r) => setTimeout(r, 250));
    if (gen !== surveyGeneration) return false;
  }
}
function paintSurveyProgress(done, total) {
  const pct = Math.round((100 * done) / total);
  sayLetters(`checking the alphabet… ${done}/${total}`);
  let bar = el.letterinfo.querySelector('.survey');
  if (!bar) {
    bar = document.createElement('span');
    bar.className = 'survey';
    bar.innerHTML = '<i></i>';
    bar.title = 'each letter not checked before is recovered once and its verdict kept; the check waits while you work';
    el.letterinfo.appendChild(bar);
  }
  bar.firstChild.style.width = `${pct}%`;
}

/*
 * The check runs in a worker (src/workers/survey.worker.js): a letter's
 * recovery is seconds of work on a swash capital, and the page stays
 * responsive while the worker does it. The worker gets the font file once
 * per font, then one letter at a time with the page's record for that
 * glyph; a glyph it recovers comes back and goes into the page's store.
 * Without a worker (an old browser, a failed load) the page checks the
 * letters itself in idle time, as before.
 */
let surveyFontSeq = 0;
let surveyWorker = null, surveyWorkerBroken = false, surveyReq = 0;
const surveyWaiting = new Map(); // request id -> {resolve, reject}
const surveyFontsSent = new Map(); // font id -> Promise<boolean>
function getSurveyWorker() {
  if (surveyWorker || surveyWorkerBroken) return surveyWorker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') { surveyWorkerBroken = true; return null; }
  try {
    surveyWorker = new Worker(new URL('./workers/survey.worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.error(err);
    surveyWorkerBroken = true;
    return null;
  }
  surveyWorker.onmessage = (e) => {
    const m = e.data;
    const w = surveyWaiting.get(m.id);
    if (!w) return;
    surveyWaiting.delete(m.id);
    if (m.type === 'error') w.reject(new Error(m.message)); else w.resolve(m);
  };
  surveyWorker.onerror = (e) => {
    console.error('alphabet check worker failed', e.message || e);
    surveyWorkerBroken = true;
    for (const w of surveyWaiting.values()) w.reject(new Error('worker failed'));
    surveyWaiting.clear();
    surveyFontsSent.clear();
    surveyWorker.terminate();
    surveyWorker = null;
  };
  return surveyWorker;
}
function askSurveyWorker(msg, transfer = []) {
  const wk = getSurveyWorker();
  if (!wk) return Promise.reject(new Error('no worker'));
  const id = ++surveyReq;
  return new Promise((resolve, reject) => {
    surveyWaiting.set(id, { resolve, reject });
    wk.postMessage({ ...msg, id }, transfer);
  });
}
/** The current font loaded in the worker; false when the worker cannot be used. */
function ensureSurveyFont() {
  const fc = fontCtx;
  if (!fc || !fontBytes || !getSurveyWorker()) return Promise.resolve(false);
  let p = surveyFontsSent.get(fc.surveyFont);
  if (!p) {
    const bytes = fontBytes.slice(0);
    p = askSurveyWorker({ type: 'font', font: fc.surveyFont, bytes, name: fc.sourceLabel }, [bytes])
      .then(() => true)
      .catch((err) => { console.error(err); surveyFontsSent.delete(fc.surveyFont); return false; });
    surveyFontsSent.set(fc.surveyFont, p);
    // fonts the page has moved on from are dropped in the worker
    for (const [font] of surveyFontsSent) if (font !== fc.surveyFont) { surveyFontsSent.delete(font); surveyWorker?.postMessage({ type: 'forget', font }); }
  }
  return p;
}
/** One letter's verdict from the worker; a glyph recovered there is kept here too. */
async function checkLetterInWorker(key, ch, rasterEm) {
  const gid = fontCtx.ot?.charToGlyphIndex(ch) ?? 0;
  const record = gid ? store.get(key, gid) : null;
  const m = await askSurveyWorker({ type: 'check', font: fontCtx.surveyFont, ch, gid, record, rasterEm });
  if (m.fresh && fontCtx && fontKeyOf(fontCtx) === key && !store.get(key, m.fresh.gid)) store.set(key, m.fresh.gid, m.fresh.record);
  return { failures: m.failures, strokes: m.strokes };
}

/** Check every letter in the background, newest verdict first onto the strip. */
async function surveyLetters() {
  const gen = ++surveyGeneration;
  const key = fontKeyOf(fontCtx);
  const opts = { rasterEm: clampInt(el.rasterEm.value, 128, 1024, 512), connect: false };
  let done = 0, bad = 0;
  // verdicts kept from an earlier session come back at once
  for (const ch of LETTERS) {
    const k = `${key}|${ch}`;
    if (letterVerdicts.has(k)) continue;
    const kept = recallVerdict(key, ch, opts.rasterEm);
    if (kept) { letterVerdicts.set(k, kept); paintChip(ch, key); }
  }
  const todo = [...LETTERS].filter((ch) => !letterVerdicts.has(`${key}|${ch}`));
  if (todo.length) paintSurveyProgress(LETTERS.length - todo.length, LETTERS.length);
  const inWorker = todo.length ? await ensureSurveyFont() : false;
  if (gen !== surveyGeneration || !fontCtx) return;
  for (const ch of LETTERS) {
    if (gen !== surveyGeneration || !fontCtx) return;
    const k = `${key}|${ch}`;
    if (!letterVerdicts.has(k)) {
      try {
        let v;
        if (inWorker) {
          v = await checkLetterInWorker(key, ch, opts.rasterEm);
          if (gen !== surveyGeneration || !fontCtx) return;
        } else {
          // the recovery is synchronous here: wait for idle time and a quiet user
          if (!(await surveyPause(gen)) || !fontCtx) return;
          const a = analyzeWord(fontCtx, ch, store, opts);
          const chk = checkAnalysis(a);
          v = { failures: chk.failures, strokes: chk.glyphs[0]?.strokes ?? 0 };
        }
        rememberVerdict(key, ch, opts.rasterEm, v);
      } catch (err) {
        console.error(err);
        if (gen !== surveyGeneration) return;
        letterVerdicts.set(k, { failures: [], strokes: 0 });
      }
      paintChip(ch, key);
    }
    done++;
    if (letterVerdicts.get(k)?.failures.length) bad++;
    if (todo.length) paintSurveyProgress(done, LETTERS.length);
  }
  sayLetters(bad
    ? `${bad} of ${LETTERS.length} letters have something to answer for - click one to see and correct it`
    : `all ${LETTERS.length} letters pass the pen checks - click one to look at it anyway`);
}

/*
 * Saving a corrected hand.
 *
 * The browser's store is the working copy; this is the keepsake. Letters are
 * keyed by character rather than glyph id, so a hand still loads onto another
 * copy of the same face (a reinstall, another machine) where the ids may
 * differ. Coordinates are font units, so the file only means anything for a
 * face with the same units per em - that is refused rather than silently
 * misplacing every stroke - and a different family is a question, not a
 * refusal, since a hand corrected on one weight is a reasonable start for
 * another.
 */

const HAND_FORMAT = 'handwriter-hand';

function handToJSON() {
  const key = fontKeyOf(fontCtx);
  const letters = {};
  for (const ch of LETTERS) {
    const gid = fontCtx.ot?.charToGlyphIndex(ch) ?? 0;
    if (gid && store.isManual(key, gid)) letters[ch] = store.get(key, gid);
  }
  return {
    format: HAND_FORMAT,
    version: 1,
    recordVersion: RECORD_VERSION,
    saved: new Date().toISOString(),
    font: {
      family: fontCtx.familyName || fontCtx.sourceName,
      unitsPerEm: fontCtx.unitsPerEm,
      numGlyphs: fontCtx.numGlyphs,
      key,
    },
    letters,
  };
}

el.handsave.addEventListener('click', () => {
  if (!fontCtx) return;
  const hand = handToJSON();
  const n = Object.keys(hand.letters).length;
  if (!n) {
    sayLetters('', 'nothing to save yet - no letter of this font has been edited by hand', false);
    return;
  }
  const name = `${(hand.font.family || 'hand').replace(/[^\w.-]+/g, '-')}-hand.json`;
  downloadBlob(new Blob([JSON.stringify(hand, null, 2)], { type: 'application/json' }), name);
  sayLetters('', `saved ${n} hand-edited ${n === 1 ? 'letter' : 'letters'} to ${name}`, false);
});

el.handfile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !fontCtx) return;
  try {
    const hand = JSON.parse(await file.text());
    if (hand.format !== HAND_FORMAT || !hand.letters) throw new Error('not a saved hand');
    if (hand.font?.unitsPerEm !== fontCtx.unitsPerEm) {
      throw new Error(`saved at ${hand.font?.unitsPerEm} units per em, this font uses ${fontCtx.unitsPerEm} - the strokes would not line up`);
    }
    const family = fontCtx.familyName || fontCtx.sourceName;
    if (hand.font?.family !== family
      && !confirm(`That hand was corrected on ${hand.font?.family}, and this is ${family}.\n\nLoad it anyway? The strokes will follow the letters they were drawn for, which may not match this face.`)) return;
    const key = fontKeyOf(fontCtx);
    const records = store.manualOf(key);
    let loaded = 0, skipped = [];
    for (const [ch, record] of Object.entries(hand.letters)) {
      const gid = fontCtx.ot?.charToGlyphIndex(ch) ?? 0;
      if (!gid || !record?.strokes?.length) { skipped.push(ch); continue; }
      // the record travels by character; its gid belongs to the font it lands in
      records[gid] = { ...record, gid, source: 'manual' };
      letterVerdicts.delete(`${key}|${ch}`);
      loaded++;
    }
    store.setManual(key, records);
    sayLetters('', `loaded ${loaded} ${loaded === 1 ? 'letter' : 'letters'}${
      skipped.length ? `; ${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} not in this font` : ''
    }`, false);
    await run();
    surveyLetters();
  } catch (err) {
    console.error(err);
    sayLetters('', `could not load that hand: ${err.message || String(err)}`, true);
  }
});

/** Show one letter on its own for editing, or `null` to go back to the text. */
function setLetterMode(ch) {
  letterMode = ch;
  el.text.title = ch ? 'showing a single letter (Letter Studio); type here or press Animate to write text again' : '';
  paintLetterStrip();
  run();
}

/** Typing text, or asking for it, ends the single-letter view without closing the panel. */
function leaveLetterMode() {
  if (!letterMode) return false;
  letterMode = null;
  el.text.title = '';
  paintLetterStrip();
  return true;
}

/* ------------------------------------------------------- the workbench -- */

// One workbench: the alphabet strip over the pen paths of the text, or of
// the one letter picked in the strip. Settings and diagnostics are under
// Advanced at the foot of the page, closed by default.
/** Paint the strip for the current font and start checking its letters. */
function refreshStudio() {
  if (!fontCtx) return;
  paintLetterStrip();
  surveyLetters();
}

el.letterstrip.addEventListener('click', (e) => {
  const ch = e.target.closest('button')?.dataset.ch;
  if (!ch) return;
  setLetterMode(ch === letterMode ? null : ch);
});

/* ------------------------------------------------------------- analysis -- */

/** Analyse the text field; resolves true once the new analysis is in place. */
function run() {
  if (!fontCtx) return Promise.resolve(false);
  const text = letterMode ?? (el.text.value ?? '').replace(/\s*\n\s*/g, ' ');
  if (!text.length) return Promise.resolve(false);
  selection = null;
  selectedPoint = null;
  drawing = null;
  drag = null;
  pointerDown = null;
  clearTake();
  document.body.classList.add('busy');

  // Yield once so the busy state paints before the synchronous crunch.
  // setTimeout rather than rAF: rAF is throttled to zero in a hidden tab.
  return new Promise((resolve) => {
    setTimeout(() => {
      let ok = false;
      try {
        analysis = analyzeWord(fontCtx, text, store, {
          rasterEm: clampInt(el.rasterEm.value, 128, 1024, 512),
          connect: el.connect.checked,
          loopGapEm: window.__loopGapEm, // console knob (scripts/inspect.js): 0 turns loop entries off
        });
        window.__analysis = analysis; // handy from the console while tuning
        window.__fontCheck = () => checkAnalysis(analysis); // invariant report (src/lib/fontCheck.js)
        window.__commitEdit = commitRecordEdit; // for scripts/inspect.js
        noteLoadedRecords();
        updateHistoryButtons();
        paintDebug();
        paintInternals();
        paintStrokeList();
        updateEditor();
        paintLog();
        paintJSON();
        loadAnimator();
        paintShapingInfo();
        paintLetterStrip();
        animator.play();
        ok = true;
      } catch (err) {
        console.error(err);
        el.shapinginfo.innerHTML = `<span class="err">${escapeHtml(String(err))}</span>`;
      } finally {
        document.body.classList.remove('busy');
        resolve(ok);
      }
    }, 0);
  });
}

function paintShapingInfo() {
  const s = analysis.shaping;
  const shaped = s.glyphs.map((g) => `${escapeHtml(g.name)}<span style="opacity:.5">/${g.gid}</span>`).join(' ');
  const differs =
    s.naiveGids.length !== s.glyphs.length ||
    s.glyphs.some((g, i) => g.gid !== s.naiveGids[i]);
  const strokes = analysis.penOrder.length;
  const bridges = analysis.plan.bridges.length;
  const cached = analysis.glyphs.filter((g) => g.cached).length;
  el.shapinginfo.innerHTML = [
    `shaped: ${shaped}`,
    differs
      ? `<b style="color:var(--accent)">shaping changed the run</b> (naive per-char would give ${s.naiveGids.length} glyphs: ${s.naiveGids.join(', ')})`
      : 'shaping matched a naive per-character lookup',
    `${strokes} strokes · ${bridges} bridge${bridges === 1 ? '' : 's'} · ${animator.duration.toFixed(
      1
    )} s · ${cached}/${analysis.glyphs.length} glyphs from cache · ${analysis.msElapsed} ms` +
      (animator.unreachedInk ? ` · ${animator.unreachedInk} px of ink no pass reaches (shown at the end)` : ''),
  ].join('<br>');
}

/** Push the current playback settings into the animator and (re)load it. */
function loadAnimator() {
  animator.speed = Number(el.speed.value);
  animator.model.natural = el.natural.checked;
  animator.loop = el.loop.checked;
  animator.showPen = el.showpen.checked;
  animator.load(analysis);
}

/** Order, lifts and bridges are derived data: recompute and repaint them. */
function replan() {
  if (!analysis) return;
  clearTake();
  rebuildPlan(analysis, { connect: el.connect.checked, loopGapEm: window.__loopGapEm });
  paintLog();
  paintJSON();
  refreshSelectionUI();
  loadAnimator();
  paintShapingInfo();
  animator.play();
}

function paintDebug() {
  debugLayout = renderDebugView(el.debug, analysis, {
    showOutlines: el.outlines.checked,
    showArrows: el.arrows.checked,
    showNumbers: el.numbers.checked,
    showNodes: el.nodes.checked,
    highlight: selection ? { ...selection, pointIndex: selectedPoint ?? selection.pointIndex } : null,
    view,
    curve: curveOption(),
  });
  window.__debugLayout = debugLayout; // handy from the console while tuning
}

/* ---------------------------------------------------------------- view --- */

const ZOOM_MAX = 8;

/** Zoom to z, keeping the canvas point `anchor` (CSS px) fixed; default centre. */
function setZoom(z, anchor) {
  const zoom = Math.min(ZOOM_MAX, Math.max(1, z));
  const c = [el.debug.clientWidth / 2, el.debug.clientHeight / 2];
  const a = anchor || c;
  // the unzoomed point currently under the anchor
  const qx = c[0] + (a[0] - view.panX - c[0]) / view.zoom;
  const qy = c[1] + (a[1] - view.panY - c[1]) / view.zoom;
  view.zoom = zoom;
  view.panX = zoom === 1 ? 0 : a[0] - c[0] - (qx - c[0]) * zoom;
  view.panY = zoom === 1 ? 0 : a[1] - c[1] - (qy - c[1]) * zoom;
  applyView();
}

function panBy(dx, dy) {
  if (view.zoom === 1) return;
  view.panX += dx;
  view.panY += dy;
  applyView();
}

function applyView() {
  for (const r of document.querySelectorAll('.zoomval')) r.textContent = `${Math.round(view.zoom * 100)}%`;
  if (analysis) paintDebug();
}

for (const b of document.querySelectorAll('[data-zoom]')) {
  b.addEventListener('click', () => {
    const a = b.dataset.zoom;
    if (a === 'in') setZoom(view.zoom * 1.5);
    else if (a === 'out') setZoom(view.zoom / 1.5);
    else setZoom(1);
  });
}

el.debug.addEventListener(
  'wheel',
  (e) => {
    if (!analysis) return;
    e.preventDefault();
    const rect = el.debug.getBoundingClientRect();
    setZoom(view.zoom * Math.exp(-e.deltaY * 0.002), [e.clientX - rect.left, e.clientY - rect.top]);
  },
  { passive: false }
);

function paintInternals() {
  const on = el.internals.checked;
  el.internalsview.hidden = !on;
  if (on && analysis) renderInternals(el.internalsview, analysis);
  else el.internalsview.innerHTML = '';
}

function paintStrokeList() {
  el.strokelist.innerHTML = analysis.penOrder
    .map((e) => {
      const g = analysis.glyphs[e.glyphIndex];
      const label = g.chars?.trim() || g.name;
      const sel =
        selection && selection.glyphIndex === e.glyphIndex && selection.strokeIndex === e.strokeIndex;
      const manual = g.record.source === 'manual' ? ' <span title="manually edited">✎</span>' : '';
      return `<span class="chip${sel ? ' sel' : ''}" data-g="${e.glyphIndex}" data-s="${
        e.strokeIndex
      }"><span class="dot" style="background:${strokeColor(e.n - 1)}"></span><b>${e.n}</b> ${escapeHtml(
        label
      )} <span class="role">${e.role}</span> · ${Math.round(e.length)}u${manual}</span>`;
    })
    .join('');
  for (const chip of el.strokelist.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      const gi = Number(chip.dataset.g);
      const si = Number(chip.dataset.s);
      selection =
        selection && selection.glyphIndex === gi && selection.strokeIndex === si
          ? null
          : { glyphIndex: gi, strokeIndex: si };
      refreshSelectionUI();
    });
  }
}

/* ------------------------------------------------------------- editing --- */

function refreshSelectionUI() {
  if (!analysis) return;
  paintDebug();
  paintStrokeList();
  updateEditor();
}

function updateEditor() {
  const active = Boolean(selection && analysis);
  el.edithint.hidden = active;
  el.editcontrols.hidden = !active;
  if (!active) return;
  const g = analysis.glyphs[selection.glyphIndex];
  const s = g.record.strokes[selection.strokeIndex];
  const entry = analysis.penOrder.find(
    (p) => p.glyphIndex === selection.glyphIndex && p.strokeIndex === selection.strokeIndex
  );
  el.editlabel.textContent = `#${entry?.n} · ${g.chars?.trim() || g.name} · ${s.role} · ${Math.round(
    s.lengthFontUnits
  )}u · ${s.points.length} points${selectedPoint != null ? ` · point ${selectedPoint + 1} · width ${s.widthEdits?.[selectedPoint] != null ? `${s.widthEdits[selectedPoint]}u ✎` : `${s.widths?.[selectedPoint] ?? '?'}u`}` : ''}`;
  const removable = selectedPoint != null && selectedPoint > 0 && selectedPoint < s.points.length - 1 && s.points.length > 3;
  el.deletePoint.disabled = !removable;
  el.deletePoint.title = selectedPoint == null
    ? 'click a point on the stroke first'
    : removable ? `delete point ${selectedPoint + 1}` : 'the ends of a stroke are where the pen lands and leaves';
  el.moveEarlier.disabled = selection.strokeIndex === 0;
  el.moveLater.disabled = selection.strokeIndex === g.record.strokes.length - 1;
  const pi = selection.pointIndex;
  el.splitStroke.disabled = !(pi != null && pi > 0 && pi < s.points.length - 1);
}

/**
 * Persist an edited record through the same seam an AI correction would use,
 * refresh everything derived from it, and replay so the change is visible.
 */
/* ------------------------------------------------------------- history -- */

// Every edit goes through commitRecordEdit, so the undo stack is built there:
// an entry is one glyph's record before and after, as JSON. Restoring a
// record whose source is "heuristic" drops the override rather than storing
// the heuristics as a hand edit, so the glyph goes back to being derived.
const HISTORY_LIMIT = 50;
const history = { undo: [], redo: [] };
const committed = new Map(); // fontKey#gid -> the record as last loaded or committed

const recordKey = (gid) => `${analysis.fontKey}#${gid}`;

/** Remember each glyph's record as the analysis handed it over. */
function noteLoadedRecords() {
  if (!analysis) return;
  for (const g of analysis.glyphs) {
    if (!g.record) continue;
    const k = recordKey(g.gid);
    if (!committed.has(k)) committed.set(k, JSON.stringify(g.record));
  }
}

function updateHistoryButtons() {
  el.undoEdit.disabled = !history.undo.length;
  el.redoEdit.disabled = !history.redo.length;
  el.undoEdit.title = history.undo.length ? `undo (${history.undo.length})` : 'nothing to undo';
  el.redoEdit.title = history.redo.length ? `redo (${history.redo.length})` : 'nothing to redo';
}

/** Put a remembered record back through the store and re-derive from it. */
function restoreRecord(gid, json) {
  const rec = JSON.parse(json);
  if (rec.source === 'heuristic') store.delete(analysis.fontKey, gid);
  else store.override(analysis.fontKey, gid, rec, rec.source || 'manual');
  committed.set(recordKey(gid), json);
  for (const g of analysis.glyphs) if (g.gid === gid) g.record = rec;
  refreshGlyphRecord(analysis, gid, rec);
  selectedPoint = null;
  // the selected stroke may be one this restore removed (undoing a drawn or placed path)
  if (selection && analysis.glyphs[selection.glyphIndex]?.gid === gid && selection.strokeIndex >= rec.strokes.length) selection = null;
  replan();
  updateHistoryButtons();
  const g = analysis.glyphs.find((x) => x.gid === gid);
  refreshLetterVerdict(g?.chars?.trim());
}

function undoEdit() {
  const e = history.undo.pop();
  if (!e) return;
  history.redo.push(e);
  restoreRecord(e.gid, e.before);
}

function redoEdit() {
  const e = history.redo.pop();
  if (!e) return;
  history.undo.push(e);
  restoreRecord(e.gid, e.after);
}

function commitRecordEdit(glyphIndex) {
  const g = analysis.glyphs[glyphIndex];
  g.record.strokes.forEach((s, i) => (s.index = i));
  // the joins and the invariant check read the ink width under every point,
  // so it has to follow the hand's changes before anything is derived
  refreshWidths(g, g.record);
  const key = recordKey(g.gid);
  const before = committed.get(key);
  const after = JSON.stringify(g.record);
  if (before !== undefined && before !== after) {
    history.undo.push({ gid: g.gid, before, after });
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo.length = 0;
  }
  committed.set(key, after);
  store.override(analysis.fontKey, g.gid, g.record, 'manual');
  refreshGlyphRecord(analysis, g.gid, store.get(analysis.fontKey, g.gid));
  replan();
  updateHistoryButtons();
  refreshLetterVerdict(g.chars?.trim());
}

function moveSelected(delta) {
  if (!selection) return;
  const g = analysis.glyphs[selection.glyphIndex];
  const i = selection.strokeIndex;
  const j = i + delta;
  if (j < 0 || j >= g.record.strokes.length) return;
  const s = g.record.strokes;
  [s[i], s[j]] = [s[j], s[i]];
  selection = { glyphIndex: selection.glyphIndex, strokeIndex: j };
  commitRecordEdit(selection.glyphIndex);
}

function paintLog() {
  const notes = analysis.notes;
  const warns = notes.filter((n) => n.severity === 'warn').length;
  el.logcount.textContent = notes.length
    ? `${warns} uncertain · ${notes.length - warns} informational`
    : '';
  if (!notes.length) {
    el.log.innerHTML =
      '<div class="empty">No ambiguities: every glyph had one clearly best stroke ordering.</div>';
    return;
  }
  el.log.innerHTML = notes
    .map(
      (n) =>
        `<div class="entry ${n.severity}"><span class="tag">${n.code}</span><span>${escapeHtml(
          n.message
        )}</span></div>`
    )
    .join('');
}

function paintJSON() {
  el.json.textContent = JSON.stringify(toJSON(analysis), null, 2);
}

/* ------------------------------------------------------------- controls -- */

el.analyze.addEventListener('click', () => { leaveLetterMode(); run(); });
el.text.addEventListener('keydown', (e) => {
  // Enter analyses, Shift+Enter starts a new line (folded into a space by run)
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); leaveLetterMode(); run(); }
});
el.text.addEventListener('input', () => {
  // the text field is the text's: typing into it ends a single-letter view
  leaveLetterMode();
  // grow with the text, up to a few lines
  el.text.rows = Math.min(6, Math.max(1, el.text.value.split('\n').length));
});
el.rasterEm.addEventListener('change', run);

for (const box of [el.outlines, el.arrows, el.numbers, el.nodes]) {
  box.addEventListener('change', () => analysis && paintDebug());
}
el.internals.addEventListener('change', paintInternals);
el.connect.addEventListener('change', () => analysis && replan());
el.natural.addEventListener('change', () => animator.setModel({ natural: el.natural.checked }));
el.loop.addEventListener('change', () => {
  animator.loop = el.loop.checked;
  // switching loop on at the end of a run starts the next one
  if (el.loop.checked && !animator.playing && animator.time >= animator.duration) animator.replay();
});

/* --------------------------------------------- drawing and dragging paths -- */

function setDrawMode(on) {
  if (on && placeModeOn) setPlaceMode(false);
  drawModeOn = on;
  el.drawMode.classList.toggle('active', on);
  el.debug.classList.toggle('drawing', on || placeModeOn);
  el.drawMode.textContent = on ? '✎ Drawing… (Esc stops)' : '✎ Draw stroke';
}

el.drawMode.addEventListener('click', () => setDrawMode(!drawModeOn));

/* ------------------------------------------------ a path from key points -- */

// Freehand drawing is only as steady as the hand; placing the key points
// of a path one click at a time is exact, and the curve between them is
// the same spline the chains run along (geometry.js smoothThroughPoints).
function setPlaceMode(on) {
  if (on && drawModeOn) setDrawMode(false);
  placeModeOn = on;
  placing = on ? { pts: [] } : null;
  el.placeMode.classList.toggle('active', on);
  el.debug.classList.toggle('drawing', on || drawModeOn);
  el.placeMode.textContent = on ? '⌖ Placing… (Enter ends, Esc stops)' : '⌖ Place points';
  if (analysis) paintDebug();
}

el.placeMode.addEventListener('click', () => setPlaceMode(!placeModeOn));

/** The dense CSS-space curve through the placed points. */
function placedCurve(step = 2) {
  const pts = placing?.pts || [];
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  return smoothThroughPoints(pts, step, 60);
}

function previewPlacing() {
  paintDebug();
  if (!placing?.pts.length) return;
  const ctx = el.debug.getContext('2d');
  const curve = placedCurve();
  ctx.save();
  if (curve.length > 1) {
    ctx.strokeStyle = '#e0562d';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(curve[0][0], curve[0][1]);
    for (let i = 1; i < curve.length; i++) ctx.lineTo(curve[i][0], curve[i][1]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#e0562d';
  ctx.lineWidth = 2;
  for (const p of placing.pts) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function finishPlacing() {
  if (!placing) return;
  const curve = placedCurve(2);
  const n = placing.pts.length;
  placing = { pts: [] };
  if (n < 2) { setPlaceMode(false); return; }
  setPlaceMode(false);
  finishDrawing(curve); // the same road a drawn path takes: snap, attribute, insert, commit
}

el.debug.addEventListener('dblclick', (e) => {
  if (!placeModeOn) return;
  e.preventDefault();
  finishPlacing();
});

/* ------------------------------------------------------- curve handles -- */

function setCurveMode(on) {
  curveModeOn = on;
  el.curveMode.classList.toggle('active', on);
  try { localStorage.setItem('handwriter.curveMode', on ? '1' : '0'); } catch { /* storage may be off */ }
  if (!on) selectedHandle = null;
  if (analysis) paintDebug();
}
el.curveMode.addEventListener('click', () => setCurveMode(!curveModeOn));
try { if (localStorage.getItem('handwriter.curveMode') === '1') setCurveMode(true); } catch { /* storage may be off */ }

/** The selected stroke's curve in word units, for the debug view; null unless curve mode is on. */
function curveOption() {
  if (!curveModeOn || !selection || !analysis) return null;
  const g = analysis.glyphs[selection.glyphIndex];
  const anchors = drag?.curve || strokeCurve(g.record, selection.strokeIndex);
  if (!anchors) return null;
  const off = (q) => (q ? [q[0] + g.x, q[1] + g.y] : null);
  return {
    anchors: anchors.map((a) => ({ p: off(a.p), in: off(a.in), out: off(a.out) })),
    active: drag?.curve ? { anchor: drag.anchor, which: drag.which } : selectedHandle,
  };
}

/** The anchor or handle of the selected stroke's curve nearest `at` (CSS px), handles before anchors. */
function nearestHandle(sel, anchors, at, maxDist) {
  const L = debugLayout;
  const g = analysis.glyphs[sel.glyphIndex];
  let best = null, bestD = maxDist * maxDist;
  anchors.forEach((a, i) => {
    for (const which of ['in', 'out', 'p']) {
      const q = a[which];
      if (!q) continue;
      const cx = L.originX + (g.x + q[0]) * L.s;
      const cy = L.baselineY - (g.y + q[1]) * L.s;
      const d = (cx - at[0]) ** 2 + (cy - at[1]) ** 2;
      // a handle sitting on its anchor: the anchor wins only if nothing closer
      if (d < bestD || (d === bestD && which === 'p' && best && best.anchor === i)) { bestD = d; best = { anchor: i, which }; }
    }
  });
  return best;
}

/** The index of the stroke's point nearest a curve anchor (what the width keys and the split act on). */
function pointNearAnchor(sel, anchor) {
  const g = analysis.glyphs[sel.glyphIndex];
  const s = g.record.strokes[sel.strokeIndex];
  let best = 0, bd = Infinity;
  s.points.forEach((p, i) => { const d = (p[0] - anchor.p[0]) ** 2 + (p[1] - anchor.p[1]) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}
window.__curve = { strokeCurve, moveCurveHandle, get mode() { return curveModeOn; }, set mode(v) { setCurveMode(!!v); } };
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawModeOn) setDrawMode(false);
  if (e.key === 'Escape' && placeModeOn) setPlaceMode(false);
});

/** Index of the selected stroke's vertex within maxDist CSS px of `at`, or null. */
function nearestVertex(sel, at, maxDist) {
  const L = debugLayout;
  const g = analysis.glyphs[sel.glyphIndex];
  const s = g.record.strokes[sel.strokeIndex];
  if (!s) return null;
  let best = null, bestD = maxDist * maxDist;
  s.points.forEach((p, i) => {
    const cx = L.originX + (g.x + p[0]) * L.s;
    const cy = L.baselineY - (g.y + p[1]) * L.s;
    const d = (cx - at[0]) ** 2 + (cy - at[1]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function previewDrawing() {
  paintDebug();
  const ctx = el.debug.getContext('2d');
  const pts = drawing.pts;
  ctx.save();
  ctx.strokeStyle = '#e0562d';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.restore();
}

/** The glyph a drawn path belongs to: most points inside its box, nearest centre on a tie. */
function glyphForPath(wordPts) {
  let best = -1, bestCount = -1, bestDist = Infinity;
  analysis.glyphs.forEach((g, gi) => {
    if (g.isBlank || !g.raster) return;
    const x1 = g.x + g.bbox.x1, x2 = g.x + g.bbox.x2;
    const y1 = g.y + g.bbox.y1, y2 = g.y + g.bbox.y2;
    let count = 0;
    for (const p of wordPts) if (p[0] >= x1 && p[0] <= x2 && p[1] >= y1 && p[1] <= y2) count++;
    const d = Math.hypot(wordPts[0][0] - (x1 + x2) / 2, wordPts[0][1] - (y1 + y2) / 2);
    if (count > bestCount || (count === bestCount && d < bestDist)) {
      best = gi; bestCount = count; bestDist = d;
    }
  });
  return best;
}

function finishDrawing(cssPts) {
  window.__lastDraw = { cssPts, gi: null, stroke: null }; // console aid
  if (!analysis || cssPts.length < 3) { paintDebug(); return; }
  const L = debugLayout;
  const word = cssPts.map(([x, y]) => [(x - L.originX) / L.s, (L.baselineY - y) / L.s]);
  const gi = glyphForPath(word);
  window.__lastDraw.gi = gi;
  if (gi < 0) { paintDebug(); return; }
  const g = analysis.glyphs[gi];
  const stroke = strokeFromDrawing(g, word.map((p) => [p[0] - g.x, p[1] - g.y]), { snap: el.snapInk.checked });
  window.__lastDraw.stroke = stroke;
  if (!stroke) { paintDebug(); return; }
  // a new path goes right after the selected stroke of that glyph, else last
  const at = selection && selection.glyphIndex === gi ? selection.strokeIndex + 1 : g.record.strokes.length;
  const idx = addStroke(g.record, stroke, at);
  selection = { glyphIndex: gi, strokeIndex: idx, pointIndex: null };
  commitRecordEdit(gi);
}

/** Pointer position in the debug canvas's CSS pixel space. */
function canvasPoint(e) {
  const rect = el.debug.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

el.debug.addEventListener('pointerdown', (e) => {
  if (!analysis) return;
  if (!analysis || !debugLayout) return;
  try { el.debug.setPointerCapture(e.pointerId); } catch { /* not every pointer can be captured */ }
  const at = canvasPoint(e);
  if (drawModeOn) { drawing = { pts: [at] }; return; }
  pointerDown = { at, moved: false };
  if (placeModeOn) return; // a click places a point on pointerup; nothing is dragged
  if (selection && curveModeOn) {
    const g = analysis.glyphs[selection.glyphIndex];
    const anchors = strokeCurve(g.record, selection.strokeIndex);
    const hit = anchors && nearestHandle(selection, anchors, at, 10);
    if (hit) {
      selectedHandle = hit;
      selectedPoint = pointNearAnchor(selection, anchors[hit.anchor]);
      drag = { curve: anchors, anchor: hit.anchor, which: hit.which, pointIndex: selectedPoint, lo: 0, hi: 0 };
      updateEditor();
    }
  } else if (selection) {
    const hit = nearestVertex(selection, at, 9);
    if (hit != null) {
      const s = analysis.glyphs[selection.glyphIndex].record.strokes[selection.strokeIndex];
      selectedPoint = hit;
      // measured from the points as they are now, so wherever the pointer
      // goes the point goes - however fast it gets there
      drag = { pointIndex: hit, base: s.points.map((p) => [p[0], p[1]]), lo: hit, hi: hit };
      updateEditor();
    }
  }
  // dragging empty space (or an unselected stroke) pans a zoomed view
  if (!drag && view.zoom > 1) pan = { last: at };
});

el.debug.addEventListener('pointermove', (e) => {
  if (!analysis) return;
  const at = canvasPoint(e);
  if (drawing) {
    const last = drawing.pts[drawing.pts.length - 1];
    if (Math.hypot(at[0] - last[0], at[1] - last[1]) >= 1.5) {
      drawing.pts.push(at);
      previewDrawing();
    }
    return;
  }
  if (!pointerDown) return;
  if (drag) {
    const g = analysis.glyphs[selection.glyphIndex];
    // the pointer in the glyph's own units, so the point lands under it
    const x = (at[0] - debugLayout.originX) / debugLayout.s - g.x;
    const y = (debugLayout.baselineY - at[1]) / debugLayout.s - g.y;
    if (drag.curve) {
      // an anchor brings its handles; a handle keeps its partner in line unless alt breaks it
      moveCurveHandle(g.record, selection.strokeIndex, drag.curve, drag.anchor, drag.which, x, y, { free: e.altKey });
    } else {
      // shift moves the single point; otherwise the curve either side follows it
      const radius = e.shiftKey ? 0 : g.record.unitsPerEm * 0.12;
      const range = dragPoint(g.record, selection.strokeIndex, drag.pointIndex, drag.base, x, y, radius);
      if (range) { drag.lo = Math.min(drag.lo, range[0]); drag.hi = Math.max(drag.hi, range[1]); }
    }
    pointerDown.moved = true;
    // redraw from the record as it is now - the plan keeps its own copy of
    // the path, so rebuild this one stroke's and the drag shows under the mouse
    const item = analysis.plan?.items.find(
      (it) => it.type === 'stroke' && it.glyphIndex === selection.glyphIndex && it.strokeIndex === selection.strokeIndex
    );
    if (item) derivePath(item);
    paintDebug();
  } else {
    if (Math.hypot(at[0] - pointerDown.at[0], at[1] - pointerDown.at[1]) > 3) pointerDown.moved = true;
    if (pan && pointerDown.moved) {
      panBy(at[0] - pan.last[0], at[1] - pan.last[1]);
      pan.last = at;
    }
  }
});

el.debug.addEventListener('pointerup', (e) => {
  if (!analysis) return;
  if (drawing) {
    const pts = drawing.pts;
    drawing = null;
    finishDrawing(pts);
    return;
  }
  if (drag && pointerDown?.moved) {
    // no snapping: a dragged point stays where it was dropped. Snap to ink is
    // for a freshly drawn path, which is meant to find the ink's centre.
    if (drag.curve) selectedPoint = pointNearAnchor(selection, drag.curve[drag.anchor]);
    drag = null;
    pointerDown = null;
    commitRecordEdit(selection.glyphIndex);
    return;
  }
  drag = null;
  pan = null;
  if (placeModeOn && pointerDown && !pointerDown.moved) {
    const at = canvasPoint(e);
    const last = placing.pts[placing.pts.length - 1];
    if (!last || Math.hypot(at[0] - last[0], at[1] - last[1]) > 2) placing.pts.push(at);
    previewPlacing();
    pointerDown = null;
    return;
  }
  if (pointerDown && !pointerDown.moved) {
    const [x, y] = canvasPoint(e);
    const onPoint = selection && !curveModeOn ? nearestVertex(selection, [x, y], 9) : null;
    if (onPoint != null) selectedPoint = onPoint; // a click on a point picks it
    else if (selection && curveModeOn && selectedHandle && drag === null && nearestHandle(selection, strokeCurve(analysis.glyphs[selection.glyphIndex].record, selection.strokeIndex), [x, y], 10)) {
      // a click on a handle picked it on pointerdown
    } else {
      selectedHandle = null;
      selection = hitTestStroke(debugLayout, analysis, x, y);
      selectedPoint = null;
    }
    refreshSelectionUI();
  }
  pointerDown = null;
});

el.debug.addEventListener('pointercancel', () => {
  drawing = null;
  drag = null;
  pan = null;
  pointerDown = null;
  if (analysis) paintDebug();
});

el.undoEdit.addEventListener('click', undoEdit);
el.redoEdit.addEventListener('click', redoEdit);
el.deletePoint.addEventListener('click', removeSelectedPoint);

/** Drop the picked point from the selected stroke. */
function removeSelectedPoint() {
  if (!selection || selectedPoint == null) return;
  const g = analysis.glyphs[selection.glyphIndex];
  if (!deletePoint(g.record, selection.strokeIndex, selectedPoint)) return;
  const s = g.record.strokes[selection.strokeIndex];
  selectedPoint = Math.min(selectedPoint, s.points.length - 2);
  commitRecordEdit(selection.glyphIndex);
}

// ⌘Z / ⌃Z undo, ⌘⇧Z / ⌃Y redo, ⌫ deletes the picked point - but never while
// the caret is in the text box or another field.
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoEdit(); else undoEdit();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redoEdit(); return; }
  if (placeModeOn) {
    if (e.key === 'Enter') { e.preventDefault(); finishPlacing(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); placing.pts.pop(); previewPlacing(); return; }
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && selection && selectedPoint != null) {
    e.preventDefault();
    removeSelectedPoint();
  }
  // the width at the picked point: [ thinner, ] wider (shift: by a fifth), \ back to the ink's
  if (selection && selectedPoint != null && (e.key === '[' || e.key === ']' || e.key === '\\')) {
    e.preventDefault();
    const g = analysis.glyphs[selection.glyphIndex];
    const s = g.record.strokes[selection.strokeIndex];
    const cur = s.widthEdits?.[selectedPoint] ?? s.widths?.[selectedPoint] ?? 20;
    const f = e.key === '\\' ? null : e.key === ']' ? (e.shiftKey ? 1.25 : 1.05) : (e.shiftKey ? 0.8 : 0.95);
    setPointWidth(g.record, selection.strokeIndex, selectedPoint, f === null ? null : cur * f);
    commitRecordEdit(selection.glyphIndex);
  }
});

el.moveEarlier.addEventListener('click', () => moveSelected(-1));
el.moveLater.addEventListener('click', () => moveSelected(1));

el.reverseStroke.addEventListener('click', () => {
  if (!selection) return;
  const g = analysis.glyphs[selection.glyphIndex];
  g.record.strokes[selection.strokeIndex].points.reverse();
  delete g.record.strokes[selection.strokeIndex].curve;
  if (selection.pointIndex != null) {
    selection.pointIndex = g.record.strokes[selection.strokeIndex].points.length - 1 - selection.pointIndex;
  }
  commitRecordEdit(selection.glyphIndex);
});

el.splitStroke.addEventListener('click', () => {
  const at = selectedPoint ?? selection?.pointIndex;
  if (!selection || at == null) return;
  const g = analysis.glyphs[selection.glyphIndex];
  if (!splitStroke(g.record, selection.strokeIndex, at)) return;
  selectedPoint = null;
  // select the second half - usually the piece about to be deleted or moved
  selection = { glyphIndex: selection.glyphIndex, strokeIndex: selection.strokeIndex + 1, pointIndex: null };
  commitRecordEdit(selection.glyphIndex);
});

el.deleteStroke.addEventListener('click', () => {
  if (!selection) return;
  const g = analysis.glyphs[selection.glyphIndex];
  const gi = selection.glyphIndex;
  if (!deleteStroke(g.record, selection.strokeIndex)) return;
  selection = null;
  selectedPoint = null;
  commitRecordEdit(gi);
});

el.resetGlyph.addEventListener('click', () => {
  if (!selection) return;
  const g = analysis.glyphs[selection.glyphIndex];
  const ch = g.chars?.trim();
  store.delete(analysis.fontKey, g.gid);
  selection = null;
  selectedPoint = null;
  run().then(() => refreshLetterVerdict(ch));
});

el.deselect.addEventListener('click', () => {
  selection = null;
  selectedPoint = null;
  refreshSelectionUI();
});

el.clearcache.addEventListener('click', () => {
  // hand-edited glyphs are work, not cache: they survive unless asked for
  const { manual } = store.stats();
  if (manual && !confirm(`Keep the ${manual} hand-edited ${manual === 1 ? 'letter' : 'letters'}?\n\nOK keeps them and re-runs the heuristics for everything else; Cancel throws them away too.`)) {
    store.clear({ alsoManual: true });
  } else {
    store.clear();
  }
  run();
});

el.playpause.addEventListener('click', () => {
  if (animator.playing) {
    animator.pause();
    setPlay('play');
  } else {
    animator.play();
    setPlay('pause');
  }
});

/* ------------------------------------------------------------ recording -- */

el.record.addEventListener('click', async () => {
  if (recorder.recording) {
    finishRecording();
    return;
  }
  if (!recorder.supported) {
    setRecord('record', 'Recording not supported in this browser');
    el.record.disabled = true;
    return;
  }
  // Record what is in the text field, not what was last analysed: if the
  // field changed since, analyse it first so the take - and its filename -
  // match the text.
  if (!analysis || el.text.value !== analysis.text) {
    if (!(await run())) return;
  }
  if (recorder.start()) {
    setRecord('stop', 'Stop recording');
    el.record.classList.add('rec');
    el.takelink.hidden = true;
    el.takeinfo.textContent = 'recording one run…';
    animator.replay();
  }
});

/**
 * Stops the recorder and offers the take as a download link. Runs
 * automatically when the run finishes, or on demand via the stop button.
 *
 * The link is deliberately a real anchor the user clicks: a download fired
 * from an async completion carries no user gesture, and Chrome silently
 * blocks such "automatic" downloads after the first few in a session.
 */
async function finishRecording() {
  if (finishingRecording) return;
  finishingRecording = true;
  animator.pause();
  setPlay('play');
  animator.drawAt(animator.time); // make sure the final state is painted
  recorder.captureFrame();
  await new Promise((r) => setTimeout(r, 200)); // let the encoder take it
  const blob = await recorder.stop();
  finishingRecording = false;
  setRecord('record', 'Record');
  el.record.classList.remove('rec');
  if (takeUrl) {
    URL.revokeObjectURL(takeUrl);
    takeUrl = null;
  }
  if (!blob) {
    el.takelink.hidden = true;
    el.takeinfo.textContent = 'nothing was captured — keep the tab visible while recording';
    return;
  }
  window.__lastRecording = { size: blob.size, type: blob.type }; // console aid
  const name = `handwriting-${(analysis?.text || 'word').replace(/\W+/g, '_')}.${recorder.ext}`;
  const mb = (blob.size / 1e6).toFixed(1);

  // an automatic download, with the link as the fallback should the browser
  // block automatic downloads for this site
  takeUrl = URL.createObjectURL(blob);
  el.takelink.href = takeUrl;
  el.takelink.download = name;
  el.takelink.textContent = `⬇ ${name} (${mb} MB)`;
  el.takelink.hidden = false;
  el.takeinfo.textContent = 'downloading… (if nothing arrived, the browser blocked automatic downloads - click the link, or allow them for this site)';
  downloadBlob(blob, name);
}


el.speed.addEventListener('input', () => {
  el.speedval.textContent = Number(el.speed.value).toFixed(1);
  animator.setSpeed(Number(el.speed.value));
  if (analysis) paintShapingInfo();
});

el.scrub.addEventListener('pointerdown', () => { scrubbing = true; });
el.scrub.addEventListener('pointerup', () => { scrubbing = false; });
el.scrub.addEventListener('input', () => {
  el.scrub.style.setProperty('--p', `${Number(el.scrub.value) / 10}%`);
  animator.seekFraction(Number(el.scrub.value) / 1000);
  setPlay('play');
});

el.renderer.value = (() => { try { return localStorage.getItem('handwriter.renderer') || 'stroke'; } catch { return 'stroke'; } })();
animator.renderer = el.renderer.value;
el.renderer.addEventListener('change', () => {
  try { localStorage.setItem('handwriter.renderer', el.renderer.value); } catch { /* private mode */ }
  animator.renderer = el.renderer.value;
  animator.drawAt(animator.time);
});
el.showpen.addEventListener('change', () => {
  animator.showPen = el.showpen.checked;
  animator.drawAt(animator.time);
});

el.copyjson.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.json.textContent);
  el.copyjson.textContent = 'Copied';
  setTimeout(() => (el.copyjson.textContent = 'Copy'), 1200);
});

/*
 * Export movie. The animator renders the run frame by frame on a fixed clock
 * into a canvas of its own, transparent; each frame goes to the dev server as
 * a PNG, and the server encodes them with AVFoundation into a .mov that keeps
 * the alpha channel (scripts/movie-server.mjs, scripts/encode-movie.swift).
 * A browser cannot write such a movie itself, so this needs `npm run dev`.
 */
const MOVIE = { width: 1920, fps: 60, hold: 1 };
let exportingMovie = false;

const onDevServer = ['localhost', '127.0.0.1'].includes(location.hostname);
el.movieformat.value = (() => { try { return localStorage.getItem('handwriter.movieformat') || (onDevServer ? 'prores4444' : 'prores4444-wasm'); } catch { return 'prores4444-wasm'; } })();
el.movieformat.addEventListener('change', () => {
  try { localStorage.setItem('handwriter.movieformat', el.movieformat.value); } catch { /* private mode */ }
});

async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

el.exportmovie.addEventListener('click', async () => {
  if (exportingMovie || !animator.timeline) return;
  exportingMovie = true;
  const label = el.exportmovie.textContent;
  el.exportmovie.disabled = true;
  const codec = el.movieformat.value;
  const text = (analysis?.text || 'word').replace(/\W+/g, '_');
  try {
    if (codec === 'prores4444-wasm') {
      // in the browser: FFmpeg in WebAssembly writes ProRes 4444 with alpha
      const { encodeProRes } = await import('./lib/wasmMovie.js');
      const { blob, info } = await encodeProRes({
        fps: MOVIE.fps,
        render: (onFrame) => animator.renderFrames({ width: MOVIE.width, fps: MOVIE.fps, hold: MOVIE.hold, showPen: el.showpen.checked }, onFrame),
        onStatus: (status) => { el.exportmovie.textContent = status; },
      });
      downloadBlob(blob, `handwriting-${text}.mov`);
      el.takeinfo.textContent = `movie: ${info.width}×${info.height}, ${info.count} frames at ${info.fps} fps, ProRes 4444 with alpha (encoded in the browser), ${(blob.size / 1e6).toFixed(1)} MB`;
      return;
    }
    let id;
    try {
      ({ id } = await postJSON('/__movie/start', { fps: MOVIE.fps, codec }));
    } catch (err) {
      throw new Error(`movie export needs the local dev server on a Mac (\`npm run dev\`): the frames are encoded with AVFoundation, which the hosted site cannot do (${err.message})`);
    }
    const toPng = (canvas) => new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('frame encode failed'))), 'image/png'));
    const info = await animator.renderFrames(
      { width: MOVIE.width, fps: MOVIE.fps, hold: MOVIE.hold, showPen: el.showpen.checked },
      async (canvas, n, count) => {
        const png = await toPng(canvas);
        const res = await fetch(`/__movie/frame?id=${id}&n=${n}`, { method: 'POST', body: png });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `frame ${n} refused`);
        el.exportmovie.textContent = `Rendering ${n + 1}/${count}`;
      },
    );
    el.exportmovie.textContent = 'Encoding…';
    const res = await fetch(`/__movie/finish?id=${id}`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `encoding failed (${res.status})`);
    const movie = await res.blob();
    downloadBlob(movie, `handwriting-${text}.mov`);
    el.takeinfo.textContent = `movie: ${info.width}×${info.height}, ${info.count} frames at ${info.fps} fps, ${codec === 'prores4444' ? 'ProRes 4444' : 'HEVC + alpha'}, ${(movie.size / 1e6).toFixed(1)} MB`;
  } catch (err) {
    console.error(err);
    el.takeinfo.innerHTML = `<span class="err">Export movie: ${escapeHtml(err.message)}</span>`;
  } finally {
    exportingMovie = false;
    el.exportmovie.disabled = false;
    el.exportmovie.textContent = label;
  }
});

el.downloadjson.addEventListener('click', () => {
  const blob = new Blob([el.json.textContent], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `strokes-${(analysis?.text || 'word').replace(/\W+/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000); // revoking at once can abort the download
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!analysis) return;
    paintDebug();
    animator.resize();
  }, 120);
});

/* ---------------------------------------------------------------- utils -- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// the version travels in the page title so a screenshot or a recording names the build
document.title = `Handwriter prototype v${version}`;
const versionBtn = $('versionbtn');
versionBtn.textContent = `prototype v${version}`;

/*
 * Version history. Each entry is a git tag, so it is a tree that can be put
 * back; the page can only tell you which they are and hand you the command,
 * since a browser cannot check anything out. `versions.json` is generated by
 * scripts/release.mjs from the tags themselves.
 */
const versionList = $('versionlist');
versionBtn.addEventListener('click', () => {
  versionList.hidden = !versionList.hidden;
  if (versionList.hidden) return;
  const rows = versions.length
    ? versions.map((v) => {
      const now = v.version === version;
      const note = escapeHtml(v.note.replace(/^v[\d.]+\s*[—-]?\s*/, '')) || (now ? 'this build' : '');
      return `<li class="${now ? 'now' : ''}"><span class="ver">v${escapeHtml(v.version)}</span><span class="date">${escapeHtml(v.date)}</span><span class="note">${note}</span><code data-copy="git checkout ${escapeHtml(v.tag)}">${escapeHtml(v.tag)}</code></li>`;
    }).join('')
    : '<li>no tags yet — run <code>node scripts/release.mjs 0.17.0 "note"</code></li>';
  versionList.innerHTML = `<h2>Version history</h2><ul>${rows}</ul>` +
    '<p class="hint">Click a tag to copy its command, then run it in the project folder. ' +
    '<code data-copy="git checkout -">git checkout -</code> comes back. ' +
    'Cut a new one with <code data-copy="node scripts/release.mjs">node scripts/release.mjs &lt;x.y.z&gt; "note"</code>.</p>';
});
versionList.addEventListener('click', (e) => {
  const code = e.target.closest('code[data-copy]');
  if (!code) return;
  navigator.clipboard?.writeText(code.dataset.copy);
  const was = code.textContent;
  code.textContent = 'copied';
  setTimeout(() => { code.textContent = was; }, 900);
});



/* ------------------------------------- can this browser encode with alpha? -- */

// The movie export runs through the dev server's AVFoundation encoder on a
// Mac; this asks WebCodecs whether the browser itself could do it, which
// is what a hosted page would need.
document.getElementById('probecodec')?.addEventListener('click', async () => {
  const out = document.getElementById('probeinfo');
  out.hidden = false;
  if (!('VideoEncoder' in window)) { out.textContent = 'WebCodecs is not available in this browser.'; return; }
  const tries = [
    ['HEVC (hvc1) with alpha', { codec: 'hvc1.1.6.L120.B0', alpha: 'keep' }],
    ['HEVC (hvc1) without alpha', { codec: 'hvc1.1.6.L120.B0' }],
    ['VP9 with alpha', { codec: 'vp09.00.10.08', alpha: 'keep' }],
    ['H.264 without alpha', { codec: 'avc1.42001f' }],
  ];
  const lines = [];
  for (const [label, cfg] of tries) {
    try {
      const r = await VideoEncoder.isConfigSupported({ width: 1920, height: 1080, bitrate: 20_000_000, framerate: 60, ...cfg });
      const alphaKept = r.config?.alpha === 'keep';
      lines.push(`${label}: ${r.supported ? 'yes' : 'no'}${cfg.alpha ? (alphaKept ? ' (alpha kept)' : ' (alpha would be dropped)') : ''}`);
    } catch (e) { lines.push(`${label}: error (${e.message || e})`); }
  }
  out.textContent = `${navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome') ? 'Safari' : 'this browser'}: ` + lines.join(' · ');
});
