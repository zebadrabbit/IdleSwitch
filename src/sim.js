// Pure simulation: interlocking (routes, switches, locking), pathfinding, signal aspects, trains, traffic and the
// virtual operator; step(sim) advances it one sim second. Never touches window, document, Math.random or Date;
// randomness comes only from sim.rng (makeRng(seed + ':sim')).
//
// Travel direction is decided by x alone, never by edge a->b order: a dir=+1 train leaves a node
// through edges whose far node has greater x, dir=-1 through smaller x. Edge dirs must also allow it.
import { makeRng, randInt } from './rng.js';

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
    routesFrom: new Map(), sectionEdges: new Map(), // section -> its main edge ids
    routes: new Map(), nextRouteId: 1,
    trains: new Map(), nextTrainId: 1, reserved: new Map(),
    queue: { 1: [], '-1': [] }, nextSpawn: { 1: start, '-1': start }, completed: [],
    time: start, log: [], auto: false, density: opts.density ?? 'normal',
    rng: makeRng(seed + ':sim'), _aspects: new Map(),
  };
  for (const e of layout.edges)
    if (e.section != null) sim.sectionEdges.set(e.section, [...(sim.sectionEdges.get(e.section) ?? []), e.id]);
  for (const sig of layout.signals) sim.routesFrom.set(sig.id, candidates(sim, sig));
  // Train numbers count up per direction from a seeded start in 100..400: even eastbound, odd westbound.
  sim.nextName = { 1: 2 * randInt(sim.rng, 50, 200), '-1': 2 * randInt(sim.rng, 50, 199) + 1 };
  return sim;
}

export const entryPortalNode = (sim, dir) => sim.layout.portals.find(p => p.dir === dir).node;

// The far end of both mains for dir, its home main first: both rows run on off the panel as a two-track main.
export function exitNodes(sim, dir) {
  const { nodes, cols, mainRow } = sim.layout, x = dir > 0 ? cols - 1 : 0;
  return [mainRow[dir], mainRow[-dir]].map(y => nodes.find(n => n.x === x && n.y === y).id);
}

export function forwardEdges(sim, node, dir) {
  const { nodes, edges } = sim.layout, x = nodes[node].x;
  return sim.adj.get(node).filter(e =>
    Math.sign(nodes[far(edges[e], node)].x - x) === dir && edges[e].dirs.includes(dir));
}

// DFS from the signal in its direction; each branch ends at the first node carrying a signal for that
// direction, or with nowhere further to go (an exit node).
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
    wrongMain: edges[es.findLast(e => edges[e].main != null)]?.main === -dir, // it ends on the other direction's home main
    slow: SLOW_CLS.has(edges[es.at(-1)].cls),
    len: es.reduce((sum, e) => sum + edges[e].len, 0),
  };
}

// ponytail: a switch is held only by its trunk edge (occupied or routed); no flank protection (spec).
// Every route through a switch uses its trunk, and a train standing on a leg is clear of the points:
// trains stop FOUL short of signals and track capacity is edge length - 0.5, so a tail sits >= 0.2
// cells off the ladder node (adopt never takes a train into a track it doesn't fit). If train stopping ever
// changes, model fouling points instead.
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

// Wrong main: its path, or a route set for it that it has yet to take (the operator sets several before any train
// moves), runs on a main edge of the other direction's home.
export const isWrongMain = (sim, train) => [train.path, ...[...sim.routes.values()]
  .filter(r => r.trainId === train.id && !train.routes.includes(r.id)).map(r => r.cand.edges)]
  .some(es => es.some(e => sim.layout.edges[e].main === -train.dir));
export const wrongMainTrains = sim => [...sim.trains.values()].filter(t => isWrongMain(sim, t));

// Traffic locking: any edge of a main section the route touches holds a train, or a route, of the other direction.
function opposing(sim, cand, dir) {
  const { edges, signals } = sim.layout, secs = new Set(cand.edges.map(e => edges[e].section).filter(s => s != null));
  return [...secs].some(s => sim.sectionEdges.get(s).some(e => {
    const st = sim.edgeState[e];
    return [...st.occ].some(id => sim.trains.get(id)?.dir === -dir)
      || (st.route !== null && signals[sim.routes.get(st.route).signal].dir !== dir);
  }));
}

