// node tests/test_ui.mjs — the UI's pure helpers (src/ui-util.js), and the renderer's fades on a recording canvas. The
// DOM side is checked by hand in a browser.
import assert from 'node:assert/strict';
import { formatClock, formatDelay, dockFor, matchCandidate, tick, loadJSON, cleanSettings, cleanLayout, clampDock,
  DEFAULT_SETTINGS, DEFAULT_LAYOUT } from '../src/ui-util.js';
import { mix, createRenderer, facingOf, rightOf, tagAt, CELL } from '../src/render.js';
import { generate } from '../src/gen.js';
import { createSim, step, nightOf, spawnTrain, setRoute, cancelRoute, switchLocked, aspectOf, lamps, signalHeads, trainBlocks } from '../src/sim.js';

// Clock: 06:00 start, minutes floor, wraps past midnight.
assert.deepEqual([21600, 22859, 86399, 86400 + 3660].map(t => formatClock(t)), ['06:00', '06:20', '23:59', '01:01']);

// Delay: running trains show "–" until late (rounded up), finished runs show early/late/on time.
assert.deepEqual([[-120], [30], [-170, true], [10, true], [300, true]].map(([s, f]) => formatDelay(s, f).text),
  ['–', '+1', '−3', '+0', '+5']);

// Docking in a 1366x768 window: within 24 px of the left/right/bottom edge, nearest edge wins, else floating.
const W = 1366, H = 768;
assert.deepEqual([dockFor(10, 100, 300, 200, W, H), dockFor(W - 320, 100, 300, 200, W, H),
  dockFor(500, H - 210, 300, 200, W, H), dockFor(W - 305, H - 202, 300, 200, W, H), dockFor(500, 300, 300, 200, W, H)],
['left', 'right', 'bottom', 'bottom', null]);

// NX: the second click picks the candidate ending at the clicked signal; a portal exit (exitSignal null) never matches.
const cands = [{ exitNode: 7, exitSignal: 3 }, { exitNode: 9, exitSignal: null }];
assert.deepEqual([matchCandidate(cands, 3), matchCandidate(cands, 4), matchCandidate(cands, null), matchCandidate(undefined, 3)],
  [cands[0], null, null, null]);

// Frame clock: 60 fps at 1x carries the fraction; a 2-minute background gap counts as 0.25 s (2.5 sim s at 1x, 20 at 8x).
assert.deepEqual([tick(0, 1000 / 60, 1).steps, tick(0.5, 120000, 1).steps, tick(0, 120000, 8).steps, tick(0, -50, 1).steps],
  [0, 3, 20, 0]);

// Storage: throwing storage and bad JSON give defaults; a partly valid record keeps its valid fields / panels.
const D = ['light', 'normal', 'busy'], settings = v => cleanSettings(v, D), mem = s => ({ getItem: () => s });
const layout = loadJSON(mem(JSON.stringify({ board: { x: 40, y: 80, dock: null, hidden: true }, log: { dock: 'top' } })), 'k', cleanLayout);
assert.deepEqual([
  loadJSON({ getItem() { throw new Error('SecurityError'); } }, 'k', settings),
  loadJSON(null, 'k', cleanLayout),
  loadJSON(mem('{oops'), 'k', settings),
  loadJSON(mem(JSON.stringify({ speed: 4, density: 'warp', flash: false })), 'k', settings),
  [layout.board, layout.log],
], [DEFAULT_SETTINGS, DEFAULT_LAYOUT, DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, speed: 4, flash: false },
  [{ x: 40, y: 80, dock: null, hidden: true }, DEFAULT_LAYOUT.log]]);

// New settings: defaults, validation, and a caller-supplied default for idleCamera
assert.deepEqual(settings(null), DEFAULT_SETTINGS);
assert.deepEqual([settings({ dayLength: 8 }).dayLength, settings({ dayLength: 3 }).dayLength, settings({ dayLength: 0 }).dayLength], [8, 4, 0]);
assert.deepEqual([settings({ slowOrders: false }).slowOrders, settings({ slowOrders: 'no' }).slowOrders], [false, true]);
assert.equal(cleanSettings(null, D, { ...DEFAULT_SETTINGS, idleCamera: false }).idleCamera, false);
assert.equal(cleanSettings({ idleCamera: true }, D, { ...DEFAULT_SETTINGS, idleCamera: false }).idleCamera, true);

