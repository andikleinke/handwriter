/**
 * Pen-order heuristics.
 *
 * Turns a skeleton graph into an ordered, oriented list of pen strokes.
 * Everything here works in raster pixel space (y-down, so "down" = +y).
 *
 * The rules being encoded, in rough priority order:
 *   - prefer one long continuous stroke: at a junction the pen carries on in
 *     the smoothest direction rather than taking a hard turn
 *   - start near the top-left of the letter
 *   - downstrokes travel downward
 *   - cursive connections progress left to right
 *   - dots, diacritics and crossbars come last
 *
 * Rather than committing to one greedy walk, we run the walk from every
 * plausible starting node, score the whole decomposition, and keep the best.
 * A narrow margin between the top two is exactly the "uncertain" signal the
 * on-page log reports.
 */

import { leadingTangent, trailingTangent, polylineLength, dist, bboxOf, resample } from './geometry.js';
import { templateFor, templateFit } from './templates.js';

const W = {
  continuity: 2.5,      // smooth continuation at a junction
  initialDir: 0.8,      // first move should head down/right
  rightward: 0.25,      // mild left-to-right bias everywhere
  edgeLength: 0.15,     // prefer committing to long edges
  strand: 2.0,          // taking this branch would orphan ink behind us
  longestShare: 3.0,    // reward one dominant continuous stroke
  extraStroke: 1.2,     // penalty per stroke beyond the theoretical minimum
  retrace: 1.0,         // penalty per unit share of path that re-covers written ink
  retraceLong: 3.0,     // per em of any single run back beyond 0.35 em: a hand lifts instead
  turn: 0.9,            // penalty for sharp corners taken at junctions
  startTopLeft: 1.0,
  entry: 1.4,           // lowercase cursive: start on the entry hairline at the left
  netRightward: 1.6,
  downstroke: 0.3,      // near-vertical runs should travel downward (weak prior)
  stress: 1.5,          // thick ink is a downstroke, hairline ink an upstroke (from the font)
  template: 3.5,        // the letter's conventional cursive path (from templates.js)
  templateStrokes: 0.8, // per pen-down more than the template's (a 't' has two)
  waypoint: 1.2,        // beam ranking: per template waypoint reached in order
  liftLocal: 1.0,       // beam ranking: lifting mid-letter is a last resort
  retraceLocal: 0.6,    // beam ranking: per em of retrace
  contourSwitch: 1.5,   // beam ranking: leaving a drawn contour while it still continues
  contourBreak: 0.8,    // whole letter: per such switch
};
const WAYPOINT_RADIUS = 0.3;

const BEAM_WIDTH = 12;

const AMBIGUOUS_BRANCH = 0.12;   // score gap below which a junction is a coin flip
const AMBIGUOUS_ORDER = 0.08;    // relative score gap between whole decompositions
// A hand happily runs back down a stem it has just drawn (an 'l', a 't') to
// carry on elsewhere; it will not retrace much more than an ascender.
const MAX_RETRACE_EM = 0.8;
// ...and only to reach something worth writing, not a speck of leftover ink.
const MIN_RETRACE_GAIN_EM = 0.06;

const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const NO_EDGES = new Set();

/* ------------------------------------------------------------------ */
/* component classification                                            */
/* ------------------------------------------------------------------ */

/**
 * Split components into body / crossbar / accent / dot and put them in pen
 * order: bodies left to right, then crossbars, then accents, then dots.
 */
