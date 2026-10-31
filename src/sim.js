// Pure simulation: interlocking (routes, switches, locking), pathfinding; later tasks add signals,
// trains, traffic and the operator. Never touches window, document, Math.random or Date; randomness
// comes only from sim.rng (makeRng(seed + ':sim')).
//
// Travel direction is decided by x alone, never by edge a->b order: a dir=+1 train leaves a node
// through edges whose far node has greater x, dir=-1 through smaller x. Edge dirs must also allow it.
import { makeRng } from './rng.js';

const SLOW_CLS = new Set(['yard', 'siding', 'spur']);
const far = (edge, n) => (edge.a === n ? edge.b : edge.a);

export function createSim(layout, seed, opts = { density: 'normal' }) {
  const adj = new Map(layout.nodes.map(n => [n.id, []]));
  for (const e of layout.edges) { adj.get(e.a).push(e.id); adj.get(e.b).push(e.id); }
  const start = 6 * 3600; // 06:00
  const sim = {
    layout, adj,
    edgeState: layout.edges.map(() => ({ occ: new Set(), route: null })),
    switchState: new Map(layout.switches.map(s => [s.node, { lie: 'normal' }])),
    signalAt: new Map(layout.signals.map(s => [`${s.node}:${s.dir}`, s.id])),
    switchAt: new Map(layout.switches.map(s => [s.node, s])), // node -> {node, trunk, normal, reverse}
    routesFrom: new Map(),
    routes: new Map(), nextRouteId: 1,
    trains: new Map(), reserved: new Map(),
    queue: { 1: [], '-1': [] }, nextSpawn: { 1: start, '-1': start }, completed: [],
    time: start, log: [], auto: false, density: opts.density ?? 'normal',
    rng: makeRng(seed + ':sim'), _aspects: new Map(),
  };
  for (const sig of layout.signals) sim.routesFrom.set(sig.id, candidates(sim, sig));
  return sim;
}

export const entryPortalNode = (sim, dir) => sim.layout.portals.find(p => p.dir === dir).node;

// The far end of that direction's main: the same row as its entry portal, at the opposite edge.
export function exitPortalNode(sim, dir) {
  const { nodes, cols } = sim.layout, y = nodes[entryPortalNode(sim, dir)].y;
  return nodes.find(n => n.y === y && n.x === (dir > 0 ? cols - 1 : 0)).id;
}

export function forwardEdges(sim, node, dir) {
  const { nodes, edges } = sim.layout, x = nodes[node].x;
  return sim.adj.get(node).filter(e =>
    Math.sign(nodes[far(edges[e], node)].x - x) === dir && edges[e].dirs.includes(dir));
}

// DFS from the signal in its direction; each branch ends at the first node carrying a signal for that
// direction, or with nowhere further to go (the exit portal).
function candidates(sim, sig) {
  const { edges } = sim.layout, dir = sig.dir, out = [];
  const walk = (n, path, nodes) => {
    for (const e of forwardEdges(sim, n, dir)) {
      const next = far(edges[e], n), p = [...path, e], ns = [...nodes, next];
      if (sim.signalAt.has(`${next}:${dir}`) || !forwardEdges(sim, next, dir).length) out.push(candidate(sim, dir, p, ns));
      else walk(next, p, ns);
    }
  };
  walk(sig.node, [], [sig.node]);
  return out;
}

function candidate(sim, dir, es, nodes) {
  const { edges } = sim.layout, exitNode = nodes.at(-1);
  // A switch the route touches needs reverse if the route uses its reverse leg (facing or trailing),
  // normal if it uses the normal leg; touching only the trunk (at a route end) asks nothing of it.
  const switches = [];
  for (const n of nodes) {
    const s = sim.switchAt.get(n);
    if (s && es.includes(s.reverse)) switches.push({ node: n, lie: 'reverse' });
    else if (s && es.includes(s.normal)) switches.push({ node: n, lie: 'normal' });
  }
  return {
    edges: es, switches, exitNode,
    exitSignal: sim.signalAt.get(`${exitNode}:${dir}`) ?? null,
    diverging: switches.some(s => s.lie === 'reverse'),
    slow: SLOW_CLS.has(edges[es.at(-1)].cls),
    len: es.reduce((sum, e) => sum + edges[e].len, 0),
  };
}

