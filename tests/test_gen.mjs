import assert from 'node:assert/strict';
import { generate, CAPACITY_MIN } from '../src/gen.js';
const seeds = ['', ' ', 'a', 'lebanon', '🚂', 'x'.repeat(500), ...Array.from({length:200},(_,i)=>`s${i}`)];
const byNum = (a, b) => a - b;
const open = (a0, a1, b0, b1) => Math.max(a0, b0) < Math.min(a1, b1); // open intervals overlap
for (const seed of seeds) {
  const L = generate(seed);
  const deg = new Map(); for (const e of L.edges) for (const n of [e.a,e.b]) deg.set(n,(deg.get(n)||0)+1);
  for (const [n,d] of deg) assert.ok(d<=3, `${seed}: node ${n} degree ${d}`);
  for (const e of L.edges) { const A=L.nodes[e.a],B=L.nodes[e.b]; assert.ok(Math.abs(A.x-B.x)>0 && (A.y===B.y || Math.abs(A.y-B.y)===Math.abs(A.x-B.x)), 'horizontal or 45°'); }
  // ids are array indices (later tasks index L.nodes[e.a] directly)
  for (const k of ['nodes', 'edges', 'signals', 'tracks']) L[k].forEach((o, i) => assert.equal(o.id, i, `${seed}: ${k}[${i}].id`));
  const adj = L.nodes.map(() => []); for (const e of L.edges) { adj[e.a].push(e); adj[e.b].push(e); }
  const far = (e, n) => L.nodes[e.a === n ? e.b : e.a];
  const segs = L.edges.map(e => { const A = L.nodes[e.a], B = L.nodes[e.b];
    return { e, A, x0: Math.min(A.x, B.x), x1: Math.max(A.x, B.x), y0: Math.min(A.y, B.y), y1: Math.max(A.y, B.y), slope: (B.y - A.y) / (B.x - A.x) }; });
  for (const p of segs) for (const q of segs) {
    if (p.e.id >= q.e.id) continue;
    // no diamond: no two diagonal edges with opposite slopes in the same column pair and overlapping rows
    if (p.slope && p.slope === -q.slope) assert.ok(!(open(p.x0, p.x1, q.x0, q.x1) && open(p.y0, p.y1, q.y0, q.y1)), `${seed}: diamond at edges ${p.e.id}/${q.e.id}`);
    // no overlap: no two horizontal edges on the same row with overlapping open x-intervals
    if (!p.slope && !q.slope && p.y0 === q.y0) assert.ok(!open(p.x0, p.x1, q.x0, q.x1), `${seed}: overlap at edges ${p.e.id}/${q.e.id}`);
  }
  // ...and no node sits inside an edge without being one of its ends
  for (const s of segs) for (const n of L.nodes) if (n.x > s.x0 && n.x < s.x1) assert.ok(n.y - s.A.y !== s.slope * (n.x - s.A.x), `${seed}: node ${n.id} inside edge ${s.e.id}`);
  // switches: each listed node has exactly 3 edges with trunk on one side, normal+reverse on the other
  for (const s of L.switches) {
    const n = L.nodes[s.node], side = id => Math.sign(far(L.edges[id], s.node).x - n.x);
    assert.deepEqual(adj[s.node].map(e => e.id).sort(byNum), [s.trunk, s.normal, s.reverse].sort(byNum), `${seed}: switch ${s.node} edges`);
    assert.ok(side(s.trunk) !== 0 && side(s.normal) === -side(s.trunk) && side(s.reverse) === side(s.normal), `${seed}: switch ${s.node} sides`);
    const t = far(L.edges[s.trunk], s.node), m = far(L.edges[s.normal], s.node); // normal continues the trunk's direction
    assert.ok(Math.sign(n.x - t.x) === Math.sign(m.x - n.x) && Math.sign(n.y - t.y) === Math.sign(m.y - n.y), `${seed}: switch ${s.node} normal leg`);
  }
  assert.deepEqual(L.switches.map(s => s.node).sort(byNum), [...deg].filter(([, d]) => d === 3).map(([n]) => n).sort(byNum), `${seed}: 3-edge nodes are exactly the switches`);
  const T = L.mainRow[-1]; assert.equal(L.mainRow[1], T + 2);
  const mains = L.edges.filter(e => e.cls === 'main'), cross = L.edges.filter(e => e.cls === 'crossover');
  for (const e of mains) { const y = L.nodes[e.a].y; assert.equal(y, L.nodes[e.b].y); assert.equal(e.main, y === T ? -1 : 1); assert.deepEqual(e.dirs, [1, -1]); assert.equal(typeof e.section, 'number'); }
  for (const e of L.edges) if (e.cls !== 'main') assert.equal(e.main, null), assert.equal(e.section, null);
  for (const e of cross) { assert.deepEqual(e.dirs, [1, -1]); assert.equal(Math.abs(L.nodes[e.a].x - L.nodes[e.b].x), 2); assert.deepEqual([L.nodes[e.a].y, L.nodes[e.b].y].sort(byNum), [T, T + 2]); assert.equal(e.speed, 30); }
  // a section is a contiguous run on one row that splits exactly at switch nodes
  const swNodes = new Set(L.switches.map(s => s.node));
  for (const p of mains) for (const q of mains) if (p !== q && (p.b === q.a || p.a === q.b || p.a === q.a || p.b === q.b)) {
    const shared = [p.a, p.b].find(n => n === q.a || n === q.b);
    assert.equal(p.section === q.section, !swNodes.has(shared), `${seed}: section split at node ${shared}`);
  }
  // one pair per gap and margin, A then B
  const gaps = [[0, L.modules[0].x0], ...L.modules.slice(1).map((m, i) => [L.modules[i].x1, m.x0]), [L.modules.at(-1).x1, L.cols - 1]];
  assert.equal(cross.length, 2 * gaps.length);
  for (const [lo, hi] of gaps) {
    const inGap = cross.filter(e => L.nodes[e.a].x > lo && L.nodes[e.b].x > lo && L.nodes[e.a].x < hi && L.nodes[e.b].x < hi).sort((e, f) => Math.min(L.nodes[e.a].x, L.nodes[e.b].x) - Math.min(L.nodes[f.a].x, L.nodes[f.b].x));
    assert.equal(inGap.length, 2);
    const west = e => L.nodes[L.nodes[e.a].x < L.nodes[e.b].x ? e.a : e.b], east = e => L.nodes[L.nodes[e.a].x < L.nodes[e.b].x ? e.b : e.a];
    assert.deepEqual([west(inGap[0]).y, east(inGap[0]).y, west(inGap[1]).y, east(inGap[1]).y], [T, T + 2, T + 2, T]);
    assert.equal(west(inGap[1]).x, west(inGap[0]).x + 3);
  }
  for (const m of L.modules) for (const x of [m.x0 - 1, m.x1 + 1]) for (const y of [T, T + 2]) for (const d of [1, -1])
    assert.ok(L.signals.some(s => s.kind === 'high' && s.dir === d && L.nodes[s.node].x === x && L.nodes[s.node].y === y), `${seed}: signal ${d} at ${x},${y}`);
  for (const p of L.places) assert.equal(p.y, -1);
  // portals: the two entry portals, each carrying a signal for its direction
  const nodeAt = (x, y) => L.nodes.find(n => n.x === x && n.y === y).id;
  assert.deepEqual(L.portals.map(p => [L.nodes[p.node].x, L.nodes[p.node].y, p.dir]), [[0, L.mainRow[1], 1], [L.cols - 1, L.mainRow[-1], -1]], `${seed}: portals`);
  for (const p of L.portals) assert.ok(L.signals.some(s => s.node === p.node && s.dir === p.dir), `${seed}: no signal at portal ${p.name}`);
  const sigKeys = L.signals.map(s => `${s.node}:${s.dir}`);
  assert.equal(new Set(sigKeys).size, sigKeys.length, `${seed}: two signals share a node:dir`);
  // BFS following dirs, leaving each node only through edges on the far side (x increasing for +1)
  const reach = (start, dir) => {
    const nodes = new Set([start]), edges = new Set(), q = [start];
    while (q.length) { const id = q.shift();
      for (const e of adj[id]) { const o = far(e, id);
        if (!e.dirs.includes(dir) || Math.sign(o.x - L.nodes[id].x) !== dir) continue;
        edges.add(e.id); if (!nodes.has(o.id)) { nodes.add(o.id); q.push(o.id); } } }
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
    assert.ok(t.edges.every(e => L.edges[e].track === t.id && L.edges[e].dirs.join() === String(t.dir)), `${seed}: track ${t.name} edges`);
    // every track reachable (following dirs) from its direction's entry portal, and both far ends reachable from the track
    assert.ok(t.edges.every(e => fromPortal[t.dir].edges.has(e)), `${seed}: track ${t.name} unreachable from portal`);
    assert.ok(exitPortal[t.dir].every(n => reach(end, t.dir).nodes.has(n)), `${seed}: far end unreachable from track ${t.name}`);
    // for each track: capacity >= CAPACITY_MIN[cls]
    assert.ok(t.capacity >= CAPACITY_MIN[t.cls], `${seed}: track ${t.name} capacity ${t.capacity} < ${CAPACITY_MIN[t.cls]}`);
    // every track has exactly one signal of its dir at its exit end (one cell before the exit node)
    const sigs = L.signals.filter(s => s.dir === t.dir && tn.includes(s.node));
    assert.equal(sigs.length, 1, `${seed}: track ${t.name} has ${sigs.length} signals`);
    assert.equal(L.nodes[sigs[0].node].x, L.nodes[end].x - t.dir, `${seed}: track ${t.name} signal not at exit end`);
    assert.equal(sigs[0].kind, t.cls === 'platform' ? 'high' : 'dwarf', `${seed}: track ${t.name} signal kind`);
  }
  // deterministic
  assert.equal(JSON.stringify(generate(seed)), JSON.stringify(L), `${seed}: not deterministic`);
}
console.log('gen ok', seeds.length);