export function setRoute(sim, signalId, exitNode, { human = false, trainId = null } = {}) {
  // ponytail: exitNode picks the first matching candidate. Generated layouts give one signal two routes to the same
  // exit only over and back through a crossover pair, and DFS meets the straight one first (main edges come first in
  // adj). If that ever changes, try each match (or take the candidate itself).
  const cand = (sim.routesFrom.get(signalId) ?? []).find(c => c.exitNode === exitNode), sig = sim.layout.signals[signalId];
  const fail = reason => ({ ok: false, reason });
  if (!cand) return fail('no such route');
  if (routeFrom(sim, signalId)) return fail('already set');
  if (cand.edges.some(e => sim.edgeState[e].occ.size > 0)) return fail('occupied');
  if (cand.edges.some(e => sim.edgeState[e].route !== null)) return fail('locked');
  if (cand.switches.some(s => sim.switchState.get(s.node).lie !== s.lie && switchLocked(sim, s.node))) return fail('switch busy');
  if (opposing(sim, cand, sig.dir)) return fail('opposing');
  // One wrong-main train at a time; the one at this signal (or the one the route is for) may go on or home.
  if (cand.wrongMain && wrongMainTrains(sim).some(t => t.id !== trainId && headNode(sim, t) !== sig.node)) return fail('wrong main');
  for (const s of cand.switches) sim.switchState.get(s.node).lie = s.lie;
  const route = { id: sim.nextRouteId++, signal: signalId, cand, trainId, human, entered: false, setAt: sim.time };
  for (const e of cand.edges) sim.edgeState[e].route = route.id;
  sim.routes.set(route.id, route);
  clearAspects(sim);
  return { ok: true, route };
}

export function cancelRoute(sim, routeId) {
  const route = sim.routes.get(routeId);
  if (!route || route.entered) return false;
  for (const e of route.cand.edges) if (sim.edgeState[e].route === routeId) sim.edgeState[e].route = null;
  sim.routes.delete(routeId);
  clearAspects(sim);
  return true;
}