export function classifyComponents(graph, em) {
  const comps = graph.components;
  if (!comps.length) return { ordered: [], roles: new Map(), notes: [] };

  const notes = [];
  const maxLen = Math.max(...comps.map((c) => c.totalLength), 1e-6);
  // The reference for "above" and "overlapping" is the substantial parts of
  // the letter. Crossbars are tested before anything is called a body: in a
  // script face a t-bar can be a long swash, longer than the stem it crosses.
  const trunks = comps.filter((c) => !c.isDot && c.totalLength >= 0.5 * maxLen);
  const trunkTop = trunks.length ? Math.min(...trunks.map((c) => c.bbox.y1)) : 0;
  const trunkMidY = trunks.length
    ? trunks.reduce((s, c) => s + (c.bbox.y1 + c.bbox.y2) / 2, 0) / trunks.length
    : 0;

  const roles = new Map();
  for (const c of comps) {
    const b = c.bbox;
    const small = b.w < 0.24 * em && b.h < 0.24 * em;
    if (c.isDot || (small && c.totalLength < 0.35 * em)) { roles.set(c.id, 'dot'); continue; }

    const horizontal = b.w > 2.2 * Math.max(b.h, 1e-6);
    const crossesATrunk = trunks.some(
      (t) => t !== c && b.x2 > t.bbox.x1 && b.x1 < t.bbox.x2 && b.h < 0.6 * t.bbox.h
    );
    if (horizontal && crossesATrunk && (b.y1 + b.y2) / 2 < trunkMidY) {
      roles.set(c.id, 'crossbar');
      continue;
    }
    if (!trunks.includes(c) && b.y2 <= trunkTop + 0.05 * em) { roles.set(c.id, 'accent'); continue; }
    roles.set(c.id, 'body');
  }

  const rank = { body: 0, crossbar: 1, accent: 2, dot: 3 };
  const ordered = [...comps].sort((a, b) => {
    const ra = rank[roles.get(a.id)], rb = rank[roles.get(b.id)];
    if (ra !== rb) return ra - rb;
    return a.bbox.x1 - b.bbox.x1;
  });

  // Two bodies that overlap heavily in x have no obvious left-to-right order.
  const bodyList = ordered.filter((c) => roles.get(c.id) === 'body');
  for (let i = 1; i < bodyList.length; i++) {
    const p = bodyList[i - 1].bbox, q = bodyList[i].bbox;
    const overlap = Math.min(p.x2, q.x2) - Math.max(p.x1, q.x1);
    if (overlap > 0.55 * Math.min(p.w, q.w)) {
      notes.push({
        severity: 'warn',
        code: 'component-order',
        message: `two disconnected parts overlap horizontally by ${Math.round(
          (100 * overlap) / Math.min(p.w, q.w)
        )}% - their left-to-right order is a guess`,
        at: [(q.x1 + q.x2) / 2, (q.y1 + q.y2) / 2],
      });
    }
  }

  return { ordered, roles, notes };
}

/* ------------------------------------------------------------------ */
/* traversal                                                           */
/* ------------------------------------------------------------------ */

function orientedOptions(graph, nodeId, used) {
  const opts = [];
  const seen = new Set();
  for (const id of graph.nodes[nodeId].edges) {
    if (used.has(id) || seen.has(id)) continue;
    seen.add(id);
    const e = graph.edges[id];
    const base = { id, length: e.length, radius: e.radius || 1, contour: e.contour ?? -1 };
    if (e.a === e.b) {
      opts.push({ ...base, pts: e.pts, other: nodeId });
      opts.push({ ...base, pts: [...e.pts].reverse(), other: nodeId });
    } else if (e.a === nodeId) {
      opts.push({ ...base, pts: e.pts, other: e.b });
    } else {
      opts.push({ ...base, pts: [...e.pts].reverse(), other: e.a });
    }
  }
  return opts;
}

/**
 * Fleury's rule, softened into a score: how many still-unwritten edges would
 * become unreachable if the pen took this branch now? A real hand avoids
 * painting itself into a corner and having to lift.
 */
function strandedCount(graph, chosenId, arriveNode, used) {
  const comp = graph.nodes[arriveNode].comp;
  const avail = new Set();
  for (const e of graph.edges) {
    if (e.comp === comp && e.id !== chosenId && !used.has(e.id)) avail.add(e.id);
  }
  if (!avail.size) return 0;

  const seenNodes = new Set([arriveNode]);
  const reached = new Set();
  const stack = [arriveNode];
  while (stack.length) {
    const n = stack.pop();
    for (const id of graph.nodes[n].edges) {
      if (!avail.has(id) || reached.has(id)) continue;
      reached.add(id);
      const e = graph.edges[id];
      const other = e.a === n ? e.b : e.a;
      if (!seenNodes.has(other)) { seenNodes.add(other); stack.push(other); }
    }
  }
  return avail.size - reached.size;
}

/**
 * At a dead end, the shortest way back over ink already written to a node
 * that still has unwritten ink - the stem the pen has just drawn, a short
 * bit of crossbar - provided it is no further than a hand would run back
 * rather than lift, and there is enough left to reach to make it worth it.
 * Returns the walk as oriented point runs, or null.
 */
function walkBack(graph, node, used, maxLen, minGain) {
  const dist = new Map([[node, 0]]);
  const prev = new Map();
  const done = new Set();
  const open = [[0, node]];
  let target = null;
  while (open.length) {
    open.sort((p, q) => p[0] - q[0]);
    const [d, n] = open.shift();
    if (done.has(n)) continue;
    done.add(n);
    if (d > maxLen) break;
    if (n !== node && remainingDegree(graph, n, used) > 0 && unusedReachableLength(graph, n, used) >= minGain) {
      target = n;
      break;
    }
    for (const id of graph.nodes[n].edges) {
      if (!used.has(id)) continue;
      const e = graph.edges[id];
      if (e.a === e.b) continue;
      const other = e.a === n ? e.b : e.a;
      const nd = d + e.length;
      if (nd < (dist.get(other) ?? Infinity)) {
        dist.set(other, nd);
        prev.set(other, { node: n, id });
        open.push([nd, other]);
      }
    }
  }
  if (target == null) return null;
  const steps = [];
  for (let n = target; n !== node; ) {
    const p = prev.get(n);
    const e = graph.edges[p.id];
    steps.unshift({ pts: e.a === p.node ? e.pts : [...e.pts].reverse(), length: e.length });
    n = p.node;
  }
  return { node: target, steps, length: dist.get(target) };
}

