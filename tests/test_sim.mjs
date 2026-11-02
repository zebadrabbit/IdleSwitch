import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate } from '../src/gen.js';
import { createSim, setRoute, cancelRoute, throwSwitch, forwardEdges, findPath, switchLocked,
  releaseEdge, sectionalRelease, entryNode, exitNodes, exitNodesOf, signalAhead, signalAheadOf, routeFrom, isWrongMain,
  wrongMainTrains, PASS_WAIT,
  ASPECT, aspectOf, signalHeads, lamps, clearAspects,
  MPH, CAR, LOCO, FOUL, TYPES, trainLength, spawnTrain, despawnTrain, moveTrains, pathLength, pointAt,
  trainBlocks, headNode, reverse, PUSH_MPH,
  DENSITY, DWELL, step, trafficMenu, fits, trackFree, holdingTracks, signalLabel, logEvent,
  WRONG_MAIN_COST, MOVING_COST, STANDING_COST, nightLevel, SLOW_ORDER, edgeSpeed, slowOrderLabel, OPERATORS } from '../src/sim.js';
import { trainStatus, boardHTML, exitLabel } from '../src/panels.js';

// ---- Task 3: interlocking core
const L = generate('lebanon');
assert.ok(L.modules.some(m => m.kind === 'station'), 'lebanon has a station (no seed loop needed)');
const sim = createSim(L, 'lebanon');
const W = -1, E = 1;
const SLOW = ['yard', 'siding', 'spur'];
const farOf = (G, e, n) => { const ed = G.edges[e]; assert.ok(ed.a === n || ed.b === n, `edge ${e} not at node ${n}`); return ed.a === n ? ed.b : ed.a; };
const walk = (G, from, es) => es.reduce((ns, e) => [...ns, farOf(G, e, ns.at(-1))], [from]); // node ids along an edge list
const allClear = S => S.routes.size === 0 && S.edgeState.every(s => s.route === null && s.occ.size === 0);
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
// Portals by dir: a dir train enters at portalOf(d) and leaves by portalOf(-d) (west id 0 eastbound, east id 1 westbound).
const portalOf = (S, d) => S.layout.portals.find(p => p.dir === d);
const pnode = (S, d) => portalOf(S, d).node;
const entrySig = (S, d) => signalAhead(S, pnode(S, d), null);
const exitsOf = (S, d) => exitNodesOf(S, portalOf(S, -d).id, d); // the far end for d, home main first
const exitGoal = (S, d) => ({ exit: portalOf(S, -d).id });
// The signal at node for trains of dir, looked up as signals were keyed before they faced an edge.
const sigAt = (S, node, dir) => S.layout.signals.find(s => s.node === node && s.dir === dir)?.id;
// Junction seeds (spec "The wye"): the first of s0..s99 with a wye on that side whose modules have destination tracks on
// both sides of it (eastbound west of the wye, westbound east of it), so trains run to and from the branch with calls.
const tx = (G, t) => G.nodes[G.edges[G.tracks[t].edges[0]].a].x; // a track's column (its entry end)
function wyeSeed(side) {
  for (let i = 0; i < 100; i++) {
    const G = generate(`s${i}`), w = G.wye, dest = (t, d) => t.cls !== 'siding' && t.dir === d;
    if (w?.kind === 'junction' && w.side === side && G.tracks.some(t => dest(t, E) && tx(G, t.id) < w.x0) && G.tracks.some(t => dest(t, W) && tx(G, t.id) > w.x1))
      return `s${i}`;
  }
  assert.fail(`no ${side} junction seed in s0..s99`);
}
const sN = wyeSeed('north'), sS = wyeSeed('south');
// Terminus seeds (spec "Phase 2"): the first of s0..s99 with a terminus on that side (s8 north, s14 south).
function termSeed(side) {
  for (let i = 0; i < 100; i++) { const w = generate(`s${i}`).wye; if (w?.kind === 'terminus' && w.side === side) return `s${i}`; }
  assert.fail(`no ${side} terminus seed in s0..s99`);
}
const tN = termSeed('north'), tS = termSeed('south');
// A terminus sim's wye: the run from each foot to its pull-ahead column (one main edge, keyed by the arrival dir that
// stops at its P: east of F2 eastbound, west of F1 westbound), the main between the feet, the legs, the stub's edges and
// its buffer, the pull-ahead signal of each arrival dir (at P, facing the run), the feet main's junction edges.
function termOf(S) {
  const G = S.layout, w = G.wye, between = (a, b) => G.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a)).id;
  const leg = f => G.edges.find(e => e.cls === 'wye' && (e.a === f || e.b === f)).id, stub = G.tracks[w.stub].edges;
  const run = { 1: between(w.F2, w.P[1]), '-1': between(w.P[-1], w.F1) };
  return { w, run, mid: between(w.F1, w.F2), leg: { F1: leg(w.F1), F2: leg(w.F2) }, stub,
    buffer: farOf(G, stub[1], G.signals[w.stubSignal].node), pSig: d => signalAhead(S, w.P[d], run[d]),
    feet: G.edges.filter(e => e.main === w.feetMain && e.junction).map(e => e.id) };
}
// A junction sim's wye: legs off F1 and F2, stem edges from the apex out, the stem signal and its node, the branch portal
// and its signal, the row of the main the feet are on, b and b' (the gap's boundary columns), the branch section.
function wyeOf(S) {
  const G = S.layout, w = G.wye, leg = f => G.edges.find(e => e.cls === 'wye' && (e.a === f || e.b === f)).id;
  const portal = G.portals.find(p => p.dir === 0);
  return { w, portal, legF1: leg(w.F1), legF2: leg(w.F2), stem: G.edges.filter(e => e.cls === 'branch').map(e => e.id),
    stemSig: w.stemSignal, stemNode: G.signals[w.stemSignal].node, portalSig: signalAhead(S, portal.node, null),
    y: G.mainRow[w.feetMain], b: w.x0, b2: w.x1, N: (x, y) => G.nodes.find(n => n.x === x && n.y === y).id,
    branchSec: G.edges.find(e => e.cls === 'branch').section };
}
// The sense a train runs branch edge e in, from its path chained from pathStart: +1 inbound (toward the main the feet are
// on), -1 outbound; 0 if e is not on its path.
function branchSense(S, T, e) {
  const G = S.layout, yM = G.mainRow[G.wye.feetMain], off = n => Math.abs(G.nodes[n].y - yM);
  let n = T.pathStart;
  for (const p of T.path) { const m = farOf(G, p, n); if (p === e) return off(m) < off(n) ? 1 : -1; n = m; }
  return 0;
}

// fresh sim shape
assert.equal(sim.time, 6 * 3600);
assert.deepEqual(sim.log, [{ t: 6 * 3600, text: `${sim.operator} on duty` }]);
assert.equal(sim.auto, false);
assert.equal(typeof sim.rng, 'function');
assert.equal(sim.adj.size, L.nodes.length);
assert.equal(sim.edgeState.length, L.edges.length);
assert.ok(allClear(sim));
assert.ok([sim.trains, sim.reserved, sim._aspects].every(m => m instanceof Map && m.size === 0));
assert.deepEqual(sim.queue, [[], []], 'one queue per portal, by portal id');
assert.deepEqual(sim.nextSpawn, [sim.time, sim.time]);
assert.deepEqual(sim.completed, []);
assert.deepEqual([...sim.switchState.keys()].sort(), L.switches.map(s => s.node).sort());
assert.ok([...sim.switchState.values()].every(s => s.lie === 'normal'));

// portals and forwardEdges: x rule plus oneWay; exits at the far end of both mains, home main first
assert.deepEqual([portalOf(sim, E).id, portalOf(sim, W).id], [0, 1]);
assert.deepEqual(exitNodesOf(sim, 1, E).map(n => [L.nodes[n].x, L.nodes[n].y]), [[L.cols - 1, L.mainRow[1]], [L.cols - 1, L.mainRow[-1]]]);
assert.deepEqual(exitNodesOf(sim, 0, W).map(n => [L.nodes[n].x, L.nodes[n].y]), [[0, L.mainRow[-1]], [0, L.mainRow[1]]]);
for (const d of [E, W]) {
  assert.equal(forwardEdges(sim, pnode(sim, d), d).length, 1);
  for (const n of exitsOf(sim, d)) {
    assert.deepEqual(forwardEdges(sim, n, d), []);
    assert.equal(forwardEdges(sim, n, -d).length, 1, 'the main runs both ways');
  }
}
// a train knows its portals: it enters at its entry and its exit nodes are the far end of its dir (the old exitNodes(dir))
{
  const S = createSim(L, 'portals'), east = spawnTrain(S, { type: 'M', dir: E }), west = spawnTrain(S, { type: 'M', dir: W });
  assert.deepEqual([east.entry, east.exit, west.entry, west.exit], [0, 1, 1, 0]);
  assert.deepEqual([entryNode(S, east), entryNode(S, west)], [pnode(S, E), pnode(S, W)]);
  assert.deepEqual([east.pathStart, west.pathStart], [pnode(S, E), pnode(S, W)], 'the path starts at the entry portal');
  assert.deepEqual(exitNodes(S, east).map(n => [L.nodes[n].x, L.nodes[n].y]), [[L.cols - 1, L.mainRow[1]], [L.cols - 1, L.mainRow[-1]]]);
  assert.deepEqual(exitNodes(S, west), exitNodesOf(S, 0, W));
  assert.deepEqual([east.goal, west.goal], [{ exit: 1 }, { exit: 0 }]);
}

// forwardEdges with the arriving edge: on every node of these layouts it equals the old x rule (leave on the far side of
// the train's dir, along the edge's allowed direction) for every edge a train of that dir can arrive by, and for none.
for (const seed of ['lebanon', 's0', 's7', 's42', 's47']) {
  const S = seed === 'lebanon' ? sim : createSim(generate(seed), seed), G = S.layout;
  const side = (n, e) => Math.sign(G.nodes[farOf(G, e, n)].x - G.nodes[n].x);
  const old = (n, d) => S.adj.get(n).filter(e => side(n, e) === d && (G.edges[e].oneWay === null || G.edges[e].oneWay === n));
  for (const n of G.nodes) for (const d of [E, W]) {
    assert.deepEqual(forwardEdges(S, n.id, d), old(n.id, d), `${seed}: node ${n.id} dir ${d}`);
    for (const from of S.adj.get(n.id).filter(e => side(n.id, e) === -d))
      assert.deepEqual(forwardEdges(S, n.id, d, from), old(n.id, d), `${seed}: node ${n.id} dir ${d} from ${from}`);
  }
}
// ... and at a switch only trunk <-> leg. At a ladder switch on lebanon's main, a train off the trunk may take the legs
// it can run along, one off a leg only the trunk; asked to run on toward the legs from a leg, the other leg (which the
// x rule alone would allow) is refused: never leg <-> leg.
{
  const sw = L.switches.find(s => L.edges[s.reverse].cls === 'ladder'), n = sw.node;
  const d = Math.sign(L.nodes[n].x - L.nodes[farOf(L, sw.trunk, n)].x); // the dir a train off the trunk runs in
  const legs = [sw.normal, sw.reverse], free = e => L.edges[e].oneWay === null || L.edges[e].oneWay === n;
  assert.deepEqual(forwardEdges(sim, n, d, sw.trunk).sort(), legs.filter(free).sort(), 'trunk -> legs');
  for (const leg of legs) {
    assert.deepEqual(forwardEdges(sim, n, -d, leg), [sw.trunk].filter(free), 'leg -> trunk');
    const other = legs.find(e => e !== leg);
    if (free(other)) assert.deepEqual(forwardEdges(sim, n, d, leg), [], 'leg -> leg refused');
  }
  assert.ok(legs.some(free) && L.switches.some(s => [s.normal, s.reverse].every(e => L.edges[e].oneWay === null)),
    'lebanon has a switch whose legs both run both ways (a main with a crossover)');
  const both = L.switches.find(s => [s.normal, s.reverse].every(e => L.edges[e].oneWay === null)), m = both.node;
  const dm = Math.sign(L.nodes[m].x - L.nodes[farOf(L, both.trunk, m)].x);
  assert.deepEqual(forwardEdges(sim, m, dm, both.normal), [], 'leg -> other leg refused, though the x rule allows it');
  assert.deepEqual(forwardEdges(sim, m, dm, both.reverse), []);
  assert.deepEqual(forwardEdges(sim, m, -dm, both.normal), [both.trunk]);
}

// signals face an edge: signalAhead(node, from) finds every signal, and is the old node:dir lookup
for (const seed of ['lebanon', 's0', 's7', 's42', 's47']) {
  const S = seed === 'lebanon' ? sim : createSim(generate(seed), seed), G = S.layout;
  const old = new Map(G.signals.map(s => [`${s.node}:${s.dir}`, s.id]));
  for (const s of G.signals) assert.equal(signalAhead(S, s.node, s.from), old.get(`${s.node}:${s.dir}`), `${seed}: signal ${s.id}`);
  assert.equal(S.signalAt.size, G.signals.length);
  for (const [k, id] of S.signalAt) assert.equal(k, `${G.signals[id].node}:${G.signals[id].from}`);
}

// reachability on the empty layout: every track of a dir is reachable from that dir's portal, the far end from the entry
// and from every track of the dir, so the menu admits everything it did before reachability. A junction's branch portal
// is an exit for either dir from both main portals and from every track before the wye (west of it eastbound, east of it
// westbound); entering there a dir train reaches the tracks beyond the wye for its dir and the far end, never the branch.
// A terminus has no branch portal; its stub (a dir 0 track) is reached from both main portals, and leads to the far end.
const ids = set => [...set].sort((a, b) => a - b);
for (const seed of ['lebanon', ...Array.from({ length: 30 }, (_, i) => `s${i}`)]) {
  const S = seed === 'lebanon' ? sim : createSim(generate(seed), seed), G = S.layout, w = G.wye;
  const br = G.portals.find(p => p.dir === 0), before = (t, d) => !!br && (d === E ? tx(G, t) < w.x0 : tx(G, t) > w.x1);
  assert.equal(!br, w?.kind !== 'junction', `${seed}: a branch portal iff a junction`);
  for (const d of [E, W]) {
    const p = portalOf(S, d), x = portalOf(S, -d), mine = G.tracks.filter(t => t.dir === d || t.stub).map(t => t.id);
    assert.deepEqual(ids(S.reach.tracks[`${p.id}:${d}`]), mine, `${seed} ${d}: tracks from the portal`);
    assert.deepEqual(ids(S.reach.exits[`p${p.id}:${d}`]), br ? [x.id, br.id] : [x.id], `${seed} ${d}: exits from the portal`);
    for (const t of mine) assert.deepEqual(ids(S.reach.exits[`t${t}:${d}`]), before(t, d) ? [x.id, br.id] : [x.id], `${seed} ${d}: exits from track ${t}`);
    assert.deepEqual(trafficMenu(S, d, p.id), trafficMenu(S, d), `${seed} ${d}: the portal of that dir by default`);
    assert.equal(S.reach.tracks[`${x.id}:${d}`].size, 0, `${seed} ${d}: nothing from the far portal against its dir`);
    if (!br) continue;
    assert.deepEqual(ids(S.reach.tracks[`${br.id}:${d}`]), mine.filter(t => (d === E ? tx(G, t) > w.x1 : tx(G, t) < w.x0)),
      `${seed} ${d}: tracks from the branch`);
    assert.deepEqual(ids(S.reach.exits[`p${br.id}:${d}`]), [x.id], `${seed} ${d}: exits from the branch`);
  }
}

// every signal has >= 1 candidate; candidates end at a node with a signal facing their last edge, or at an exit node.
// A junction's dir 0 signals (the stem's, the branch portal's) walk both dirs: each candidate carries the dir whose rule
// admitted it, 0 when both did (straight down the stem); along it x moves only that way, vertical stem edges are neutral.
for (const seed of ['lebanon', ...Array.from({ length: 50 }, (_, i) => `s${i}`)]) {
  const S = seed === 'lebanon' ? sim : createSim(generate(seed), seed), G = S.layout;
  const swAt = new Map(G.switches.map(s => [s.node, s])), facing = (n, e) => G.signals.find(s => s.node === n && s.from === e)?.id;
  for (const sig of G.signals) {
    const cs = S.routesFrom.get(sig.id);
    assert.ok(cs.length >= 1, `${seed}: signal ${sig.id} has no candidates`);
    // setRoute names a route by its exit node: over and back inside one crossover pair is dropped (it ends where the
    // straight route does), and of two ways through a junction gap to one exit (crossing at either pair) one is kept
    assert.equal(new Set(cs.map(c => c.exitNode)).size, cs.length, `${seed}: signal ${sig.id} has two candidates to one exit`);
    assert.ok(cs.every(c => c.edges.filter(e => G.edges[e].cls === 'crossover').length < 2), `${seed}: over and back in one pair`);
    for (const c of cs) {
      const ns = walk(G, sig.node, c.edges), last = G.edges[c.edges.at(-1)];
      assert.ok(sig.dir === 0 ? [E, W, 0].includes(c.dir) : c.dir === sig.dir, `${seed}: candidate dir ${c.dir} from a dir ${sig.dir} signal`);
      ns.slice(1).forEach((n, i) => { // vertical: a junction's stem or a terminus's stub
        const dx = Math.sign(G.nodes[n].x - G.nodes[ns[i]].x), ed = G.edges[c.edges[i]];
        assert.ok(dx === c.dir || (dx === 0 && (ed.cls === 'branch' || G.tracks[ed.track]?.stub)), `${seed}: candidate runs against dir`);
      });
      assert.ok(c.edges.every((e, i) => [null, ns[i]].includes(G.edges[e].oneWay)), `${seed}: candidate uses an edge against its oneWay`);
      assert.equal(c.exitNode, ns.at(-1));
      // a route carries its dir, the nodes it runs through and the edge its signal faces
      assert.deepEqual([c.nodes, c.from], [ns, sig.from], `${seed}: candidate nodes / from`);
      assert.equal(c.nodes.length, c.edges.length + 1);
      const exitSig = facing(c.exitNode, c.edges.at(-1)) ?? null;
      assert.equal(c.exitSignal, exitSig);
      // ... or at a buffer stop (a terminus's stub: a dead end that is no portal), from a shunt signal only (backing in)
      if (exitSig === null) assert.ok(c.dir !== 0 && (G.portals.some(p => exitNodesOf(S, p.id, c.dir).includes(c.exitNode))
        || (sig.kind === 'shunt' && S.adj.get(c.exitNode).length === 1 && G.tracks[G.wye?.stub]?.edges.includes(c.edges.at(-1)))),
        `${seed}: candidate ends at neither a signal nor an exit`);
      // a terminus's shunt signals end no route: walks run through the feet (spec "Shunt signals")
      assert.ok(c.edges.slice(0, -1).every((e, i) => [undefined, 'shunt'].includes(G.signals[facing(ns[i + 1], e)]?.kind)), `${seed}: candidate runs past a signal`);
      assert.ok(Math.abs(c.len - c.edges.reduce((s, e) => s + G.edges[e].len, 0)) < 1e-9);
      assert.equal(c.slow, SLOW.includes(last.cls) || !!G.tracks[last.track]?.stub, `${seed}: slow`); // into the stub: backing in
      assert.equal(c.diverging, c.switches.some(s => s.lie === 'reverse'));
      // every switch the candidate passes through is listed, with reverse iff it uses the reverse leg (and the one its
      // signal stands on: a terminus's shunt signals stand on the feet)
      assert.deepEqual(c.switches.map(s => s.node), ns.slice(0, -1).filter(n => swAt.has(n)), `${seed}: switch list`);
      for (const s of c.switches) assert.equal(s.lie, c.edges.includes(swAt.get(s.node).reverse) ? 'reverse' : 'normal');
    }
  }
}

// setRoute on the westbound entry portal signal to its first straight candidate -> ok
const straight = sig => sim.routesFrom.get(sig).find(c => !c.diverging && !c.slow);
const portalSig = entrySig(sim, W);
const c0 = straight(portalSig);
let r = setRoute(sim, portalSig, c0.exitNode);
assert.equal(r.ok, true);
const R0 = r.route;
// a route carries its dir and its sense in each section it touches (on a main section, its dir)
const sense0 = new Map(c0.edges.filter(e => L.edges[e].section !== null).map(e => [L.edges[e].section, W]));
assert.ok(sense0.size > 0);
assert.deepEqual(R0, { id: R0.id, signal: portalSig, cand: c0, dir: W, sense: sense0, trainId: null, human: false, entered: false,
  setAt: sim.time });
assert.equal(sim.routes.get(R0.id), R0);
assert.ok(c0.edges.every(e => sim.edgeState[e].route === R0.id));
assert.deepEqual(setRoute(sim, portalSig, pnode(sim, W)), { ok: false, reason: 'no such route' });
assert.deepEqual(setRoute(sim, portalSig, c0.exitNode), { ok: false, reason: 'already set' });

// a second setRoute over a shared edge -> {ok:false, reason:'locked'}. No other candidate can reach the
// portal's one-edge route, so the shared-edge pair is the next route on: the home signal's straight run
// through the first module, and a route from another westbound signal that merges into it (a track exit; an eastbound
// one on Main 1 shares edges too, but R0 makes it 'opposing').
const home = c0.exitSignal;
const c1 = straight(home);
r = setRoute(sim, home, c1.exitNode, { human: true });
assert.equal(r.ok, true);
const R1 = r.route;
assert.equal(R1.human, true);
assert.notEqual(R1.id, R0.id);
let other = null;
for (const [sig, cs] of sim.routesFrom) for (const c of cs)
  if (!other && sig !== home && L.signals[sig].dir === W && c.edges.some(e => c1.edges.includes(e))) other = { sig, c };
