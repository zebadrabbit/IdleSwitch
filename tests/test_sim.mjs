import assert from 'node:assert/strict';
import { generate } from '../src/gen.js';
import { createSim, setRoute, cancelRoute, throwSwitch, forwardEdges, findPath, switchLocked,
  releaseEdge, sectionalRelease, entryPortalNode, exitPortalNode } from '../src/sim.js';

// ---- Task 3: interlocking core
const L = generate('lebanon');
assert.ok(L.modules.some(m => m.kind === 'station'), 'lebanon has a station (no seed loop needed)');
const sim = createSim(L, 'lebanon');
const W = -1, E = 1;
const SLOW = ['yard', 'siding', 'spur'];
const farOf = (G, e, n) => { const ed = G.edges[e]; assert.ok(ed.a === n || ed.b === n, `edge ${e} not at node ${n}`); return ed.a === n ? ed.b : ed.a; };
const walk = (G, from, es) => es.reduce((ns, e) => [...ns, farOf(G, e, ns.at(-1))], [from]); // node ids along an edge list
const allClear = S => S.routes.size === 0 && S.edgeState.every(s => s.route === null && s.occ.size === 0);

// fresh sim shape
assert.equal(sim.time, 6 * 3600);
assert.deepEqual(sim.log, []);
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

// portals and forwardEdges: x rule plus dirs (Main 1 runs westbound only even though it has east neighbours)
assert.deepEqual([E, W].map(d => entryPortalNode(sim, d)), [L.portals.find(p => p.dir === E).node, L.portals.find(p => p.dir === W).node]);
assert.deepEqual([L.nodes[exitPortalNode(sim, E)].x, L.nodes[exitPortalNode(sim, E)].y], [L.cols - 1, L.rows - 1]);
assert.deepEqual([L.nodes[exitPortalNode(sim, W)].x, L.nodes[exitPortalNode(sim, W)].y], [0, 0]);
for (const d of [E, W]) {
  assert.equal(forwardEdges(sim, entryPortalNode(sim, d), d).length, 1);
  assert.deepEqual(forwardEdges(sim, exitPortalNode(sim, d), d), []);
  assert.deepEqual(forwardEdges(sim, exitPortalNode(sim, d), -d), [], 'mains are one-way (dirs), though x allows it');
}

// every signal has >= 1 candidate; candidates end at a node that has a signal of that dir or is the exit portal
for (const seed of ['lebanon', ...Array.from({ length: 50 }, (_, i) => `s${i}`)]) {
  const S = seed === 'lebanon' ? sim : createSim(generate(seed), seed), G = S.layout;
  const swAt = new Map(G.switches.map(s => [s.node, s]));
  for (const sig of G.signals) {
    const cs = S.routesFrom.get(sig.id);
    assert.ok(cs.length >= 1, `${seed}: signal ${sig.id} has no candidates`);
    for (const c of cs) {
      const ns = walk(G, sig.node, c.edges), last = G.edges[c.edges.at(-1)];
      ns.slice(1).forEach((n, i) => assert.equal(Math.sign(G.nodes[n].x - G.nodes[ns[i]].x), sig.dir, `${seed}: candidate runs against dir`));
      assert.ok(c.edges.every(e => G.edges[e].dirs.includes(sig.dir)), `${seed}: candidate uses an edge against its dirs`);
      assert.equal(c.exitNode, ns.at(-1));
      const exitSig = S.signalAt.get(`${c.exitNode}:${sig.dir}`) ?? null;
      assert.equal(c.exitSignal, exitSig);
      if (exitSig === null) assert.equal(c.exitNode, exitPortalNode(S, sig.dir), `${seed}: candidate ends at neither a signal nor the exit portal`);
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
assert.deepEqual(R0, { id: R0.id, signal: portalSig, cand: c0, trainId: null, human: false, entered: false });
assert.equal(sim.routes.get(R0.id), R0);
assert.ok(c0.edges.every(e => sim.edgeState[e].route === R0.id));
assert.deepEqual(setRoute(sim, portalSig, entryPortalNode(sim, W)), { ok: false, reason: 'no such route' });
assert.deepEqual(setRoute(sim, portalSig, c0.exitNode), { ok: false, reason: 'already set' });

// a second setRoute over a shared edge -> {ok:false, reason:'locked'}. No other candidate can reach the
// portal's one-edge route, so the shared-edge pair is the next route on: the home signal's straight run
// through the first module, and a route from another signal that merges into it (a track exit).
const home = c0.exitSignal;
const c1 = straight(home);
r = setRoute(sim, home, c1.exitNode, { human: true });
assert.equal(r.ok, true);
const R1 = r.route;
assert.equal(R1.human, true);
assert.notEqual(R1.id, R0.id);
let other = null;
for (const [sig, cs] of sim.routesFrom) for (const c of cs)
  if (!other && sig !== home && c.edges.some(e => c1.edges.includes(e))) other = { sig, c };
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

// a switch lying wrong and held by an edge outside the route -> 'switch busy'
const swDef = L.switches.find(s => s.node === sw.node);
const flank = [swDef.trunk, swDef.normal, swDef.reverse].find(e => !c1.edges.includes(e));
sim.edgeState[flank].occ.add(98);
assert.deepEqual(setRoute(sim, home, c1.exitNode), { ok: false, reason: 'switch busy' });
sim.edgeState[flank].occ.delete(98);

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

// findPath from west entry portal to the east exit portal node returns edges with strictly increasing x
const p = findPath(sim, entryPortalNode(sim, E), E, { node: exitPortalNode(sim, E) });
assert.ok(p && p.length > 0);
const pn = walk(L, entryPortalNode(sim, E), p);
pn.slice(1).forEach((n, i) => assert.ok(L.nodes[n].x > L.nodes[pn[i]].x, 'x strictly increasing'));
assert.equal(pn.at(-1), exitPortalNode(sim, E));

// findPath to {track: id of first platform} ends inside that track's edges (at its first edge)
const plat = L.tracks.find(t => t.cls === 'platform');
const pp = findPath(sim, entryPortalNode(sim, plat.dir), plat.dir, { track: plat.id });
assert.ok(pp && plat.edges.includes(pp.at(-1)));
assert.equal(pp.at(-1), plat.edges[0]);
walk(L, entryPortalNode(sim, plat.dir), pp); // contiguous from the portal
assert.equal(findPath(sim, entryPortalNode(sim, -plat.dir), -plat.dir, { track: plat.id }), null, 'wrong-way platform unreachable');

// a manually occupied edge (edgeState[e].occ.add(99)) makes setRoute over it return reason 'occupied' and findPath avoid it
const busy = c1.edges.reduce((a, b) => (lenOf(b) > lenOf(a) ? b : a)); // the main through the first module
const from = entryPortalNode(sim, W), to = { node: exitPortalNode(sim, W) };
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
assert.equal(findPath(sim, from, W, to), null, 'the home signal has no way past a route held by someone else');
assert.equal(cancelRoute(sim, r.route.id), true);
assert.ok(allClear(sim));

console.log('sim core ok');
