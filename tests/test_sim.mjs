import assert from 'node:assert/strict';
import { generate } from '../src/gen.js';
import { createSim, setRoute, cancelRoute, throwSwitch, forwardEdges, findPath, switchLocked,
  releaseEdge, sectionalRelease, entryPortalNode, exitNodes, routeFrom, isWrongMain, wrongMainTrains, PASS_WAIT,
  ASPECT, aspectOf, signalHeads, lamps, clearAspects,
  MPH, CAR, LOCO, FOUL, TYPES, trainLength, spawnTrain, despawnTrain, moveTrains, pathLength, pointAt,
  trainBlocks, headNode,
  DENSITY, DWELL, step, trafficMenu, fits, trackFree, holdingTracks, signalLabel, logEvent,
  WRONG_MAIN_COST, MOVING_COST, STANDING_COST, nightLevel, SLOW_ORDER, edgeSpeed, slowOrderLabel, OPERATORS } from '../src/sim.js';
import { trainStatus } from '../src/panels.js';

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

// fresh sim shape
assert.equal(sim.time, 6 * 3600);
assert.deepEqual(sim.log, [{ t: 6 * 3600, text: `${sim.operator} on duty` }]);
assert.equal(sim.auto, false);
assert.equal(typeof sim.rng, 'function');
assert.equal(sim.adj.size, L.nodes.length);
assert.equal(sim.edgeState.length, L.edges.length);
assert.ok(allClear(sim));
assert.ok([sim.trains, sim.reserved, sim._aspects].every(m => m instanceof Map && m.size === 0));
assert.deepEqual(sim.queue, { 1: [], '-1': [] });
assert.deepEqual(sim.completed, []);
assert.deepEqual([...sim.switchState.keys()].sort(), L.switches.map(s => s.node).sort());
assert.ok([...sim.switchState.values()].every(s => s.lie === 'normal'));

// portals and forwardEdges: x rule plus dirs; exits at the far end of both mains, home main first
assert.deepEqual([E, W].map(d => entryPortalNode(sim, d)), [L.portals.find(p => p.dir === E).node, L.portals.find(p => p.dir === W).node]);
assert.deepEqual(exitNodes(sim, E).map(n => [L.nodes[n].x, L.nodes[n].y]), [[L.cols - 1, L.mainRow[1]], [L.cols - 1, L.mainRow[-1]]]);
assert.deepEqual(exitNodes(sim, W).map(n => [L.nodes[n].x, L.nodes[n].y]), [[0, L.mainRow[-1]], [0, L.mainRow[1]]]);
for (const d of [E, W]) {
  assert.equal(forwardEdges(sim, entryPortalNode(sim, d), d).length, 1);
  for (const n of exitNodes(sim, d)) {
    assert.deepEqual(forwardEdges(sim, n, d), []);
    assert.equal(forwardEdges(sim, n, -d).length, 1, 'the main runs both ways');
  }
}