/** Total length of unwritten edges the pen could still reach from this node. */
function unusedReachableLength(graph, startNode, used) {
  const seenNodes = new Set([startNode]);
  const seenEdges = new Set();
  const stack = [startNode];
  let total = 0;
  while (stack.length) {
    const n = stack.pop();
    for (const id of graph.nodes[n].edges) {
      if (used.has(id) || seenEdges.has(id)) continue;
      seenEdges.add(id);
      const e = graph.edges[id];
      total += e.length;
      const other = e.a === n ? e.b : e.a;
      if (!seenNodes.has(other)) { seenNodes.add(other); stack.push(other); }
    }
  }
  return total;
}

/*
 * Beam search over the pen's decisions.
 *
 * A greedy walk commits at every junction; at a symmetric crossing (the loop
 * of an 'A' cutting its legs) the two continuations score identically and
 * the choice is luck. Instead, states carry the edges written so far, the
 * current stroke (as a list of steps, materialised into points only at the
 * end), and a running local score; each depth writes exactly one more edge,
 * with dead ends resolved by running back over written ink or lifting first. The best BEAM_WIDTH
 * states survive each depth, and every complete decomposition is then judged
 * by the whole-letter score.
 */

function newStroke(startNode) {
  return {
    steps: [],
    turns: [],
    length: 0,
    retracedLen: 0,
    ptCount: 0,
    // where along the stroke each node was reached, so a dead end can back up
    arrivals: [{ node: startNode, idx: 0, len: 0, leaveDir: null }],
  };
}

function initialState(graph, startNode) {
  const n = graph.nodes[startNode];
  return {
    used: new Set(),
    node: startNode,
    pos: [n.x, n.y],
    inDir: null,
    score: 0,
    wp: 0, // next template waypoint to reach
    contour: -1, // the drawn contour the pen is following
    breaks: 0,   // times it left one that still continued
    ambiguities: [],
    strokes: [],
    cur: newStroke(startNode),
  };
}

/** Advance through the template's waypoints as far as this edge carries the pen. */
function waypointsReached(tpl, pts, wp, em) {
  if (!tpl || wp >= tpl.wps.length) return wp;
  for (const p of resample(pts, Math.max(2, em * 0.03))) {
    const nx = (p[0] - tpl.frame.x0) / tpl.frame.w;
    const ny = 1 - (p[1] - tpl.frame.y0) / tpl.frame.h;
    while (wp < tpl.wps.length && Math.hypot(nx - tpl.wps[wp][0], ny - tpl.wps[wp][1]) < WAYPOINT_RADIUS) wp++;
  }
  return wp;
}

function stepEdge(state, o, dir, gain, span, tpl, em, broke = false) {
  const cur = state.cur;
  const first = cur.ptCount === 0;
  const arrivals = cur.arrivals.slice();
  arrivals[arrivals.length - 1] = { ...arrivals[arrivals.length - 1], leaveDir: dir };
  const ptCount = cur.ptCount + (first ? o.pts.length : o.pts.length - 1);
  arrivals.push({ node: o.other, idx: ptCount - 1, len: cur.length + o.length, leaveDir: null });
  const used = new Set(state.used);
  used.add(o.id);
  const wp = waypointsReached(tpl, o.pts, state.wp, em);
  return {
    used,
    node: o.other,
    pos: o.pts[o.pts.length - 1],
    inDir: arriveDir(o.pts, span),
    score: state.score + gain + W.waypoint * (wp - state.wp),
    wp,
    contour: o.contour >= 0 ? o.contour : state.contour,
    breaks: state.breaks + (broke ? 1 : 0),
    ambiguities: state.ambiguities,
    strokes: state.strokes,
    cur: {
      steps: cur.steps.concat([{ pts: o.pts, length: o.length, radius: o.radius }]),
      turns: state.inDir ? cur.turns.concat([1 - dot2(state.inDir, dir)]) : cur.turns,
      length: cur.length + o.length,
      retracedLen: cur.retracedLen,
      ptCount,
      arrivals,
    },
  };
}

