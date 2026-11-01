# Handwriter — status

Updated 2026-11-01. Current release: v0.45.0 (2026-10-19), deployed at https://andikleinke.github.io/handwriter/.
Working tree clean; no unreleased changes.

## What works

- **Font route** (the only route since v0.23.0): HarfBuzz shaping → raster → skeleton → stroke-order recovery
  (pointed-pen rules for formal scripts, loop entries, crossbar rule) → pen plan with bridges between letters →
  vector ribbons fitted to the outline (stroke renderer, default since v0.28.0) with the raster reveal as fallback.
- **Fonts**: Pinyon Script (default), Autography (with a bundled hand of corrected letters), Ms Madi; any
  .otf/.ttf via the font picker.
- **Letter Studio**: per-letter view with an A–Z strip, verdicts from an alphabet check running in a worker,
  editor (split, delete, add, nudge, snap, draw, place points, Bézier handles, width keys, undo/redo), hand
  export/import; corrected letters persist in localStorage.
- **Player**: speed, pen tip, natural speed, loop, connect letters; multi-line text.
- **Export movie** with alpha: ProRes 4444 or HEVC-with-alpha through the dev server's Mac encoder; ProRes 4444 in
  the browser via ffmpeg.wasm (works on the hosted site). No SVG export since the pen model went.
- Versions list from the page title; `node scripts/release.mjs` releases.

## Known limitations and bugs

- The o's parallel-retrace seam (outline-reveal renderer only) is unsolved; the stroke renderer sidesteps it.
- Autography/Pinyon x: the hairline needs a different centreline (XOR vs outline worst there).
- A letter's recovered tips are round; slanted cuts (the a's apex) come out rounder than the font's.
- Pinyon capitals fail the pointed-pen check more often; the J's body stroke starts on the bar's left half.
- calt alternates have their own glyph ids, so a hand correction on the plain letter does not reach the alternate.
- Hosted site: movie export only via the wasm ProRes route; HEVC-with-alpha needs the dev server on a Mac.

## Next steps

- Possible: a Mac-native shell (WKWebView + in-app server + the Swift encoder) for HEVC-alpha export without the
  dev server (estimated 1–2 h, still open).
- Digits and punctuation; italic capitals; per-letter fit refinements against the outline.
- The idea of integrating Handwriter into Aaron (Keynote palette) was dropped on 2026-10-17.