assert.ok(other, 'some route shares an edge with the home straight route');
assert.deepEqual(setRoute(sim, other.sig, other.c.exitNode), { ok: false, reason: 'locked' });

// throwSwitch on a switch inside a set route -> false; after cancel -> true and lie flips
const sw = c1.switches[0];
assert.ok(sw, 'home straight route passes a switch');
assert.equal(switchLocked(sim, sw.node), true);
assert.equal(throwSwitch(sim, sw.node), false);
assert.equal(sim.switchState.get(sw.node).lie, sw.lie);
assert.equal(cancelRoute(sim, R1.id), true);
assert.equal(cancelRoute(sim, R1.id), false, 'already gone');
assert.ok(!sim.routes.has(R1.id) && c1.edges.every(e => sim.edgeState[e].route === null));
assert.equal(switchLocked(sim, sw.node), false);
assert.equal(throwSwitch(sim, sw.node), true);
assert.notEqual(sim.switchState.get(sw.node).lie, sw.lie);

// trunk rule: a train standing on a leg is clear of the points, so the switch still throws;
// its trunk occupied (or routed, above) holds it
const swDef = L.switches.find(s => s.node === sw.node);
const leg = [swDef.normal, swDef.reverse].find(e => !c1.edges.includes(e));
sim.edgeState[leg].occ.add(98);
assert.equal(switchLocked(sim, sw.node), false, 'only a leg occupied');
assert.equal(throwSwitch(sim, sw.node), true);
assert.equal(throwSwitch(sim, sw.node), true); // back to the wrong lie, for the setRoute check below
sim.edgeState[leg].occ.delete(98);
sim.edgeState[swDef.trunk].occ.add(98);
assert.equal(switchLocked(sim, sw.node), true, 'trunk occupied');
assert.equal(throwSwitch(sim, sw.node), false);
sim.edgeState[swDef.trunk].occ.delete(98);
assert.notEqual(sim.switchState.get(sw.node).lie, sw.lie);

// 'switch busy' needs a route that meets a switch only on a leg, at the route's start. Generated layouts
// never build one (every route through a switch uses its trunk, so 'occupied'/'locked' fire first), so a
// hand-made wye: signal on the switch node 1, a train standing on the trunk 0-1, routes out to 2 or 3.
const Y = createSim({
  nodes: [[0, 0], [1, 0], [2, 0], [2, 1]].map(([x, y], id) => ({ id, x, y })),
  edges: [[0, 1, 'main'], [1, 2, 'main'], [1, 3, 'ladder']].map(([a, b, cls], id) => ({ id, a, b, cls, oneWay: a, len: 1, track: null })),
  switches: [{ node: 1, trunk: 0, normal: 1, reverse: 2 }],
  signals: [{ id: 0, node: 0, from: null, dir: E, kind: 'high' }, { id: 1, node: 1, from: 0, dir: E, kind: 'high' }],
  portals: [], tracks: [], cols: 3, mainRow: { 1: 0, '-1': 0 },
}, 'wye');
Y.edgeState[0].occ.add(1);
assert.deepEqual(setRoute(Y, 1, 3), { ok: false, reason: 'switch busy' });
assert.equal(setRoute(Y, 1, 2).ok, true, 'a switch already lying right is not busy');

// after cancelRoute the second setRoute succeeds, and sets its switches
r = setRoute(sim, other.sig, other.c.exitNode);
assert.equal(r.ok, true);
assert.ok(other.c.switches.every(s => sim.switchState.get(s.node).lie === s.lie));
assert.equal(cancelRoute(sim, r.route.id), true);

// setRoute throws a free switch back to the lie it needs; an entered route will not cancel
r = setRoute(sim, home, c1.exitNode);
assert.equal(r.ok, true);
assert.equal(sim.switchState.get(sw.node).lie, sw.lie);
r.route.entered = true;
assert.equal(cancelRoute(sim, r.route.id), false);
assert.ok(sim.routes.has(r.route.id));

// releaseEdge frees one edge at a time; the route is deleted with its last edge
const R3 = r.route;
for (const e of R3.cand.edges) {
  assert.ok(sim.routes.has(R3.id));
  releaseEdge(sim, e);
  assert.equal(sim.edgeState[e].route, null);
}
assert.ok(!sim.routes.has(R3.id));

// sectionalRelease: a train shape (Task 5 fields) whose tail has left the first edge only, then all of them
r = setRoute(sim, home, c1.exitNode, { trainId: 5 });
const R4 = r.route, [e0, e1] = c1.edges, lenOf = e => L.edges[e].len;
const fake = { id: 5, len: 1, path: [...c1.edges], pathStart: L.signals[home].node, pathOff: 0, headDist: lenOf(e0) + 0.5 };
for (const e of c1.edges) sim.edgeState[e].occ.add(5);
assert.deepEqual(setRoute(sim, other.sig, other.c.exitNode), { ok: false, reason: 'occupied' }, 'occupied is checked before locked');
sectionalRelease(sim, fake); // head past e0, tail still on it: nothing to release
assert.deepEqual(fake.path, c1.edges);
assert.equal(fake.pathOff, 0);
fake.headDist = lenOf(e0) + 1.5;
sectionalRelease(sim, fake);
assert.deepEqual(fake.path, c1.edges.slice(1));
assert.equal(fake.pathOff, lenOf(e0));
assert.equal(fake.pathStart, c1.nodes[1], 'the path start moves up with the released edge');
assert.ok(!sim.edgeState[e0].occ.has(5) && sim.edgeState[e0].route === null);
assert.ok(sim.edgeState[e1].occ.has(5) && sim.edgeState[e1].route === R4.id && sim.routes.has(R4.id));
fake.headDist = c1.len + fake.len;
sectionalRelease(sim, fake);
assert.deepEqual(fake.path, []);
assert.ok(Math.abs(fake.pathOff - c1.len) < 1e-9);
assert.equal(fake.pathStart, c1.exitNode);
assert.ok(!sim.routes.has(R4.id));
assert.equal(cancelRoute(sim, R0.id), true);
assert.ok(allClear(sim), 'everything released');

// findPath {exit: portal} from each entry portal returns edges with strictly increasing (decreasing) x, ending at an exit
for (const d of [E, W]) {
  const p = findPath(sim, pnode(sim, d), d, exitGoal(sim, d));
  assert.ok(p && p.length > 0);
  const pn = walk(L, pnode(sim, d), p);
  pn.slice(1).forEach((n, i) => assert.equal(Math.sign(L.nodes[n].x - L.nodes[pn[i]].x), d, 'x strictly monotonic'));
  assert.ok(exitsOf(sim, d).includes(pn.at(-1)));
}

// findPath to {track: id of first platform} ends inside that track's edges (at its first edge)
const plat = L.tracks.find(t => t.cls === 'platform');
const pp = findPath(sim, pnode(sim, plat.dir), plat.dir, { track: plat.id });
assert.ok(pp && plat.edges.includes(pp.at(-1)));
assert.equal(pp.at(-1), plat.edges[0]);
walk(L, pnode(sim, plat.dir), pp); // contiguous from the portal
assert.equal(findPath(sim, pnode(sim, -plat.dir), -plat.dir, { track: plat.id }), null, 'wrong-way platform unreachable');

// a manually occupied edge (edgeState[e].occ.add(99)) makes setRoute over it return reason 'occupied' and findPath avoid it
const busy = c1.edges.reduce((a, b) => (lenOf(b) > lenOf(a) ? b : a)); // the main through the first module
const from = pnode(sim, W), to = exitGoal(sim, W);
assert.ok(findPath(sim, from, W, to).includes(busy), 'shortest path takes the main');
assert.ok(!findPath(sim, from, W, to, { [busy]: 1000 }).includes(busy), 'penalty steers off it');
sim.edgeState[busy].occ.add(99);
assert.deepEqual(setRoute(sim, home, c1.exitNode), { ok: false, reason: 'occupied' });
const around = findPath(sim, from, W, to);
assert.ok(around && !around.includes(busy), 'findPath goes round the occupied edge');
sim.edgeState[busy].occ.delete(99);

// a route owned by train 7 is passable for train 7 only
r = setRoute(sim, home, c1.exitNode, { trainId: 7 });
assert.equal(r.ok, true);
assert.ok(findPath(sim, from, W, to, { trainId: 7 }).includes(busy));
const roundIt = findPath(sim, from, W, to);
assert.ok(roundIt && !roundIt.some(e => c1.edges.includes(e)) && roundIt.some(e => L.edges[e].cls === 'crossover'),
  'no way past a route held by someone else: round it on the other main');
assert.equal(cancelRoute(sim, r.route.id), true);
assert.ok(allClear(sim));

// wrongMainCost keeps a westbound off Main 2 while Main 1 is clear. The home signal's first edge occupied: a train
// stood PASS_WAIT there is passed on the other main (a crossover), one still moving is followed.
{
  const S = createSim(L, 'pass'), G = S.layout, cost = { standingCost: 60, blockedCost: 10, wrongMainCost: 3 };
  assert.ok(!findPath(S, from, W, to, { wrongMainCost: 3 }).some(e => G.edges[e].main === E), 'Main 1 clear: stays on it');
  const M = spawnTrain(S, { type: 'M', dir: W });
  S.edgeState[c1.edges[0]].occ.add(M.id); // one edge: costs are per edge, and the section now runs the module's length
  M.lastMoveTime = S.time - PASS_WAIT;
  assert.ok(findPath(S, from, W, to, cost).some(e => G.edges[e].cls === 'crossover'), 'round a standing train');
  M.lastMoveTime = S.time;
  assert.ok(!findPath(S, from, W, to, cost).some(e => G.edges[e].cls === 'crossover'), 'behind a moving one');
}

// one un-entered route per signal; an entered route still clearing behind its train does not block the next,
// whichever track the first train dwells on (trunk rule: its track edge is only a leg of the ladder switch).
// Every same-signal pair of routes into tracks, including lebanon's train dwelling on track 3 -> track 4.
const trackOf = c => L.edges[c.edges.at(-1)].track;
const pairs = [];
for (const [sig, cs] of sim.routesFrom) for (const A of cs) for (const B of cs)
  if (A !== B && trackOf(A) !== null && trackOf(B) !== null) pairs.push({ sig, A, B });
assert.ok(pairs.some(q => trackOf(q.A) === 3 && trackOf(q.B) === 4), 'lebanon: one signal routes into tracks 3 and 4');
for (const { sig: ps, A: cA, B: cB } of pairs) {
assert.equal(routeFrom(sim, ps), null);
r = setRoute(sim, ps, cA.exitNode, { trainId: 1 });
assert.equal(r.ok, true);
const RA = r.route;
assert.equal(routeFrom(sim, ps), RA);
assert.deepEqual(setRoute(sim, ps, cB.exitNode), { ok: false, reason: 'already set' }, 'un-entered route blocks a second');
RA.entered = true; // train 1 has gone in ...
assert.equal(routeFrom(sim, ps), null);
for (const e of cA.edges.slice(0, -1)) releaseEdge(sim, e); // ... and stands dwelling on the track's first edge
sim.edgeState[cA.edges.at(-1)].occ.add(1);
assert.ok(sim.routes.has(RA.id), 'the dwelling train still holds its last edge');
r = setRoute(sim, ps, cB.exitNode);
assert.equal(r.ok, true, `dwelling on track ${trackOf(cA)}, second train into track ${trackOf(cB)}: ${r.reason}`);
assert.equal(routeFrom(sim, ps), r.route);
assert.equal(cancelRoute(sim, r.route.id), true);
releaseEdge(sim, cA.edges.at(-1));
sim.edgeState[cA.edges.at(-1)].occ.delete(1);
assert.ok(allClear(sim));
}

// opposing: a westbound occupying an edge of a section refuses an eastbound route into that section, and vice versa
{ const S = createSim(L, 'opp'), G = S.layout;
  const sigE = G.signals.find(s => s.dir === E && G.nodes[s.node].y === G.mainRow[-1] && S.routesFrom.get(s.id).some(c => !c.diverging));
  const c = S.routesFrom.get(sigE.id).find(k => !k.diverging), sec = G.edges[c.edges[0]].section;
  const other = S.sectionEdges.get(sec).find(e => !c.edges.includes(e)) ?? c.edges.at(-1);
  const w = spawnTrain(S, { type: 'M', dir: W }); S.edgeState[other].occ.add(w.id);
  assert.equal(setRoute(S, sigE.id, c.exitNode).reason, 'opposing');
  S.edgeState[other].occ.clear();
  assert.equal(setRoute(S, sigE.id, c.exitNode).ok, true); }
// nose to nose: routes toward one boundary node from both sides; the second is refused
{ const S = createSim(L, 'nose'), G = S.layout, T = G.mainRow[-1];
  const node = G.signals.find(s => G.nodes[s.node].y === T && G.signals.filter(o => o.node === s.node).length === 2).node;
  const into = d => [...S.routesFrom].flatMap(([id, cs]) => cs.filter(c => c.exitNode === node && G.signals[id].dir === d).map(c => ({ id, c })))[0];
  const a = into(E), b = into(W), ra = setRoute(S, a.id, a.c.exitNode);
  assert.equal(ra.ok, true);
  assert.equal(setRoute(S, b.id, b.c.exitNode).reason, 'opposing');
  // traffic locking reads the route's sense per section (not its signal's dir): turned round, it no longer opposes
  for (const k of ra.route.sense.keys()) ra.route.sense.set(k, W);
  assert.equal(setRoute(S, b.id, b.c.exitNode).ok, true); }
// wrong main: only one train at a time; the train at the signal is exempt
{ const S = createSim(L, 'wm'), G = S.layout;
  const [sigA, sigB] = G.signals.filter(s => S.routesFrom.get(s.id).some(c => c.wrongMain));
  const cA = S.routesFrom.get(sigA.id).find(c => c.wrongMain), cB = S.routesFrom.get(sigB.id).find(c => c.wrongMain);
  const t = spawnTrain(S, { type: 'M', dir: sigA.dir }); t.path = [...cA.edges]; t.pathStart = sigA.node; // standing on the wrong main
  assert.equal(isWrongMain(S, t), true); assert.deepEqual(wrongMainTrains(S), [t]);
  assert.equal(setRoute(S, sigB.id, cB.exitNode).reason, 'wrong main');
  const next = signalAheadOf(S, t), cN = S.routesFrom.get(next).find(c => c.wrongMain);
  assert.equal(next, sigAt(S, cA.exitNode, t.dir));
  if (cN) assert.equal(setRoute(S, next, cN.exitNode, { trainId: t.id }).ok, true, 'the wrong-main train may continue'); }
// an untaken human wrong-main route counts as a wrong-main train: a wrong-main route at another signal is refused
{ const S = createSim(L, 'wmh'), G = S.layout;
  const [sigA, sigB] = G.signals.filter(s => S.routesFrom.get(s.id).some(c => c.wrongMain));
  const wm = sig => S.routesFrom.get(sig.id).find(c => c.wrongMain).exitNode;
  assert.equal(setRoute(S, sigA.id, wm(sigA), { human: true }).ok, true);
  assert.equal(setRoute(S, sigB.id, wm(sigB)).reason, 'wrong main'); }
// signalLabel unique over 50 seeds; the facing letter (from the edge it faces, or the portal's side) is E for eastbound,
// W for westbound, and for a wye's dir 0 signals: a junction's two (the stem's and the branch portal's) and a terminus's
// stub signal the way down or up the column toward the main, S on a north wye, N on a south one; a terminus's shunt
// signals the way in from their run (E at F1, W at F2), with an s suffix
for (let i = 0; i < 50; i++) {
  const S = createSim(generate(`lab${i}`), 'x'), ls = S.layout.signals.map(s => signalLabel(S, s.id)), wye = S.layout.wye;
  assert.equal(new Set(ls).size, ls.length, `lab${i}`);
  S.layout.signals.forEach((s, k) => assert.equal(ls[k][0], s.dir === E ? 'E' : s.dir === W ? 'W' : s.kind === 'shunt' ? (s.node === wye.F1 ? 'E' : 'W')
    : wye.side === 'north' ? 'S' : 'N', `lab${i}: ${ls[k]}`));
  S.layout.signals.forEach((s, k) => assert.equal(ls[k].at(-1) === 's', s.kind === 'shunt', `lab${i}: ${ls[k]} suffix`));
}

// A terminus (spec "The wye (geometry)"; the terminus mission is Task 7's): the sim loads every one in s0..s99. Its shunt
// signals light as dwarfs (one head) and read E/W column row s; the stub is reached from both main portals for their dir
// and leads on to the far end of either dir. Both main portals draw passenger trains for it (spec "The terminus mission"):
// a P at 6 x pax and an X at 3 x pax, like a platform, marked terminus.
for (const [a, top] of [[ASPECT.STOP, 'R'], [ASPECT.RESTRICTING, 'FR'], [ASPECT.SLOW_CLEAR, 'G']])
  assert.deepEqual(lamps(a, 'shunt', 1), { top }, `shunt lamps for ${a}`);
let termini = 0;
for (let i = 0; i < 100; i++) {
  const G = generate(`s${i}`), w = G.wye;
  if (w?.kind !== 'terminus') continue;
  const S = createSim(G, `s${i}`);
  termini++;
  for (const k of ['F1', 'F2']) {
    assert.match(signalLabel(S, w.shunt[k]), new RegExp(`^${k === 'F1' ? 'E' : 'W'}${G.nodes[w[k]].x}${String.fromCharCode(65 + G.nodes[w[k]].y)}s$`), `s${i}: ${k} shunt label`);
    assert.equal(signalHeads(S, w.shunt[k]), 1, `s${i}: ${k} shunt heads`);
  }
  for (const d of [E, W]) {
    assert.ok(S.reach.tracks[`${portalOf(S, d).id}:${d}`].has(w.stub), `s${i} ${d}: the stub from the portal`);
    assert.deepEqual(ids(S.reach.exits[`t${w.stub}:${d}`]), [portalOf(S, -d).id], `s${i} ${d}: the far end from the stub`);
    assert.deepEqual(trafficMenu(S, d).filter(m => m.dest === w.stub), [{ type: 'P', dest: w.stub, weight: 6, terminus: true },
      { type: 'X', dest: w.stub, weight: 3, terminus: true }], `s${i} ${d}: the stub on the menu`);
  }
}
assert.ok(termini >= 15, `${termini} terminus seeds in s0..s99`);

console.log('sim core ok');

// ---- Task 4: aspects
let L4;
for (let i = 0; i < 100 && !L4; i++) {
  const g = generate(`s${i}`);
  if (g.modules.some(m => m.kind === 'station') && g.modules.some(m => m.kind === 'yard')) L4 = g;
}
assert.ok(L4, 'a seed with station and yard');
const S4 = createSim(L4, 'asp');
const sigs = L4.signals;
const trk = c => L4.tracks[L4.edges[c.edges.at(-1)].track];
const plain = c => !c.diverging && !c.slow;
const A = id => { clearAspects(S4); return aspectOf(S4, id); };
const set = (sig, c) => { const r = setRoute(S4, sig, c.exitNode); assert.equal(r.ok, true, r.reason); return r.route; };
const undo = r => cancelRoute(S4, r.id);

for (const s of sigs) assert.equal(A(s.id), ASPECT.STOP, 'fresh sim: every signal STOP');

// the straight main chain, entry portal to exit portal: every signal CLEAR (the last one's next is the open exit,
// every other one's next is CLEAR). Drop the last route: its signal STOP, the one before APPROACH, the rest ADVANCE_APPROACH.
for (const dir of [E, W]) {
  const chain = [];
  for (let sig = entrySig(S4, dir); sig !== null;) {
    const c = S4.routesFrom.get(sig).find(plain);
    chain.push(set(sig, c));
    sig = c.exitSignal;
  }
  assert.ok(chain.length >= 3 && exitsOf(S4, dir).includes(chain.at(-1).cand.exitNode));
  assert.deepEqual(chain.map(r => A(r.signal)), chain.map(() => ASPECT.CLEAR), `${dir}: full chain`);
  const last = chain.pop();
  undo(last);
  assert.equal(A(last.signal), ASPECT.STOP);
  assert.deepEqual(chain.map(r => A(r.signal)), chain.map((_, i) => (i === chain.length - 1 ? ASPECT.APPROACH : ASPECT.ADVANCE_APPROACH)),
    `${dir}: chain to a STOP`);
  chain.forEach(undo);
}

// into a platform: DIVERGING_APPROACH; into yard/siding/spur: RESTRICTING
{
  let plat = 0, slow = 0;
  for (const s of sigs.filter(s => s.kind === 'high')) for (const c of S4.routesFrom.get(s.id)) {
    const t = trk(c);
    if (c.slow && SLOW.includes(t?.cls)) {
      const r = set(s.id, c); assert.equal(A(s.id), ASPECT.RESTRICTING); assert.equal(signalHeads(S4, s.id), 2); undo(r); slow++;
    } else if (c.diverging && t?.cls === 'platform') {
      const r = set(s.id, c); assert.equal(A(s.id), ASPECT.DIVERGING_APPROACH); undo(r); plat++;
    }
  }
  assert.ok(plat > 0 && slow > 0, 'platform and slow routes exercised');
}