/** The pen runs back over written ink to where unwritten ink remains. */
function walkState(state, walk, span, em) {
  const cur = state.cur;
  const steps = cur.steps.slice();
  let ptCount = cur.ptCount, length = cur.length;
  for (const st of walk.steps) {
    steps.push({ pts: st.pts, length: st.length, radius: 0, retrace: true });
    ptCount += st.pts.length - 1;
    length += st.length;
  }
  const last = walk.steps[walk.steps.length - 1].pts;
  return {
    used: state.used,
    node: walk.node,
    pos: last[last.length - 1],
    inDir: arriveDir(last, span),
    score: state.score - W.retraceLocal * (walk.length / em),
    wp: state.wp,
    contour: state.contour,
    breaks: state.breaks,
    ambiguities: state.ambiguities,
    strokes: state.strokes,
    cur: {
      steps,
      turns: cur.turns,
      length,
      retracedLen: cur.retracedLen + walk.length,
      ptCount,
      arrivals: cur.arrivals.concat([{ node: walk.node, idx: ptCount - 1, len: length, leaveDir: null }]),
    },
  };
}

function liftState(state, nextNode, graph) {
  const n = graph.nodes[nextNode];
  return {
    used: state.used,
    node: nextNode,
    pos: [n.x, n.y],
    inDir: null,
    score: state.score - W.liftLocal,
    wp: state.wp,
    contour: -1,
    breaks: state.breaks,
    ambiguities: state.ambiguities,
    strokes: state.strokes.concat([state.cur]),
    cur: newStroke(nextNode),
  };
}

/** Successor states that have written exactly one more edge. */
function expand(state, graph, comp, em, span, tpl) {
  const opts = orientedOptions(graph, state.node, state.used);
  if (!opts.length) {
    const out = [];
    const walk = walkBack(graph, state.node, state.used, em * MAX_RETRACE_EM, em * MIN_RETRACE_GAIN_EM);
    if (walk && state.cur.ptCount > 1) {
      out.push(...expand(walkState(state, walk, span, em), graph, comp, em, span, tpl));
    }
    const next = pickNextStart(comp, graph, state.used, state.pos);
    if (next != null) out.push(...expand(liftState(state, next, graph), graph, comp, em, span, tpl));
    return out;
  }

  // the contour the pen is on still continues here: turning off it costs
  const sameContourGoesOn = state.contour >= 0 && opts.some((o) => o.contour === state.contour);
  const scored = opts.map((o) => {
    const dir = exitDir(o.pts, span);
    let s = 0;
    if (state.inDir) s += W.continuity * dot2(state.inDir, dir);
    else s += W.initialDir * (0.7 * dir[1] + 0.5 * dir[0]);
    s += W.rightward * dir[0];
    s += W.edgeLength * clamp(o.length / (em * 0.4), 0, 1);
    if (strandedCount(graph, o.id, o.other, state.used)) s -= W.strand;
    const broke = sameContourGoesOn && o.contour >= 0 && o.contour !== state.contour;
    if (broke) s -= W.contourSwitch;
    return { o, dir, s, broke };
  });
  scored.sort((a, b) => b.s - a.s);

  let ambiguities = state.ambiguities;
  if (scored.length > 1 && scored[0].s - scored[1].s < AMBIGUOUS_BRANCH) {
    ambiguities = ambiguities.concat([{ at: state.pos, n: scored.length, gap: scored[0].s - scored[1].s }]);
  }
  return scored.map(({ o, dir, s, broke }) => {
    const child = stepEdge(state, o, dir, s, span, tpl, em, broke);
    child.ambiguities = ambiguities;
    return child;
  });
}

/** Replay a stroke's steps into points; measure retraces and ink stress. */
function materialize(stroke, medianRadius) {
  const pts = [];
  const retraces = [];
  let stress = 0;
  for (const step of stroke.steps) {
    if (step.retrace) {
      const from = pts[pts.length - 1];
      pts.push(...step.pts.slice(1));
      retraces.push({ from, to: pts[pts.length - 1], length: step.length });
    } else {
      if (pts.length) pts.push(...step.pts.slice(1));
      else pts.push(...step.pts);
      // downward travel (+dy in raster space) on thick ink, upward on thin
      const dy = step.pts[step.pts.length - 1][1] - step.pts[0][1];
      stress += (step.radius / medianRadius - 1) * dy;
    }
  }
  const length = polylineLength(pts);
  return {
    pts,
    turns: stroke.turns,
    length,
    inkLength: length - stroke.retracedLen,
    retraces,
    retracedLen: stroke.retracedLen,
    stress,
  };
}

/**
 * The direction an edge leaves a node in, read from `skip` to `skip + span`
 * along it (an edge too short for that is read end to end).
 */
function exitDir(pts, { span, skip }) {
  const total = polylineLength(pts);
  if (total < skip + span * 0.5) return leadingTangent(pts, total);
  const at = (L) => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = dist(pts[i - 1], pts[i]);
      if (acc + d >= L) { const t = d > 0 ? (L - acc) / d : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; }
      acc += d;
    }
    return pts[pts.length - 1];
  };
  const a = at(skip), b = at(Math.min(total, skip + span));
  const m = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / m, (b[1] - a[1]) / m];
}

/** The direction an edge arrives at its last node in, read the same way from the far end. */
function arriveDir(pts, tan) {
  const d = exitDir(pts.slice().reverse(), tan);
  return [-d[0], -d[1]];
}