// every signal has >= 1 candidate; candidates end at a node that has a signal of that dir or is an exit node
for (const seed of ['lebanon', ...Array.from({ length: 50 }, (_, i) => `s${i}`)]) {
  const S = seed === 'lebanon' ? sim : createSim(generate(seed), seed), G = S.layout;
  const swAt = new Map(G.switches.map(s => [s.node, s]));
  for (const sig of G.signals) {
    const cs = S.routesFrom.get(sig.id);
    assert.ok(cs.length >= 1, `${seed}: signal ${sig.id} has no candidates`);
    // over and back inside one crossover pair is dropped: it ends where the straight route does
    assert.equal(new Set(cs.map(c => c.exitNode)).size, cs.length, `${seed}: signal ${sig.id} has two candidates to one exit`);
    assert.ok(cs.every(c => c.edges.filter(e => G.edges[e].cls === 'crossover').length < 2), `${seed}: over and back in one pair`);
    for (const c of cs) {
      const ns = walk(G, sig.node, c.edges), last = G.edges[c.edges.at(-1)];
      ns.slice(1).forEach((n, i) => assert.equal(Math.sign(G.nodes[n].x - G.nodes[ns[i]].x), sig.dir, `${seed}: candidate runs against dir`));
      assert.ok(c.edges.every(e => G.edges[e].dirs.includes(sig.dir)), `${seed}: candidate uses an edge against its dirs`);
      assert.equal(c.exitNode, ns.at(-1));
      const exitSig = S.signalAt.get(`${c.exitNode}:${sig.dir}`) ?? null;
      assert.equal(c.exitSignal, exitSig);
      if (exitSig === null) assert.ok(exitNodes(S, sig.dir).includes(c.exitNode), `${seed}: candidate ends at neither a signal nor an exit`);
      assert.ok(ns.slice(1, -1).every(n => !S.signalAt.has(`${n}:${sig.dir}`)), `${seed}: candidate runs past a signal`);
      assert.ok(Math.abs(c.len - c.edges.reduce((s, e) => s + G.edges[e].len, 0)) < 1e-9);
      assert.equal(c.slow, SLOW.includes(last.cls));
      assert.equal(c.diverging, c.switches.some(s => s.lie === 'reverse'));
      // every switch the candidate passes through is listed, with reverse iff it uses the reverse leg
      assert.deepEqual(c.switches.map(s => s.node), ns.slice(1, -1).filter(n => swAt.has(n)), `${seed}: switch list`);
      for (const s of c.switches) assert.equal(s.lie, c.edges.includes(swAt.get(s.node).reverse) ? 'reverse' : 'normal');
    }
  }
}

// setRoute on the westbound entry portal signal to its first straight candidate -> ok
const sigAt = (node, dir) => sim.signalAt.get(`${node}:${dir}`);
const straight = sig => sim.routesFrom.get(sig).find(c => !c.diverging && !c.slow);
const portalSig = sigAt(entryPortalNode(sim, W), W);
const c0 = straight(portalSig);
let r = setRoute(sim, portalSig, c0.exitNode);
assert.equal(r.ok, true);
const R0 = r.route;
assert.deepEqual(R0, { id: R0.id, signal: portalSig, cand: c0, trainId: null, human: false, entered: false, setAt: sim.time });
assert.equal(sim.routes.get(R0.id), R0);
assert.ok(c0.edges.every(e => sim.edgeState[e].route === R0.id));
assert.deepEqual(setRoute(sim, portalSig, entryPortalNode(sim, W)), { ok: false, reason: 'no such route' });
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
  edges: [[0, 1, 'main'], [1, 2, 'main'], [1, 3, 'ladder']].map(([a, b, cls], id) => ({ id, a, b, cls, dirs: [E], len: 1, track: null })),
  switches: [{ node: 1, trunk: 0, normal: 1, reverse: 2 }],
  signals: [{ id: 0, node: 0, dir: E, kind: 'high' }, { id: 1, node: 1, dir: E, kind: 'high' }],
  portals: [], cols: 3, mainRow: { 1: 0, '-1': 0 },
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
const fake = { id: 5, len: 1, path: [...c1.edges], pathOff: 0, headDist: lenOf(e0) + 0.5 };
for (const e of c1.edges) sim.edgeState[e].occ.add(5);
assert.deepEqual(setRoute(sim, other.sig, other.c.exitNode), { ok: false, reason: 'occupied' }, 'occupied is checked before locked');
sectionalRelease(sim, fake); // head past e0, tail still on it: nothing to release
assert.deepEqual(fake.path, c1.edges);
assert.equal(fake.pathOff, 0);
fake.headDist = lenOf(e0) + 1.5;
sectionalRelease(sim, fake);
assert.deepEqual(fake.path, c1.edges.slice(1));
assert.equal(fake.pathOff, lenOf(e0));
assert.ok(!sim.edgeState[e0].occ.has(5) && sim.edgeState[e0].route === null);
assert.ok(sim.edgeState[e1].occ.has(5) && sim.edgeState[e1].route === R4.id && sim.routes.has(R4.id));
fake.headDist = c1.len + fake.len;
sectionalRelease(sim, fake);
assert.deepEqual(fake.path, []);
assert.ok(Math.abs(fake.pathOff - c1.len) < 1e-9);
assert.ok(!sim.routes.has(R4.id));
assert.equal(cancelRoute(sim, R0.id), true);
assert.ok(allClear(sim), 'everything released');

