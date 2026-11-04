// Pure simulation: interlocking (routes, switches, locking), pathfinding, signal aspects, trains, traffic and the
// virtual operator; step(sim) advances it one sim second. Never touches window, document, Math.random or Date;
// randomness comes only from sim.rng (makeRng(seed + ':sim')) for traffic, sim.branchRng (makeRng(seed + ':branch')) for
// the junction's coins and sim.extras (makeRng(seed + ':extras')) for slow orders and the operator, so neither of the
// last two changes a seed's traffic.
//
// Travel follows the path, never an edge's a->b order (spec "The direction model"): a train's path is a chain of edges
// from train.pathStart, so the order it runs each edge in comes from chaining. train.dir (+1 bound east, -1 west) only
// keeps it from moving against its dir in x (forwardEdges; vertical edges are neutral). A signal faces the edge a train
// arrives on (signal.from, null at a portal): sim.signalAt is keyed `${node}:${from}`. A terminus train turns round
// (reverse): its path becomes the edges it stands on, reversed, and its dir flips (spec "Phase 2").
import { makeRng, pick, randInt } from './rng.js';

const SLOW_CLS = new Set(['yard', 'siding', 'spur', 'stub', 'lead']);
const far = (edge, n) => (edge.a === n ? edge.b : edge.a);

export function createSim(layout, seed, opts = { density: 'normal' }) {
  const adj = new Map(layout.nodes.map(n => [n.id, []]));
  for (const e of layout.edges) { adj.get(e.a).push(e.id); adj.get(e.b).push(e.id); }
  const start = 6 * 3600; // 06:00
  // A west or east portal is left by both rows of its end, the leaving dir's home main first: both run on off the panel
  // as a two-track main. A junction's branch portal (dir 0) is left by its own node, for either dir.
  const { nodes, mainRow, portals } = layout;
  const ends = (p, dir) => (p.dir === 0 ? [p.node]
    : [mainRow[dir], mainRow[-dir]].map(y => nodes.find(n => n.x === nodes[p.node].x && n.y === y).id));
  const sim = {
    layout, adj,
    edgeState: layout.edges.map(() => ({ occ: new Set(), route: null })),
    switchState: new Map(layout.switches.map(s => [s.node, { lie: 'normal' }])),
    signalAt: new Map(layout.signals.map(s => [`${s.node}:${s.from}`, s.id])), // the signal at node facing edge from
    switchAt: new Map(layout.switches.map(s => [s.node, s])), // node -> {node, trunk, normal, reverse}
    routesFrom: new Map(), sectionEdges: new Map(), // section -> its edge ids (the mains', and a junction's branch section)
    exits: portals.map(p => ({ 1: ends(p, 1), '-1': ends(p, -1) })), // portal id -> dir -> exitNodesOf
    routes: new Map(), nextRouteId: 1,
    trains: new Map(), nextTrainId: 1, reserved: new Map(),
    queue: portals.map(() => []), nextSpawn: portals.map(() => start), completed: [], // by portal id
    time: start, log: [], auto: false, density: opts.density ?? 'normal',
    rng: makeRng(seed + ':sim'), branchRng: makeRng(seed + ':branch'), _aspects: new Map(),
    cuts: new Map(), cutRng: makeRng(seed + ':cuts'),
    dayLength: opts.dayLength ?? 2400, slowOrders: opts.slowOrders ?? true, extras: makeRng(seed + ':extras'), slowOrder: null,
  };
  sim.nextSlowOrder = start - SLOW_ORDER.gap * Math.log(1 - sim.extras());
  sim.operator = drawOperator(sim.extras, null);
  sim.nextShift = start + 8 * 3600;
  logEvent(sim, `${sim.operator} on duty`);
  for (const e of layout.edges) if (e.section != null) {
    if (!sim.sectionEdges.has(e.section)) sim.sectionEdges.set(e.section, []);
    sim.sectionEdges.get(e.section).push(e.id);
  }
  // a fan's lead, ladder and stubs (its section): one unit for trackFree, as the spec's "Reservation" has it
  sim.fanEdges = layout.fan ? sim.sectionEdges.get(layout.edges[layout.tracks[layout.fan.stubs[0]].edges[0]].section) : [];
  // a terminus's feet main inside its gap (junction edges): nothing follows a terminus train onto them before it reverses
  const w = layout.wye;
  sim.feet = w?.kind === 'terminus' ? layout.edges.filter(e => e.main === w.feetMain && e.junction).map(e => e.id) : [];
  const branchSec = w?.kind === 'terminus' ? layout.edges.find(e => e.cls === 'wye').section : undefined;
  sim.gapEdges = new Set(w?.kind === 'terminus' ? layout.edges.filter(e => e.junction || e.section === branchSec).map(e => e.id) : []);
  for (const sig of layout.signals) sim.routesFrom.set(sig.id, candidates(sim, sig));
  sim.reach = reachability(sim);
  // Train numbers count up per direction from a seeded start in 100..400: even eastbound, odd westbound.
  sim.nextName = { 1: 2 * randInt(sim.rng, 50, 200), '-1': 2 * randInt(sim.rng, 50, 199) + 1 };
  initialCuts(sim);
  return sim;
}

// Standing cuts (spec "Traffic"): every stub of a fan but one (cutRng picks) holds one, each spur stub by a fair coin;
// a cut is its stub's industry type, CUT_MIN..CUT_MAX cars. Drawn only when a stub exists, so other seeds are untouched.
export const CUT_MIN = 3, CUT_MAX = 8;
export const cutLen = cut => cut.cars * CAR;
function initialCuts(sim) {
  const { fan, spurStubs, tracks } = sim.layout, put = id =>
    sim.cuts.set(id, { track: id, type: tracks[id].industry.trainType, cars: randInt(sim.cutRng, CUT_MIN, CUT_MAX) });
  if (fan) { const empty = pick(sim.cutRng, fan.stubs); fan.stubs.filter(id => id !== empty).forEach(put); }
  for (const { stub } of spurStubs ?? []) if (sim.cutRng() < 0.5) put(stub);
}

// The west or east portal a dir train enters by (the far end's is portalFor(-dir), where it leaves).
const portalFor = (sim, dir) => sim.layout.portals.find(p => p.dir === dir).id;
const branchOf = sim => sim.layout.portals.find(p => p.dir === 0); // a junction's branch portal, or undefined
export const entryNode = (sim, train) => sim.layout.portals[train.entry].node;
export const exitNodesOf = (sim, portalId, dir) => sim.exits[portalId][dir]; // dir's home main first (createSim)
export const exitNodes = (sim, train) => exitNodesOf(sim, train.exit, train.dir);
// The portal a route or train runs out by at node (one of its exit nodes for either dir), or undefined.
export const portalAtNode = (sim, node) => sim.layout.portals.find(p => [1, -1].some(d => exitNodesOf(sim, p.id, d).includes(node)));

// The edges a dir train may leave node by, having arrived on edge from (null at a portal): never back along from; only
// the way the edge runs (oneWay: null both ways, else the node it is entered from); never against its dir in x (an edge
// with dx 0 is neutral); and at a switch only trunk <-> leg.
export function forwardEdges(sim, node, dir, from = null) {
  const { nodes, edges } = sim.layout, x = nodes[node].x, sw = from === null ? undefined : sim.switchAt.get(node);
  return sim.adj.get(node).filter(e => e !== from && (edges[e].oneWay === null || edges[e].oneWay === node)
    && (nodes[far(edges[e], node)].x - x) * dir >= 0 && !(sw && (e === sw.trunk) === (from === sw.trunk)));
}

export const signalAhead = (sim, node, from) => sim.signalAt.get(`${node}:${from}`);
// The signal a train's path ends at: at its head node facing its last edge; the portal signal before its first route.
export const signalAheadOf = (sim, train) => signalAhead(sim, headNode(sim, train), train.path.at(-1) ?? null);

// DFS from the signal in its direction (a dir 0 signal in each of +1 and -1), leaving its node away from the edge it
// faces; each branch ends at the first node with a signal facing the edge it arrived by, or with nowhere further to go
// (an exit node). A terminus's shunt signals end no route (spec "Shunt signals"): a walk runs through the feet as if
// they had none, so a route from P crosses the whole junction to the far P. The stub's buffer (a dead end that is no
// exit) ends only a shunt signal's own route (backing in): no train runs head first into the stub. A route both dirs
// walk (down the stem) is one candidate with dir 0. setRoute names a route by its exit node, so each candidate has its
// own: over and back inside one crossover pair (two crossover edges) is dropped (it ends where the straight route
// does), and of two ways to one exit (through a junction gap, crossing at either pair) the one with fewer wrong-main
// edges is kept, then the shorter.
function candidates(sim, sig) {
  const { edges, signals, tracks } = sim.layout, found = new Map(); // edge list -> candidate
  for (const dir of sig.dir === 0 ? [1, -1] : [sig.dir]) {
    const walk = (n, from, path, nodes) => {
      for (const e of forwardEdges(sim, n, dir, from)) {
        const next = far(edges[e], n), p = [...path, e], ns = [...nodes, next], g = signalAhead(sim, next, e);
        const signalled = g !== undefined && signals[g].kind !== 'shunt';
        if (signalled || !forwardEdges(sim, next, dir, e).length) {
          if (!signalled && sig.kind !== 'shunt' && tracks[edges[e].track]?.stub) continue; // up a leg to the buffer
          const key = p.join();
          if (found.has(key)) found.get(key).dir = 0; else found.set(key, candidate(sim, sig, p, ns, dir));
        } else walk(next, e, p, ns);
      }
    };
    walk(sig.node, sig.from, [], [sig.node]);
  }
  const out = new Map(), wrong = c => c.edges.filter(e => edges[e].main === -c.dir).length; // exit node -> candidate
  for (const c of found.values()) {
    if (c.edges.filter(e => edges[e].cls === 'crossover').length >= 2) continue;
    const o = out.get(c.exitNode);
    if (!o || wrong(c) < wrong(o) || (wrong(c) === wrong(o) && c.len < o.len)) out.set(c.exitNode, c);
  }
  return [...out.values()];
}