/** A stroke run the other way: the pen path, its retraces and its stress mirrored. */
function reversed(k) {
  return {
    ...k,
    pts: k.pts.slice().reverse(),
    retraces: (k.retraces || []).map((r) => ({ from: r.to, to: r.from, length: r.length })),
    stress: -(k.stress || 0),
  };
}

/** The other orientations of a decomposition: every combination for up to three strokes, single flips beyond. */
function orientations(d) {
  const n = d.strokes.length;
  const out = [];
  if (n <= 3) {
    for (let mask = 1; mask < 1 << n; mask++) {
      out.push({ ...d, strokes: d.strokes.map((k, i) => (mask & (1 << i) ? reversed(k) : k)) });
    }
  } else {
    out.push({ ...d, strokes: d.strokes.map(reversed) });
    for (let i = 0; i < n; i++) out.push({ ...d, strokes: d.strokes.map((k, j) => (i === j ? reversed(k) : k)) });
  }
  return out;
}

/** Every complete decomposition the beam kept, starting from `startNode`. */
function beamSearch(comp, graph, startNode, em, medianRadius, tpl) {
  // Directions at a junction are read a stroke-width or two beyond it: the
  // skeleton wobbles inside a knot, and a tangent taken right at the node
  // makes the pairing of branches close to random (Diaz et al. 2024; Qiao,
  // Nishiara & Yasuhara 2006 estimate continuity outside the cluster).
  const span = { span: Math.max(4, em * 0.03), skip: Math.max(2, 1.5 * medianRadius) };
  const total = comp.edgeIds.length;
  // a letter with many crossings has more ways to go wrong early; widen
  const width = Math.min(48, BEAM_WIDTH + 2 * total);
  let beam = [initialState(graph, startNode)];
  for (let depth = 0; depth < total && beam.length; depth++) {
    const next = [];
    for (const st of beam) next.push(...expand(st, graph, comp, em, span, tpl));
    next.sort((a, b) => b.score - a.score);
    beam = next.slice(0, width);
  }
  return beam
    .filter((st) => st.used.size === total)
    .map((st) => ({
      strokes: st.strokes.concat([st.cur]).filter((s) => s.ptCount > 1).map((s) => materialize(s, medianRadius)),
      ambiguities: st.ambiguities,
      breaks: st.breaks,
    }))
    .filter((d) => d.strokes.length);
}

/** Degree counting only edges not yet written; a self-loop counts twice. */
function remainingDegree(graph, nodeId, used) {
  let d = 0;
  const seen = new Set();
  for (const id of graph.nodes[nodeId].edges) {
    if (used.has(id) || seen.has(id)) continue;
    seen.add(id);
    d += graph.edges[id].a === graph.edges[id].b ? 2 : 1;
  }
  return d;
}

const nodeDegree = (graph, nodeId) => remainingDegree(graph, nodeId, NO_EDGES);

function pickNextStart(comp, graph, used, prevEnd) {
  const bb = comp.bbox;
  const w = Math.max(bb.w, 1e-6), h = Math.max(bb.h, 1e-6);
  let best = null, bestScore = -Infinity;
  for (const nid of comp.nodeIds) {
    const d = remainingDegree(graph, nid, used);
    if (d === 0) continue;
    const n = graph.nodes[nid];
    const nx = (n.x - bb.x1) / w, ny = (n.y - bb.y1) / h;
    let s = -(0.65 * nx + 0.35 * ny);
    if (d === 1) s += 1.0; // a loose end is where a pen naturally lands
    if (prevEnd) s += 0.2 * (1 - clamp(dist(prevEnd, [n.x, n.y]) / Math.max(w, h), 0, 1));
    if (s > bestScore) { bestScore = s; best = nid; }
  }
  return best;
}

/**
 * The whole pen path of a decomposition in template space (glyph bbox
 * normalised, y up), resampled so alignment cost does not depend on how
 * densely each edge happened to be sampled.
 */
function normalisedPath(strokes, frame, em) {
  const out = [];
  for (const k of strokes) {
    const pts = resample(k.pts, Math.max(2, em * 0.02));
    for (const [x, y] of pts) {
      out.push([(x - frame.x0) / frame.w, 1 - (y - frame.y0) / frame.h]);
    }
  }
  return out;
}

function scoreDecomposition(comp, decomp, minStrokes, entryBias, template, frame, em) {
  return scoreParts(comp, decomp, minStrokes, entryBias, template, frame, em).total;
}

