// Pure UI helpers (no DOM, no globals): clock and delay text, docking, NX matching, the frame clock, and
// localStorage parsing with defaults. Unit-tested by tests/test_ui.mjs.

export const PANELS = ['board', 'log', 'inspector', 'legend', 'settings']; // keys 1..5, in this order
export const SPEEDS = [1, 2, 4, 8];
export const DOCK_SNAP = 24; // px from a window edge that docks a released panel
export const MAX_DT = 0.25;  // s of real time one frame may advance; a tab back from the background doesn't race

const pad = n => String(n).padStart(2, '0');

// Sim seconds since midnight -> "HH:MM", wrapping at 24 h.
export function formatClock(t) {
  const m = Math.floor(t / 60);
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

// Delay in sim seconds -> {text, cls}. A train still on its way shows "–" until it is late; a finished run
// shows its final minutes either way (U+2212 for early, like the sim's log).
export function formatDelay(sec, final = false) {
  if (!final && sec <= 0) return { text: '–', cls: '' };
  const m = final ? Math.round(sec / 60) : Math.ceil(sec / 60);
  if (m < 0) return { text: `−${-m}`, cls: 'early' };
  return { text: `+${m}`, cls: m > 0 ? 'late' : '' };
}

// The window edge ('left' | 'right' | 'bottom') a panel released at x, y with size w, h docks to in a W x H
// window, or null. The nearest edge within DOCK_SNAP wins.
export function dockFor(x, y, w, h, W, H) {
  const gap = { left: x, right: W - (x + w), bottom: H - (y + h) };
  let best = null;
  for (const k of ['left', 'right', 'bottom']) if (gap[k] <= DOCK_SNAP && (best === null || gap[k] < gap[best])) best = k;
  return best;
}

// NX second click: the armed signal's candidate route that ends at the clicked signal, or null.
export const matchCandidate = (cands, clicked) => (clicked == null ? null : (cands ?? []).find(c => c.exitSignal === clicked) ?? null);

// One frame of dtMs real ms at speed: whole sim steps to run now, and the fraction carried to the next frame.
export function tick(acc, dtMs, speed, perSec = 10) {
  const total = acc + Math.min(MAX_DT, Math.max(0, dtMs / 1000)) * perSec * speed, steps = Math.floor(total);
  return { steps, acc: total - steps };
}

export const randomSeed = rand => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(rand() * 26))).join('');

// Storage may be missing, may throw on access (privacy modes), or hold anything: clean() gets the parsed
// value or null and returns something valid.
export function loadJSON(storage, key, clean) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(key)); } catch { /* blocked storage or bad JSON: defaults */ }
  return clean(raw);
}
export function saveJSON(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked: just not remembered */ }
}

export const DEFAULT_SETTINGS = { speed: 1, density: 'normal', idleReturn: true, flash: true, dayLength: 4, slowOrders: true, idleCamera: true };
export const DAY_LENGTHS = [2, 4, 8, 0]; // lighting cycle, real minutes at 1x; 0 = always day
const obj = v => (v && typeof v === 'object' ? v : {});
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

// defaults: ui.js passes its own (idleCamera off under prefers-reduced-motion).
export function cleanSettings(v, densities, defaults = DEFAULT_SETTINGS) {
  const o = obj(v), d = defaults;
  return {
    speed: SPEEDS.includes(o.speed) ? o.speed : d.speed,
    density: densities.includes(o.density) ? o.density : d.density,
    idleReturn: bool(o.idleReturn, d.idleReturn),
    flash: bool(o.flash, d.flash),
    dayLength: DAY_LENGTHS.includes(o.dayLength) ? o.dayLength : d.dayLength,
    slowOrders: bool(o.slowOrders, d.slowOrders),
    idleCamera: bool(o.idleCamera, d.idleCamera),
  };
}

// {id: {x, y, dock, hidden}, size}; x, y place a floating panel (dock null). Board right, log bottom, the inspector
// floating under the HUD at the top left, legend and settings hidden. size: docked px (side widths, bottom height).
export const DEFAULT_LAYOUT = {
  board: { x: 0, y: 0, dock: 'right', hidden: false },
  log: { x: 0, y: 0, dock: 'bottom', hidden: false },
  inspector: { x: 12, y: 44, dock: null, hidden: false },
  legend: { x: 324, y: 44, dock: null, hidden: true },
  settings: { x: 672, y: 44, dock: null, hidden: true },
  size: { left: 420, right: 420, bottom: 200 },
};
const DOCKS = [null, 'left', 'right', 'bottom'];
const num = v => typeof v === 'number' && Number.isFinite(v);

// Each panel keeps its saved entry if the whole entry is valid, else gets its default; each dock size likewise.
export function cleanLayout(v) {
  const o = obj(v), out = {};
  for (const id of PANELS) {
    const p = o[id];
    const ok = p && typeof p === 'object' && num(p.x) && num(p.y) && DOCKS.includes(p.dock) && typeof p.hidden === 'boolean';
    out[id] = ok ? { x: p.x, y: p.y, dock: p.dock, hidden: p.hidden } : { ...DEFAULT_LAYOUT[id] };
  }
  const s = obj(o.size);
  out.size = {};
  for (const k in DEFAULT_LAYOUT.size) out.size[k] = num(s[k]) && s[k] >= 0 ? s[k] : DEFAULT_LAYOUT.size[k];
  return out;
}

// A dock's size in px in a W x H window: side docks 200 to 60% of W wide, the bottom dock 80 to 70% of H tall.
export function clampDock(side, px, W, H) {
  const [lo, hi] = side === 'bottom' ? [80, 0.7 * H] : [200, 0.6 * W];
  return Math.round(Math.max(lo, Math.min(hi, px)));
}