export function releaseEdge(sim, edgeId) {
  const st = sim.edgeState[edgeId], id = st.route;
  if (id === null) return;
  st.route = null;
  const route = sim.routes.get(id);
  if (route && !route.cand.edges.some(e => sim.edgeState[e].route === id)) sim.routes.delete(id);
  clearAspects(sim);
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

export const PASS_WAIT = 60; // stood this long, a train ahead counts as standing (findPath's standingCost)

// Extra cost of edge e for findPath: 0 if free. Blocked by trains that have all stood PASS_WAIT (or ids not on the board):
// standingCost; by a moving train, or only by another's route: blockedCost. undefined (cost not given) = impassable.
function blockCost(sim, e, penalty) {
  if (!blocked(sim, e, penalty.trainId)) return 0;
  const t = id => sim.trains.get(id), occ = [...sim.edgeState[e].occ].filter(id => id !== penalty.trainId);
  const standing = occ.length && occ.every(id => !t(id) || sim.time - t(id).lastMoveTime >= PASS_WAIT);
  return standing ? penalty.standingCost : penalty.blockedCost;
}

// Dijkstra over forward edges. goal {node}: reach it. goal {exit: true}: reach either of exitNodes. goal {track}: stop
// on the first edge of that track (a virtual sink, so the returned list ends with that edge).
// penalty: {trainId?, blockedCost?, standingCost?, wrongMainCost?, [edgeId]: extraCost}. Blocked edges cost
// blockedCost or standingCost extra (blockCost), so the operator still sees its way past trains ahead and leaves "can
// the next route be set now" to setRoute; a class without its cost is skipped. A main edge of the other direction's
// home costs wrongMainCost (default 0) extra; a ladder or crossover 1.
// ponytail: linear-scan priority queue, fine for generated layouts (< 200 nodes); a binary heap if they grow.
export function findPath(sim, fromNode, dir, goal, penalty = {}) {
  const { edges } = sim.layout, SINK = -1, exits = goal.exit ? exitNodes(sim, dir) : [];
  const dist = new Map([[fromNode, 0]]), prev = new Map(), done = new Set();
  for (;;) {
    let u = null;
    for (const [n, d] of dist) if (!done.has(n) && (u === null || d < dist.get(u))) u = n;
    if (u === null) return null;
    if (u === SINK || u === goal.node || exits.includes(u)) {
      const path = [];
      for (let n = u; n !== fromNode; n = prev.get(n).from) path.unshift(prev.get(n).edge);
      return path;
    }
    done.add(u);
    for (const e of forwardEdges(sim, u, dir)) {
      const extra = blockCost(sim, e, penalty);
      if (extra == null) continue;
      const ed = edges[e];
      const v = goal.track != null && ed.track === goal.track ? SINK : far(ed, u);
      const d = dist.get(u) + ed.len + (ed.cls === 'ladder' || ed.cls === 'crossover' ? 1 : 0) + (penalty[e] ?? 0) + extra
        + (ed.main === -dir ? penalty.wrongMainCost ?? 0 : 0);
      if (!done.has(v) && (!dist.has(v) || d < dist.get(v))) { dist.set(v, d); prev.set(v, { from: u, edge: e }); }
    }
  }
}

// ---- Signal aspects (American, spec "Signals")
export const ASPECT = { STOP: 'STOP', RESTRICTING: 'RESTRICTING', APPROACH: 'APPROACH', ADVANCE_APPROACH: 'ADVANCE_APPROACH',
  CLEAR: 'CLEAR', DIVERGING_CLEAR: 'DIVERGING_CLEAR', DIVERGING_APPROACH: 'DIVERGING_APPROACH', SLOW_CLEAR: 'SLOW_CLEAR' };

export const clearAspects = sim => sim._aspects.clear();

// Memoised in sim._aspects; route changes and moveTrains clear it. Recursion follows exit signals along one
// direction's DAG (x strictly increases), so it terminates.
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

// ---- Trains (spec "Trains", "Speeds"). Grid cells and sim seconds; MPH converts mph to cells/s.
export const MPH = 1 / 180, CAR = 0.6, LOCO = 0.8, FOUL = 0.3;
// acc/dec in mph per sim-second.
export const TYPES = {
  X: { name: 'Express', prio: 5, cars: 8, max: 60, acc: 1.0, dec: 1.5, passenger: true },
  P: { name: 'Passenger', prio: 4, cars: 5, max: 60, acc: 1.0, dec: 1.5, passenger: true },
  Z: { name: 'Priority intermodal', prio: 3, cars: 12, max: 60, acc: 0.5, dec: 0.8 },
  M: { name: 'Manifest', prio: 2, cars: 14, max: 50, acc: 0.4, dec: 0.7 },
  C: { name: 'Unit coal', prio: 1, cars: 20, max: 45, acc: 0.3, dec: 0.6 },
  G: { name: 'Grain', prio: 1, cars: 16, max: 45, acc: 0.3, dec: 0.6 },
  I: { name: 'Intermodal', prio: 1, cars: 12, max: 50, acc: 0.4, dec: 0.7 },
  L: { name: 'Local', prio: 0, cars: 6, max: 40, acc: 0.5, dec: 0.8 },
};

export const trainLength = type => LOCO + TYPES[type].cars * CAR;

// Head at the entry portal node with nothing occupied; its first adopted route gives it its first edges.
// Positions are cumulative along the train's run from that portal: path[0] starts at pathOff.
// id: the spawner hands in the id it gave the queue entry, so a train holding for a queued one finds it later.
export function spawnTrain(sim, { type, dir, dest = null, name, id = sim.nextTrainId++ }) {
  const T = TYPES[type];
  const train = {
    id, name: name ?? `${type} ${id}`, type, dir, prio: T.prio, len: trainLength(type), maxSpeed: T.max * MPH,
    path: [], routes: [], pathOff: 0, headDist: 0, speed: 0, state: 'entering', dest,
    goal: dest !== null ? { track: dest } : { exit: true },
    dwellUntil: 0, holdFor: null, spawnTime: sim.time, sched: sim.time, lastMoveTime: sim.time, stops: 0, stalled: false, events: [],
  };
  sim.trains.set(id, train);
  return train;
}

// The end of the edge in travel direction (edges always span x, so the x rule decides).
function toNode(sim, edgeId, dir) {
  const { nodes, edges } = sim.layout, e = edges[edgeId];
  return (nodes[e.b].x - nodes[e.a].x) * dir > 0 ? e.b : e.a;
}

// Where the train's path ends: the entry portal before its first route, else the far end of its last edge.
export function headNode(sim, train) {
  return train.path.length ? toNode(sim, train.path.at(-1), train.dir) : entryPortalNode(sim, train.dir);
}

export const pathLength = (sim, train) => train.path.reduce((s, e) => s + sim.layout.edges[e].len, train.pathOff);

// Grid coords at dist along the path; null before its start (released edges, or behind the portal) or past its end.
export function pointAt(sim, train, dist) {
  const { nodes, edges } = sim.layout;
  if (dist < train.pathOff) return null;
  let s = train.pathOff;
  for (const id of train.path) {
    const len = edges[id].len;
    if (dist <= s + len) {
      const b = nodes[toNode(sim, id, train.dir)], a = nodes[far(edges[id], b.id)], f = (dist - s) / len;
      return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
    }
    s += len;
  }
  if (dist !== s) return null;
  const n = nodes[headNode(sim, train)];
  return { x: n.x, y: n.y };
}

// Loco then cars, head first, each clipped to the path (dropped if wholly off it).
// ponytail: a block spanning a bend draws as a straight chord; blocks are under a cell long.
export function trainBlocks(sim, train) {
  const out = [], start = train.pathOff, end = pathLength(sim, train);
  for (let i = 0; i <= TYPES[train.type].cars; i++) {
    const front = train.headDist - (i ? LOCO + (i - 1) * CAR : 0), back = front - (i ? CAR : LOCO);
    const hi = Math.min(front, end), lo = Math.max(back, start);
    if (hi <= lo) continue;
    const p = pointAt(sim, train, hi), q = pointAt(sim, train, lo);
    out.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, kind: i ? 'car' : 'loco' });
  }
  return out;
}