// dwarf: next STOP -> RESTRICTING; onward main route set -> SLOW_CLEAR
{
  const d = sigs.find(s => s.kind === 'dwarf' && S4.routesFrom.get(s.id).some(c => !c.slow && c.exitSignal !== null && S4.routesFrom.get(c.exitSignal).some(plain)));
  assert.ok(d);
  assert.equal(signalHeads(S4, d.id), 1);
  const c = S4.routesFrom.get(d.id).find(c => !c.slow && c.exitSignal !== null && S4.routesFrom.get(c.exitSignal).some(plain));
  const r1 = set(d.id, c);
  assert.equal(A(d.id), ASPECT.RESTRICTING);
  const r2 = set(c.exitSignal, S4.routesFrom.get(c.exitSignal).find(plain));
  assert.equal(A(d.id), ASPECT.SLOW_CLEAR);
  undo(r2); undo(r1);
}

// chain A -> B -> C set, C's next STOP: C APPROACH, B and A ADVANCE_APPROACH
{
  let chain = null;
  for (const a of sigs) for (const ca of S4.routesFrom.get(a.id)) {
    if (chain || !plain(ca) || ca.exitSignal === null) continue;
    for (const cb of S4.routesFrom.get(ca.exitSignal)) {
      if (chain || !plain(cb) || cb.exitSignal === null) continue;
      for (const cc of S4.routesFrom.get(cb.exitSignal)) if (!chain && plain(cc) && cc.exitSignal !== null) chain = [[a.id, ca], [ca.exitSignal, cb], [cb.exitSignal, cc]];
    }
  }
  assert.ok(chain, 'three consecutive straight routes');
  const rs = chain.map(([s, c]) => set(s, c));
  assert.equal(A(chain[2][0]), ASPECT.APPROACH);
  assert.equal(A(chain[1][0]), ASPECT.ADVANCE_APPROACH);
  assert.equal(A(chain[0][0]), ASPECT.ADVANCE_APPROACH);
  rs.forEach(undo);
}
assert.ok(allClear(S4));

// lamps
assert.deepEqual(lamps(ASPECT.DIVERGING_CLEAR, 'high', 2), { top: 'R', bottom: 'G' });
assert.deepEqual(lamps(ASPECT.RESTRICTING, 'dwarf', 1), { top: 'FR' });
assert.deepEqual(lamps(ASPECT.ADVANCE_APPROACH, 'high', 1), { top: 'FY' });
assert.deepEqual(lamps(ASPECT.CLEAR, 'high', 2), { top: 'G', bottom: 'R' });
assert.deepEqual(lamps(ASPECT.APPROACH, 'high', 2), { top: 'Y', bottom: 'R' });
assert.deepEqual(lamps(ASPECT.ADVANCE_APPROACH, 'high', 2), { top: 'FY', bottom: 'R' });
assert.deepEqual(lamps(ASPECT.DIVERGING_APPROACH, 'high', 2), { top: 'R', bottom: 'Y' });
assert.deepEqual(lamps(ASPECT.RESTRICTING, 'high', 2), { top: 'R', bottom: 'FR' });
assert.deepEqual(lamps(ASPECT.STOP, 'high', 2), { top: 'R', bottom: 'R' });
assert.deepEqual(lamps(ASPECT.CLEAR, 'high', 1), { top: 'G' });
assert.deepEqual(lamps(ASPECT.APPROACH, 'high', 1), { top: 'Y' });
assert.deepEqual(lamps(ASPECT.STOP, 'high', 1), { top: 'R' });
assert.deepEqual(lamps(ASPECT.DIVERGING_CLEAR, 'high', 1), { top: 'R' });
assert.deepEqual(lamps(ASPECT.STOP, 'dwarf', 1), { top: 'R' });
assert.deepEqual(lamps(ASPECT.SLOW_CLEAR, 'dwarf', 1), { top: 'G' });
assert.deepEqual(lamps(ASPECT.CLEAR, 'dwarf', 1), { top: 'R' });
console.log('aspects ok');

// ---- Task 5: trains
{
const S = createSim(L, 'trains'), G = S.layout;
const tick = () => { moveTrains(S); S.time++; };
const straightOf = sig => S.routesFrom.get(sig).find(c => !c.diverging && !c.slow);
const lenOf = e => G.edges[e].len;

// constants, TYPES, train shape
assert.deepEqual([MPH, CAR, LOCO, FOUL], [1 / 180, 0.6, 0.8, 0.3]);
assert.deepEqual(Object.keys(TYPES), ['X', 'P', 'Z', 'M', 'C', 'G', 'I', 'L']);
assert.deepEqual(TYPES.X, { name: 'Express', prio: 5, cars: 8, max: 60, acc: 1.0, dec: 1.5, passenger: true });
assert.deepEqual(TYPES.L, { name: 'Local', prio: 0, cars: 6, max: 40, acc: 0.5, dec: 0.8 });
for (const t of Object.keys(TYPES)) assert.ok(close(trainLength(t), LOCO + TYPES[t].cars * CAR));
const X = spawnTrain(S, { type: 'X', dir: W, name: 'X 101' });
const exitW = exitNodes(S, X)[0];
assert.equal(S.trains.get(X.id), X);
assert.deepEqual(X, { id: X.id, name: 'X 101', type: 'X', dir: W, entry: 1, exit: 0, prio: 5, len: trainLength('X'),
  maxSpeed: 60 * MPH, path: [], pathStart: pnode(S, W), routes: [], pathOff: 0, headDist: 0, speed: 0, state: 'entering', dest: null,
  goal: { exit: 0 }, dwellUntil: 0, holdFor: null, spawnTime: S.time, sched: S.time, lastMoveTime: S.time, stops: 0, stalled: false,
  events: [], run: 0, locoAtTail: false, pushing: false, terminus: false, arrival: W, reversed1: false });
assert.equal(headNode(S, X), pnode(S, W));
assert.equal(signalAheadOf(S, X), entrySig(S, W), 'before its first route it reads the portal signal');
assert.deepEqual(trainBlocks(S, X), [], 'nothing on the board before its first route');

// set the straight route from the portal signal and every onward straight main route by hand
const routes = [];
for (let sig = entrySig(S, W); sig !== null;) {
  const cand = straightOf(sig), res = setRoute(S, sig, cand.exitNode, { trainId: X.id });
  assert.equal(res.ok, true, res.reason);
  routes.push(res.route);
  sig = cand.exitSignal;
}
assert.ok(routes.length >= 3);
assert.equal(routes.at(-1).cand.exitNode, exitW);
const home = routes[1], homeStart = routes[0].cand.len, homeEnd = homeStart + home.cand.len;
assert.notEqual(aspectOf(S, home.signal), ASPECT.STOP);

// occupancy is exactly the path edges overlapping (tail, head]; release is eager (path[0] still holds the tail)
const occupancyRule = T => {
  let s = T.pathOff;
  for (const e of T.path) {
    assert.equal(S.edgeState[e].occ.has(T.id), s <= T.headDist && s + lenOf(e) > T.headDist - T.len, `${T.name}: edge ${e}`);
    s += lenOf(e);
  }
  S.edgeState.forEach((st, e) => { if (st.occ.has(T.id)) assert.ok(T.path.includes(e), `${T.name} occupies ${e} off its path`); });
  if (T.path.length) assert.ok(T.pathOff + lenOf(T.path[0]) > T.headDist - T.len, 'tail left path[0] but it was not released');
};

let steps = 0, blocksChecked = false, homeCleared = false;
while (S.trains.has(X.id) && steps < 2 * 3600) {
  tick(); steps++;
  for (const st of S.edgeState) assert.ok(st.occ.size <= 1);
  assert.ok(X.speed <= 60 * MPH + 1e-9);
  if (steps === 1) {
    assert.deepEqual(X.path, routes.flatMap(r => r.cand.edges), 'adopted the whole chain');
    assert.ok(routes.every(r => r.trainId === X.id));
    assert.equal(headNode(S, X), exitW);
    const portal = G.nodes[pnode(S, W)];
    assert.deepEqual(pointAt(S, X, 0), { x: portal.x, y: portal.y });
    assert.equal(pointAt(S, X, -0.01), null);
    assert.equal(routes[0].entered, true, 'head on the portal edge');
    assert.equal(aspectOf(S, routes[0].signal), ASPECT.STOP);
  }
  if (!S.trains.has(X.id)) break;
  occupancyRule(X);
  // a train entering a route drops its entrance signal to STOP
  if (X.headDist >= homeStart) { assert.equal(home.entered, true); assert.equal(aspectOf(S, home.signal), ASPECT.STOP); }
  else { assert.equal(home.entered, false); assert.notEqual(aspectOf(S, home.signal), ASPECT.STOP); }
  // ... and once its tail has passed, the route is gone and its edges are free
  if (!homeCleared && X.headDist - X.len >= homeEnd) {
    assert.ok(!S.routes.has(home.id) && home.cand.edges.every(e => S.edgeState[e].route === null && S.edgeState[e].occ.size === 0));
    homeCleared = true;
  }
  if (!blocksChecked && X.state === 'running' && X.headDist - X.len > X.pathOff && X.headDist < pathLength(S, X)) {
    const b = trainBlocks(S, X), h = pointAt(S, X, X.headDist), t = pointAt(S, X, X.headDist - X.len);
    assert.equal(b.length, 1 + TYPES.X.cars);
    assert.deepEqual(b.map(k => k.kind), ['loco', ...Array(TYPES.X.cars).fill('car')]);
    assert.deepEqual([b[0].x1, b[0].y1], [h.x, h.y]);
    assert.ok(close(b.at(-1).x2, t.x) && close(b.at(-1).y2, t.y), 'last car ends at the tail');
    b.slice(1).forEach((k, i) => assert.ok(close(k.x1, b[i].x2) && close(k.y1, b[i].y2), 'blocks are contiguous'));
    // Main 1 is a straight westbound row: head end is west, block lengths are LOCO and CAR
    assert.ok(b.every(k => k.y1 === G.mainRow[W] && k.y2 === G.mainRow[W] && k.x1 < k.x2));
    b.forEach((k, i) => assert.ok(close(k.x2 - k.x1, i ? CAR : LOCO), `block ${i} length`));
    // lag draws the train that far behind its head (the renderer's between-step interpolation); adv is the last step's advance
    assert.ok(X.adv > 0 && close(trainBlocks(S, X, X.adv)[0].x1, pointAt(S, X, X.headDist - X.adv).x), 'lagged head sits adv behind');
    blocksChecked = true;
  }
}
assert.ok(blocksChecked && homeCleared);
assert.equal(X.state, 'done');
assert.ok(!S.trains.has(X.id));
assert.ok(steps >= 2 * 60 && steps <= 12 * 60, `X took ${steps} sim-seconds`);
assert.equal(X.stops, 0);
assert.ok(routes.every(r => !S.routes.has(r.id)));
assert.ok(allClear(S));

// a P with no routes set stands at the portal, stopped, and never passes the portal signal
const P = spawnTrain(S, { type: 'P', dir: E });
for (let i = 0; i < 600; i++) { tick(); assert.ok(P.headDist <= 0, 'past the portal signal'); }
assert.equal(P.state, 'stopped');
assert.ok(Math.abs(pathLength(S, P) - P.headDist) <= FOUL + 0.05);
assert.deepEqual([P.speed, P.stops, P.lastMoveTime], [0, 0, P.spawnTime]);
assert.ok(S.edgeState.every(st => st.occ.size === 0), 'not on the board yet');

// given only the portal route (no trainId: the train at the signal adopts it), it stops FOUL short of the home signal
const pSig = entrySig(S, E), pc = straightOf(pSig);
const pr = setRoute(S, pSig, pc.exitNode).route;
let movedAt = null; // sim.time of the last step the head advanced in; the arrival step (speed 0 after it) counts
for (let i = 0; i < 600; i++) {
  const t = S.time, h = P.headDist;
  tick();
  if (P.headDist > h) movedAt = t;
  assert.ok(P.headDist <= pathLength(S, P) - FOUL + 1e-9, 'past the stop point');
  occupancyRule(P);
}
assert.equal(P.lastMoveTime, movedAt);
assert.equal(pr.trainId, P.id);
assert.deepEqual(P.routes, [pr.id]);
assert.equal(P.state, 'stopped');
assert.ok(close(pathLength(S, P) - P.headDist, FOUL, 1e-6));
assert.deepEqual([P.speed, P.stops], [0, 1]);
assert.ok(P.lastMoveTime < S.time - 60);
assert.equal(headNode(S, P), pc.exitNode);
assert.equal(aspectOf(S, pSig), ASPECT.STOP);

// route changes clear the aspect memo; a route cancelled in front of the train (not yet entered) drops off
// its path and it stops short again
const hSig = pc.exitSignal, hc = straightOf(hSig);
assert.equal(aspectOf(S, hSig), ASPECT.STOP); // memoised
const hr = setRoute(S, hSig, hc.exitNode).route;
assert.notEqual(aspectOf(S, hSig), ASPECT.STOP, 'setRoute clears the memo');
tick();
assert.equal(hr.trainId, P.id);
assert.ok(P.path.length > hc.edges.length); // what is left of pc (the crossover pair's short edges release behind it), then hc
assert.deepEqual(P.path, [...pc.edges, ...hc.edges].slice(-P.path.length));
assert.ok(P.speed > 0 && !hr.entered);
assert.notEqual(aspectOf(S, hSig), ASPECT.STOP);
assert.equal(cancelRoute(S, hr.id), true);
assert.equal(aspectOf(S, hSig), ASPECT.STOP, 'cancelRoute clears the memo');
for (let i = 0; i < 120; i++) { tick(); assert.ok(P.headDist < pc.len, 'passed a cancelled route'); occupancyRule(P); }
assert.ok(P.path.length > 0);
assert.deepEqual(P.path, pc.edges.slice(-P.path.length));
assert.deepEqual([P.state, P.speed, P.stops], ['stopped', 0, 2]);
assert.ok(hc.edges.every(e => S.edgeState[e].route === null && S.edgeState[e].occ.size === 0));

// releaseEdge clears the memo too
const hr2 = setRoute(S, hSig, hc.exitNode, { trainId: 99 }).route;
assert.notEqual(aspectOf(S, hSig), ASPECT.STOP);
hc.edges.forEach(e => releaseEdge(S, e));
assert.ok(!S.routes.has(hr2.id));
assert.equal(aspectOf(S, hSig), ASPECT.STOP, 'releaseEdge clears the memo');

// despawnTrain releases everything the train holds
despawnTrain(S, P);
assert.equal(P.state, 'done');
assert.ok(!S.trains.has(P.id));
assert.ok(allClear(S));

// cancel an adopted home route and, before the next tick, set another from the same signal for the same train.
// Routes from one signal share their leading edge, so the path must be cut at the route boundary (the signal), not at
// the switch where they split; the train then adopts the new route, stops FOUL short of its red exit, and once the
// way on is set it runs out.
for (const dir of [W, E]) {
  const T = spawnTrain(S, { type: 'L', dir });
  const sig0 = entrySig(S, dir), c0 = straightOf(sig0), hs = c0.exitSignal;
  const R0 = setRoute(S, sig0, c0.exitNode).route, R = setRoute(S, hs, straightOf(hs).exitNode).route;
  tick();
  assert.deepEqual(T.routes, [R0.id, R.id]);
  assert.equal(R.trainId, T.id);
  assert.ok(!R.entered && T.path.includes(R.cand.edges.at(-1)));
  assert.equal(cancelRoute(S, R.id), true);
  const c2 = S.routesFrom.get(hs).find(c => c !== R.cand && c.edges[0] === R.cand.edges[0] && c.exitSignal !== null);
  assert.ok(c2, 'a second route from the home signal sharing its first edge');
  const R2 = setRoute(S, hs, c2.exitNode, { trainId: T.id }).route;
  tick();
  assert.deepEqual(T.path, [...c0.edges, ...c2.edges], `${dir}: cut at the home signal, all of R2 adopted`);
  assert.deepEqual(T.routes, [R0.id, R2.id]);
  for (let i = 0; i < 30 * 60 && !(T.state === 'stopped' && T.stops > 0); i++) { tick(); occupancyRule(T); }
  assert.equal(T.state, 'stopped', `${dir}: train stuck in ${T.state}`);
  assert.equal(headNode(S, T), c2.exitNode);
  assert.ok(close(pathLength(S, T) - T.headDist, FOUL, 1e-6), `${dir}: stopped FOUL short of R2's exit`);
  assert.deepEqual(T.path, c2.edges.slice(c2.edges.length - T.path.length), 'what is left of R2 (the rest released behind it)');
  for (let sig = c2.exitSignal; sig !== null;) { // the way on: any non-slow route from each signal to an exit
    const c = S.routesFrom.get(sig).find(k => !k.slow), res = setRoute(S, sig, c.exitNode);
    assert.equal(res.ok, true, res.reason);
    sig = c.exitSignal;
  }
  for (let i = 0; i < 30 * 60 && S.trains.has(T.id); i++) { tick(); occupancyRule(T); }
  assert.equal(T.state, 'done', `${dir}: ${T.state}`);
  assert.ok(allClear(S), `${dir}: everything released`);
}
}
console.log('trains ok');

