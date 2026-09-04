# Handwriter — brief for a second opinion

**Version in this package: 0.12.0.** Plain JavaScript + Vite, no build step
needed to read the code, no framework, no TypeScript. Everything that runs is
in `src/`, `scripts/` and `index.html`.

## What the project is

A browser prototype that **animates text being handwritten** in cursive. Two
independent engines share one player:

1. **Pen model** (the default, and the part that matters for this review) —
   synthesises handwriting with no font involved: each letter is a list of
   waypoints in an x-height frame, joined into words, drawn as a smooth path,
   inked by a simulated nib, then paced so a pen can be animated along it.
2. **Font route** (older, still working) — takes a real cursive font, shapes
   it with HarfBuzz, rasterises each glyph, thins it to a skeleton, recovers
   a plausible pen order by beam search, and reveals the font's own outline
   behind a moving nib. It also feeds the "fit a hand from a font" feature.

## The acceptance criterion

The owner's target is the evenness of a good calligraphic **script font**
(Pinyon Script / Great Vibes / Bickham): repeated letters identical, feet
exactly on the baseline, uniform slant, tangent-continuous joins with no
notches, clean thick downstrokes and hairline upstrokes — while still
animating with a natural rhythm.

Current output is in `samples/` (see below). The gap the owner has flagged, in
order of how often it has been raised:

- kinks and bumps at the inter-letter joins, especially where a stem's foot
  turns into the rise toward the next letter;
- a general "unsteady hand" wobble — repeated letters (the two `l`s in
  "hello") not identical, loops not clean;
- letters ignoring the baseline (feet floating above or dipping below).

Version 0.12.0 is a rewrite aimed at exactly these three points; the owner has
not yet approved the result, hence this review.

## Architecture as of 0.12.0 (geometry first)

Earlier versions **generated the geometry with a kinematic model**: a
sigma-lognormal superposition of velocity strokes aimed at virtual targets,
integrated at 200 Hz. That was the root cause of all three complaints — the
shape of a letter depended on stroke overlap and timing, so nothing landed
exactly anywhere. It has been inverted:

```
letters (waypoints)  →  layout + joins  →  ONE path per pen-down chain  →  nib width  →  pacing
   src/pen/hand/*        src/pen/compose.js   src/pen/spline.js (+hobby.js)   compose.js    pace.js
```

- **`src/pen/spline.js` + `src/pen/hobby.js`** — every pen-down chain of
  waypoints is drawn with **Hobby's algorithm** (METAFONT's curve:
  interpolating, near-continuous curvature). `hobby.js` is a vendored ISC
  port of `arnoson/hobby-curve`, kept close to the published source; the
  wrapper falls back to centripetal Catmull-Rom if the solve misbehaves. The
  chain is split at explicit stops so a reversal stays a point.