// dir: the dir whose rule admitted it (its signal's; 0 when both did); nodes: sig.node, then the far end of each edge;
// from: the edge its signal faces.
function candidate(sim, sig, es, nodes, dir) {
  const { edges, tracks, wye } = sim.layout, exitNode = nodes.at(-1), lastMain = edges[es.findLast(e => edges[e].main != null)];
  const into = edges[es.at(-1)].track;
  // A switch the route touches needs reverse if the route uses its reverse leg (facing or trailing),
  // normal if it uses the normal leg; touching only the trunk (at a route end) asks nothing of it.
  const switches = [];
  for (const n of nodes) {
    const s = sim.switchAt.get(n);
    if (s && es.includes(s.reverse)) switches.push({ node: n, lie: 'reverse' });
    else if (s && es.includes(s.normal)) switches.push({ node: n, lie: 'normal' });
  }
  return {
    dir, edges: es, nodes, from: sig.from, switches, exitNode,
    exitSignal: signalAhead(sim, exitNode, es.at(-1)) ?? null,
    diverging: switches.some(s => s.lie === 'reverse'),
    // it ends on the other direction's home main (a junction gap's piece of it doesn't count: the route runs on, out of
    // the gap or into the branch). Rule: a terminus gap's does (but for a terminus train: wrongMainOut). Its P columns are
    // stands inside the gap, and on s200 a through train exempt there stood at P for good (see isWrongMain).
    wrongMain: lastMain?.main === -dir && !(lastMain.junction && wye?.kind === 'junction'),
    wrongMainOut: lastMain?.main === -dir && !lastMain.junction, // past the gap (a terminus train's own count)
    // it runs wrong main inside a junction gap without running out by the branch: it puts its train wrong main there,
    // the one wrong-main move (setRoute; isWrongMain counts it). Rule: only a move out by the branch is exempt. A branch
    // arrival crossing to its home main is routed to b or b', where it can stand waiting for the main with its tail
    // still on the other main's junction edges (the pair is 1-4 cells behind the signal), against that main's through
    // traffic: on s687 and s364 that tail closed a cycle with the train already wrong main elsewhere, for good.
    gapWrong: wye?.kind === 'junction' && exitNode !== sim.layout.portals[wye.portal].node
      && es.some(e => edges[e].junction && edges[e].main === -dir),
    slow: SLOW_CLS.has(edges[es.at(-1)].cls) || (into !== null && !!tracks[into].stub), // into the stub: backing in
    len: es.reduce((sum, e) => sum + edges[e].len, 0),
    // it runs from outside a terminus's gap (b or b') onto the feet main inside it (setRoute's 'terminus' rule)
    intoGap: wye?.kind === 'terminus' && edges[es[0]].main != null && !edges[es[0]].junction
      && es.some(e => edges[e].main === wye.feetMain && edges[e].junction),
  };
}