/** The whole-letter score, with its terms kept apart for the tuning readout. */
function scoreParts(comp, decomp, minStrokes, entryBias, template, frame, em) {
  const { strokes } = decomp;
  if (!strokes.length) return { total: -Infinity };
  const fit = template && frame ? templateFit(template, normalisedPath(strokes, frame, em)) : 0;
  // Retraced travel writes nothing: it counts against the stroke, not for it.
  const totalLen = strokes.reduce((s, k) => s + k.inkLength, 0) || 1e-6;
  const longest = Math.max(...strokes.map((k) => k.inkLength));
  const retraced = strokes.reduce((s, k) => s + k.retracedLen, 0);
  // Running back over a short stem or a bit of bar is how a hand joins
  // things. Running back the length of a whole arm to avoid a lift the
  // letter conventionally has (a K's arm, a t's bar) is tracing, not
  // writing - so that costs, but only where the convention says to lift:
  // an "ll" ligature runs up and down its second stem by design.
  const mergesConvention = template && strokes.length < template.length;
  const longRetrace = mergesConvention
    ? strokes.reduce((s, k) => s + (k.retraces || []).reduce((t, r) => t + Math.max(0, r.length - 0.35 * em), 0), 0) / em
    : 0;
  const stress = strokes.reduce((s, k) => s + (k.stress || 0), 0);
  const bb = comp.bbox;
  const w = Math.max(bb.w, 1e-6), h = Math.max(bb.h, 1e-6);

  const first = strokes[0].pts[0];
  const last = strokes[strokes.length - 1].pts.slice(-1)[0];
  const nx0 = (first[0] - bb.x1) / w, ny0 = (first[1] - bb.y1) / h;
  const startScore = 1 - (0.6 * nx0 + 0.4 * ny0);
  // A cursive lowercase letter is entered on its hairline: a loose end at the
  // far left, low in the letter, heading right. That entry is where the
  // previous letter hands the pen over, so it outranks "top-left".
  const lead = leadingTangent(strokes[0].pts, 6);
  // heading clearly up (any slant: an r's stem is entered from below and
  // climbed) or clearly right - never down or back
  const entry = entryBias && nx0 < 0.25 && ny0 > 0.45 && (lead[1] < -0.3 || lead[0] > 0.2) ? 1 : 0;
  const netRight = clamp((last[0] - first[0]) / w, -1, 1);

  let turnSum = 0, turnCount = 0;
  let vertLen = 0, vertDown = 0;
  for (const k of strokes) {
    for (const t of k.turns) { turnSum += t; turnCount++; }
    for (let i = 1; i < k.pts.length; i++) {
      const dx = k.pts[i][0] - k.pts[i - 1][0];
      const dy = k.pts[i][1] - k.pts[i - 1][1];
      if (Math.abs(dy) > Math.abs(dx)) {
        const l = Math.hypot(dx, dy);
        vertLen += l;
        if (dy > 0) vertDown += l;
      }
    }
  }
  const meanTurn = turnCount ? turnSum / turnCount : 0;
  const downFrac = vertLen > 0 ? vertDown / vertLen : 0.5;

  const parts = {
    longest: W.longestShare * (longest / totalLen),
    extra: -W.extraStroke * Math.max(0, strokes.length - minStrokes),
    retrace: -W.retrace * (retraced / totalLen) - W.retraceLong * longRetrace,
    turn: -W.turn * meanTurn,
    start: W.startTopLeft * startScore,
    entry: W.entry * entry,
    rightward: W.netRightward * netRight,
    down: W.downstroke * (downFrac - 0.5) * 2,
    stress: W.stress * clamp(stress / totalLen, -1, 1),
    template: W.template * fit,
    // more pen-downs than the letter conventionally has cost; fewer do not -
    // a script face joins what print writes separately (an H whose right
    // stem swings up into the bar), and a joined letter is the cursive ideal
    templateStrokes: template
      ? -W.templateStrokes * Math.max(0, strokes.filter((k) => k.inkLength > em * 0.1).length - template.length)
      : 0,
    contour: -W.contourBreak * (decomp.breaks || 0),
  };
  let total = 0;
  for (const v of Object.values(parts)) total += v;
  return { total, fit, strokes: strokes.length, ...parts };
}

function candidateStarts(comp, graph, limit = 14) {
  const bb = comp.bbox;
  const w = Math.max(bb.w, 1e-6), h = Math.max(bb.h, 1e-6);
  const withDeg = comp.nodeIds.map((nid) => {
    const n = graph.nodes[nid];
    return {
      nid,
      d: nodeDegree(graph, nid),
      tl: 0.6 * ((n.x - bb.x1) / w) + 0.4 * ((n.y - bb.y1) / h),
    };
  }).filter((c) => c.d > 0);

  // A pen starts at a loose end. Only a letter with none (a closed bowl) is
  // entered mid-line, at a junction.
  const leaves = withDeg.filter((c) => c.d === 1).sort((a, b) => a.tl - b.tl);
  const rest = withDeg.filter((c) => c.d !== 1).sort((a, b) => a.tl - b.tl);
  const picked = leaves.length ? leaves.slice(0, limit) : rest.slice(0, limit);
  return picked.map((c) => c.nid);
}

