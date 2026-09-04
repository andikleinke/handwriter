/**
 * Skeleton -> polyline graph.
 *
 * Nodes are endpoints (1 neighbour), junctions (3+ neighbours) and isolated
 * dots (0 neighbours). Runs of 2-neighbour pixels between them become edges
 * carrying their pixel polyline.
 *
 * Thinning artefacts are cleaned up here: touching junction pixels collapse
 * into one node, short spurs are pruned, and pass-through nodes are merged
 * away so a long smooth curve stays a single edge.
 */

import { polylineLength, simplifyRDP, bboxOf, leadingTangent } from './geometry.js';

const D8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

function degreeMap(skel, w, h) {
  const deg = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!skel[i]) continue;
      let d = 0;
      for (const [dx, dy] of D8) if (skel[i + dy * w + dx]) d++;
      deg[i] = d;
    }
  }
  return deg;
}

export function buildSkeletonGraph(skel, w, h, opts = {}) {
  const {
    simplifyEps = 0.55,
    distMap = null,
    minDotRadius = 2.5,
    // A thinning spur at a stroke terminal is about as long as the ink is
    // thick there, so the test is local: compare against the edge's own
    // half-width, never against a glyph-wide average.
    spurFactor = 2.2,
    maxSpurLength = 40,
    spurRounds = 3,
  } = opts;
  const deg = degreeMap(skel, w, h);

  // ---- 1. cluster non-chain pixels into nodes -----------------------------
  const pixelNode = new Int32Array(w * h).fill(-1);
  const nodes = [];
  for (let i = 0; i < skel.length; i++) {
    if (!skel[i] || deg[i] === 2 || pixelNode[i] !== -1) continue;
    const id = nodes.length;
    const pixels = [];
    const stack = [i];
    pixelNode[i] = id;
    while (stack.length) {
      const p = stack.pop();
      pixels.push(p);
      const px = p % w, py = (p / w) | 0;
      for (const [dx, dy] of D8) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!skel[q] || deg[q] === 2 || pixelNode[q] !== -1) continue;
        pixelNode[q] = id;
        stack.push(q);
      }
    }
    let sx = 0, sy = 0;
    for (const p of pixels) { sx += p % w; sy += (p / w) | 0; }
    nodes.push({
      id,
      x: sx / pixels.length,
      y: sy / pixels.length,
      pixels,
      edges: [],
      alive: true,
    });
  }

  // ---- 2. trace edges -----------------------------------------------------
  const edges = [];
  const chainSeen = new Uint8Array(w * h);
  const directSeen = new Set();
  const maxWalk = skel.length + 8;

  const addEdge = (a, b, pts) => {
    const id = edges.length;
    edges.push({ id, a, b, pts, alive: true });
    nodes[a].edges.push(id);
    if (b !== a) nodes[b].edges.push(id);
    else nodes[a].edges.push(id); // self-loop occupies two slots
    return id;
  };

  const walkChain = (startPixel, firstPixel) => {
    const pts = [startPixel, firstPixel];
    chainSeen[firstPixel] = 1;
    let prev = startPixel, cur = firstPixel;
    for (let guard = 0; guard < maxWalk; guard++) {
      const cx = cur % w, cy = (cur / w) | 0;
      let next = -1;
      for (const [dx, dy] of D8) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!skel[q] || q === prev) continue;
        next = q;
        break;
      }
      if (next === -1) return { pts, end: -1 };
      pts.push(next);
      if (pixelNode[next] !== -1) return { pts, end: pixelNode[next] };
      if (chainSeen[next]) return { pts, end: -1 };
      chainSeen[next] = 1;
      prev = cur;
      cur = next;
    }
    return { pts, end: -1 };
  };

  for (const node of nodes) {
    for (const p of node.pixels) {
      const px = p % w, py = (p / w) | 0;
      for (const [dx, dy] of D8) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!skel[q]) continue;
        const qn = pixelNode[q];
        if (qn === node.id) continue;
        if (qn !== -1) {
          const key = p < q ? `${p}:${q}` : `${q}:${p}`;
          if (directSeen.has(key)) continue;
          directSeen.add(key);
          addEdge(node.id, qn, [p, q]);
          continue;
        }
        if (chainSeen[q]) continue;
        const { pts, end } = walkChain(p, q);
        addEdge(node.id, end === -1 ? node.id : end, pts);
      }
    }
  }

  // ---- 3. closed loops with no node on them -------------------------------
  for (let i = 0; i < skel.length; i++) {
    if (!skel[i] || deg[i] !== 2 || chainSeen[i] || pixelNode[i] !== -1) continue;
    // promote this pixel to a node, then trace the ring back to it
    const id = nodes.length;
    pixelNode[i] = id;
    nodes.push({ id, x: i % w, y: (i / w) | 0, pixels: [i], edges: [], alive: true });
    const px = i % w, py = (i / w) | 0;
    for (const [dx, dy] of D8) {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (!skel[q] || chainSeen[q] || pixelNode[q] !== -1) continue;
      const { pts, end } = walkChain(i, q);
      addEdge(id, end === -1 ? id : end, pts);
      break; // one traversal covers the whole ring
    }
  }

  // Nodes that never had an edge are real ink blobs (an i-tittle thins to
  // one). Nodes orphaned later by pruning are not - remember the difference.
  for (const n of nodes) n.wasIsolated = n.edges.length === 0;

  // ---- 4. pixel indices -> float points, simplify -------------------------
  for (const e of edges) {
    e.radius = medianDist(e.pts, distMap);
    const raw = e.pts.map((p) => [p % w, (p / w) | 0]);
    // snap the endpoints onto the node centroids so junctions stay coherent
    raw[0] = [nodes[e.a].x, nodes[e.a].y];
    raw[raw.length - 1] = [nodes[e.b].x, nodes[e.b].y];
    e.pts = simplifyRDP(raw, simplifyEps);
    e.length = polylineLength(e.pts);
  }

  const g = { nodes, edges };
  pruneSpurs(g, { spurFactor, maxSpurLength, rounds: spurRounds });
  contractJunctionKnots(g, (e) => Math.min(maxSpurLength, spurFactor * Math.max(e.radius || 1, 1)));
  mergePassThroughNodes(g);
  dropDegenerates(g);
  return compact(g, w, h, distMap, minDotRadius);
}