- **`src/pen/compose.js`** — lays letters out (shear for slant), and at a
  join **drops the previous letter's own foot** and writes the connector
  itself: a tight bounce arc (radius 0.15 x-heights, and the stem is cut at
  the height that puts the bounce's lowest point exactly on the baseline), a
  straight run, and a wider entry arc (0.4 x-heights) into the direction the
  next letter's lead-in would have had. All three are sampled into the same
  chain, so the spline carries them. Also computes nib width as a function of
  direction of travel.
- **`src/pen/pace.js`** — timing only, along the fixed path: a lognormal bell
  per run between stops, modulated by the two-thirds power law (v ∝ κ^(−1/3))
  and by the shade, with a dwell at stops.
- **Looseness** (the "hand" variability) now only offsets/scales a letter as a
  whole and varies the timing; it never bends a stroke.

Research that informed this is summarised, with sources, in
`docs/research-even-script.md`.

### Letter data

`src/pen/hand/*.js` — the alphabet, authored by hand as dense waypoints in a
frame with baseline 0 and x-height 1, grouped (ovals, arches, loops,
descenders, capitals A–M, N–Z, "small" = r s x, plus a separate italic
lowercase). `src/pen/hand/GUIDE.md` documents the conventions. A letter entry
is `{ width, exit, joinTarget, stops, waypoints, marks }`:

- `exit`: `'base'` (foot), `'mid'` (checkstroke of b o v w), `'none'`;
- `joinTarget`: index of the waypoint a connector lands on, or
  `{ base, mid }` for a different landing per connector type;
- `stops`: waypoint indices where the pen halts regardless of turn angle;
- `marks`: i-dots, t-bars, the x's cross, capitals' extra strokes.

`src/pen/letters.js` still derives arcs/gaps/pressure per waypoint (a legacy
of the kinematic era); `compose.js` now only reads the stop flags out of it.
**This is known redundancy** — see question 4.

## How to run

```
npm install
npm run dev        # http://localhost:5173
```

Headless (no browser; renders SVG and, on macOS, PNG via qlmanage):

```
node scripts/pen-check.mjs                                   # checks + alphabet sheet
node scripts/pen-check.mjs --scale=0.6 --png --out=x.svg "hello"
node scripts/pen-check.mjs --png --out=p.svg "oa ob oc" "na nb nc"   # each arg = one row
node scripts/pen-check.mjs --proof --letters=abcdefghi --out=q.svg --png
node scripts/pen-check.mjs --hand=copperplate|palmer|broad|italic ...
node scripts/pen-check.mjs --var=0 ...                       # looseness off
```

The checks must print no `!!` lines. Pair sheets ("every letter after o",
"after n") are the fastest way to see join defects.

## Samples in this package

`samples/` — rendered from the code as packaged.

| file | what it shows |
| --- | --- |
| `clean-0*.svg/.png` | the app's own SVG export: finished ink, no debug marks. Start here. |
| `01-hello-large.*` | "hello" large, with waypoint markers (orange circles = authored waypoints; ignore them when judging shape) |
| `02-words.*` | five rows of words |
| `03-joins-after-o.*` | every letter following `o` — the join diagnostic |
| `04-proof-a-i.*` | letters a–i drawn individually with guides |
| `05-copperplate.*`, `06-italic.*` | two other hands from the same letters |

## What I would like reviewed

1. **Is the geometry-first architecture right, or is the data model the real
   limit?** Letters are pure point lists: no per-point tangents, no per-point
   width, no explicit cusp type beyond a stop flag. Hobby's spline infers all
   curvature from point spacing, so letterform quality depends entirely on
   where the waypoints were placed by hand. Would authoring letters as
   Bézier/skeleton segments **with explicit tangents at anchors** (the way a
   type designer or METAFONT would) be the necessary next step to reach
   script-font quality, or is dense-waypoints-plus-Hobby sufficient and the
   remaining problems are just bad waypoints?

2. **Joins.** The connector is currently *computed* (bounce arc + run + entry
   arc, radii fixed in x-heights). Script fonts instead *design* the exit and
   entry strokes into the glyphs and standardise the connection point and
   angle, with a handful of contextual alternates. Which approach will get to
   "no notches, ever" faster here, given that this engine controls the layout
   and could place letters so that anchors coincide exactly?

3. **Baseline discipline.** The bounce is analytically placed so its lowest
   point is on the baseline (`compose.js`, the `targetY` computation). Is
   there a cleaner formulation — e.g. constrain the spline itself with a
   baseline tangency condition, or author feet as explicit arcs — and should
   round bottoms get the typographic 1–2 % overshoot?

4. **Redundancy / dead weight.** `src/pen/letters.js` still computes arcs,
   overlaps and pressure per waypoint although only the stop flags are read;
   `src/pen/lognormal.js` is now used only for the shape of a bell in
   `pace.js`. Worth collapsing? Any other structural cruft you would remove?

5. **The width (nib) model.** Width is a function of direction of travel only,
   smoothed along the path, tapered at chain ends
   (`nibWidths` in `compose.js`). A real pointed pen's pressure also depends
   on *where in the stroke* the pen is (attack at the top of a downstroke,
   release at the baseline). Is the current model the reason the ink still
   reads slightly "brushy" rather than "pointed pen"?

6. **Anything that would make the animation itself more convincing**
   (`src/pen/pace.js`, and `src/render/animator.js` which drives the canvas).

7. Any correctness bugs, edge cases, or performance traps you notice. The
   engine is exercised by `scripts/pen-check.mjs`; there is no unit-test
   suite (a fair criticism in itself).

## Not part of this review, but included because they are in the tree

- The whole **font route** (`src/lib/*`, `src/render/sweep.js`,
  `src/render/animator.js`'s reveal path) — the older engine. It works; it is
  not what the owner is unhappy about.
- **`src/pen/fit.js`** + `docs/plan-font-fit.md` — deriving a pen-model hand
  from a font's recovered strokes.
- `README.md` is long (46 KB) and documents both engines plus the research
  behind them. The pen-model sections are the relevant ones ("The pen model",
  "Geometry first", "Joins", "Pace").

## Note on the font files

`Autography.otf` / `FONTFILE.otf` (identical) are a third-party test font the
owner uses locally with the font route; they are included so the project runs,
not for redistribution.
