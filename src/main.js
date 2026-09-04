/**
 * UI wiring only. All analysis lives under src/lib, all drawing under
 * src/render.
 */

import defaultFontUrl from '../FONTFILE.otf?url';
import { version } from '../package.json';
import { loadFont } from './lib/shaping.js';
import { fontStore } from './lib/fontStore.js';
import { composeWord } from './pen/compose.js';
import { STYLES as PEN_STYLES } from './pen/grammar.js';
import { renderPenDebug } from './render/penDebug.js';
import { analyzeWord, toJSON, rebuildPlan, refreshGlyphRecord } from './lib/analyze.js';
import {
  splitStroke,
  deleteStroke,
  addStroke,
  strokeFromDrawing,
  nudgeStroke,
  snapStrokeRange,
} from './lib/edit.js';
import { StrokeStore } from './lib/cache.js';
import { renderDebugView, hitTestStroke } from './render/debugView.js';
import { Animator } from './render/animator.js';
import { CanvasRecorder } from './render/recorder.js';
import { downloadBlob } from './render/takes.js';
import { penToSvg } from './pen/svg.js';
import { fitHand } from './pen/fit.js';
import { letterFromWaypoints } from './pen/letters.js';
import { handStore } from './lib/handStore.js';
import { fontKeyOf } from './lib/cache.js';
import { renderInternals } from './render/internals.js';
import { strokeColor } from './render/layout.js';

const $ = (id) => document.getElementById(id);
const el = {
  text: $('text'),
  analyze: $('analyze'),
  fontfile: $('fontfile'),
  source: $('source'),
  animmeta: $('animmeta'),
  penhandfield: $('penhandfield'),
  penhand: $('penhand'),
  penrow: $('penrow'),
  penslant: $('penslant'),
  penslantval: $('penslantval'),
  pentempo: $('pentempo'),
  pentempoval: $('pentempoval'),
  penvar: $('penvar'),
  penwrap: $('penwrap'),
  penfit: $('penfit'),
  penhandremove: $('penhandremove'),
  penhanddownload: $('penhanddownload'),
  penvarval: $('penvarval'),
  pennib: $('pennib'),
  pentake: $('pentake'),
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
  fontinfo: $('fontinfo'),
  shapinginfo: $('shapinginfo'),
  debug: $('debug'),
  strokelist: $('strokelist'),
  edithint: $('edithint'),
  editcontrols: $('editcontrols'),
  editlabel: $('editlabel'),
  moveEarlier: $('moveEarlier'),
  moveLater: $('moveLater'),
  reverseStroke: $('reverseStroke'),
  splitStroke: $('splitStroke'),
  deleteStroke: $('deleteStroke'),
  resetGlyph: $('resetGlyph'),
  deselect: $('deselect'),
  drawMode: $('drawMode'),
  snapInk: $('snapInk'),
  anim: $('anim'),
  playpause: $('playpause'),
  record: $('record'),
  takelink: $('takelink'),
  exportsvg: $('exportsvg'),
  takeinfo: $('takeinfo'),
  speed: $('speed'),
  timecode: $('timecode'),
  speedval: $('speedval'),
  scrub: $('scrub'),
  showpen: $('showpen'),
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
let penResult = null;   // the pen model's word, when that is the source
let scrubbing = false;
let selection = null; // {glyphIndex, strokeIndex, pointIndex?} of the stroke being edited
let debugLayout = null;
let drawModeOn = false;
const view = { zoom: 1, panX: 0, panY: 0 }; // debug view only; the animation stays fitted
let pan = null;         // {last} while the view is being dragged
let drawing = null;     // {pts: [[cssX, cssY], ...]} while a path is being drawn
let drag = null;        // {pointIndex, last, lo, hi} while a vertex is being dragged
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

async function useFont(arrayBuffer, name) {
  fontCtx = await loadFont(arrayBuffer, name);
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
  updateHandButtons();
}

/* ---------------------------------------------------------- font picker -- */

const DEFAULT_FONT = 'default';

/** Offer the bundled font first, then every saved one; keep the current choice selected. */
async function refreshFontPicker(selectedId) {
  const saved = await fontStore.list();
  el.fontpick.innerHTML = '';
  const opt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; el.fontpick.appendChild(o); };
  opt(DEFAULT_FONT, 'Autography (default)');
  for (const f of saved) opt(f.id, f.family && f.family !== f.name ? `${f.family} · ${f.name}` : f.name);
  const want = selectedId ?? fontStore.choice;
  el.fontpick.value = saved.some((f) => f.id === want) ? want : DEFAULT_FONT;
  el.fontremove.hidden = el.fontpick.value === DEFAULT_FONT;
}

