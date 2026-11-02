// Seeded terminal generator: seed string -> Layout (track graph, switches, signals, tracks, portals).
// Pure: never touches window, document, Math.random or Date; all randomness comes from makeRng(seed).
//
// Grid: x = column (west 0 .. east cols-1), y = row (0 at the top). Main 1 is row T, home main of
// westbound (dir -1); Main 2 is row T+2, home main of eastbound (dir +1); both are signalled both ways,
// with row T+1 empty between them and a crossover pair in every gap and both margins. Each module hangs
// its westbound tracks above Main 1 (rows T-1 .. T-kt) and its eastbound tracks below Main 2 (rows
// T+3 .. T+2+kb), each side with an entry ladder and an exit ladder. Ids are array indices:
// nodes[i].id === i, likewise edges/signals/tracks/portals. An edge's oneWay is null (both ways) or the
// node it may be entered from; a signal stands at its node for trains arriving on edge `from` (null at a
// portal).
import { makeRng, pick, randInt } from './rng.js';

export const CLASS_SPEED = { main: 60, crossover: 30, ladder: 30, platform: 30, yard: 15, siding: 15, spur: 15 };
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
const MARGIN = 8; // columns from a portal to the nearest module: crossover pair, boundary signal
const GAP = 9;    // columns between modules (x0 of the next = x1 of this + GAP): signal, pair, signal

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

