// Seeded terminal generator: seed string -> Layout (track graph, switches, signals, tracks, portals).
// Pure: never touches window, document, Math.random or Date; all randomness comes from makeRng(seed).
//
// Grid: x = column (west 0 .. east cols-1), y = row (0 at the top). Main 1 is row 0 and runs westbound
// (dir -1) only; Main 2 is row R and runs eastbound (dir +1) only. Each module hangs its westbound tracks
// off Main 1 (rows 1..kt) and its eastbound tracks off Main 2 (rows R-1 .. R-kb), each side with an
// entry ladder and an exit ladder. Ids are array indices: nodes[i].id === i, likewise edges/signals/tracks.
import { makeRng, pick, randInt } from './rng.js';

export const CLASS_SPEED = { main: 60, ladder: 30, platform: 30, yard: 15, siding: 15, spur: 15 };
export const CAPACITY_MIN = { platform: 6, yard: 12, siding: 14, spur: 14 };

const INDUSTRIES = [
  { key: 'coal', label: '… Power Plant', trainType: 'C' },
  { key: 'steel', label: '… Steel', trainType: 'M' },
  { key: 'grain', label: '… Elevator', trainType: 'G' },
  { key: 'intermodal', label: '… Intermodal', trainType: 'I' },
  { key: 'lumber', label: '… Lumber', trainType: 'M' },
  { key: 'auto', label: '… Assembly', trainType: 'M' },
  { key: 'oil', label: '… Terminal', trainType: 'M' },
];
// 6 x 4 syllables = 24 place names (Lebanon, Cornwall, Colebrook, Hartford, ...).
const PLACES = ['Leb', 'Corn', 'Cole', 'Ash', 'Hart', 'Stan'].flatMap(a => ['anon', 'wall', 'brook', 'ford'].map(b => a + b));
const PORTAL_SUFFIX = ['Jct', 'Yard', 'Mine'];
const KINDS = ['station', 'yard', 'sidings'];
const DWARF = new Set(['yard', 'siding', 'spur']); // tracks whose exit signal is a dwarf
const MARGIN = 3; // columns from a portal to the nearest module
const GAP = 4;    // columns between modules (x0 of the next = x1 of this + GAP)

const range = n => Array.from({ length: n }, (_, i) => i);

function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// At most one station and one yard, at least one of them, never two of a kind side by side.
function validMix(kinds) {
  const count = k => kinds.filter(x => x === k).length;
  return count('station') <= 1 && count('yard') <= 1 && count('sidings') < kinds.length &&
    kinds.every((k, i) => i === 0 || k !== kinds[i - 1]);
}

// A module's track list per side. top[i] sits on row i+1 (nearest Main 1 first); bot[j] on row R-(j+1)
// (nearest Main 2 first). Names run top-to-bottom across the module, as on a station diagram.
function planModule(rng, kind, place, sidingCount) {
  const t = (cls, name, industry = null) => ({ cls, name, industry });
  if (kind === 'station') {
    const name = place(), kt = randInt(rng, 1, 2), kb = randInt(rng, 1, 2);
    return { kind, name,
      top: range(kt).map(i => t('platform', String(i + 1))),
      bot: range(kb).map(j => t('platform', String(kt + kb - j))) };
  }
  if (kind === 'yard') {
    const name = `${place()} Yard`;
    const yt = randInt(rng, 1, 2), yb = randInt(rng, 1, 2);
    let st = randInt(rng, 0, 1), sb = randInt(rng, 0, 1);
    if (!st && !sb) { if (rng() < 0.5) st = 1; else sb = 1; } // every yard serves at least one industry
    const inds = shuffle(rng, INDUSTRIES); // two spurs never share an industry
    const spur = i => {
      const label = inds[i].label.replace('…', place());
      return t('spur', label, { key: inds[i].key, label, trainType: inds[i].trainType });
    };
    // Spurs sit deepest (furthest from their main), behind the yard tracks.
    return { kind, name,
      top: [...range(yt).map(i => t('yard', `Y${i + 1}`)), ...(st ? [spur(0)] : [])],
      bot: [...range(yb).map(j => t('yard', `Y${yt + yb - j}`)), ...(sb ? [spur(1)] : [])] };
  }
  // Sidings are numbered across the whole terminal so two siding groups never repeat a name.
  const n = sidingCount();
  return { kind, name: `${place()} Sidings`, top: [t('siding', `Siding ${n + 1}`)], bot: [t('siding', `Siding ${n + 2}`)] };
}

// Wide enough that row index i (1-based) still meets its floor: capacity = width - 2i - 1.5.
const width = m => Math.max(...[m.top, m.bot].flatMap(side =>
  side.map((t, i) => CAPACITY_MIN[t.cls] + 2 * (i + 1) + 2)));