/**
 * Where two strokes cross, thinning leaves a knot: two or three junction
 * nodes about a stroke-width apart, joined by stubs. Contract the stubs so
 * the crossing is one node with clean arms - that is what the pen sees, and
 * it is what lets "carry straight on" be judged arm against arm.
 */
function contractJunctionKnots(g, maxLenFor) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 60) {
    changed = false;
    for (const e of g.edges) {
      if (!e.alive || e.a === e.b) continue;
      const maxLen = maxLenFor(e);
      if (e.length > maxLen) continue;
      const na = g.nodes[e.a], nb = g.nodes[e.b];
      if (aliveEdgesOf(g, na).length < 3 || aliveEdgesOf(g, nb).length < 3) continue;

      e.alive = false;
      na.x = (na.x + nb.x) / 2;
      na.y = (na.y + nb.y) / 2;
      for (const id of nb.edges) {
        const f = g.edges[id];
        if (!f.alive || id === e.id) continue;
        if (f.a === nb.id) f.a = na.id;
        if (f.b === nb.id) f.b = na.id;
        na.edges.push(id);
      }
      nb.alive = false;
      nb.edges = [];
      // re-anchor the arms on the merged node; a stub that became a tiny loop goes
      for (const id of na.edges) {
        const f = g.edges[id];
        if (!f.alive) continue;
        if (f.a === na.id) f.pts[0] = [na.x, na.y];
        if (f.b === na.id) f.pts[f.pts.length - 1] = [na.x, na.y];
        f.length = polylineLength(f.pts);
        if (f.a === f.b && f.length < maxLen * 2) f.alive = false;
      }
      changed = true;
    }
  }
}