// findPath {exit: true} from each entry portal returns edges with strictly increasing (decreasing) x, ending at an exit
for (const d of [E, W]) {
  const p = findPath(sim, entryPortalNode(sim, d), d, { exit: true });
  assert.ok(p && p.length > 0);
  const pn = walk(L, entryPortalNode(sim, d), p);
  pn.slice(1).forEach((n, i) => assert.equal(Math.sign(L.nodes[n].x - L.nodes[pn[i]].x), d, 'x strictly monotonic'));
  assert.ok(exitNodes(sim, d).includes(pn.at(-1)));
}

// findPath to {track: id of first platform} ends inside that track's edges (at its first edge)
const plat = L.tracks.find(t => t.cls === 'platform');
const pp = findPath(sim, entryPortalNode(sim, plat.dir), plat.dir, { track: plat.id });
assert.ok(pp && plat.edges.includes(pp.at(-1)));
assert.equal(pp.at(-1), plat.edges[0]);
walk(L, entryPortalNode(sim, plat.dir), pp); // contiguous from the portal
assert.equal(findPath(sim, entryPortalNode(sim, -plat.dir), -plat.dir, { track: plat.id }), null, 'wrong-way platform unreachable');

// a manually occupied edge (edgeState[e].occ.add(99)) makes setRoute over it return reason 'occupied' and findPath avoid it
const busy = c1.edges.reduce((a, b) => (lenOf(b) > lenOf(a) ? b : a)); // the main through the first module
const from = entryPortalNode(sim, W), to = { exit: true };
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
  const a = into(E), b = into(W);
  assert.equal(setRoute(S, a.id, a.c.exitNode).ok, true);
  assert.equal(setRoute(S, b.id, b.c.exitNode).reason, 'opposing'); }
// wrong main: only one train at a time; the train at the signal is exempt
{ const S = createSim(L, 'wm'), G = S.layout;
  const [sigA, sigB] = G.signals.filter(s => S.routesFrom.get(s.id).some(c => c.wrongMain));
  const cA = S.routesFrom.get(sigA.id).find(c => c.wrongMain), cB = S.routesFrom.get(sigB.id).find(c => c.wrongMain);
  const t = spawnTrain(S, { type: 'M', dir: sigA.dir }); t.path = [...cA.edges]; // standing on the wrong main
  assert.equal(isWrongMain(S, t), true); assert.deepEqual(wrongMainTrains(S), [t]);
  assert.equal(setRoute(S, sigB.id, cB.exitNode).reason, 'wrong main');
  const next = S.signalAt.get(`${headNode(S, t)}:${t.dir}`), cN = S.routesFrom.get(next).find(c => c.wrongMain);
  if (cN) assert.equal(setRoute(S, next, cN.exitNode, { trainId: t.id }).ok, true, 'the wrong-main train may continue'); }
// an untaken human wrong-main route counts as a wrong-main train: a wrong-main route at another signal is refused
{ const S = createSim(L, 'wmh'), G = S.layout;
  const [sigA, sigB] = G.signals.filter(s => S.routesFrom.get(s.id).some(c => c.wrongMain));
  const wm = sig => S.routesFrom.get(sig.id).find(c => c.wrongMain).exitNode;
  assert.equal(setRoute(S, sigA.id, wm(sigA), { human: true }).ok, true);
  assert.equal(setRoute(S, sigB.id, wm(sigB)).reason, 'wrong main'); }
