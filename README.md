# Handwriter — stroke recovery prototype

Proves the hard part of the "type text → get a video of it being handwritten"
idea: recovering **centrelines** and a **plausible pen stroke order** from a
static cursive font, then animating a pen along those centrelines - painting
its own stroke at the font's ink width, so the letters form as they would on
paper.

Default font: `PinyonScript-Regular.ttf` (SIL OFL), bundled since v0.14.0.
Earlier test font: `FONTFILE.otf` in this folder (byte-identical to the `Autography.otf`
copy next to it — the app loads `FONTFILE.otf`). Any other `.otf`/`.ttf` can be
dropped in through the font picker.

The build's version is in the page title (`Stroke recovery prototype vX.Y.Z`,
from `package.json`), so a screenshot or a recording names the build.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173.

## What to try

1. **"hello"** (the default) is written by the **pen model** in the **looped
   school hand**: letters from taught strokes, joined by connectors, timed by
   the kinematic model, inked by a pointed nib. The **Hand** picker offers the
   school hand, Palmer, Copperplate and a broad-edge nib; **Slant**, **Tempo**
   and **Looseness** override the hand, **Nib** swaps the pen, **Another take**
   rewrites the text with fresh small deviations.
2. Several lines: Shift+Enter in the text field starts a new line (Enter
   analyses); **Wrap at** breaks the text by word at a width in em.
3. **Export SVG** saves the written word as vector ink; **● Record** captures
   one run of the preview as a video.
4. **Fit hand from font** derives a hand from the current font: the font
   route recovers every letter's pen path, and the pen model then writes in
   the font's letterforms with its own joins and dynamics. Fitted hands are
   kept in this browser and listed under the built-in ones, with **Remove
   hand** and **Download hand**; the fit report appears with the word's
   notes.
5. Switch **Source** to the **font outline** for the recovery route: HarfBuzz
   returns **4 glyphs** for "hello" — `h`, `e`, `l_l`, `o` — where a naive
   per-character lookup would give 5; the `liga` feature fires, so the
   pipeline is genuinely shaping rather than looking up characters. It
   recovers as 4 strokes, and with **connect letters** on, "hell" is written
   as one continuous pen-down motion: the dotted grey connectors in the debug
   view are the bridges. **"flighty"** exercises the i-dot (drawn after the
   letter body), the t-crossbar (deferred to last) and two descenders;
   **"Jazz it up!"** capitals, whitespace, punctuation and a contextual
   alternate (`t.1`, chosen by `calt`).
6. The **Font** picker offers the bundled faces first (Pinyon Script, then Autography) and every font
   you have added with **+ Add font…**; added fonts are kept in this browser
   (IndexedDB) and offered again next time, and **Remove** forgets the selected
   one. The last choice is remembered.
7. Tick **raster + skeleton** (font route) to see the binary bitmap and thinned
   centreline each glyph was actually derived from. This is the view that
   tells you whether a bad result is a heuristics problem or a rasterisation
   problem.
8. The preview has player controls over its bottom edge: play/pause, **●
   Record**, and a scrub bar with the time. Drag the bar to step through the
   animation, or change **Avg speed** (up to 4 em/s). **Pen tip** marks the
   pen, on paper and in the air. **Natural speed** toggles the research-based
   velocity model against constant speed; **connect letters** toggles the
   bridging (font route); **loop** runs the animation continuously.
9. **Zoom the debug view** (up to 800%) with its − / + / fit buttons, or by
   scrolling over it — zoom happens at the cursor. Drag empty space to pan.
   Stroke lines, handles and badges keep their screen size, which is what
   makes zoomed editing easy. The animation preview always shows the whole
   text.
10. Read the **uncertainty log** — ambiguous junctions, near-tied starting
    points, deferred crossbars, reversed strokes; with the pen model, the
    grammar's notes and a fitted hand's report.
11. **Copy** / **Download** the JSON to see the cacheable data layer.

## Pipeline

```
text
 └─ HarfBuzz (WASM)          shape → glyph ids + positions (calt, liga, kerning)
     └─ opentype.js          outline for each glyph id HarfBuzz returned
         └─ rasterise        high-res binary bitmap (default 512px/em)
             └─ Zhang-Suen   thinning → 1px skeleton
                 └─ graph    endpoints + junctions as nodes, runs as edges
                     └─ order   heuristics → ordered, oriented pen strokes
                         └─ smooth  resample → average → simplify
                             └─ JSON   strokes in font units
```

### Stroke-order heuristics

Rather than committing to one greedy walk, each connected component is walked
from **every plausible starting node**, and the whole decomposition is scored:

| term | meaning |
| --- | --- |
| longest-stroke share | reward one dominant continuous stroke |
| extra strokes | penalise lifting the pen more than topologically necessary |
| retrace | mild penalty per unit of path that re-covers written ink; and where a candidate has fewer strokes than the letter's convention, a strong one per em of any single run back beyond 0.35 em (running back a K's whole arm to avoid the conventional lift is tracing, not writing) |
| turn | penalise sharp corners taken at junctions |
| start top-left | the pen should enter near the top-left |
| entry | lowercase: a loose end at the far left, low, heading right outranks top-left — that is where the previous letter hands the pen over |
| net rightward | cursive progresses left to right |
| downstroke | near-vertical runs should travel downward |
| stress | thick ink is a downstroke, hairline ink an upstroke — read off the font's own distance map |
| template | how well the path follows the letter's conventional cursive motion (below) |
| template strokes | per pen-down more than the letter conventionally has (a `t` has two); fewer is never penalised, since a script face joins what print writes separately |
| contour | per time the pen left a drawn contour that still continued (fonts built from overlapping stroke contours only, see below) |

Every candidate is also judged in **every orientation** - each of its strokes
reversed or not - and the best-scoring orientation is kept, so the direction
of a loop or a stem is decided by the template's order, the entry and the
rightward drift rather than by a rule applied afterwards (that rule used to
reverse an `o` drawn the right way round into a clockwise one).

The walk itself is a **beam search** over junction decisions rather than a
greedy one: at a symmetric crossing (the loop of an `A` cutting its legs) two
continuations score identically and a greedy walk picks by luck. States carry
the edges written so far and a running local score — smoothest continuation,
a Fleury-style penalty for stranding unwritten ink, and credit for reaching
the template's waypoints in order — and the best few dozen survive each
depth. Directions at a junction are read a stroke-width or two *beyond* it:
the skeleton wobbles inside a knot, and a tangent taken right at the node
makes the pairing of branches close to random (the literature's main
practical lesson, see below). Every complete candidate is then judged by the whole-letter score
above, and the readout of the top candidates with their score terms is kept
in each record (`stats.candidates`) so a wrong choice can be diagnosed.

At a dead end the pen **runs back over written ink**: the shortest way over
edges it has already drawn (up to 0.8 em, and only to reach at least 0.06 em
of unwritten ink) to the nearest node with work left, instead of lifting.
That is how the `ll` ligature becomes one stroke — up the second stem, back
down, out the descender — and how the capital `A` of the test font closes
its eye and then runs back a short bit of crossbar to carry on, the way a
hand writes it. (An earlier version could only retrace the pen's own recent
path, so a loop that ended one edge away from the rest could not be closed
without lifting.) Retraced spans are dashed in the debug view. A pen starts
at a loose end; only a letter without one (a closed bowl) is entered
mid-line.

Where two strokes cross, thinning leaves a *knot*: two or three junctions a
stroke-width apart joined by stubs, which makes "carry straight on" look like
a sequence of sharp little turns. `graph.js` contracts those knots into one
node so a crossing is judged arm against arm.