// Dock sizes: defaults when missing or bad, kept when valid (a copy: drags mutate it); clamps
assert.deepEqual(cleanLayout(null).size, { left: 420, right: 420, bottom: 200 });
assert.deepEqual(cleanLayout({ size: { left: 300, right: 'x', bottom: -5 } }).size, { left: 300, right: 420, bottom: 200 });
assert.notEqual(cleanLayout(DEFAULT_LAYOUT).size, DEFAULT_LAYOUT.size);
assert.deepEqual([clampDock('left', 10, 1366, 768), clampDock('right', 2000, 1366, 768), clampDock('bottom', 1000, 1366, 768), clampDock('bottom', 150, 1366, 768)],
  [200, Math.round(0.6 * 1366), Math.round(0.7 * 768), 150]);
assert.equal(clampDock('left', 1000, 1366, 768, 600), 1366 - 600 - 240); // the side docks leave fit's 240 px between them

// Colour blend (night chrome and palette): endpoints exact, midpoint rounds per channel.
assert.deepEqual([0, 0.5, 1].map(t => mix('#0b1020', '#070b17', t)), ['#0b1020', '#090e1c', '#070b17']);

// ---- Renderer on a recording canvas: what each frame drew (text, padlock outlines, radial gradients) and at what alpha.
globalThis.innerWidth = 1366; globalThis.innerHeight = 768; globalThis.devicePixelRatio = 1;
let rec = [];
const ctx = new Proxy({ globalAlpha: 1 }, {
  get: (o, k) => k in o ? o[k] : (...a) => {
    if (k === 'fillText') rec.push({ k, text: a[0], x: a[1], y: a[2], align: o.textAlign, alpha: o.globalAlpha });
    else if (k === 'fillRect' && a[3] === 15) rec.push({ k: 'tag', x: a[0], y: a[1], w: a[2], h: a[3] });
    else if (k === 'strokeRect' && a[2] === 7 && a[3] === 5.5) rec.push({ k: 'lock', x: a[0] + 3.5, y: a[1] + 1.5, alpha: o.globalAlpha });
    else if (k === 'createRadialGradient') rec.push({ k: 'halo' });
    return k === 'measureText' ? { width: 30 } : { addColorStop() {} };
  },
  set: (o, k, v) => { o[k] = v; return true; },
});
const R = createRenderer({ getContext: () => ctx, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) });
R.resize();
const RL = generate('lebanon'), RS = createSim(RL, 'lebanon', { slowOrders: false });
R.fit(RL);
let rnow = 0;
const frame = (ui = {}, sim = RS) => { rec = []; R.draw(sim, { blink: true, ...ui, now: (rnow += 16) }); return rec; };

// The shown night level is eased: seeded at the raw level (no fade in at boot), then a Day length change crossfades
// it (95 % in under half a second), frame by frame, and settles exactly once within 0.001.
while (nightOf(RS) !== 1) RS.time += 10;
frame();
assert.equal(R.night, 1, 'boot: no fade in');
RS.dayLength = 0;
const ns = Array.from({ length: 70 }, () => (frame(), R.night));
assert.ok(ns.every((n, i) => n < (ns[i - 1] ?? 1) || n === 0) && ns.every((n, i) => (ns[i - 1] ?? 1) - n < 0.12), 'eases down, no step');
assert.ok(ns[0] > 0.85 && ns[29] < 0.05 && ns[69] === 0, `crossfades and lands on 0 (${ns[0]}, ${ns[29]}, ${ns[69]})`);

// The caption keeps the box it was shown in while it fades, until it reaches 0 or changes text.
const A = { x: 0, y: 0, w: 800, h: 600 }, B = { x: 420, y: 0, w: 500, h: 600 };
const capX = (c, box) => frame({ caption: c, box }).find(d => d.text === c?.text)?.x;
assert.deepEqual([capX({ text: 'watching E1A', alpha: 1 }, A), capX({ text: 'watching E1A', alpha: 0.5 }, B), capX(null, B),
  capX({ text: 'watching E1A', alpha: 0.3 }, B), capX({ text: 'watching W2B', alpha: 0.1 }, A)], [16, 16, undefined, 436, 16]);