// ponytail: a switch is held only by its trunk edge (occupied or routed); no flank protection (spec).
// Every route through a switch uses its trunk, and a train standing on a leg is clear of the points:
// trains stop FOUL short of signals and track capacity is edge length - 0.5, so a tail sits >= 0.2
// cells off the ladder node (adopt never takes a train into a track it doesn't fit). If train stopping ever
// changes, model fouling points instead.
// forTrain: the train a route starting at node is set for. Its own body on the trunk does not hold the points (a
// reversed terminus train at the foot's shunt signal: its head stands FOUL short of the foot, clear of them).
// A set route also owns the switches it lists until a train enters it. For every route but one from a shunt signal that
// is the trunk lock already (a route through a switch uses its trunk, and none of a route is released before it is
// entered), so nothing else changes; a shunt route leaves its foot by a leg and never locks the trunk, and without this
// a through route from P threw the points back under a back-in route set by hand. Once entered, the train on the run
// (the trunk) holds them until it is clear. (Owning them for the route's whole life would hold a switch after sectional
// release has freed its trunk behind the train, which changes every seed's traffic.)
export function switchLocked(sim, node, forTrain = null) {
  const sw = sim.switchAt.get(node), st = sw && sim.edgeState[sw.trunk];
  return !!st && ([...st.occ].some(id => id !== forTrain?.id) || st.route !== null
    || [...sim.routes.values()].some(r => !r.entered && r.cand.switches.some(s => s.node === node)));
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
// moves), runs on a main edge of the other direction's home. Edges of a junction gap (tagged junction) don't count for
// a train running out by the branch: its path, or a route set for it, ends at the branch portal (spec "Junction
// exemption"). Its route runs from outside the gap to the portal, so it never stands in the gap. Rule: any other
// running there counts (candidate's gapWrong): a train routed across the gap to b or b' can stand at the signal with
// its tail on the other main's junction edges. Keyed on the route, not train.exit, so a human route up the stem is
// exempt whatever the train's exit, and one past the wye counts for a train bound for the branch. In a terminus's gap
// only a terminus train is exempt, whose visit there counts as the one wrong-main move instead (setRoute's onVisit
// rule). Rule: other trains have no exemption in a terminus's gap. Its P columns are stands inside the gap, so a route
// there need not run through and out as at a junction; on s200 a through train exempt in the gap stood at P, wrong
// main, holding the main a wrong-main train elsewhere had to get home on, for good.
export const isWrongMain = (sim, train) => {
  const { wye, edges, portals } = sim.layout;
  const pending = [...sim.routes.values()].filter(r => r.trainId === train.id && !train.routes.includes(r.id)).map(r => r.cand);
  const out = wye?.kind === 'junction' && [train.path.length ? headNode(sim, train) : null, ...pending.map(c => c.exitNode)]
    .includes(portals[wye.portal].node);
  const exempt = out || train.terminus;
  return [train.path, ...pending.map(c => c.edges)]
    .some(es => es.some(e => edges[e].main === -train.dir && !(exempt && edges[e].junction)));
};
export const wrongMainTrains = sim => [...sim.trains.values()].filter(t => isWrongMain(sim, t));

// Traffic locking (spec "Branch section"): a move's sense in a section, from the node order it runs its first edge
// there in (edge e from node u): on a main section its x direction (its dir), on a junction's branch section +1 inbound
// (toward the main the feet are on) or -1 outbound (no branch edge is level, so one always holds). A route's senses are
// kept as route.sense (section -> sense); a train's come from its path. Opposing: a section the route touches holds a
// train, or a route, of the opposite sense there.
function senseIn(sim, e, u) {
  const { edges, nodes, mainRow, wye } = sim.layout, ed = edges[e], a = nodes[u], b = nodes[far(ed, u)];
  if (ed.main != null) return Math.sign(b.x - a.x);
  // the fan: +1 outbound (a spur stub's edges are of these classes too, on layouts with no fan, but have no section)
  if (ed.cls === 'lead' || ed.cls === 'stub') return Math.sign(b.x - a.x) * -sim.layout.fan?.main;
  const y = mainRow[wye.feetMain];
  return Math.abs(b.y - y) < Math.abs(a.y - y) ? 1 : -1;
}
function senseOf(sim, cand) {
  const sense = new Map();
  cand.edges.forEach((e, i) => {
    const s = sim.layout.edges[e].section;
    if (s != null && !sense.has(s)) sense.set(s, senseIn(sim, e, cand.nodes[i]));
  });
  return sense;
}
// A train's sense in section s, chained along its path from pathStart; on a main section with none of its path there
// (a test's hand-placed occupant), its dir; elsewhere null, which opposes either sense.
function trainSense(sim, train, s) {
  let n = train.pathStart;
  for (const e of train.path) {
    if (sim.layout.edges[e].section === s) return senseIn(sim, e, n);
    n = far(sim.layout.edges[e], n);
  }
  return sim.layout.edges[sim.sectionEdges.get(s)[0]].main != null ? train.dir : null;
}
function opposing(sim, sense) {
  return [...sense].some(([s, v]) => sim.sectionEdges.get(s).some(e => {
    const st = sim.edgeState[e];
    return [...st.occ].some(id => { const t = sim.trains.get(id); return t && [-v, null].includes(trainSense(sim, t, s)); })
      || (st.route !== null && sim.routes.get(st.route).sense.get(s) === -v);
  }));
}

// A route is wrong main for train t: past the gap for a terminus train (its running in the gap is exempt), else as the
// candidate says.
const wrongMainFor = (t, cand) => (t?.terminus ? cand.wrongMainOut : cand.wrongMain);

// Holds: train t occupies one of the edges es, or a route set for it locks one.
const holdsAny = (sim, t, es) => [...es].some(e => sim.edgeState[e].occ.has(t.id)
  || (sim.edgeState[e].route !== null && sim.routes.get(sim.edgeState[e].route).trainId === t.id));
// A terminus train on its visit to the gap: from its first route in until it is out again, it holds (or is routed over)
// an edge inside the gap: a junction main edge, a leg or the stub (sim.gapEdges).
const onVisit = (sim, t) => t.terminus && holdsAny(sim, t, sim.gapEdges);
// One more wrong-main move would make two (setRoute's 'wrong main'; spec "Builder check" 4): another train is wrong main (but
// the one it is for, and the one at signalId, which may go on or home), an untaken human wrong-main route (or one wrong main
// inside a junction gap: gapWrong) waits for its train, or (visits) a terminus train is on its visit (setRoute's onVisit
// rule). A fan visitor's reverse 1 waits on the first two only (ruling 2026-11-04): its shove runs on its own run and lead,
// in a gap that shares no section with a terminus's, and while it shoves it is wrong main itself, so the terminus train's
// own wrong-main routes wait out that minute. Waiting out every terminus visit, it gave most visits up on terminus seeds.
const untaken = r => r.trainId === null && !r.entered && (r.cand.wrongMain || r.cand.gapWrong); // (one at this signal: 'already set')
const wrongMainBusy = (sim, forTrain, { signalId = null, trainId = forTrain?.id ?? null, visits = true } = {}) =>
  wrongMainTrains(sim).some(t => t.id !== trainId && signalAheadOf(sim, t) !== signalId) || [...sim.routes.values()].some(untaken)
  || (visits && [...sim.trains.values()].some(t => t !== forTrain && t.id !== trainId && onVisit(sim, t)));

export function setRoute(sim, signalId, exitNode, { human = false, trainId = null } = {}) {
  // exitNode names the candidate: candidates() keeps one per exit node.
  const cand = (sim.routesFrom.get(signalId) ?? []).find(c => c.exitNode === exitNode);
  const fail = reason => ({ ok: false, reason });
  if (!cand) return fail('no such route');
  if (routeFrom(sim, signalId)) return fail('already set');
  if (cand.edges.some(e => sim.edgeState[e].occ.size > 0)) return fail('occupied');
  if (cand.edges.some(e => sim.edgeState[e].route !== null)) return fail('locked');
  // the train it is for: the operator's (trainId), or for a human NX the train standing at the signal
  const forTrain = trainId !== null ? sim.trains.get(trainId) ?? null
    : [...sim.trains.values()].find(t => signalAheadOf(sim, t) === signalId) ?? null;
  if (cand.switches.some(s => sim.switchState.get(s.node).lie !== s.lie
    && switchLocked(sim, s.node, s.node === cand.nodes[0] ? forTrain : null))) return fail('switch busy');
  const sense = senseOf(sim, cand);
  if (opposing(sim, sense)) return fail('opposing');
  // Rule: nothing follows a terminus train into the gap on the feet main until it has reversed (spec "Reverse 1": it
  // turns round at P with no other train on the feet main's junction edges, which missions waits for). Without this a
  // train following it in stands at the near P while it reverses in the same section, the other way.
  if (cand.intoGap && [...sim.trains.values()].some(t => t !== forTrain && t.terminus && !t.reversed1 && holdsAny(sim, t, sim.feet)))
    return fail('terminus');
  // One wrong-main train at a time; the one at this signal (or the one the route is for) may go on or home. An untaken
  // human wrong-main route at another signal (or one wrong main inside a junction gap: gapWrong) counts as one: some
  // train will take it (wrongMainBusy).
  // Rule: a terminus train on its visit to the gap (onVisit) is the one wrong-main move: it runs against one main's home
  // direction there, approaching or leaving, and holds a main against the other trains while it is in (entry rule,
  // traffic locking, its tail across a pair on the way out). Its own running in the gap is exempt (its routes count as
  // wrong main only past the gap: wrongMainOut), but no other train is sent wrong main meanwhile, and it leaves the stub
  // against the feet main only while none is. On s83 a train sent wrong main behind a departure met one of the other
  // direction head on, both waiting on the main the departure held, for good. It may begin its visit with one out
  // (waiting at b it would hold its own home main, where on s200 the one out had to get home).
  const terminus = !!forTrain?.terminus, leavesAgainst = terminus && signalId === sim.layout.wye.stubSignal
    && cand.edges.some(e => sim.layout.edges[e].main === -cand.dir);
  if ((wrongMainFor(forTrain, cand) || leavesAgainst || cand.gapWrong) && wrongMainBusy(sim, forTrain, { signalId, trainId }))
    return fail('wrong main');
  for (const s of cand.switches) sim.switchState.get(s.node).lie = s.lie;
  const route = { id: sim.nextRouteId++, signal: signalId, cand, dir: cand.dir, sense, trainId, human, entered: false,
    setAt: sim.time };
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
// train's whole run: path[0] starts at train.pathOff (at node train.pathStart), the head is at headDist, the tail at
// headDist - len.
export function sectionalRelease(sim, train) {
  const { edges } = sim.layout;
  while (train.path.length && train.pathOff + edges[train.path[0]].len <= train.headDist - train.len) {
    const e = train.path.shift();
    sim.edgeState[e].occ.delete(train.id);
    releaseEdge(sim, e);
    train.pathOff += edges[e].len;
    train.pathStart = far(edges[e], train.pathStart);
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

// Dijkstra over forward edges from fromNode, arrived at by edge from (null at a portal); each node expands by the edge
// its best way in arrived on. goal {node}: reach it. goal {exit: portalId}: reach one of that portal's exit nodes for
// dir. goal {track}: stop on the first edge of that track (a virtual sink, so the returned list ends with that edge).
// penalty: {trainId?, blockedCost?, standingCost?, wrongMainCost?, [edgeId]: extraCost}. Blocked edges cost
// blockedCost or standingCost extra (blockCost), so the operator still sees its way past trains ahead and leaves "can
// the next route be set now" to setRoute; a class without its cost is skipped. A main edge of the other direction's
// home costs wrongMainCost (default 0) extra; a ladder or crossover 1.
// ponytail: linear-scan priority queue, fine for generated layouts (< 200 nodes); a binary heap if they grow.
export function findPath(sim, fromNode, dir, goal, penalty = {}, from = null) {
  const { edges } = sim.layout, SINK = -1, exits = goal.exit != null ? exitNodesOf(sim, goal.exit, dir) : [];
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
    for (const e of forwardEdges(sim, u, dir, prev.get(u)?.edge ?? from)) {
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
  if (kind === 'dwarf' || kind === 'shunt') return { top: DWARF[aspect] ?? 'R' }; // a terminus's shunt signals light as dwarfs
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

export const trainLength = (type, cars = TYPES[type].cars) => LOCO + cars * CAR;
export const isLight = train => train.cars === 0;

// Head at the entry portal node with nothing occupied; its first adopted route gives it its first edges.
// Positions are cumulative along the train's run from that portal: path[0] starts at pathOff, at node pathStart.
// id: the spawner hands in the id it gave the queue entry, so a train holding for a queued one finds it later.
// entry, exit: portal ids, by default the portal of its dir and the far end.
// A train for a terminus's stub is a terminus train (spec "The terminus mission"): bound first for the pull-ahead node
// past the wye for its dir (arrival, kept: dir flips when it reverses), its exit the far end until it turns round at P,
// then the portal it came in by (where its reversed dir now runs, so the board and captions read true). run: cells
// run before its last reversal (pathOff restarts there); locoAtTail and pushing while it backs in; reversed1 once it has
// turned round at P.
// A fan visitor (shunt: the queue entry's flag) carries train.shunt (spec "The visit"): its stage, its stand (P, where it
// turns round to back in), its lead (Lt, where it turns round between stubs and leaves from) and its fan; bound first for
// its stand. A spur stub's visitor (its dest a spur with a stub) has the spur's exit signal for both, and its stub.
export function spawnTrain(sim, { type, dir, dest = null, cars = TYPES[type].cars, name, id = sim.nextTrainId++, entry = portalFor(sim, dir),
  exit = portalFor(sim, -dir), shunt = false }) {
  const T = TYPES[type], terminus = dest !== null && dest === sim.layout.wye?.stub, { fan, tracks, signals } = sim.layout;
  const sig = shunt && tracks[dest].stubOf != null && signals.find(g => g.from === tracks[dest].edges[1] && g.kind !== 'shunt');
  const visit = !shunt ? null : sig ? { kind: 'spur', stage: 'approach', stand: sig.node, lead: sig.node, leadSignal: sig.id, stub: tracks[dest].stubOf }
    : { kind: 'fan', stage: 'approach', stand: fan.P, lead: fan.Lt, leadSignal: fan.leadSignal, fan };
  const train = {
    id, name: name ?? `${type} ${id}`, type, dir, cars, entry, exit, prio: T.prio, len: trainLength(type, cars), maxSpeed: T.max * MPH,
    path: [], pathStart: sim.layout.portals[entry].node, routes: [], pathOff: 0, headDist: 0, speed: 0, state: 'entering', dest,
    goal: terminus ? { node: sim.layout.wye.P[dir] } : visit ? { node: visit.stand } : dest !== null ? { track: dest } : { exit },
    dwellUntil: 0, holdFor: null, spawnTime: sim.time, sched: sim.time, lastMoveTime: sim.time, stops: 0, stalled: false, events: [],
    run: 0, locoAtTail: false, pushing: false, terminus, arrival: dir, reversed1: false, shunt: visit,
  };
  sim.trains.set(id, train);
  return train;
}

// Where the train's path ends, chained from pathStart: the entry portal before its first route.
export function headNode(sim, train) {
  let n = train.pathStart;
  for (const e of train.path) n = far(sim.layout.edges[e], n);
  return n;
}

export const pathLength = (sim, train) => train.path.reduce((s, e) => s + sim.layout.edges[e].len, train.pathOff);

// Grid coords at dist along the path; null before its start (released edges, or behind the portal) or past its end.
export function pointAt(sim, train, dist) {
  const { nodes, edges } = sim.layout;
  if (dist < train.pathOff) return null;
  let s = train.pathOff, n = train.pathStart; // each edge runs from n to its far end
  for (const id of train.path) {
    const len = edges[id].len, next = far(edges[id], n);
    if (dist <= s + len) {
      const a = nodes[n], b = nodes[next], f = (dist - s) / len;
      return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
    }
    s += len;
    n = next;
  }
  if (dist !== s) return null;
  return { x: nodes[n].x, y: nodes[n].y };
}

// Loco then cars, head first, each clipped to the path (dropped if wholly off it); pushing (locoAtTail) the cars lead
// and the loco is the last block. The head block is the path's leading end either way.
// ponytail: a block spanning a bend draws as a straight chord; blocks are under a cell long.
// lag (cells) draws the train that far behind its head: the renderer passes the unelapsed part of the last step's
// advance so motion is smooth between 1 s sim steps.
export function trainBlocks(sim, train, lag = 0) {
  const out = [], start = train.pathOff, end = pathLength(sim, train), head = train.headDist - lag, n = train.cars;
  const cars = Array.from({ length: n }, (_, j) => [head - ((train.locoAtTail ? 0 : LOCO) + j * CAR), CAR, 'car']); // [front, size, kind]
  const loco = [train.locoAtTail ? head - n * CAR : head, LOCO, 'loco'];
  for (const [front, size, kind] of train.locoAtTail ? [...cars, loco] : [loco, ...cars]) {
    const hi = Math.min(front, end), lo = Math.max(front - size, start);
    if (hi <= lo) continue;
    const p = pointAt(sim, train, hi), q = pointAt(sim, train, lo);
    out.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, kind });
  }
  return out;
}

// A standing cut's blocks, as trainBlocks gives a train's: its cars along the stub's buffer edge from FOUL short of the
// buffer back, the nearest first, each led by its buffer end. That is where the cars of the train that set it out stood
// (shoved in to the stop point, loco trailing), and stopDist puts a loco sent in to it touching the last, so a set-out or
// a pick-up moves no pixel. The generator lists a stub's buffer edge last, the buffer its b.
export function cutBlocks(sim, cut) {
  const { nodes, edges, tracks } = sim.layout, e = edges[tracks[cut.track].edges.at(-1)], b = nodes[e.b], s = nodes[e.a];
  const at = d => ({ x: b.x + (s.x - b.x) * d / e.len, y: b.y + (s.y - b.y) * d / e.len }); // d cells from the buffer
  return Array.from({ length: cut.cars }, (_, j) => {
    const p = at(FOUL + j * CAR), q = at(FOUL + (j + 1) * CAR);
    return { x1: p.x, y1: p.y, x2: q.x, y2: q.y, kind: 'car' };
  });
}

// Turns a standing train round where it stands (spec "Reversal"). Its new path is the edges it occupies (the occupancy
// rule's), reversed, from the far end of its head's edge; r, the unused part of that edge beyond the old head, is where
// the new tail stands, exactly where the head was: nothing jumps, and occupancy is the same set. The run so far is banked
// in train.run (pathOff restarts at 0). Every route set for it goes (un-entered ones cancelled, entered ones' locks on
// the edges it stands on dropped, or their old sense would oppose its new one), and so does any edge of its path ahead
// of its head. The loco swaps ends: it pushes while the loco trails.
export function reverse(sim, train, newDir) {
  if (train.speed !== 0) throw new Error(`${train.name} cannot reverse at speed`);
  const { edges } = sim.layout, tail = train.headDist - train.len, occ = [];
  let s = train.pathOff, n = train.pathStart, end = n, r = 0;
  for (const e of train.path) {
    if (s > train.headDist) break;
    n = far(edges[e], n);
    if (s + edges[e].len > tail) { occ.push(e); end = n; r = s + edges[e].len - train.headDist; }
    s += edges[e].len;
  }
  for (const route of [...sim.routes.values()]) if (route.trainId === train.id) {
    for (const e of route.cand.edges) if (sim.edgeState[e].route === route.id) sim.edgeState[e].route = null;
    sim.routes.delete(route.id);
  }
  clearAspects(sim);
  train.run += train.pathOff;
  Object.assign(train, { dir: newDir, path: occ.reverse(), pathStart: end, pathOff: 0, headDist: r + train.len, routes: [],
    locoAtTail: !train.locoAtTail });
  train.pushing = train.locoAtTail;
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
    const sig = signalAheadOf(sim, train);
    const route = sig === undefined ? null : routeFrom(sim, sig);
    // a dir 0 signal (the branch's) offers routes of both dirs: only one of the train's own dir, or one both run (dir 0)
    if (!route || (route.trainId !== null && route.trainId !== train.id) || (route.dir !== 0 && route.dir !== train.dir)) return;
    // ponytail: never into a track the train doesn't fit (a human route can ask it; the operator checks fits). This is
    // what keeps switchLocked's trunk-only rule true: only a train that fits stands clear of the points at both ends.
    const into = sim.layout.edges[route.cand.edges.at(-1)].track;
    if (into !== null && !fits(sim, train, into)) return;
    train.path.push(...route.cand.edges);
    train.routes.push(route.id);
    route.trainId = train.id;
    train.events.push({ t: sim.time, kind: 'route', signal: signalLabel(sim, route.signal), ...(route.human ? { human: true } : {}),
      ...(wrongMainFor(train, route.cand) || route.cand.gapWrong ? { wrongMain: true } : {}) });
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

// Drops every reservation the train holds (a spur stub's visitor holds its spur while bound for the stub).
const unreserve = (sim, train) => { for (const [t, id] of sim.reserved) if (id === train.id) sim.reserved.delete(t); };
// Releases every edge the train still holds, cancels any route set for it that it never entered, drops its
// reservation, then logs its delay and records it in sim.completed with its portals' names, its distance (cells of path
// run, portal to portal) and its event log.
export function despawnTrain(sim, train) {
  const { edges, portals } = sim.layout;
  for (const e of train.path) {
    sim.edgeState[e].occ.delete(train.id);
    releaseEdge(sim, e);
    train.pathOff += edges[e].len;
    train.pathStart = far(edges[e], train.pathStart);
  }
  train.path = [];
  for (const r of [...sim.routes.values()]) if (!r.entered && r.trainId === train.id) cancelRoute(sim, r.id);
  unreserve(sim, train);
  train.state = 'done';
  sim.trains.delete(train.id);
  const delay = sim.time - train.sched, m = Math.round(delay / 60);
  logEvent(sim, `${train.name} out via ${portals[train.exit].name} (${m < 0 ? '−' : '+'}${Math.abs(m)} min)`);
  train.events.push({ t: sim.time, kind: 'out' });
  sim.completed.push({ name: train.name, type: train.type, from: portals[train.entry].name, to: portals[train.exit].name, delay,
    spawnTime: train.spawnTime, exitTime: sim.time, stops: train.stops, distance: train.run + train.pathOff, events: train.events });
  clearAspects(sim);
}

export const PUSH_MPH = 15; // a pushing train's limit (spec "Reversal")

// One step of dt sim seconds for every train. Does not advance sim.time (step owns it).
// The stop point: FOUL short of the path's end, and a cut short of that when the path ends at the buffer of a stub holding
// one (the loco runs up to the cut and touches it; nothing runs into a cut, however it was routed). A train turned round in
// the stub, its path ending at the stub signal, has the cut behind it.
export function stopDist(sim, train) {
  const last = sim.layout.edges[train.path.at(-1)], cut = last && sim.adj.get(headNode(sim, train)).length === 1 && sim.cuts.get(last.track);
  return train.pathOff + train.path.reduce((s, e) => s + sim.layout.edges[e].len, 0) - FOUL - (cut ? cutLen(cut) : 0);
}
export function moveTrains(sim, dt = 1) {
  const { edges, tracks } = sim.layout;
  for (const train of [...sim.trains.values()]) {
    dropCancelled(sim, train);
    adopt(sim, train);
    // A train that has just reversed stands until it has a route: then it backs in (or goes where a human sent it).
    if (train.state === 'reversing' && train.routes.length) {
      train.state = 'running';
      if (train.dest !== null && trackAhead(sim, train) === train.dest) {
        logEvent(sim, `${train.name} backing into ${tracks[train.dest].name}`);
        train.events.push({ t: sim.time, kind: 'backing', track: tracks[train.dest].name });
      }
    }
    // Its path ends at an exit: it runs off the panel there. That is its own exit unless a human routed it out by another.
    // A dead end that is no portal (a terminus's buffer stop) is no exit: the train stops FOUL short of it.
    const out = train.path.length > 0 ? portalAtNode(sim, headNode(sim, train)) : undefined, runOff = out !== undefined;
    const acc = TYPES[train.type].acc * MPH, dec = TYPES[train.type].dec * MPH;
    const held = train.state === 'dwelling' || train.state === 'holding' || train.state === 'reversing';
    // Limit: the head's edge, and every edge ahead braked down to from where the head is now. A limit never drops the
    // train faster than dec (a slow order set under it brakes it); the stop point below stays absolute.
    // ponytail: speed limits read the head's edge only; a tail still on slower track doesn't hold the train.
    let vAllowed = held ? 0 : train.maxSpeed, s = train.pathOff;
    for (const e of train.path) {
      const end = s + edges[e].len;
      const ahead = Math.max(0, s - train.headDist), ve = edgeSpeed(sim, edges[e]) * MPH;
      if (end > train.headDist) vAllowed = Math.min(vAllowed, Math.max(Math.sqrt(ve * ve + 2 * dec * ahead), train.speed - dec * dt));
      s = end;
    }
    if (train.pushing) vAllowed = Math.min(vAllowed, PUSH_MPH * MPH);
    const remaining = runOff ? Infinity : stopDist(sim, train) - train.headDist; // to the stop point
    vAllowed = Math.min(vAllowed, Math.sqrt(2 * dec * Math.max(0, remaining)));
    // ponytail: brake curve is one-sided; fine for a panel sim
    let v = Math.min(train.speed + acc * dt, vAllowed), adv = v * dt;
    // Never past the stop point: arrive and stand. Rounding leaves ~1e-16 of remaining once there; that is not a move.
    if (adv >= remaining) { adv = remaining > 1e-9 ? remaining : 0; v = 0; }
    if (train.speed > 0 && v === 0) train.stops++;
    train.speed = v;
    train.headDist += adv;
    train.adv = adv;
    if (adv > 0) Object.assign(train, { lastMoveTime: sim.time, stalled: false });
    occupy(sim, train);
    sectionalRelease(sim, train);
    if (runOff && train.headDist - train.len >= pathLength(sim, train)) { train.exit = out.id; despawnTrain(sim, train); continue; }
    if (!held) train.state = v === 0 && remaining - adv <= 0.05 ? 'stopped' : 'running';
  }
  clearAspects(sim);
}

// ---- Traffic and the virtual operator (spec "Traffic", "The virtual operator")
// Mean spawn interval per portal of a two-portal terminal, sim s; with a junction's third portal each portal's is 1.5 x
// this (the same traffic, shared three ways).
export const DENSITY = { light: 12 * 60, normal: 7 * 60, busy: 4 * 60 };
export const BRANCH_SHARE = 0.3; // share of the trains that can reach a junction's branch that leave by it
export const DWELL = { P: 3 * 60, L: 15 * 60, industry: 25 * 60, terminus: 10 * 60, setOut: 3 * 60, pickUp: 2 * 60 };
const STALL = 30 * 60, STARVE = 10 * 60, NEAR = 20; // stood this long: logged / served first; "behind within" cells
const QUEUE_MAX = 8; // queued trains per portal

export function logEvent(sim, text) {
  sim.log.push({ t: sim.time, text });
  if (sim.log.length > 200) sim.log.shift();
}

// E12C, W41Ad: facing, column, row letter (A = row 0), a d suffix for dwarfs (s for a terminus's shunt signals, E at F1
// and W at F2, which share their node with no other signal). The facing is the way a train reading it
// travels: from the far end of the edge it faces to its node (E/W along a row, N/S up/down a column), at a portal into
// the panel. Unique: one signal per node and facing.
const INTO = { west: 'E', east: 'W', north: 'S', south: 'N' }; // a portal's side -> the way its trains enter
export function signalLabel(sim, signalId) {
  const { signals, nodes, edges, portals } = sim.layout, s = signals[signalId], n = nodes[s.node];
  let facing;
  if (s.from === null) facing = INTO[portals.find(p => p.node === s.node).side];
  else {
    const o = nodes[far(edges[s.from], s.node)], dx = n.x - o.x, dy = n.y - o.y; // y grows downward (south)
    facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
  }
  return `${facing}${n.x}${String.fromCharCode(65 + n.y)}${s.kind === 'dwarf' ? 'd' : s.kind === 'shunt' ? 's' : ''}`;
}

// Beside a standing cut, too: a train in a stub then stands clear of its ladder like on any track, so turned round its head
// reads the stub signal (a human route into a full stub that it doesn't fit is never taken, and dies: deadRoute).
export const fits = (sim, train, trackId) => train.len <= sim.layout.tracks[trackId].capacity - (sim.cuts.has(trackId) ? cutLen(sim.cuts.get(trackId)) : 0);

// The fan a track is a stub of, or null.
const fanOf = (sim, trackId) => (sim.layout.fan?.stubs.includes(trackId) ? sim.layout.fan : null);
// ponytail: yard tracks must be clear like any other; the spec's optional Restricting entry onto an occupied yard
// track is dropped.
// Rule (spec "Reservation"): a fan is one unit. Its stub is free only while no other train is in the fan, routed into it,
// reserved for any of its stubs or bound for one: its one visitor works every stub, its dest moving between them.
export function trackFree(sim, trackId, forTrainId = null) {
  const mine = id => forTrainId !== null && id === forTrainId, fan = fanOf(sim, trackId), ids = fan ? fan.stubs : [trackId];
  if (ids.some(id => sim.reserved.has(id) && !mine(sim.reserved.get(id)))) return false;
  if (fan && [...sim.trains.values()].some(t => !mine(t.id) && ids.includes(t.dest))) return false;
  return (fan ? sim.fanEdges : sim.layout.tracks[trackId].edges).every(e => {
    const st = sim.edgeState[e];
    return [...st.occ].every(mine) && (st.route === null || mine(sim.routes.get(st.route).trainId));
  });
}

export const holdingTracks = (sim, dir) =>
  sim.layout.tracks.filter(t => t.dir === dir && (t.cls === 'siding' || t.cls === 'yard')).map(t => t.id);

// Reachability on the empty layout (spec "Reachability"): tracks[`${portal}:${dir}`] holds the tracks a dir train
// entering at that portal can reach; exits[`p${portal}:${dir}`] and exits[`t${track}:${dir}`] the exit portals a dir
// train can still reach from that portal (never itself: a portal node is one of its own exit nodes), or standing at
// that track's exit signal. Every portal is an entry for both dirs here; a main portal never gets a train of the other.
// ponytail: one findPath per (start, dir, goal), up to ~170 per junction layout: createSim takes 2-25 ms (s3: 23 ms, 17
// before the branch portal counted). One flood per start collecting every track and exit it reaches would do if layouts
// grow.
function reachability(sim) {
  const { tracks, signals, portals } = sim.layout, reach = { tracks: {}, exits: {} };
  const exitsFrom = (node, dir, from) =>
    new Set(portals.filter(x => findPath(sim, node, dir, { exit: x.id }, {}, from)?.length).map(x => x.id));
  for (const p of portals) for (const d of [1, -1]) {
    reach.tracks[`${p.id}:${d}`] = new Set(tracks.filter(t => findPath(sim, p.node, d, { track: t.id })).map(t => t.id));
    reach.exits[`p${p.id}:${d}`] = exitsFrom(p.node, d, null);
  }
  for (const t of tracks) {
    // A train at the track stands at its exit signal, facing the track edge it stands on: the first, or a terminus stub's
    // second (its buffer edge; the first runs from the apex to the signal).
    const s = signals.find(g => t.edges.includes(g.from));
    for (const d of [1, -1]) reach.exits[`t${t.id}:${d}`] = exitsFrom(s.node, d, s.from);
  }
  return reach;
}

// Weights follow the lighting cycle: passenger falls at night, freight (Z, M, spur industries) rises, locals stay. Only
// destinations a dir train entering at portalId (by default the portal of dir) can reach.
// A terminus's stub is drawn at both main portals like a platform (spec "The terminus mission"), by a P and an X, marked
// terminus. Rule: only while it is free (no train in it, routed into it or bound for it) and no terminus train is
// queued: one mission takes ~25 min and serves both portals, so terminus entries otherwise fill every portal's queue
// (QUEUE_MAX) and the draws for all other traffic are dropped (s12 busy: 8 of 8 queued for the stub at both portals by
// the fourth hour, a third fewer trains through in 8 h).
// A fan's visits (spec "Traffic") are drawn for its serving dir (fan.main) at its serving portal only: a loaded visit to its
// first empty stub (CUT_MAX cars here, for the fits filter: newEntry draws CUT_MIN..CUT_MAX) and a light one (no cars) to
// its first full stub, each of its stub's industry type, marked shunt. Rule: only while the fan is free and no visitor for
// it is queued (one in the offing, as the terminus). A spur with a stub is an industrial lead: in place of its spur item, the
// same visit keyed on its one stub (dest the spur, whose reservation covers the stub), loaded while the stub is empty, light
// while it is full, by the same rule on the spur, and like the fan's at its dir's main portal only (drawn at a junction's
// branch portal too, s166's stood at the stem to cross the gap until the valve gave the visit up). So no unit train is ever
// drawn for it.
export function trafficMenu(sim, dir, portalId = portalFor(sim, dir)) {
  const reach = sim.reach.tracks[`${portalId}:${dir}`], mine = sim.layout.tracks.filter(t => t.dir === dir && reach.has(t.id));
  const n = nightOf(sim), pax = 1 - 0.7 * n, frt = 1 + 0.7 * n, { wye, portals, fan, tracks } = sim.layout, visits = [];
  if (fan && dir === fan.main && portalId === portalFor(sim, dir) && trackFree(sim, fan.stubs[0])
    && !sim.queue.some(q => q.some(k => k.shunt && fan.stubs.includes(k.dest)))) {
    const empty = fan.stubs.find(id => !sim.cuts.has(id)), full = fan.stubs.find(id => sim.cuts.has(id)), type = id => tracks[id].industry.trainType;
    if (empty !== undefined) visits.push({ type: type(empty), cars: CUT_MAX, dest: empty, weight: 3 * frt, shunt: true });
    if (full !== undefined) visits.push({ type: type(full), cars: 0, dest: full, weight: 2 * frt, shunt: true });
  }
  const stub = wye?.kind === 'terminus' && portals[portalId].dir !== 0 && reach.has(wye.stub) && trackFree(sim, wye.stub)
    && !sim.queue.some(q => q.some(k => k.terminus)) ? wye.stub : null;
  const menu = [{ type: 'X', dest: null, weight: 3 * pax }, { type: 'Z', dest: null, weight: 2 * frt },
    { type: 'M', dest: null, weight: 3 * frt },
    ...mine.filter(t => t.cls === 'platform').map(t => ({ type: 'P', dest: t.id, weight: 6 * pax })),
    ...mine.filter(t => t.cls === 'spur').flatMap(t => (t.stubOf == null ? [{ type: t.industry.trainType, dest: t.id, weight: 2 * frt }]
      : !trackFree(sim, t.id) || sim.queue.some(q => q.some(k => k.shunt && k.dest === t.id)) || portalId !== portalFor(sim, dir) ? []
      : [{ type: t.industry.trainType, cars: sim.cuts.has(t.stubOf) ? 0 : CUT_MAX, dest: t.id, stub: t.stubOf,
        weight: (sim.cuts.has(t.stubOf) ? 2 : 3) * frt, shunt: true }])),
    ...mine.filter(t => t.cls === 'yard').map(t => ({ type: 'L', dest: t.id, weight: 2 })),
    ...(stub === null ? [] : [{ type: 'P', dest: stub, weight: 6 * pax, terminus: true }, { type: 'X', dest: stub, weight: 3 * pax, terminus: true }]),
    ...visits];
  // A train too long for its track would wedge the queue for good. The generator's capacity floors mean this
  // drops nothing; the spawn gate checks fits again anyway.
  return menu.filter(m => m.dest === null || fits(sim, { len: trainLength(m.type, m.cars) }, m.dest));
}

// A visit's allowance (spec "Schedule"), to a fan's stub or a spur with a stub: its two dwells and five minutes of shunting.
const dwellFor = (sim, type, dest) => (dest === null ? 0 : sim.layout.tracks[dest].cls === 'stub' || sim.layout.tracks[dest].stubOf != null
  ? DWELL.setOut + DWELL.pickUp + 5 * 60
  : sim.layout.tracks[dest].stub ? DWELL.terminus
  : sim.layout.tracks[dest].cls === 'spur' ? DWELL.industry : DWELL[type]);

// The track whose signal the train's path ends at (its last edge is that track's first), or null.
const trackAhead = (sim, train) => (train.path.length ? sim.layout.edges[train.path.at(-1)].track : null);

// A queued train at a portal: drawn from the menu, named, scheduled and given its train id now. Its delay clock runs
// from here, so waiting at the portal counts. It enters bound the portal's way (at a junction's branch portal east or
// west by a fair coin) and leaves at the far end, or by the branch (BRANCH_SHARE) when it can reach that from its
// destination, or from its entry when it has none. Both coins come from sim.branchRng, one draw each per entry whether
// used or not, so they never touch sim.rng: a layout without a wye keeps its traffic. A fan visitor leaves by the far end,
// whatever its coin said (spec "The visit" 11); a loaded one's cars come from sim.cutRng.
function newEntry(sim, portalId) {
  const { portals, edges } = sim.layout, dirCoin = sim.branchRng(), exitCoin = sim.branchRng(), branch = portals.find(p => p.dir === 0);
  const dir = portals[portalId].dir || (dirCoin < 0.5 ? 1 : -1), menu = trafficMenu(sim, dir, portalId);
  let r = sim.rng() * menu.reduce((s, m) => s + m.weight, 0);
  const { type, dest, terminus, shunt, cars: most = TYPES[type].cars } = menu.find(m => (r -= m.weight) < 0) ?? menu.at(-1);
  const cars = shunt && most ? randInt(sim.cutRng, CUT_MIN, most) : most;
  const name = `${type} ${sim.nextName[dir]}`;
  sim.nextName[dir] += 2;
  const reach = sim.reach.exits[dest !== null ? `t${dest}:${dir}` : `p${portalId}:${dir}`];
  const exit = !shunt && branch && exitCoin < BRANCH_SHARE && reach.has(branch.id) ? branch.id : portalFor(sim, -dir);
  // Its home main, portal to far end.
  const mainLen = edges.reduce((s, e) => s + (e.main === dir ? e.len : 0), 0);
  const run = mainLen / (0.8 * TYPES[type].max * MPH);
  return { id: sim.nextTrainId++, name, type, dir, entry: portalId, exit, dest, cars, len: trainLength(type, cars), ...(terminus ? { terminus } : {}),
    ...(shunt ? { shunt } : {}),
    spawnTime: sim.time, sched: Math.round(sim.time + run + dwellFor(sim, type, dest) + 5 * 60) };
}

function canEnter(sim, q) {
  const node = sim.layout.portals[q.entry].node, st = sim.edgeState[forwardEdges(sim, node, q.dir)[0]];
  const r = st.route === null ? null : sim.routes.get(st.route);
  // Rule: the portal edge must be unoccupied and unrouted, except for an un-entered human route (trainId null) from
  // this portal's signal, of its direction (at the branch portal, dir 0: either), which the entering train adopts;
  // otherwise a route lined from the portal before any train came blocks it for good. A route running out over the
  // portal edge (a departure up the stem) is never the entering train's to take.
  if (st.occ.size || (r && (r.entered || r.trainId !== null || r.signal !== signalAhead(sim, node, null)
    || (r.dir !== q.dir && r.dir !== 0)))) return false;
  // A train still waiting at this portal for its first route occupies nothing: never stack another behind it.
  for (const t of sim.trains.values()) if (t.entry === q.entry && !t.path.length) return false;
  // Rule: a fan visitor enters only while no train is wrong main (the operator sends none out while it approaches): on s125
  // one entered behind a train already out, whose way home was held by the queue behind the visitor's stand.
  return q.dest === null || (fits(sim, q, q.dest) && trackFree(sim, q.dest) && !(q.shunt && fanOf(sim, q.dest) && wrongMainBusy(sim, null, { visits: false })));
}

function spawner(sim) {
  const { portals } = sim.layout, mean = DENSITY[sim.density] * (portals.length / 2); // per portal: the traffic is shared
  for (const p of portals) {
    const queue = sim.queue[p.id];
    while (sim.time >= sim.nextSpawn[p.id]) {
      // ponytail: a full queue (QUEUE_MAX) drops the draw. The board lists queued trains as due soon, and past a
      // handful they only pile up delay. Thin the spawn rate instead if queues ever sit full.
      if (queue.length < QUEUE_MAX) queue.push(newEntry(sim, p.id));
      sim.nextSpawn[p.id] += -mean * Math.log(1 - sim.rng()); // exponential gaps
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
    logEvent(sim, `${t.name} entered from ${p.name}`);
  }
}

// Rule: a hold ends when the awaited train is gone, has routes past the holder's signal (where the holder's path
// ends: it has the main, the holder follows it out), or has itself stopped to dwell or hold (not coming).
function holdOver(sim, t) {
  const h = sim.trains.get(t.holdFor), x = n => sim.layout.nodes[n].x;
  if (!h) return !sim.queue.some(q => q.some(k => k.id === t.holdFor));
  return h.state === 'dwelling' || h.state === 'holding' || (x(headNode(sim, h)) - x(headNode(sim, t))) * t.dir > 0;
}

// Rule (spec "Reverse 1"): a train turns round only with no other train, and no route not its own, on a section it stands
// in or on the edges es: nothing may stand or be routed there in the sense its turn makes opposite. Pulled ahead at P, es
// is the feet main's junction edges, which nothing enters behind it meanwhile (setRoute's 'terminus' rule); so it only
// waits for trains ahead of it to clear them.
function clearToReverse(sim, t, es = []) {
  const { edges } = sim.layout, secs = new Set(t.path.filter(e => sim.edgeState[e].occ.has(t.id)).map(e => edges[e].section));
  return [...es, ...[...secs].flatMap(s => sim.sectionEdges.get(s) ?? [])].every(e => {
    const st = sim.edgeState[e];
    return [...st.occ].every(id => id === t.id) && (st.route === null || sim.routes.get(st.route).trainId === t.id);
  });
}

// A terminus train (spec "The terminus mission"): stopped at its pull-ahead node it reverses (its head now at the far
// foot's shunt signal, from which the operator backs it into the stub) and arrives at the buffer like any train at its
// track; when its dwell is up it reverses again (dir unchanged, loco leading) and leaves for the portal it came in by.
// A visitor (a fan's or a spur stub's) runs its own stages (shuntStep).
function missions(sim) {
  const { tracks } = sim.layout;
  for (const t of sim.trains.values()) {
    const at = trackAhead(sim, t);
    if (t.shunt) shuntStep(sim, t);
    else if (t.state === 'dwelling') {
      if (sim.time >= t.dwellUntil && (!t.terminus || clearToReverse(sim, t))) {
        logEvent(sim, `${t.name} departed ${tracks[t.dest].name}`);
        t.events.push({ t: sim.time, kind: 'departed', track: tracks[t.dest].name });
        sim.reserved.delete(t.dest);
        if (t.terminus) reverse(sim, t, -t.arrival); // its exit is its entry since reverse 1
        Object.assign(t, { dest: null, goal: { exit: t.exit }, state: 'running', lastMoveTime: sim.time });
      }
    } else if (t.state === 'stopped' && t.dest !== null && at === t.dest) {
      t.state = 'dwelling';
      t.dwellUntil = sim.time + dwellFor(sim, t.type, at);
      logEvent(sim, `${t.name} arrived at ${tracks[at].name}`);
      t.events.push({ t: sim.time, kind: 'arrived', track: tracks[at].name });
    } else if (t.terminus && !t.reversed1 && t.state === 'stopped' && !t.adv && headNode(sim, t) === t.goal.node
      && clearToReverse(sim, t, sim.feet)) { // !adv: not in the step it ran up to P, whose motion the renderer still draws
      const sig = signalLabel(sim, signalAheadOf(sim, t));
      reverse(sim, t, -t.arrival);
      Object.assign(t, { goal: { track: t.dest }, state: 'reversing', reversed1: true, exit: t.entry });
      logEvent(sim, `${t.name} reversing at ${sig}`);
      t.events.push({ t: sim.time, kind: 'reversing', signal: sig });
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

// A fan visitor (spec "The visit"), by what has actually happened (where it stopped, with what), so a human's routes drive
// the same visit. approach: stopped at its stand (P), it turns round (reverse 1) when clear to and when no other train is
// wrong main (wrongMainBusy: from here until its tail is up the lead it is the one wrong-main train), its head at X, whose
// shunt signal backs it into its stub. in: stopped in a stub (its dest, or one a human sent it into), it works it if it
// can, loaded at an empty one (setOut) or light at a full one (pickUp), and when its dwell is up its cars become the cut
// (or the cut's its cars) where they stand, the loco's pixels unmoved; then, or at once where it can work nothing, it turns
// round, loco leading, for Lt (out after a set-out while another stub of the fan is full and a fair coin on cutRng says so,
// depart otherwise: spec "The visit" 7, amended). out: at Lt, light, it turns round again for the first other full stub
// (in). At Lt otherwise it is done with the fan and runs for its exit. Each reversal waits one still step (!adv, as the
// terminus's) and for no other train or route in the sections it stands in (clearToReverse).
// A spur stub's visitor (kind spur) runs the same stages with the spur's exit signal for its stand and its lead: it turns
// round there when its spur is clear, waiting for no wrong-main train (it stands on no main: spec "Builder check" 4), bound
// now for the stub (its dest; the spur stays reserved for it), and with one stub it leaves after its one set-out or pick-up.
function shuntStep(sim, t) {
  const { tracks } = sim.layout, s = t.shunt, at = trackAhead(sim, t), still = t.state === 'stopped' && !t.adv;
  // retarget: a fan visitor's only (a spur stub's has its one stub)
  const name = () => tracks[t.dest].name, retarget = id => { sim.reserved.delete(t.dest); t.dest = id; sim.reserved.set(id, t.id); };
  const turn = (dir, goal, stage) => {
    const before = signalAheadOf(sim, t);
    reverse(sim, t, dir);
    const sig = signalLabel(sim, before ?? signalAheadOf(sim, t)); // at a buffer (no signal) the stub signal it now reads
    Object.assign(t, { goal, state: 'reversing' });
    s.stage = stage;
    logEvent(sim, `${t.name} reversing at ${sig}`);
    t.events.push({ t: sim.time, kind: 'reversing', signal: sig });
  };
  if (s.stage === 'approach') {
    if (still && headNode(sim, t) === s.stand && (s.kind === 'fan'
      ? clearToReverse(sim, t, t.path.slice(-1)) && !wrongMainBusy(sim, t, { visits: false }) // (a fan visitor's last edge is the run)
      : clearToReverse(sim, t, tracks[t.dest].edges))) {
      if (s.kind === 'spur') t.dest = s.stub;
      turn(-t.arrival, { track: t.dest }, 'in');
    }
  } else if (t.state === 'dwelling') {
    if (sim.time < t.dwellUntil || !clearToReverse(sim, t)) return;
    if (s.stage === 'setOut') {
      const n = t.cars;
      sim.cuts.set(t.dest, { track: t.dest, type: t.type, cars: n });
      Object.assign(t, { cars: 0, len: LOCO, headDist: t.headDist - n * CAR });
      logEvent(sim, `${t.name} set out ${n} cars at ${name()}`);
      t.events.push({ t: sim.time, kind: 'setOut', track: name(), cars: n });
    } else {
      const n = sim.cuts.get(t.dest).cars;
      sim.cuts.delete(t.dest);
      Object.assign(t, { cars: n, len: trainLength(t.type, n), headDist: t.headDist + n * CAR });
      logEvent(sim, `${t.name} picked up ${n} cars at ${name()}`);
      t.events.push({ t: sim.time, kind: 'pickUp', track: name(), cars: n });
    }
    const pick = s.stage === 'setOut' && s.kind === 'fan' && s.fan.stubs.some(id => id !== t.dest && sim.cuts.has(id)) && sim.cutRng() < 0.5;
    turn(t.arrival, { node: s.lead }, pick ? 'out' : 'depart');
  } else if (s.stage === 'in' && t.state === 'stopped' && (s.kind === 'fan' ? s.fan.stubs : [s.stub]).includes(at)) {
    if (at !== t.dest) retarget(at);
    if (isLight(t) === sim.cuts.has(at)) {
      Object.assign(t, { state: 'dwelling', dwellUntil: sim.time + (isLight(t) ? DWELL.pickUp : DWELL.setOut) });
      s.stage = isLight(t) ? 'pickUp' : 'setOut';
      logEvent(sim, `${t.name} arrived at ${name()}`);
      t.events.push({ t: sim.time, kind: 'arrived', track: name() });
    } else if (!t.adv && clearToReverse(sim, t)) turn(t.arrival, { node: s.lead }, 'depart');
  } else if (still && headNode(sim, t) === s.lead && (s.stage === 'out' || s.stage === 'depart')) {
    const full = s.stage === 'out' ? s.fan.stubs.find(id => id !== t.dest && sim.cuts.has(id)) : undefined; // (out: a fan's)
    if (full === undefined) {
      logEvent(sim, `${t.name} departed ${name()}${isLight(t) ? ' light' : ''}`);
      t.events.push({ t: sim.time, kind: 'departed', track: name() });
      unreserve(sim, t);
      Object.assign(t, { dest: null, shunt: null, goal: { exit: t.exit } });
    } else if (clearToReverse(sim, t)) { retarget(full); turn(-t.arrival, { track: full }, 'in'); }
  }
}
// The visitor gives its visit up (spec "Human routes", "The valve", "Builder check" 2): it keeps whatever it has coupled
// and runs for the far end of the way it now faces. A spur stub's visitor misses its stub.
function missShunt(sim, t) {
  const track = sim.layout.tracks[t.shunt.kind === 'fan' ? t.dest : t.shunt.stub].name;
  logEvent(sim, `${t.name} missed ${track}`);
  t.events.push({ t: sim.time, kind: 'missed', track });
  unreserve(sim, t);
  t.exit = portalFor(sim, -t.dir);
  Object.assign(t, { dest: null, shunt: null, goal: { exit: t.exit } });
}

// Rule: a higher-priority train of the same direction is "behind" if its head node (where its routes end) is up to
// NEAR cells behind this one's and it isn't dwelling or holding, or it is the next queued train of its direction to enter
// behind it.
// A terminus train is never held for (it turns round at the wye and goes back), nor held (spec "The terminus mission"); nor
// is a fan visitor (spec "Never passed, never held").
// ponytail: proximity on head nodes only, ceiling NEAR = 20 cells and no lookahead on where the faster train goes.
function trainBehind(sim, t) {
  const x = n => sim.layout.nodes[n].x, xt = x(headNode(sim, t));
  for (const h of sim.trains.values()) {
    if (h.terminus || h.shunt || h.dir !== t.dir || h.prio <= t.prio || h.state === 'dwelling' || h.state === 'holding') continue;
    const d = (xt - x(headNode(sim, h))) * t.dir;
    if (d > 0 && d <= NEAR) return h;
  }
  // Rule: a queued train counts only if its destination is free (or it has none): one waiting for a busy spur is
  // not coming, and holding for it parked trains for an hour in the soak. Nor if it enters ahead (a junction's branch
  // arrival, while this train is short of the wye).
  const q = sim.queue.flat().find(k => !k.terminus && !k.shunt && k.dir === t.dir && (xt - x(sim.layout.portals[k.entry].node)) * t.dir > 0
    && (k.dest === null || trackFree(sim, k.dest)));
  return q && TYPES[q.type].prio > t.prio ? q : null;
}

// Overtake: route t from sig into a free holding track it fits, to wait there for the train behind.
function hold(sim, t, sig, cands) {
  if (t.terminus || t.shunt) return false;
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
// - into a track the train at its signal doesn't fit, or of the other dir than that train (at the branch's dir 0 stem
//   signal): adopt refuses it, and nothing can pass that train; or
// - wrong main (onto the other main, across a junction gap's other main without running out by the branch, or from a
//   signal on the other main) with no train of its direction at its signal. It counts as the one wrong-main train and
//   locks the other direction's home main against it. A dir 0 signal is on no main; a train is at it when its path
//   ends there (signalAheadOf), whichever its dir; or
// - from a terminus's shunt signal with no train at it: only a reversed terminus train ever comes there, and none can
//   while the stub is busy. Left, one onto the main held a departure and the trains behind it at b for good, and a
//   back-in route at the other foot kept the arrival reversing for hours. Likewise from a fan's lead signal (Lt) or an
//   industrial stub's signal, where only a visitor stands: Lt's runs down the lead onto the run, and under random clicking
//   held the run 35 min on s12 (a stub signal's lived on while a visitor was bound for that stub).
const GRACE = 3 * 60;
function deadRoute(sim, r) {
  const { edges, tracks, signals, nodes, mainRow } = sim.layout;
  if (!r.human || r.entered || r.trainId !== null || sim.time - r.setAt < GRACE) return false;
  const from = edges[r.cand.edges[0]].track, into = edges[r.cand.edges.at(-1)].track, trains = [...sim.trains.values()];
  const sig = signals[r.signal], at = trains.filter(t => signalAheadOf(sim, t) === r.signal);
  if (at.length && at.every(t => r.dir !== 0 && t.dir !== r.dir)) return true;
  if ((sig.kind === 'shunt' || r.signal === sim.layout.fan?.leadSignal || tracks[edges[sig.from]?.track]?.cls === 'stub') && !at.length) return true;
  const onOther = sig.dir !== 0 && nodes[sig.node].y === mainRow[-sig.dir];
  if ((r.cand.wrongMain || r.cand.gapWrong || onOther) && !at.length) return true;
  if (from === null) return into !== null && at.some(t => !fits(sim, t, into));
  return tracks[from].edges.every(e => sim.edgeState[e].occ.size === 0)
    && [...sim.routes.values()].every(o => edges[o.cand.edges.at(-1)].track !== from)
    && !trains.some(t => t.dest === from && sim.time - t.lastMoveTime < STARVE);
}

// Rule: a junction's branch turns round (spec "Stem one at a time"). A departure waiting at a signal into it (bound for
// the branch, its path ending at b or b') stands on the main and holds up the trains behind it; an arrival waiting at
// the branch portal holds up nothing. So while a departure waits no arrival is let into the stem, and the branch drains
// (trains in it always run out) for the departure. Without this, busy arrivals follow each other down the stem (same
// sense) and a departure at b waited 14 min while the main behind it backed up. An arrival that has stood STARVE is
// not held: it is served first by rank like any train stood that long, and a departure cannot slip in behind an
// outbound train on the single stem, so it gets in next. A departure stood STARVE gives the branch up (the valve).
function arrivalsHeld(sim, br) {
  if (!br) return false;
  const trains = [...sim.trains.values()];
  return !trains.some(u => u.entry === br.id && !u.path.length && sim.time - u.lastMoveTime >= STARVE)
    && trains.some(u => u.exit === br.id && u.dest === null && intoBranch(sim, signalAheadOf(sim, u), u.dir, br));
}
// Rule: a terminus's feet main turns round too. A terminus train that has stood STARVE waiting for its way into the gap
// (at b or b', before it reverses) or out of the stub (at the stub signal) wants the gap's section in its dir, against
// whatever runs the other way there; under busy traffic those trains follow each other in (same sense) and it waited 25
// min on s14. So the operator routes no other train into the gap the other way while it waits (returned here), and the
// gap drains for it: the trains in there always run out of it. Not while a train is wrong main (the terminus train may
// not start its run then: setRoute), and while it holds them no train is sent wrong main past the trains it holds.
function terminusTurning(sim) {
  if (sim.layout.wye?.kind !== 'terminus' || wrongMainTrains(sim).length) return [];
  return [...sim.trains.values()].filter(u => {
    if (!u.terminus || u.state === 'dwelling' || sim.time - u.lastMoveTime < STARVE) return false;
    const sig = signalAheadOf(sim, u);
    return sig !== undefined && (u.reversed1 ? sig === sim.layout.wye.stubSignal : !!sim.routesFrom.get(sig)?.some(c => c.intoGap));
  });
}
// Signal sig has a route of dir up the stem to the branch portal br (it stands at b or b').
const intoBranch = (sim, sig, dir, br) => !!sim.routesFrom.get(sig)?.some(c => c.exitNode === br.node && c.dir === dir);
// The train gives up the branch it was bound for and runs for the far end of its dir.
function missBranch(sim, t, br) {
  logEvent(sim, `${t.name} missed ${br.name}`);
  t.exit = portalFor(sim, -t.dir);
  t.goal = { exit: t.exit };
}

// A train whose path ends at a signal with no route from it gets the route to the next signal along its pathfound
// way, when the interlocking allows; otherwise it waits and tries again next tick. The operator cancels nothing but
// dead human routes (deadRoute), so a human route any train can still take stands.
// Rule: trains ahead don't hide the way, and setRoute decides if the next route sets now. An edge held by a route or a
// moving train costs nothing extra (MOVING_COST): the train follows. One held by a train stood PASS_WAIT costs
// STANDING_COST, above a detour round a module (~20-25: WRONG_MAIN_COST a wrong-main edge, two crossovers), so the
// standing train is passed on the other main.
// ponytail: on the four busy soak seeds STANDING_COST is flat from 25 to 1000 (a wrong-main train on the panel 0-5 % of
// ticks, worst stand 13 min); below ~20 (roughly one module's detour) passing mostly stops. PASS_WAIT moves the share
// (30 s: up to 8 %). If passing should be smarter, price a stand by how long the train ahead will stay.
export const WRONG_MAIN_COST = 3, MOVING_COST = 0, STANDING_COST = 60;
function operator(sim) {
  const { edges, tracks } = sim.layout;
  for (const r of [...sim.routes.values()]) {
    if (!deadRoute(sim, r)) continue;
    cancelRoute(sim, r.id);
    const c = r.cand, to = c.exitSignal !== null ? signalLabel(sim, c.exitSignal)
      : portalAtNode(sim, c.exitNode)?.name ?? 'end of track'; // the portal it runs out by
    logEvent(sim, `AUTO: cleared route ${signalLabel(sim, r.signal)} → ${to} (no train can take it)`);
  }
  // Rule: highest priority first, but a train that has stood STARVE (10 min) goes before any that hasn't; under
  // busy traffic a higher-priority main train waits every time the main frees, and a local at a merge starved.
  // ponytail: a fixed threshold, not aging; worst stand 16.8 min over 60 busy seeds. Age it if denser traffic starves.
  const rank = t => t.prio + (sim.time - t.lastMoveTime >= STARVE ? 10 : 0);
  const br = branchOf(sim), held = arrivalsHeld(sim, br), turning = terminusTurning(sim);
  const approaching = [...sim.trains.values()].some(u => u.shunt?.kind === 'fan' && u.shunt.stage === 'approach');
  for (const t of [...sim.trains.values()].sort((a, b) => rank(b) - rank(a) || a.id - b.id)) {
    if (t.state === 'dwelling' || t.state === 'holding' || t.holdFor !== null) continue; // holding or on its way in
    const node = headNode(sim, t), last = t.path.at(-1) ?? null, sig = signalAhead(sim, node, last);
    if (sig === undefined || routeFrom(sim, sig)) continue;
    // arriving: it dwells before going on (a fan visitor arrives at a buffer, with no signal; turned round in its stub, its
    // path still on the stub, it is leaving)
    if (t.dest !== null && !t.shunt && trackAhead(sim, t) === t.dest) continue;
    // Rule (liveness valve): a train bound for the branch that is wrong main (a human sent it: the operator never does,
    // below) gives the branch up and runs for the far end; so does one that has stood STARVE at b or b' when its route
    // up the stem is refused (after setRoute, below). The atomic routes through the junction keep it safe, not live: on
    // s142 a branch-bound train at b' waited on a train standing across its way in the gap, which waited (three trains
    // on) on the train behind the first. Switching its exit then cleared every stand within the hour.
    const forBranch = br && t.dest === null && t.exit === br.id;
    if (forBranch && isWrongMain(sim, t)) missBranch(sim, t, br);
    // Rule (the terminus's valve): a terminus train that has stood 2 x STARVE at b or b' with its way into the gap
    // refused (terminusTurning has had STARVE to drain it) gives the stub up and runs through for the far end. Waiting
    // to cross to the feet main it stands on its own home main: on s263 behind a train whose way on was held, head on, by
    // a wrong-main train that had to get home on the main the terminus train stood on, for good.
    if (t.terminus && !t.reversed1 && sim.time - t.lastMoveTime >= 2 * STARVE && sim.routesFrom.get(sig).some(c => c.intoGap)) {
      logEvent(sim, `${t.name} missed ${tracks[t.dest].name}`);
      sim.reserved.delete(t.dest);
      Object.assign(t, { terminus: false, dest: null, goal: { exit: t.exit } });
    }
    // Rule (spec "Never wrong main", "The valve"): a fan visitor that has not turned round gives its visit up (missShunt)
    // when it is wrong main (only a human sends it: the operator never does, below) or has stood 2 x STARVE, at its stand
    // unable to turn round (another train wrong main all that time, or its section held) or short of it, its way refused.
    if (t.shunt?.stage === 'approach' && (isWrongMain(sim, t) || sim.time - t.lastMoveTime >= 2 * STARVE)) missShunt(sim, t);
    const path = findPath(sim, node, t.dir, t.goal,
      { trainId: t.id, blockedCost: MOVING_COST, standingCost: STANDING_COST, wrongMainCost: WRONG_MAIN_COST }, last);
    if (!path) {
      // Rule: no way at all means a human route took it past its destination: give up the call, run for the exit; past
      // the branch it was bound for (a junction's), give that up and run for the far end.
      // A terminus train sent on past its pull-ahead signal gives the stub up for good (a through train now); one sent
      // away from the stub after reversing runs back for the portal it came in by. A fan visitor sent anywhere off its visit
      // gives it up there (spec "Builder check" 2).
      if (t.shunt) missShunt(sim, t);
      else if (t.dest !== null) {
        logEvent(sim, `${t.name} missed ${tracks[t.dest].name}`);
        sim.reserved.delete(t.dest);
        if (!t.reversed1) t.terminus = false; // reversed, its exit is already its entry
        Object.assign(t, { dest: null, goal: { exit: t.exit } });
      } else if (br && t.exit === br.id) missBranch(sim, t, br);
      continue;
    }
    if (!path.length) continue; // at its goal node (a terminus train at its pull-ahead signal): missions turns it round
    // At a dir 0 signal (the stem's) only the routes of its dir, or both dirs, are the train's to take.
    const cands = sim.routesFrom.get(sig).filter(c => c.dir === 0 || c.dir === t.dir);
    if (t.dest === null && t.prio <= 2 && hold(sim, t, sig, cands)) continue;
    // The candidate the path starts with; when none is (the path dips over a pair and back), the one ending where the
    // path's first leg does: at its first signal or exit.
    let legEnd = node;
    for (const e of path) {
      legEnd = far(edges[e], legEnd);
      if (signalAhead(sim, legEnd, e) !== undefined || exitNodes(sim, t).includes(legEnd)) break;
    }
    // ... or, bound for a track, the one running the whole path on along that track (into a terminus's stub the route
    // runs on past the track's first edge, where the path stops, to the buffer)
    const runsOn = c => t.goal.track != null && path.every((e, i) => c.edges[i] === e)
      && c.edges.slice(path.length).every(e => edges[e].track === t.goal.track);
    const cand = cands.find(c => c.edges.every((e, i) => path[i] === e)) ?? cands.find(runsOn) ?? cands.find(c => c.exitNode === legEnd);
    const into = cand ? edges[cand.edges.at(-1)].track : null;
    // Rule: never into a track that isn't its destination (holds go through hold()); a way round through one = wait. A spur
    // stub's visitor bound for its stub runs out of it back up its spur (spec "The visit").
    // Wrong-main candidates are fine: the way round a train on the main is over the crossovers.
    // ponytail: findPath doesn't price tracks, so a way round through one can still beat the other main and the train
    // waits. Price tracks other than the goal in findPath if passing ever looks too rare.
    if (!cand || (into !== null && into !== t.dest && into !== tracks[t.dest]?.spur)) continue;
    if (held && sim.layout.signals[sig].node === br.node) continue; // an arrival held at the portal (arrivalsHeld)
    if (cand.intoGap && turning.some(u => u !== t && u.dir !== cand.dir)) continue; // held out of the gap (terminusTurning)
    const wm = wrongMainFor(t, cand);
    if (wm && turning.some(u => u !== t)) continue; // nor round the trains held (terminusTurning)
    // Rule: nor while a fan visitor is on its way to its stand, where it turns round only with no other train wrong main.
    // One sent out meanwhile can need the visitor to clear: on s230 a train sent round it on the other main stood at b'
    // with its way home over the visitor's run and its way on held head on; on s366 one sent wrong main across the junction
    // waited on a train queued behind the visitor. Each held the visitor 20 min (the valve) and a train behind them 30. One
    // that has stood STARVE is not held (it goes first by rank, and the visitor waits for it).
    if ((wm || cand.gapWrong) && approaching && sim.time - t.lastMoveTime < STARVE) continue;
    // Rule: a train bound for the branch is never sent wrong main (its moves through the junction gap are exempt and not
    // wrongMain). Stood at b or b' on the other main its only way on is the branch, and an arrival holding that inbound
    // can need the very section it stands in: a deadlock on three of 17 junction seeds in 8 busy hours. One already
    // wrong main gave the branch up above (the valve), so this only keeps the rest off the other main.
    if (wm && t.dest === null && t.exit === br?.id) continue;
    if (wm && t.shunt) continue; // nor a fan visitor (spec "Never wrong main"): its shove is its one wrong-main move
    if (setRoute(sim, sig, cand.exitNode, { trainId: t.id }).ok)
      logEvent(sim, `AUTO: ${signalLabel(sim, sig)} → ${t.name}${wm || cand.gapWrong ? ' (wrong main)' : ''}`);
    // the valve's second clause: only once this tick's route up the stem was refused, so a train left standing ten
    // minutes in MANUAL keeps the branch when its way up is free
    else if (forBranch && cand.exitNode === br.node && sim.time - t.lastMoveTime >= STARVE) missBranch(sim, t, br);
  }
}

// ---- Ambience (spec "The lighting cycle", "Slow orders", "Shift change and the HUD")
// Night level 0..1 by phase of the cycle from 06:00: day, dusk (0.4-0.5), night, dawn (0.9-1). dayLength <= 0: always day.
const smoothstep = x => x * x * (3 - 2 * x);
export function nightLevel(time, dayLength) {
  if (dayLength <= 0) return 0;
  const p = ((time - 6 * 3600) % dayLength) / dayLength; // ponytail: sim time never runs before 06:00
  return p < 0.4 ? 0 : p < 0.5 ? smoothstep((p - 0.4) / 0.1) : p < 0.9 ? 1 : 1 - smoothstep((p - 0.9) / 0.1);
}
export function nightOf(sim) { return nightLevel(sim.time, sim.dayLength); }

export const SLOW_ORDER = { gap: 20 * 60, min: 5 * 60, max: 10 * 60, mph: 20, minLen: 6 }; // sim s: mean gap, duration range; cells
// A slow order is a bulletin, not an indication: speeds only, aspects and findPath costs are unchanged.
export const edgeSpeed = (sim, e) => (sim.slowOrder && e.section === sim.slowOrder.section ? SLOW_ORDER.mph : e.speed);
export function slowOrderLabel({ slowOrder: o }) { return `Main ${o.main} ${o.x0}–${o.x1}`; }
const clock = t => [Math.floor(t / 3600) % 24, Math.floor(t / 60) % 60].map(v => String(v).padStart(2, '0')).join(':'); // HH:MM

// One at a time, on a main section at least minLen cells long (never a junction's branch section); exponential gaps
// like spawns. Off (or no section long enough): none starts and the next is kept ahead without a draw, so turning them
// back on doesn't fire one at once; an active one runs out.
function slowOrders(sim) {
  const next = () => sim.time - SLOW_ORDER.gap * Math.log(1 - sim.extras());
  if (sim.slowOrder && sim.time >= sim.slowOrder.until) {
    logEvent(sim, `Slow order lifted: ${slowOrderLabel(sim)}`);
    sim.slowOrder = null;
    sim.nextSlowOrder = next();
  }
  if (sim.slowOrder || sim.time < sim.nextSlowOrder) return;
  const { edges, nodes } = sim.layout;
  const long = [...sim.sectionEdges].filter(([, ids]) => ids.every(e => edges[e].main != null)
    && ids.reduce((s, e) => s + edges[e].len, 0) >= SLOW_ORDER.minLen);
  if (!sim.slowOrders || !long.length) { sim.nextSlowOrder += SLOW_ORDER.gap; return; }
  const [section, ids] = pick(sim.extras, long), es = ids.map(e => edges[e]), xs = es.flatMap(e => [nodes[e.a].x, nodes[e.b].x]);
  sim.slowOrder = { section, until: sim.time + randInt(sim.extras, SLOW_ORDER.min, SLOW_ORDER.max),
    main: es[0].main === -1 ? 1 : 2, x0: Math.min(...xs), x1: Math.max(...xs) }; // Main 1 is mainRow[-1]
  logEvent(sim, `Slow order: ${slowOrderLabel(sim)}, ${SLOW_ORDER.mph} mph until ${clock(sim.slowOrder.until)}`);
}

export const OPERATORS = ['Alvarez', 'Brennan', 'Chen', 'Dubois', 'Ekwueme', 'Fischer', 'Garza', 'Haddad', 'Iyer', 'Jensen',
  'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quinn', 'Reyes', 'Sato', 'Tremblay', 'Ueda', 'Varga',
  'Whitfield', 'Zhang'];
function drawOperator(rng, not) {
  for (;;) {
    const name = `${String.fromCharCode(randInt(rng, 65, 90))}. ${pick(rng, OPERATORS)}`;
    if (name !== not) return name;
  }
}

// Shifts change every 8 sim hours from 06:00: 14:00, 22:00, 06:00.
function shifts(sim) {
  if (sim.time < sim.nextShift) return;
  sim.operator = drawOperator(sim.extras, sim.operator);
  sim.nextShift += 8 * 3600;
  logEvent(sim, `Shift change: ${sim.operator} takes the desk`);
}

// One sim second.
export function step(sim) {
  clearAspects(sim);
  // Cancelled routes drop off paths before the operator reads where they end (moveTrains drops them too, for its callers).
  for (const t of sim.trains.values()) dropCancelled(sim, t);
  if (sim.auto) operator(sim);
  spawner(sim);
  slowOrders(sim);
  shifts(sim);
  moveTrains(sim);
  missions(sim);
  sim.time += 1;
}