export function generate(seed) {
  const rng = makeRng(seed);

  // --- plan: module mix, names, columns ---
  const n = randInt(rng, 2, 4);
  let kinds;
  // ponytail: rejection sampling; worst case (n=4) accepts ~7% of draws, so ~14 tries on average.
  // A constructive interleave would bound it, but nothing here is hot.
  do kinds = range(n).map(() => pick(rng, KINDS)); while (!validMix(kinds));
  const names = shuffle(rng, PLACES); // at most 2 portals + 4 modules + 2 industries = 8 of 24
  let ni = 0, sidings = 0;
  const place = () => names[ni++];
  const west = `${place()} ${pick(rng, PORTAL_SUFFIX)}`;
  const east = `${place()} ${pick(rng, PORTAL_SUFFIX)}`;
  const mods = kinds.map(kind => planModule(rng, kind, place, () => (sidings += 2) - 2));
  let x = MARGIN;
  for (const m of mods) { m.x0 = x; m.x1 = x + width(m); x = m.x1 + GAP; }
  const cols = mods[mods.length - 1].x1 + MARGIN + 1;
  const R = 1 + Math.max(...mods.map(m => m.top.length)) + Math.max(...mods.map(m => m.bot.length));

  // --- build: plain closures over flat arrays ---
  const nodes = [], edges = [], signals = [], tracks = [], at = new Map();
  const node = (x, y) => {
    const k = `${x},${y}`;
    if (!at.has(k)) { at.set(k, nodes.length); nodes.push({ id: nodes.length, x, y }); }
    return at.get(k);
  };
  const edge = (a, b, cls, dirs, track = null) => {
    const dx = Math.abs(nodes[a].x - nodes[b].x), diag = nodes[a].y !== nodes[b].y;
    edges.push({ id: edges.length, a, b, cls, dirs, speed: CLASS_SPEED[cls], len: diag ? dx * Math.SQRT2 : dx, track });
    return edges.length - 1;
  };
  const signal = (node, dir, kind) => signals.push({ id: signals.length, node, dir, kind });
  // k unit diagonals from (x,y) stepping (dx,dy); returns node ids, index i = row index i (0 = on the main).
  const ladder = (x, y, dx, dy, k, dir) => {
    const ns = [node(x, y)];
    for (let i = 1; i <= k; i++) { ns.push(node(x + i * dx, y + i * dy)); edge(ns[i - 1], ns[i], 'ladder', [dir]); }
    return ns;
  };

  // Mains: one node at each portal and at every module's ladder and signal columns, joined in order.
  // ponytail: no crossovers between the mains. Under directional running (Main 1 westbound only,
  // Main 2 eastbound only) a crossover is dead track no train may use. Bidirectional CTC would add
  // them back near both ends and at module boundaries.
  const xs = [0, cols - 1, ...mods.flatMap(m => [m.x0 - 1, m.x0, m.x1, m.x1 + 1])].sort((a, b) => a - b);
  for (const [y, dir] of [[0, -1], [R, 1]])
    for (let i = 1; i < xs.length; i++) edge(node(xs[i - 1], y), node(xs[i], y), 'main', [dir]);
  const portals = [
    { node: node(0, R), name: west, dir: 1 },          // eastbound enters at the west end of Main 2
    { node: node(cols - 1, 0), name: east, dir: -1 },  // westbound enters at the east end of Main 1
  ];
  for (const p of portals) signal(p.node, p.dir, 'high');

  // Track i of a side runs from its entry ladder node to its exit ladder node, with its signal node
  // one cell before the exit. Capacity counts entry -> signal, less half a cell of clearance.
  const side = (list, dir, entry, exit) => list.forEach((t, k) => {
    const id = tracks.length, a = entry[k + 1], b = exit[k + 1];
    const sig = node(nodes[b].x - dir, nodes[b].y);
    const e1 = edge(a, sig, t.cls, [dir], id), e2 = edge(sig, b, t.cls, [dir], id);
    signal(sig, dir, DWARF.has(t.cls) ? 'dwarf' : 'high');
    tracks.push({ id, cls: t.cls, name: t.name, dir, edges: [e1, e2], capacity: edges[e1].len - 0.5, industry: t.industry });
  });

  for (const m of mods) {
    const { x0, x1 } = m, kt = m.top.length, kb = m.bot.length;
    signal(node(x1 + 1, 0), -1, 'high'); // westbound entry (home) signal
    signal(node(x0 - 1, 0), -1, 'high'); // westbound exit
    signal(node(x0 - 1, R), 1, 'high');  // eastbound entry (home) signal
    signal(node(x1 + 1, R), 1, 'high');  // eastbound exit
    // Westbound: enter down the right-hand ladder, leave up the left-hand one. Eastbound mirrors.
    side(m.top, -1, ladder(x1, 0, -1, 1, kt, -1), ladder(x0, 0, 1, 1, kt, -1));
    side(m.bot, 1, ladder(x0, R, 1, -1, kb, 1), ladder(x1, R, -1, -1, kb, 1));
  }

  // Switches: every 3-edge node. Trunk = the lone edge on one side; normal = the leg that continues
  // the trunk's direction (main continues main, ladder continues ladder); reverse = the other leg.
  const inc = nodes.map(() => []);
  for (const e of edges) { inc[e.a].push(e); inc[e.b].push(e); }
  const far = (e, n) => nodes[e.a === n ? e.b : e.a];
  const switches = [];
  for (const nd of nodes) {
    const es = inc[nd.id];
    if (es.length !== 3) continue;
    const sideOf = e => Math.sign(far(e, nd.id).x - nd.x);
    const trunk = es.find(e => es.filter(f => sideOf(f) === sideOf(e)).length === 1);
    const t = far(trunk, nd.id), legs = es.filter(e => e !== trunk);
    const normal = legs.find(e => { const o = far(e, nd.id);
      return Math.sign(o.x - nd.x) === Math.sign(nd.x - t.x) && Math.sign(o.y - nd.y) === Math.sign(nd.y - t.y); });
    switches.push({ node: nd.id, trunk: trunk.id, normal: normal.id, reverse: legs.find(e => e !== normal).id });
  }

  return {
    seed, cols, rows: R + 1, nodes, edges, switches, signals, tracks, portals,
    places: mods.map(m => ({ name: m.name, x: (m.x0 + m.x1) / 2, y: -1 })), // label row above Main 1
    modules: mods.map(m => ({ kind: m.kind, x0: m.x0, x1: m.x1, name: m.name })),
  };
}