// Train tags fade in when the train enters (tau 120 ms); a padlock fades in on its first lock and out when unlocked.
RS.auto = true;
const tr = spawnTrain(RS, { type: 'P', dir: 1 });
for (let i = 0; i < 600 && !trainBlocks(RS, tr).length; i++) step(RS);
const tagA = () => frame().find(d => d.text === tr.name)?.alpha, ta = [tagA(), tagA(), ...Array.from({ length: 30 }, tagA)];
assert.ok(ta[0] > 0 && ta[0] < 0.2 && ta[1] > ta[0] && ta.at(-1) > 0.98, `tag fades in (${ta.slice(0, 3)})`);
const PS = createSim(RL, 'lebanon', { slowOrders: false }); // no trains: a route alone locks its switches
const res = [...PS.routesFrom].flatMap(([g, cs]) => cs.map(c => [g, c])).map(([g, c]) => setRoute(PS, g, c.exitNode)).find(r => r.ok);
const lockNode = RL.switches.find(w => switchLocked(PS, w.node))?.node, lockX = (RL.nodes[lockNode].x * 24 - R.camera.x) * R.camera.zoom;
const lockA = () => frame({}, PS).find(d => d.k === 'lock' && Math.abs(d.x - lockX) < 1e-6)?.alpha ?? 0;
const la = Array.from({ length: 30 }, lockA);
assert.ok(la[0] > 0 && la[0] < 0.2 && la[1] > la[0] && la.at(-1) > 0.98, `padlock fades in (${la.slice(0, 3)})`);
for (const id of [...PS.routes.keys()]) cancelRoute(PS, id);
assert.ok(!switchLocked(PS, lockNode));
const lo = Array.from({ length: 60 }, lockA);
assert.ok(lo[0] < 1 && lo[0] > 0.8 && lo[5] < lo[0] && lo.at(-1) === 0, `padlock fades out (${lo.slice(0, 3)}, ${lo.at(-1)})`);

// A lamp halo faded to black is skipped: with flashing lamps in their off phase, one radial gradient per lit head
// (plus a headlight per moving train) and none for the dark ones.
for (let i = 0; i < 3000 && !RL.signals.some(g => Object.values(lamps(aspectOf(RS, g.id), g.kind, signalHeads(RS, g.id))).some(c => c?.[0] === 'F')); i++) step(RS);
const heads = RL.signals.flatMap(g => { const l = lamps(aspectOf(RS, g.id), g.kind, signalHeads(RS, g.id)); return signalHeads(RS, g.id) === 2 ? [l.top, l.bottom] : [l.top]; });
const flashing = heads.filter(c => c[0] === 'F').length;
assert.ok(flashing > 0, 'a flashing aspect to test with');
for (let i = 0; i < 30; i++) frame({ blink: false }); // the off-phase lamps and halos fade to black
const halos = frame({ blink: false }).filter(d => d.k === 'halo').length, moving = [...RS.trains.values()].filter(t => t.speed > 0).length;
assert.ok(halos <= heads.length - flashing + moving, `dark halos skipped (${halos} gradients, ${heads.length} heads, ${flashing} dark)`);

// ---- Facing (spec "Rendering and panels"): a signal faces the way a train passing it travels, from the far node of the
// edge it faces to its node; a portal signal into the panel. Heads, chevrons and tags go on rightOf(travel), y down.
const n0 = v => ({ x: v.x + 0, y: v.y + 0 }); // -0 -> 0 for deepEqual
const N3 = generate('s3'), S18 = generate('s18'); // a north junction, a south one
assert.ok(N3.wye?.side === 'north' && S18.wye?.side === 'south');
const eastMain = RL.signals.find(g => g.dir === 1 && g.from !== null && RL.nodes[g.node].y === RL.mainRow[1]);
const portalSig = (L, id) => L.signals.find(g => g.node === L.portals[id].node && g.from === null);
assert.deepEqual([facingOf(RL, eastMain), facingOf(N3, N3.signals[N3.wye.stemSignal]), facingOf(S18, S18.signals[S18.wye.stemSignal])].map(n0),
  [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]);
assert.deepEqual([portalSig(RL, 0), portalSig(RL, 1), portalSig(N3, 2), portalSig(S18, 2)].map((g, i) => n0(facingOf([RL, RL, N3, S18][i], g))),
  [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }], 'portal signals point into the panel');
