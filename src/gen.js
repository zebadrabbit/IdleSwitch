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
//
// About 60 % of terminals also grow a wye in one inter-module gap, on Main 1 with the apex above it (north) or on Main 2
// with the apex below (south): two feet on that main and legs up to the apex. Half of them are junctions (Keddie): a
// vertical single-track stem from the apex to a third portal at the panel edge. The other half are termini (Tampa): a
// vertical stub platform off the apex ending at a buffer stop, with pull-ahead columns either side (spec "The wye").
//
// About 40 % also grow an industrial fan in another gap (a 45° lead off Main 1 north or Main 2 south, laddering into two or
// three dead-end stubs), and some yard spurs a single dead-end stub one row deeper (spec "Industrial branches").
import { makeRng, pick, randInt } from './rng.js';

export const CLASS_SPEED = { main: 60, crossover: 30, ladder: 30, platform: 30, yard: 15, siding: 15, spur: 15, wye: 30, branch: 45,
  lead: 15, stub: 15 };
export const CAPACITY_MIN = { platform: 6, yard: 12, siding: 14, spur: 14 };

// stub: the name of a spur's stub (spec "The spur stub").
const INDUSTRIES = [
  { key: 'coal', label: '… Power Plant', stub: '… Plant Track', trainType: 'C' },
  { key: 'steel', label: '… Steel', stub: '… Mill Track', trainType: 'M' },
  { key: 'grain', label: '… Elevator', stub: '… Silo Track', trainType: 'G' },
  { key: 'intermodal', label: '… Intermodal', stub: '… Ramp Track', trainType: 'I' },
  { key: 'lumber', label: '… Lumber', stub: '… Shed Track', trainType: 'M' },
  { key: 'auto', label: '… Assembly', stub: '… Dock Track', trainType: 'M' },
  { key: 'oil', label: '… Terminal', stub: '… Rack Track', trainType: 'M' },
];
// 6 x 4 syllables = 24 place names (Lebanon, Cornwall, Colebrook, Hartford, ...).
const PLACES = ['Leb', 'Corn', 'Cole', 'Ash', 'Hart', 'Stan'].flatMap(a => ['anon', 'wall', 'brook', 'ford'].map(b => a + b));
const PORTAL_SUFFIX = ['Jct', 'Yard', 'Mine'];
const KINDS = ['station', 'yard', 'sidings'];
const DWARF = new Set(['yard', 'siding', 'spur', 'stub']); // tracks whose exit signal is a dwarf
const MARGIN = 8; // columns from a portal to the nearest module: crossover pair, boundary signal
const GAP = 9;    // columns between modules (x0 of the next = x1 of this + GAP): signal, pair, signal
const GAP_WYE = 22; // a junction gap: signal, pair, empty, F1 . A . F2, empty, pair, signal
const GAP_TERM = 36; // a terminus gap: signal, pair, empty, P, run(7), F1 . A . F2, run(7), P, empty, pair, signal
// Columns from the wye gap's west boundary signal column b: the second pair's first column, the foot F1 (F2 = F1 + 4,
// the apex A = F1 + 2), the pull-ahead columns and b' (the east boundary). A terminus is symmetric about its apex.
const WYE_COLS = { junction: { pair: 14, F1: 8, P: [], end: 20 }, terminus: { pair: 28, F1: 15, P: [8, 26], end: 34 } };
const WYE_P = 0.6;  // share of terminals with a wye
const GAP_FAN = { 2: 33, 3: 34 }; // a fan gap by stub count: signal, pair, empty, P, run(7), X, pair under the lead, stubs, signal
// Columns from the fan gap's west boundary signal column b (a north fan; a south one mirrors them about the gap's centre): the
// pull-ahead column, the lead switch on the main, the second pair's first column, the top of the lead and the ladder foot.
// Stub i's ladder node is J + i (K0 = J) on row 2 + i off the main, its signal one cell on, its buffer 7 further.
const FAN_COLS = { P: 8, X: 15, pair: 17, Lt: 17, J: 20 };
const FAN_P = 0.5;       // share of terminals with a gap the wye leaves free that get a fan
const SPUR_STUB_P = 0.4; // share of yard spurs with a stub

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
      const p = place(), label = inds[i].label.replace('…', p);
      return { ...t('spur', label, { key: inds[i].key, label, trainType: inds[i].trainType }), stubName: inds[i].stub.replace('…', p) };
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