// ---- Task 6: traffic + operator
{
const busySim = seed => { const S = createSim(generate(seed), seed, { density: 'busy' }); S.auto = true; return S; };
const xOf = (S, n) => S.layout.nodes[n].x;

// constants
assert.deepEqual(DENSITY, { light: 12 * 60, normal: 7 * 60, busy: 4 * 60 });
assert.deepEqual(DWELL, { P: 3 * 60, L: 15 * 60, industry: 25 * 60, terminus: 10 * 60 });

// fits: nothing is 99 cells long; a P fits every platform (generator floors)
{
  const S = createSim(L, 'fits');
  for (const t of L.tracks) assert.equal(fits(S, { len: 99 }, t.id), false);
  for (const t of L.tracks.filter(k => k.cls === 'platform')) assert.equal(fits(S, { len: trainLength('P') }, t.id), true);
}

// trafficMenu: X3 Z2 M3 always; P6 per platform, spur trainType 2 per spur, L2 per yard track of that dir
for (const seed of ['lebanon', 's7', 's42']) {
  const S = createSim(generate(seed), seed), G = S.layout;
  for (const dir of [E, W]) {
    const mine = G.tracks.filter(t => t.dir === dir);
    const want = [{ type: 'X', dest: null, weight: 3 }, { type: 'Z', dest: null, weight: 2 }, { type: 'M', dest: null, weight: 3 },
      ...mine.filter(t => t.cls === 'platform').map(t => ({ type: 'P', dest: t.id, weight: 6 })),
      ...mine.filter(t => t.cls === 'spur').map(t => ({ type: t.industry.trainType, dest: t.id, weight: 2 })),
      ...mine.filter(t => t.cls === 'yard').map(t => ({ type: 'L', dest: t.id, weight: 2 }))];
    const key = m => `${m.type}:${m.dest}:${m.weight}`;
    assert.deepEqual(trafficMenu(S, dir).map(key).sort(), want.map(key).sort(), `${seed} ${dir}: menu`);
    assert.deepEqual(holdingTracks(S, dir).sort(), mine.filter(t => t.cls === 'siding' || t.cls === 'yard').map(t => t.id).sort());
  }
}

// trackFree: routed, occupied and reserved tracks are not free, except to the train holding them
{
  const S = createSim(L, 'free');
  const sig = S.layout.signals.find(g => S.routesFrom.get(g.id).some(c => L.edges[c.edges.at(-1)].track !== null));
  const c = S.routesFrom.get(sig.id).find(k => L.edges[k.edges.at(-1)].track !== null), t = L.edges[c.edges.at(-1)].track;
  assert.equal(trackFree(S, t), true);
  const r = setRoute(S, sig.id, c.exitNode, { trainId: 7 }).route;
  assert.equal(trackFree(S, t), false);
  assert.equal(trackFree(S, t, 7), true);
  assert.equal(trackFree(S, t, 8), false);
  cancelRoute(S, r.id);
  S.edgeState[L.tracks[t].edges[1]].occ.add(9);
  assert.equal(trackFree(S, t), false);
  assert.equal(trackFree(S, t, 9), true);
  S.edgeState[L.tracks[t].edges[1]].occ.clear();
  S.reserved.set(t, 4);
  assert.equal(trackFree(S, t), false);
  assert.equal(trackFree(S, t, 4), true);
}

// findPath blockedCost (the operator's): blocked edges cost extra instead of being impassable, so a train ahead
// doesn't hide the way; a free way round is still preferred
{
  const S = createSim(L, 'soft');
  const from = pnode(S, W), to = exitGoal(S, W);
  const straightW = sig => S.routesFrom.get(sig).find(k => !k.diverging && !k.slow);
  const ps = entrySig(S, W), c0 = straightW(ps), c = straightW(c0.exitSignal);
  const main = c.edges.reduce((a, b) => (L.edges[b].len > L.edges[a].len ? b : a)); // the main through the module
  const plain = findPath(S, from, W, to);
  assert.deepEqual(findPath(S, from, W, to, { blockedCost: 1000 }), plain, 'nothing blocked: same path');
  const r = setRoute(S, ps, c0.exitNode, { trainId: 3 }).route; // over the portal edge: no way round it
  assert.equal(findPath(S, from, W, to), null);
  const soft = findPath(S, from, W, to, { blockedCost: 1000 });
  assert.ok(soft && soft.includes(c0.edges[0]), 'through a route held by train 3, at a cost');
  cancelRoute(S, r.id);
  S.edgeState[main].occ.add(9); // not a train on the board: standing
  const round = findPath(S, from, W, to, { blockedCost: 1000, standingCost: 1000 });
  assert.ok(round && !round.includes(main), 'a free way round beats an occupied edge');
  S.edgeState[main].occ.clear();
}

// despawnTrain: cancels an un-entered route still set for the train, drops its reservation, logs and records it
{
  const S = createSim(L, 'despawn');
  const T = spawnTrain(S, { type: 'M', dir: W, name: 'M 9' });
  T.sched = S.time + 125;
  const sig = entrySig(S, W), far1 = S.routesFrom.get(sig)[0].exitSignal;
  const stray = setRoute(S, far1, S.routesFrom.get(far1)[0].exitNode, { trainId: T.id }).route;
  S.reserved.set(L.tracks[0].id, T.id);
  S.time += 600;
  despawnTrain(S, T);
  assert.ok(!S.routes.has(stray.id) && allClear(S));
  assert.equal(S.reserved.size, 0);
  assert.deepEqual(S.completed, [{ name: 'M 9', type: 'M', from: portalOf(S, W).name, to: portalOf(S, E).name, delay: 475,
    spawnTime: T.spawnTime, exitTime: S.time, stops: 0, distance: 0, events: [{ t: S.time, kind: 'out' }] }]);
  assert.equal(S.log.at(-1).text, `M 9 out via ${L.portals.find(p => p.dir === E).name} (+8 min)`);
}

// a human route that takes a train past its destination: it gives up the call (and its reservation) and runs out
{
  const S = createSim(L, 'missed');
  S.auto = true;
  S.nextSpawn = [Infinity, Infinity]; // no traffic
  const plat = L.tracks.find(t => t.cls === 'platform' && t.dir === E);
  const home = L.signals.find(g => S.routesFrom.get(g.id).some(c => L.edges[c.edges.at(-1)].track === plat.id));
  const through = S.routesFrom.get(home.id).find(c => L.edges[c.edges.at(-1)].track === null);
  assert.equal(setRoute(S, home.id, through.exitNode, { human: true }).ok, true);
  const P = spawnTrain(S, { type: 'P', dir: E, dest: plat.id, name: 'P 2' });
  S.reserved.set(plat.id, P.id);
  for (let i = 0; i < 3600 && S.trains.has(P.id); i++) step(S);
  assert.equal(P.state, 'done');
  assert.ok(!P.path.length && S.log.some(e => e.text === `P 2 missed ${plat.name}`));
  assert.equal(S.reserved.size, 0);
  assert.ok(allClear(S));
}

// signalLabel and logEvent
{
  const S = createSim(L, 'label');
  const pw = entrySig(S, W), pe = entrySig(S, E);
  const row = y => String.fromCharCode(65 + y); // A = row 0
  assert.equal(signalLabel(S, pw), `W${L.cols - 1}${row(L.mainRow[W])}`);
  assert.equal(signalLabel(S, pe), `E0${row(L.mainRow[E])}`);
  const dw = L.signals.find(g => g.kind === 'dwarf');
  assert.equal(signalLabel(S, dw.id), `${dw.dir === 1 ? 'E' : 'W'}${L.nodes[dw.node].x}${row(L.nodes[dw.node].y)}d`);
  for (let i = 0; i < 250; i++) logEvent(S, `line ${i}`);
  assert.equal(S.log.length, 200);
  assert.deepEqual(S.log.at(-1), { t: S.time, text: 'line 249' });
  assert.equal(S.log[0].text, 'line 50');
}

// the portal queue admits its first eligible entry: a through train queued behind a freight whose spur (here: track)
// is not free enters first; the freight enters only once its track is free
{
  const S = createSim(generate('s42'), 's42'), G = S.layout;
  S.nextSpawn = [Infinity, Infinity]; // only the hand-made queue below
  const spur = G.tracks.find(t => t.cls === 'spur'), dir = spur.dir, q = S.queue[portalOf(S, dir).id];
  const entry = (type, dest, name) => ({ id: S.nextTrainId++, name, type, dir, entry: portalOf(S, dir).id, exit: portalOf(S, -dir).id, dest,
    len: trainLength(type), spawnTime: S.time, sched: S.time });
  const F = entry(spur.industry.trainType, spur.id, 'F 1'), X = entry('X', null, 'X 3');
  q.push(F, X);
  S.reserved.set(spur.id, 999); // a train still working the spur
  step(S);
  assert.ok(S.trains.has(X.id), 'the through train behind entered');
  assert.deepEqual(q, [F], 'the freight waits for its spur');
  for (let i = 0; i < 300; i++) { step(S); assert.ok(!S.trains.has(F.id), 'entered while its spur was not free'); }
  S.reserved.delete(spur.id);
  S.auto = true; // route the X on so the portal clears
  for (let i = 0; i < 1800 && !S.trains.has(F.id); i++) step(S);
  assert.ok(S.trains.has(F.id) && q.length === 0, 'the freight entered once its spur was free');
  assert.equal(S.reserved.get(spur.id), F.id);
}

// a human route lined from the entry portal signal before any train is there: the next train enters and adopts it
{
  const S = createSim(L, 'portal');
  S.nextSpawn = [S.time, Infinity]; // one eastbound draw now
  const sig = entrySig(S, E);
  const r = setRoute(S, sig, S.routesFrom.get(sig)[0].exitNode, { human: true }).route;
  step(S);
  assert.equal(S.trains.size, 1, 'a train entered past the human route on the portal edge');
  const T = [...S.trains.values()][0];
  step(S);
  assert.equal(r.trainId, T.id);
  assert.ok(T.routes.includes(r.id) && r.entered);
  // still refused while the portal edge is routed for another train
  const U = createSim(L, 'portal2');
  U.nextSpawn = [U.time, Infinity];
  setRoute(U, sig, U.routesFrom.get(sig)[0].exitNode, { trainId: 99 });
  step(U);
  assert.equal(U.trains.size, 0);
}

// overriding a hold by hand: the operator's un-entered hold route is cancelled and a human main route is set from
// the same signal; the train drops the hold, takes the main and runs out, and nothing stalls. The awaited train is
// a through X/Z (it never dwells or holds, and can't pass the holder now ahead of it on the main), so nothing but
// the override itself can end the hold.
{
  const S = busySim('s7'), G = S.layout;
  let T = null;
  for (let i = 0; i < 2 * 3600 && !T; i++) {
    step(S);
    for (const U of S.trains.values()) {
      const r = U.holdFor === null ? null : S.routes.get(U.routes.at(-1));
      const h = r && (S.trains.get(U.holdFor) ?? S.queue.flat().find(q => q.id === U.holdFor));
      if (!r || r.entered || !h || !['X', 'Z'].includes(h.type)) continue;
      const main = S.routesFrom.get(r.signal).find(c => G.edges[c.edges.at(-1)].track === null);
      assert.equal(cancelRoute(S, r.id), true);
      if (setRoute(S, r.signal, main.exitNode, { human: true }).ok) { T = U; break; }
      assert.equal(setRoute(S, r.signal, r.cand.exitNode, { trainId: U.id }).ok, true); // put the hold back; try later
    }
  }
  assert.ok(T, 'the operator set a hold route');
  for (let i = 0; i < 60 * 60 && S.trains.has(T.id); i++) {
    step(S);
    for (const U of S.trains.values()) assert.ok(!U.stalled && (U.state === 'dwelling' || U.state === 'holding' || S.time - U.lastMoveTime <= 30 * 60), `${U.name} stalled`);
  }
  assert.equal(T.holdFor, null);
  assert.ok(!S.trains.has(T.id) && S.completed.some(c => c.name === T.name), `${T.name} still on the board (${T.state})`);
  assert.ok(!S.log.some(e => e.text.startsWith('STALL')));
}

// step: one sim second; the first spawn of each direction is due at 06:00 and the head enters at once
{
  const S = busySim('lebanon'), G = S.layout;
  step(S);
  assert.equal(S.time, 6 * 3600 + 1);
  assert.equal(S.trains.size, 2, 'one train in from each portal');
  const names = [...S.trains.values()].map(t => [t.dir, Number(t.name.split(' ')[1])]);
  for (const [dir, n] of names) {
    assert.equal(n % 2, dir === E ? 0 : 1, 'even eastbound, odd westbound');
    assert.ok(n >= 100 && n <= 400);
  }
  for (const t of S.trains.values()) assert.ok(S.log.some(e => e.text === `${t.name} entered from ${G.portals[t.entry].name}`));
}

// STALL: logged in AUTO only, once per stand; moving re-arms it. M 6 stands at signals whose routes are set for a
// train that isn't there (99), so neither it nor the operator can take them.
{
  const S = createSim(L, 'stall');
  S.nextSpawn = [Infinity, Infinity]; // no traffic
  spawnTrain(S, { type: 'M', dir: E, name: 'M 6' });
  const ps = entrySig(S, E);
  const block = sig => setRoute(S, sig, S.routesFrom.get(sig)[0].exitNode, { trainId: 99 }).route;
  const stalls = () => S.log.filter(e => e.text === 'STALL M 6').length, r = block(ps);
  for (let i = 0; i < 40 * 60; i++) step(S);
  assert.equal(stalls(), 0, 'STALL logged in MANUAL');
  S.auto = true;
  step(S);
  assert.equal(stalls(), 1, 'stood 40 min in AUTO, not logged');
  for (const c of S.routesFrom.get(ps)) block(c.exitSignal); // both ways on: up the home main, or over the crossovers
  cancelRoute(S, r.id); // the operator routes M 6 up to one of them, where it stands again
  for (let i = 0; i < 40 * 60; i++) step(S);
  assert.equal(stalls(), 2, 'a second stand, after moving, not logged');
}

// a portal that can't take a train keeps at most 8 waiting per direction: draws past that are dropped
{
  const S = busySim('lebanon');
  for (const dir of [E, W]) {
    const sig = entrySig(S, dir);
    setRoute(S, sig, S.routesFrom.get(sig)[0].exitNode, { trainId: 99 }); // the portal edge is routed for another train
  }
  for (let i = 0; i < 3 * 3600; i++) step(S);
  assert.equal(S.trains.size, 0);
  assert.deepEqual(S.queue.map(q => q.length), [8, 8]);
  // a queue entry carries its dir and its portals: in at that portal, out at the far end
  for (const d of [E, W]) assert.ok(S.queue[portalOf(S, d).id].every(q => q.dir === d && q.entry === portalOf(S, d).id
    && q.exit === portalOf(S, -d).id), `queue entries of ${d}`);
}

// Lighting cycle: day, dusk midpoint, night, dawn midpoint; off when dayLength is 0
const T0 = 6 * 3600, P = 2400;
assert.deepEqual([0, 0.2, 0.45, 0.5, 0.7, 0.95].map(f => +nightLevel(T0 + f * P, P).toFixed(2)), [0, 0, 0.5, 1, 1, 0.5]);
assert.equal(nightLevel(T0 + 0.6 * P, 0), 0);
assert.ok(nightLevel(T0 + 0.42 * P, P) > 0 && nightLevel(T0 + 0.42 * P, P) < 0.5, 'dusk ramps');

// Traffic mix: at full night passenger weights are 30 % of day, freight 170 %, locals unchanged
{
  const A = createSim(L, 'lebanon'), B = createSim(L, 'lebanon');
  B.time = T0 + 0.6 * B.dayLength; // night
  const w = (S, pred) => trafficMenu(S, E).filter(pred).reduce((s, m) => s + m.weight, 0);
  const pax = m => m.type === 'X' || m.type === 'P', frt = m => ['Z', 'M', 'C', 'G', 'I'].includes(m.type), loc = m => m.type === 'L';
  assert.ok(close(w(B, pax), 0.3 * w(A, pax)) && close(w(B, frt), 1.7 * w(A, frt)) && w(B, loc) === w(A, loc));
}

// Slow orders: appear, apply, lift, log; only on main sections; separate rng stream; off lets one run out
{
  const S1 = createSim(L, 's7'), S2 = createSim(L, 's7', { slowOrders: false }); // normal density: queues never fill, so both draw the same entries
  S1.auto = S2.auto = true; // in MANUAL nothing leaves the portal and the queues do fill
  let seen = null;
  for (let i = 0; i < 4 * SLOW_ORDER.gap && !seen; i++) { step(S1); if (S1.slowOrder) seen = { ...S1.slowOrder }; }
  assert.ok(seen, 'a slow order appears within 4 mean gaps');
  assert.ok(S1.sectionEdges.has(seen.section), 'on a main section');
  assert.ok(S1.sectionEdges.get(seen.section).reduce((s, e) => s + L.edges[e].len, 0) >= SLOW_ORDER.minLen, 'on a section minLen long');
  const inSec = S1.sectionEdges.get(seen.section);
  assert.ok(inSec.every(e => edgeSpeed(S1, L.edges[e]) === SLOW_ORDER.mph));
  assert.ok(L.edges.filter(e => e.section !== seen.section).every(e => edgeSpeed(S1, e) === e.speed));
  assert.ok(S1.log.some(l => l.text.startsWith(`Slow order: ${slowOrderLabel(S1)}, 20 mph until `)));
  S1.slowOrders = false; // turned off mid-order: it runs out on schedule
  while (S1.time <= seen.until) step(S1);
  assert.equal(S1.slowOrder, null);
  assert.ok(S1.log.some(l => l.text === `Slow order lifted: Main ${seen.main} ${seen.x0}–${seen.x1}`));
  for (let i = 0; i < 4 * SLOW_ORDER.gap; i++) step(S2);
  assert.equal(S2.slowOrder, null, 'none when off');
  while (S1.time < S2.time) step(S1); // compared at one sim time: S1 stopped when its order lifted
  while (S2.time < S1.time) step(S2);
  const num = name => Number(name.split(' ')[1]); // train number: unique, in the order the spawner named them
  const names = S => [...S.queue.flat(), ...S.trains.values(), ...S.completed].map(t => t.name).sort((a, b) => num(a) - num(b));
  assert.ok(names(S1).length >= 20);
  assert.deepEqual(names(S1), names(S2), 'traffic unchanged by slow orders');
}
// ... and never on a junction's branch section (legs and stem: a section but no main), though it is minLen long; the
// label names the main the order is on. s1: south wye, s3: north.
for (const seed of ['s1', 's3']) {
  const G = generate(seed), S = createSim(G, seed), branch = G.edges.find(e => e.cls === 'branch').section, seen = [];
  assert.ok(S.sectionEdges.get(branch).reduce((s, e) => s + G.edges[e].len, 0) >= SLOW_ORDER.minLen, `${seed}: branch section minLen long`);
  for (let i = 0; i < 4 * SLOW_ORDER.gap; i++) { step(S); if (S.slowOrder && S.slowOrder !== seen.at(-1)) seen.push(S.slowOrder); }
  assert.ok(seen.length, `${seed}: a slow order within 4 mean gaps`);
  for (const o of seen) {
    const es = S.sectionEdges.get(o.section).map(e => G.edges[e]);
    assert.ok(es.every(e => e.main != null), `${seed}: slow order on section ${o.section}, not a main section`);
    assert.equal(o.main, es[0].main === -1 ? 1 : 2, `${seed}: slow order labelled Main ${o.main}`);
  }
}

// A slow order set under a train at speed brakes it at its own rate, never in one step, down to 20 mph on the section
{
  const S = createSim(L, 'lebanon', { slowOrders: false });
  S.auto = true;
  const head = T => { let s = T.pathOff; return L.edges[T.path.find(e => (s += L.edges[e].len) >= T.headDist)]; }; // head's edge
  const ahead = T => { // cells of the head's section still ahead of the head
    const xs = S.sectionEdges.get(head(T).section).flatMap(e => [L.nodes[L.edges[e].a].x, L.nodes[L.edges[e].b].x]);
    const hx = pointAt(S, T, T.headDist).x;
    return T.dir > 0 ? Math.max(...xs) - hx : hx - Math.min(...xs);
  };
  let t = null;
  for (let i = 0; i < 3600 && !t; i++) {
    step(S);
    t = [...S.trains.values()].find(T => T.speed > 50 * MPH && head(T)?.section != null && ahead(T) >= 15) ?? null;
  }
  assert.ok(t, 'no train at speed on a long main section');
  S.slowOrder = { section: head(t).section, until: S.time + 3600 };
  const on = () => S.trains.has(t.id) && head(t)?.section === S.slowOrder.section, v = t.speed;
  step(S);
  assert.ok(v - t.speed <= TYPES[t.type].dec * MPH + 1e-9, `${t.name} snapped from ${v / MPH} to ${t.speed / MPH} mph`);
  for (let i = 0; i < 120 && on() && t.speed > SLOW_ORDER.mph * MPH + 1e-9; i++) step(S);
  assert.ok(on() && t.speed <= SLOW_ORDER.mph * MPH + 1e-9, `${t.name} not down to 20 mph on the section`);
}

// Operator: named at boot, changes at 14:00 with a new name, logged
{
  const S = createSim(L, 'lebanon');
  assert.match(S.operator, /^[A-Z]\. [A-Z][a-z]+$/);
  assert.ok(OPERATORS.includes(S.operator.slice(3)));
  assert.equal(S.log[0]?.text, `${S.operator} on duty`);
  const first = S.operator;
  while (S.time < 14 * 3600 + 5) step(S);
  assert.notEqual(S.operator, first);
  assert.ok(S.log.some(l => l.text === `Shift change: ${S.operator} takes the desk`));
}

// soak: 8 sim-hours busy over the brief's three seeds plus s47 (a local stood 45 min at a merge there before the
// operator served long-standing trains first) and two junctions (sN north, sS south); never two trains on one edge,
// never a stall, and the spawn gate (a queued train with a destination enters only while that track is free, and
// reserves it). At a junction also: one sense at a time on the branch, wrong-main running inside the gap exempt and
// never standing there, trains to and from the branch. Two termini (tN north, tS south) with the same, plus: every
// train's path chains from its pathStart; at every reversal no other train, and no route not its own, on any section the
// reversing train stands in, nor (pulled ahead at P) on the feet main's junction edges; terminus trains in and out
// within the hour, by the portal they came in by.
const snap = S => JSON.stringify({ time: S.time, trains: [...S.trains.values()].map(t => [t.id, t.headDist, t.speed, t.state]), completed: S.completed });
const held = new Set(); // trains seen holding for an overtake, over all the seeds
let sawWrongMain = false;
for (const seed of ['lebanon', 's7', 's42', 's47', sN, sS, tN, tS]) {
  const S = busySim(seed), G = S.layout, dwelt = new Map(), w = G.wye, br = G.portals.find(p => p.dir === 0);
  const branchSec = w ? G.edges.find(e => e.cls === 'wye').section : null, rows = [G.mainRow[E], G.mainRow[W]];
  const feet = w?.kind === 'terminus' ? termOf(S).feet : [], loco = new Map(); // train id -> locoAtTail after the last step
  let entered = 0, wrongTicks = 0, exemptTicks = 0, reversals = 0, visiting = false, wmWas = new Set();
  for (let i = 0; i < 8 * 3600; i++) {
    // every train new after the step (queued earlier or drawn this very tick) is checked against the tracks before it
    const free = G.tracks.map(t => trackFree(S, t.id)), before = new Set(S.trains.keys());
    step(S);
    assert.ok(S.queue.flat().filter(k => k.terminus).length <= 1, `${seed}: two terminus trains queued`);
    // a terminus train on its visit to the gap is the one wrong-main move: no train goes wrong main meanwhile
    if (w?.kind === 'terminus') {
      const wmNow = new Set(wrongMainTrains(S).map(T => T.id));
      if (visiting) assert.ok([...wmNow].every(id => wmWas.has(id)), `${seed}: sent wrong main during a terminus train's visit`);
      visiting = [...S.trains.values()].some(T => T.terminus && T.path.some(e => G.edges[e].junction || G.edges[e].section === branchSec));
      wmWas = wmNow;
    }
    for (const T of S.trains.values()) {
      let n = T.pathStart;
      for (const e of T.path) { assert.ok(G.edges[e].a === n || G.edges[e].b === n, `${seed}: ${T.name}'s path is not chained from pathStart`); n = farOf(G, e, n); }
      // its tail is on its path (behind it only while it is still coming in at its portal): a reversal never jumps it
      const coming = T.run === 0 && T.pathOff === 0 && T.pathStart === G.portals[T.entry].node;
      assert.ok(coming || T.headDist - T.len >= T.pathOff - 1e-9, `${seed}: ${T.name}'s tail is off its path`);
      if (!T.terminus) continue;
      const since = S.time - T.events.find(e => e.kind === 'entered').t;
      assert.ok(since <= 3600, `${seed}: terminus ${T.name} in for ${since} s`);
      if (loco.has(T.id) && loco.get(T.id) !== T.locoAtTail) { // it reversed this step (missions runs last)
        reversals++;
        const mine = new Set(T.path.filter(e => S.edgeState[e].occ.has(T.id)).map(e => G.edges[e].section));
        const other = e => [...S.edgeState[e].occ].some(id => id !== T.id)
          || (S.edgeState[e].route !== null && S.routes.get(S.edgeState[e].route).trainId !== T.id);
        for (const [sec, es] of S.sectionEdges) if (mine.has(sec)) assert.ok(!es.some(other), `${seed}: ${T.name} reversed with another train in section ${sec}`);
        if (T.locoAtTail) assert.ok(!feet.some(other), `${seed}: ${T.name} reversed at P with another train on the feet main's junction edges`);
      }
      loco.set(T.id, T.locoAtTail);
    }
    for (const T of S.trains.values()) {
      if (before.has(T.id)) continue;
      entered++;
      if (T.dest === null) continue;
      assert.ok(free[T.dest], `${seed}: ${T.name} entered while ${G.tracks[T.dest].name} was not free`);
      assert.equal(S.reserved.get(T.dest), T.id);
      assert.ok(trackFree(S, T.dest, T.id));
    }
    S.edgeState.forEach((st, e) => {
      assert.ok(st.occ.size <= 1, `${seed}: two trains on one edge`);
      // an occupied edge is unrouted (released behind its train, or never routed) or routed for its occupant
      if (st.occ.size === 1 && st.route !== null) assert.equal(S.routes.get(st.route).trainId, [...st.occ][0], `${seed}: edge ${e} routed for another train`);
    });
    assert.ok(S.queue.every(q => q.length <= 8), `${seed}: queue ${S.queue.map(q => q.length).join(' / ')}`);
    // traffic locking: no main section holds trains of both directions; one wrong-main train at a time
    for (const [sec, es] of S.sectionEdges) {
      if (sec === branchSec) continue; // below
      const dirs = new Set(es.flatMap(e => [...S.edgeState[e].occ].map(id => S.trains.get(id)?.dir)));
      dirs.delete(undefined);
      assert.ok(dirs.size <= 1, `${seed}: opposing trains in section ${sec}`);
    }
    assert.ok(S.slowOrder === null || S.sectionEdges.get(S.slowOrder.section).every(e => G.edges[e].main != null), `${seed}: slow order off the mains`);
    const wrong = wrongMainTrains(S).length;
    assert.ok(wrong <= 1, `${seed}: two wrong-main trains`);
    if (wrong) { wrongTicks++; sawWrongMain = true; }
    if (w) {
      // the branch carries one sense at a time (inbound toward the main, or outbound), over the trains on it (their
      // sense from their paths) and the routes locking it
      const senses = new Set();
      for (const e of S.sectionEdges.get(branchSec)) {
        for (const id of S.edgeState[e].occ) senses.add(branchSense(S, S.trains.get(id), e));
        if (S.edgeState[e].route !== null) senses.add(S.routes.get(S.edgeState[e].route).sense.get(branchSec));
      }
      assert.ok([...senses].every(v => v === 1 || v === -1) && senses.size <= 1, `${seed}: senses ${[...senses]} on the branch`);
      // wrong-main running that does not count (exempt) is on junction edges only, and a train on one holds its way out
      // of the gap: its path ends at a signal outside it (or the branch portal), never on a main inside it
      for (const T of S.trains.values()) {
        const on = T.path.filter(e => S.edgeState[e].occ.has(T.id) && G.edges[e].main === -T.dir);
        if (!on.length) continue;
        if (!isWrongMain(S, T)) { assert.ok(on.every(e => G.edges[e].junction), `${seed}: ${T.name} exempt off the junction`); exemptTicks++; }
        const h = G.nodes[headNode(S, T)];
        // (at a junction; a terminus's gap has stands inside it, its P columns, where the one wrong-main train may stand)
        if (on.some(e => G.edges[e].junction) && w.kind === 'junction') assert.ok(!(h.x > w.x0 && h.x < w.x1 && rows.includes(h.y)), `${seed}: ${T.name} routed to a stand inside the gap`);
      }
    }
    for (const T of S.trains.values()) {
      if (T.state === 'dwelling') dwelt.set(T.name, G.tracks[T.dest].cls);
      else if (T.state === 'holding') {
        held.add(`${seed} ${T.name}`);
        assert.ok(T.dest === null && T.prio <= 2 && T.holdFor !== null, `${seed}: ${T.name} may not hold`);
        assert.ok(holdingTracks(S, T.dir).includes(G.edges[T.path.at(-1)].track));
      } else assert.ok(S.time - T.lastMoveTime <= 30 * 60, `${seed}: ${T.name} stalled (${T.state})`);
    }
  }
  assert.ok(entered > 0);
  assert.ok(wrongTicks / (8 * 3600) <= 0.30, `${seed}: a wrong-main train on the panel ${(wrongTicks / 288).toFixed(1)} % of ticks`);
  assert.ok(S.completed.length >= 20, `${seed}: only ${S.completed.length} trains completed`);
  assert.ok(!S.log.some(e => e.text.startsWith('STALL')));
  if (G.tracks.some(t => t.cls === 'platform')) assert.ok(S.completed.some(c => dwelt.get(c.name) === 'platform'), `${seed}: no P called`);
  if (G.tracks.some(t => t.cls === 'yard')) assert.ok(S.completed.some(c => ['yard', 'spur'].includes(dwelt.get(c.name))), `${seed}: no freight served the yard`);
  for (const c of S.completed) {
    assert.deepEqual(Object.keys(c).sort(), ['delay', 'distance', 'events', 'exitTime', 'from', 'name', 'spawnTime', 'stops', 'to', 'type']);
    // in at its dir's portal or the branch, out at the far end or the branch, never in and out by the branch; a terminus
    // train (it reversed) in and out by its dir's portal, within the hour
    const d = Number(c.name.split(' ')[1]) % 2 ? W : E, term = c.events.some(e => e.kind === 'reversing');
    if (term) assert.ok(c.from === portalOf(S, d).name && c.to === c.from && c.exitTime - c.events[1].t <= 3600, `${seed}: terminus ${c.name} from ${c.from} to ${c.to}`);
    else assert.ok([portalOf(S, d).name, br?.name].includes(c.from) && [portalOf(S, -d).name, br?.name].includes(c.to) && c.from !== c.to,
      `${seed}: ${c.name} from ${c.from} to ${c.to}`);
    assert.ok(c.exitTime > c.spawnTime && c.distance > 0);
    // the per-train log (spec "Delay"): queued at spawnTime, entered, ..., out at exitTime, in time order
    assert.deepEqual([c.events[0], c.events[1].kind, c.events.at(-1)], [{ t: c.spawnTime, kind: 'queued' }, 'entered', { t: c.exitTime, kind: 'out' }]);
    assert.ok(c.events.every((e, i) => !i || e.t >= c.events[i - 1].t), `${seed}: ${c.name} events out of time order`);
  }
  // a P that called at a platform: a route in, arrived, departed, a route on
  if (G.tracks.some(t => t.cls === 'platform')) {
    const P = S.completed.find(c => c.type === 'P' && dwelt.get(c.name) === 'platform'), kinds = P.events.map(e => e.kind);
    const at = k => kinds.indexOf(k), arrived = P.events[at('arrived')];
    assert.ok(at('entered') < at('route') && at('route') < at('arrived') && at('arrived') < at('departed')
      && at('departed') < kinds.lastIndexOf('route'), `${seed}: ${P.name} events ${kinds}`);
    assert.ok(G.tracks.some(t => t.cls === 'platform' && t.name === arrived.track), `${seed}: arrived at ${arrived.track}`);
    assert.ok(P.events.filter(e => e.kind === 'route').every(e => /^[EWNS]\d+[A-Z][ds]?$/.test(e.signal)));
  }
  if (w?.kind === 'terminus') {
    const done = S.completed.filter(c => c.events.some(e => e.kind === 'reversing'));
    assert.ok(done.length >= 5 && reversals >= 2 * done.length, `${seed}: ${done.length} terminus trains, ${reversals} reversals`);
  }
  if (br) {
    const arrivals = S.completed.filter(c => c.from === br.name).length, departures = S.completed.filter(c => c.to === br.name).length;
    assert.ok(arrivals >= 5 && departures >= 5, `${seed}: ${arrivals} trains in from the branch, ${departures} out by it`);
    assert.ok(exemptTicks > 0, `${seed}: no exempt wrong-main running at the junction`);
  }
}
assert.ok(held.size > 0, 'the overtake rule never held a train');
assert.ok(sawWrongMain, 'no wrong-main run in 32 busy hours: the feature is dormant');

// determinism: same seed, same day
{
  const [A, B] = [busySim('s7'), busySim('s7')];
  for (let i = 0; i < 3600; i++) { step(A); step(B); }
  assert.ok(A.completed.length > 0);
  assert.equal(snap(A), snap(B));
  const C = busySim('s42');
  for (let i = 0; i < 3600; i++) step(C);
  assert.notEqual(snap(A), snap(C));
}

// run fixture (tools/freeze-run.mjs, frozen from the sim before travel moved onto the path): s42 busy in AUTO for two
// hours logs the same last 200 lines and completes the same trains, in order, with the same delays
{
  const fx = JSON.parse(readFileSync(new URL('./fixtures/run-s42.json', import.meta.url), 'utf8'));
  const S = busySim('s42');
  for (let i = 0; i < 7200; i++) step(S);
  assert.deepEqual(S.log.map(e => e.text), fx.log, 'run fixture: log');
  assert.deepEqual(S.completed.map(c => [c.name, c.delay]), fx.completed, 'run fixture: completed');
}

// human override: an express on the main approaching a module with a holding track on its side is sent into it by
// hand (the operator's un-entered route from that signal cancelled first); it takes the human route and still leaves
{
  const S = createSim(generate('override'), 'override'), G = S.layout;
  S.auto = true;
  let X = null, track = null;
  for (let i = 0; i < 4 * 3600 && !track; i++) {
    step(S);
    for (const T of S.trains.values()) {
      if (T.type !== 'X' || T.state !== 'running' || !T.path.length) continue;
      const hx = pointAt(S, T, T.headDist).x;
      for (const sig of G.signals.filter(g => g.dir === T.dir)) {
        const ahead = (xOf(S, sig.node) - hx) * T.dir;
        if (ahead < 8 || ahead > 30) continue;
        const hc = S.routesFrom.get(sig.id).find(c => {
          const t = G.edges[c.edges.at(-1)].track;
          return t !== null && holdingTracks(S, T.dir).includes(t) && fits(S, T, t) && trackFree(S, t);
        });
        if (!hc) continue;
        const r = routeFrom(S, sig.id);
        if (r?.human) continue;
        if (r) assert.equal(cancelRoute(S, r.id), true);
        if (!setRoute(S, sig.id, hc.exitNode, { human: true }).ok) continue; // the operator re-sets next tick; try later
        X = T; track = G.edges[hc.edges.at(-1)].track;
        break;
      }
      if (track !== null) break;
    }
  }
  assert.ok(X, 'an express approached a module with a free holding track');
  const t0 = S.time, first = G.tracks[track].edges[0];
  let adopted = false;
  while (S.trains.has(X.id) && S.time - t0 < 60 * 60) {
    step(S);
    if (X.path.includes(first)) adopted = true;
  }
  assert.ok(adopted, `${X.name} never took the human route into ${G.tracks[track].name}`);
  assert.ok(!S.trains.has(X.id), `${X.name} still on the board after an hour (${X.state})`);
  assert.equal(X.state, 'done');
  const done = S.completed.find(c => c.name === X.name);
  assert.ok(done && done.delay === done.exitTime - X.sched);
  const exitName = G.portals.find(p => p.dir === -X.dir).name;
  assert.ok(S.log.some(e => e.text.startsWith(`${X.name} out via ${exitName} (`) && / min\)$/.test(e.text)));
}