// cancelRoute only takes un-entered routes. One cancelled ahead of a train drops off its path, with the train's
// routes beyond it (they would be stranded), so the train brakes for the signal again. The cut is the first edge
// not carrying one of train.routes (the routes it adopted), which is the cancelled route's first edge, at its
// signal: routes from one signal share leading edges, so a new route set there since must not count as the old one.
function dropCancelled(sim, train) {
  const { edges } = sim.layout;
  train.routes = train.routes.filter(id => sim.routes.has(id)); // drops cancelled and fully released routes
  let s = train.pathOff;
  const cut = train.path.findIndex(e => {
    const gone = s > train.headDist && !train.routes.includes(sim.edgeState[e].route);
    s += edges[e].len;
    return gone;
  });
  if (cut < 0) return;
  for (const e of train.path.splice(cut)) {
    const id = sim.edgeState[e].route;
    if (train.routes.includes(id)) { cancelRoute(sim, id); train.routes = train.routes.filter(r => r !== id); }
  }
}

// Take the un-entered route from the signal where the path ends (and the next, and so on).
function adopt(sim, train) {
  for (;;) {
    const sig = sim.signalAt.get(`${headNode(sim, train)}:${train.dir}`);
    const route = sig === undefined ? null : routeFrom(sim, sig);
    if (!route || (route.trainId !== null && route.trainId !== train.id)) return;
    // ponytail: never into a track the train doesn't fit (a human route can ask it; the operator checks fits). This is
    // what keeps switchLocked's trunk-only rule true: only a train that fits stands clear of the points at both ends.
    const into = sim.layout.edges[route.cand.edges.at(-1)].track;
    if (into !== null && !fits(sim, train, into)) return;
    train.path.push(...route.cand.edges);
    train.routes.push(route.id);
    route.trainId = train.id;
    train.events.push({ t: sim.time, kind: 'route', signal: signalLabel(sim, route.signal), ...(route.human ? { human: true } : {}) });
  }
}

// Path edges overlapping (tail, headDist] are occupied: [s, e) overlaps it iff s <= head && e > tail. This is
// the complement of sectionalRelease's e <= tail for everything the head has reached, so release and occupancy agree.
function occupy(sim, train) {
  const { edges } = sim.layout, tail = train.headDist - train.len;
  let s = train.pathOff;
  for (const e of train.path) {
    if (s > train.headDist) break;
    if (s + edges[e].len > tail) {
      const st = sim.edgeState[e];
      st.occ.add(train.id);
      if (st.route !== null) sim.routes.get(st.route).entered = true; // the head is in: its signal drops to stop
    }
    s += edges[e].len;
  }
}

// Releases every edge the train still holds, cancels any route set for it that it never entered, drops its
// reservation, then logs its delay and records it in sim.completed with its distance (cells of path run, portal to
// portal) and its event log.
export function despawnTrain(sim, train) {
  for (const e of train.path) {
    sim.edgeState[e].occ.delete(train.id);
    releaseEdge(sim, e);
    train.pathOff += sim.layout.edges[e].len;
  }
  train.path = [];
  for (const r of [...sim.routes.values()]) if (!r.entered && r.trainId === train.id) cancelRoute(sim, r.id);
  for (const [t, id] of sim.reserved) if (id === train.id) sim.reserved.delete(t);
  train.state = 'done';
  sim.trains.delete(train.id);
  const delay = sim.time - train.sched, m = Math.round(delay / 60);
  const portal = sim.layout.portals.find(p => p.dir === -train.dir).name; // where the other direction enters
  logEvent(sim, `${train.name} out via ${portal} (${m < 0 ? '−' : '+'}${Math.abs(m)} min)`);
  train.events.push({ t: sim.time, kind: 'out' });
  sim.completed.push({ name: train.name, type: train.type, delay, spawnTime: train.spawnTime, exitTime: sim.time, stops: train.stops,
    distance: train.pathOff, events: train.events });
  clearAspects(sim);
}