// A module's track list per side. top[i] sits on row T-(i+1) (nearest Main 1 first); bot[j] on row
// T+2+(j+1) (nearest Main 2 first). Names run top-to-bottom across the module, as on a station diagram.
function planModule(rng, kind, place, sidingCount) {
  const t = (cls, name, industry = null) => ({ cls, name, industry });
  if (kind === 'station') {
    const name = place(), kt = randInt(rng, 1, 2), kb = randInt(rng, 1, 2);
    return { kind, name,
      top: range(kt).map(i => t('platform', String(kt - i))),
      bot: range(kb).map(j => t('platform', String(kt + j + 1))) };
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
      top: [...range(yt).map(i => t('yard', `Y${yt - i}`)), ...(st ? [spur(0)] : [])],
      bot: [...range(yb).map(j => t('yard', `Y${yt + j + 1}`)), ...(sb ? [spur(1)] : [])] };
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
  const T = Math.max(...mods.map(m => m.top.length)), R2 = T + 2;
  const rows = R2 + 1 + Math.max(...mods.map(m => m.bot.length));

  // --- build: plain closures over flat arrays ---
  const nodes = [], edges = [], signals = [], tracks = [], at = new Map();
  const node = (x, y) => {
    const k = `${x},${y}`;
    if (!at.has(k)) { at.set(k, nodes.length); nodes.push({ id: nodes.length, x, y }); }
    return at.get(k);
  };
  // dirs: the sign of dx a train may travel the edge with, derived from oneWay for the sim, which still reads it.
  const edge = (a, b, cls, oneWay, track = null, extra) => {
    const dx = Math.abs(nodes[a].x - nodes[b].x), diag = nodes[a].y !== nodes[b].y;
    const dirs = oneWay === null ? [1, -1] : [Math.sign(nodes[oneWay === a ? b : a].x - nodes[oneWay].x)];
    edges.push({ id: edges.length, a, b, cls, oneWay, dirs, speed: CLASS_SPEED[cls], len: diag ? dx * Math.SQRT2 : dx, track,
      main: null, section: null, ...extra });
    return edges.length - 1;
  };
  const signal = (node, dir, kind, from) => signals.push({ id: signals.length, node, from, dir, kind });
  // k unit diagonals from (x,y) stepping (dx,dy), one-way for dir (entered from the end a dir train reaches
  // first); returns node ids, index i = row index i (0 = on the main).
  const ladder = (x, y, dx, dy, k, dir) => {
    const ns = [node(x, y)];
    for (let i = 1; i <= k; i++) { ns.push(node(x + i * dx, y + i * dy)); edge(ns[i - 1], ns[i], 'ladder', dx === dir ? ns[i - 1] : ns[i]); }
    return ns;
  };

  // Mains: one node at each portal, at every module's ladder and signal columns and at every crossover
  // end, joined in order on both rows. A pair at column a: A = Main 1 (a) -> Main 2 (a+2), B = Main 2
  // (a+3) -> Main 1 (a+5), so each direction has exactly one way across.
  // ponytail: one fixed pair per gap and margin, none inside a module. A real panel varies them; a fixed
  // pair keeps every gap the same width and the geometry crossing-free by construction.
  const pairs = [1, ...mods.map(m => m.x1 + 2)];
  const xs = [0, cols - 1, ...mods.flatMap(m => [m.x0 - 1, m.x0, m.x1, m.x1 + 1]),
    ...pairs.flatMap(a => [a, a + 2, a + 3, a + 5])].sort((a, b) => a - b);
  const mainIn = new Map(); // `${node}:${dir}` -> the main edge a dir train arrives at node by
  for (const [y, main] of [[T, -1], [R2, 1]])
    for (let i = 1; i < xs.length; i++) {
      const a = node(xs[i - 1], y), b = node(xs[i], y), e = edge(a, b, 'main', null, null, { main });
      mainIn.set(`${b}:1`, e); mainIn.set(`${a}:-1`, e);
    }
  for (const a of pairs) {
    edge(node(a, T), node(a + 2, R2), 'crossover', null);
    edge(node(a + 3, R2), node(a + 5, T), 'crossover', null);
  }
  const portals = [
    { id: 0, node: node(0, R2), name: west, dir: 1, side: 'west' },        // eastbound enters at the west end of Main 2
    { id: 1, node: node(cols - 1, T), name: east, dir: -1, side: 'east' }, // westbound enters at the east end of Main 1
  ];
  for (const p of portals) signal(p.node, p.dir, 'high', null);

  // Track i of a side runs from its entry ladder node to its exit ladder node, with its signal node
  // one cell before the exit. Capacity counts entry -> signal, less half a cell of clearance.
  const side = (list, dir, entry, exit) => list.forEach((t, k) => {
    const id = tracks.length, a = entry[k + 1], b = exit[k + 1];
    const sig = node(nodes[b].x - dir, nodes[b].y);
    const e1 = edge(a, sig, t.cls, a, id), e2 = edge(sig, b, t.cls, sig, id);
    signal(sig, dir, DWARF.has(t.cls) ? 'dwarf' : 'high', e1);
    tracks.push({ id, cls: t.cls, name: t.name, dir, edges: [e1, e2], capacity: edges[e1].len - 0.5, industry: t.industry });
  });

  for (const m of mods) {
    const { x0, x1 } = m, kt = m.top.length, kb = m.bot.length;
    // Boundary signals: both directions on both mains at each end of the module.
    for (const x of [x0 - 1, x1 + 1]) for (const y of [T, R2]) for (const d of [1, -1]) {
      const nd = node(x, y);
      signal(nd, d, 'high', mainIn.get(`${nd}:${d}`));
    }
    // Westbound: enter up the right-hand ladder, leave down the left-hand one. Eastbound mirrors below.
    side(m.top, -1, ladder(x1, T, -1, -1, kt, -1), ladder(x0, T, 1, -1, kt, -1));
    side(m.bot, 1, ladder(x0, R2, 1, 1, kb, 1), ladder(x1, R2, -1, 1, kb, 1));
  }

  // Switches: every 3-edge node. With v(e) the unit vector from the node along edge e: trunk = the edge
  // whose v has a negative dot product with both others (the lone edge on one x-side; at a wye apex, the
  // stem); normal = the leg nearest the trunk's continuation -v(trunk) (main continues main, ladder
  // continues ladder; on a tie, the leg whose far node is further west); reverse = the other leg.
  const inc = nodes.map(() => []);
  for (const e of edges) { inc[e.a].push(e); inc[e.b].push(e); }
  const far = (e, n) => nodes[e.a === n ? e.b : e.a];
  const switches = [];
  for (const nd of nodes) {
    const es = inc[nd.id];
    if (es.length !== 3) continue;
    const v = es.map(e => { const o = far(e, nd.id), dx = o.x - nd.x, dy = o.y - nd.y, l = Math.hypot(dx, dy); return [dx / l, dy / l]; });
    const dot = (i, j) => v[i][0] * v[j][0] + v[i][1] * v[j][1];
    const t = [0, 1, 2].find(i => [0, 1, 2].every(j => j === i || dot(i, j) < 0));
    const [p, q] = [0, 1, 2].filter(i => i !== t);
    const nearer = dot(t, q) - dot(t, p); // > 0: p is nearer the continuation
    const n = Math.abs(nearer) > 1e-9 ? (nearer > 0 ? p : q) : (far(es[p], nd.id).x < far(es[q], nd.id).x ? p : q);
    switches.push({ node: nd.id, trunk: es[t].id, normal: es[n].id, reverse: es[n === p ? q : p].id });
  }
  // Sections: main edges were made row by row, west to east; a new section starts on a new row and at
  // every crossover end, so a section is the stretch of one main between crossover pairs (ladder points
  // don't split it). Traffic locking claims a whole one: no opposing train can be lined into the far end
  // of a module while a wrong-main train is on its way through it to the next pair.
  const xo = new Set(edges.filter(e => e.cls === 'crossover').flatMap(e => [e.a, e.b]));
  let sec = -1, prev = null;
  for (const e of edges) if (e.cls === 'main') { if (e.a !== prev || xo.has(e.a)) sec++; e.section = sec; prev = e.b; }

  return {
    seed, cols, rows, nodes, edges, switches, signals, tracks, portals, wye: null, mainRow: { 1: R2, '-1': T },
    places: mods.map(m => ({ name: m.name, x: (m.x0 + m.x1) / 2, y: -1 })), // label row above the top tracks
    modules: mods.map(m => ({ kind: m.kind, x0: m.x0, x1: m.x1, name: m.name })),
  };
}