/** Load the picked font (bundled, or from the browser's store) and analyse the text with it. */
async function pickFont(id) {
  try {
    if (id === DEFAULT_FONT) {
      const res = await fetch(defaultFontUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await useFont(await res.arrayBuffer(), 'FONTFILE.otf');
    } else {
      const bytes = await fontStore.bytes(id);
      if (!bytes) throw new Error('that font is no longer stored');
      const meta = (await fontStore.list()).find((f) => f.id === id);
      await useFont(bytes, meta?.name || 'font');
    }
    fontStore.choice = id;
    el.fontremove.hidden = id === DEFAULT_FONT;
    await run();
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
el.source.addEventListener('change', () => {
  const pen = el.source.value === 'pen';
  el.penhandfield.hidden = !pen;
  el.penrow.hidden = !pen;
  run();
});
/* ------------------------------------------------------- fitted hands -- */

/** Hands fitted from fonts, as stored: {id, name, fontKey, hand}. */
let fittedHands = [];

/** The picker: built-in hands first, then every fitted one; keeps the choice. */
async function refreshHandPicker(selectedId) {
  fittedHands = await handStore.list();
  const want = selectedId ?? el.penhand.value ?? handStore.choice;
  el.penhand.innerHTML = '';
  for (const id of Object.keys(PEN_STYLES)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = PEN_STYLES[id].name;
    el.penhand.appendChild(o);
  }
  if (fittedHands.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'fitted from fonts';
    for (const f of fittedHands) {
      const o = document.createElement('option');
      o.value = `fit:${f.id}`;
      o.textContent = `${f.name} (fitted)`;
      grp.appendChild(o);
    }
    el.penhand.appendChild(grp);
  }
  el.penhand.value = [...el.penhand.options].some((o) => o.value === want) ? want : 'school';
  updateHandButtons();
}

function updateHandButtons() {
  const fitted = el.penhand.value.startsWith('fit:');
  el.penhandremove.hidden = !fitted;
  el.penhanddownload.hidden = !fitted;
  el.penfit.hidden = !fontCtx;
}

/** A hand by picker value: a built-in preset, or a fitted hand with its own letters. */
function handById(id) {
  if (id && id.startsWith('fit:')) {
    const rec = fittedHands.find((f) => `fit:${f.id}` === id);
    if (rec) {
      const letters = {};
      for (const [ch, e] of Object.entries(rec.hand.letters)) letters[ch] = letterFromWaypoints(ch, e);
      return { ...PEN_STYLES.school, ...rec.hand.style, id, name: `${rec.name} (fitted)`, letters };
    }
  }
  return PEN_STYLES[id] || PEN_STYLES.school;
}

/**
 * Fit a hand to the current font: recover every letter on its own (isolated
 * forms, no contextual alternates), then derive waypoints, slant and nib.
 */
async function fitHandFromCurrentFont() {
  if (!fontCtx) return;
  // the picker's label names the font best (the bundled font's family name is not in its name table)
  const picked = el.fontpick.selectedOptions[0]?.textContent.replace(/ \(default\)$/, '');
  const name = picked || fontCtx.familyName || fontCtx.sourceName || 'font';
  el.penfit.disabled = true;
  document.body.classList.add('busy');
  const letters = [];
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  try {
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      el.fontinfo.textContent = `fitting a hand to ${name}: ${ch} (${i + 1}/${chars.length})`;
      await new Promise((r) => setTimeout(r, 0));
      const a = analyzeWord(fontCtx, ch, store, { rasterEm: clampInt(el.rasterEm.value, 128, 1024, 512), connect: false });
      const g = a.glyphs.find((x) => !x.isBlank && x.record);
      letters.push({ ch, record: g?.record ?? null, raster: g?.raster ?? null, xAdvance: g?.xAdvance ?? fontCtx.xHeight });
    }
    const { hand } = fitHand({
      name,
      fontKey: fontKeyOf(fontCtx),
      metrics: { unitsPerEm: fontCtx.unitsPerEm, xHeight: fontCtx.xHeight, ascender: fontCtx.ascender, descender: fontCtx.descender, capHeight: fontCtx.ot?.tables?.os2?.sCapHeight || null },
      letters,
    });
    calibrateTempo(hand);
    const id = await handStore.add(name, hand.fontKey, hand);
    await refreshHandPicker(`fit:${id}`);
    handStore.choice = el.penhand.value;
    applyPenPreset(el.penhand.value);
    el.source.value = 'pen';
    el.source.dispatchEvent(new Event('change'));
  } catch (err) {
    console.error(err);
    el.fontinfo.innerHTML = `<span class="err">fitting failed: ${escapeHtml(String(err))}</span>`;
  } finally {
    el.penfit.disabled = false;
    document.body.classList.remove('busy');
  }
}

/**
 * A fitted face may carry far more path per letter than the school hand (a
 * flamboyant script with long lead-outs) or far less; the tempo is scaled so
 * the pen covers x-heights per second at the school hand's pace.
 */
function calibrateTempo(hand) {
  const letters = {};
  for (const [ch, e] of Object.entries(hand.letters)) letters[ch] = letterFromWaypoints(ch, e);
  const probe = 'abcdefghijklmnopqrstuvwxyz';
  const pace = (style) => {
    const r = composeWord(probe, { ...style, variability: 0 });
    const path = r.chains.reduce((s, c) => s + c.L, 0) / r.xHeight;
    return path / Math.max(1e-6, r.total);
  };
  const want = pace(PEN_STYLES.school);
  const got = pace({ ...PEN_STYLES.school, ...hand.style, letters });
  if (got > 0 && want > 0) {
    hand.style.tempo = Math.round(Math.min(0.2, Math.max(0.04, hand.style.tempo * (got / want))) * 1000) / 1000;
    hand.report[0].message += `; tempo set to ${Math.round(hand.style.tempo * 1000)} ms for the school hand's pace (${want.toFixed(1)} x-heights/s)`;
  }
}

el.penfit.addEventListener('click', () => fitHandFromCurrentFont());
el.penhandremove.addEventListener('click', async () => {
  const id = el.penhand.value;
  if (!id.startsWith('fit:')) return;
  await handStore.remove(id.slice(4));
  await refreshHandPicker('school');
  handStore.choice = 'school';
  applyPenPreset('school');
  run();
});
el.penhanddownload.addEventListener('click', () => {
  const rec = fittedHands.find((f) => `fit:${f.id}` === el.penhand.value);
  if (!rec) return;
  const blob = new Blob([JSON.stringify(rec.hand, null, 1)], { type: 'application/json' });
  downloadBlob(blob, `hand-${rec.name.replace(/\W+/g, '_')}.json`);
});

(async () => {
  await refreshHandPicker(handStore.choice);
  applyPenPreset(el.penhand.value);
})();
el.penhand.addEventListener('change', () => { handStore.choice = el.penhand.value; applyPenPreset(el.penhand.value); updateHandButtons(); run(); });
el.penslant.addEventListener('input', () => { el.penslantval.textContent = el.penslant.value; });
el.penslant.addEventListener('change', () => run());
el.pentempo.addEventListener('input', () => { el.pentempoval.textContent = el.pentempo.value; });
el.pentempo.addEventListener('change', () => run());
el.penvar.addEventListener('input', () => { el.penvarval.textContent = el.penvar.value; });
el.penvar.addEventListener('change', () => run());
el.pennib.addEventListener('change', () => run());
el.penwrap.addEventListener('change', () => run());
el.pentake.addEventListener('click', () => { penSeed++; run(); });

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
  } catch (err) {
    console.error(err);
    el.fontinfo.innerHTML = `<span class="err">${escapeHtml(String(err))}</span>`;
  } finally {
    e.target.value = '';
  }
});

