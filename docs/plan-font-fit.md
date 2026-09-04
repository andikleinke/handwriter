# Milestone 4 plan: fitting a pen-model hand to a font

Status (v0.10.0): implemented as planned in src/pen/fit.js, src/lib/handStore.js
and the pen controls of src/main.js, with two deviations: validation runs in
the browser right after the fit (a symmetric Chamfer distance per letter is in
the fit report) instead of a Node script, and the tempo is calibrated by
composing the alphabet and matching the school hand's pace in x-heights per
second rather than by waypoint density.

Written 2026-09-02 by a planning agent from the code as it stood; kept here
as the working plan. Corrections found while reading the code: (a) glyph
records (`recoverGlyphStrokes` in src/lib/strokeRecovery.js, RECORD_VERSION
21) carry `strokes[].points` (font units, glyph origin), `role`
(body/dot/accent/crossbar), `retraces`, `startWidth/endWidth` and
`stats.strokeWidthPx.median`, but no per-point radius: radii are sampled from
the distance map as `sampleChain` in src/render/sweep.js does
(`inkInfo(g.raster).dist` at `fontToRaster`). (b) `composeWord` reads the
module constant LETTERS; a fitted hand needs `style.letters ?? LETTERS`.

Measured on Autography (26 lowercase records): upem 1000, x-height 197 u by
`loadFont`'s median-of-tops (OS/2 says 500; keep the measurement), cap height
704 u (3.6 xh), ascenders about 3.0 xh, descenders about -1.9 xh, italic
angle 0 and stems measured 0°, median radius 0.09 xh with down/up medians
0.10/0.09 (a monoline brush). Exit hairlines are thin (0.02–0.05 xh) and
long (up to 1.2 xh), ending at y 0.5–0.8; entries are blunt stubs starting
at x ≈ -0.2 xh. So this face joins at x-height, and letters overlap the
advance on both sides.

## 1. Chains to letter-frame waypoints (src/pen/fit.js)

- Frame: `toFrame(p) = [(p.x - p.y·shear)/xh, p.y/xh]` with `shear =
  tan(slant)` (unshear so the letter is authored upright; the composer
  re-applies the slant). x is measured from the glyph origin, not the ink
  bbox: `width = xAdvance/xh` and `style.spacing = 0`, so side bearings and
  overlapping hairlines survive; negative x is fine for the composer.
- Roles: first body chain = the letter; further body chains and
  dot/crossbar/accent chains become marks (a dot as `[[x,y]]`, others
  resampled), matching `letterFromWaypoints`.
- Entry and exit as exactly one segment each. Exit hairline = the tail where
  radius < 0.5·glyph median for the rest of the chain, capped at 0.3 em,
  else the run after the last turning point; it collapses to the single
  provisional last waypoint. Entry stub = the head up to the first turning
  point, capped at 0.22 em, collapsed to `waypoints[0]`, with `joinTarget
  = 1`. Fonts without hairlines get synthetic ones: prepend `[x0 - 0.15, y0 -
  0.25]`, append `[x1 + 0.15, y1 + 0.25]`. `letterFromWaypoints` accepts an
  explicit `joinTarget`.
- Cusps from the chain: turning over a ±0.06 xh window > 150° plus every
  `retraces[].from/to`; kept as waypoints with close neighbours so
  `targetsFromWaypoints` sees the reversal.
- Density: arc length 0.12 xh, curvature-merged: drop a sample when the
  turn since the last kept one < 12° and the segment stays < 0.4 xh
  (otherwise a 9.6-xh `b` becomes 80 strokes and 3 s of writing).
- exit = 'mid' if the last body point y > 0.45, else 'base'.

```js
export function fitHand({ name, metrics, letters }, opts = {}) // letters: [{ch, record, raster, xAdvance}]
  -> { hand: { name, version, letters: {ch: {width, exit, joinTarget, waypoints, marks, confidence}}, style }, report }
export function sampleChains(record, raster, stepFu)  // [{role, pts, radii, cum, retraces}]
export function measureSlant(samples, xh)             // degrees from vertical
export function letterFromChains(ch, samples, frame, opts)
export function nibFromRadii(all, up, down, xh)       // {type, wMin, wMax, angle?}
```