// a human route lined from an empty track's exit signal: only a train in that track could take it, and none is coming
// (a queued one can't enter while the route holds the track). Left alone it locks that direction's exit from the
// module for good; the operator clears it after the 3-minute grace and traffic runs on. s90: a siding (nothing is
// ever bound for one; s91 was the seed until it grew a terminus, which no traffic test runs before the terminus
// mission); lebanon: a platform (P trains call there).
for (const [seed, cls] of [['s90', 'siding'], ['lebanon', 'platform']]) {
  const S = busySim(seed), G = S.layout, odd = n => Number(n.split(' ')[1]) % 2;
  for (let i = 0; i < 20 * 60; i++) step(S); // traffic about
  let r = null;
  for (let i = 0; i < 3600 && !r; i++) {
    for (const t of G.tracks.filter(k => k.cls === cls)) {
      if (r || !trackFree(S, t.id)) continue; // empty, nothing routed in or out, no train holding it
      const sig = G.signals.find(g => S.routesFrom.get(g.id).some(c => c.edges[0] === t.edges[1])).id; // its exit signal
      r = setRoute(S, sig, S.routesFrom.get(sig)[0].exitNode, { human: true }).route ?? null;
    }
    if (!r) step(S);
  }
  assert.ok(r, `${seed}: no ${cls} free to line a route out of`);
  const dir = S.layout.signals[r.signal].dir, done0 = S.completed.length;
  const text = `AUTO: cleared route ${signalLabel(S, r.signal)} → ${signalLabel(S, r.cand.exitSignal)} (no train can take it)`;
  let gone = null;
  for (let i = 0; i < 2 * 3600; i++) {
    step(S);
    if (gone === null && !S.routes.has(r.id)) {
      gone = S.time;
      assert.ok(S.log.some(e => e.text === text), `${seed}: no "${text}" in the log`);
    }
    for (const T of S.trains.values()) assert.ok(!T.stalled, `${seed}: STALL ${T.name}`);
  }
  const out = S.completed.slice(done0).filter(c => odd(c.name) === (dir === E ? 0 : 1)).length;
  assert.ok(gone !== null && gone - r.setAt <= 180 + 3, `${seed}: the dead route stood ${gone === null ? 'for good' : gone - r.setAt + ' s'} (${out} out that way)`);
  assert.ok(gone - r.setAt >= 180, `${seed}: cleared before the grace was up`);
  assert.ok(out >= 10, `${seed}: only ${out} trains out that way in 2 h`);
}

// a human route into a track the train at its signal does not fit is not taken (its tail would foul the points); no
// train can take it, so the operator clears it after the grace and routes the train on
{
  const S = createSim(L, 'fit'), G = S.layout;
  S.auto = true;
  S.nextSpawn = [Infinity, Infinity]; // no traffic
  const plat = G.tracks.find(t => t.cls === 'platform' && !fits(S, { len: trainLength('M') }, t.id));
  const home = G.signals.find(g => S.routesFrom.get(g.id).some(c => G.edges[c.edges.at(-1)].track === plat.id)).id;
  const c = S.routesFrom.get(home).find(k => G.edges[k.edges.at(-1)].track === plat.id);
  const r = setRoute(S, home, c.exitNode, { human: true }).route;
  const M = spawnTrain(S, { type: 'M', dir: plat.dir, name: 'M 4' });
  let gone = null;
  for (let i = 0; i < 3600 && S.trains.has(M.id); i++) {
    step(S);
    assert.ok(!plat.edges.some(e => M.path.includes(e)), `M 4 took a route into platform ${plat.name}, ${plat.capacity} long`);
    if (gone === null && !S.routes.has(r.id)) gone = S.time;
  }
  assert.ok(gone !== null && gone - r.setAt >= 180, 'cleared before the grace was up');
  assert.equal(M.state, 'done');
  assert.ok(S.log.some(e => e.text === `AUTO: cleared route ${signalLabel(S, home)} → ${signalLabel(S, c.exitSignal)} (no train can take it)`));
}

// passing: M 2 stands at the end of the first module on its home main. Stood PASS_WAIT, the express behind is routed
// round it on the other main from the portal (a crossover, logged and evented wrong main); still moving, it is followed.
for (const moving of [false, true]) {
  const S = createSim(L, 'pass'), G = S.layout;
  S.nextSpawn = [Infinity, Infinity]; // no traffic
  const M = spawnTrain(S, { type: 'M', dir: E, name: 'M 2' }), ps = entrySig(S, E);
  const home = S.routesFrom.get(ps).find(c => !c.wrongMain);
  assert.equal(setRoute(S, ps, home.exitNode, { trainId: M.id }).ok, true);
  assert.equal(setRoute(S, home.exitSignal, S.routesFrom.get(home.exitSignal).find(c => !c.diverging).exitNode, { trainId: M.id }).ok, true);
  for (let i = 0; i < 3600 && M.state !== 'stopped'; i++) step(S);
  assert.equal(M.state, 'stopped');
  M.lastMoveTime = moving ? S.time : S.time - PASS_WAIT;
  S.auto = true;
  const X = spawnTrain(S, { type: 'X', dir: E, name: 'X 4' });
  step(S);
  const r = S.routes.get(X.routes[0]), ev = X.events.find(e => e.kind === 'route');
  assert.ok(r && ev && r.signal === ps, 'X 4 got the portal route');
  assert.equal(r.cand.wrongMain, !moving, moving ? 'passed a moving train' : 'followed a standing train');
  assert.equal(X.path.some(e => G.edges[e].cls === 'crossover'), !moving);
  assert.equal(ev.wrongMain, moving ? undefined : true);
  const line = `AUTO: ${signalLabel(S, ps)} → X 4${moving ? '' : ' (wrong main)'}`;
  assert.ok(S.log.some(e => e.text === line), `no "${line}" line`);
}

// exit on the wrong row: the home main's last section held for good (a foreign id), an eastbound still leaves, over the
// last pair and off the end of Main 1 through the westbound entry; a westbound queued meanwhile enters after it
{
  const S = createSim(L, 'wrongrow'), G = S.layout;
  S.auto = true;
  S.nextSpawn = [Infinity, Infinity];
  for (const e of S.sectionEdges.get(G.edges[S.adj.get(exitsOf(S, E)[0])[0]].section)) S.edgeState[e].occ.add(999);
  const X = spawnTrain(S, { type: 'X', dir: E, name: 'X 6' }), pw = forwardEdges(S, pnode(S, W), W)[0];
  let q = null;
  for (let i = 0; i < 3600 && S.trains.has(X.id); i++) {
    step(S);
    assert.ok(S.edgeState.every(st => st.occ.size <= 1), 'two trains on one edge');
    if (q) assert.ok(!S.trains.has(q.id), 'the westbound entered under the eastbound');
    else if (X.path.includes(pw)) S.queue[1].push(q = { id: S.nextTrainId++, name: 'M 7', type: 'M', dir: W, entry: 1, exit: 0, dest: null,
      len: trainLength('M'), spawnTime: S.time, sched: S.time });
  }
  assert.ok(q, 'X 6 never routed off the end of Main 1');
  assert.ok(!S.trains.has(X.id) && S.completed.some(c => c.name === 'X 6'), 'X 6 still on the board');
  for (let i = 0; i < 60 && !S.trains.has(q.id); i++) step(S);
  assert.ok(S.trains.has(q.id), 'the westbound never entered');
}

// dead wrong-main human routes: one lined onto the other main, one from a signal on the other main. No train of their
// direction is at either signal, so the operator clears both after GRACE; a home-main human route stands.
{
  const S = createSim(L, 'deadwm'), G = S.layout;
  S.auto = true;
  S.nextSpawn = [Infinity, Infinity];
  const all = [...S.routesFrom].flatMap(([sig, cs]) => cs.map(c => ({ sig, c }))).filter(k => k.c.exitSignal !== null);
  const dir = k => G.signals[k.sig].dir, onOther = k => G.nodes[G.signals[k.sig].node].y === G.mainRow[-dir(k)];
  const apart = (k, ...ks) => ks.every(o => dir(o) === dir(k) && !o.c.edges.some(e => k.c.edges.includes(e)));
  const a = all.find(k => k.c.wrongMain && !onOther(k));
  const b = all.find(k => onOther(k) && !k.c.wrongMain && apart(k, a));
  const c = all.find(k => !onOther(k) && !k.c.wrongMain && G.edges[k.c.edges[0]].track === null && apart(k, a, b));
  const [ra, rb, rc] = [a, b, c].map(k => setRoute(S, k.sig, k.c.exitNode, { human: true }).route);
  assert.ok(ra && rb && rc, 'three human routes set');
  const gone = new Map();
  for (let i = 0; i < 300; i++) { step(S); for (const r of [ra, rb]) if (!gone.has(r) && !S.routes.has(r.id)) gone.set(r, S.time); }
  for (const r of [ra, rb]) {
    assert.ok(gone.get(r) - r.setAt >= 180 && gone.get(r) - r.setAt <= 183, `cleared after ${gone.get(r) - r.setAt} s`);
    const text = `AUTO: cleared route ${signalLabel(S, r.signal)} → ${signalLabel(S, r.cand.exitSignal)} (no train can take it)`;
    assert.ok(S.log.some(e => e.text === text), `no "${text}" in the log`);
  }
  assert.ok(S.routes.has(rc.id), 'a home-main human route was cleared');
}

// board status: ' · wrong main' while the train is
{
  const S = createSim(L, 'status'), G = S.layout, ps = entrySig(S, E);
  const T = spawnTrain(S, { type: 'M', dir: E });
  T.state = 'running';
  T.path = [...S.routesFrom.get(ps).find(c => c.wrongMain).edges];
  assert.equal(trainStatus(T, S), 'routed · wrong main');
  T.state = 'stopped';
  assert.equal(trainStatus(T, S), 'waiting · wrong main');
  T.path = [...S.routesFrom.get(ps).find(c => !c.wrongMain).edges];
  assert.ok(T.path.every(e => G.edges[e].main !== W));
  assert.equal(trainStatus(T, S), 'waiting');
}

// board: From -> To by the entry and exit portals, for queued, active and completed trains; an exit label names the portal
{
  const S = busySim('lebanon'), G = S.layout, short = n => n.split(' ')[0];
  for (let i = 0; i < 3600 && !(S.completed.length && S.queue.flat().length); i++) step(S);
  const html = boardHTML(S, null), ft = (a, b) => `title="${a} → ${b}">${short(a)}\u202f→\u202f${short(b)}<`;
  for (const t of [...S.queue.flat(), ...S.trains.values()]) assert.ok(html.includes(ft(G.portals[t.entry].name, G.portals[t.exit].name)), t.name);
  for (const c of S.completed.slice(-5)) assert.ok(html.includes(ft(c.from, c.to)), c.name);
  for (const d of [E, W]) {
    const c = [...S.routesFrom.values()].flat().find(k => k.exitSignal === null && k.dir === d); // a route off the far end
    assert.equal(exitLabel(S, c), `exit to ${portalOf(S, -d).name}`);
  }
}