el.fontremove.addEventListener('click', async () => {
  const id = el.fontpick.value;
  if (id === DEFAULT_FONT) return;
  const name = el.fontpick.selectedOptions[0]?.textContent || 'this font';
  if (!confirm(`Forget ${name}? Its stroke cache stays until you clear it.`)) return;
  await fontStore.remove(id);
  await refreshFontPicker(DEFAULT_FONT);
  await pickFont(DEFAULT_FONT);
});

/* ------------------------------------------------------------- analysis -- */

/** Analyse the text field; resolves true once the new analysis is in place. */
function run() {
  if (el.source.value === 'pen') return runPen();
  penResult = null;
  el.exportsvg.hidden = true;
  el.animmeta.textContent = "the font's own outlines, uncovered by a round nib that follows the recovered path";
  if (!fontCtx) return Promise.resolve(false);
  const text = (el.text.value ?? '').replace(/\s*\n\s*/g, ' ');
  if (!text.length) return Promise.resolve(false);
  selection = null;
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
        });
        window.__analysis = analysis; // handy from the console while tuning
        paintDebug();
        paintInternals();
        paintStrokeList();
        updateEditor();
        paintLog();
        paintJSON();
        loadAnimator();
        paintShapingInfo();
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
  const shaped = s.glyphs.map((g) => `${g.name}<span style="opacity:.5">/${g.gid}</span>`).join(' ');
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

