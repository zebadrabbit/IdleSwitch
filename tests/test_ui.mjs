// node tests/test_ui.mjs — the UI's pure helpers (src/ui-util.js), and the renderer's fades on a recording canvas. The
// DOM side is checked by hand in a browser.
import assert from 'node:assert/strict';
import { formatClock, formatDelay, dockFor, matchCandidate, tick, loadJSON, cleanSettings, cleanLayout, clampDock,
  DEFAULT_SETTINGS, DEFAULT_LAYOUT } from '../src/ui-util.js';
import { mix, createRenderer } from '../src/render.js';
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
    if (k === 'fillText') rec.push({ k, text: a[0], x: a[1], alpha: o.globalAlpha });
    else if (k === 'strokeRect' && a[2] === 7 && a[3] === 5.5) rec.push({ k: 'lock', x: a[0] + 3.5, alpha: o.globalAlpha });
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

console.log('ui ok');