assert.deepEqual([{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }].map(v => n0(rightOf(v))),
  [{ x: 0, y: 1 }, { x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }], 'east: below (as before), west: above, down: west, up: east');
// Tags (40 x 15, gap 10, head block centred at 100, 50): on a row 10 px below eastbound / above westbound exactly as
// before; beside a train on the stem; off a row, every corner at least gap px off the train's line on its right.
assert.deepEqual([[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, y]) => tagAt(100, 50, { x, y }, 40, 15, 10)),
  [{ cx: 100, ty: 60 }, { cx: 100, ty: 25 }, { cx: 70, ty: 43 }, { cx: 130, ty: 43 }]);
const clearOf = (x, y, u, w, h, gap) => { // the least distance of the box's corners along rightOf(u) from the line through (x, y)
  const { cx, ty } = tagAt(x, y, u, w, h, gap), v = rightOf(u);
  return Math.min(...[[cx - w / 2, ty], [cx + w / 2, ty], [cx - w / 2, ty + h], [cx + w / 2, ty + h]].map(([px, py]) => (px - x) * v.x + (py - y) * v.y));
};
for (let a = 0; a < 2 * Math.PI; a += Math.PI / 12) {
  const u = { x: Math.cos(a), y: Math.sin(a) };
  assert.ok(clearOf(100, 50, u, 40, 15, 10) >= 9.5 && clearOf(100, 50, u, 64, 15, 10) >= 9.5, `tag clear of the line at ${(a * 180 / Math.PI).toFixed(0)}°`);
}