## 2. Style parameters

- slant: weighted median direction of near-vertical (±25°) thick (radius ≥
  median) runs ≥ 0.3 xh; `post.italicAngle` only as a prior.
- x-height ratio: `metrics.xHeight/unitsPerEm`; store `style.unitsPerEm =
  1000`, `style.xHeight = 1000·ratio` so em/s on the speed slider keeps its
  meaning.
- Nib (widths in x-heights): `wMono = 2·p50(all)/xh`; `wMin = 2·p50(up)`,
  `wMax = 2·p50(down)`; ratio < 1.25 → mono, else pointed; if the radius
  correlates better with `|sin(θ - φ)|` → broad with angle φ. `slowShade`
  0.4 when ratio > 2.5.
- spacing 0 (width is the advance); lift, variability, skew from BASE; tempo
  scaled so waypoints per x-height of path match the school hand's.
- Record capHeight/xh, ascender/descender ratios in `hand.metrics`.

## 3. Validation

`scripts/fit-check.mjs --hand=hand.json [--font=FONTFILE.otf] [--letters=…]
[--png]`: the hand JSON exported by the UI carries `letters[ch].source.chains`
in font units (recovery needs canvas and cannot run in Node). Per letter:
`composeWord(ch, {...style, letters, variability: 0})`, scale to font units,
report (a) the symmetric Chamfer distance to the source chains in em and (b)
the ink-hit rate inside the glyph outline via opentype.js when `--font` is
given. Fail at Chamfer > 0.06 em or hit rate < 0.85; draw a sheet with the
outline in grey under the ribbon. `pen-check.mjs` gains `--hand=path.json`.

## 4. Where the code goes

- src/pen/fit.js: pure; imports inkInfo, fontToRaster, resample,
  cumulativeLengths only.
- src/lib/handStore.js: mirror fontStore.js (DB `handwriter-hands`, store
  `hands`, list/get/add/remove, choice in localStorage); records `{id, name,
  fontKey, added, hand}`.
- src/pen/letters.js: joinTarget passthrough. src/pen/compose.js:
  `style.letters`.
- src/main.js: button `#penfit` ("Fit hand from this font") in `#penrow`;
  `fitHandFromCurrentFont()` shapes each of a–z, A–Z alone through
  `analyzeWord(fontCtx, ch, store, {rasterEm, connect: false})` (isolated
  forms) in a yielding loop with progress in `#fontinfo`, then `fitHand`,
  `handStore.add`, refresh `#penhand` (built-ins, then an optgroup of fitted
  hands with values `fit:<id>`), select it, run(). `currentPenStyle()` /
  `applyPenPreset()` go through `handById(id)`. The fit report goes into
  `#log`, the hand JSON into `#json`; "Remove" for a fitted hand.

## 5. Risks and open questions

- Wrong chains: most test glyphs carry start-point warnings; `l`/`f` start at
  the loop top, `p` at the descender bottom, `t` is a swash form. Inherit,
  but score each letter (templateFit plus "net rightward, entry in the left
  third") into `confidence`, list it in the report, and rely on the editor:
  fix the glyph in the font route, refit. No chains → fall back to the
  built-in letter and note it.
- Fonts without lead-ins: synthetic hairlines, or write unjoined; a
  `style.join` flag defaulting to joined when the exits are hairlines.
- Capitals: several body chains → marks; swashes far outside the advance;
  never join.
- Density vs tempo: curvature-merged resampling (recommended).
- Performance: 52 recoveries × 50–80 ms plus re-thinning for inkInfo ≈ 4–5 s
  on the first fit, cached afterwards.
- Kerning ignored (advance only); contextual alternates ignored.

## Steps

1. letters.js joinTarget passthrough; compose.js style.letters (S).
2. fit.js: sampleChains, measureSlant, nibFromRadii, ends/cusps/resampling,
   letterFromChains, fitHand (L).
3. handStore.js (S).
4. main.js + index.html: fit button, picker, handById, report/JSON (M).
5. scripts/fit-check.mjs + pen-check.mjs --hand (M).
6. Tune on Autography against the sheet; README section (S–M).
