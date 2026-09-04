# Authoring hand-refined letters for the pen model

Each letter is a list of **dense waypoints** in the letter frame; the model
derives strokes, arcs, overlaps and pressure from them (see ../letters.js).

## Frame
- Baseline y = 0, x-height y = 1, ascenders reach about 2, descenders about -1.
- x runs in x-heights from the letter's left edge (0) to its `width`.
- Author **upright**: the hand's slant is applied afterwards by the composer.

## Entry and exit
- Letters entered from the baseline start at `[0, 0]` with a lead-in rising
  to x-height (or up into an ascender loop). A join from the previous letter
  lands on the *second* waypoint (the top of the lead-in), and the lead-in
  itself is dropped.
- Ovals (a c d g o q) start at their top right, about `[0.78, 0.92]`, and run
  counter-clockwise; they have no lead-in, a join lands on the start.
- The **last waypoint is the exit**, provisional: for most letters
  `[width, 0.9]` rising from the baseline (`exit: 'base'`); for b o v w a
  checkstroke at x-height (`exit: 'mid'`), i.e. a small dip and out at ~0.9.
- Marks written after the word: `marks: [[[x, y]]]` for a dot,
  `[[[x1, y1], [x2, y2]]]` for a bar or a second slant. Capitals: further
  strokes as marks too (they follow the letter with a lift); capitals never
  join, so their exit is ignored.

## Density and cusps
- 8–16 waypoints per letter; at least 3 around any loop, bowl or arch. Dense
  is the point: the kinematic model cuts every corner it is given, and a loop
  drawn as one long stroke loses half its height.
- A reversal sharper than ~150° between consecutive waypoints becomes a
  **cusp**: the pen stops and turns (the top of an i or t, a retraced stem).
  Gentler turns round off.
- Pressure is automatic: downward travel is shaded, upward is hairline.

## Proportions (Zaner-Bloser looped cursive, in x-heights)
- Ascender loops about 0.3–0.4 wide and 2 tall, closing on the stem near
  x-height; descender loops to -1, about 0.4 wide, closing on the stem at the
  baseline; ovals 0.6–0.75 wide, filling the x-height; arches (m n) round at
  the top; retraces (i t d p) go up and come back down the same line.
- Widths: a .9 b .9 c .85 d 1 e .9 f .8 g 1 h 1.15 i .5 j .6 k 1.1 l .7
  m 1.7 n 1.15 o .9 p 1 q 1 r .75 s .75 t .6 u 1.15 v .9 w 1.4 x .9 y 1 z .9.
  Capitals: 1.5 wide, 1.5 tall (cap height), tails to about -0.5.

## Format
```js
export const ovals = {
  a: { width: 0.9, exit: 'base', waypoints: [[0.78, 0.92], [0.5, 1.0], ...] },
};
```
An entry here overrides the derived letter of the same name.

## Workflow
- Proof of your letters, large, with targets:
  `node scripts/pen-check.mjs --proof --letters=acdo --out=pen-proof-ovals.svg --png`
  then read `pen-proof-ovals.png` (an image). Keep proofs to at most 9 letters.
- In context: `node scripts/pen-check.mjs --png --out=pen-words-ovals.svg "a quick brown fox"`
  then read `pen-words-ovals.png`. Each argument is one row: pass several
  short rows rather than one long one (the PNG is a square crop, about 6 em
  wide).
- Joins: a letter's `joinTarget` is the waypoint a connector lands on; put it
  at the top of the lead-in (the cusp, the loop's crossing, the shoulder) so
  the connector, which is shaped by the composer, replaces the lead-in. It
  may be `{ base, mid }`: an undercurve from the baseline and a level bridge
  from a checkstroke (b o v w) may want different landings.
- `stops: [i, …]`: waypoint indices where the pen halts whatever the turn
  (a pointed top, the closing of an oval). Without it only a reversal sharper
  than ~150° stops the pen.
- The checks: `node scripts/pen-check.mjs` must print no `!!` lines.
- Edit only your own group file. Do not touch other files, the dev server or
  the browser.