// ponytail: a switch is held only by its trunk edge (occupied or routed); no flank protection (spec).
// Every route through a switch uses its trunk, and a train standing on a leg is clear of the points:
// trains stop FOUL short of signals and track capacity is edge length - 0.5, so a tail sits >= 0.2
// cells off the ladder node. If train stopping ever changes, model fouling points instead.
export function switchLocked(sim, node) {
  const sw = sim.switchAt.get(node), st = sw && sim.edgeState[sw.trunk];
  return !!st && (st.occ.size > 0 || st.route !== null);
}

export function throwSwitch(sim, node) {
  const st = sim.switchState.get(node);
  if (!st || switchLocked(sim, node)) return false;
  st.lie = st.lie === 'normal' ? 'reverse' : 'normal';
  return true;
}

// The signal's un-entered route, or null. Entered routes still clearing behind their train don't count.
export function routeFrom(sim, signalId) {
  for (const r of sim.routes.values()) if (r.signal === signalId && !r.entered) return r;
  return null;
}

export function setRoute(sim, signalId, exitNode, { human = false, trainId = null } = {}) {
  // ponytail: exitNode picks the first matching candidate; generated layouts never give one signal two
  // routes to the same exit. If they ever do, try each match (or take the candidate itself).
  const cand = (sim.routesFrom.get(signalId) ?? []).find(c => c.exitNode === exitNode);
  const fail = reason => ({ ok: false, reason });
  if (!cand) return fail('no such route');
  if (routeFrom(sim, signalId)) return fail('already set');
  if (cand.edges.some(e => sim.edgeState[e].occ.size > 0)) return fail('occupied');
  if (cand.edges.some(e => sim.edgeState[e].route !== null)) return fail('locked');
  if (cand.switches.some(s => sim.switchState.get(s.node).lie !== s.lie && switchLocked(sim, s.node))) return fail('switch busy');
  for (const s of cand.switches) sim.switchState.get(s.node).lie = s.lie;
  const route = { id: sim.nextRouteId++, signal: signalId, cand, trainId, human, entered: false };
  for (const e of cand.edges) sim.edgeState[e].route = route.id;
  sim.routes.set(route.id, route);
  return { ok: true, route };
}

export function cancelRoute(sim, routeId) {
  const route = sim.routes.get(routeId);
  if (!route || route.entered) return false;
  for (const e of route.cand.edges) if (sim.edgeState[e].route === routeId) sim.edgeState[e].route = null;
  sim.routes.delete(routeId);
  return true;
}

export function releaseEdge(sim, edgeId) {
  const st = sim.edgeState[edgeId], id = st.route;
  if (id === null) return;
  st.route = null;
  const route = sim.routes.get(id);
  if (route && !route.cand.edges.some(e => sim.edgeState[e].route === id)) sim.routes.delete(id);
}

// Drops the edges the tail has left from the front of train.path. Positions are cumulative along the
// train's whole run: path[0] starts at train.pathOff, the head is at headDist, the tail at headDist - len.
export function sectionalRelease(sim, train) {
  const { edges } = sim.layout;
  while (train.path.length && train.pathOff + edges[train.path[0]].len <= train.headDist - train.len) {
    const e = train.path.shift();
    sim.edgeState[e].occ.delete(train.id);
    releaseEdge(sim, e);
    train.pathOff += edges[e].len;
  }
}

// Edge is taken if anyone but the caller occupies it, or a route not held by the caller locks it.
function blocked(sim, e, trainId) {
  const own = id => trainId != null && id === trainId, st = sim.edgeState[e];
  return [...st.occ].some(t => !own(t)) || (st.route !== null && !own(sim.routes.get(st.route).trainId));
}