function medianDist(pixels, distMap) {
  if (!distMap || !pixels.length) return 1;
  const vals = pixels.map((p) => distMap[p]).sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

/**
 * A node left with no edges is either a real dot (an i-tittle thins down to a
 * blob of ink) or a leftover speck. The distance transform tells them apart:
 * a dot sits at the centre of something several pixels thick.
 */
function dotRadiusOf(node, distMap) {
  if (!distMap) return Infinity;
  let r = 0;
  for (const p of node.pixels) if (distMap[p] > r) r = distMap[p];
  return r;
}

function aliveEdgesOf(g, node) {
  return node.edges.filter((id) => g.edges[id].alive);
}

/**
 * A leaf edge no longer than a couple of local half-widths is a thinning
 * artefact. The round limit matters as much as the threshold: one pass clears
 * genuine spurs, while an unbounded loop will happily nibble an entire limb
 * off the glyph one short edge at a time.
 */
function pruneSpurs(g, { spurFactor, maxSpurLength, rounds }) {
  const limitFor = (e) => Math.min(maxSpurLength, spurFactor * Math.max(e.radius || 1, 1));
  let changed = true;
  let guard = 0;
  while (changed && guard++ < rounds) {
    changed = false;
    for (const e of g.edges) {
      if (!e.alive) continue;
      const limit = limitFor(e);
      if (e.length >= limit) continue;
      const da = aliveEdgesOf(g, g.nodes[e.a]).length;
      const db = aliveEdgesOf(g, g.nodes[e.b]).length;
      const isLeaf = da === 1 || db === 1;
      const isolated = da <= 1 && db <= 1;
      if (!isLeaf || isolated) continue; // never delete a whole tiny component
      if (isTaperTail(g, e, da === 1 ? e.b : e.a, limitFor)) continue;
      e.alive = false;
      changed = true;
    }
  }
}

/**
 * A foot, not a fork. Thinning sprouts a *pair* of short spurs at a blunt
 * stroke end; a stem's foot is a *single* short spur at a junction that also
 * has two real branches (the stem arriving, the shoulder leaving) and that
 * carries straight on from one of them. Feet are kept: the pen dips into
 * them and back along their true curve. Forks are pruned.
 */
function isTaperTail(g, e, junctionId, limitFor) {
  const junction = g.nodes[junctionId];
  const incident = aliveEdgesOf(g, junction);
  if (incident.length < 3) return false;
  const leaving = (id) => {
    const f = g.edges[id];
    const pts = f.a === junctionId ? f.pts : [...f.pts].reverse();
    return leadingTangent(pts, 6);
  };
  let shortSpurs = 0;
  let continues = false;
  const mine = leaving(e.id);
  for (const id of incident) {
    const f = g.edges[id];
    if (f.a === f.b) continue;
    const other = f.a === junctionId ? f.b : f.a;
    if (aliveEdgesOf(g, g.nodes[other]).length === 1 && f.length < limitFor(f)) shortSpurs++;
    if (id !== e.id) {
      const d = leaving(id);
      if (-(d[0] * mine[0] + d[1] * mine[1]) > 0.5) continues = true;
    }
  }
  return shortSpurs === 1 && continues;
}

/** Collapse A-v-B into A-B so long curves survive as one edge. */
function mergePassThroughNodes(g) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const v of g.nodes) {
      if (!v.alive) continue;
      const inc = aliveEdgesOf(g, v);
      if (inc.length !== 2 || inc[0] === inc[1]) continue;
      const e1 = g.edges[inc[0]];
      const e2 = g.edges[inc[1]];
      if (e1.a === e1.b || e2.a === e2.b) continue; // self-loop, leave alone

      const p1 = e1.b === v.id ? e1.pts : [...e1.pts].reverse();
      const p2 = e2.a === v.id ? e2.pts : [...e2.pts].reverse();
      const other1 = e1.b === v.id ? e1.a : e1.b;
      const other2 = e2.a === v.id ? e2.b : e2.a;

      const pts = p1.concat(p2.slice(1));
      e1.alive = false;
      e2.alive = false;
      v.alive = false;
      const id = g.edges.length;
      g.edges.push({
        id,
        a: other1,
        b: other2,
        pts,
        length: polylineLength(pts),
        radius:
          ((e1.radius || 1) * e1.length + (e2.radius || 1) * e2.length) /
          Math.max(e1.length + e2.length, 1e-6),
        alive: true,
      });
      g.nodes[other1].edges.push(id);
      g.nodes[other2].edges.push(id);
      changed = true;
    }
  }
}

function dropDegenerates(g) {
  for (const e of g.edges) {
    if (e.alive && e.a === e.b && e.length < 2) e.alive = false;
  }
}

function compact(g, w, h, distMap, minDotRadius) {
  const nodeMap = new Map();
  const nodes = [];
  for (const n of g.nodes) {
    if (!n.alive) continue;
    const hasEdge = n.edges.some((id) => g.edges[id].alive);
    let radius = 0;
    if (!hasEdge) {
      if (!n.wasIsolated) continue; // orphaned by pruning, not a real mark
      radius = dotRadiusOf(n, distMap);
      if (radius < minDotRadius) continue; // speck, not a tittle
    }
    nodeMap.set(n.id, nodes.length);
    nodes.push({ id: nodes.length, x: n.x, y: n.y, edges: [], radius });
  }
  const edges = [];
  for (const e of g.edges) {
    if (!e.alive) continue;
    const a = nodeMap.get(e.a);
    const b = nodeMap.get(e.b);
    if (a === undefined || b === undefined) continue;
    const id = edges.length;
    // radius = median ink half-width along the edge: thick strokes are the
    // pen's downstrokes, hairlines its upstrokes
    edges.push({ id, a, b, pts: e.pts, length: e.length, radius: e.radius || 1 });
    nodes[a].edges.push(id);
    nodes[b].edges.push(id);
  }

  // connected components (union-find over nodes)
  const parent = nodes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent[ra] = rb;
  }
  const compIndex = new Map();
  const components = [];
  for (const n of nodes) {
    const r = find(n.id);
    if (!compIndex.has(r)) {
      compIndex.set(r, components.length);
      components.push({ id: components.length, nodeIds: [], edgeIds: [], totalLength: 0 });
    }
    const c = compIndex.get(r);
    n.comp = c;
    components[c].nodeIds.push(n.id);
  }
  for (const e of edges) {
    const c = nodes[e.a].comp;
    e.comp = c;
    components[c].edgeIds.push(e.id);
    components[c].totalLength += e.length;
  }
  for (const c of components) {
    const pts = [];
    for (const eid of c.edgeIds) pts.push(...edges[eid].pts);
    for (const nid of c.nodeIds) pts.push([nodes[nid].x, nodes[nid].y]);
    c.bbox = bboxOf(pts);
    c.isDot = c.edgeIds.length === 0;
  }

  return { nodes, edges, components, width: w, height: h };
}