// One step of dt sim seconds for every train. Does not advance sim.time (step owns it).
export function moveTrains(sim, dt = 1) {
  const { edges } = sim.layout;
  for (const train of [...sim.trains.values()]) {
    dropCancelled(sim, train);
    adopt(sim, train);
    const runOff = train.path.length > 0 && exitNodes(sim, train.dir).includes(headNode(sim, train));
    const acc = TYPES[train.type].acc * MPH, dec = TYPES[train.type].dec * MPH;
    const held = train.state === 'dwelling' || train.state === 'holding';
    // Limit: the head's edge, and every edge ahead braked down to from where the head is now.
    // ponytail: speed limits read the head's edge only; a tail still on slower track doesn't hold the train.
    let vAllowed = held ? 0 : train.maxSpeed, s = train.pathOff;
    for (const e of train.path) {
      const end = s + edges[e].len;
      const ahead = Math.max(0, s - train.headDist), ve = edges[e].speed * MPH;
      if (end > train.headDist) vAllowed = Math.min(vAllowed, Math.sqrt(ve * ve + 2 * dec * ahead));
      s = end;
    }
    const remaining = runOff ? Infinity : s - train.headDist - FOUL; // to the stop point FOUL short of the path's end
    vAllowed = Math.min(vAllowed, Math.sqrt(2 * dec * Math.max(0, remaining)));
    // ponytail: brake curve is one-sided; fine for a panel sim
    let v = Math.min(train.speed + acc * dt, vAllowed), adv = v * dt;
    // Never past the stop point: arrive and stand. Rounding leaves ~1e-16 of remaining once there; that is not a move.
    if (adv >= remaining) { adv = remaining > 1e-9 ? remaining : 0; v = 0; }
    if (train.speed > 0 && v === 0) train.stops++;
    train.speed = v;
    train.headDist += adv;
    if (adv > 0) Object.assign(train, { lastMoveTime: sim.time, stalled: false });
    occupy(sim, train);
    sectionalRelease(sim, train);
    if (runOff && train.headDist - train.len >= pathLength(sim, train)) { despawnTrain(sim, train); continue; }
    if (!held) train.state = v === 0 && remaining - adv <= 0.05 ? 'stopped' : 'running';
  }
  clearAspects(sim);
}

// ---- Traffic and the virtual operator (spec "Traffic", "The virtual operator")
export const DENSITY = { light: 12 * 60, normal: 7 * 60, busy: 4 * 60 }; // mean spawn interval per direction, sim s
export const DWELL = { P: 3 * 60, L: 15 * 60, industry: 25 * 60 };
const STALL = 30 * 60, STARVE = 10 * 60, NEAR = 20; // stood this long: logged / served first; "behind within" cells
const QUEUE_MAX = 8; // queued trains per portal

export function logEvent(sim, text) {
  sim.log.push({ t: sim.time, text });
  if (sim.log.length > 200) sim.log.shift();
}

// E12C, W41Ad: direction, column, row letter (A = row 0), a d suffix for dwarfs. Unique: one signal per node and dir.
export function signalLabel(sim, signalId) {
  const s = sim.layout.signals[signalId], n = sim.layout.nodes[s.node];
  return `${s.dir === 1 ? 'E' : 'W'}${n.x}${String.fromCharCode(65 + n.y)}${s.kind === 'dwarf' ? 'd' : ''}`;
}

export const fits = (sim, train, trackId) => train.len <= sim.layout.tracks[trackId].capacity;

// ponytail: yard tracks must be clear like any other; the spec's optional Restricting entry onto an occupied yard
// track is dropped.
export function trackFree(sim, trackId, forTrainId = null) {
  const mine = id => forTrainId !== null && id === forTrainId;
  if (sim.reserved.has(trackId) && !mine(sim.reserved.get(trackId))) return false;
  return sim.layout.tracks[trackId].edges.every(e => {
    const st = sim.edgeState[e];
    return [...st.occ].every(mine) && (st.route === null || mine(sim.routes.get(st.route).trainId));
  });
}

export const holdingTracks = (sim, dir) =>
  sim.layout.tracks.filter(t => t.dir === dir && (t.cls === 'siding' || t.cls === 'yard')).map(t => t.id);