// Wide enough that row index i (1-based) still meets its floor: capacity = width - 2i - 1.5. A spur with a stub needs one
// more (2i + 17), so the stub's buffer is no further upstream than the spur's entry ladder node.
const width = m => Math.max(...[m.top, m.bot].flatMap(side =>
  side.map((t, i) => CAPACITY_MIN[t.cls] + 2 * (i + 1) + 2 + (t.stub ? 1 : 0))));

export function generate(seed, opts = { industrial: true }) {
  const rng = makeRng(seed);

  // --- plan: module mix, names, columns ---
  const n = randInt(rng, 2, 4);
  let kinds;
  // ponytail: rejection sampling; worst case (n=4) accepts ~7% of draws, so ~14 tries on average.
  // A constructive interleave would bound it, but nothing here is hot.
  do kinds = range(n).map(() => pick(rng, KINDS)); while (!validMix(kinds));
  const names = shuffle(rng, PLACES); // at most 2 portals + 4 modules + 2 industries + a branch or stub + a fan = 10 of 24
  let ni = 0, sidings = 0;
  const place = () => names[ni++];
  const west = `${place()} ${pick(rng, PORTAL_SUFFIX)}`;
  const east = `${place()} ${pick(rng, PORTAL_SUFFIX)}`;
  const mods = kinds.map(kind => planModule(rng, kind, place, () => (sidings += 2) - 2));
  // The wye draws from its own stream, so the main one (and every layout without a wye) is untouched. Its first
  // draw is the presence coin; side and gap follow only when there is one, then the kind (a fair coin), drawn last so
  // the first three are as they were before termini. The stream is ':junction', not the plan's ':wye': on ':wye' the
  // frozen fixture seed s47 draws 0.553 first, and no order of the presence, side and gap draws (nor any of the first 12
  // draws as the coin) keeps all five fixture seeds wye-free.
  const wr = makeRng(seed + ':junction');
  const wye = wr() < WYE_P ? { side: wr() < 0.5 ? 'north' : 'south', gap: randInt(wr, 0, n - 2) } : null;
  if (wye) wye.kind = wr() < 0.5 ? 'junction' : 'terminus';
  const term = wye?.kind === 'terminus', K = wye && WYE_COLS[wye.kind];
  // The fan and the spur stubs draw from their own stream as well, after the wye (spec "The fan (geometry)"): the presence
  // coin, then, when there is a fan and a gap the wye leaves free, its side, gap, stub count and the stubs' industries (none
  // a spur has), then one coin per yard spur in module order. opts.industrial false draws nothing: the base generator.
  let fan = null;
  if (opts.industrial !== false) {
    const ir = makeRng(seed + ':industrial'), free = range(n - 1).filter(g => g !== wye?.gap);
    const spurs = mods.flatMap(m => [...m.top, ...m.bot]).filter(t => t.cls === 'spur');
    if (ir() < FAN_P && free.length) {
      fan = { side: ir() < 0.5 ? 'north' : 'south', gap: pick(ir, free), count: ir() < 0.5 ? 2 : 3 };
      const used = new Set(spurs.map(t => t.industry.key));
      fan.inds = shuffle(ir, INDUSTRIES).filter(d => !used.has(d.key)).slice(0, fan.count);
    }
    for (const t of spurs) t.stub = ir() < SPUR_STUB_P;
  }
  let x = MARGIN;
  mods.forEach((m, i) => {
    m.x0 = x; m.x1 = x + width(m);
    x = m.x1 + (wye?.gap === i ? (term ? GAP_TERM : GAP_WYE) : fan?.gap === i ? GAP_FAN[fan.count] : GAP);
  });
  const cols = mods[mods.length - 1].x1 + MARGIN + 1;
  // Rows: the wye needs `off` rows beyond its main: the apex two rows off it, then a stem of at least four cells to the
  // panel edge (junction), or S one cell past the apex and the 7-cell stub to its buffer (terminus). North that is
  // T >= off, south rows - 1 >= R2 + off. A fan needs count + 1 (stub i on row 2 + i off its main), a side whose spur has
  // a stub one row beyond its tracks. Padding is empty rows beyond the module tracks.
  const off = !wye ? 0 : term ? 10 : 6, deep = side => side.length + (side.at(-1).stub ? 1 : 0);
  const T = Math.max(...mods.map(m => deep(m.top)), wye?.side === 'north' ? off : 0, fan?.side === 'north' ? fan.count + 1 : 0), R2 = T + 2;
  const rows = Math.max(R2 + 1 + Math.max(...mods.map(m => deep(m.bot))), wye?.side === 'south' ? R2 + 1 + off : 0,
    fan?.side === 'south' ? R2 + 2 + fan.count : 0);
  const wb = wye && mods[wye.gap].x1 + 1; // the wye gap's west boundary signal column (the spec's b); b' = wb + K.end
  // The fan gap's b and b', and its columns: FAN_COLS from b north, from b' westward south (the mirror).
  const fb = fan && mods[fan.gap].x1 + 1, fe = fan && fb + GAP_FAN[fan.count] - 2;
  const fx = k => (fan.side === 'north' ? fb + k : fe - k);

  // --- build: plain closures over flat arrays ---
  const nodes = [], edges = [], signals = [], tracks = [], at = new Map();
  const node = (x, y) => {
    const k = `${x},${y}`;
    if (!at.has(k)) { at.set(k, nodes.length); nodes.push({ id: nodes.length, x, y }); }
    return at.get(k);
  };
  const edge = (a, b, cls, oneWay, track = null, extra) => {
    const dx = Math.abs(nodes[a].x - nodes[b].x), dy = Math.abs(nodes[a].y - nodes[b].y); // horizontal, vertical or 45°
    edges.push({ id: edges.length, a, b, cls, oneWay, speed: CLASS_SPEED[cls], len: !dx ? dy : dy ? dx * Math.SQRT2 : dx, track,
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
  // pair keeps every gap the same width and the geometry crossing-free by construction. The wye gap has a second
  // pair (at wb+14, a terminus's at wb+28) and main nodes at its feet (wb+8 and wb+12; a terminus's wb+15 and wb+19) and
  // a terminus's pull-ahead columns (wb+8, wb+26) on both rows, so each run from a P to its foot is one 7-cell edge. The fan
  // gap's pairs are at fx(1) and fx(17) (the second under the lead), its main nodes at P and X, so the run P-X is one edge.
  const pairs = [1, ...mods.flatMap((m, i) => (wye?.gap === i ? [m.x1 + 2, wb + K.pair]
    : fan?.gap === i ? [1, FAN_COLS.pair].map(k => Math.min(fx(k), fx(k + 5))) : [m.x1 + 2]))];
  const xs = [0, cols - 1, ...mods.flatMap(m => [m.x0 - 1, m.x0, m.x1, m.x1 + 1]),
    ...(wye ? [K.F1, K.F1 + 4, ...K.P].map(k => wb + k) : []), ...(fan ? [fx(FAN_COLS.P), fx(FAN_COLS.X)] : []),
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
  // A spur with a stub (spec "The spur stub"): a switch Xs 7 cells before the signal splits the entry edge (capacity as
  // before), and the stub runs back from Xs one row deeper (y + dir: westbound tracks hang above Main 1, eastbound below
  // Main 2): Xs-Q one 45° lead cell, Q-Sq one cell, Sq-Bq seven to the buffer, all both ways. Xs's shunt faces Xs-sig (a
  // train reversed at the signal backs in by it), Sq's dwarf the buffer edge; both dir 0.
  const spurStubs = [];
  const side = (list, dir, entry, exit) => list.forEach((t, k) => {
    const id = tracks.length, a = entry[k + 1], b = exit[k + 1];
    const sig = node(nodes[b].x - dir, nodes[b].y), Xs = t.stub ? node(nodes[sig].x - 7 * dir, nodes[sig].y) : null;
    const e0 = Xs === null ? null : edge(a, Xs, t.cls, a, id), from = Xs ?? a;
    const e1 = edge(from, sig, t.cls, from, id), e2 = edge(sig, b, t.cls, sig, id);
    signal(sig, dir, DWARF.has(t.cls) ? 'dwarf' : 'high', e1);
    tracks.push({ id, cls: t.cls, name: t.name, dir, edges: Xs === null ? [e1, e2] : [e0, e1, e2],
      capacity: (Xs === null ? 0 : edges[e0].len) + edges[e1].len - 0.5, industry: t.industry });
    if (Xs === null) return;
    const x = nodes[Xs].x, y = nodes[Xs].y + dir, stub = id + 1, shunt = signals.length;
    const Q = node(x - dir, y), Sq = node(x - 2 * dir, y), Bq = node(x - 9 * dir, y);
    edge(Xs, Q, 'lead', null);
    const eQS = edge(Q, Sq, 'stub', null, stub), eSB = edge(Sq, Bq, 'stub', null, stub);
    signal(Xs, 0, 'shunt', e1);
    signal(Sq, 0, 'dwarf', eSB);
    tracks[id].stubOf = stub;
    tracks.push({ id: stub, cls: 'stub', dir: 0, name: t.stubName, stub: true, edges: [eQS, eSB], capacity: edges[eSB].len - 0.5,
      industry: t.industry, spur: id });
    spurStubs.push({ spur: id, stub, Xs, shunt });
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

  // The wye: feet F1 and F2 = F1 + 4 on its main, apex A two rows off it at F1 + 2, 45° legs (class wye), and the legs'
  // section (the branch section, below) holds the stem or the stub too.
  // Junction (F1 = wb+8): the stem (class branch) one edge per cell from A to the panel edge, where the branch portal is.
  // Its two signals serve both directions (dir 0): the portal signal and the stem signal one cell before the apex, facing
  // down the stem. No other signal stands inside the gap (atomic routes through it).
  // Terminus (F1 = wb+15): the pull-ahead columns P (wb+8, wb+26) carry signals both ways on both mains, like a module
  // boundary; a shunt signal (dir 0, route-transparent from Task 7) stands at each foot facing in from its run; the stub
  // runs from A away from the main: S one cell on (its exit signal, dir 0, facing the apex), the buffer 7 cells further.
  let wyeOut = null;
  const own = []; // the wye's legs and its stem or stub: the branch section's edges
  if (wye) {
    const north = wye.side === 'north', y = north ? T : R2, sy = north ? -1 : 1, ax = wb + K.F1 + 2;
    const F1 = node(wb + K.F1, y), F2 = node(wb + K.F1 + 4, y), A = node(ax, y + 2 * sy);
    own.push(edge(F1, A, 'wye', null), edge(F2, A, 'wye', null));
    const common = { side: wye.side, gap: wye.gap, F1, F2, A };
    if (!term) {
      const edgeY = north ? 0 : rows - 1, stem = [A];
      for (let yy = y + 3 * sy; yy !== edgeY + sy; yy += sy) {
        stem.push(node(ax, yy));
        own.push(edge(stem.at(-2), stem.at(-1), 'branch', null));
      }
      portals.push({ id: 2, node: stem.at(-1), name: `${place()} Branch`, dir: 0, side: wye.side });
      signal(stem.at(-1), 0, 'high', null);
      const stemSignal = signals.length;
      signal(stem[1], 0, 'high', own[3]); // facing the stem's second edge, from the portal side
      wyeOut = { kind: 'junction', ...common, stemSignal, portal: 2, feetMain: north ? -1 : 1, x0: wb, x1: wb + K.end };
    } else {
      for (const k of K.P) for (const yy of [T, R2]) for (const d of [1, -1]) {
        const nd = node(wb + k, yy);
        signal(nd, d, 'high', mainIn.get(`${nd}:${d}`));
      }
      const shunt = { F1: signals.length, F2: signals.length + 1 };
      signal(F1, 0, 'shunt', mainIn.get(`${F1}:1`));  // facing east: from the west run
      signal(F2, 0, 'shunt', mainIn.get(`${F2}:-1`)); // facing west: from the east run
      const S = node(ax, y + 3 * sy), buffer = node(ax, y + 10 * sy), stub = tracks.length;
      own.push(edge(A, S, 'platform', null, stub), edge(S, buffer, 'platform', null, stub));
      const stubSignal = signals.length;
      signal(S, 0, 'high', own[3]); // a train leaving the stub arrives at S from the buffer
      tracks.push({ id: stub, cls: 'platform', dir: 0, name: `${place()} Union 1`, stub: true, edges: [own[2], own[3]],
        capacity: edges[own[3]].len - 0.5, industry: null });
      wyeOut = { kind: 'terminus', ...common, feetMain: north ? -1 : 1, x0: wb, x1: wb + K.end,
        P: { 1: node(wb + K.P[1], y), '-1': node(wb + K.P[0], y) }, stub, shunt, stubSignal };
    }
    // The junction gap: every main edge strictly between b and b', both mains.
    const inside = id => nodes[id].x > wb && nodes[id].x < wb + K.end;
    for (const e of edges) if (e.cls === 'main' && inside(e.a) && inside(e.b)) e.junction = true;
  }

  // The fan (spec "The fan (geometry)"): P carries signals both ways on both mains, like a module boundary; X on the lead's
  // main is the lead switch, the run P-X its trunk. The lead (class lead) runs X-Lt one 45° edge away from the main, then
  // Lt-J along the straight; stub i (class stub) leaves its ladder node Ki (K0 = J, each Ki one 45° lead cell on from the
  // last) along its row: Ki-Si one cell, Si-Bi seven to the buffer. Every edge both ways. Signals, all dir 0: X's shunt
  // facing the run (the visitor reversed at P backs in by it), J's shunt and Lt's dwarf facing the straight, each Si's
  // dwarf facing its buffer edge. The stubs take industry names with the fan's one place name.
  let fanOut = null;
  const fanOwn = []; // the lead, the ladder and the stubs: the fan section's edges
  if (fan) {
    const north = fan.side === 'north', y = north ? T : R2, sy = north ? -1 : 1;
    for (const yy of [T, R2]) for (const d of [1, -1]) {
      const nd = node(fx(FAN_COLS.P), yy);
      signal(nd, d, 'high', mainIn.get(`${nd}:${d}`));
    }
    const P = node(fx(FAN_COLS.P), y), X = node(fx(FAN_COLS.X), y);
    const Lt = node(fx(FAN_COLS.Lt), y + 2 * sy), J = node(fx(FAN_COLS.J), y + 2 * sy);
    fanOwn.push(edge(X, Lt, 'lead', null), edge(Lt, J, 'lead', null));
    const shunt = { X: signals.length, J: signals.length + 1 }, leadSignal = signals.length + 2;
    signal(X, 0, 'shunt', mainIn.get(`${X}:${north ? 1 : -1}`)); // from the run: P is west of X north, east south
    signal(J, 0, 'shunt', fanOwn[1]);
    signal(Lt, 0, 'dwarf', fanOwn[1]);
    const p = place(), stubs = [];
    let k = J;
    fan.inds.forEach((d, i) => {
      const row = y + (2 + i) * sy, id = tracks.length, label = d.label.replace('…', p);
      if (i) { const ki = node(fx(FAN_COLS.J + i), row); fanOwn.push(edge(k, ki, 'lead', null)); k = ki; }
      const S = node(fx(FAN_COLS.J + 1 + i), row), B = node(fx(FAN_COLS.J + 8 + i), row);
      const e1 = edge(k, S, 'stub', null, id), e2 = edge(S, B, 'stub', null, id);
      fanOwn.push(e1, e2);
      signal(S, 0, 'dwarf', e2);
      tracks.push({ id, cls: 'stub', dir: 0, name: label, stub: true, edges: [e1, e2], capacity: edges[e2].len - 0.5,
        industry: { key: d.key, label, trainType: d.trainType } });
      stubs.push(id);
    });
    fanOut = { side: fan.side, gap: fan.gap, count: fan.count, x0: fb, x1: fe, main: north ? -1 : 1, P, X, Lt, J, stubs, shunt,
      leadSignal, name: `${p} Industrial` };
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
    if (t === undefined) throw new Error(`no trunk at node ${nd.id} (${nd.x},${nd.y})`);
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
  // The wye's legs and its stem or stub: one more section, the branch (not a main). The fan's lead, ladder and stubs: one
  // more after it.
  if (wye) { sec++; for (const e of own) edges[e].section = sec; }
  if (fan) { sec++; for (const e of fanOwn) edges[e].section = sec; }

  return {
    seed, cols, rows, nodes, edges, switches, signals, tracks, portals, wye: wyeOut, fan: fanOut, spurStubs, mainRow: { 1: R2, '-1': T },
    places: [...mods.map(m => ({ name: m.name, x: (m.x0 + m.x1) / 2, y: -1 })), // label row above the top tracks
      ...(fan ? [{ name: fanOut.name, x: (fx(FAN_COLS.X) + fx(FAN_COLS.J + 7 + fan.count)) / 2, y: -1 }] : [])], // over X .. the last buffer
    modules: mods.map(m => ({ kind: m.kind, x0: m.x0, x1: m.x1, name: m.name })),
  };
}
