# Even but animated cursive: research notes (2026-09-03)

Findings of a research pass on how practitioners produce script-font evenness
while still animating a pen; they informed the geometry-first rebuild of the
pen model in v0.12.0.

## Architecture: geometry first, dynamics only for time

1. Skeleton = a static spline through few anchors with pinned tangents (stem
   tops and feet, join points), designed upright and sheared to the slant.
   A kinematic simulation must never produce geometry: that was the source
   of the wobble.
2. Pen = a width function of the local stroke direction applied to the fixed
   skeleton (Noordzij's "expansion" contrast for the pointed pen,
   "translation" for the broad edge).
3. Joins = one fixed exit point/angle convention plus a handful of
   contextual alternates; as the layout engine we can place the next glyph
   so its entry anchor coincides with the previous exit.
4. Timing = a speed profile along the fixed path (minimum jerk / two-thirds
   power law, or lognormal bells re-parameterised by arc length), used only
   to reveal the pre-computed outline.

## Connected script typefaces

- `.start/.between/.end` forms via `calt`; the right side of one letter meets
  the left side of the next at the same height; alternate `.between`
  variants on doubled letters (FontCreator tutorial).
- Connecting ends carry zero side bearings so the last node of one letter
  sits exactly on the first node of the next; extend the connecting bits by
  a unit to avoid hairline gaps (Glyphs forum).
- Letters connect at different heights, so entry or exit strokes may have to
  move (Type Network, "OpenType at work"); Gautreaux needs only four
  alternates (r s x z, the letters with entry strokes); b o v loops were
  closed to avoid high-exit disconnections (Alphabettes).
- Calligraphic conventions: lowercase joins at the baseline via the hairline
  entrance stroke; b o v w exit at the midline and need a bridge.
  Spencerian: main slant 52°, connective slant 30° from the baseline;
  Copperplate 55°, proportions 3:2:3 (ascender : x : descender), Engrosser's
  2:1:2.

## Skeleton plus pen

- METAFONT sweeps an oriented ellipse (`pencircle xscaled .. yscaled ..
  rotated ..`) along a skeleton; Metaflop exposes pen width, contrast,
  superness, slant, overshoot; Prototypo is skeleton based.
- Noordzij's contrasts (translation, expansion, rotation); LTTR/INK maps them
  to imprint shape, scale and angle with a "contrast tilt".
- Width functions in tools: Inkscape calligraphy (angle, fixation, thinning),
  DynaDraw's mass-spring filter.
- Pointed-pen practice: hairline = the nib's point at zero pressure; full
  pressure from the top of a downstroke, held to the baseline, released
  quickly. Implement `w = hair + (shade - hair) · env(s) · smoothstep(max(0,
  -t̂·ŷ))` with an attack/release envelope.

## Curve primitive

- Hobby's algorithm (recommended): interpolating, first and approximate
  second order geometric continuity, a linear-time tridiagonal solve; handle
  length ρ·chord/(3τ) with ρ = (2+α)/(1+(1-c)cosθ + c cosφ). Tangents can be
  pinned at knots. JavaScript ports: arnoson/hobby-curve (ISC; the one
  vendored in src/pen/hobby.js), jakelow.com/blog/hobby-curves (ISC),
  loopspace/jsHobby. Caveat: global - moving a knot can change the whole
  run; fine for static glyphs.
- Spiro / Euler spirals: G2-G4 knots (libspiro, spiro-js), but the solver can
  fail to converge and loops can reverse ("stiff spring steel").
- Centripetal Catmull-Rom: C1 only, no cusps or self-intersections, but the
  curvature jumps at knots show once a pen expands the stroke.

## Timing separate from geometry

- Two-thirds power law: v = K·r^(1/3); minimum-jerk bell 10t³-15t⁴+6t⁵;
  Todorov & Jordan 1998: for a given path the jerk-minimising speed profile
  reproduces both; Viviani & Flash 1995 on isochrony.
- Sigma-lognormal is a velocity model; iDeLog separates spatial virtual
  targets from lognormal timing. Modal stroke about 100 ms, about 3
  characters a second.
- Animation tools reveal a filled thick/thin glyph by animating a stroke
  along a fat skeleton mask (stroke-dasharray), with per-path easing.

## Baseline and evenness

- Overshoot 1-3 % of x-height for rounds and points, none for flat stems;
  alignment zones snap extrema.
- Design upright, shear x += y·cot(slant): 0.70 for 55°, 0.78 for 52°.
  Loops 1.5× (3:2:3) or 2× x-height (2:1:2).

## Pitfalls

Dynamics generating geometry; Catmull-Rom curvature kinks under a pen; Spiro
divergence at sharp entries; forgetting the one-unit join overlap; applying
overshoot to stems; any per-instance randomness in geometry (put it in the
timing only).