export function trafficMenu(sim, dir) {
  const mine = sim.layout.tracks.filter(t => t.dir === dir);
  const menu = [{ type: 'X', dest: null, weight: 3 }, { type: 'Z', dest: null, weight: 2 }, { type: 'M', dest: null, weight: 3 },
    ...mine.filter(t => t.cls === 'platform').map(t => ({ type: 'P', dest: t.id, weight: 6 })),
    ...mine.filter(t => t.cls === 'spur').map(t => ({ type: t.industry.trainType, dest: t.id, weight: 2 })),
    ...mine.filter(t => t.cls === 'yard').map(t => ({ type: 'L', dest: t.id, weight: 2 }))];
  // A train too long for its track would wedge the queue for good. The generator's capacity floors mean this
  // drops nothing; the spawn gate checks fits again anyway.
  return menu.filter(m => m.dest === null || fits(sim, { len: trainLength(m.type) }, m.dest));
}

const dwellFor = (sim, type, dest) => (dest === null ? 0 : sim.layout.tracks[dest].cls === 'spur' ? DWELL.industry : DWELL[type]);

// The track whose signal the train's path ends at (its last edge is that track's first), or null.
const trackAhead = (sim, train) => (train.path.length ? sim.layout.edges[train.path.at(-1)].track : null);

// A queued train: drawn from the menu, named, scheduled and given its train id now. Its delay clock runs from
// here, so waiting at the portal counts.
function newEntry(sim, dir) {
  const menu = trafficMenu(sim, dir);
  let r = sim.rng() * menu.reduce((s, m) => s + m.weight, 0);
  const { type, dest } = menu.find(m => (r -= m.weight) < 0) ?? menu.at(-1);
  const name = `${type} ${sim.nextName[dir]}`;
  sim.nextName[dir] += 2;
  // Its home main, portal to far end.
  const mainLen = sim.layout.edges.reduce((s, e) => s + (e.main === dir ? e.len : 0), 0);
  const run = mainLen / (0.8 * TYPES[type].max * MPH);
  return { id: sim.nextTrainId++, name, type, dir, dest, len: trainLength(type), spawnTime: sim.time,
    sched: Math.round(sim.time + run + dwellFor(sim, type, dest) + 5 * 60) };
}

function canEnter(sim, q) {
  const st = sim.edgeState[forwardEdges(sim, entryPortalNode(sim, q.dir), q.dir)[0]];
  const r = st.route === null ? null : sim.routes.get(st.route);
  // Rule: the portal edge must be unoccupied and unrouted, except for an un-entered human route (trainId null),
  // which the entering train adopts; otherwise a route lined from the portal before any train came blocks it for good.
  if (st.occ.size || (r && (r.entered || r.trainId !== null))) return false;
  // A train still waiting at the portal for its first route occupies nothing: never stack another behind it.
  for (const t of sim.trains.values()) if (t.dir === q.dir && !t.path.length) return false;
  return q.dest === null || (fits(sim, q, q.dest) && trackFree(sim, q.dest));
}

function spawner(sim) {
  for (const dir of [1, -1]) {
    const queue = sim.queue[dir];
    while (sim.time >= sim.nextSpawn[dir]) {
      // ponytail: a full queue (QUEUE_MAX) drops the draw. The board lists queued trains as due soon, and past a
      // handful they only pile up delay. Thin the spawn rate instead if queues ever sit full.
      if (queue.length < QUEUE_MAX) queue.push(newEntry(sim, dir));
      sim.nextSpawn[dir] += -DENSITY[sim.density] * Math.log(1 - sim.rng()); // exponential gaps
    }
    // Rule: the first eligible entry enters, not strictly the head: one waiting for a full spur doesn't hold the
    // main for the through trains queued behind it.
    const i = queue.findIndex(q => canEnter(sim, q));
    if (i < 0) continue;
    const [q] = queue.splice(i, 1), t = spawnTrain(sim, q);
    t.spawnTime = q.spawnTime;
    t.sched = q.sched;
    if (q.dest !== null) sim.reserved.set(q.dest, t.id);
    t.events.push({ t: q.spawnTime, kind: 'queued' }, { t: sim.time, kind: 'entered' });
    logEvent(sim, `${t.name} entered from ${sim.layout.portals.find(p => p.dir === dir).name}`);
  }
}