/**
 * The pen model: the word is written from the letter grammar - no font, no
 * skeleton - timed by the kinematic model and inked by the nib.
 */
let penSeed = 1;

/** The pen style as set in the controls: a hand's preset, with the sliders over it. */
function currentPenStyle() {
  const base = handById(el.penhand.value);
  const nibType = el.pennib.value;
  const nib = nibType === base.nib.type ? base.nib
    : nibType === 'mono' ? { type: 'mono', wMin: 0.07, wMax: 0.07 }
    : nibType === 'broad' ? { type: 'broad', wMin: 0.03, wMax: 0.17, angle: 45 }
    : { type: 'pointed', wMin: 0.04, wMax: 0.15 };
  return {
    ...base,
    slant: Number(el.penslant.value),
    tempo: Number(el.pentempo.value) / 1000,
    variability: Number(el.penvar.value),
    wrapEm: Math.max(0, Number(el.penwrap.value) || 0),
    nib,
    seed: penSeed,
  };
}

/** Put a hand's preset into the controls. */
function applyPenPreset(id) {
  const s = handById(id);
  el.penslant.value = String(s.slant);
  el.penslantval.textContent = String(s.slant);
  el.pentempo.value = String(Math.round(s.tempo * 1000));
  el.pentempoval.textContent = String(Math.round(s.tempo * 1000));
  el.penvar.value = String(s.variability);
  el.penvarval.textContent = String(s.variability);
  el.pennib.value = s.nib.type;
}