Inside a knot the recovered centreline is not trusted at all. Where two or
three strokes merge into one blob of ink - the distance map there reads far
wider than the stroke's own half-width - thinning detours through the
blob's centre, or runs along the other stroke for a while: the hook of the
test font's `A` arrives on the crossbar and only then turns up into the eye,
which showed as a step in the drawn line. Any curve inside the blob is inside
ink, so the pen takes the smoothest one: a cubic blend from where it enters
the knot to where it leaves, on the entry and exit directions
(`blendKnots()` in `strokeRecovery.js`). Runs that touch a stroke's end,
run longer than a quarter em, or contain a reversal are left alone.

### A pointed pen's rules (v0.14.0)

The bundled default face is now **Pinyon Script** (SIL Open Font License), a
formal Copperplate whose lowercase connects by design: measured on the
outlines, every exit hairline ends at the same place relative to the advance
(0.19 x-heights past it, 0.57 x-heights up) and either overlaps the next
letter's own entry hairline (m n r s x z) or runs into its first shade (every
stem and oval). Autography, the earlier test face, does not connect at all,
which is why its joins had to be invented and never looked right. Great Vibes
and Imperial Script (also OFL) connect the same way and sit in the project
folder for the font picker.

The recovery reads such a face as a pointed pen - two ink widths a factor two
apart on the skeleton, hairline and shade (`detectHand`), every skeleton edge
split where the width changes (`splitEdgesByWidth`) - and then follows the
rules every teacher of Copperplate, Engrosser's and Spencerian script states
(sources at the end of this section):

- **Pressure only on the downstroke.** Thick ink was written downward;
  hairlines go either way. The beam search pays heavily for a shade pushed
  upward, both at the junction and in the whole-letter score that judges
  every reversal of a candidate.
- **A loop turns one way, and its widest shade says which.** The right side
  of an oval rides up under the stem of a d, g or q (a short overlap); the
  swell on the far side of a b's bowl, longer than 0.15 em, is pulled down
  instead. Knots shorter than 0.25 em (the k's, the z's flat loop) carry no
  direction.
- **`a d g q` are written in one movement (v0.15.0).** Pinyon is a Copperplate
  face, where a shade is pulled from its top after a lift, so `d` would be an
  oval and then a separate stem - which on screen hangs in the air until it
  reaches the bowl. Spencer's `d` is one movement instead: the oval, "without
  lifting the pen, the remainder ... formed like the t" (Spencerian Key,
  1866) - up the stem and straight back down it to the baseline. The four
  letters built as an oval with a stem on its right follow him: the pen may
  run back down a whole ascender (1.7 em rather than 0.35), an extra pen-down
  costs them what it costs a monoline hand rather than half, they take no
  voluntary lift to the top of a shade, and the rule against pushing a shade
  upward is lifted for their stem - their loops still turn the way their own
  shade says. Every other letter keeps the engrosser's lift.
- **A shade is pulled in one motion from its top.** Turning off it half-way
  costs, beginning it in its middle costs, and a pen standing at the foot of
  an unwritten stem lifts to the stem's very top (the Engrosser's "raise the
  pen, pull the shade"): the d's stem after its oval, the second stem of a u
  and w where the hairline merges into it, the h after a joined hairline.
- **Entered on the entry hairline, left on the exit hairline.** The loose thin
  end nearest the handover point (this letter's own exit moved back by the
  advance) is the entry; the rightmost loose thin end in the middle heights
  is the exit. The first stroke starts on the entry, the last ends on the
  exit, the stroke holding the handover point comes first, and a hairline
  written towards its tip costs.
- **Lifts are cheap, retraces short.** Engrosser's script lifts after every
  shade, so an extra stroke costs half what it costs a monoline hand, and
  the pen runs back at most 0.35 em over its own ink (a foot, a short stem).
- Caps and stubs under 0.06 em, knot self-loops under 0.05 em and ink
  changes shorter than 0.05 em are ignored by all of this.

The school-cursive templates are off for a pointed pen: they enter every
letter from the baseline, which Copperplate does not. What the rules produce
on Pinyon (`window.__fontCheck()` after an analysis lists it): h, k, l, t,
i, j, p pulled from the top of the stem; c and o from the top of the oval,
counter-clockwise; a, d, g and q in one movement round the oval and up and
down the stem; e from its eye; m, n, r, s, x, z from the entry hairline; u,
v, w, y from the top of the first shade with a lift onto the next; b as one
stroke round its loop and bowl. The pen order of the z and the x is the least
settled (teachers disagree there too).

**Joins for a pointed pen** (`penPlan.js`): where the exit hairline runs
into the next letter's shade, the hairline is written up to the shade's
edge and its tip tucked under the shade - the reveal hides it until the
shade is written - and the pen lifts; the next letter begins at the top of
its own first stroke (a "lift-join", about 120 ms in the air). Where the
exit meets the next letter's own entry hairline the two flow straight on
(a bridge, as before). Mid-stroke landings, which write up a stem, are off.

Records now carry the ink width under every point (`widths`) and the ink a
stroke writes against these rules as the search judged it (`againstRule`).
`scripts/pen-test.mjs` covers the pen model; the font route's invariants run
in the page: `window.__fontCheck()` reports, per glyph, where each stroke
starts (top of a shade, hairline, foot of a shade), shaded ink written
upward, rule violations, and per join whether the pen flowed or lifted.
The alphabet and the pangram pass with no failures.