// Dijkstra over forward edges. goal {node}: reach it. goal {track}: stop on the first edge of that track
// (a virtual sink, so the returned list ends with that edge). penalty: {trainId?, [edgeId]: extraCost}.
// ponytail: linear-scan priority queue, fine for generated layouts (< 200 nodes); a binary heap if they grow.
export function findPath(sim, fromNode, dir, goal, penalty = {}) {
  const { edges } = sim.layout, SINK = -1;
  const dist = new Map([[fromNode, 0]]), prev = new Map(), done = new Set();
  for (;;) {
    let u = null;
    for (const [n, d] of dist) if (!done.has(n) && (u === null || d < dist.get(u))) u = n;
    if (u === null) return null;
    if (u === SINK || u === goal.node) {
      const path = [];
      for (let n = u; n !== fromNode; n = prev.get(n).from) path.unshift(prev.get(n).edge);
      return path;
    }
    done.add(u);
    for (const e of forwardEdges(sim, u, dir)) {
      if (blocked(sim, e, penalty.trainId)) continue;
      const ed = edges[e];
      const v = goal.track != null && ed.track === goal.track ? SINK : far(ed, u);
      const d = dist.get(u) + ed.len + (ed.cls === 'ladder' ? 1 : 0) + (penalty[e] ?? 0);
      if (!done.has(v) && (!dist.has(v) || d < dist.get(v))) { dist.set(v, d); prev.set(v, { from: u, edge: e }); }
    }
  }
}

// ---- Signal aspects (American, spec "Signals")
export const ASPECT = { STOP: 'STOP', RESTRICTING: 'RESTRICTING', APPROACH: 'APPROACH', ADVANCE_APPROACH: 'ADVANCE_APPROACH',
  CLEAR: 'CLEAR', DIVERGING_CLEAR: 'DIVERGING_CLEAR', DIVERGING_APPROACH: 'DIVERGING_APPROACH', SLOW_CLEAR: 'SLOW_CLEAR' };

export const clearAspects = sim => sim._aspects.clear();

// Memoised in sim._aspects (step clears it each tick). Recursion follows exit signals along one direction's
// DAG (x strictly increases), so it terminates.
export function aspectOf(sim, signalId) {
  const memo = sim._aspects;
  if (memo.has(signalId)) return memo.get(signalId);
  let a = ASPECT.STOP;
  const route = routeFrom(sim, signalId);
  if (route) {
    const c = route.cand, next = c.exitSignal !== null ? aspectOf(sim, c.exitSignal) : ASPECT.CLEAR;
    if (sim.layout.signals[signalId].kind === 'dwarf') a = c.slow || next === ASPECT.STOP ? ASPECT.RESTRICTING : ASPECT.SLOW_CLEAR;
    else if (c.slow) a = ASPECT.RESTRICTING;
    else if (c.diverging) a = next === ASPECT.STOP || next === ASPECT.RESTRICTING ? ASPECT.DIVERGING_APPROACH : ASPECT.DIVERGING_CLEAR;
    else a = next === ASPECT.STOP ? ASPECT.APPROACH : next === ASPECT.CLEAR ? ASPECT.CLEAR : ASPECT.ADVANCE_APPROACH;
  }
  memo.set(signalId, a);
  return a;
}

export function signalHeads(sim, signalId) {
  if (sim.layout.signals[signalId].kind !== 'high') return 1;
  return sim.routesFrom.get(signalId).some(c => c.diverging || c.slow) ? 2 : 1;
}

// F prefix = flashing. ponytail: a 1-head high signal asked for a diverging/restricting aspect shows stop.
const HIGH2 = { CLEAR: ['G', 'R'], APPROACH: ['Y', 'R'], ADVANCE_APPROACH: ['FY', 'R'], DIVERGING_CLEAR: ['R', 'G'],
  DIVERGING_APPROACH: ['R', 'Y'], RESTRICTING: ['R', 'FR'], STOP: ['R', 'R'] };
const HIGH1 = { CLEAR: 'G', APPROACH: 'Y', ADVANCE_APPROACH: 'FY' };
const DWARF = { RESTRICTING: 'FR', SLOW_CLEAR: 'G' };
export function lamps(aspect, kind, heads) {
  if (kind === 'dwarf') return { top: DWARF[aspect] ?? 'R' };
  if (heads === 1) return { top: HIGH1[aspect] ?? 'R' };
  const [top, bottom] = HIGH2[aspect] ?? HIGH2.STOP;
  return { top, bottom };
}