// Rule: a hold ends when the awaited train is gone, has routes past the holder's signal (where the holder's path
// ends: it has the main, the holder follows it out), or has itself stopped to dwell or hold (not coming).
function holdOver(sim, t) {
  const h = sim.trains.get(t.holdFor), x = n => sim.layout.nodes[n].x;
  if (!h) return !sim.queue[t.dir].some(q => q.id === t.holdFor);
  return h.state === 'dwelling' || h.state === 'holding' || (x(headNode(sim, h)) - x(headNode(sim, t))) * t.dir > 0;
}

function missions(sim) {
  const { tracks } = sim.layout;
  for (const t of sim.trains.values()) {
    const at = trackAhead(sim, t);
    if (t.state === 'dwelling') {
      if (sim.time >= t.dwellUntil) {
        logEvent(sim, `${t.name} departed ${tracks[t.dest].name}`);
        t.events.push({ t: sim.time, kind: 'departed', track: tracks[t.dest].name });
        sim.reserved.delete(t.dest);
        Object.assign(t, { dest: null, goal: { exit: true }, state: 'running', lastMoveTime: sim.time });
      }
    } else if (t.state === 'stopped' && t.dest !== null && at === t.dest) {
      t.state = 'dwelling';
      t.dwellUntil = sim.time + dwellFor(sim, t.type, at);
      logEvent(sim, `${t.name} arrived at ${tracks[at].name}`);
      t.events.push({ t: sim.time, kind: 'arrived', track: tracks[at].name });
    }
    if (t.holdFor !== null) {
      // Rule: a hold also ends once the train's path no longer ends at a holding track: a human cancelled the hold
      // route or lined it elsewhere (or out of the siding), and the operator skips trains with holdFor set.
      if (holdOver(sim, t) || !holdingTracks(sim, t.dir).includes(at)) {
        t.holdFor = null;
        if (t.state === 'holding') Object.assign(t, { state: 'running', lastMoveTime: sim.time });
      } else if (t.state === 'stopped' && at !== null) t.state = 'holding';
    }
    // A stand is logged once, in AUTO only (in MANUAL the human holds trains at will); moving re-arms it.
    if (sim.auto && t.state !== 'dwelling' && t.state !== 'holding' && !t.stalled && sim.time - t.lastMoveTime >= STALL) {
      t.stalled = true;
      logEvent(sim, `STALL ${t.name}`);
    }
  }
}

// Rule: a higher-priority train of the same direction is "behind" if its head node (where its routes end) is up to
// NEAR cells behind this one's and it isn't dwelling or holding, or it is the next queued train to enter.
// ponytail: proximity on head nodes only, ceiling NEAR = 20 cells and no lookahead on where the faster train goes.
function trainBehind(sim, t) {
  const x = n => sim.layout.nodes[n].x, xt = x(headNode(sim, t));
  for (const h of sim.trains.values()) {
    if (h.dir !== t.dir || h.prio <= t.prio || h.state === 'dwelling' || h.state === 'holding') continue;
    const d = (xt - x(headNode(sim, h))) * t.dir;
    if (d > 0 && d <= NEAR) return h;
  }
  // Rule: a queued train counts only if its destination is free (or it has none): one waiting for a busy spur is
  // not coming, and holding for it parked trains for an hour in the soak.
  const q = sim.queue[t.dir].find(k => k.dest === null || trackFree(sim, k.dest));
  return q && TYPES[q.type].prio > t.prio ? q : null;
}

// Overtake: route t from sig into a free holding track it fits, to wait there for the train behind.
function hold(sim, t, sig, cands) {
  const other = trainBehind(sim, t);
  if (!other) return false;
  const free = new Set(holdingTracks(sim, t.dir).filter(k => fits(sim, t, k) && trackFree(sim, k)));
  const c = cands.find(k => free.has(sim.layout.edges[k.edges.at(-1)].track));
  if (!c || !setRoute(sim, sig, c.exitNode, { trainId: t.id }).ok) return false;
  t.holdFor = other.id;
  const track = sim.layout.tracks[sim.layout.edges[c.edges.at(-1)].track].name;
  logEvent(sim, `${t.name} holding at ${track} for ${other.name}`);
  t.events.push({ t: sim.time, kind: 'holding', track, for: other.name });
  return true;
}