/** Euler: a graph with 2k odd-degree nodes needs at least k pen-down paths. */
function minStrokeCount(comp, graph) {
  let odd = 0;
  for (const nid of comp.nodeIds) if (nodeDegree(graph, nid) % 2 === 1) odd++;
  return Math.max(1, Math.ceil(odd / 2));
}

/* ------------------------------------------------------------------ */
/* crossbars hiding inside a connected component                       */
/* ------------------------------------------------------------------ */

function deferCrossbars(strokes, comp, em, glyphLabel, notes) {
  if (strokes.length < 2) return { keep: strokes, late: [] };
  const bb = comp.bbox;
  const total = strokes.reduce((sum, s) => sum + s.inkLength, 0) || 1e-6;
  const keep = [], late = [];
  for (const s of strokes) {
    const a = s.pts[0], b = s.pts.slice(-1)[0];
    const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    const midY = (a[1] + b[1]) / 2;
    const upper = midY < bb.y1 + 0.45 * Math.max(bb.h, 1e-6);
    // A bar is flat along its whole length, not just between its endpoints:
    // an 'n' entered and left at x-height has level endpoints too, but its
    // path drops to the baseline in between. It is also a minor part of the
    // letter, never most of it.
    const sb = bboxOf(s.pts);
    const flat = sb.h < 0.35 * Math.max(sb.w, 1e-6);
    const minor = s.inkLength < 0.5 * total;
    const isBar = dx > 2.5 * dy && s.length < 0.9 * em && upper && flat && minor;
    if (isBar) {
      s.role = 'crossbar';
      late.push(s);
      notes.push({
        severity: 'info',
        code: 'crossbar-deferred',
        message: `${glyphLabel}: a short horizontal stroke in the upper part of the letter was moved to the end (read as a crossbar)`,
        at: [(a[0] + b[0]) / 2, midY],
      });
    } else keep.push(s);
  }
  return { keep, late };
}

/* ------------------------------------------------------------------ */
/* bowl direction                                                      */
/* ------------------------------------------------------------------ */

/**
 * Cursive runs left to right. Reversing an open stroke costs nothing - it
 * covers exactly the same ink - so once the decomposition is settled, any
 * clearly horizontal stroke that ended up travelling backwards is flipped.
 */
function enforceLeftToRight(strokes, em, glyphLabel, notes) {
  for (const s of strokes) {
    if (s.oriented) continue; // its direction was judged by the whole-letter score
    const a = s.pts[0], b = s.pts.slice(-1)[0];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (dist(a, b) < 0.06 * em) continue;                 // closed-ish: handled by area
    if (Math.abs(dx) < 1.5 * Math.abs(dy)) continue;      // not a horizontal run
    if (dx >= -0.15 * em) continue;                       // already progressing rightward
    s.pts.reverse();
    notes.push({
      severity: 'info',
      code: 'stroke-direction',
      message: `${glyphLabel}: a mostly horizontal stroke was reversed to run left to right`,
      at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    });
  }
}

/** Shoelace area. In y-down raster space a negative value is visually CCW. */
function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return a / 2;
}

/**
 * Bowls (o, a, d, g) are written counter-clockwise. A closed stroke can be
 * flipped freely - it starts and ends in the same place - so enforce that.
 */