// signalLabel unique over 50 seeds
for (let i = 0; i < 50; i++) { const S = createSim(generate(`lab${i}`), 'x'); const ls = S.layout.signals.map(s => signalLabel(S, s.id)); assert.equal(new Set(ls).size, ls.length, `lab${i}`); }

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
  for (let sig = S4.signalAt.get(`${entryPortalNode(S4, dir)}:${dir}`); sig !== null;) {
    const c = S4.routesFrom.get(sig).find(plain);
    chain.push(set(sig, c));
    sig = c.exitSignal;
  }
  assert.ok(chain.length >= 3 && exitNodes(S4, dir).includes(chain.at(-1).cand.exitNode));
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
const exitW = exitNodes(S, W)[0];
assert.equal(S.trains.get(X.id), X);
assert.deepEqual(X, { id: X.id, name: 'X 101', type: 'X', dir: W, prio: 5, len: trainLength('X'), maxSpeed: 60 * MPH,
  path: [], routes: [], pathOff: 0, headDist: 0, speed: 0, state: 'entering', dest: null, goal: { exit: true }, dwellUntil: 0,
  holdFor: null, spawnTime: S.time, sched: S.time, lastMoveTime: S.time, stops: 0, stalled: false, events: [] });
assert.equal(headNode(S, X), entryPortalNode(S, W));
assert.deepEqual(trainBlocks(S, X), [], 'nothing on the board before its first route');

// set the straight route from the portal signal and every onward straight main route by hand
const routes = [];
for (let sig = S.signalAt.get(`${entryPortalNode(S, W)}:${W}`); sig !== null;) {
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
    const portal = G.nodes[entryPortalNode(S, W)];
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
const pSig = S.signalAt.get(`${entryPortalNode(S, E)}:${E}`), pc = straightOf(pSig);
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
  const sig0 = S.signalAt.get(`${entryPortalNode(S, dir)}:${dir}`), c0 = straightOf(sig0), hs = c0.exitSignal;
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
assert.deepEqual(DWELL, { P: 3 * 60, L: 15 * 60, industry: 25 * 60 });

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
  const from = entryPortalNode(S, W), to = { exit: true };
  const straightW = sig => S.routesFrom.get(sig).find(k => !k.diverging && !k.slow);
  const ps = S.signalAt.get(`${from}:${W}`), c0 = straightW(ps), c = straightW(c0.exitSignal);
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
  const sig = S.signalAt.get(`${entryPortalNode(S, W)}:${W}`), far1 = S.routesFrom.get(sig)[0].exitSignal;
  const stray = setRoute(S, far1, S.routesFrom.get(far1)[0].exitNode, { trainId: T.id }).route;
  S.reserved.set(L.tracks[0].id, T.id);
  S.time += 600;
  despawnTrain(S, T);
  assert.ok(!S.routes.has(stray.id) && allClear(S));
  assert.equal(S.reserved.size, 0);
  assert.deepEqual(S.completed, [{ name: 'M 9', type: 'M', delay: 475, spawnTime: T.spawnTime, exitTime: S.time, stops: 0,
    distance: 0, events: [{ t: S.time, kind: 'out' }] }]);
  assert.equal(S.log.at(-1).text, `M 9 out via ${L.portals.find(p => p.dir === E).name} (+8 min)`);
}

// a human route that takes a train past its destination: it gives up the call (and its reservation) and runs out
{
  const S = createSim(L, 'missed');
  S.auto = true;
  S.nextSpawn = { 1: Infinity, '-1': Infinity }; // no traffic
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
  const pw = S.signalAt.get(`${entryPortalNode(S, W)}:${W}`), pe = S.signalAt.get(`${entryPortalNode(S, E)}:${E}`);
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
  S.nextSpawn = { 1: Infinity, '-1': Infinity }; // only the hand-made queue below
  const spur = G.tracks.find(t => t.cls === 'spur'), dir = spur.dir, q = S.queue[dir];
  const entry = (type, dest, name) => ({ id: S.nextTrainId++, name, type, dir, dest, len: trainLength(type), spawnTime: S.time, sched: S.time });
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
  S.nextSpawn = { 1: S.time, '-1': Infinity }; // one eastbound draw now
  const sig = S.signalAt.get(`${entryPortalNode(S, E)}:${E}`);
  const r = setRoute(S, sig, S.routesFrom.get(sig)[0].exitNode, { human: true }).route;
  step(S);
  assert.equal(S.trains.size, 1, 'a train entered past the human route on the portal edge');
  const T = [...S.trains.values()][0];
  step(S);
  assert.equal(r.trainId, T.id);
  assert.ok(T.routes.includes(r.id) && r.entered);
  // still refused while the portal edge is routed for another train
  const U = createSim(L, 'portal2');
  U.nextSpawn = { 1: U.time, '-1': Infinity };
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
      const h = r && (S.trains.get(U.holdFor) ?? S.queue[U.dir].find(q => q.id === U.holdFor));
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
  const S = busySim('lebanon');
  step(S);
  assert.equal(S.time, 6 * 3600 + 1);
  assert.equal(S.trains.size, 2, 'one train in from each portal');
  const names = [...S.trains.values()].map(t => [t.dir, Number(t.name.split(' ')[1])]);
  for (const [dir, n] of names) {
    assert.equal(n % 2, dir === E ? 0 : 1, 'even eastbound, odd westbound');
    assert.ok(n >= 100 && n <= 400);
  }
  assert.ok(S.log.some(e => / entered from /.test(e.text)));
}