// Rule: the operator clears a human route no train can take, GRACE after it was set. The spec says the operator never
// cancels human routes, but also that the panel "must never sit dead because you walked away mid-route", and one such
// route holds its module's exit for that direction for good. Dead: un-entered, not taken (trainId null), and either
// - out of a track (from its exit signal) that holds no train, that no route runs into, and that no train still moving
//   is bound for. Queued trains don't count: none can enter while the route holds the track. Nor does one that has
//   stood STARVE: it is stuck, most likely behind a train this very route blocks. Counting either wedged the line in
//   probes; or
// - into a track the train at its signal doesn't fit: adopt refuses it, and nothing can pass that train.
const GRACE = 3 * 60;
function deadRoute(sim, r) {
  const { edges, tracks, signals } = sim.layout;
  if (!r.human || r.entered || r.trainId !== null || sim.time - r.setAt < GRACE) return false;
  const from = edges[r.cand.edges[0]].track, into = edges[r.cand.edges.at(-1)].track, trains = [...sim.trains.values()];
  if (from === null) {
    const sig = signals[r.signal];
    return into !== null && trains.some(t => t.dir === sig.dir && headNode(sim, t) === sig.node && !fits(sim, t, into));
  }
  return tracks[from].edges.every(e => sim.edgeState[e].occ.size === 0)
    && [...sim.routes.values()].every(o => edges[o.cand.edges.at(-1)].track !== from)
    && !trains.some(t => t.dest === from && sim.time - t.lastMoveTime < STARVE);
}

// A train whose path ends at a signal with no route from it gets the route to the next signal along its pathfound
// way, when the interlocking allows; otherwise it waits and tries again next tick. The operator cancels nothing but
// dead human routes (deadRoute), so a human route any train can still take stands.
// Rule: trains ahead don't hide the way: a blocked edge (standing or moving) costs BLOCKED_COST, and setRoute decides if
// the route sets now.
// ponytail: 1000 outweighs any detour on generated layouts (under 100 columns); raise it if layouts reach ~1000 cells.
const BLOCKED_COST = 1000;
function operator(sim) {
  const { edges, tracks } = sim.layout;
  for (const r of [...sim.routes.values()]) {
    if (!deadRoute(sim, r)) continue;
    cancelRoute(sim, r.id);
    const c = r.cand, to = c.exitSignal !== null ? signalLabel(sim, c.exitSignal)
      : sim.layout.portals.find(p => p.dir === -sim.layout.signals[r.signal].dir).name; // where the other direction enters
    logEvent(sim, `AUTO: cleared route ${signalLabel(sim, r.signal)} → ${to} (no train can take it)`);
  }
  // Rule: highest priority first, but a train that has stood STARVE (10 min) goes before any that hasn't; under
  // busy traffic a higher-priority main train waits every time the main frees, and a local at a merge starved.
  // ponytail: a fixed threshold, not aging; worst stand 16.8 min over 60 busy seeds. Age it if denser traffic starves.
  const rank = t => t.prio + (sim.time - t.lastMoveTime >= STARVE ? 10 : 0);
  for (const t of [...sim.trains.values()].sort((a, b) => rank(b) - rank(a) || a.id - b.id)) {
    if (t.state === 'dwelling' || t.state === 'holding' || t.holdFor !== null) continue; // holding or on its way in
    const node = headNode(sim, t), sig = sim.signalAt.get(`${node}:${t.dir}`);
    if (sig === undefined || routeFrom(sim, sig)) continue;
    if (t.dest !== null && trackAhead(sim, t) === t.dest) continue; // arriving: it dwells before going on
    const path = findPath(sim, node, t.dir, t.goal, { trainId: t.id, blockedCost: BLOCKED_COST, standingCost: BLOCKED_COST });
    if (!path) {
      // Rule: no way at all means a human route took it past its destination: give up the call, run for the exit.
      if (t.dest !== null) {
        logEvent(sim, `${t.name} missed ${tracks[t.dest].name}`);
        sim.reserved.delete(t.dest);
        Object.assign(t, { dest: null, goal: { exit: true } });
      }
      continue;
    }
    const cands = sim.routesFrom.get(sig);
    if (t.dest === null && t.prio <= 2 && hold(sim, t, sig, cands)) continue;
    const cand = cands.find(c => c.edges.every((e, i) => path[i] === e));
    const into = cand ? edges[cand.edges.at(-1)].track : null;
    // Rule: never into a track that isn't its destination (holds go through hold()); a way round through one = wait.
    // ponytail: sound while mains are one-way with no crossovers (every way round is a track); not for bidirectional CTC.
    if (!cand || (into !== null && into !== t.dest)) continue;
    if (setRoute(sim, sig, cand.exitNode, { trainId: t.id }).ok) logEvent(sim, `AUTO: ${signalLabel(sim, sig)} → ${t.name}`);
  }
}

// One sim second.
export function step(sim) {
  clearAspects(sim);
  if (sim.auto) operator(sim);
  spawner(sim);
  moveTrains(sim);
  missions(sim);
  sim.time += 1;
}