function runPen() {
  clearTake();
  const text = el.text.value;
  try {
    analysis = null;
    const PEN_STYLE = currentPenStyle();
    el.animmeta.textContent = 'the pen model: letters written from their taught strokes, timed by the kinematic model, inked by the nib';
    penResult = composeWord(text, PEN_STYLE);
    const fitted = fittedHands.find((f) => `fit:${f.id}` === el.penhand.value);
    if (fitted?.hand.report) penResult.notes.unshift(...fitted.hand.report);
    window.__pen = penResult; // handy from the console while tuning
    paintDebug();
    el.strokelist.innerHTML = '';
    el.editcontrols.hidden = true;
    el.internalsview.hidden = true;
    const strokes = penResult.chains.reduce((n, c) => n + c.targets.length - 1, 0);
    el.shapinginfo.innerHTML = [
      `pen model · <b>${escapeHtml(PEN_STYLE.name)}</b> · slant ${PEN_STYLE.slant}° · ${PEN_STYLE.nib.type} nib · tempo ${Math.round(PEN_STYLE.tempo * 1000)} ms · take ${penSeed}`,
      `${penResult.chains.length} pen-down chain${penResult.chains.length === 1 ? '' : 's'} · ${strokes} strokes · ${penResult.total.toFixed(1)} s`,
    ].join('<br>');
    el.log.innerHTML = penResult.notes.length
      ? penResult.notes.map((n) => `<div class="entry ${n.severity}"><span>${n.code}</span><span>${escapeHtml(n.message)}</span></div>`).join('')
      : '<div class="entry info"><span>ok</span><span>every letter has a grammar</span></div>';
    el.logcount.textContent = `${penResult.notes.length} note${penResult.notes.length === 1 ? '' : 's'}`;
    el.json.textContent = JSON.stringify({
      source: 'pen', text, style: PEN_STYLE,
      chains: penResult.chains.map((c) => ({ id: c.id, seconds: +(c.t1 - c.t0).toFixed(3), targets: c.targets.map((p) => p.map((v) => Math.round(v))), samples: c.pts.length })),
    }, null, 2);
    animator.speed = Number(el.speed.value);
    animator.loop = el.loop.checked;
    animator.showPen = el.showpen.checked;
    animator.loadPen(penResult);
    el.exportsvg.hidden = false;
    animator.play();
    return Promise.resolve(true);
  } catch (err) {
    console.error(err);
    el.shapinginfo.innerHTML = `<span class="err">${escapeHtml(String(err))}</span>`;
    return Promise.resolve(false);
  }
}

/** Order, lifts and bridges are derived data: recompute and repaint them. */
function replan() {
  if (!analysis) return;
  clearTake();
  rebuildPlan(analysis, { connect: el.connect.checked });
  paintLog();
  paintJSON();
  refreshSelectionUI();
  loadAnimator();
  paintShapingInfo();
  animator.play();
}