// over and back: an eastbound wrong-main train stands at Main 1's end of a module, an eastbound stood PASS_WAIT on Main 2
// past the next pair. findPath dips over that pair and back round it, which no candidate is (none uses two crossovers);
// the operator takes the candidate ending where the path's first leg does, straight on or home, this tick.
{
  const G = generate('s0'), S = createSim(G, 's0'), N = (x, y) => G.nodes.find(n => n.x === x && n.y === y).id;
  S.auto = true;
  S.nextSpawn = [Infinity, Infinity];
  const on = (x1, x2, y) => G.edges.find(e => e.cls === 'main' && [e.a, e.b].every(n => G.nodes[n].y === y)
    && [e.a, e.b].map(n => G.nodes[n].x).sort((a, b) => a - b).join() === `${x1},${x2}`).id;
  const [m, m1] = G.modules, T1 = G.mainRow[W], T2 = G.mainRow[E], e0 = on(m.x1, m.x1 + 1, T1);
  const X = spawnTrain(S, { type: 'M', dir: E, name: 'M 2' }), Y = spawnTrain(S, { type: 'M', dir: E, name: 'M 4' });
  Object.assign(X, { path: [e0], pathStart: N(m.x1, T1), headDist: G.edges[e0].len - FOUL, state: 'stopped' });
  Object.assign(Y, { path: [on(m1.x0, m1.x1, T2), on(m1.x1, m1.x1 + 1, T2)], pathStart: N(m1.x0, T2), lastMoveTime: S.time - 2 * PASS_WAIT,
    state: 'stopped' });
  Y.headDist = pathLength(S, Y) - FOUL;
  for (const t of [X, Y]) t.path.forEach(e => S.edgeState[e].occ.add(t.id));
  assert.ok(isWrongMain(S, X));
  const sig = sigAt(S, N(m.x1 + 1, T1), E), cands = S.routesFrom.get(sig);
  const path = findPath(S, headNode(S, X), E, X.goal,
    { trainId: X.id, blockedCost: MOVING_COST, standingCost: STANDING_COST, wrongMainCost: WRONG_MAIN_COST }, X.path.at(-1));
  assert.ok(!cands.some(c => c.edges.every((e, i) => path[i] === e)), 'findPath no longer dips over and back');
  step(S);
  const r = S.routes.get(X.routes[0]);
  assert.ok(r && r.signal === sig, 'the wrong-main train got no route');
  const straight = cands.find(c => c.edges.every(e => G.edges[e].cls === 'main')), home = cands.find(c => G.nodes[c.exitNode].y === T2);
  assert.ok([straight, home].includes(r.cand), 'neither straight on nor home');
}

// a human cancels a route a train has adopted but not entered, while it holds routes beyond it: those drop off its path
// before the operator runs, so the train is routed on from the cancelled route's signal, never from its old path end
// (a route set for it there is off its path for good, and wedges the signal)
{
  const S = createSim(L, 'lebanon');
  S.auto = true;
  S.nextSpawn = [Infinity, Infinity];
  const C = spawnTrain(S, { type: 'C', dir: E, name: 'C 2' });
  for (let i = 0; i < 4; i++) step(S);
  const mine = () => [...S.routes.values()].filter(r => r.trainId === C.id && !r.entered);
  const r = mine().sort((a, b) => a.id - b.id)[0];
  assert.ok(r && C.routes.indexOf(r.id) < C.routes.length - 1, 'C holds no route beyond an un-entered one');
  assert.equal(cancelRoute(S, r.id), true);
  step(S);
  assert.ok(mine().every(q => C.routes.includes(q.id)), 'a route set for C off its path');
  assert.equal(S.routes.get(C.routes.at(-1)).signal, r.signal, 'not routed on from the cancelled route\'s signal');
}
}
console.log('traffic ok');

// ---- Wyes: three portals, branch traffic, junction interlocking (spec "Portals and traffic", "Interlocking additions").
// sN: a north junction (feet on Main 1), sS: a south one (feet on Main 2).
{
const quiet = seed => { const S = createSim(generate(seed), seed); S.nextSpawn = S.nextSpawn.map(() => Infinity); return S; };
const entryOf = (S, type, dir, entry, exit, name, dest = null) => ({ id: S.nextTrainId++, name, type, dir, entry, exit, dest,
  len: trainLength(type), spawnTime: S.time, sched: S.time });
// T stands on path from start, its head FOUL short of the path's end (or at headDist), occupying every path edge
const stand = (S, T, path, start, headDist = null) => {
  Object.assign(T, { path: [...path], pathStart: start, state: 'stopped' });
  T.headDist = headDist ?? pathLength(S, T) - FOUL;
  path.forEach(e => S.edgeState[e].occ.add(T.id));
  return T;
};
const allFree = S => S.edgeState.every(st => st.route === null);
const block = S => { for (const p of S.layout.portals) { const g = signalAhead(S, p.node, null); setRoute(S, g, S.routesFrom.get(g)[0].exitNode, { trainId: 99 }); } };

for (const seed of [sN, sS]) {
  const S = quiet(seed), G = S.layout, k = wyeOf(S), home = d => G.mainRow[d];
  assert.equal(k.portal.id, 2);
  // forwardEdges on the stem never doubles back (it is vertical, so the x rule alone would allow it); at the apex off
  // the stem (its trunk) onto the leg of the train's dir, off a leg only up the stem, never leg <-> leg
  for (const d of [E, W]) {
    assert.deepEqual(forwardEdges(S, k.stemNode, d, k.stem[1]), [k.stem[0]], `${seed}: down the stem, never back up`);
    assert.deepEqual(forwardEdges(S, k.stemNode, d, k.stem[0]), [k.stem[1]], `${seed}: up the stem, never back down`);
    assert.deepEqual(forwardEdges(S, k.w.A, d, k.stem[0]), [d === E ? k.legF2 : k.legF1], `${seed}: apex, off the stem`);
    // the branch portal is left down the stem by either dir, and is the only exit node of the branch for both
    assert.deepEqual(forwardEdges(S, k.portal.node, d), [k.stem.at(-1)]);
    assert.deepEqual(exitNodesOf(S, 2, d), [k.portal.node]);
  }
  assert.deepEqual(forwardEdges(S, k.w.A, E, k.legF1), [k.stem[0]], `${seed}: off the west leg, up the stem only`);
  assert.deepEqual(forwardEdges(S, k.w.A, W, k.legF2), [k.stem[0]], `${seed}: off the east leg, up the stem only`);

  // the stem signal (dir 0) walks both dirs: eastbound candidates end at b', westbound at b; the way onto the dir's home
  // main crosses over when the feet are on the other main (eastbound off a north wye, westbound off a south one); the
  // way onto the other main is wrong main
  const cs = S.routesFrom.get(k.stemSig);
  for (const d of [E, W]) {
    const mine = cs.filter(c => c.dir === d);
    assert.ok(mine.some(c => G.nodes[c.exitNode].y === home(d)), `${seed}: no ${d} way home from the stem signal`);
    for (const c of mine) {
      const end = G.nodes[c.exitNode], xo = c.edges.some(e => G.edges[e].cls === 'crossover');
      assert.equal(end.x, d === E ? k.b2 : k.b, `${seed}: stem candidate ${d} ends at column ${end.x}`);
      assert.deepEqual([c.edges[0], c.edges[1]], [k.stem[0], d === E ? k.legF2 : k.legF1]);
      assert.equal(c.wrongMain, end.y !== home(d), `${seed}: stem candidate ${d} to row ${end.y} wrong main`);
      if (end.y === home(d)) assert.equal(xo, k.y !== home(d), `${seed}: ${d} home from the stem crosses iff the feet are on the other main`);
    }
  }
  assert.ok(cs.every(c => c.dir !== 0));
  // the branch portal signal: one route, down to the stem signal, either dir
  assert.deepEqual(S.routesFrom.get(k.portalSig).map(c => [c.dir, c.exitNode, c.exitSignal]), [[0, k.stemNode, k.stemSig]]);
  // of two ways through the gap from b (b') to the other main at b' (b), crossing at either pair, the one with less
  // wrong-main running is kept (crossing at the other pair runs >= 7 edges wrong main)
  for (const [x, d, x2] of [[k.b, E, k.b2], [k.b2, W, k.b]]) for (const y of [home(E), home(W)]) {
    const c = S.routesFrom.get(sigAt(S, k.N(x, y), d)).find(c2 => c2.exitNode === k.N(x2, y === home(E) ? home(W) : home(E)));
    assert.ok(c.edges.filter(e => G.edges[e].main === -d).length <= 3, `${seed}: ${d} from ${x},${y} crosses at the far pair`);
  }

  // senses on the branch section are +1 inbound (toward the main) and -1 outbound, never 0: two inbound routes in
  // sequence (the stem signal's, then the portal's behind it) do not oppose each other; on main sections, the dir
  const toHome = cs.find(c => c.dir === E && G.nodes[c.exitNode].y === home(E));
  const r1 = setRoute(S, k.stemSig, toHome.exitNode), r2 = setRoute(S, k.portalSig, k.stemNode);
  assert.ok(r1.ok && r2.ok, `${seed}: two inbound routes: ${r1.reason} ${r2.reason}`);
  assert.deepEqual([r1.route.dir, r2.route.dir, r1.route.sense.get(k.branchSec), r2.route.sense.get(k.branchSec)], [E, 0, 1, 1]);
  for (const [s, v] of r1.route.sense) if (s !== k.branchSec) assert.equal(v, E);
  assert.deepEqual([...r2.route.sense.keys()], [k.branchSec]);
  cancelRoute(S, r1.route.id); cancelRoute(S, r2.route.id);
  const bSig = sigAt(S, k.N(k.b, home(E)), E), dep = S.routesFrom.get(bSig).find(c => c.exitNode === k.portal.node);
  const r3 = setRoute(S, bSig, dep.exitNode);
  assert.ok(r3.ok, r3.reason);
  assert.equal(r3.route.sense.get(k.branchSec), -1, `${seed}: a departure into the stem runs outbound`);
  cancelRoute(S, r3.route.id);
  assert.ok(allClear(S));

  // an eastbound arrival on its way down the east leg (inbound): a departure from b up the west leg and the stem is
  // refused 'opposing' and locks nothing, though both are eastbound (a train's sense comes from its path); a second
  // inbound route behind it, from the portal down to the stem signal, is allowed
  { const S2 = quiet(seed);
    stand(S2, spawnTrain(S2, { type: 'M', dir: E, entry: 2 }), [k.legF2], k.w.A, 1);
    assert.equal(setRoute(S2, bSig, dep.exitNode).reason, 'opposing', `${seed}: departure under an arrival`);
    assert.ok(allFree(S2), `${seed}: a refused route left a lock`);
    assert.ok(setRoute(S2, k.portalSig, k.stemNode).ok, `${seed}: second inbound route refused`); }
  // ... and the other way: a departure on its way up the west leg (outbound) refuses both inbound routes
  { const S2 = quiet(seed);
    stand(S2, spawnTrain(S2, { type: 'M', dir: E }), [k.legF1], k.w.F1, 1);
    assert.equal(setRoute(S2, k.stemSig, toHome.exitNode).reason, 'opposing', `${seed}: arrival under a departure`);
    assert.equal(setRoute(S2, k.portalSig, k.stemNode).reason, 'opposing', `${seed}: entry under a departure`);
    assert.ok(allFree(S2)); }
  // a westbound train standing at the stem signal: the departure is refused (it holds the stem) and locks nothing; it
  // will not take an eastbound human route from its signal, which no train can take now, so the operator clears that
  // after the grace and routes the train west
  { const S2 = quiet(seed), pe = S2.routesFrom.get(k.portalSig)[0].edges;
    const T = stand(S2, spawnTrain(S2, { type: 'M', dir: W, entry: 2 }), pe, k.portal.node);
    assert.equal(signalAheadOf(S2, T), k.stemSig);
    assert.equal(setRoute(S2, bSig, dep.exitNode).reason, 'occupied');
    assert.ok(allFree(S2));
    const h = setRoute(S2, k.stemSig, toHome.exitNode, { human: true }).route;
    assert.ok(h, `${seed}: human route from the stem signal`);
    moveTrains(S2);
    assert.deepEqual([T.path, h.trainId], [pe, null], `${seed}: a westbound train took an eastbound route`);
    S2.auto = true;
    for (let i = 0; i < 200 && S2.routes.has(h.id); i++) step(S2);
    assert.ok(!S2.routes.has(h.id) && S2.time - h.setAt >= 180, `${seed}: the eastbound route at a westbound train stood`);
    const text = `AUTO: cleared route ${signalLabel(S2, k.stemSig)} → ${signalLabel(S2, toHome.exitSignal)} (no train can take it)`;
    assert.ok(S2.log.some(e => e.text === text), `${seed}: no "${text}"`);
    for (let i = 0; i < 60 && !T.routes.length; i++) step(S2);
    assert.equal(S2.routes.get(T.routes[0])?.dir, W, `${seed}: the westbound train was not routed on`); }

  // labels: the stem and portal signals face down (north wye) or up (south) the stem; a route into the stem ends at the
  // branch portal
  for (const g of [k.stemSig, k.portalSig]) assert.equal(signalLabel(S, g)[0], seed === sN ? 'S' : 'N');
  assert.equal(exitLabel(S, dep), `exit to ${k.portal.name}`);
}

// branch traffic, run by the operator. On each side one dir must cross between the branch and its home main (dX:
// eastbound off a north wye, westbound off a south one). Its arrival goes stem -> leg -> feet main -> the pair beyond the
// wye -> home main -> out at b' (b), and while it runs wrong main inside the gap it is exempt; its departure from its
// portal with exit 2 crosses at the pair before the wye, climbs the near leg and the stem and runs out by the branch.
for (const seed of [sN, sS]) {
  const S = quiet(seed), G = S.layout, k = wyeOf(S), dX = -k.w.feetMain, branch = k.portal.name;
  const near = portalOf(S, dX).id, far = portalOf(S, -dX).id, legIn = dX === E ? k.legF1 : k.legF2, legOut = dX === E ? k.legF2 : k.legF1;
  const inGap = n => G.nodes[n].x > k.b && G.nodes[n].x < k.b2, side = e => Math.sign((G.nodes[G.edges[e].a].x - G.nodes[k.w.A].x) * dX);
  S.auto = true;
  const run = q => {
    S.queue[q.entry].push(q);
    const seen = new Set();
    let exempt = 0;
    for (let i = 0; i < 3600 && !S.completed.some(c => c.name === q.name); i++) {
      step(S);
      const T = S.trains.get(q.id);
      if (!T) continue;
      T.path.forEach(e => seen.add(e));
      if (T.path.some(e => S.edgeState[e].occ.has(T.id) && G.edges[e].junction && G.edges[e].main === -T.dir)) {
        exempt++;
        assert.ok(!isWrongMain(S, T) && !wrongMainTrains(S).includes(T), `${seed}: ${T.name} counted wrong main inside the gap`);
      }
    }
    const done = S.completed.find(c => c.name === q.name);
    assert.ok(done, `${seed}: ${q.name} never left`);
    return { seen: [...seen], exempt, done };
  };
  const a = run(entryOf(S, 'X', dX, 2, far, 'X 8'));
  assert.ok(S.log.some(e => e.text === `X 8 entered from ${branch}`), `${seed}: no "X 8 entered from ${branch}"`);
  assert.deepEqual([a.done.from, a.done.to], [branch, G.portals[far].name]);
  assert.ok([...k.stem, legOut].every(e => a.seen.includes(e)) && !a.seen.includes(legIn), `${seed}: X 8 not down the far leg`);
  assert.ok(a.seen.some(e => G.edges[e].cls === 'crossover' && inGap(G.edges[e].a) && side(e) > 0), `${seed}: X 8 never crossed beyond the wye`);
  const bEnd = k.N(dX === E ? k.b2 : k.b, G.mainRow[dX]);
  assert.ok(a.seen.some(e => G.edges[e].main === dX && [G.edges[e].a, G.edges[e].b].includes(bEnd) && inGap(farOf(G, e, bEnd))),
    `${seed}: X 8 never ran out of the gap on its home main`);
  assert.ok(a.exempt > 0, `${seed}: X 8 never ran wrong main inside the gap`);
  const d = run(entryOf(S, 'M', dX, near, 2, 'M 10'));
  assert.deepEqual([d.done.from, d.done.to], [G.portals[near].name, branch]);
  assert.ok(S.log.some(e => e.text.startsWith(`M 10 out via ${branch} (`)), `${seed}: no "M 10 out via ${branch}"`);
  assert.ok([legIn, ...k.stem].every(e => d.seen.includes(e)) && !d.seen.includes(legOut), `${seed}: M 10 not up the near leg`);
  assert.ok(d.seen.some(e => G.edges[e].cls === 'crossover' && inGap(G.edges[e].a) && side(e) < 0), `${seed}: M 10 never crossed before the wye`);
  assert.ok(d.exempt > 0, `${seed}: M 10 never ran wrong main inside the gap`);
  assert.ok(allClear(S));
}

// a human route can send a train out by another portal than its exit: up the stem it leaves by the branch; past the wye
// a branch-bound train gives up the branch and runs for the far end
{
  const S = quiet(sN), G = S.layout, k = wyeOf(S), branch = k.portal.name;
  S.auto = true;
  const bSig = sigAt(S, k.N(k.b, G.mainRow[E]), E), cs = S.routesFrom.get(bSig);
  const up = cs.find(c => c.exitNode === k.portal.node), on = cs.find(c => c.exitNode === k.N(k.b2, G.mainRow[E]));
  const out = name => { for (let i = 0; i < 3600 && !S.completed.some(c => c.name === name); i++) step(S); return S.completed.find(c => c.name === name); };
  assert.equal(setRoute(S, bSig, up.exitNode, { human: true }).ok, true);
  S.queue[0].push(entryOf(S, 'M', E, 0, 1, 'M 12'));
  assert.equal(out('M 12')?.to, branch, 'M 12 did not leave by the branch');
  assert.ok(S.log.some(e => e.text.startsWith(`M 12 out via ${branch} (`)));
  assert.equal(setRoute(S, bSig, on.exitNode, { human: true }).ok, true);
  S.queue[0].push(entryOf(S, 'M', E, 0, 2, 'M 14'));
  assert.equal(out('M 14')?.to, G.portals[1].name, 'M 14 did not leave by the far end');
  assert.ok(S.log.some(e => e.text === `M 14 missed ${branch}`));
  assert.ok(!S.log.some(e => e.text.startsWith('STALL')));
}

// the branch turns round: a departure waiting at b holds a new arrival at the portal (the arrival, an express, is
// served first by rank and would otherwise take the stem) ...
{
  const S = quiet(sN), G = S.layout, k = wyeOf(S), bSig = sigAt(S, k.N(k.b, G.mainRow[E]), E), sg = G.signals[bSig];
  S.auto = true;
  const D = stand(S, spawnTrain(S, { type: 'M', dir: E, exit: 2, name: 'M 16' }), [sg.from], farOf(G, sg.from, sg.node));
  const A = spawnTrain(S, { type: 'X', dir: W, entry: 2, name: 'X 17' });
  step(S);
  assert.equal(S.routes.get(D.routes[0])?.cand.exitNode, k.portal.node, 'the departure waiting at b did not get the stem');
  assert.equal(A.routes.length, 0, 'an arrival went in while a departure waited');
}
// ... unless an arrival has stood STARVE (10 min) at the portal: then it is not held, and goes in first by rank
{
  const S = quiet(sN), G = S.layout, k = wyeOf(S), bSig = sigAt(S, k.N(k.b, G.mainRow[E]), E), sg = G.signals[bSig];
  S.auto = true;
  const D = stand(S, spawnTrain(S, { type: 'X', dir: E, exit: 2, name: 'X 18' }), [sg.from], farOf(G, sg.from, sg.node));
  const A = spawnTrain(S, { type: 'M', dir: W, entry: 2, name: 'M 19' });
  A.lastMoveTime = S.time - 10 * 60;
  step(S);
  assert.equal(S.routes.get(A.routes[0])?.signal, k.portalSig, 'the starved arrival was not let in');
  assert.equal(D.routes.length, 0, 'a departure went in past a starved arrival');
}
// a train bound for the branch is never sent wrong main: with M 2 stood on Main 2 through the first module, an express
// bound for the far end is routed round it on Main 1 from the portal; one bound for the branch waits instead (stood at
// b or b' on the other main, its only way on would be the branch, which an arrival may hold needing that very section)
for (const exit of [1, 2]) {
  const S = quiet(sN), G = S.layout, ps = entrySig(S, E);
  const M = spawnTrain(S, { type: 'M', dir: E, name: 'M 2' }), home = S.routesFrom.get(ps).find(c => !c.wrongMain);
  assert.equal(setRoute(S, ps, home.exitNode, { trainId: M.id }).ok, true);
  assert.equal(setRoute(S, home.exitSignal, S.routesFrom.get(home.exitSignal).find(c => !c.diverging).exitNode, { trainId: M.id }).ok, true);
  for (let i = 0; i < 3600 && M.state !== 'stopped'; i++) step(S);
  M.lastMoveTime = S.time - PASS_WAIT;
  S.auto = true;
  const X = spawnTrain(S, { type: 'X', dir: E, exit, name: 'X 4' });
  step(S);
  if (exit === 1) assert.ok(S.routes.get(X.routes[0])?.cand.wrongMain, 'the far-end express was not routed round M 2');
  else assert.ok(X.routes.every(r => !S.routes.get(r).cand.wrongMain), 'the branch-bound express was sent wrong main');
}

// the liveness valve on a frozen AUTO wedge (tools/freeze-wedge.mjs: s142 busy at 10:18 under the sim before the valve,
// layout included, where it held for good): P 411, bound for the branch, has stood 18 min at b' with its way up the
// stem occupied by P 264, which waits on L 268, opposed by M 425, which waits on Z 419, which waits on P 411. P 411
// gives the branch up at once and runs for the far end; within the hour no train stands an hour.
{
  const fx = JSON.parse(readFileSync(new URL('./fixtures/wedge-s142.json', import.meta.url), 'utf8'));
  const S = createSim(fx.layout, fx.seed, { density: 'busy', slowOrders: false }), G = S.layout, br = G.portals[2];
  Object.assign(S, { time: fx.time, nextTrainId: fx.nextTrainId, nextRouteId: fx.nextRouteId, auto: true });
  S.nextSpawn = S.nextSpawn.map(() => Infinity); // the frozen trains only
  // frozen before reversing existed: those trains' fields at their defaults
  for (const t of fx.trains) S.trains.set(t.id, { run: 0, locoAtTail: false, pushing: false, terminus: false, arrival: t.dir, reversed1: false, ...t, events: [] });
  for (const { exitNode, sense, ...r } of fx.routes) {
    const cand = S.routesFrom.get(r.signal).find(c => c.exitNode === exitNode);
    S.routes.set(r.id, { ...r, cand, dir: cand.dir, sense: new Map(sense) });
  }
  for (const [e, id] of fx.occ) S.edgeState[e].occ.add(id);
  for (const [e, id] of fx.locks) S.edgeState[e].route = id;
  for (const [n, lie] of fx.lies) S.switchState.get(n).lie = lie;
  for (const [t, id] of fx.reserved) S.reserved.set(t, id);
  const P = [...S.trains.values()].find(t => t.name === 'P 411');
  assert.ok(P.exit === br.id && P.dest === null && S.time - P.lastMoveTime >= 10 * 60 && G.nodes[headNode(S, P)].x === G.wye.x1, 'the frozen wedge');
  step(S);
  assert.ok(S.log.some(e => e.text === `P 411 missed ${br.name}`), 'P 411 kept the branch');
  for (let i = 0; i < 3600; i++) {
    step(S);
    for (const T of S.trains.values()) if (T.state !== 'dwelling' && T.state !== 'holding')
      assert.ok(S.time - T.lastMoveTime < 3600, `${T.name} stood an hour after the valve`);
  }
  assert.equal(S.completed.find(c => c.name === 'P 411')?.to, G.portals[0].name, 'P 411 not out by the far end');
}

// a branch-bound train a human left on the wrong main (westbound on Main 2) gives the branch up too, at once, and
// leaves by the far end within the hour: at the boundary east of the wye's module neighbour, every way on is wrong
// main, which the operator never sets for a train bound for the branch; at b' with an arrival standing at the stem
// signal, that arrival needs the section it stands in. Traffic flows on.
for (const seed of [sN, sS]) for (const shape of ['module', 'gate']) {
  const S = shape === 'gate' ? quiet(seed) : createSim(generate(seed), seed), G = S.layout, k = wyeOf(S), br = k.portal;
  const x = shape === 'gate' ? k.b2 : G.modules.find(m => m.x0 - 1 === k.b2).x1 + 1, nd = k.N(x, G.mainRow[E]), sg = G.signals[sigAt(S, nd, W)];
  const X = stand(S, spawnTrain(S, { type: 'X', dir: W, exit: br.id, name: 'X 9' }), [sg.from], farOf(G, sg.from, nd));
  const A = shape === 'gate' ? stand(S, spawnTrain(S, { type: 'M', dir: E, entry: br.id, name: 'M 10' }), S.routesFrom.get(k.portalSig)[0].edges, br.node) : null;
  assert.ok(isWrongMain(S, X), `${seed} ${shape}: X 9 not wrong main`);
  S.auto = true;
  for (let i = 0; i < 3600 && (S.trains.has(X.id) || (A && S.trains.has(A.id))); i++) step(S);
  assert.ok(S.log.some(e => e.text === `X 9 missed ${br.name}`), `${seed} ${shape}: X 9 kept the branch`);
  assert.equal(S.completed.find(c => c.name === 'X 9')?.to, portalOf(S, E).name, `${seed} ${shape}: X 9 not out by the far end`);
  if (A) assert.ok(S.completed.some(c => c.name === 'M 10'), `${seed}: the arrival never left`);
  else {
    const e0 = S.completed.length;
    for (let i = 0; i < 3600; i++) step(S);
    assert.ok(S.completed.length - e0 >= 10 && !S.log.some(e => e.text.startsWith('STALL')), `${seed}: traffic stopped after X 9`);
  }
}

// an un-entered human route running up the stem out of the branch portal (dir E) lets no eastbound arrival in: it
// starts at b, not at the portal's signal, so the arrival could never take it
{
  const S = quiet(sN), G = S.layout, k = wyeOf(S), bSig = sigAt(S, k.N(k.b, G.mainRow[E]), E);
  const r = setRoute(S, bSig, k.portal.node, { human: true }).route;
  S.queue[2].push(entryOf(S, 'M', E, 2, 1, 'M 20'));
  step(S);
  assert.equal(S.trains.size, 0, 'an arrival entered under a departure route');
  cancelRoute(S, r.id);
  step(S);
  assert.equal(S.trains.size, 1, 'the arrival did not enter once the stem was clear');
}

// a human route lined from the branch portal signal before any train is there: the next branch arrival enters (either
// dir: the route is dir 0) and adopts it
{
  const S = quiet(sN), k = wyeOf(S);
  S.nextSpawn[2] = S.time;
  const r = setRoute(S, k.portalSig, k.stemNode, { human: true }).route;
  step(S);
  assert.equal(S.trains.size, 1, 'no branch arrival past the human route on the stem');
  const T = [...S.trains.values()][0];
  assert.equal(T.entry, 2);
  step(S);
  assert.ok(r.trainId === T.id && T.routes.includes(r.id) && r.entered);
}

// dead human routes at the wye: one from the stem signal onto the other main (wrong main, no train at the dir 0 signal),
// one from b on the other main up into the stem (logged to the branch portal by name). Each cleared after GRACE.
{
  const k = wyeOf(quiet(sN)), S0 = quiet(sN), G = S0.layout;
  const wm = S0.routesFrom.get(k.stemSig).find(c => c.wrongMain);
  const bOther = sigAt(S0, k.N(k.b, G.mainRow[W]), E), up = S0.routesFrom.get(bOther).find(c => c.exitNode === k.portal.node);
  for (const [sig, c, to] of [[k.stemSig, wm, signalLabel(S0, wm.exitSignal)], [bOther, up, k.portal.name]]) {
    const S = quiet(sN);
    S.auto = true;
    const r = setRoute(S, sig, c.exitNode, { human: true }).route;
    assert.ok(r, `human route from ${signalLabel(S, sig)}`);
    for (let i = 0; i < 200 && S.routes.has(r.id); i++) step(S);
    assert.ok(!S.routes.has(r.id) && S.time - r.setAt >= 180, `the route from ${signalLabel(S, sig)} stood`);
    const text = `AUTO: cleared route ${signalLabel(S, sig)} → ${to} (no train can take it)`;
    assert.ok(S.log.some(e => e.text === text), `no "${text}"`);
  }
}

// a branch arrival bound east (north wye) never draws a destination west of the wye, which the west portal's do; bound
// west, none east of it
{
  const S = quiet(sN), G = S.layout, k = wyeOf(S);
  const dests = (d, p) => trafficMenu(S, d, p).filter(m => m.dest !== null).map(m => m.dest);
  assert.ok(dests(E, 0).some(t => tx(G, t) < k.b), 'the west portal draws eastbound destinations west of the wye');
  assert.ok(dests(E, 2).length && !dests(E, 2).some(t => tx(G, t) < k.b), 'a branch arrival bound east drew one west of the wye');
  assert.ok(!dests(W, 2).some(t => tx(G, t) > k.b2), 'a branch arrival bound west drew one east of the wye');
}

// the coins (both from sim.branchRng): about 30 % of the trains that can reach the branch from their destination (or
// entry) leave by it, the rest keep the far end; branch arrivals pick east or west fairly, never leave by the branch, draw
// only destinations they can reach, and are numbered with their dir (even eastbound, odd westbound)
{
  const S = createSim(generate(sN), sN), br = 2;
  block(S);
  const entries = [];
  for (let i = 0; i < 200; i++) { S.nextSpawn = S.nextSpawn.map(() => S.time); step(S); for (const q of S.queue) entries.push(...q.splice(0)); }
  assert.equal(S.trains.size, 0);
  const can = q => S.reach.exits[q.dest !== null ? `t${q.dest}:${q.dir}` : `p${q.entry}:${q.dir}`].has(br);
  const eligible = entries.filter(can), share = eligible.filter(q => q.exit === br).length / eligible.length;
  assert.ok(eligible.length >= 200 && share >= 0.2 && share <= 0.4, `exit coin: ${(100 * share).toFixed(1)} % of ${eligible.length}`);
  assert.ok(entries.filter(q => !can(q)).every(q => q.exit === portalOf(S, -q.dir).id), 'a train that cannot reach the branch was sent there');
  const arr = entries.filter(q => q.entry === br), east = arr.filter(q => q.dir === E).length / arr.length;
  assert.ok(arr.length >= 200 && east > 0.35 && east < 0.65, `branch arrivals: ${(100 * east).toFixed(1)} % eastbound`);
  for (const q of arr) {
    assert.equal(Number(q.name.split(' ')[1]) % 2, q.dir === E ? 0 : 1, `${q.name} bound ${q.dir}`);
    assert.ok(q.dest === null || S.reach.tracks[`${br}:${q.dir}`].has(q.dest), `${q.name} drew a track it cannot reach`);
    assert.equal(q.exit, portalOf(S, -q.dir).id);
  }
  assert.equal(new Set(entries.map(q => q.name)).size, entries.length, 'train numbers count per dir over all portals');
  // traffic on a layout without a wye draws no branch coin from sim.rng: same entries as before (the s42 run fixture
  // below says the same)
}

// spawn rate: each of three portals draws at DENSITY x 1.5 on average (traffic shared three ways), each of two at
// DENSITY; QUEUE_MAX per portal
for (const [seed, k] of [[sN, 1.5], ['lebanon', 1]]) {
  const S = createSim(generate(seed), seed, { density: 'busy' }), t0 = S.time, n = S.layout.portals.map(() => 0);
  block(S);
  for (let i = 0; i < 48 * 3600; i++) { step(S); S.queue.forEach((q, p) => { n[p] += q.length; q.length = 0; }); }
  for (const p of S.layout.portals) {
    const mean = (S.nextSpawn[p.id] - t0) / n[p.id];
    assert.ok(Math.abs(mean / (DENSITY.busy * k) - 1) < 0.15, `${seed}: portal ${p.id} mean interval ${mean.toFixed(0)} s`);
  }
}
{
  const S = createSim(generate(sS), sS, { density: 'busy' });
  block(S);
  for (let i = 0; i < 3 * 3600; i++) step(S);
  assert.deepEqual(S.queue.map(q => q.length), [8, 8, 8], 'QUEUE_MAX per portal');
}
}
console.log('junction ok');