What the teaching literature says, gathered in two research passes for this
version: pressure is applied on downstrokes only, with a pointed nib no
technique shades an upstroke (Vitolo; the Zanerian Manual: "make all shaded
strokes downward and all light lines upward"); Engrosser's script lifts at
every baseline and pulls each shade from the top after a lift (Zanerian
Manual, Vitolo's h: hairline, lift, shade from the top, loop), while
Spencerian, Palmer and Winters' Copperplate run on continuously from a
baseline lead-in; ovals begin at the top right and run counter-clockwise;
the exit of one letter is the entrance of the next (Winters, Loveleigh
Loops, Spencer); the o, v, w and b leave from a dot at the waist; the x's
crossing is made upward (Spencer) or downward (Vitolo); no source gives a
lift duration.

Sources: Vitolo, Script in the Copperplate Style (zanerian.com) and
Lessons in Engrosser's Script (IAMPETH) · Lupfer, Zanerian Manual of
Alphabets and Engrossing (1924) · Zaner, Lessons in Ornamental Penmanship
(1909); Bloser (1948) · Winters, Mastering Copperplate Calligraphy · Spencer,
Theory of Spencerian Penmanship (1874); Spencerian Key (1866) · Palmer, The
Palmer Method of Business Writing (1935) · Baird, Lessons (zanerian.com) ·
Loveleigh Loops, Copperplate alphabet and connections · Masgrimes,
Engrosser's Script branch · Maxie Calligraphy, lowercase groups.

### What the literature says about recovering the pen's path

The problem - recovering the writing order from a static image - has a
forty-year literature, surveyed for this project (sources at the end of this
section). Its practical lessons, and what this prototype does with them:

- **Thin, build a graph, pick the smoothest traversal.** Every classic method
  (Boccignone 1993; Doermann & Rosenfeld 1995; Jäger 1996; Kato & Yasuhara
  2000; Qiao, Nishiara & Yasuhara 2006; Diaz et al. 2024) works on the
  skeleton graph and chooses, at each junction, the pairing of branches
  closest to straight continuation, with a global objective of least total
  turning, fewest pen lifts and least double-tracing. That is the shape of
  this pipeline. Qiao et al. make it exact (an optimal Euler path after
  matching the odd-degree nodes); the beam search here approximates it, with
  the whole-letter score judging complete candidates.
- **Read tangents outside the knot.** Diaz et al. (2024) and Qiao et al.
  estimate a branch's direction one to two stroke-widths away from the
  junction, because the skeleton inside a knot is an artefact. Adopted.
- **Double-tracing only where a hand would.** Kato & Yasuhara resolve
  odd-degree nodes by double-tracing short branches; Diaz et al. distinguish
  a *T-pattern* (one straight pair and a branch at ninety degrees: two
  strokes, lift) from a *retraced* branch (a short straight branch ending at
  a nearby end-point: run back over it). The walk-back here is bounded the
  same way (short, and only to reach ink worth writing).
- **Direction priors.** Doermann & Rosenfeld's clues - ink width at ends and
  junctions, left-to-right and top-to-bottom, loops and retraces - are the
  stress, rightward, start and loop terms above.
- **Conventions per letter.** Cursive teaching systems (Zaner-Bloser,
  D'Nealian, the German Lateinische and Vereinfachte Ausgangsschrift) agree
  on the essentials: lowercase is entered with an undercurve from the
  baseline; the ovals `a c d g o q` are counter-clockwise from the top
  right; ascender loops (`b e f h k l`) are counter-clockwise, descender
  loops (`g j y z`) clockwise; dots, t-bars and the second slant of an `x`
  come last; capitals are mostly one stroke except `H K X T F`, where the
  vertical comes first. These are the templates in `templates.js`, used as a
  soft term that breaks ties rather than overriding geometry (as Rousseau,
  Anquetil & Camillerapp 2005 recommend: knowledge proposes, geometry
  disposes).
- **Fonts built from stroke contours.** Faces drawn with stroke tools
  (Glyphs, FontLab, Fontself, LTTR/INK) often ship with one overlapping
  contour per pen gesture, and a hand follows a gesture to its end before
  turning off into another. Where a glyph has more than one outer contour,
  every skeleton edge is labelled with the contour it runs through and the
  search pays for leaving a contour that still continues. The test font is
  not built that way (its capitals are one merged outline with counters), so
  the prior is inert there. Contours are hints, not strokes: the two legs of
  an `A` are separate contours and one pen movement, so they are never split
  into strokes outright.
- **Learned models** (Bhunia et al. 2018; Archibald et al. 2021; Moussa,
  Lelore & Mouchère 2023; Google's InkSight 2024) recover trajectories well
  but need paired online/offline training data and models far too large for
  a browser page; Berio et al.'s StrokeStyles (2022) is the training-free
  exception for *stroke extraction* (junction typing on the medial axis)
  but does not give an order.

Sources: Boccignone et al., Pattern Recognition 26(3), 1993 · Doermann &
Rosenfeld, IJCV 15, 1995 · Jäger, ICPR 1996 · Kato & Yasuhara, IEEE TPAMI
22(9), 2000 · Qiao, Nishiara & Yasuhara, IEEE TPAMI 28(11), 2006 · Rousseau,
Anquetil & Camillerapp, ICDAR 2005 · Nguyen & Blumenstein, DAS 2010 · Dinh et
al., Expert Systems with Applications 64, 2016 · Diaz, Crispo, Parziale,
Marcelli & Ferrer, IJIMAI 2024 (arXiv:2406.03194) · Chan, arXiv:1905.06749 ·
Bhunia et al., ICPR 2018 · Archibald et al. (TRACE), ICDAR 2021 · Moussa,
Lelore & Mouchère (SET-SORT), ICDAR 2023 · Mitrevski et al. (InkSight),
arXiv:2402.05804 · Berio, Leymarie, Asente & Echevarria (StrokeStyles), ACM
TOG 41, 2022 · Zaner-Bloser cursive stroke sequences; Mücke, Schreiblehrgang
Lateinische Ausgangsschrift, 2015; ISB Bayern, Vereinfachte Ausgangsschrift,
2006.

### What the teaching literature says about penmanship

A second survey covered how cursive and calligraphy are *taught* - Zaner-Bloser
and D'Nealian, the Palmer Method and the Spencerian manuals, Getty-Dubay
Italic, Handwriting Without Tears, British continuous cursive, the German
Ausgangsschriften and the French school models - and the motor-control
studies behind them. What this prototype takes from it:

- **Per-letter stroke sequences.** The templates in `templates.js` are now
  the taught sequences written out as waypoints (Zaner-Bloser's stroke words,
  with Palmer, Spencerian and Éduscol detail): ovals `a c d g o q` counter-
  clockwise from the top right; ascender loops `b e f h k l` counter-
  clockwise, descender loops `g j y z` clockwise; `k` with its small
  clockwise knot at the stem; `s` pointed at the top with a clockwise bowl;
  `x` in two strokes with the second slant last; capitals mostly one stroke,
  `H K X T F` two or three with the vertical first, and `B P R D` built as
  stem, retrace and clockwise bowls. Two capitals (`A`, `K`) keep forms
  verified against the test face.
- **Joins.** Most letters exit at the baseline rising to the right, and that
  exit *is* the next letter's lead-in. `b o v w` end in a checkstroke at
  x-height (Handwriting Without Tears' "tow truck" letters, `r f t` too in
  British schemes) and join horizontally, and the next letter drops its
  lead-in and is entered at x-height - the bridge's mid-entry mode. Dots,
  t-bars and the second slant of an `x` are added after the word. Capitals
  join only when they end at the right on the baseline (`A C E J K L M N Q R
  U Y Z`); British schemes never join capitals, Nelson breaks after `b g j p
  q x y`, italic does not join out of `g j q y` or into `f z`, and the
  German Grundschrift observes that fluent adults lift after two or three
  letters and before the rotation change into `a c d g o q`.
- **Pressure.** Copperplate shades downstrokes only, with hairline upstrokes
  and connectors, at a 55° slant; Spencerian has five shade forms (heavy at
  the top of `t d`, growing to a square base for `p`, swelling mid-curve in
  ovals and capitals); Palmer is unshaded; Italic takes thickness from the
  direction of travel against a 45° edge. All describe shaded strokes as
  slow and deliberate, hairlines as quick and light, without numbers.
- **Rhythm.** Fluent adults write at about five strokes a second (100–150 ms
  per stroke, one velocity peak per stroke, consecutive strokes overlapping),
  a loop of down-and-up in about 270 ms, stops of at most 35 ms at angular
  junctions only (the top of an `A`, the closing of an `o`, the knot of a
  `k`), lifts of 100–300 ms; downstrokes are the stable "information
  carriers" and upstrokes the variable connectors; Palmer counts one beat per
  stroke and drills ovals at two hundred downstrokes a minute. The speed
  model's stroke bells, its 120 ms lifts and its up/down asymmetry sit
  inside these figures.

Sources: Zaner-Bloser, Cursive Fundamentals Pack and Handwriting G3/G4
(2020) · Palmer, The Palmer Method of Business Writing (1935) · Spencer,
Spencerian Key to Practical Penmanship (1866); Theory of Spencerian
Penmanship (1874) · Learning Without Tears, Can-Do Cursive Teacher's Guide
(2018) · OUP Nelson Handwriting joins; DfE National Curriculum (2013) · ISB
Bayern, Materialien zur Vereinfachten Ausgangsschrift (2006); Grundschul-
verband, Grundschrift Kartei (2017) · DGESCO, Modèles d'écriture scolaire
(2013); Éduscol, La forme des lettres (2015) · Vitolo, Lessons in
Engrosser's Script (IAMPETH) · Van Galen, Human Movement Science 10 (1991) ·
Thomassen & Van Galen, J. Forensic Document Examination 28 (1997) ·
Thomassen & Meulenbroek (1993); Meulenbroek & Thomassen (1991) · Teulings &
Schomaker, Acta Psychologica 82 (1993) · Fitjar et al., Frontiers in
Psychology 12 (2021) · Paz-Villagrán, Danna & Velay, Human Movement Science
33 (2014) · Viviani & Flash (1995).

### The pen model

The **Source** picker chooses between the penmanship engine described below,
the default, and the font route: the word is *written* from a
letter grammar (`src/pen/grammar.js`), drawn as a spline through the
letters' waypoints (`src/pen/spline.js`), inked by a simulated nib and paced
by the kinematic model (`src/pen/compose.js`, `src/pen/pace.js`), with no
font and no skeleton involved. Each letter is a list of waypoints in a frame
with the baseline at 0 and the x-height at 1, points the pen passes through
exactly; a true reversal (the top of an `i`, a retraced stem) is a cusp
where the pen stops and turns, and a letter may mark further stops. Joins
are intrinsic: the composer writes the connector from the previous letter's
last downstroke to the next letter's join target, and the checkstroke
letters exit at x-height. The pointed nib spreads under the shade's pressure
on downward travel and runs hairline on the rest. The debug view shows the
path per chain and the waypoints it passes through; the speed slider scales
the model's own clock. The alphabet - a to z and A to Z - was first derived
from the taught stroke sequences in `templates.js` (`src/pen/letters.js`)
and has since been authored letter by letter (below).
Dots, t-bars and the second slant of an `x` are written after the word; a
capital's further strokes follow it with a lift. Capitals whose last stroke
is the body itself join on into the next letter as the school hand teaches
(A C E J L M N R U Y Z); the rest, and any capital finished by a separate
stroke (H K F T X), end with a lift.

**Geometry first, and frozen (v0.13.0).** Every letter is drawn on its own,
once, as **Hobby's spline** through its waypoints (`src/pen/hobby.js`, a
vendored ISC port of METAFONT's curve: it passes through every waypoint with
near-continuous curvature and no overshoot in practice), split wherever the
pen stops so a reversal stays a point, with the open ends pinned by phantom
knots so the curve leaves and arrives along the stroke (`src/pen/spline.js`).
The composer never re-solves a word: it lays the frozen glyphs out and writes
the connectors between them, so two l's are the same l wherever they stand
(`scripts/pen-test.mjs` checks this to floating-point precision). The nib's
width is a function of the direction of travel along that fixed path (a
pointed pen spreads on downward travel, a broad edge across its angle),
swelling and fading over a short distance, tapered at the ends; marks are
lighter. **Even mode is the default**: looseness varies the timing and the
letter spacing only - never a shape, never a slant, never the baseline.

**Anchors and variants.** Each letter carries named anchors derived once from
its waypoints (`src/pen/letters.js`): the entry a connector lands on, per
kind (`entry.base` from a baseline connector, `entry.mid` from a checkstroke
bridge), the exit at which it hands over when a letter follows (`exit.at`:
the bottom of its last downstroke, which can be cut for a bounce, or the stop
where a checkstroke closes), and its stops. A letter may come in **variants**
chosen by how it is entered: the ovals a d g o q are entered at their bottom
from a baseline connector - along the bottom, up the right side, over the
top, down the left and round to the entry, then up the right side once more,
a hairline over a hairline - so that no connector ever crosses a counter; from
a bridge they are entered at their top right, where the pen halts and turns
back over the oval.

**Joins.** When a letter follows, the previous letter's foot is dropped and
the composer writes the connector from the bottom of its last downstroke: the
stem is cut at the height that puts the bounce's bottom on the baseline
(radius 0.15 x-heights, plus the nib's half-width there), and the connector
is a bounce arc turning from the stem's direction until the pen points at the
next letter's entry, then one cubic Hermite blend arriving along that glyph's
own direction - tangent-continuous throughout, whatever the gap. From a
checkstroke the pen halts at the stop where the letter closes and the bridge
dips off in the direction of the letter's own tick. A word-final foot is
written the same way, ending in the air at the letter's provisional exit.
Capitals whose last stroke is the body itself join on (A C E J L M N R U Y Z);
the rest, and any capital finished by a separate stroke, end with a lift.

**Baseline discipline.** What sits on the line is the visible ink, not the
centreline: after the width is known, wherever the ink's lower edge has a
local minimum near the baseline - a foot bounce, the cusp of an m, the bottom
of a bowl - the path is eased vertically so the edge lands exactly on it; a
round bottom keeps the typographic overshoot of 1.5 %. A connector is shifted
as a whole with long ramps across its junctions, so no tangent is tilted.

**Tests.** `npm test` runs `scripts/pen-test.mjs`: identical repeated letters
in even mode, the ink edge never below the line beyond the overshoot and every
foot bounce on it, tangent continuity and bounded curvature at every join, no
connector through the counter it enters, monotonic times with a true dwell at
every stop, and a pair matrix aa..zz against a snapshot (`--update` to
accept, `--strict` to fail on change).

**Pace.** Along the fixed path the writing is cut into strokes the way a
hand makes them - at every stop, and at every vertical reversal or sharp
turn - and each stroke gets one asymmetric bell of speed (the lognormal
profile of a human stroke, peaking early), floored so the pen slows between
strokes but never crawls, modulated by the two-thirds power law (the pen
slows into tight curves as v ∝ κ^(-1/3)) and, in a shaded hand, by the
shade. A stroke lasts longer the further it reaches, but not in proportion
(isochrony); the pen comes to rest and dwells only at a true stop
(`src/pen/pace.js`). The research behind these choices - connected script
typefaces' join conventions, skeleton-plus-pen construction, Hobby's and
other splines, timing laws - is summarised in `docs/research-even-script.md`.

Four hands share the grammar and differ in slant, tempo, nib and pressure,
with values from the teaching literature: a **looped school hand** (20°,
lightly shaded pointed nib), **Palmer** (25°, unshaded monoline, brisk),
**Copperplate** (35° from the vertical, that is 55° from the baseline, shade
on the downstrokes only and those slower, "slow and deliberate") and a
**broad-edge nib at 45°** whose thick and thin follow the direction of
travel. A fifth hand, **italic**, is a different grammar rather than a
different pen: loop-free, branching, elliptical lowercase in the manner of
modern italic handwriting (`src/pen/hand/italic-am.js`, `italic-nz.js`),
joined by the same connectors, written with a monoline nib at 8°; a hand may
bring its own letters (`style.letters`), and what the italic set lacks it
borrows from the school hand. The italic lowercase is a first pass: its
letters read, its joins work, but a letter written on its own still shows the
straight lead-in as a doubled stem, and the capitals are the school hand's. With the pen model as source, a **Hand** picker and sliders for
slant, tempo and looseness appear, a **Nib** picker overrides the hand's
nib, and **Another take** rewrites the text with fresh small deviations: a
loose hand lands a percent or two of x-height off its targets and never
times two strokes alike, a stiff one repeats itself. The text may run over
several lines (Shift+Enter in the text field starts one; Enter analyses), and
**Wrap at** breaks lines by word at a width in em - lines sit 3.6 x-heights
apart, and the pen's trip to the next line is a lift like any other, capped
so a carriage return does not look like a pause for thought. `node
scripts/pen-check.mjs [--hand=copperplate] [words…]` writes a set of words
and the alphabet, checks that every chain lands on its last target and that
no letter strays far from the template it came from, and draws
`pen-sheet.svg` for a look.

### A penmanship engine instead of a font

The route this prototype does not take yet - generating letterforms and pen
paths from the principles of penmanship rather than recovering them from a
font - was surveyed as well (sources below). The practical lineage runs from
Knuth's Metafont, a pen dragged along a path, through Hobby splines and
Levien's Spiro curves to today's stroke fonts (Hershey, EMS, LTTR/INK,
Glyphs' stroke attributes), which store centrelines only and know nothing of
speed or pressure. The dynamics layer is Plamondon's kinematic theory: a word
as the vector sum of overlapping lognormal velocity strokes aimed at virtual
targets, where the overlap rounds corners as a hand does, jitter of a percent
or two gives natural variation, and joins between letters come free because an
exit stroke and the next entry overlap like any two strokes (about three
strokes a second, onset gaps of 50–120 ms, integrated at 200 Hz; Berio, Fol
Leymarie & Plamondon's AutoGraff is the closest prior work). Nibs are simple:
a broad edge gives width by the sine of the angle between travel and the nib,
a pointed pen gives width from pressure, peaking on slow downstrokes. Learned
generators (Graves 2013, DeepWriting, the 2023–2025 transformer and diffusion
models, InkSight) need IAM-scale data, produce shapes without dynamics and
cannot write in a given style. Writing in the style of an existing font is
feasible but approximate: skeletonise, register the grammar's targets, read
slant and proportions off the metrics.

Recommended shape: a letter grammar of virtual targets with arc angle, onset
gap and pressure hint, typed entry and exit; a style set (slant, proportions,
loop sizes, connection angle, spacing, tempo, variability, nib); a join table
on exit and entry types; the lognormal integrator; a nib renderer feeding the
existing player. Rough effort: integrator and renderer one to two weeks, a
grammar editor one to two weeks, authoring sixty-odd letter grammars three to
five weeks per style (the dominant cost), joins and presets one to two weeks,
font fitting six to ten weeks; a first version without fitting is two to
three engineer-months.

Sources: Knuth, Mathematical Typography (1979); The METAFONTbook (1986) ·
Hobby, Discrete & Computational Geometry 1 (1986); Digitized Brush
Trajectories (1985) · Levien, From Spiral to Spline (2009) · Hershey,
Calligraphy for Computers (1967) · Plamondon et al., Pattern Recognition
Letters 35 (2014); O'Reilly & Plamondon, Pattern Recognition 42 (2009) ·
Ferrer, Diaz, Carmona-Duarte & Morales, IEEE TPAMI 39 (2017) · Ferrer et al.,
iDeLog, IEEE TPAMI 42 (2020) · Berio, Fol Leymarie & Plamondon, MOCO 2017;
Eurographics 2018; Berio, AutoGraff (2021) · Graves, arXiv:1308.0850 (2013)
· Aksan, Pece & Hilliges, CHI 2018 · Balashova et al., Computer Graphics
Forum 38 (2019) · Berio et al., StrokeStyles, ACM TOG 41 (2022) · Lian et
al., EasyFont, ACM TOG 38 (2018).

### Letterform templates

Ink alone cannot say that an `A` is written up the left leg, over the apex
and down the right leg — in this very font the *left* leg is the heavy
stroke, so the thick-is-down rule argues the other way. `src/lib/templates.js`
supplies the convention: for every Latin letter, a coarse ordered list of
waypoints (in glyph-bbox coordinates) per pen-down stroke, cursive style.
A candidate path is aligned to the waypoints by dynamic programming
(monotone, so order and direction both count), and the fit is a strong term
in the whole-letter score. Templates are deliberately loose; the geometry
still decides everything they leave open, and there is none for digits,
punctuation or ligatures. When a letter comes out wrong, the honest fix is
usually a better template — or the manual tools below.

Afterwards: clearly horizontal strokes running backwards are reversed, closed
bowls are forced counter-clockwise, and dots, accents and crossbars are moved
to the end.

Whenever the top two options are close — at a junction or across whole
decompositions — it goes in the on-page log rather than being silently
resolved.

### Coverage repair

Spur pruning and smoothing can leave real ink beyond the pen's reach — the
classic case is a stem's tapered tail, whose skeleton branch looks exactly
like a prunable artefact. Uncovered ink used to pop in the instant its stroke
completed ("like an afterthought"). `repairCoverage()` paints the pen's
coverage with a round-capped stroker, flood-fills any missed ink, and splices
a there-and-back detour into the nearest stroke — the same dip-into-the-taper
motion a human pen makes. With the ownership reveal (below) nothing can be
missed any more; the repair now exists so the pen *visibly* dips into a tail
at the right moment rather than the tail filling in from the side. Only a
*body* of ink earns a detour - a blob at least 24 px that is about as thick
(≥ 90 %) as the stroke it hangs off, such as a foot or a heavy tail. A sliver,
a pointed corner, or the outer bulge of a wedge where two strokes merge (the
right side of the `e`'s eye in the test font) is left to the round nib, which
simply rounds it off; a detour there made the pen visibly go up, down and up
again. Each repair is reported in the log (`tail-retrace`).

### Pen plan: bridges between letters

Glyph records only know their own letter. `src/lib/penPlan.js` decides how
the pen moves through the **word**: the order, where it lifts, and where it
flows from one letter straight into the next — because a hand never lifts
between an exit stroke and the following entry stroke, even when the font
leaves a gap there.

For each consecutive pair of body strokes it searches the tail of the first
and the start of the second for the pair of points the pen can pass between
most naturally (short gap, tangents agreeing with the direction of travel,
little ink skipped), and joins them with a cubic Hermite curve drawn as ink at
the local hairline width. Two modes:

- **trim** — the exit hairline of `h` and the entry hairline of `e` overlap;
  both are cut back to the join and the skipped hairline ink is revealed
  while the pen travels the bridge (it lies within the pen's width anyway).
- **mid-entry** — the `e`'s exit swash lands on the first `l` *mid-stem*,
  which has no entry hairline. The pen enters there, writes up to the top of
  the stem, retraces down through the entry point and carries on. The entry
  lands on the nearest point *between* vertices, so a straight stem with few
  vertices still gets joined exactly where the previous stroke arrives.

Dots, accents and crossbars are written after their word, left to right, as a
hand does once it has stopped flowing. Bridges are derived data — never
cached, recomputed after every edit, and listed in the JSON panel under
`plan.bridges`; the log says where the pen flowed and where it lifted and why.

### Speed model

`src/lib/timing.js` turns the plan's geometry into a clock. **Natural speed**
(default) is parameterised from the handwriting-kinematics literature:

| effect | model | source |
| --- | --- | --- |
| writing is a chain of strokes, each with a bell-shaped speed | the chain is cut at its turning points (vertical reversals and cusps, at least 0.1 em apart); each stroke runs a bell from 45% at one turn to its peak and back | sigma-lognormal model: Plamondon & Guerfali 1998; minimum jerk: Flash & Hogan 1985 |
| long strokes are quick, short ones unhurried | a stroke's peak speed ∝ its length^0.5, held to 0.75–1.35× the chain's mean, with a seeded ±6% per-stroke variation | isochrony between strokes: Viviani & Flash 1995 |
| slows in tight turns and reversals, runs on straights | speed ∝ curvature^(−1/3), clamped to [0.55, 1.4]× nominal, on top of the stroke bells | two-thirds power law: Lacquaniti, Terzuolo & Viviani 1983; holds piecewise for handwriting (Viviani & Flash 1995) |
| upstrokes faster than downstrokes | ±7% around the mean by the tangent's vertical component | adult cursive: upstrokes ≈42 mm/s vs downstrokes ≈37 mm/s (Thomassen & Meulenbroek 1993); also Maarse & Thomassen 1983 |
| ease in from rest, ease out into the lift | smoothstep ramp over the first/last 0.15 em, floor 15% | bell-shaped (minimum-jerk) velocity per movement: Flash & Hogan 1985 |
| small movements are quick, not slow | chain duration ∝ length^0.25 below 1 em (a dot ≈ 100 ms), floor 80 ms | isochrony: Viviani & Flash 1995; Pagliarini et al. 2017 |
| pen lifts | 120 ms + travel within a word, 250 ms + travel between words, in-air 1.5× | inter-letter intervals 90–155 ms (Kandel et al. 2008), word pauses ≈250 ms (Chenu et al. 2014); in-air speed is unmeasured in the literature — the 1.5× is a choice |
| average speed | slider default = 11 x-heights/s, measured off the font; the slider tops out at 4 em/s | adult cursive ≈ 39 mm/s at ≈3.6 mm x-height (Thomassen & Meulenbroek 1993) |

Profiles are harmonically normalised so **the slider stays honest**: a chain
of length L still takes exactly L / v0 seconds, only the distribution of speed
along it changes. Untick *natural speed* for constant speed.

### The renderer: the font's ink, uncovered by a sweeping nib

What the preview draws is always the font's own outline; the pen never
approximates it. Two earlier renderers were dropped for the same reason: a
mask that revealed ink by the first pass of a nib showed crossover spikes and
stripes on retraced stems, and a painted stroke with widths read from the
ink lost everything the font's contrast is made of - thick and thin, pointed
tips, the wedge of a foot. `src/render/sweep.js` builds a **reveal map** per
glyph instead, and `src/render/animator.js` plays it:

- **The nib claims the ink's real cross-section (v0.15.0).** A disc is only
  ever the largest circle that fits: it under-reads wherever the stroke is
  wider than it is round, which on a pointed pen is most of a shade. So each
  sample measures how far the ink actually reaches perpendicular to travel,
  left and right separately, and claims that band (half a sample-spacing along
  the path either way, so consecutive bands tile). The measurement stops at
  the ink's edge, at 2.2x the nib radius, or in the *valley* - marching out of
  one stroke's core into a crossing, the distance to the outline falls to a
  minimum between the two cores and climbs again toward the other, and that
  minimum is where this stroke's own half-width ends. The ends of a chain keep
  a round disc, so a tip still ends in the nib's shape.
- **A round nib whose radius follows the ink.** Each pen-down chain is
  sampled every raster pixel; the nib's half-width at a sample is read from
  the distance map over ±0.08 em of path, at the 75th percentile of that
  window (a sample off the ink borrows its nearest inked neighbour). A
  crossing inflates the distance map to the half-width of the union, but only
  over the samples inside it - a minority of the window - so the percentile
  passes over them and lands on the stroke's own width. Until v0.15.0 this
  was the window's *minimum*, which a crossing cannot fool either but which
  also drags the nib down to the thinnest ink within a whole 0.08 em: on a
  pointed pen, whose shade swells and tapers over about that distance, the
  nib was systematically narrower than the shade it was writing, and the ink
  it missed went to whichever pass was nearest - at a crossing, the one still
  to come. That is what broke pieces out of a shade as it was written and
  filled them in when the crossing arrived.
- **First pass wins, per pixel.** The passes are replayed in pen order. Every
  pixel the disk touches for the first time is claimed by that chain at that
  arc length - so a pixel's reveal time is the moment the nib first covers
  it, which makes the front round like the nib. The disk grows through the
  ink only, so it never reaches across a counter to the far side of a loop,
  and a pass crossing a stroke drawn later claims exactly its own tube
  through it, no bump on either side. A retraced stem belongs to the first
  pass, so the retrace shows nothing new, no stripes.
- **Everything else follows the nearest claimed pixel.** Ink the disks never
  touch - a wedge, the flare of a foot, the far side of a merge, the last
  few pixels of a taper - is assigned to its nearest claimed pixel plus the
  distance to it, so it appears just after the nib passes, like ink spreading.
  Nothing pops in when a stroke completes. Ink in a component no pass enters
  at all (a dropped speck) would appear when the run ends; the readout under
  the debug view counts such pixels, and for the test words it is zero.
- **The wedges at a crossing follow the later stroke.** Where two passes
  cross, the ink in the concave wedges between them is in neither nib's tube;
  it exists only because both strokes are there, so it appears with the later
  pass. Without this the first stroke through a crossing showed a small knot
  where the other stroke would later cross it. Only ink that really lies
  *between* the two passes: a pixel is deferred when the later pass is no
  further from it than the nearest pass is (within 1.5 px). Ink that hugs the
  stroke under the pen is that stroke's own, however soon another pass
  crosses beside it - deferring that was the second source of the holes.
- **The edge is the outline.** The map extends two pixels into the
  background around the ink and the frame is drawn by painting the glyph's
  vector outline through it: raster resolution decides *when* a pixel shows,
  the outline decides *where* the edge is, so edges stay crisp at any zoom.
- **Joins are one ribbon.** Where the pen flows from one letter into the
  next, the font has two shapes overlapping at a slight angle - the first
  letter's exit hairline and the next letter's blunt entry - with a notch
  where they cross, and the pen never travels the exit beyond the plan's
  cut. Those untravelled ends (the tail past the cut, a trimmed entry
  hairline, a blunt end's corners) are hidden by the map unless a real pass
  covers them; the letter's own pass reclaims what its nib covers around the
  cut, so visible ink ends in the nib's round shape. The join itself is
  painted as one ribbon that runs 0.08 em into both letters: at every sample
  it carries the ink's real cross-section, found by walking the normal
  through the letter's raster to the edges (held to a running median so a
  crossing cannot fling an edge out), and across the bridge, which has no
  ink of its own, the edges interpolate between the two sides. Inside a
  letter the ribbon *is* the outline, so it merges without a seam, and it is
  revealed with the nib like everything else. Two rules keep the timing
  honest: a stroke's nib claims pixels only in its own glyph, and a bridge's
  nib claims the letter it leaves only beyond the cut and the letter it
  enters only ahead of the entry point - so a blunt entry end, and whatever
  crosses it, wait for that letter's own passes instead of showing while the
  previous letter is still being written.

A frame is one alpha write per glyph (only the glyphs whose chains moved) and
one clipped image draw. Time is the clock; the nib's arc-length position on
each chain comes from the timing tables.

## Layout

Data layer — no DOM, no rendering:

| file | role |
| --- | --- |
| `src/lib/shaping.js` | HarfBuzz shaping + opentype.js outlines by glyph id |
| `src/lib/raster.js` | glyph → binary bitmap + font ↔ raster mapping |
| `src/lib/thinning.js` | Zhang-Suen, distance transform, speck removal |
| `src/lib/graph.js` | skeleton → node/edge graph, spur pruning |
| `src/lib/strokeOrder.js` | the pen-order heuristics: beam search + whole-letter score |
| `src/lib/templates.js` | the taught cursive stroke sequences per Latin letter, as waypoints |
| `src/lib/snap.js` | skeleton/distance-map cache; snapping points onto ink |
| `src/lib/geometry.js` | polyline maths (RDP, resample, smooth, arc length) |
| `src/lib/strokeRecovery.js` | per-glyph pipeline → JSON record (incl. coverage repair) |
| `src/lib/penPlan.js` | word-level pen order, lifts, bridges, mid-entries |
| `src/lib/timing.js` | the speed model: plan geometry → time tables |
| `src/lib/edit.js` | record surgery for manual corrections (split, delete, draw, drag) |
| `src/lib/analyze.js` | word-level orchestration |
| `src/lib/cache.js` | per-font/per-glyph record store |
| `src/lib/fontStore.js` | added fonts, kept in IndexedDB; the last choice |

Render layer:

| file | role |
| --- | --- |
| `src/render/layout.js` | word space ↔ canvas transform |
| `src/render/debugView.js` | outlines, numbered strokes, arrowheads, bridges, retraces |
| `src/render/sweep.js` | reveal maps: which chain uncovers each pixel, and when; hides untravelled join tails |
| `src/render/animator.js` | the reveal animation on the timing model |
| `src/render/recorder.js` | MediaRecorder capture of the preview |
| `src/render/internals.js` | raster + skeleton strip |
| `src/main.js` | UI wiring only |

### The data layer is the contract

`recoverGlyphStrokes()` returns a plain JSON record per glyph, in font units
(y-up, origin on the baseline at the glyph origin):

```json
{
  "version": 3,
  "source": "heuristic",
  "gid": 149,
  "name": "h",
  "chars": "h",
  "unitsPerEm": 1000,
  "advance": 456,
  "bbox": { "x1": -19, "y1": -1.62, "x2": 451.48, "y2": 589.21 },
  "penWidth": 59.9,
  "strokes": [
    { "index": 0, "role": "body", "component": 0,
      "lengthFontUnits": 1171, "startWidth": 41.7, "endWidth": 35.2,
      "retraces": [{ "from": [199, 568], "to": [165, 68], "lengthFontUnits": 512 }],
      "points": [[8, 562], [10.4, 551.2], "…"] }
  ],
  "notes": [{ "severity": "warn", "code": "start-point", "message": "…", "at": [8, 562] }],
  "stats": { "…": "raster size, ink/skeleton pixel counts, timings" }
}
```

Records are keyed by font + glyph id in `StrokeStore` (memory + localStorage),
and carry a `source` field. An AI-assisted correction pass slots in at
`store.override(fontKey, gid, record, 'ai')` — nothing in the rendering code
looks at where a record came from. **Clear stroke cache** re-runs recovery
from scratch (wiping manual edits too), which is what you want while tuning
heuristics.

### Manual corrections

Click any stroke — directly in the debug view or via its chip — then:

- **◀ earlier / later ▶** move it within its glyph's pen order
- **⇄ reverse direction** flip which end the pen starts from
- **✂ split here** cut the stroke at the marked point (clicking the stroke in
  the view places the dashed split marker; chips don't carry a point)
- **🗑 delete stroke** remove the pen pass — the ink itself stays, revealed by
  the nearest remaining stroke, so split + delete "edits out" a bad path
  segment without leaving holes in the final word
- **drag its points** — the selected stroke shows its vertices; drag one and
  the curve follows with a smooth falloff (0.12 em of arc either side), or
  hold **shift** to move that point alone. The point tracks the cursor while
  the mouse is down and stays exactly where it is dropped
- **click a point** of the selected stroke to pick it (the dashed ring); it
  is where **✂ split here** cuts and what **⌫ delete point** removes
- **↶ undo / ↷ redo** (⌘Z, ⌘⇧Z; ⌃Z, ⌃⇧Z or ⌃Y) step through the last 50
  edits of the session, of any kind. Undoing back past a glyph's first edit
  drops its override, so the glyph goes back to being derived
- **↺ re-run this glyph** discard edits and restore the heuristic result

To define a path from scratch, click **✎ draw stroke** and draw over the
letter (mouse, pen or finger). The path is smoothed like a recovered stroke,
attributed to the glyph it mostly lies over, and inserted right after the
selected stroke of that glyph (or last). Draw mode stays on until Esc or the
button again, so a letter can be redrawn as several strokes in order; delete
the heuristic strokes first if they are wrong. With **snap to ink** on (the
default), a *drawn* path is pulled onto the ink's centreline — recomputed
from the same skeleton the automatic recovery used — so a rough gesture
becomes an accurate pen path. Dragged points are not snapped: a point put
somewhere deliberately stays there.

A stroke's points are **dense samples of the path, not Bézier anchors**: they
sit a raster pixel or two apart (`resample` at 0.004 em in
`strokeRecovery.js`), and the curve between them is the polyline itself, so
there are no direction handles to pull — the shape is carried by where the
samples are. That is why dragging one point alone dents the curve and the
falloff exists. Everything downstream consumes polylines: the reveal map
walks them pixel by pixel, the join planner measures tangents over a window
of them, and the pen model's own hand is dense waypoints too.

Edits go through the same seam an AI pass would use
(`store.override(fontKey, gid, record, 'manual')`): the record's `source`
becomes `"manual"` (✎ in the stroke list), it persists in localStorage, and
because records are keyed by glyph id a fix applies everywhere that glyph
appears — correct the `l_l` ligature once and every "ll" uses it. Reordering
is per glyph; glyphs themselves always write in shaping order.

## Recording

**● Record** (next to Play) analyses the text field first if it changed,
restarts the animation and records one run of the preview canvas in real
time via `MediaRecorder` — it stops by itself at
the end of the run, or earlier with **■ Stop recording**. The take then
downloads automatically as `handwriting-<text>.webm`. Browsers allow a page
a couple of downloads without a user gesture and then ask once whether to
allow "multiple automatic downloads" for the site — allow it and takes keep
arriving by themselves. Should a download be blocked, the take is still there
as a link next to the button; the link only ever refers to the current text
and strokes — it disappears as soon as either changes.

Chrome/Firefox produce `handwriting-<text>.webm` (VP9 where available);
Safari falls back to MP4. Keep the tab visible while recording: browsers
throttle hidden tabs, which stalls both the animation and the capture.

This is deliberately a capture of what you saw, for sharing and review. The
product-grade exporter — WebCodecs with a fixed frame clock, muxed to MP4,
independent of tab visibility — is a later milestone.

**Export SVG** (pen model only) saves the written word as
`handwriting-<text>.svg`: one filled path per pen-down chain, the ribbon at
the nib's width around the trajectory, exactly the ink the preview paints
(`src/pen/svg.js`). It is a vector of the finished word, not of the motion;
the timing stays in the JSON.

## Audit notes

A read-through of the whole codebase went with the speed and bridging work.
What changed as a result:

- **Timeline is time-based.** It used to be pen distance with fixed fake
  costs for lifts; now `timing.js` owns the clock and the animator only asks
  "where is the pen at T".
- **Repeated glyphs share work.** `analyzeWord` recovers and rasterises each
  glyph id once per word, and `Animator.load` builds region bitmaps once per
  glyph id — "ll" no longer pays twice. Manual edits refresh every instance.
- **Cache writes are batched.** `StrokeStore` serialised the whole store to
  localStorage once per glyph; it now coalesces into one write per tick and
  flushes on `pagehide`.
- **Degree counting** in the stroke-order code was copied three times with
  subtle differences; it is one helper now.
- Dead fields and a stray `return` of an innerHTML assignment are gone; the
  data-layer/render split is intact (`penPlan.js` and `timing.js` are pure).
- Not done, noted: recovery still runs on the main thread (~50–80 ms per new
  glyph). The data layer is DOM-free except for canvas rasterisation, which
  `OffscreenCanvas` would allow in a worker.

### Correcting a hand, letter by letter (v0.15.0)

A pen path belongs to a glyph, not to a word: correcting the `z` once corrects
it in every word that uses it. **A–Z letters**, in the debug view's header,
opens a strip of the alphabet for exactly that. Click a letter and the view
shows it alone and large with its pen order and all the editing controls;
close the strip and the text comes back, untouched.

Each chip carries what is known about that letter: bold with a ✎ when it is
hand-edited, outlined when `fontCheck` has something to say about it, faint
until it has been looked at, and its tooltip lists the stroke count and any
complaint. The verdicts are filled in one letter at a time in the background,
because the first analysis of a glyph is a full recovery; afterwards they come
from the store. On Pinyon the strip settles at 8 of 52 flagged, all capitals.

**Saving a hand.** *Save hand* writes every hand-edited letter of the current
font to a JSON file, *load hand* reads one back. Letters are keyed by
character rather than glyph id, so a hand still loads onto another copy of the
same face where the ids differ. A file saved at a different units-per-em is
refused outright - the coordinates are font units and every stroke would land
in the wrong place - while a different family only asks, since a hand
corrected on one weight is a fair start for another. Letters the font does not
have are named and skipped.

### Hand-edited letters (v0.14.0)

The debug view has always been able to change a pen path - click a stroke,
drag its points, split, delete, reverse, reorder, or draw a new one with
*draw stroke* (snapped to the ink's centreline). Those edits are stored per
glyph and re-used for every word that letter appears in. Three things now
make them safe to rely on:

- **They survive.** Hand-edited glyphs live in their own bucket in the store
  (`cache.js`), separate from the recovered ones. A recovered record is
  derived from the code, so a new `RECORD_VERSION` throws it away; an edited
  one is work, so it outlives version bumps and *Clear stroke cache* (which
  now asks before discarding it) and goes only when that glyph is reverted.
  Each carries `editedUnderVersion`, so a reader can tell what it predates.
- **They stay complete.** Every edit refreshes the per-point ink widths that
  the joins and the invariant check read (`refreshWidths` in `edit.js`), and
  an older record missing them has them refilled from the raster on load, so
  a hand-edited letter joins and is checked exactly like a recovered one. An
  edited stroke drops the search's `againstRule` verdict rather than carrying
  a stale one.
- **They are checked.** `window.__fontCheck()` judges edited and recovered
  glyphs alike, so a hand-placed stroke that pushes a shade upward is
  reported like any other.

### Could a pen just draw it, instead?

A recurring question: rather than uncovering the font's outline, why not sweep
an invisible pen of varying width along the recovered path and be rid of the
crossing artefacts by construction? It was measured on Pinyon in v0.15.0, by
building the sweep and comparing its area with the glyph's ink pixel for
pixel, over `l o n e a z f k b s t y`:

| width model | ink missed | ink invented | XOR of the ink |
| --- | --- | --- | --- |
| inscribed circle (the record's own widths) | 19.1% | 3.4% | **22.5%** |
| measured cross-section, lightly smoothed | 12.1% | 5.5% | **17.7%** |

Best letters about 13% (`f`, `t`), worst 39% (`s`, whose reverse-oval shade
turns tighter than the offset can follow). The bar for "the reader would not
notice" is one or two percent, so on this face a swept pen would visibly
redraw the letters - it misses far more than it invents, mostly the tapered
tips the skeleton stops short of and the fillets where strokes merge. The
conclusion is not that sweeping is wrong in principle, but that it cannot
reproduce *this* face; a font that is itself a clean pen sweep would score
much better. The reveal engine keeps the outline exactly, so it stays.

## Versions

The project had no version control until v0.16.0, so most of its past is gone:
only **v0.12.0** survives, recovered from the zip made for the review, and
**v0.16.0** is everything since as one snapshot. From here on each release is
a git tag, which means a tree that can be put back.

```
node scripts/release.mjs 0.17.0 "what changed"   # set the version, commit, tag
node scripts/release.mjs --refresh               # rebuild versions.json from the tags
git checkout v0.12.0                             # go back
git checkout -                                   # and return
```

Clicking the version in the page's title opens the list and hands you the
command for each one; the page cannot check anything out itself, so it copies
the command instead. `versions.json` is generated from the tags by the release
script and is never edited by hand.

## Known rough edges

- The nib percentile (0.75) assumes a crossing takes up less than a quarter
  of the ±0.08 em window. Where two strokes run nearly parallel through each
  other - a very shallow crossing - the nib can still follow the union and
  sweep a little of the stroke still to come.
- **Where a stroke runs alongside its own later pass the seam is ragged.**
  The right side of an `o` is written twice: the bowl closes over it, and the
  exit swirl retraces it about 1200 units of arc later. Both passes have a
  claim on the overlap - the earlier takes what its own cross-section covers,
  the later takes the rest, which is right - but the boundary is decided pixel
  by pixel from a cross-section measured sample by sample, so it comes out
  ragged, and a ragged boundary between two moments that far apart reads as
  chunks chopped out of the stroke.

  Measured as neighbouring ink of one pass revealed more than 0.1 em of arc
  apart, it is about 230 pixels of the `o`'s 11500. Tried and rejected for it
  (v0.17.0, reverted in v0.17.1): giving a retrace the arc of the pass it goes
  back over - it settles the seam, but the later pass's *own* new ink then
  appears early, so the `o`'s swirl draws itself on the upstroke. Also tried:
  a 3x3 and a 5x5 median over the arc field (the 5x5 more than tripled the
  jumps, smearing values into new discontinuities); raising the cross-section
  cap; disabling either valley rule; disabling the wedge pass - the last four
  leave the region pixel for pixel unchanged.

  The remaining fix is structural rather than another rule: segment the ink
  into a region per pass with a proper boundary - a medial-axis decomposition
  with junction typing, StrokeStyles-style - instead of deciding ownership
  pixel by pixel from whichever band reaches first. That is the step deferred
  under "Could a pen just draw it, instead?", and this is the case showing the
  heuristics cannot close it.
- Pointed pen (v0.14.0): the z and the x are written in three strokes with
  the crossing hairlines of the x drawn downward (Vitolo's way); the a's and g's oval rides up under the stem for a
  third of an x-height before the stem is pulled; the o leaves by running
  back down its right side to the exit tick, which Pinyon puts low. The
  font route's timing is still `timing.js`, not the pen model's `pace.js`.

- The left-to-right rule is applied to strokes whose horizontal displacement
  dominates. A letter that legitimately ends left of where it started is not
  reversed, but it is also not detected as unusual.
- Spur pruning is local (against each edge's own half-width) and capped at
  three rounds. An unbounded loop will happily nibble a whole limb off a glyph
  one short edge at a time — that was a real bug during development.
- Bridging is geometric: it joins strokes whose ends are within 0.14 em and
  whose tangents agree. It cannot know that a particular font *wants* a lift
  somewhere; untick *connect letters* if it joins something it shouldn't.
- The in-air speed and the +5–10% speed-up toward the end of a word that the
  literature hints at are not modelled; nobody has measured the first and the
  second is a single-lab observation.
- The reveal engine never invents ink, so where the font's shape reaches far
  beyond the nib (a very wide wedge) that part fills in a moment after the
  pen passes rather than under it. The lag is the distance to the nib at pen
  speed - a frame or two at most.