function orientClosedLoops(strokes, em, glyphLabel, notes) {
  for (const s of strokes) {
    const a = s.pts[0], b = s.pts.slice(-1)[0];
    if (dist(a, b) > 0.06 * em) continue;
    const area = signedArea(s.pts);
    if (Math.abs(area) < (0.04 * em) ** 2) continue;
    if (area > 0) {
      s.pts.reverse();
      notes.push({
        severity: 'info',
        code: 'loop-direction',
        message: `${glyphLabel}: a closed loop was flipped to counter-clockwise (handwriting draws bowls that way)`,
        at: a,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {object} graph  from buildSkeletonGraph, raster pixel space
 * @param {{em:number, label:string, lowercase?:boolean}} ctx
 *        em size in raster px, glyph label for messages, whether the glyph is
 *        a lowercase letter (entered from the left in cursive)
 * @returns {{strokes: Array, notes: Array}}
 */
export function orderStrokes(graph, ctx) {
  const { em, label, lowercase = false, medianRadius = 1, chars = '', frame = null } = ctx;
  const template = templateFor(chars);
  const { ordered, roles, notes: classNotes } = classifyComponents(graph, em);
  const notes = classNotes.map((n) => ({ ...n, message: `${label}: ${n.message}` }));
  const out = [];
  const deferred = [];
  const debug = []; // per component: the best-scoring candidates and their score terms

  for (const comp of ordered) {
    const role = roles.get(comp.id);

    if (comp.isDot) {
      // A dot thins away to a single node; emit a minimal two-point stroke so
      // the animation still has something to travel along.
      const n = graph.nodes[comp.nodeIds[0]];
      if (!n) continue;
      const r = Math.max(1, n.radius || 1);
      out.push({
        pts: [[n.x - r * 0.5, n.y], [n.x + r * 0.5, n.y]],
        role: 'dot',
        comp: comp.id,
        turns: [],
        length: r,
        inkLength: r,
        retraces: [],
        retracedLen: 0,
        tittle: true, // a real blob of ink, exempt from the min-length filter
      });
      continue;
    }

    const minStrokes = minStrokeCount(comp, graph);
    const starts = candidateStarts(comp, graph);
    let best = null, bestScore = -Infinity, secondScore = -Infinity, bestStart = null, secondStart = null;
    let candidates = 0;
    const ranked = [];
    // templates describe the letter body; marks are matched by nothing
    const tpl = role === 'body' && template && frame ? template : null;
    const beamTpl = tpl ? { wps: tpl.flat(), frame } : null;
    for (const s of starts) {
      const entryBias = lowercase && nodeDegree(graph, s) === 1;
      for (const d0 of beamSearch(comp, graph, s, em, medianRadius, beamTpl)) {
        candidates++;
        // Direction is a decision like any other: judge every way of
        // reversing the candidate's strokes by the whole-letter score (the
        // template's order, the entry, the rightward drift), not by a rule.
        let d = d0, parts = scoreParts(comp, d0, minStrokes, entryBias, tpl, frame, em);
        for (const alt of orientations(d0)) {
          const p = scoreParts(comp, alt, minStrokes, entryBias, tpl, frame, em);
          if (p.total > parts.total) { d = alt; parts = p; }
        }
        for (const k of d.strokes) k.oriented = true;
        const score = parts.total;
        ranked.push({ parts, d, s });
        if (score > bestScore) {
          if (bestStart !== s) { secondScore = bestScore; secondStart = bestStart; }
          bestScore = score;
          best = d;
          bestStart = s;
        } else if (score > secondScore && s !== bestStart) {
          secondScore = score;
          secondStart = s;
        }
      }
    }
    if (!best) continue;

    ranked.sort((a, b) => b.parts.total - a.parts.total);
    debug.push({
      component: comp.id,
      role,
      candidates,
      top: ranked.slice(0, 6).map(({ parts, d, s }) => ({
        start: [Math.round(graph.nodes[s].x), Math.round(graph.nodes[s].y)],
        paths: d.strokes.map((k) => k.pts.filter((_, i) => i % 3 === 0).map((p) => [Math.round(p[0]), Math.round(p[1])])),
        ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      })),
    });

    if (secondStart != null && Number.isFinite(secondScore)) {
      const gap = bestScore - secondScore;
      if (gap < AMBIGUOUS_ORDER * Math.max(1, Math.abs(bestScore))) {
        notes.push({
          severity: 'warn',
          code: 'start-point',
          message: `${label}: two different starting points scored within ${gap.toFixed(
            3
          )} of each other (${candidates} candidate paths in all) - the chosen pen entry is close to arbitrary`,
          at: [best.strokes[0].pts[0][0], best.strokes[0].pts[0][1]],
        });
      }
    }

    for (const amb of best.ambiguities) {
      notes.push({
        severity: 'warn',
        code: 'junction-branch',
        message: `${label}: at a junction with ${amb.n} ways to continue, the best two local scores were within ${amb.gap.toFixed(
          3
        )} - resolved by the whole-letter score`,
        at: amb.at,
      });
    }
    for (const s of best.strokes) {
      for (const r of s.retraces) {
        notes.push({
          severity: 'info',
          code: 'retrace',
          message: `${label}: the pen runs back ${(r.length / em).toFixed(2)} em along ink it has just written rather than lifting`,
          at: r.from,
        });
      }
    }

    // minStrokes travels with the strokes: the "could this have been one
    // stroke?" note is only honest once short fragments have been filtered.
    const strokes = best.strokes.map((s) => ({ ...s, role, comp: comp.id, minStrokes }));
    if (role === 'body') {
      const { keep, late } = deferCrossbars(strokes, comp, em, label, notes);
      out.push(...keep);
      deferred.push(...late);
    } else {
      out.push(...strokes);
    }
  }

  // crossbars found inside a connected letter body still come last overall
  const all = out.concat(deferred);
  enforceLeftToRight(all, em, label, notes);
  orientClosedLoops(all, em, label, notes);
  return { strokes: all, notes: dedupeNotes(notes), debug };
}

/** The same junction can be flagged by more than one traversal attempt. */
function dedupeNotes(notes) {
  const seen = new Set();
  return notes.filter((n) => {
    const key = `${n.code}|${n.at ? `${Math.round(n.at[0] / 4)},${Math.round(n.at[1] / 4)}` : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