// On a junction's stem: the stem signal's heads stand on the right of travel (west of a north stem, east of a south
// one; pick finds it there, not mirrored across the line); a train's tag sits on the right of its travel; the branch
// portal's name and queue count sit beside the portal node on the right of entering travel, clear of the stem.
for (const L of [N3, S18]) {
  const R2 = createRenderer({ getContext: () => ctx, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) }), S = createSim(L, L.seed);
  R2.fit(L);
  const north = L.wye.side === 'north', side = north ? -1 : 1, z = R2.camera.zoom, sx = L.nodes[L.wye.A].x;
  const X = gx => (gx * CELL - R2.camera.x) * z, Y = gy => (gy * CELL - R2.camera.y) * z;
  const sn = L.nodes[L.signals[L.wye.stemSignal].node], off = Math.min(7, Math.max(4, 7 * z)) + Math.min(4, Math.max(3, 4 * z));
  const at = dx => R2.pick(S, X(sn.x) + dx, Y(sn.y));
  assert.deepEqual([at(side * off)?.id, at(-side * off)?.kind === 'signal'], [L.wye.stemSignal, false], `${L.wye.side}: stem signal heads by facing`);
  // Two trains on the stem, one running toward the main and one toward the portal: the tag box clears the stem line
  // on the right of each one's travel, level with its head block.
  const p = L.portals[2].node, stem = [p], branch = L.edges.filter(e => e.cls === 'branch');
  while (stem.at(-1) !== L.wye.A) stem.push(branch.map(e => (e.a === stem.at(-1) ? e.b : e.b === stem.at(-1) ? e.a : null)).find(n => n !== null && !stem.includes(n)));
  const along = ns => ns.slice(1).map((n, i) => L.edges.find(e => (e.a === ns[i] && e.b === n) || (e.b === ns[i] && e.a === n)).id);
  const inbound = spawnTrain(S, { type: 'P', dir: 1, entry: 2, name: 'P 9' }), outbound = spawnTrain(S, { type: 'P', dir: -1, exit: 2, name: 'P 11' });
  Object.assign(inbound, { path: along(stem.slice(0, 3)), pathStart: p, headDist: 1.5 }); // the stem's first two cells
  Object.assign(outbound, { path: along(stem.slice(0, 3).reverse()), pathStart: stem[2], headDist: 1.9 });
  S.queue[2].push({}, {});
  const rec2 = (rec = [], R2.draw(S, { blink: true, now: 16 }), rec), tags = rec2.filter(d => d.k === 'tag');
  for (const [t, right] of [[inbound, side], [outbound, -side]]) { // inbound runs toward the main: down a north stem, right = west
    const tag = tags.find(d => rec2.some(f => f.text === t.name && Math.abs(f.x - (d.x + d.w / 2)) < 1));
    assert.ok(tag, `${t.name} tag drawn`);
    assert.ok(right < 0 ? tag.x + tag.w <= X(sx) - 9 : tag.x >= X(sx) + 9, `${L.wye.side}: ${t.name}'s tag on the right of its travel (${tag.x}, ${tag.w}, ${X(sx)})`);
    const blocks = trainBlocks(S, t), cy = (Y(blocks[0].y1) + Y(blocks[0].y2)) / 2;
    assert.ok(tag.y <= cy + 1 && tag.y + tag.h >= cy - 1, `${t.name}'s tag level with its head block (${tag.y}, ${cy})`);
  }
  // Down the whole stem (four cells or more) and round the turn onto a leg: the blocks stay a chain (each starts where the
  // one ahead ends), the head moves on by no more than it advances, and the tag stays on the right of the head block's
  // travel all the way.
  const leg = L.edges.find(e => e.cls === 'wye' && (e.a === L.wye.A || e.b === L.wye.A)), turner = spawnTrain(createSim(L, L.seed), { type: 'M', dir: 1, entry: 2 });
  Object.assign(turner, { path: [...along(stem), leg.id], pathStart: p });
  let last = null;
  for (let hd = 0.9; hd <= stem.length - 1 + Math.SQRT2 * 2; hd += 0.05) {
    turner.headDist = hd;
    const bl = trainBlocks(S, turner), h = bl[0], l = Math.hypot(h.x1 - h.x2, h.y1 - h.y2), u = { x: (h.x1 - h.x2) / l, y: (h.y1 - h.y2) / l };
    assert.ok(bl.every((b, i) => i === 0 || (Math.abs(b.x1 - bl[i - 1].x2) < 1e-9 && Math.abs(b.y1 - bl[i - 1].y2) < 1e-9)), `a chain at ${hd}`);
    assert.ok(!last || Math.hypot(h.x1 - last.x, h.y1 - last.y) <= 0.05 + 1e-9, `the head runs on at ${hd}`);
    assert.ok(clearOf((X(h.x1) + X(h.x2)) / 2, (Y(h.y1) + Y(h.y2)) / 2, u, 38, 15, 10) >= 9.5, `tag on the right through the turn at ${hd}`);
    last = { x: h.x1, y: h.y1 };
  }
  assert.ok(Math.abs(last.y - L.mainRow[L.wye.feetMain]) < 0.2, 'down to the main');
  const name = rec2.find(d => d.text === `to ${L.portals[2].name}`), count = rec2.find(d => d.text === '+2 waiting');
  assert.ok(name && count && name.align === count.align && name.x === count.x && count.y > name.y, 'the count on the line under the name');
  assert.equal(name.align, north ? 'right' : 'left', 'running away from the stem');
  assert.ok(north ? name.x <= X(sx) - 8 : name.x >= X(sx) + 8, `${L.wye.side}: beside the stem on the right of entering travel (${name.x}, ${X(sx)})`);
  const py = Y(L.nodes[p].y), places = rec2.filter(d => L.places.some(q => q.name.toUpperCase() === d.text));
  assert.ok(north ? count.y < py - 6 : name.y > py + 6, `${L.wye.side}: beyond the portal end, clear of the stem's signals and tags (${name.y}, ${count.y}, ${py})`);
  assert.ok(places.length === L.places.length && places.every(q => [name, count].every(d => Math.abs(d.y - q.y) >= 12.5)), 'clear of the module names\' row');
  // A route down the stem locks the apex: its padlock stands beside the apex, away from the stem signal's heads, not on the stem.
  const SL = createSim(L, L.seed), A = L.nodes[L.wye.A];
  assert.ok(setRoute(SL, L.wye.stemSignal, SL.routesFrom.get(L.wye.stemSignal)[0].exitNode).ok && switchLocked(SL, L.wye.A));
  const lock = (rec = [], R2.draw(SL, { blink: true, now: 32 }), rec).find(d => d.k === 'lock' && Math.abs(d.y - Y(A.y)) < 1);
  assert.ok(lock && Math.sign(lock.x - X(A.x)) === -side && Math.abs(lock.x - X(A.x)) >= 9, `${L.wye.side}: apex padlock beside the apex (${lock?.x}, ${X(A.x)})`);
}

console.log('ui ok');