// ---- Phase 2: reversing and the terminus (spec "Phase 2: reversing and the terminus"). tN: a north terminus (feet on
// Main 1), tS: a south one (feet on Main 2).
{
const quiet = seed => { const S = createSim(generate(seed), seed); S.nextSpawn = S.nextSpawn.map(() => Infinity); return S; };
// T stands on path from start, its head FOUL short of the path's end (or at headDist), occupying every path edge
const stand = (S, T, path, start, headDist = null) => {
  Object.assign(T, { path: [...path], pathStart: start, state: 'stopped' });
  T.headDist = headDist ?? pathLength(S, T) - FOUL;
  path.forEach(e => S.edgeState[e].occ.add(T.id));
  return T;
};
const near = (p, q, msg) => assert.ok(p && q && Math.abs(p.x - q.x) <= 1e-9 && Math.abs(p.y - q.y) <= 1e-9, `${msg}: ${JSON.stringify(p)} vs ${JSON.stringify(q)}`);
// the edges the occupancy rule gives T's path ([s, s + len) with s <= head and s + len > tail), and the edges T holds
const occRule = (S, T) => {
  const out = [];
  let s = T.pathOff;
  for (const e of T.path) { const l = S.layout.edges[e].len; if (s <= T.headDist && s + l > T.headDist - T.len) out.push(e); s += l; }
  return out.sort((a, b) => a - b);
};
const holds = (S, T) => S.edgeState.flatMap((st, e) => (st.occ.has(T.id) ? [e] : []));
const straightOf = (S, sig) => S.routesFrom.get(sig).find(c => !c.diverging && !c.slow);

assert.equal(PUSH_MPH, 15);
assert.equal(DWELL.terminus, 10 * 60);

// reverse, by hand: an express stopped at the pull-ahead signal (head FOUL short of P, 40 cells into its run) turns round
// where it stands. Its path is its occupied edges reversed from P, its tail exactly where its head was and its head where
// its tail was (every point of it: no pixel moves), loco at the tail, pushing, its run banked. Its head node is the foot,
// whose shunt signal it reads. Reversed again it is as it was, loco leading. At speed it refuses.
for (const seed of [tN, tS]) for (const d of [E, W]) {
  const S = quiet(seed), k = termOf(S), w = k.w, foot = d === E ? w.F2 : w.F1;
  const X = spawnTrain(S, { type: 'X', dir: d, name: 'X 2' });
  X.pathOff = 40;
  stand(S, X, [k.run[d]], foot);
  const len = X.len, us = [0, 0.4, 1.3, len / 2, len - 0.2, len], at = u => pointAt(S, X, X.headDist - u), was = us.map(at), occ = holds(S, X);
  assert.deepEqual(occRule(S, X), occ);
  X.speed = 0.01;
  assert.throws(() => reverse(S, X, -d), /speed/, 'reversed at speed');
  X.speed = 0;
  reverse(S, X, -d);
  assert.deepEqual([X.dir, X.path, X.pathStart, X.pathOff, X.run, X.locoAtTail, X.pushing], [-d, [k.run[d]], w.P[d], 0, 40, true, true]);
  assert.ok(close(X.headDist, FOUL + len), `${seed}: headDist ${X.headDist}`);
  assert.equal(headNode(S, X), foot, `${seed} ${d}: the head node is not the foot`);
  assert.equal(signalAheadOf(S, X), d === E ? w.shunt.F2 : w.shunt.F1, `${seed} ${d}: not at the shunt signal`);
  us.forEach((u, i) => near(pointAt(S, X, X.headDist - len + u), was[i], `${seed} ${d}: the point ${u} behind the old head moved`));
  assert.deepEqual([holds(S, X), occRule(S, X)], [occ, occ], `${seed} ${d}: occupancy changed`);
  sectionalRelease(S, X);
  assert.deepEqual(X.path, [k.run[d]], 'sectionalRelease dropped an edge after the reversal');
  // pushing: the cars lead and the loco is the last block, its back at the train's tail
  const bl = trainBlocks(S, X);
  assert.deepEqual([bl[0].kind, bl.at(-1).kind, bl.filter(b => b.kind === 'loco').length], ['car', 'loco', 1]);
  near({ x: bl[0].x1, y: bl[0].y1 }, was.at(-1), 'the leading car is not at the old tail');
  near({ x: bl.at(-1).x2, y: bl.at(-1).y2 }, was[0], 'the loco\'s back is not at the old head');
  reverse(S, X, d);
  assert.deepEqual([X.dir, X.locoAtTail, X.pushing, X.run, trainBlocks(S, X)[0].kind], [d, false, false, 40, 'loco']);
  us.forEach((u, i) => near(at(u), was[i], `${seed} ${d}: reversed twice, the point ${u} moved`));
}
// ... and a long freight stopped mid-edge across five edges with its routes set (entered) and one more set for it ahead
// (not yet adopted): every route set for it is gone (the un-entered one cancelled), the edges ahead of its head drop
// off its path unlocked, its occupancy and every point of it stay put
{
  const S = createSim(L, 'rev'), G = S.layout, s1 = entrySig(S, E), c1 = straightOf(S, s1), c2 = straightOf(S, c1.exitSignal);
  const c3 = straightOf(S, c2.exitSignal), M = spawnTrain(S, { type: 'M', dir: E, name: 'M 4' });
  const rs = [[s1, c1], [c1.exitSignal, c2], [c2.exitSignal, c3]].map(([g, c]) => setRoute(S, g, c.exitNode, { trainId: M.id }).route);
  Object.assign(M, { path: [...c1.edges, ...c2.edges], routes: [rs[0].id, rs[1].id], headDist: c1.len + G.edges[c2.edges[0]].len + 4.37 });
  for (const e of occRule(S, M)) { S.edgeState[e].occ.add(M.id); S.routes.get(S.edgeState[e].route).entered = true; }
  sectionalRelease(S, M);
  const occ = holds(S, M), us = [0, 0.37, 2, 4.37, 4.4, 5, M.len - 0.1, M.len], was = us.map(u => pointAt(S, M, M.headDist - u));
  assert.ok(occ.length >= 4 && M.path.length > occ.length, `the freight spans ${occ.length} edges of ${M.path.length}`);
  reverse(S, M, W);
  assert.deepEqual(M.path, [...occ].sort((a, b) => M.path.indexOf(a) - M.path.indexOf(b)), 'the path is not the occupied edges');
  assert.deepEqual([...M.path].reverse(), c1.edges.concat(c2.edges).filter(e => occ.includes(e)), 'not reversed');
  assert.deepEqual(holds(S, M), occ);
  assert.deepEqual(occRule(S, M), occ);
  assert.ok([...S.routes.values()].every(r => r.trainId !== M.id) && S.edgeState.every(st => st.route === null), 'a route of its own still set');
  us.forEach((u, i) => near(pointAt(S, M, M.headDist - M.len + u), was[i], `the point ${u} behind the old head moved`));
}

// shunt signals end no route: from the pull-ahead signal either way the through route crosses both feet to the far P
// (none ends at a foot, and none runs head first into the stub); the shunt signal's own routes are the main onward and
// the stub, backing in down the near leg to the buffer: slow, so its dwarf shows Restricting
for (const seed of [tN, tS]) {
  const S = quiet(seed), G = S.layout, k = termOf(S), w = k.w;
  for (const d of [E, W]) {
    // the signal at the near P for d, facing in from outside the runs
    const from = signalAhead(S, w.P[-d], G.edges.find(e => e.id !== k.run[-d] && e.main === w.feetMain && (e.a === w.P[-d] || e.b === w.P[-d])).id);
    const cs = S.routesFrom.get(from), through = cs.find(c => c.exitNode === w.P[d]);
    assert.ok(cs.every(c => ![w.F1, w.F2, k.buffer].includes(c.exitNode)), `${seed} ${d}: ${signalLabel(S, from)} ends at a foot or the buffer`);
    assert.deepEqual(through?.edges, d === E ? [k.run[W], k.mid, k.run[E]] : [k.run[E], k.mid, k.run[W]], `${seed} ${d}: the through route`);
    assert.equal(through.exitSignal, k.pSig(d));
    const shunt = d === E ? w.shunt.F2 : w.shunt.F1, back = S.routesFrom.get(shunt).find(c => c.exitNode === k.buffer);
    assert.deepEqual([back?.edges, back?.dir, back?.slow, back?.exitSignal], [[d === E ? k.leg.F2 : k.leg.F1, ...k.stub], -d, true, null], `${seed}: the stub route`);
    assert.ok(S.routesFrom.get(shunt).some(c => c.exitNode !== k.buffer && !c.slow), `${seed}: the shunt signal's main route`);
    assert.equal(setRoute(S, shunt, k.buffer).ok, true);
    clearAspects(S);
    assert.equal(aspectOf(S, shunt), ASPECT.RESTRICTING);
    assert.deepEqual(lamps(aspectOf(S, shunt), 'shunt', signalHeads(S, shunt)), { top: 'FR' });
    cancelRoute(S, routeFrom(S, shunt).id);
  }
}

// the points at the foot may move for the reversed train standing at its shunt signal (its head 1.1 cells clear of
// them), though its own body occupies the foot's trunk: for the operator (trainId) or a human NX (the train at the
// signal), never for another train
for (const seed of [tN, tS]) {
  const S = quiet(seed), k = termOf(S), w = k.w;
  const X = stand(S, spawnTrain(S, { type: 'X', dir: E, name: 'X 2' }), [k.run[E]], w.F2);
  reverse(S, X, W);
  assert.deepEqual([switchLocked(S, w.F2), switchLocked(S, w.F2, X)], [true, false], `${seed}: switchLocked at the foot`);
  assert.equal(S.switchState.get(w.F2).lie, 'normal');
  assert.equal(setRoute(S, w.shunt.F2, k.buffer, { trainId: 99 }).reason, 'switch busy', `${seed}: the points moved for another train`);
  const r = setRoute(S, w.shunt.F2, k.buffer, { trainId: X.id });
  assert.equal(r.ok, true, `${seed}: ${r.reason}`);
  assert.equal(S.switchState.get(w.F2).lie, 'reverse');
  cancelRoute(S, r.route.id);
  S.switchState.get(w.F2).lie = 'normal';
  assert.equal(setRoute(S, w.shunt.F2, k.buffer, { human: true }).ok, true, `${seed}: a human NX for the standing train`);
}

// A route set from a shunt signal owns the foot's points until a train enters it: the points stand on its first edge,
// not on its trunk (the run, where the reversed train stands), so the trunk rule alone left them free. With one set no
// other route may move them, nor may a human throw them (the operator's through route from P threw them back under a
// back-in route set by hand, and the reversed train backed up the leg with the points the other way).
for (const seed of [tN, tS]) {
  const S = quiet(seed), G = S.layout, k = termOf(S), w = k.w;
  const r = setRoute(S, w.shunt.F2, k.buffer, { human: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(S.switchState.get(w.F2).lie, 'reverse');
  assert.deepEqual([switchLocked(S, w.F2), throwSwitch(S, w.F2)], [true, false], `${seed}: the points free under a shunt route`);
  // the westbound through route from P east of the wye needs the points at F2 normal
  const outer = G.edges.find(e => e.id !== k.run[E] && e.main === w.feetMain && (e.a === w.P[1] || e.b === w.P[1])).id;
  assert.equal(setRoute(S, signalAhead(S, w.P[1], outer), w.P[-1]).reason, 'switch busy', `${seed}: a route moved the points under a shunt route`);
  cancelRoute(S, r.route.id);
  assert.equal(throwSwitch(S, w.F2), true, `${seed}: held after the route was cancelled`);
}

// A route from a shunt signal at which no train stands is dead after GRACE (only a reversed terminus train comes to a
// shunt signal, and none can while the stub is busy): the operator clears it. Left, one onto the main held a departure
// and the trains behind it at b for good, and a back-in route at the other foot kept the arrival reversing for hours.
for (const seed of [tN, tS]) {
  const S = quiet(seed), w = S.layout.wye, main = S.routesFrom.get(w.shunt.F1).find(c => c.dir === E && !c.slow);
  assert.equal(setRoute(S, w.shunt.F1, main.exitNode, { human: true }).ok, true);
  S.auto = true;
  for (let i = 0; i < 3 * 60 + 2; i++) step(S);
  assert.equal(routeFrom(S, w.shunt.F1), null, `${seed}: a route from a shunt signal with no train at it stood`);
  assert.ok(S.log.some(e => e.text.startsWith(`AUTO: cleared route ${signalLabel(S, w.shunt.F1)} → `)));
}

// a train for the stub (from either main portal): terminus, its arrival dir kept, bound first for the pull-ahead signal
// past the wye for that dir; its exit the far end until it departs. Every other train is no terminus train.
{
  const S = quiet(tN), w = S.layout.wye;
  for (const d of [E, W]) {
    const T = spawnTrain(S, { type: 'P', dir: d, dest: w.stub });
    assert.deepEqual([T.terminus, T.arrival, T.goal, T.exit, T.dest, T.run, T.locoAtTail, T.pushing, T.reversed1],
      [true, d, { node: w.P[d] }, portalOf(S, -d).id, w.stub, 0, false, false, false]);
  }
  const M = spawnTrain(S, { type: 'M', dir: E });
  assert.deepEqual([M.terminus, M.arrival, M.goal], [false, E, { exit: portalOf(S, W).id }]);
}

// One terminus train in the offing at a time: the stub is on the menus only while it is free (nothing in it, routed into
// it or bound for it) and no terminus train is queued. A mission takes ~25 min and serves both portals, so otherwise
// terminus entries fill every portal queue (QUEUE_MAX) and the draws for all other traffic are dropped.
{
  const S = quiet(tN), w = S.layout.wye, onMenu = () => [E, W].map(d => trafficMenu(S, d).some(m => m.dest === w.stub));
  assert.deepEqual(onMenu(), [true, true]);
  S.queue[1].push({ id: 90, name: 'X 91', type: 'X', dir: W, entry: 1, exit: 0, dest: w.stub, terminus: true, len: trainLength('X'), spawnTime: S.time, sched: S.time });
  assert.deepEqual(onMenu(), [false, false], 'drawn while a terminus train is queued');
  S.queue[1].length = 0;
  S.reserved.set(w.stub, 7);
  assert.deepEqual(onMenu(), [false, false], 'drawn while one is bound for the stub');
  S.reserved.clear();
  assert.deepEqual(onMenu(), [true, true]);
}

// The mission (spec "The terminus mission"), in AUTO on a quiet sim: a P for the stub, entering from either end, runs to
// the pull-ahead signal past the wye, reverses there, backs down the near leg into the stub at no more than 15 mph with
// its loco trailing, dwells 10 min, departs forward (loco leading), climbs the other leg and leaves by the portal it came
// in by. No point of it ever jumps (at a reversal its tail is where its head was), its path always chains from
// pathStart, and the board reads reversing, then backing in.
// (once more from the west on tN, with a back-in route set by hand at the other foot while it runs up to P: it is
// cleared GRACE after it was set, and the mission goes on)
for (const [seed, d, other] of [[tN, E], [tS, E], [tN, W], [tS, W], [tN, E, true]]) {
  const S = quiet(seed), G = S.layout, k = termOf(S), w = k.w, entry = portalOf(S, d), stub = G.tracks[w.stub].name;
  let poked = !other;
  S.auto = true;
  S.queue[entry.id].push({ id: S.nextTrainId++, name: 'P 2', type: 'P', dir: d, entry: entry.id, exit: portalOf(S, -d).id, dest: w.stub,
    terminus: true, len: trainLength('P'), spawnTime: S.time, sched: S.time });
  let T = null, phase = 'in';
  const words = new Set(), legs = { back: new Set(), out: new Set() }, said = s => S.log.some(e => e.text.startsWith(`P 2 ${s}`));
  for (let i = 0; i < 3600 && !S.completed.some(c => c.name === 'P 2'); i++) {
    const was = T && { dir: T.dir, head: pointAt(S, T, T.headDist), tail: pointAt(S, T, T.headDist - T.len) };
    step(S);
    T ??= [...S.trains.values()].find(t => t.name === 'P 2') ?? null;
    if (!T || !S.trains.has(T.id)) continue;
    if (!poked && !T.reversed1 && headNode(S, T) === w.P[d] && T.speed > 0)
      poked = setRoute(S, d === E ? w.shunt.F1 : w.shunt.F2, k.buffer, { human: true }).ok;
    let n = T.pathStart;
    for (const e of T.path) { assert.ok(G.edges[e].a === n || G.edges[e].b === n, `${seed} ${d}: the path is not chained`); n = farOf(G, e, n); }
    assert.ok(phase === 'in' || T.headDist - T.len >= T.pathOff - 1e-9, `${seed} ${d}: the tail is off the path`); // (in: entering)
    if (was && was.dir !== T.dir) {
      near(pointAt(S, T, T.headDist - T.len), was.head, `${seed} ${d}: the reversal moved the tail`);
      near(pointAt(S, T, T.headDist), was.tail, `${seed} ${d}: the reversal moved the head`);
    }
    if (phase === 'in' && said('reversing at')) phase = 'back';
    if (phase === 'back' && said('arrived at')) phase = 'dwell';
    if (phase === 'dwell' && said('departed')) phase = 'out';
    if (phase === 'in') assert.ok(!T.locoAtTail && T.dir === d);
    if (phase === 'back') assert.ok(T.speed <= PUSH_MPH * MPH + 1e-9 && T.locoAtTail && T.pushing && T.dir === -d, `${seed} ${d}: pushing at ${T.speed / MPH} mph`);
    if (phase === 'out') assert.ok(!T.locoAtTail && !T.pushing && T.dir === -d);
    if (legs[phase]) T.path.filter(e => G.edges[e].cls === 'wye').forEach(e => legs[phase].add(e));
    words.add(trainStatus(T, S));
  }
  const at = [`entered from ${entry.name}`, `reversing at ${signalLabel(S, k.pSig(d))}`, `backing into ${stub}`, `arrived at ${stub}`,
    `departed ${stub}`, `out via ${entry.name} (`].map(s => S.log.findIndex(e => e.text.startsWith(`P 2 ${s}`)));
  assert.ok(at.every((v, i) => v >= 0 && (!i || v > at[i - 1])), `${seed} ${d}: the log ${at}\n${S.log.map(e => e.text).join('\n')}`);
  const c = S.completed.find(x => x.name === 'P 2'), ev = kind => c.events.find(e => e.kind === kind).t;
  assert.deepEqual([c.from, c.to], [entry.name, entry.name]);
  assert.equal(ev('departed') - ev('arrived'), DWELL.terminus);
  assert.ok(c.distance > 2 * Math.abs(G.nodes[w.P[d]].x - G.nodes[entry.node].x), `${seed} ${d}: distance ${c.distance}`);
  // backed in by the leg at the far foot, out by the other
  assert.deepEqual([[...legs.back], [...legs.out]], d === E ? [[k.leg.F2], [k.leg.F1]] : [[k.leg.F1], [k.leg.F2]], `${seed} ${d}: legs`);
  assert.ok(words.has('reversing') && words.has('backing in'), `${seed} ${d}: status words ${[...words]}`);
  assert.ok(!S.log.some(e => e.text.startsWith('STALL')) && S.routes.size === 0 && S.reserved.size === 0);
  // its running in the gap against a main's home direction is exempt: never logged as wrong main
  assert.ok(!S.log.some(e => e.text.endsWith('P 2 (wrong main)')), `${seed} ${d}: logged wrong main`);
  if (other) assert.ok(poked && S.log.some(e => e.text.startsWith('AUTO: cleared route ')), 'the back-in route at the other foot was not set, or not cleared');
}

// Nothing follows a terminus train into the gap on the feet main until it has reversed: while it stands at its
// pull-ahead signal unreversed, a route from the gap's boundary onto the feet main is refused for another train
// ('terminus') though it runs the same way, and the other way is opposed. Once it has reversed, the old direction is
// opposed and the new one sets (on its home main).
for (const seed of [tN, tS]) {
  const S = quiet(seed), G = S.layout, k = termOf(S), w = k.w, yF = G.mainRow[w.feetMain];
  const T = stand(S, spawnTrain(S, { type: 'P', dir: E, dest: w.stub, name: 'P 2' }), [k.run[E]], w.F2);
  const node = x => G.nodes.find(n => n.x === x && n.y === yF).id, bE = sigAt(S, node(w.x0), E), bW = sigAt(S, node(w.x1), W);
  const inE = S.routesFrom.get(bE).find(c => c.exitNode === w.P[-1]).exitNode, inW = S.routesFrom.get(bW).find(c => c.exitNode === w.P[1]).exitNode;
  assert.equal(setRoute(S, bE, inE, { trainId: 50 }).reason, 'terminus', `${seed}: followed the terminus train in`);
  assert.equal(setRoute(S, bE, inE, { human: true }).reason, 'terminus', `${seed}: a human sent a train in behind it`);
  assert.equal(setRoute(S, bW, inW, { trainId: 51 }).reason, 'opposing');
  reverse(S, T, W);
  T.reversed1 = true;
  assert.equal(setRoute(S, bE, inE, { trainId: 50 }).reason, 'opposing');
  // (onto the feet main westbound: its home on a north terminus; on a south one wrong main, and the terminus train is
  // on its visit, the one wrong-main move)
  const r = setRoute(S, bW, inW, { trainId: 51 });
  assert.deepEqual([r.ok, r.reason], w.feetMain === W ? [true, undefined] : [false, 'wrong main'], `${seed}: the new direction`);
}
// ... and it reverses only once no other train is on the feet main's junction edges (one still clearing a pair, here)
for (const seed of [tN, tS]) {
  const S = quiet(seed), G = S.layout, k = termOf(S), w = k.w;
  const T = stand(S, spawnTrain(S, { type: 'P', dir: E, dest: w.stub, name: 'P 2' }), [k.run[E]], w.F2);
  const pair = k.feet.find(e => G.edges[e].section !== G.edges[k.run[E]].section && G.nodes[G.edges[e].a].x > G.nodes[w.P[1]].x);
  const O = stand(S, spawnTrain(S, { type: 'M', dir: E, name: 'M 3' }), [pair], G.nodes[G.edges[pair].a].x < G.nodes[G.edges[pair].b].x ? G.edges[pair].a : G.edges[pair].b);
  S.auto = true;
  for (let i = 0; i < 5; i++) step(S);
  assert.deepEqual([T.reversed1, T.dir, T.state], [false, E, 'stopped'], `${seed}: reversed with a train on the feet main`);
  S.edgeState[pair].occ.delete(O.id);
  S.trains.delete(O.id);
  step(S);
  assert.deepEqual([T.reversed1, T.dir, T.locoAtTail], [true, W, true], `${seed}: did not reverse`);
  assert.ok(S.log.some(e => e.text === `P 2 reversing at ${signalLabel(S, k.pSig(E))}`));
}

// The feet main turns round for a terminus train (like the branch for a departure): one that has stood STARVE (10 min)
// at the stub signal waiting for its way out against the traffic in the gap holds every other train's route into the
// gap of the other direction, so the gap drains and it gets out; under busy traffic the trains of the other direction
// follow each other in and it waited 25 min on s14. One that has not stood STARVE holds nothing.
for (const starved of [true, false]) {
  const S = quiet(tS), G = S.layout, k = termOf(S), w = k.w, yF = G.mainRow[w.feetMain];
  const node = x => G.nodes.find(n => n.x === x && n.y === yF).id;
  // D: in from the west, dwelt, departed: in the stub at its signal, bound back west
  const D = stand(S, spawnTrain(S, { type: 'P', dir: E, dest: w.stub, name: 'P 2' }), [k.stub[1]], k.buffer);
  Object.assign(D, { dir: W, reversed1: true, dest: null, exit: D.entry, goal: { exit: D.entry }, lastMoveTime: S.time - (starved ? 600 : 0) });
  // I: eastbound at the far P, in the gap's section (it gets its way on out, but is in there all the step)
  const I = stand(S, spawnTrain(S, { type: 'M', dir: E, name: 'M 3' }), [k.run[E]], w.F2);
  // A: eastbound at b, its way on into the gap behind I
  const bE = sigAt(S, node(w.x0), E), A = stand(S, spawnTrain(S, { type: 'M', dir: E, name: 'M 5' }), [G.signals[bE].from], farOf(G, G.signals[bE].from, node(w.x0)));
  S.auto = true;
  step(S);
  assert.equal(D.routes.length, 0, 'D routed against I');
  assert.equal(A.routes.length > 0, !starved, starved ? 'routed into the gap against the starved departure' : 'held without a starved departure');
}

// A terminus train's visit to the gap (from its first route in until it is out again) is the one wrong-main move: it runs
// against one main's home direction in there, approaching or leaving, and holds a main against the others while it is
// in. Its own running there is exempt from the count, but no other train is sent wrong main meanwhile, and it leaves the
// stub against the feet main only while no train is wrong main (it may begin its visit with one out: waiting at b it
// would hold its own home main). Other trains have no exemption in a terminus's gap (its P columns are stands inside it). On s83 a train sent wrong main behind a departure met one of the other direction head on, both waiting on
// the main the departure held, for good; on s200 a through train wrong main in the gap stood at P.
{
  const S = quiet(tS), G = S.layout, k = termOf(S), w = k.w;
  const sig = G.signals.find(g => g.dir !== 0 && G.nodes[g.node].x < w.x0 - 8 && S.routesFrom.get(g.id).some(c => c.wrongMain)).id;
  const wm = S.routesFrom.get(sig).find(c => c.wrongMain).exitNode;
  // D: in from the west, departed and out of the stub, running west on the feet main (Main 2) toward P
  const D = stand(S, spawnTrain(S, { type: 'P', dir: E, dest: w.stub, name: 'P 2' }), [k.run[W]], w.F1);
  Object.assign(D, { dir: W, reversed1: true, dest: null, exit: D.entry, goal: { exit: D.entry } });
  assert.equal(isWrongMain(S, D), false, 'its running inside the gap is exempt');
  assert.equal(setRoute(S, sig, wm, { trainId: 50 }).reason, 'wrong main', 'sent wrong main during a terminus train\'s visit');
  D.terminus = false; // a through train there is wrong main like anywhere
  assert.equal(isWrongMain(S, D), true, 'a through train exempt in a terminus\'s gap');
  assert.equal(setRoute(S, sig, wm, { trainId: 50 }).reason, 'wrong main');
  S.edgeState[k.run[W]].occ.delete(D.id);
  D.path = [];
  const r = setRoute(S, sig, wm, { trainId: 50 });
  assert.equal(r.ok, true, r.reason);
  cancelRoute(S, r.route.id);
  // a train wrong main away from the gap: D may not leave the stub against the feet main; a terminus train at b may begin
  // its visit (and then D may not leave either)
  stand(S, D, [k.stub[1]], k.buffer);
  D.terminus = true;
  const out = S.routesFrom.get(w.stubSignal).find(c => c.dir === W).exitNode, y1 = G.mainRow[W], yF = G.mainRow[w.feetMain];
  const far = G.edges.find(e => e.main === W && !e.junction && G.nodes[e.a].y === y1 && Math.max(G.nodes[e.a].x, G.nodes[e.b].x) < w.x0 - 8).id;
  const O = stand(S, spawnTrain(S, { type: 'M', dir: E, name: 'M 3' }), [far], G.nodes[G.edges[far].a].x < G.nodes[G.edges[far].b].x ? G.edges[far].a : G.edges[far].b);
  assert.equal(isWrongMain(S, O), true);
  assert.equal(setRoute(S, w.stubSignal, out, { trainId: D.id }).reason, 'wrong main', 'left the stub against the feet main with a train wrong main');
  const bE = sigAt(S, G.nodes.find(n => n.x === w.x0 && n.y === yF).id, E), inE = S.routesFrom.get(bE).find(c => c.exitNode === w.P[-1]);
  const T = stand(S, spawnTrain(S, { type: 'X', dir: E, dest: w.stub, name: 'X 4' }), [G.signals[bE].from], farOf(G, G.signals[bE].from, G.signals[bE].node));
  assert.equal(inE.wrongMain, false);
  const rT = setRoute(S, bE, inE.exitNode, { trainId: T.id }); // (waiting at b it would hold its own home main)
  assert.equal(rT.ok, true, `a terminus train kept from its visit by a train wrong main: ${rT.reason}`);
  assert.equal(setRoute(S, w.stubSignal, out, { trainId: D.id }).ok, false);
  cancelRoute(S, rT.route.id);
  S.edgeState[far].occ.delete(O.id);
  S.trains.delete(O.id);
  assert.equal(setRoute(S, w.stubSignal, out, { trainId: D.id }).ok, true);
}

// The liveness valve (like a branch-bound train's): a terminus train that has stood 20 min (2 x STARVE) at the gap's
// boundary with its way in refused gives the stub up and runs through for the far end. On s263 one stood at b on its
// home main waiting to cross to the feet main behind a train whose way on was held, head on, by a wrong-main train that
// had to get home on the main the terminus train stood on: for good.
for (const stood of [20, 19]) {
  const S = quiet(tN), G = S.layout, k = termOf(S), w = k.w, y2 = G.mainRow[-w.feetMain];
  const node = (x, y) => G.nodes.find(n => n.x === x && n.y === y).id, bE = sigAt(S, node(w.x0, y2), E);
  const T = stand(S, spawnTrain(S, { type: 'P', dir: E, dest: w.stub, name: 'P 2' }), [G.signals[bE].from], farOf(G, G.signals[bE].from, node(w.x0, y2)));
  S.reserved.set(w.stub, T.id);
  T.lastMoveTime = S.time - stood * 60;
  const across = S.routesFrom.get(bE).find(c => c.exitNode === w.P[-1]);
  S.edgeState[across.edges.at(-1)].occ.add(999); // its way across to the feet main, held
  S.auto = true;
  step(S);
  const missed = S.log.some(e => e.text === `P 2 missed ${G.tracks[w.stub].name}`);
  assert.equal(missed, stood >= 20, `${stood} min: missed ${missed}`);
  if (missed) {
    assert.deepEqual([T.terminus, T.dest, T.goal, S.reserved.size], [false, null, { exit: portalOf(S, W).id }, 0]);
    assert.ok(T.routes.length > 0, 'not routed on through the gap');
  } else assert.deepEqual([T.terminus, T.routes.length], [true, 0]);
}

// a human who routes a terminus train on from its pull-ahead signal before it reverses sends it past the wye: it gives
// up the stub and runs for the far end as a through train
{
  const S = quiet(tN), G = S.layout, k = termOf(S), w = k.w;
  const T = stand(S, spawnTrain(S, { type: 'P', dir: E, dest: w.stub, name: 'P 2' }), [k.run[E]], w.F2);
  S.reserved.set(w.stub, T.id);
  assert.equal(setRoute(S, k.pSig(E), straightOf(S, k.pSig(E)).exitNode, { human: true }).ok, true);
  S.auto = true;
  for (let i = 0; i < 3600 && S.trains.has(T.id); i++) step(S);
  assert.ok(S.log.some(e => e.text === `P 2 missed ${G.tracks[w.stub].name}`));
  assert.deepEqual([S.completed.find(c => c.name === 'P 2')?.to, T.terminus, T.reversed1, S.reserved.size], [portalOf(S, W).name, false, false, 0]);
}
}
console.log('terminus ok');