// STALL: logged in AUTO only, once per stand; moving re-arms it. M 6 stands at signals whose routes are set for a
// train that isn't there (99), so neither it nor the operator can take them.
{
  const S = createSim(L, 'stall');
  S.nextSpawn = { 1: Infinity, '-1': Infinity }; // no traffic
  spawnTrain(S, { type: 'M', dir: E, name: 'M 6' });
  const ps = S.signalAt.get(`${entryPortalNode(S, E)}:${E}`);
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
    const sig = S.signalAt.get(`${entryPortalNode(S, dir)}:${dir}`);
    setRoute(S, sig, S.routesFrom.get(sig)[0].exitNode, { trainId: 99 }); // the portal edge is routed for another train
  }
  for (let i = 0; i < 3 * 3600; i++) step(S);
  assert.equal(S.trains.size, 0);
  assert.deepEqual([S.queue[1].length, S.queue[-1].length], [8, 8]);
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
  const names = S => [...S.queue[E], ...S.queue[W], ...S.trains.values(), ...S.completed].map(t => t.name).sort((a, b) => num(a) - num(b));
  assert.ok(names(S1).length >= 20);
  assert.deepEqual(names(S1), names(S2), 'traffic unchanged by slow orders');
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
// operator served long-standing trains first); never two trains on one edge, never a stall, and the spawn gate
// (a queued train with a destination enters only while that track is free, and reserves it)
const snap = S => JSON.stringify({ time: S.time, trains: [...S.trains.values()].map(t => [t.id, t.headDist, t.speed, t.state]), completed: S.completed });
const held = new Set(); // trains seen holding for an overtake, over all the seeds
let sawWrongMain = false;
for (const seed of ['lebanon', 's7', 's42', 's47']) {
  const S = busySim(seed), G = S.layout, dwelt = new Map();
  let entered = 0, wrongTicks = 0;
  for (let i = 0; i < 8 * 3600; i++) {
    // every train new after the step (queued earlier or drawn this very tick) is checked against the tracks before it
    const free = G.tracks.map(t => trackFree(S, t.id)), before = new Set(S.trains.keys());
    step(S);
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
    assert.ok(S.queue[1].length <= 8 && S.queue[-1].length <= 8, `${seed}: queue ${S.queue[1].length} / ${S.queue[-1].length}`);
    // traffic locking: no section holds trains of both directions; one wrong-main train at a time
    for (const [sec, es] of S.sectionEdges) {
      const dirs = new Set(es.flatMap(e => [...S.edgeState[e].occ].map(id => S.trains.get(id)?.dir)));
      dirs.delete(undefined);
      assert.ok(dirs.size <= 1, `${seed}: opposing trains in section ${sec}`);
    }
    assert.ok(S.slowOrder === null || S.sectionEdges.has(S.slowOrder.section), `${seed}: slow order off the mains`);
    const wrong = wrongMainTrains(S).length;
    assert.ok(wrong <= 1, `${seed}: two wrong-main trains`);
    if (wrong) { wrongTicks++; sawWrongMain = true; }
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
    assert.deepEqual(Object.keys(c).sort(), ['delay', 'distance', 'events', 'exitTime', 'name', 'spawnTime', 'stops', 'type']);
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
    assert.ok(P.events.filter(e => e.kind === 'route').every(e => /^[EW]\d+[A-Z]d?$/.test(e.signal)));
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
// module for good; the operator clears it after the 3-minute grace and traffic runs on. s91: a siding (nothing is
// ever bound for one); lebanon: a platform (P trains call there).
for (const [seed, cls] of [['s91', 'siding'], ['lebanon', 'platform']]) {
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
  S.nextSpawn = { 1: Infinity, '-1': Infinity }; // no traffic
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
  S.nextSpawn = { 1: Infinity, '-1': Infinity }; // no traffic
  const M = spawnTrain(S, { type: 'M', dir: E, name: 'M 2' }), ps = S.signalAt.get(`${entryPortalNode(S, E)}:${E}`);
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
  S.nextSpawn = { 1: Infinity, '-1': Infinity };
  for (const e of S.sectionEdges.get(G.edges[S.adj.get(exitNodes(S, E)[0])[0]].section)) S.edgeState[e].occ.add(999);
  const X = spawnTrain(S, { type: 'X', dir: E, name: 'X 6' }), pw = forwardEdges(S, entryPortalNode(S, W), W)[0];
  let q = null;
  for (let i = 0; i < 3600 && S.trains.has(X.id); i++) {
    step(S);
    assert.ok(S.edgeState.every(st => st.occ.size <= 1), 'two trains on one edge');
    if (q) assert.ok(!S.trains.has(q.id), 'the westbound entered under the eastbound');
    else if (X.path.includes(pw)) S.queue[W].push(q = { id: S.nextTrainId++, name: 'M 7', type: 'M', dir: W, dest: null,
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
  S.nextSpawn = { 1: Infinity, '-1': Infinity };
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
  const S = createSim(L, 'status'), G = S.layout, ps = S.signalAt.get(`${entryPortalNode(S, E)}:${E}`);
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

// over and back: an eastbound wrong-main train stands at Main 1's end of a module, an eastbound stood PASS_WAIT on Main 2
// past the next pair. findPath dips over that pair and back round it, which no candidate is (none uses two crossovers);
// the operator takes the candidate ending where the path's first leg does, straight on or home, this tick.
{
  const G = generate('s0'), S = createSim(G, 's0'), N = (x, y) => G.nodes.find(n => n.x === x && n.y === y).id;
  S.auto = true;
  S.nextSpawn = { 1: Infinity, '-1': Infinity };
  const on = (x1, x2, y) => G.edges.find(e => e.cls === 'main' && [e.a, e.b].every(n => G.nodes[n].y === y)
    && [e.a, e.b].map(n => G.nodes[n].x).sort((a, b) => a - b).join() === `${x1},${x2}`).id;
  const [m, m1] = G.modules, T1 = G.mainRow[W], T2 = G.mainRow[E], e0 = on(m.x1, m.x1 + 1, T1);
  const X = spawnTrain(S, { type: 'M', dir: E, name: 'M 2' }), Y = spawnTrain(S, { type: 'M', dir: E, name: 'M 4' });
  Object.assign(X, { path: [e0], headDist: G.edges[e0].len - FOUL, state: 'stopped' });
  Object.assign(Y, { path: [on(m1.x0, m1.x1, T2), on(m1.x1, m1.x1 + 1, T2)], lastMoveTime: S.time - 2 * PASS_WAIT, state: 'stopped' });
  Y.headDist = pathLength(S, Y) - FOUL;
  for (const t of [X, Y]) t.path.forEach(e => S.edgeState[e].occ.add(t.id));
  assert.ok(isWrongMain(S, X));
  const sig = S.signalAt.get(`${N(m.x1 + 1, T1)}:${E}`), cands = S.routesFrom.get(sig);
  const path = findPath(S, headNode(S, X), E, X.goal,
    { trainId: X.id, blockedCost: MOVING_COST, standingCost: STANDING_COST, wrongMainCost: WRONG_MAIN_COST });
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
  S.nextSpawn = { 1: Infinity, '-1': Infinity };
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
