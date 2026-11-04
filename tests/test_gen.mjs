import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate, CAPACITY_MIN, CLASS_SPEED } from '../src/gen.js';
import { createSim, findPath } from '../src/sim.js';
const seeds = ['', ' ', 'a', 'lebanon', '🚂', 'x'.repeat(500), ...Array.from({length:300},(_,i)=>`s${i}`)];
const byNum = (a, b) => a - b;
// r against the line p->q (sign of the cross product); r inside the box of p, q (for r collinear with them)
const orient = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
const within = (p, q, r) => Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
// the closed segments AB and CD share a point
const meet = (A, B, C, D) => {
  const o1 = orient(A, B, C), o2 = orient(A, B, D), o3 = orient(C, D, A), o4 = orient(C, D, B);
  return (o1 !== o2 && o3 !== o4) || (!o1 && within(A, B, C)) || (!o2 && within(A, B, D)) || (!o3 && within(C, D, A)) || (!o4 && within(C, D, B));
};
for (const seed of seeds) {
  const L = generate(seed), W = L.wye, F = L.fan;
  const deg = new Map(); for (const e of L.edges) for (const n of [e.a,e.b]) deg.set(n,(deg.get(n)||0)+1);
  for (const [n,d] of deg) assert.ok(d<=3, `${seed}: node ${n} degree ${d}`);
  assert.equal(deg.size, L.nodes.length, `${seed}: a node without an edge`);
  // every edge horizontal, vertical (the stem) or 45°, its len the distance along it, its speed its class's
  for (const e of L.edges) {
    const A = L.nodes[e.a], B = L.nodes[e.b], dx = Math.abs(A.x - B.x), dy = Math.abs(A.y - B.y);
    assert.ok(dx + dy > 0 && (dx === 0 || dy === 0 || dx === dy), `${seed}: edge ${e.id} horizontal, vertical or 45°`);
    assert.ok(Math.abs(e.len - (dx === 0 ? dy : dy ? dx * Math.SQRT2 : dx)) < 1e-12, `${seed}: edge ${e.id} len ${e.len}`);
    assert.equal(e.speed, CLASS_SPEED[e.cls], `${seed}: edge ${e.id} speed`);
  }
  // ids are array indices (later tasks index L.nodes[e.a] directly)
  for (const k of ['nodes', 'edges', 'signals', 'tracks', 'portals']) L[k].forEach((o, i) => assert.equal(o.id, i, `${seed}: ${k}[${i}].id`));
  const adj = L.nodes.map(() => []); for (const e of L.edges) { adj[e.a].push(e); adj[e.b].push(e); }
  const far = (e, n) => L.nodes[e.a === n ? e.b : e.a];
  // no crossing: two edges meet only at a node they share (the legs, the stem and every diagonal included), and two
  // edges at one node never run over each other (no overlap, no node inside an edge, no diamond)
  for (const p of L.edges) for (const q of L.edges) {
    if (p.id >= q.id) continue;
    const shared = [p.a, p.b].filter(n => n === q.a || n === q.b);
    assert.ok(shared.length <= 1, `${seed}: edges ${p.id}/${q.id} join the same two nodes`);
    if (!shared.length) { assert.ok(!meet(L.nodes[p.a], L.nodes[p.b], L.nodes[q.a], L.nodes[q.b]), `${seed}: edges ${p.id}/${q.id} cross`); continue; }
    const S = L.nodes[shared[0]], P = far(p, S.id), Q = far(q, S.id);
    assert.ok(orient(S, P, Q) !== 0 || (P.x - S.x) * (Q.x - S.x) + (P.y - S.y) * (Q.y - S.y) < 0, `${seed}: edges ${p.id}/${q.id} overlap at node ${S.id}`);
  }
  // switches: each listed node has exactly 3 edges. Trunk: the one whose direction has a negative dot product with
  // both others; normal: the leg nearer the trunk's continuation, on a tie (the wye apex) the one further west.
  const wyeNodes = new Set(W ? [W.F1, W.F2, W.A] : []);
  for (const s of L.switches) {
    const n = L.nodes[s.node], side = id => Math.sign(far(L.edges[id], s.node).x - n.x);
    assert.deepEqual(adj[s.node].map(e => e.id).sort(byNum), [s.trunk, s.normal, s.reverse].sort(byNum), `${seed}: switch ${s.node} edges`);
    const v = id => { const o = far(L.edges[id], s.node), l = Math.hypot(o.x - n.x, o.y - n.y); return [(o.x - n.x) / l, (o.y - n.y) / l]; };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1], [t, m, r] = [s.trunk, s.normal, s.reverse].map(v);
    assert.ok(dot(t, m) < 0 && dot(t, r) < 0 && dot(m, r) >= 0, `${seed}: switch ${s.node} trunk`);
    const dm = -dot(t, m), dr = -dot(t, r);
    assert.ok(dm > dr + 1e-9 || (Math.abs(dm - dr) <= 1e-9 && far(L.edges[s.normal], s.node).x < far(L.edges[s.reverse], s.node).x), `${seed}: switch ${s.node} normal`);
    if (wyeNodes.has(s.node)) continue; // the feet and the apex: below
    // every other switch as before the wye: trunk on one x-side, both legs on the other, normal continuing the trunk
    assert.ok(side(s.trunk) !== 0 && side(s.normal) === -side(s.trunk) && side(s.reverse) === side(s.normal), `${seed}: switch ${s.node} sides`);
    const tn = far(L.edges[s.trunk], s.node), mn = far(L.edges[s.normal], s.node);
    assert.ok(Math.sign(n.x - tn.x) === Math.sign(mn.x - n.x) && Math.sign(n.y - tn.y) === Math.sign(mn.y - n.y), `${seed}: switch ${s.node} normal leg`);
  }
  assert.deepEqual(L.switches.map(s => s.node).sort(byNum), [...deg].filter(([, d]) => d === 3).map(([n]) => n).sort(byNum), `${seed}: 3-edge nodes are exactly the switches`);
  const T = L.mainRow[-1]; assert.equal(L.mainRow[1], T + 2);
  const mains = L.edges.filter(e => e.cls === 'main'), cross = L.edges.filter(e => e.cls === 'crossover');
  for (const e of mains) { const y = L.nodes[e.a].y; assert.equal(y, L.nodes[e.b].y); assert.equal(e.main, y === T ? -1 : 1); assert.equal(e.oneWay, null); assert.equal(typeof e.section, 'number'); }
  const own = e => e.cls === 'wye' || e.cls === 'branch' || (e.cls === 'platform' && L.tracks[e.track]?.stub === true); // the wye's own edges: its branch section
  const inFan = e => !!F && ['lead', 'stub'].includes(e.cls) && L.nodes[e.a].x > F.x0 && L.nodes[e.a].x < F.x1; // the fan's: its section
  for (const e of L.edges) if (e.cls !== 'main') { assert.equal(e.main, null); if (!own(e) && !inFan(e)) assert.equal(e.section, null); }
  for (const e of cross) { assert.equal(e.oneWay, null); assert.equal(Math.abs(L.nodes[e.a].x - L.nodes[e.b].x), 2); assert.deepEqual([L.nodes[e.a].y, L.nodes[e.b].y].sort(byNum), [T, T + 2]); assert.equal(e.speed, 30); }
  // a section is a contiguous run on one row that splits exactly at crossover-end nodes (not at the wye's feet)
  const xoNodes = new Set(cross.flatMap(e => [e.a, e.b]));
  for (const p of mains) for (const q of mains) if (p !== q && (p.b === q.a || p.a === q.b || p.a === q.a || p.b === q.b)) {
    const shared = [p.a, p.b].find(n => n === q.a || n === q.b);
    assert.equal(p.section === q.section, !xoNodes.has(shared), `${seed}: section split at node ${shared}`);
  }
  // one pair per gap and margin, A then B (the wye gap and the fan gap have two: checked below)
  const gaps = [[0, L.modules[0].x0], ...L.modules.slice(1).map((m, i) => [L.modules[i].x1, m.x0]), [L.modules.at(-1).x1, L.cols - 1]];
  assert.equal(cross.length, 2 * gaps.length + (W ? 2 : 0) + (F ? 2 : 0));
  for (const [lo, hi] of gaps) {
    if ((W && lo === L.modules[W.gap].x1) || (F && lo === L.modules[F.gap].x1)) continue;
    const inGap = cross.filter(e => L.nodes[e.a].x > lo && L.nodes[e.b].x > lo && L.nodes[e.a].x < hi && L.nodes[e.b].x < hi).sort((e, f) => Math.min(L.nodes[e.a].x, L.nodes[e.b].x) - Math.min(L.nodes[f.a].x, L.nodes[f.b].x));
    assert.equal(inGap.length, 2);
    const west = e => L.nodes[L.nodes[e.a].x < L.nodes[e.b].x ? e.a : e.b], east = e => L.nodes[L.nodes[e.a].x < L.nodes[e.b].x ? e.b : e.a];
    assert.deepEqual([west(inGap[0]).y, east(inGap[0]).y, west(inGap[1]).y, east(inGap[1]).y], [T, T + 2, T + 2, T]);
    assert.equal(west(inGap[1]).x, west(inGap[0]).x + 3);
  }
  for (const m of L.modules) for (const x of [m.x0 - 1, m.x1 + 1]) for (const y of [T, T + 2]) for (const d of [1, -1])
    assert.ok(L.signals.some(s => s.kind === 'high' && s.dir === d && L.nodes[s.node].x === x && L.nodes[s.node].y === y), `${seed}: signal ${d} at ${x},${y}`);
  for (const p of L.places) assert.equal(p.y, -1);
  // portals: the two entry portals (and a junction's branch portal, below; a terminus has none), each carrying a signal for its
  // direction
  const nodeAt = (x, y) => L.nodes.find(n => n.x === x && n.y === y)?.id;
  assert.deepEqual(L.portals.slice(0, 2).map(p => [L.nodes[p.node].x, L.nodes[p.node].y, p.dir]), [[0, L.mainRow[1], 1], [L.cols - 1, L.mainRow[-1], -1]], `${seed}: portals`);
  for (const p of L.portals) assert.ok(L.signals.some(s => s.node === p.node && s.dir === p.dir), `${seed}: no signal at portal ${p.name}`);
  assert.deepEqual(L.portals.map(p => [p.id, p.side]), [[0, 'west'], [1, 'east'], ...(W?.kind === 'junction' ? [[2, W.side]] : [])], `${seed}: portal ids and sides`);
  // oneWay: null (both ways) or one of the edge's own nodes; the old x-sign dirs list is gone
  for (const e of L.edges) {
    assert.ok(e.oneWay === null || e.oneWay === e.a || e.oneWay === e.b, `${seed}: edge ${e.id} oneWay ${e.oneWay}`);
    assert.ok(!('dirs' in e), `${seed}: edge ${e.id} still carries dirs`);
  }
  // the x direction a train travels a one-way edge in (entered from its oneWay node); null both ways
  const oneWayDir = e => (e.oneWay === null ? null : Math.sign(far(e, e.oneWay).x - L.nodes[e.oneWay].x));
  // a signal faces the unique edge a train of its dir arrives on (from the side opposite its dir); portal signals face
  // none; the wye's dir 0 signals (stem, shunt, stub) are checked with the wye
  const portalNodes = new Set(L.portals.map(p => p.node));
  for (const s of L.signals) {
    const n = L.nodes[s.node], arriving = adj[s.node].filter(e => Math.sign(far(e, s.node).x - n.x) === -s.dir);
    if (portalNodes.has(s.node)) { assert.equal(s.from, null, `${seed}: portal signal ${s.id} from`); continue; }
    if (s.dir === 0) continue;
    assert.equal(arriving.length, 1, `${seed}: signal ${s.id} has ${arriving.length} arriving edges`);
    assert.equal(s.from, arriving[0].id, `${seed}: signal ${s.id} from`);
    assert.notEqual(L.edges[s.from].oneWay, s.node, `${seed}: signal ${s.id} faces an edge that only leaves its node`);
  }
  const sigKeys = L.signals.map(s => `${s.node}:${s.dir}`);
  assert.equal(new Set(sigKeys).size, sigKeys.length, `${seed}: two signals share a node:dir`);
  // Forward walk (spec "Forward edges") from start, arrived at by edge from (null at a portal): never back along the
  // arriving edge, only the way oneWay allows, never against dir in x (an edge with dx 0 is neutral), and at a switch
  // only trunk <-> leg.
  const swAt = new Map(L.switches.map(s => [s.node, s]));
  const reach = (start, dir, from = null) => {
    const nodes = new Set([start]), edges = new Set(), seen = new Set(), q = [[start, from]];
    while (q.length) {
      const [id, by] = q.shift(), sw = by === null ? null : swAt.get(id);
      if (seen.has(`${id}:${by}`)) continue;
      seen.add(`${id}:${by}`);
      for (const e of adj[id]) {
        const o = far(e, id);
        if (e.id === by || (e.oneWay !== null && e.oneWay !== id) || (o.x - L.nodes[id].x) * dir < 0
          || (sw && (e.id === sw.trunk) === (by === sw.trunk))) continue;
        edges.add(e.id); nodes.add(o.id); q.push([o.id, e.id]);
      }
    }
    return { nodes, edges };
  };
  // a train leaves at the far end on either main
  const exitPortal = { 1: [nodeAt(L.cols - 1, T), nodeAt(L.cols - 1, T + 2)], '-1': [nodeAt(0, T), nodeAt(0, T + 2)] };
  const fromPortal = { 1: reach(L.portals[0].node, 1), '-1': reach(L.portals[1].node, -1) };
  for (const d of [1, -1]) for (const n of exitPortal[d]) assert.ok(fromPortal[d].nodes.has(n), `${seed}: far end ${n} unreachable from portal ${d}`);
  // track names are distinct (stubs and spur stubs included)
  assert.equal(new Set(L.tracks.map(t => t.name)).size, L.tracks.length, `${seed}: two tracks share a name`);
  // at least one module of kind station or yard
  assert.ok(L.modules.some(m => m.kind === 'station' || m.kind === 'yard'), `${seed}: no station or yard`);
  for (const t of L.tracks) {
    // an industrial stub's last edge is its buffer edge, horizontal, ending (b) at the degree-1 buffer: cutBlocks, the
    // renderer's bufferBar and its name rule read it so
    const buf = t.cls === 'stub' && L.edges[t.edges.at(-1)];
    assert.ok(!buf || (adj[buf.b].length === 1 && L.nodes[buf.a].y === L.nodes[buf.b].y), `${seed}: stub ${t.name}'s buffer edge`);
    if (t.stub) continue; // a stub, the terminus's or an industrial one (a fan's or a spur's): dir 0, both ways (below)
    const tn = [...new Set(t.edges.flatMap(e => [L.edges[e].a, L.edges[e].b]))];
    const end = tn.reduce((m, n) => (L.nodes[n].x - L.nodes[m].x) * t.dir > 0 ? n : m); // exit-end node
    assert.ok(t.edges.every(e => L.edges[e].track === t.id && oneWayDir(L.edges[e]) === t.dir), `${seed}: track ${t.name} edges`);
    // every track reachable (following oneWay) from its direction's entry portal, and both far ends reachable from the track
    assert.ok(t.edges.every(e => fromPortal[t.dir].edges.has(e)), `${seed}: track ${t.name} unreachable from portal`);
    assert.ok(exitPortal[t.dir].every(n => reach(end, t.dir, t.edges.at(-1)).nodes.has(n)), `${seed}: far end unreachable from track ${t.name}`);
    // for each track: capacity >= CAPACITY_MIN[cls]
    assert.ok(t.capacity >= CAPACITY_MIN[t.cls], `${seed}: track ${t.name} capacity ${t.capacity} < ${CAPACITY_MIN[t.cls]}`);
    // every track has exactly one signal of its dir at its exit end (one cell before the exit node)
    const sigs = L.signals.filter(s => s.dir === t.dir && tn.includes(s.node));
    assert.equal(sigs.length, 1, `${seed}: track ${t.name} has ${sigs.length} signals`);
    assert.equal(L.nodes[sigs[0].node].x, L.nodes[end].x - t.dir, `${seed}: track ${t.name} signal not at exit end`);
    assert.equal(sigs[0].kind, t.cls === 'platform' ? 'high' : 'dwarf', `${seed}: track ${t.name} signal kind`);
  }
  if (!W) {
    assert.equal(L.wye, null, `${seed}: wye`);
    assert.ok(L.edges.every(e => !('junction' in e)), `${seed}: junction tag without a wye`);
  } else {
    // The wye (spec "The wye (geometry)"), in the gap east of module W.gap; b = its x1 + 1 (W.x0), b' = W.x1, columns from b:
    // junction  pair b+1..b+6 | b+7 empty | F1 = b+8, A = b+10, F2 = b+12 | b+13 empty | pair b+14..b+19 | b' = b+20
    // terminus  pair b+1..b+6 | b+7 empty | P b+8 | run(7) | F1 = b+15, A = b+17, F2 = b+19 | run(7) | P b+26 | b+27 empty |
    //           pair b+28..b+33 | b' = b+34 (GAP_TERM 36: symmetric about the apex)
    const term = W.kind === 'terminus', K = term ? { end: 34, F1: 15, pair: 28, mains: [1, 3, 4, 6, 8, 15, 19, 26, 28, 30, 31, 33] }
      : { end: 20, F1: 8, pair: 14, mains: [1, 3, 4, 6, 8, 12, 14, 16, 17, 19] };
    const b = W.x0, north = W.side === 'north', y = north ? T : T + 2, sy = north ? -1 : 1, xy = n => [L.nodes[n].x, L.nodes[n].y];
    const inside = n => L.nodes[n].x > b && L.nodes[n].x < b + K.end, pairOf = e => [e.a, e.b].sort(byNum).join();
    assert.ok(['junction', 'terminus'].includes(W.kind), `${seed}: wye kind ${W.kind}`);
    assert.ok(['north', 'south'].includes(W.side) && W.gap >= 0 && W.gap < L.modules.length - 1, `${seed}: wye side / gap`);
    assert.deepEqual([b, W.x1, L.modules[W.gap + 1].x0], [L.modules[W.gap].x1 + 1, b + K.end, b + K.end + 1], `${seed}: wye gap columns`);
    assert.deepEqual([xy(W.F1), xy(W.F2), xy(W.A)], [[b + K.F1, y], [b + K.F1 + 4, y], [b + K.F1 + 2, y + 2 * sy]], `${seed}: feet and apex`);
    assert.equal(W.feetMain, north ? -1 : 1);
    for (const row of [T, T + 2]) // main nodes in the gap: the pairs' ends, the feet (and a terminus's P) columns, on both mains
      assert.deepEqual(L.nodes.filter(n => n.y === row && inside(n.id)).map(n => n.x).sort(byNum),
        K.mains.map(k => b + k), `${seed}: main nodes in the wye gap, row ${row}`);
    const ends = e => [L.nodes[e.a], L.nodes[e.b]].sort((p, q) => p.x - q.x).flatMap(p => [p.x, p.y]);
    assert.deepEqual(cross.filter(e => inside(e.a)).map(ends).sort((p, q) => p[0] - q[0]),
      [[b + 1, T, b + 3, T + 2], [b + 4, T + 2, b + 6, T], [b + K.pair, T, b + K.pair + 2, T + 2], [b + K.pair + 3, T + 2, b + K.pair + 5, T]],
      `${seed}: the wye gap's two pairs`);
    // legs: 45°, class wye, both ways
    const legs = L.edges.filter(e => e.cls === 'wye');
    assert.deepEqual(legs.map(pairOf).sort(), [[W.F1, W.A], [W.F2, W.A]].map(([p, q]) => [p, q].sort(byNum).join()).sort(), `${seed}: legs`);
    for (const e of legs) assert.ok(e.oneWay === null && e.track === null && e.speed === 30 && Math.abs(e.len - 2 * Math.SQRT2) < 1e-12, `${seed}: leg ${e.id}`);
    // the stem (junction) or stub (terminus): vertical from A away from the main, one edge per node
    const vert = L.edges.filter(e => own(e) && e.cls !== 'wye'), sameCol = e => L.nodes[e.a].x === b + K.F1 + 2 && L.nodes[e.b].x === b + K.F1 + 2;
    assert.ok(vert.length && vert.every(sameCol), `${seed}: the ${term ? 'stub' : 'stem'} runs straight up or down from the apex`);
    // sections: legs and stem (or stub) one section, after the main sections, that no main edge has
    const bs = new Set([...legs, ...vert].map(e => e.section));
    assert.equal(bs.size, 1, `${seed}: branch sections`);
    assert.equal([...bs][0], Math.max(...mains.map(e => e.section)) + 1, `${seed}: branch section id`);
    // junction: exactly the main edges strictly between b and b', both mains (the runs and the pieces inside the pairs too)
    for (const e of L.edges) assert.equal(e.junction === true, e.cls === 'main' && inside(e.a) && inside(e.b), `${seed}: edge ${e.id} junction`);
    // the feet: trunk the main edge away from the other foot, normal the main; the apex: trunk the stem (stub), and on the
    // dot-product tie (both legs 45° off it) the west leg is normal
    const sw = n => L.switches.find(s => s.node === n);
    const mainAt = (n, dx) => adj[n].find(e => e.cls === 'main' && Math.sign(far(e, n).x - L.nodes[n].x) === dx).id;
    const leg = (n, f) => adj[n].find(e => e.cls === 'wye' && (f === undefined || far(e, n).id === f)).id;
    assert.deepEqual(sw(W.F1), { node: W.F1, trunk: mainAt(W.F1, -1), normal: mainAt(W.F1, 1), reverse: leg(W.F1) }, `${seed}: F1 switch`);
    assert.deepEqual(sw(W.F2), { node: W.F2, trunk: mainAt(W.F2, 1), normal: mainAt(W.F2, -1), reverse: leg(W.F2) }, `${seed}: F2 switch`);
    assert.deepEqual(sw(W.A), { node: W.A, trunk: adj[W.A].find(e => e.cls !== 'wye').id, normal: leg(W.A, W.F1), reverse: leg(W.A, W.F2) },
      `${seed}: apex switch (tie-break: the west leg is normal)`);
    const names = [...L.modules.map(m => m.name), ...L.portals.map(p => p.name), ...L.tracks.map(t => t.name)];
    if (!term) {
      // padding: the apex two rows off the main, the stem at least four cells to the panel edge
      if (north) assert.ok(T >= 6, `${seed}: T ${T}`); else assert.ok(L.rows - 1 - (T + 2) >= 6, `${seed}: rows ${L.rows}`);
      // the stem: vertical from A to the panel edge, one branch edge per cell, the branch portal at its end
      const end = north ? 0 : L.rows - 1, cells = Math.abs(end - L.nodes[W.A].y);
      assert.ok(cells >= 4, `${seed}: stem ${cells} cells`);
      const stemNodes = [W.A, ...Array.from({ length: cells }, (_, k) => nodeAt(b + 10, L.nodes[W.A].y + (k + 1) * sy))];
      assert.ok(stemNodes.every(n => n !== undefined), `${seed}: stem nodes`);
      const stem = L.edges.filter(e => e.cls === 'branch');
      assert.deepEqual(stem.map(pairOf).sort(), stemNodes.slice(1).map((n, k) => [n, stemNodes[k]].sort(byNum).join()).sort(), `${seed}: stem edges`);
      assert.deepEqual(vert, stem, `${seed}: the branch section is the legs and the stem`);
      for (const e of stem) assert.ok(e.oneWay === null && e.track === null && e.speed === 45 && e.len === 1, `${seed}: stem edge ${e.id}`);
      const P = L.portals[2], place = P.name.replace(/ Branch$/, '');
      assert.deepEqual(P, { id: 2, node: stemNodes.at(-1), name: `${place} Branch`, dir: 0, side: W.side }, `${seed}: branch portal`);
      assert.equal(W.portal, 2);
      assert.equal(adj[P.node].length, 1, `${seed}: the branch portal ends the stem`);
      assert.equal(names.filter(s => s.includes(place)).length, 1, `${seed}: branch place ${place} already used`);
      // signals: inside the gap only the stem signal (one cell before the apex, facing down the stem from the portal) and
      // the portal signal, both dir 0
      const pSig = L.signals.find(s => s.node === P.node), ss = L.signals[W.stemSignal];
      assert.deepEqual(L.signals.filter(s => inside(s.node)).map(s => s.id).sort(byNum), [W.stemSignal, pSig.id].sort(byNum), `${seed}: signals inside the junction`);
      assert.deepEqual([ss.node, ss.dir, ss.kind, ss.from], [stemNodes[1], 0, 'high', adj[stemNodes[1]].find(e => far(e, stemNodes[1]).id === stemNodes[2]).id], `${seed}: stem signal`);
      assert.deepEqual([pSig.dir, pSig.from, pSig.kind], [0, null, 'high'], `${seed}: branch portal signal`);
      // from the branch portal both far ends (east for +1, west for -1); the branch from each main portal for its dir
      for (const d of [1, -1]) {
        for (const n of exitPortal[d]) assert.ok(reach(P.node, d).nodes.has(n), `${seed}: far end ${n} unreachable from the branch for ${d}`);
        assert.ok(fromPortal[d].nodes.has(P.node), `${seed}: the branch unreachable from portal ${d}`);
      }
    } else {
      // padding: the apex two rows off the main, then S and the 7-cell stub: the buffer at least 10 rows off the main
      if (north) assert.ok(T >= 10, `${seed}: T ${T}`); else assert.ok(L.rows - 1 - (T + 2) >= 10, `${seed}: rows ${L.rows}`);
      assert.equal(L.portals.length, 2, `${seed}: a terminus has no branch portal`);
      assert.ok(!('portal' in W) && !('stemSignal' in W), `${seed}: terminus wye keys`);
      // the pull-ahead columns: P = b+8 and b+26 on both mains carry a high signal each way (like a module boundary), and
      // W.P names the one on the feet's main a train pulls ahead to, per arrival dir (east of F2 eastbound)
      for (const x of [b + 8, b + 26]) for (const row of [T, T + 2]) for (const d of [1, -1])
        assert.ok(L.signals.some(s => s.node === nodeAt(x, row) && s.dir === d && s.kind === 'high'), `${seed}: pull-ahead signal ${d} at ${x},${row}`);
      assert.deepEqual(W.P, { 1: nodeAt(b + 26, y), '-1': nodeAt(b + 8, y) }, `${seed}: pull-ahead nodes`);
      // the runs: one 7-cell main edge from each P to its foot, on both mains
      for (const row of [T, T + 2]) for (const [p, q] of [[b + 8, b + 15], [b + 19, b + 26]]) {
        const run = adj[nodeAt(p, row)].find(e => far(e, nodeAt(p, row)).id === nodeAt(q, row));
        assert.ok(run && run.cls === 'main' && run.len === 7, `${seed}: run ${p}..${q} on row ${row}`);
      }
      // shunt signals: at F1 facing east (from the west run), at F2 facing west (from the east run), dir 0
      const sh = k => L.signals[W.shunt[k]];
      assert.deepEqual([sh('F1').node, sh('F1').from, sh('F1').dir, sh('F1').kind], [W.F1, mainAt(W.F1, -1), 0, 'shunt'], `${seed}: shunt signal at F1`);
      assert.deepEqual([sh('F2').node, sh('F2').from, sh('F2').dir, sh('F2').kind], [W.F2, mainAt(W.F2, 1), 0, 'shunt'], `${seed}: shunt signal at F2`);
      // the stub: S one cell off the apex away from the main, the buffer 7 further (8 cells from A), two platform edges
      const S = nodeAt(b + 17, L.nodes[W.A].y + sy), buf = nodeAt(b + 17, L.nodes[W.A].y + 8 * sy), t = L.tracks[W.stub];
      assert.ok(S !== undefined && buf !== undefined, `${seed}: stub nodes`);
      const eAS = adj[W.A].find(e => far(e, W.A).id === S), eSB = adj[S].find(e => far(e, S).id === buf);
      assert.ok(eAS && eSB, `${seed}: stub edges`);
      assert.deepEqual(vert.map(e => e.id).sort(byNum), [eAS.id, eSB.id].sort(byNum), `${seed}: the branch section is the legs and the stub`);
      for (const e of [eAS, eSB]) assert.ok(e.cls === 'platform' && e.oneWay === null && e.main === null && e.track === W.stub, `${seed}: stub edge ${e.id}`);
      assert.equal(eAS.len + eSB.len, 8, `${seed}: stub 8 cells from the apex to the buffer`);
      const place = t.name.replace(/ Union 1$/, '');
      assert.deepEqual(t, { id: W.stub, cls: 'platform', dir: 0, name: `${place} Union 1`, stub: true, edges: [eAS.id, eSB.id], capacity: 6.5, industry: null },
        `${seed}: stub track`);
      assert.ok(place && !place.includes(' ') && names.filter(s => s.includes(place)).length === 1, `${seed}: stub place ${place} already used`);
      assert.equal(adj[buf].length, 1, `${seed}: the buffer stop ends the stub`);
      // the stub's exit signal: at S, dir 0, facing the apex (a train leaving the stub arrives at S from the buffer side)
      assert.deepEqual(L.signals[W.stubSignal], { id: W.stubSignal, node: S, from: eSB.id, dir: 0, kind: 'high' }, `${seed}: stub signal`);
      // no other signal inside the gap: the P columns', the two shunts and the stub's
      const ps = L.signals.filter(s => [b + 8, b + 26].includes(L.nodes[s.node].x) && [T, T + 2].includes(L.nodes[s.node].y)).map(s => s.id);
      assert.deepEqual(L.signals.filter(s => inside(s.node)).map(s => s.id).sort(byNum), [...ps, W.shunt.F1, W.shunt.F2, W.stubSignal].sort(byNum),
        `${seed}: signals inside the terminus gap`);
      // reachable: the stub from each main portal for its dir by the near leg (a walk that does not stop at signals, so the
      // shunts are transparent), never by the far one; both far ends from the stub signal
      for (const [d, near, other] of [[1, W.F1, W.F2], [-1, W.F2, W.F1]]) {
        const fp = fromPortal[d].edges;
        assert.ok([leg(W.A, near), eAS.id, eSB.id].every(e => fp.has(e)) && !fp.has(leg(W.A, other)), `${seed}: the stub from portal ${d} by the near leg`);
        for (const n of exitPortal[d]) assert.ok(reach(S, d, eSB.id).nodes.has(n), `${seed}: far end ${n} unreachable from the stub for ${d}`);
      }
    }
  }
  const xy = n => [L.nodes[n].x, L.nodes[n].y], between = (p, q) => adj[p].find(e => far(e, p).id === q);
  const sg = id => [L.signals[id].node, L.signals[id].from, L.signals[id].dir, L.signals[id].kind];
  if (!F) assert.equal(L.fan, null, `${seed}: fan`);
  else {
    // The fan (spec "The fan (geometry)"), columns from b = F.x0 for a north fan; a south fan is the mirror about the
    // gap's centre (fx), its rows below Main 2. P b+8 and X b+15 on the lead's main, the pairs at b+1 and b+17, Lt b+17 and
    // J b+20 two rows off the main, stub i from its ladder node Ki (K0 = J) at b+20+i, i rows further, Si one cell on, Bi 7
    // further; b' = b+31 (two stubs) or b+32 (three).
    const b = F.x0, E = F.x1 - b, north = F.side === 'north', fx = k => (north ? b + k : b + E - k), y = north ? T : T + 2, sy = north ? -1 : 1;
    const insideF = n => L.nodes[n].x > b && L.nodes[n].x < F.x1;
    assert.ok(['north', 'south'].includes(F.side) && [2, 3].includes(F.count), `${seed}: fan side / count`);
    assert.ok(F.gap >= 0 && F.gap < L.modules.length - 1 && F.gap !== W?.gap, `${seed}: fan gap ${F.gap}`);
    assert.deepEqual([b, E, L.modules[F.gap + 1].x0], [L.modules[F.gap].x1 + 1, F.count + 29, L.modules[F.gap].x1 + { 2: 33, 3: 34 }[F.count]], `${seed}: fan gap columns`);
    assert.equal(F.main, north ? -1 : 1);
    if (north) assert.ok(T >= F.count + 1, `${seed}: T ${T}`); else assert.ok(L.rows - 1 - (T + 2) >= F.count + 1, `${seed}: rows ${L.rows}`);
    assert.deepEqual([xy(F.P), xy(F.X), xy(F.Lt), xy(F.J)], [[fx(8), y], [fx(15), y], [fx(17), y + 2 * sy], [fx(20), y + 2 * sy]], `${seed}: P, X, Lt, J`);
    const pairsAt = [1, 17].map(k => Math.min(fx(k), fx(k + 5))).sort(byNum);
    for (const row of [T, T + 2]) // main nodes in the gap: the pairs' ends, P and X, on both mains
      assert.deepEqual(L.nodes.filter(n => n.y === row && insideF(n.id)).map(n => n.x).sort(byNum),
        [fx(8), fx(15), ...pairsAt.flatMap(a => [a, a + 2, a + 3, a + 5])].sort(byNum), `${seed}: main nodes in the fan gap, row ${row}`);
    const ends = e => [L.nodes[e.a], L.nodes[e.b]].sort((p, q) => p.x - q.x).flatMap(p => [p.x, p.y]);
    assert.deepEqual(cross.filter(e => insideF(e.a)).map(ends).sort((p, q) => p[0] - q[0]),
      pairsAt.flatMap(a => [[a, T, a + 2, T + 2], [a + 3, T + 2, a + 5, T]]), `${seed}: the fan gap's two pairs`);
    // the run P-X: one 7-cell main edge; the lead X-Lt (45°) and Lt-J (3 cells), the ladder cells, the stubs' two edges each
    const run = between(F.P, F.X), lead = [between(F.X, F.Lt), between(F.Lt, F.J)], ladder = [], stubSigs = [];
    assert.ok(run && run.cls === 'main' && run.len === 7 && run.main === F.main, `${seed}: run P-X`);
    assert.ok(lead.every(Boolean) && Math.abs(lead[0].len - 2 * Math.SQRT2) < 1e-12 && lead[1].len === 3, `${seed}: lead`);
    assert.equal(F.stubs.length, F.count, `${seed}: fan stubs`);
    const stubEdges = F.stubs.flatMap((id, i) => {
      const row = y + (2 + i) * sy, k = i ? nodeAt(fx(20 + i), row) : F.J, S = nodeAt(fx(21 + i), row), B = nodeAt(fx(28 + i), row);
      assert.ok([k, S, B].every(n => n !== undefined), `${seed}: stub ${i} nodes`);
      if (i) ladder.push(between(nodeAt(fx(19 + i), row - sy), k)); // up from K(i-1)
      const eKS = between(k, S), eSB = between(S, B), t = L.tracks[id];
      assert.ok(eKS && eSB && eKS.len === 1 && eSB.len === 7 && adj[B].length === 1, `${seed}: stub ${i} edges, buffer`);
      assert.deepEqual(t, { id, cls: 'stub', dir: 0, name: t.name, stub: true, edges: [eKS.id, eSB.id], capacity: 6.5, industry: t.industry }, `${seed}: stub ${i} track`);
      stubSigs.push({ node: S, from: eSB.id, B });
      return [eKS, eSB];
    });
    assert.ok(ladder.every(e => e && Math.abs(e.len - Math.SQRT2) < 1e-12), `${seed}: ladder cells`);
    const fanEdges = [...lead, ...ladder, ...stubEdges];
    assert.deepEqual(fanEdges.map(e => e.id).sort(byNum), L.edges.filter(inFan).map(e => e.id).sort(byNum), `${seed}: the fan's edges`);
    for (const e of fanEdges) assert.ok(e.oneWay === null && e.cls === (stubEdges.includes(e) ? 'stub' : 'lead') && e.speed === 15, `${seed}: fan edge ${e.id}`);
    // one section, after the mains' and the wye's, that no main edge has
    const fs = [...new Set(fanEdges.map(e => e.section))];
    assert.deepEqual(fs, [Math.max(...L.edges.filter(e => e.cls === 'main' || own(e)).map(e => e.section)) + 1], `${seed}: the fan section`);
    // switches: X's trunk the run, normal the main onward, reverse the lead; J's trunk the straight, K1's the cell below it
    const sw = n => L.switches.find(s => s.node === n), onward = adj[F.X].find(e => e.cls === 'main' && e !== run);
    assert.deepEqual(sw(F.X), { node: F.X, trunk: run.id, normal: onward.id, reverse: lead[0].id }, `${seed}: X switch`);
    assert.equal(sw(F.J).trunk, lead[1].id, `${seed}: J switch`);
    if (F.count === 3) assert.equal(sw(nodeAt(fx(21), y + 3 * sy)).trunk, ladder[0].id, `${seed}: K1 switch`);
    // signals: P both ways on both mains; X and J shunts, Lt and each Si dwarfs, all dir 0; nothing else inside the gap
    for (const row of [T, T + 2]) for (const d of [1, -1])
      assert.ok(L.signals.some(s => s.node === nodeAt(fx(8), row) && s.dir === d && s.kind === 'high'), `${seed}: P signal ${d} on row ${row}`);
    assert.deepEqual(sg(F.shunt.X), [F.X, run.id, 0, 'shunt'], `${seed}: X shunt`);
    assert.deepEqual(sg(F.shunt.J), [F.J, lead[1].id, 0, 'shunt'], `${seed}: J shunt`);
    assert.deepEqual(sg(F.leadSignal), [F.Lt, lead[1].id, 0, 'dwarf'], `${seed}: Lt dwarf`);
    const si = stubSigs.map(({ node, from }) => { const s = L.signals.find(g => g.node === node); assert.deepEqual(sg(s.id), [node, from, 0, 'dwarf'], `${seed}: stub signal`); return s.id; });
    const ps = L.signals.filter(s => L.nodes[s.node].x === fx(8)).map(s => s.id);
    assert.deepEqual(L.signals.filter(s => insideF(s.node)).map(s => s.id).sort(byNum), [...ps, F.shunt.X, F.shunt.J, F.leadSignal, ...si].sort(byNum),
      `${seed}: signals inside the fan gap`);
    // names: '<Place> Industrial' on the label row over the fan; the stubs by industry, keys distinct from the spurs'
    const place = F.name.replace(/ Industrial$/, ''), inds = F.stubs.map(id => L.tracks[id].industry);
    assert.ok(place && !place.includes(' ') && F.name === `${place} Industrial`, `${seed}: fan name ${F.name}`);
    assert.ok(F.stubs.every((id, i) => L.tracks[id].name === inds[i].label && inds[i].label.startsWith(`${place} `)), `${seed}: stub names`);
    const keys = [...inds, ...L.tracks.filter(t => t.cls === 'spur').map(t => t.industry)].map(d => d.key);
    assert.equal(new Set(keys).size, keys.length, `${seed}: industries shared`);
    assert.ok(L.places.some(p => p.name === F.name && p.y === -1 && p.x === (fx(15) + fx(27 + F.count)) / 2), `${seed}: fan label`);
    // the sim's routes: X's shunt and J's to every buffer (X keeps its main-onward ones too), Lt's down the lead to P's
    // signal; every stub reachable from X reversed, none from the serving portal head first
    const S = createSim(L, seed);
    for (const g of [F.shunt.X, F.shunt.J]) for (const { B } of stubSigs)
      assert.equal(S.routesFrom.get(g).filter(c => c.exitNode === B).length, 1, `${seed}: one route from signal ${g} to buffer ${B}`);
    const out = S.routesFrom.get(F.leadSignal);
    assert.ok(out.length === 1 && out[0].exitNode === F.P && out[0].exitSignal === L.signals.find(s => s.node === F.P && s.from === run.id)?.id, `${seed}: Lt's route`);
    for (const id of F.stubs) assert.ok(findPath(S, F.X, -F.main, { track: id }, {}, run.id), `${seed}: stub ${id} from X reversed`);
    const served = S.reach.tracks[`${L.portals.find(p => p.dir === F.main).id}:${F.main}`];
    assert.ok(F.stubs.every(id => !served.has(id)), `${seed}: a stub reachable from the serving portal`);
  }
  // Spur stubs (spec "The spur stub (geometry)"): Xs 7 cells upstream of the spur's exit signal splits its entry edge; Q one
  // 45° cell back and one row deeper, Sq one cell on, Bq 9 columns back of Xs; the row otherwise empty in the module.
  const base = L.spurStubs.length ? generate(seed, { industrial: false }) : null;
  for (const ss of L.spurStubs) {
    const sp = L.tracks[ss.spur], st = L.tracks[ss.stub], d = sp.dir, sig = L.signals.find(s => s.dir === d && sp.edges.includes(s.from));
    const [sx, y] = xy(sig.node), [e0, e1] = sp.edges.map(e => L.edges[e]);
    assert.ok(sp.cls === 'spur' && sp.stubOf === ss.stub && st.spur === ss.spur, `${seed}: spur stub links`);
    assert.ok(sp.edges.length === 3 && sig.from === e1.id, `${seed}: spur ${sp.name} edges`);
    assert.deepEqual(xy(ss.Xs), [sx - 7 * d, y], `${seed}: Xs`);
    assert.ok([e0.a, e0.b].includes(ss.Xs) && [e1.a, e1.b].includes(ss.Xs) && [e1.a, e1.b].includes(sig.node), `${seed}: spur edges at Xs`);
    const Q = nodeAt(sx - 8 * d, y + d), Sq = nodeAt(sx - 9 * d, y + d), Bq = nodeAt(sx - 16 * d, y + d);
    assert.equal(Math.abs(y + d - L.mainRow[d]), Math.abs(y - L.mainRow[d]) + 1, `${seed}: the stub one row deeper`);
    assert.ok([Q, Sq, Bq].every(n => n !== undefined) && adj[Bq].length === 1, `${seed}: spur stub nodes`);
    const eXQ = between(ss.Xs, Q), eQS = between(Q, Sq), eSB = between(Sq, Bq);
    assert.ok(eXQ && eXQ.cls === 'lead' && eXQ.oneWay === null && eXQ.section === null && eXQ.track === null, `${seed}: Xs-Q`);
    for (const e of [eQS, eSB]) assert.ok(e && e.cls === 'stub' && e.oneWay === null && e.section === null && e.track === ss.stub, `${seed}: spur stub edge`);
    assert.deepEqual(st, { id: ss.stub, cls: 'stub', dir: 0, name: st.name, stub: true, edges: [eQS.id, eSB.id], capacity: 6.5, industry: sp.industry, spur: ss.spur },
      `${seed}: spur stub track`);
    assert.deepEqual(sg(ss.shunt), [ss.Xs, e1.id, 0, 'shunt'], `${seed}: Xs shunt`);
    assert.deepEqual(sg(L.signals.find(s => s.node === Sq).id), [Sq, eSB.id, 0, 'dwarf'], `${seed}: Sq dwarf`);
    // capacity: entry to signal less half a cell, as without industry (plus the module's widening for the stub, if any)
    const m = L.modules.find(o => o.x0 <= sx && sx <= o.x1), bm = base.modules[L.modules.indexOf(m)], i = Math.abs(y - L.mainRow[d]);
    assert.equal(sp.capacity, e0.len + e1.len - 0.5, `${seed}: spur ${sp.name} capacity`);
    assert.equal(sp.capacity, base.tracks.find(t => t.name === sp.name).capacity + (m.x1 - m.x0) - (bm.x1 - bm.x0), `${seed}: spur ${sp.name} capacity vs base`);
    assert.deepEqual(L.nodes.filter(n => n.y === y + d && n.x >= m.x0 && n.x <= m.x1).map(n => n.id).sort(byNum), [Q, Sq, Bq].sort(byNum), `${seed}: the stub's row`);
    assert.ok(m.x1 - m.x0 >= 2 * i + 17, `${seed}: module ${m.name} width ${m.x1 - m.x0} for a stub spur on row ${i}`);
  }
  // byte-identical without industry (spec "Builder check" 1): the knob off gives this very layout when it drew none
  if (!F && !L.tracks.some(t => 'stubOf' in t)) assert.deepEqual(generate(seed, { industrial: false }), L, `${seed}: industrial knob`);
  // deterministic
  assert.equal(JSON.stringify(generate(seed)), JSON.stringify(L), `${seed}: not deterministic`);
}
// s0..s199 (spec "Tests"): fans on both sides with both counts, spur stubs on both sides; never a fan in the wye's gap,
// and none when the wye takes a two-module terminal's one gap.
const s200 = Array.from({ length: 200 }, (_, i) => generate(`s${i}`)), fans = s200.map(G => G.fan).filter(Boolean);
assert.ok(fans.length >= 50, `${fans.length} fan layouts in s0..s199`);
assert.deepEqual([...new Set(fans.map(f => f.side))].sort(), ['north', 'south'], 'both sides occur for a fan');
assert.deepEqual([...new Set(fans.map(f => f.count))].sort(byNum), [2, 3], 'both stub counts occur');
const stubbed = s200.filter(G => G.spurStubs.length);
assert.ok(stubbed.length >= 40, `${stubbed.length} spur-stub layouts in s0..s199`);
assert.deepEqual([...new Set(stubbed.flatMap(G => G.spurStubs.map(s => G.tracks[s.spur].dir)))].sort(byNum), [-1, 1], 'spur stubs on both sides');
assert.ok(s200.every(G => !G.fan || G.fan.gap !== G.wye?.gap), 'a fan in the wye gap');
const twoWye = s200.filter(G => G.modules.length === 2 && G.wye);
assert.ok(twoWye.length && twoWye.every(G => G.fan === null), 'a fan with a wye in the only gap');
// About 60 % of seeds grow a wye, on either side; a fair coin makes it a junction or a terminus.
const wyes = Array.from({ length: 100 }, (_, i) => generate(`s${i}`).wye).filter(Boolean);
assert.ok(wyes.length >= 40, `${wyes.length} wye layouts in s0..s99`);
const kinds = k => wyes.filter(w => w.kind === k);
for (const k of ['junction', 'terminus']) {
  assert.ok(kinds(k).length >= 15, `${kinds(k).length} ${k} layouts in s0..s99`);
  assert.deepEqual([...new Set(kinds(k).map(w => w.side))].sort(), ['north', 'south'], `both sides occur for a ${k}`);
}
// Frozen layouts (tools/freeze-layouts.mjs, from the generator before oneWay/from): same lists, with the
// old dirs string standing in for oneWay ('1-1' both ways; '1' entered from the west node, '-1' from the east).
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/layouts.json', import.meta.url), 'utf8'));
for (const [seed, fx] of Object.entries(fixtures)) {
  const L = generate(seed, { industrial: false });
  assert.equal(L.wye, null, `${seed}: a fixture seed grew a wye`);
  assert.deepEqual(L.nodes.map(n => [n.x, n.y]), fx.nodes, `${seed}: fixture nodes`);
  assert.deepEqual(L.edges.map(e => [e.a, e.b, e.cls, e.track, e.main, e.section]),
    fx.edges.map(([a, b, cls, , track, main, section]) => [a, b, cls, track, main, section]), `${seed}: fixture edges`);
  fx.edges.forEach(([a, b, , dirs], i) => {
    const [w, e] = L.nodes[a].x < L.nodes[b].x ? [a, b] : [b, a];
    assert.equal(L.edges[i].oneWay, { '1-1': null, 1: w, '-1': e }[dirs], `${seed}: edge ${i} oneWay (old dirs ${dirs})`);
  });
  assert.deepEqual(L.switches.map(s => [s.node, s.trunk, s.normal, s.reverse]), fx.switches, `${seed}: fixture switches`);
  assert.deepEqual(L.tracks.map(t => [t.id, t.cls, t.name, t.dir, t.edges, t.capacity]), fx.tracks, `${seed}: fixture tracks`);
  assert.deepEqual(L.signals.map(s => [s.node, s.dir, s.kind]), fx.signals, `${seed}: fixture signals`);
  assert.deepEqual(L.portals.map(p => [p.node, p.name, p.dir]), fx.portals, `${seed}: fixture portals`);
}
// Frozen industrial layouts (tools/freeze-layouts.mjs): the whole layout of a north two-stub fan (s7), a south three-stub
// fan (s5) and a spur stub on each side (s3).
const industrial = JSON.parse(readFileSync(new URL('./fixtures/layouts-industrial.json', import.meta.url), 'utf8'));
for (const [seed, fx] of Object.entries(industrial)) assert.deepEqual(JSON.parse(JSON.stringify(generate(seed))), fx, `${seed}: industrial fixture`);
console.log('gen ok', seeds.length, 'fixtures', Object.keys(fixtures).length, '+', Object.keys(industrial).length, 'industrial, wyes in s0..s99', wyes.length,
  `(${kinds('junction').length} junction, ${kinds('terminus').length} terminus); in s0..s199 ${fans.length} fans,`, stubbed.length, 'with spur stubs');