function paintDebug() {
  if (penResult) {
    debugLayout = renderPenDebug(el.debug, penResult, view);
    window.__debugLayout = debugLayout;
    return;
  }
  debugLayout = renderDebugView(el.debug, analysis, {
    showOutlines: el.outlines.checked,
    showArrows: el.arrows.checked,
    showNumbers: el.numbers.checked,
    showNodes: el.nodes.checked,
    highlight: selection,
    view,
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
  )}u`;
  el.moveEarlier.disabled = selection.strokeIndex === 0;
  el.moveLater.disabled = selection.strokeIndex === g.record.strokes.length - 1;
  const pi = selection.pointIndex;
  el.splitStroke.disabled = !(pi != null && pi > 0 && pi < s.points.length - 1);
}

/**
 * Persist an edited record through the same seam an AI correction would use,
 * refresh everything derived from it, and replay so the change is visible.
 */
function commitRecordEdit(glyphIndex) {
  const g = analysis.glyphs[glyphIndex];
  g.record.strokes.forEach((s, i) => (s.index = i));
  store.override(analysis.fontKey, g.gid, g.record, 'manual');
  refreshGlyphRecord(analysis, g.gid, store.get(analysis.fontKey, g.gid));
  replan();
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

el.analyze.addEventListener('click', run);
el.text.addEventListener('keydown', (e) => {
  // Enter analyses, Shift+Enter starts a new line (the pen model writes lines)
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
});
el.text.addEventListener('input', () => {
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
  drawModeOn = on;
  el.drawMode.classList.toggle('active', on);
  el.debug.classList.toggle('drawing', on);
  el.drawMode.textContent = on ? '✎ drawing… (Esc to stop)' : '✎ draw stroke';
}

el.drawMode.addEventListener('click', () => setDrawMode(!drawModeOn));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawModeOn) setDrawMode(false);
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
  if (selection) {
    const hit = nearestVertex(selection, at, 9);
    if (hit != null) drag = { pointIndex: hit, last: at, lo: hit, hi: hit };
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
    const dx = (at[0] - drag.last[0]) / debugLayout.s;
    const dy = -(at[1] - drag.last[1]) / debugLayout.s;
    const range = nudgeStroke(g.record, selection.strokeIndex, drag.pointIndex, dx, dy, g.record.unitsPerEm * 0.12);
    if (range) { drag.lo = Math.min(drag.lo, range[0]); drag.hi = Math.max(drag.hi, range[1]); }
    drag.last = at;
    pointerDown.moved = true;
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
    const g = analysis.glyphs[selection.glyphIndex];
    if (el.snapInk.checked) snapStrokeRange(g, g.record, selection.strokeIndex, drag.lo, drag.hi);
    drag = null;
    pointerDown = null;
    commitRecordEdit(selection.glyphIndex);
    return;
  }
  drag = null;
  pan = null;
  if (pointerDown && !pointerDown.moved) {
    const [x, y] = canvasPoint(e);
    selection = hitTestStroke(debugLayout, analysis, x, y);
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

el.moveEarlier.addEventListener('click', () => moveSelected(-1));
el.moveLater.addEventListener('click', () => moveSelected(1));

el.reverseStroke.addEventListener('click', () => {
  if (!selection) return;
  const g = analysis.glyphs[selection.glyphIndex];
  g.record.strokes[selection.strokeIndex].points.reverse();
  if (selection.pointIndex != null) {
    selection.pointIndex = g.record.strokes[selection.strokeIndex].points.length - 1 - selection.pointIndex;
  }
  commitRecordEdit(selection.glyphIndex);
});

el.splitStroke.addEventListener('click', () => {
  if (!selection || selection.pointIndex == null) return;
  const g = analysis.glyphs[selection.glyphIndex];
  if (!splitStroke(g.record, selection.strokeIndex, selection.pointIndex)) return;
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
  commitRecordEdit(gi);
});

el.resetGlyph.addEventListener('click', () => {
  if (!selection) return;
  const g = analysis.glyphs[selection.glyphIndex];
  store.delete(analysis.fontKey, g.gid);
  selection = null;
  run();
});

el.deselect.addEventListener('click', () => {
  selection = null;
  refreshSelectionUI();
});

el.clearcache.addEventListener('click', () => {
  store.clear();
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

el.showpen.addEventListener('change', () => {
  animator.showPen = el.showpen.checked;
  animator.drawAt(animator.time);
});

el.copyjson.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.json.textContent);
  el.copyjson.textContent = 'Copied';
  setTimeout(() => (el.copyjson.textContent = 'Copy'), 1200);
});

el.exportsvg.addEventListener('click', () => {
  if (!penResult) return;
  const svg = penToSvg(penResult, { pxPerEm: 160 });
  const name = `handwriting-${penResult.text.replace(/\W+/g, '_')}.svg`;
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), name);
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
    if (!analysis && !penResult) return;
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
document.querySelector('.topbar h1 span').textContent = `prototype v${version}`;

