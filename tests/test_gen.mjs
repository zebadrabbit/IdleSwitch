import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate, CAPACITY_MIN, CLASS_SPEED } from '../src/gen.js';
const seeds = ['', ' ', 'a', 'lebanon', '🚂', 'x'.repeat(500), ...Array.from({length:200},(_,i)=>`s${i}`)];
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
  const L = generate(seed), W = L.wye;
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
  for (const e of L.edges) if (e.cls !== 'main') { assert.equal(e.main, null); if (e.cls !== 'wye' && e.cls !== 'branch') assert.equal(e.section, null); }
  for (const e of cross) { assert.equal(e.oneWay, null); assert.equal(Math.abs(L.nodes[e.a].x - L.nodes[e.b].x), 2); assert.deepEqual([L.nodes[e.a].y, L.nodes[e.b].y].sort(byNum), [T, T + 2]); assert.equal(e.speed, 30); }
  // a section is a contiguous run on one row that splits exactly at crossover-end nodes (not at the wye's feet)
  const xoNodes = new Set(cross.flatMap(e => [e.a, e.b]));
  for (const p of mains) for (const q of mains) if (p !== q && (p.b === q.a || p.a === q.b || p.a === q.a || p.b === q.b)) {
    const shared = [p.a, p.b].find(n => n === q.a || n === q.b);
    assert.equal(p.section === q.section, !xoNodes.has(shared), `${seed}: section split at node ${shared}`);
  }
  // one pair per gap and margin, A then B (the wye gap has two: checked below)
  const gaps = [[0, L.modules[0].x0], ...L.modules.slice(1).map((m, i) => [L.modules[i].x1, m.x0]), [L.modules.at(-1).x1, L.cols - 1]];
  assert.equal(cross.length, 2 * gaps.length + (W ? 2 : 0));
  for (const [lo, hi] of gaps) {
    if (W && lo === L.modules[W.gap].x1) continue;
    const inGap = cross.filter(e => L.nodes[e.a].x > lo && L.nodes[e.b].x > lo && L.nodes[e.a].x < hi && L.nodes[e.b].x < hi).sort((e, f) => Math.min(L.nodes[e.a].x, L.nodes[e.b].x) - Math.min(L.nodes[f.a].x, L.nodes[f.b].x));
    assert.equal(inGap.length, 2);
    const west = e => L.nodes[L.nodes[e.a].x < L.nodes[e.b].x ? e.a : e.b], east = e => L.nodes[L.nodes[e.a].x < L.nodes[e.b].x ? e.b : e.a];
    assert.deepEqual([west(inGap[0]).y, east(inGap[0]).y, west(inGap[1]).y, east(inGap[1]).y], [T, T + 2, T + 2, T]);
    assert.equal(west(inGap[1]).x, west(inGap[0]).x + 3);
  }
  for (const m of L.modules) for (const x of [m.x0 - 1, m.x1 + 1]) for (const y of [T, T + 2]) for (const d of [1, -1])
    assert.ok(L.signals.some(s => s.kind === 'high' && s.dir === d && L.nodes[s.node].x === x && L.nodes[s.node].y === y), `${seed}: signal ${d} at ${x},${y}`);
  for (const p of L.places) assert.equal(p.y, -1);
  // portals: the two entry portals (and a junction's branch portal, below), each carrying a signal for its direction
  const nodeAt = (x, y) => L.nodes.find(n => n.x === x && n.y === y)?.id;
  assert.deepEqual(L.portals.slice(0, 2).map(p => [L.nodes[p.node].x, L.nodes[p.node].y, p.dir]), [[0, L.mainRow[1], 1], [L.cols - 1, L.mainRow[-1], -1]], `${seed}: portals`);
  for (const p of L.portals) assert.ok(L.signals.some(s => s.node === p.node && s.dir === p.dir), `${seed}: no signal at portal ${p.name}`);
  assert.deepEqual(L.portals.map(p => [p.id, p.side]), [[0, 'west'], [1, 'east'], ...(W ? [[2, W.side]] : [])], `${seed}: portal ids and sides`);
  // oneWay: null (both ways) or one of the edge's own nodes; the old x-sign dirs list is gone
  for (const e of L.edges) {
    assert.ok(e.oneWay === null || e.oneWay === e.a || e.oneWay === e.b, `${seed}: edge ${e.id} oneWay ${e.oneWay}`);
    assert.ok(!('dirs' in e), `${seed}: edge ${e.id} still carries dirs`);
  }
  // the x direction a train travels a one-way edge in (entered from its oneWay node); null both ways
  const oneWayDir = e => (e.oneWay === null ? null : Math.sign(far(e, e.oneWay).x - L.nodes[e.oneWay].x));
  // a signal faces the unique edge a train of its dir arrives on (from the side opposite its dir); portal signals face
  // none; the stem signal (dir 0) is checked with the wye
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
  // at least one module of kind station or yard
  assert.ok(L.modules.some(m => m.kind === 'station' || m.kind === 'yard'), `${seed}: no station or yard`);
  for (const t of L.tracks) {
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
    // The junction wye (spec "The wye (geometry)"): in the gap east of module W.gap, b = its x1 + 1 and b' = b + 20:
    // pair b+1..b+6 | b+7 empty | F1 = b+8, A = (b+10, two rows off the main), F2 = b+12 | b+13 empty | pair b+14..b+19.
    const b = W.x0, north = W.side === 'north', y = north ? T : T + 2, sy = north ? -1 : 1, xy = n => [L.nodes[n].x, L.nodes[n].y];
    const inside = n => L.nodes[n].x > b && L.nodes[n].x < b + 20;
    assert.equal(W.kind, 'junction');
    assert.ok(['north', 'south'].includes(W.side) && W.gap >= 0 && W.gap < L.modules.length - 1, `${seed}: wye side / gap`);
    assert.deepEqual([b, W.x1, L.modules[W.gap + 1].x0], [L.modules[W.gap].x1 + 1, b + 20, b + 21], `${seed}: wye gap columns`);
    assert.deepEqual([xy(W.F1), xy(W.F2), xy(W.A)], [[b + 8, y], [b + 12, y], [b + 10, y + 2 * sy]], `${seed}: feet and apex`);
    assert.equal(W.feetMain, north ? -1 : 1);
    for (const row of [T, T + 2]) // main nodes in the gap: the pairs' ends and the feet columns, on both mains
      assert.deepEqual(L.nodes.filter(n => n.y === row && inside(n.id)).map(n => n.x).sort(byNum),
        [1, 3, 4, 6, 8, 12, 14, 16, 17, 19].map(k => b + k), `${seed}: main nodes in the wye gap, row ${row}`);
    const ends = e => [L.nodes[e.a], L.nodes[e.b]].sort((p, q) => p.x - q.x).flatMap(p => [p.x, p.y]);
    assert.deepEqual(cross.filter(e => inside(e.a)).map(ends).sort((p, q) => p[0] - q[0]),
      [[b + 1, T, b + 3, T + 2], [b + 4, T + 2, b + 6, T], [b + 14, T, b + 16, T + 2], [b + 17, T + 2, b + 19, T]], `${seed}: the wye gap's two pairs`);
    // padding: the apex two rows off the main, the stem at least two cells to the panel edge
    if (north) assert.ok(T >= 4, `${seed}: T ${T}`); else assert.ok(L.rows - 1 - (T + 2) >= 4, `${seed}: rows ${L.rows}`);
    // legs: 45°, class wye, both ways
    const legs = L.edges.filter(e => e.cls === 'wye'), pairOf = e => [e.a, e.b].sort(byNum).join();
    assert.deepEqual(legs.map(pairOf).sort(), [[W.F1, W.A], [W.F2, W.A]].map(([p, q]) => [p, q].sort(byNum).join()).sort(), `${seed}: legs`);
    for (const e of legs) assert.ok(e.oneWay === null && e.track === null && e.speed === 30 && Math.abs(e.len - 2 * Math.SQRT2) < 1e-12, `${seed}: leg ${e.id}`);
    // the stem: vertical from A to the panel edge, one branch edge per cell, the branch portal at its end
    const end = north ? 0 : L.rows - 1, cells = Math.abs(end - L.nodes[W.A].y);
    assert.ok(cells >= 2, `${seed}: stem ${cells} cells`);
    const stemNodes = [W.A, ...Array.from({ length: cells }, (_, k) => nodeAt(b + 10, L.nodes[W.A].y + (k + 1) * sy))];
    assert.ok(stemNodes.every(n => n !== undefined), `${seed}: stem nodes`);
    const stem = L.edges.filter(e => e.cls === 'branch');
    assert.deepEqual(stem.map(pairOf).sort(), stemNodes.slice(1).map((n, k) => [n, stemNodes[k]].sort(byNum).join()).sort(), `${seed}: stem edges`);
    for (const e of stem) assert.ok(e.oneWay === null && e.track === null && e.speed === 45 && e.len === 1, `${seed}: stem edge ${e.id}`);
    const P = L.portals[2], place = P.name.replace(/ Branch$/, '');
    assert.deepEqual(P, { id: 2, node: stemNodes.at(-1), name: `${place} Branch`, dir: 0, side: W.side }, `${seed}: branch portal`);
    assert.equal(W.portal, 2);
    assert.equal(adj[P.node].length, 1, `${seed}: the branch portal ends the stem`);
    assert.ok(![...L.modules.map(m => m.name), ...L.portals.slice(0, 2).map(p => p.name), ...L.tracks.map(t => t.name)].some(s => s.includes(place)),
      `${seed}: branch place ${place} already used`);
    // signals: inside the gap only the stem signal (one cell before the apex, facing down the stem from the portal) and
    // the portal signal, both dir 0
    const pSig = L.signals.find(s => s.node === P.node), ss = L.signals[W.stemSignal];
    assert.deepEqual(L.signals.filter(s => inside(s.node)).map(s => s.id).sort(byNum), [W.stemSignal, pSig.id].sort(byNum), `${seed}: signals inside the junction`);
    assert.deepEqual([ss.node, ss.dir, ss.kind, ss.from], [stemNodes[1], 0, 'high', adj[stemNodes[1]].find(e => far(e, stemNodes[1]).id === stemNodes[2]).id], `${seed}: stem signal`);
    assert.deepEqual([pSig.dir, pSig.from, pSig.kind], [0, null, 'high'], `${seed}: branch portal signal`);
    // sections: legs and stem one section, after the main sections, that no main edge has
    const bs = new Set([...legs, ...stem].map(e => e.section));
    assert.equal(bs.size, 1, `${seed}: branch sections`);
    assert.equal([...bs][0], Math.max(...mains.map(e => e.section)) + 1, `${seed}: branch section id`);
    // junction: exactly the main edges strictly between b and b', both mains
    for (const e of L.edges) assert.equal(e.junction === true, e.cls === 'main' && inside(e.a) && inside(e.b), `${seed}: edge ${e.id} junction`);
    // the feet: trunk the main edge away from the other foot, normal the main; the apex: trunk the stem, and on the
    // dot-product tie (both legs 45° off the stem) the west leg is normal
    const sw = n => L.switches.find(s => s.node === n);
    const mainAt = (n, dx) => adj[n].find(e => e.cls === 'main' && Math.sign(far(e, n).x - L.nodes[n].x) === dx).id;
    const leg = (n, f) => adj[n].find(e => e.cls === 'wye' && (f === undefined || far(e, n).id === f)).id;
    assert.deepEqual(sw(W.F1), { node: W.F1, trunk: mainAt(W.F1, -1), normal: mainAt(W.F1, 1), reverse: leg(W.F1) }, `${seed}: F1 switch`);
    assert.deepEqual(sw(W.F2), { node: W.F2, trunk: mainAt(W.F2, 1), normal: mainAt(W.F2, -1), reverse: leg(W.F2) }, `${seed}: F2 switch`);
    assert.deepEqual(sw(W.A), { node: W.A, trunk: adj[W.A].find(e => e.cls === 'branch').id, normal: leg(W.A, W.F1), reverse: leg(W.A, W.F2) },
      `${seed}: apex switch (tie-break: the west leg is normal)`);
    // from the branch portal both far ends (east for +1, west for -1); the branch from each main portal for its dir
    for (const d of [1, -1]) {
      for (const n of exitPortal[d]) assert.ok(reach(P.node, d).nodes.has(n), `${seed}: far end ${n} unreachable from the branch for ${d}`);
      assert.ok(fromPortal[d].nodes.has(P.node), `${seed}: the branch unreachable from portal ${d}`);
    }
  }
  // deterministic
  assert.equal(JSON.stringify(generate(seed)), JSON.stringify(L), `${seed}: not deterministic`);
}
// About 60 % of seeds grow a junction wye, on either side.
const wyes = Array.from({ length: 100 }, (_, i) => generate(`s${i}`).wye).filter(Boolean);
assert.ok(wyes.length >= 40, `${wyes.length} wye layouts in s0..s99`);
assert.deepEqual([...new Set(wyes.map(w => w.side))].sort(), ['north', 'south'], 'both sides occur');
// Frozen layouts (tools/freeze-layouts.mjs, from the generator before oneWay/from): same lists, with the
// old dirs string standing in for oneWay ('1-1' both ways; '1' entered from the west node, '-1' from the east).
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/layouts.json', import.meta.url), 'utf8'));
for (const [seed, fx] of Object.entries(fixtures)) {
  const L = generate(seed);
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
console.log('gen ok', seeds.length, 'fixtures', Object.keys(fixtures).length, 'wyes in s0..s99', wyes.length);
