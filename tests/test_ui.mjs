// node tests/test_ui.mjs — the UI's pure helpers (src/ui-util.js). The DOM side is checked by hand in a browser.
import assert from 'node:assert/strict';
import { formatClock, formatDelay, dockFor, matchCandidate, tick, loadJSON, cleanSettings, cleanLayout,
  DEFAULT_SETTINGS, DEFAULT_LAYOUT } from '../src/ui-util.js';
import { mix } from '../src/render.js';

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

// Colour blend (night chrome and palette): endpoints exact, midpoint rounds per channel.
assert.deepEqual([0, 0.5, 1].map(t => mix('#0b1020', '#070b17', t)), ['#0b1020', '#090e1c', '#070b17']);

console.log('ui ok');
