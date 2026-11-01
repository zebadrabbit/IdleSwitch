// The app: boot from the seed, the frame loop, HUD, dockable panels with saved layout and settings, NX routing
// by clicks, keybinds, camera. Panel bodies come from panels.js; pure helpers from ui-util.js.
import { generate } from './gen.js';
import { createSim, step, DENSITY, setRoute, cancelRoute, throwSwitch, routeFrom, headNode, logEvent, signalLabel, nightOf } from './sim.js';
import { createRenderer, mix } from './render.js';
import { createIdleCamera, tween, centreOn, IDLE_CAM_MS } from './camera.js';
import { PANELS, SPEEDS, DEFAULT_SETTINGS, DEFAULT_LAYOUT, formatClock, dockFor, matchCandidate, tick, randomSeed, loadJSON, saveJSON,
  cleanSettings, cleanLayout, clampDock } from './ui-util.js';
import { boardHTML, logHTML, inspectorHTML, legendHTML, settingsHTML, densityOptions, exitLabel, switchLabel } from './panels.js';

const SIM_PER_SEC = 10;      // sim seconds per real second at 1x
const IDLE_MS = 120000;      // MANUAL with no input this long returns to AUTO (setting idleReturn)
const PANEL_MS = 250;        // DOM panels refresh at most 4x a second
const FLASH_MS = 1500;       // NX refusal: the entrance signal flashes red 3x (250 ms on, 250 off)
const LAYOUT_KEY = 'idleswitch.layout', SETTINGS_KEY = 'idleswitch.settings';
const $ = sel => document.querySelector(sel);
const store = (() => { try { return localStorage; } catch { return null; } })(); // access itself can throw
const newSeed = () => randomSeed(Math.random); // one of the app's two uses of Math.random (the idle camera's rng the other)

// ---- Boot
const params = new URLSearchParams(location.search);
const seed = params.get('seed') ?? newSeed(); // bad or empty seeds go to generate as they are
params.set('seed', seed);
try { history.replaceState(null, '', `?${params}`); } catch { /* file:// and sandboxed frames refuse */ }

const settings = loadJSON(store, SETTINGS_KEY, v => cleanSettings(v, Object.keys(DENSITY),
  { ...DEFAULT_SETTINGS, idleCamera: !matchMedia('(prefers-reduced-motion: reduce)').matches }));
let panels = loadJSON(store, LAYOUT_KEY, cleanLayout);
const layout = generate(seed);
const sim = createSim(layout, seed,
  { density: settings.density, dayLength: settings.dayLength * 60 * SIM_PER_SEC, slowOrders: settings.slowOrders });
sim.auto = true;
// Debug: ?ff=N runs N sim seconds at boot. Headless screenshots need it: --virtual-time-budget never runs rAF.
const ff = Math.min(86400, Math.max(0, parseInt(params.get('ff'), 10) || 0));
for (let i = 0; i < ff; i++) step(sim);

const canvas = $('#map'), r = createRenderer(canvas);
const state = {
  speed: settings.speed, paused: false, armedSignal: null, selected: null, lastInput: performance.now(),
  hover: null, refused: null, fitted: true, fitZoom: 1, pressInPanel: false, idleCam: false, camTween: null,
};
const panelEl = id => $(`#panel-${id}`), bodies = Object.fromEntries(PANELS.map(id => [id, $(`#panel-${id} .panel-body`)]));
const docks = { left: $('#dock-left'), right: $('#dock-right'), bottom: $('#dock-bottom') };
const saveSettings = () => saveJSON(store, SETTINGS_KEY, settings);

// ---- Camera: fit the terminal into the area the docked panels leave free (the whole window in bare mode or when
// that is under 240 x 160). F, 0 and the ⌖ button glide there; boot, resize and layout refits are instant.
const idle = createIdleCamera({ rng: Math.random });
function centreBox() {
  const b = $('#dock-center').getBoundingClientRect();
  return b.width >= 240 && b.height >= 160 ? { x: b.left, y: b.top, w: b.width, h: b.height } : { x: 0, y: 0, w: innerWidth, h: innerHeight };
}
const fitCamera = () => r.fitted(layout, centreBox());
function fit(ease = false) {
  if (ease && !state.fitted) return glide(fitCamera, true);
  state.camTween = null;
  r.fit(layout, centreBox());
  state.fitted = true;
  state.fitZoom = r.camera.zoom;
}
// Glide from the camera as it is to to() over MOVE_MS (camera.js's tween, pivoting on the centre box's centre). to is
// read every frame, so the way home lands on the fit of the docks as they are by then; home: refit when it lands.
function glide(to, home) {
  state.camTween = { from: { ...r.camera }, start: performance.now(), to, home };
  state.fitted = false;
}
const zoomLimit = z => Math.max(Math.min(0.4, state.fitZoom), Math.min(4, z)); // the wheel's and the buttons'
function zoomBy(f) { // about the centre box's centre, from where a glide in progress is going
  const b = centreBox(), c = state.camTween?.to() ?? r.camera, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const to = centreOn({ x: c.x + cx / c.zoom, y: c.y + cy / c.zoom }, b, zoomLimit(c.zoom * f));
  glide(() => to, false);
}
// Any input: note the time and take the camera back from the idle camera, gliding home to the fit.
function touch() {
  state.lastInput = performance.now();
  if (!state.idleCam) return;
  idle.reset();
  state.idleCam = false;
  glide(fitCamera, true);
}
// Each frame before drawing: the idle camera when it may run (setting on, not paused, IDLE_CAM_MS without input), else
// the glide in progress. Returns the caption to draw, which fades out on its own after input.
function steer(now, box) {
  const active = settings.idleCamera && !state.paused && now - state.lastInput > IDLE_CAM_MS;
  const u = idle.update(sim, now, { fit: r.fitted(layout, box), box, lag: t => (1 - acc) * (t.adv ?? 0), active, camera: r.camera });
  if (u?.x != null) {
    Object.assign(r.camera, { x: u.x, y: u.y, zoom: u.zoom });
    state.idleCam = true;
    state.fitted = false; // so layout and resize refits leave it alone
  } else if (state.camTween) {
    const g = state.camTween, p = tween(g.from, g.to(), g.start, { x: box.x + box.w / 2, y: box.y + box.h / 2 }).at(now);
    Object.assign(r.camera, { x: p.x, y: p.y, zoom: p.zoom });
    if (p.done) { state.camTween = null; if (g.home) fit(); }
  }
  return u?.caption ?? null;
}

// ---- HUD
function hud() {
  $('#hud-clock').textContent = formatClock(sim.time);
  const a = $('#hud-auto');
  a.textContent = sim.auto ? 'AUTO' : 'MANUAL';
  a.classList.toggle('on', sim.auto);
  $('#btn-pause').textContent = state.paused ? '▶' : '⏸';
  $('#btn-pause').classList.toggle('on', state.paused);
  $('#btn-speed').textContent = `${state.speed}×`;
  $('#hud-operator').textContent = sim.operator;
}
// Every frame: the HUD sun and moon by the night level n, and the page chrome blended toward its night colours.
const sky = $('#hud-sky'), [sun, moon] = sky.children;
let skyN = -1, chromeN = -1;
function ambient(n) {
  if (n !== skyN) { // unchanged (paused) keeps the dusk/dawn title
    sky.title = `lighting: ${n === 0 ? 'day' : n === 1 ? 'night' : n > skyN ? 'dusk' : 'dawn'}`;
    sun.style.opacity = 1 - n;
    moon.style.opacity = n;
    skyN = n;
  }
  if (Math.abs(n - chromeN) > 0.01) {
    chromeN = n;
    const css = document.documentElement.style;
    css.setProperty('--bg', mix('#0b1020', '#070b17', n));
    css.setProperty('--panel', mix('#121a2e', '#0d1424', n));
  }
}
const togglePause = () => { state.paused = !state.paused; hud(); };
function toggleAuto() {
  sim.auto = !sim.auto;
  logEvent(sim, sim.auto ? 'AUTO resumed' : 'MANUAL: panel taken');
  hud();
  refreshPanels();
}
function setSpeed(s) {
  state.speed = settings.speed = s;
  saveSettings();
  const radio = bodies.settings.querySelector(`input[name="speed"][value="${s}"]`);
  if (radio) radio.checked = true;
  hud();
}
const stepSpeed = d => setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(state.speed) + d))]);
function setDensity(d) {
  settings.density = sim.density = d;
  saveSettings();
  $('#hud-density').value = d;
  bodies.settings.querySelector('select[name="density"]').value = d;
}
// ponytail: the standard Fullscreen API only; where it is missing (iPhone Safari) the button does nothing.
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
const loadSeed = s => { location.search = `?${new URLSearchParams({ seed: s })}`; };

$('#btn-pause').addEventListener('click', togglePause);
$('#btn-speed').addEventListener('click', () => setSpeed(SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]));
$('#hud-auto').addEventListener('click', toggleAuto);
$('#btn-fullscreen').addEventListener('click', toggleFullscreen);
$('#btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
$('#btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
$('#btn-fit').addEventListener('click', () => fit(true));
$('#hud-density').innerHTML = densityOptions(settings.density);
$('#hud-density').addEventListener('change', e => { setDensity(e.target.value); e.target.blur(); }); // keys work again at once
// The HUD seed opens a popover under it: load a seed, roll a new one, or copy this one. Escape or a press elsewhere closes.
const seedBtn = $('#hud-seed'), pop = $('#seed-pop'), popSeed = pop.querySelector('input');
seedBtn.textContent = seed;
function seedPop(show) {
  pop.classList.toggle('hidden', !show);
  if (!show) return;
  pop.style.left = `${seedBtn.getBoundingClientRect().left}px`;
  popSeed.value = seed;
  popSeed.focus();
  popSeed.select();
}
seedBtn.addEventListener('click', () => seedPop(pop.classList.contains('hidden')));
addEventListener('pointerdown', e => { if (!e.target.closest?.('#seed-pop, #hud-seed')) seedPop(false); });
popSeed.addEventListener('keydown', e => { if (e.key === 'Enter') loadSeed(popSeed.value); });
pop.addEventListener('click', async e => {
  const b = e.target.closest('button'), act = b?.dataset.act;
  if (act === 'load') loadSeed(popSeed.value);
  else if (act === 'new') loadSeed(newSeed());
  else if (act === 'copy') {
    try { await navigator.clipboard.writeText(seed); b.textContent = 'copied'; } catch { b.textContent = 'copy failed'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1200);
  }
});
// A mouse click shouldn't leave focus on a button, or Space would press it again instead of pausing.
document.addEventListener('click', e => { if (e.detail) e.target.closest?.('button')?.blur(); });

// ---- Panels: dock (moved into a #dock-* grid cell) or float (left/top), hide, drag; saved on every change.
function clampPos(el, x, y) {
  const w = el.offsetWidth || 300;
  return { x: Math.max(0, Math.min(innerWidth - w, x)), y: Math.max(36, Math.min(innerHeight - 30, y)) };
}
function applyPanel(id) {
  const p = panels[id], el = panelEl(id);
  el.classList.toggle('hidden', p.hidden);
  el.classList.remove('dock-left', 'dock-right', 'dock-bottom');
  if (p.dock) {
    el.classList.add(`dock-${p.dock}`);
    if (el.parentElement !== docks[p.dock]) docks[p.dock].append(el);
    el.style.left = el.style.top = el.style.width = el.style.height = ''; // a floating resize doesn't follow it in
  } else {
    if (el.parentElement !== document.body) document.body.append(el);
    const c = clampPos(el, p.x, p.y);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
  }
  $(`#hud button[data-panel="${id}"]`).classList.toggle('on', !p.hidden);
  for (const d of Object.values(docks)) d.classList.toggle('empty', !d.querySelector('.panel:not(.hidden)')); // hides its handle
}
// Docked sizes from panels.size, clamped to the window here only, so a larger window gets the saved size back. Shown
// side docks never overlap or squeeze the map under 240 px: the left yields to the right (the right only to the floors).
const SIZE_VARS = { left: '--side-w-left', right: '--side-w-right', bottom: '--bottom-h' };
function applySizes() {
  const s = panels.size, W = innerWidth, H = innerHeight, shown = k => !docks[k].classList.contains('empty');
  const left = clampDock('left', s.left, W, H, shown('right') ? clampDock('right', s.right, W, H) : 0);
  const px = { left, right: clampDock('right', s.right, W, H, shown('left') ? left : 0), bottom: clampDock('bottom', s.bottom, W, H) };
  for (const k in SIZE_VARS) document.documentElement.style.setProperty(SIZE_VARS[k], `${px[k]}px`);
}
function layoutChanged() { // also on show/hide and docking: what a side dock may take depends on the other
  saveJSON(store, LAYOUT_KEY, panels);
  applySizes();
  if (state.fitted) fit();
  refreshPanels();
}
function togglePanel(id) {
  panels[id].hidden = !panels[id].hidden;
  applyPanel(id);
  layoutChanged();
}
function resetLayout() {
  panels = cleanLayout(DEFAULT_LAYOUT);
  PANELS.forEach(applyPanel);
  layoutChanged();
}

function startDrag(id, e) {
  const el = panelEl(id), title = e.currentTarget, x0 = e.clientX, y0 = e.clientY, rect = el.getBoundingClientRect();
  let dx = x0 - rect.left, dy = y0 - rect.top, moved = false;
  title.setPointerCapture(e.pointerId);
  const move = ev => {
    if (!moved) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      el.classList.add('dragging');
      if (panels[id].dock) { // undock at the floating size, grabbed near where the title was taken
        panels[id].dock = null;
        applyPanel(id);
        title.setPointerCapture(ev.pointerId); // moving the panel out of its dock dropped the capture
        dx = Math.max(12, Math.min(el.offsetWidth - 40, dx));
        dy = Math.min(dy, 14);
      }
    }
    const c = clampPos(el, ev.clientX - dx, ev.clientY - dy);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
  };
  const up = () => {
    title.removeEventListener('pointermove', move);
    title.removeEventListener('pointerup', up);
    title.removeEventListener('pointercancel', up);
    el.classList.remove('dragging');
    if (!moved) return;
    const b = el.getBoundingClientRect();
    Object.assign(panels[id], { x: Math.round(b.left), y: Math.round(b.top), dock: dockFor(b.left, b.top, b.width, b.height, innerWidth, innerHeight) });
    applyPanel(id);
    layoutChanged();
  };
  title.addEventListener('pointermove', move);
  title.addEventListener('pointerup', up);
  title.addEventListener('pointercancel', up);
}

for (const id of PANELS) {
  const el = panelEl(id);
  el.querySelector('.panel-title').addEventListener('pointerdown', e => {
    if (e.button === 0 && !e.target.closest('button')) { e.preventDefault(); startDrag(id, e); }
  });
  el.querySelector('.panel-hide').addEventListener('click', () => togglePanel(id));
  $(`#hud button[data-panel="${id}"]`).addEventListener('click', () => togglePanel(id));
  // ponytail: a panel's DOM isn't swapped while a press is down in it, or the press's click would be lost.
  el.addEventListener('pointerdown', () => { state.pressInPanel = true; });
}
for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, () => { state.pressInPanel = false; });
// A dock's handle: drag its inner edge to the pointer (the map refits as it goes), double-click for the default.
for (const h of document.querySelectorAll('.dock-handle')) {
  const k = h.dataset.dock, o = { left: 'right', right: 'left' }[k]; // o: the other side dock
  h.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    h.classList.add('active');
  });
  h.addEventListener('pointermove', e => {
    if (!h.hasPointerCapture(e.pointerId)) return;
    const px = k === 'left' ? e.clientX : k === 'right' ? innerWidth - e.clientX : innerHeight - e.clientY;
    panels.size[k] = clampDock(k, px, innerWidth, innerHeight, o ? docks[o].offsetWidth : 0); // 0 for an empty dock
    applySizes();
    if (state.fitted) fit();
  });
  h.addEventListener('lostpointercapture', () => { h.classList.remove('active'); layoutChanged(); });
  h.addEventListener('dblclick', () => { panels.size[k] = DEFAULT_LAYOUT.size[k]; layoutChanged(); });
}

const lastHTML = {};
function put(id, html) {
  if (lastHTML[id] !== html) { bodies[id].innerHTML = html; lastHTML[id] = html; }
}
const visible = id => !panels[id].hidden && !document.body.classList.contains('bare');
function refreshPanels() {
  hud();
  if (state.pressInPanel) return;
  if (visible('board')) put('board', boardHTML(sim, state.selected?.kind === 'train' ? state.selected.id : null));
  if (visible('log')) put('log', logHTML(sim));
  if (visible('inspector')) put('inspector', inspectorHTML(sim, state.selected, state.armedSignal));
}

bodies.legend.innerHTML = legendHTML();
bodies.settings.innerHTML = settingsHTML(settings, seed);
document.body.classList.toggle('noflash', !settings.flash);
bodies.settings.addEventListener('change', e => {
  const t = e.target;
  if (t.name !== 'seed') t.blur(); // a focused control swallows the keybinds
  if (t.name === 'speed') setSpeed(Number(t.value));
  else if (t.name === 'density') setDensity(t.value);
  else if (t.name === 'dayLength') {
    settings.dayLength = Number(t.value);
    sim.dayLength = settings.dayLength * 60 * SIM_PER_SEC;
    saveSettings();
  } else if (t.type === 'checkbox') { // idleReturn, flash, slowOrders, idleCamera
    settings[t.name] = t.checked;
    sim.slowOrders = settings.slowOrders;
    saveSettings();
    document.body.classList.toggle('noflash', !settings.flash);
  }
});
bodies.settings.addEventListener('click', e => {
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'reset') resetLayout();
  else if (act === 'load') loadSeed(bodies.settings.querySelector('input[name="seed"]').value);
  else if (act === 'new') loadSeed(newSeed());
});
bodies.settings.querySelector('input[name="seed"]').addEventListener('keydown', e => { if (e.key === 'Enter') loadSeed(e.target.value); });
bodies.board.addEventListener('click', e => {
  const row = e.target.closest('tr[data-train]');
  if (row) selectTrain(Number(row.dataset.train));
});
bodies.inspector.addEventListener('click', e => {
  const d = e.target.closest('button')?.dataset;
  if (!d) return;
  if (d.exit !== undefined) nx(Number(d.sig), Number(d.exit));
  else if (d.cancel !== undefined) cancel(Number(d.cancel));
  else if (d.throw !== undefined) throwIt(Number(d.throw));
  refreshPanels();
});

// ---- NX and the other panel actions. Clicks never change AUTO/MANUAL; the operator leaves human routes alone.
function nx(sig, exitNode) {
  const res = setRoute(sim, sig, exitNode, { human: true });
  if (res.ok) {
    logEvent(sim, `Route set: ${signalLabel(sim, sig)} → ${exitLabel(sim, res.route.cand)}`);
    state.armedSignal = null;
  } else {
    logEvent(sim, `Route refused: ${res.reason}`);
    state.refused = { signal: sig, until: performance.now() + FLASH_MS };
  }
}
function cancel(routeId) {
  const rt = sim.routes.get(routeId);
  if (rt && cancelRoute(sim, routeId)) logEvent(sim, `Route cancelled: ${signalLabel(sim, rt.signal)}`);
  else logEvent(sim, 'Cancel refused: a train is on the route');
}
function throwIt(node) {
  if (throwSwitch(sim, node)) logEvent(sim, `Switch ${switchLabel(sim, node)} thrown ${sim.switchState.get(node).lie}`);
  else {
    logEvent(sim, `Switch ${switchLabel(sim, node)} refused: locked`);
    const insp = panelEl('inspector');
    insp.classList.remove('shake');
    void insp.offsetWidth; // restart the animation
    insp.classList.add('shake');
  }
}
function selectTrain(id) {
  const t = sim.trains.get(id);
  if (!t) return;
  state.selected = { kind: 'train', id };
  state.armedSignal = sim.signalAt.get(`${headNode(sim, t)}:${t.dir}`) ?? null; // pre-arm its next signal
  refreshPanels();
}
function clickSignal(id) {
  const armed = state.armedSignal;
  if (armed === id) { // the entrance again: cancel its un-entered route, or just disarm
    const rt = routeFrom(sim, id);
    if (rt) cancel(rt.id);
    state.armedSignal = null;
  } else if (armed !== null) nx(armed, matchCandidate(sim.routesFrom.get(armed), id)?.exitNode); // no match: 'no such route'
  else {
    state.armedSignal = id;
    state.selected = { kind: 'signal', id };
  }
}
function clearSelection() {
  state.armedSignal = state.selected = state.refused = null;
}
function onMapClick(hit) {
  if (!hit) clearSelection();
  else if (hit.kind === 'signal') clickSignal(hit.id);
  else if (hit.kind === 'train') selectTrain(hit.id);
  else if (hit.kind === 'switch') { state.selected = { kind: 'switch', id: hit.id }; throwIt(hit.id); }
  else if (hit.kind === 'route') cancel(hit.id);
  refreshPanels();
}

// ---- Canvas: click picks, drag pans, wheel zooms about the cursor. The canvas fills the window from (0, 0),
// so client coordinates are canvas coordinates.
let press = null;
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  press = { x: e.clientX, y: e.clientY, panning: false };
});
canvas.addEventListener('pointermove', e => {
  if (press) {
    // From the camera as it is then (a glide may have moved it since the press), by the pointer's travel since the press,
    // so the grabbed point stays under the cursor.
    if (!press.panning && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4)
      Object.assign(press, { panning: true, cx: r.camera.x, cy: r.camera.y });
    if (press.panning) {
      r.camera.x = press.cx - (e.clientX - press.x) / r.camera.zoom;
      r.camera.y = press.cy - (e.clientY - press.y) / r.camera.zoom;
      state.fitted = false;
      state.camTween = null; // a drag takes over from any glide where it is
      canvas.style.cursor = 'grabbing';
    }
    return;
  }
  const hit = r.pick(sim, e.clientX, e.clientY);
  state.hover = hit?.kind === 'signal' ? hit.id : null;
  canvas.style.cursor = hit ? 'pointer' : '';
});
canvas.addEventListener('pointerup', () => {
  const p = press;
  press = null;
  canvas.style.cursor = '';
  if (p && !p.panning) onMapClick(r.pick(sim, p.x, p.y));
});
canvas.addEventListener('pointercancel', () => { press = null; });
canvas.addEventListener('pointerleave', () => { state.hover = null; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const c = r.camera, dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1); // Firefox scrolls in lines
  const z = zoomLimit(c.zoom * Math.exp(-dy * 0.0015));
  const wx = c.x + e.clientX / c.zoom, wy = c.y + e.clientY / c.zoom;
  c.zoom = z;
  c.x = wx - e.clientX / z;
  c.y = wy - e.clientY / z;
  state.fitted = false;
  state.camTween = null;
}, { passive: false });

// ---- Keys (ignored while typing in a field; a focused button keeps Space and Enter).
addEventListener('keydown', e => {
  touch();
  if (e.key === 'Escape') seedPop(false);
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, select, textarea')) return;
  if (e.target.closest?.('button') && (e.key === ' ' || e.key === 'Enter')) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const keys = {
    ' ': togglePause, '+': () => stepSpeed(1), '=': () => stepSpeed(1), '-': () => stepSpeed(-1), a: toggleAuto,
    f: () => fit(true), 0: () => fit(true),
    h: () => { document.body.classList.toggle('bare'); if (state.fitted) fit(); refreshPanels(); },
    Escape: () => { clearSelection(); refreshPanels(); }, '?': () => togglePanel('legend'), n: () => loadSeed(newSeed()),
  };
  if (k >= '1' && k <= '5') togglePanel(PANELS[Number(k) - 1]);
  else if (keys[k]) keys[k]();
  else return;
  e.preventDefault();
});
// Capture: touch hands the camera back before a canvas drag or wheel takes it.
for (const ev of ['pointerdown', 'pointermove', 'wheel']) addEventListener(ev, touch, { passive: true, capture: true });

addEventListener('resize', () => {
  r.resize();
  PANELS.forEach(applyPanel); // re-clamp floating panels into the window
  applySizes();
  if (state.fitted) fit();
});

// ---- Frame loop
function uiFor(now, caption, box) {
  const s = state.selected, f = state.refused && now < state.refused.until ? state.refused : null;
  const hide = id => (f && f.signal === id ? null : id); // the refusal flash replaces the rings on its signal
  return {
    selectedSignal: s?.kind === 'signal' ? hide(s.id) : null,
    selectedTrain: s?.kind === 'train' ? s.id : null,
    selectedSwitch: s?.kind === 'switch' ? s.id : null,
    armedSignal: hide(state.armedSignal),
    refusedSignal: f && Math.floor((f.until - now) / 250) % 2 === 1 ? f.signal : null,
    hoverSignal: state.hover,
    blink: !settings.flash || Math.floor(now / 500) % 2 === 0,
    alpha: acc, // fraction of the next sim step already elapsed; the renderer interpolates train positions with it
    now, caption, box,
  };
}

let last = performance.now(), acc = 0, lastPanels = -Infinity, failed = false;
// A throw must not stop a screensaver: the first one goes to the console and the sim log, and the loop runs on. The
// sim, the drawing and the panels are guarded apart, so one failing still leaves the others (and the logged error) on screen.
function guarded(f) {
  try { f(); } catch (err) {
    if (!failed) { failed = true; console.error(err); logEvent(sim, `ERROR: ${err?.message ?? err}`); }
  }
}
function frame(now) {
  const dt = now - last;
  last = now;
  guarded(() => {
    if (!state.paused) {
      const t = tick(acc, dt, state.speed, SIM_PER_SEC);
      acc = t.acc;
      for (let i = 0; i < t.steps; i++) step(sim);
    }
    if (!sim.auto && settings.idleReturn && performance.now() - state.lastInput > IDLE_MS) {
      sim.auto = true;
      logEvent(sim, 'AUTO resumed (idle)');
    }
    if (state.selected?.kind === 'train' && !sim.trains.has(state.selected.id)) state.selected = state.armedSignal = null; // it left
  });
  const box = centreBox();
  let caption = null;
  guarded(() => { caption = steer(now, box); });
  guarded(() => r.draw(sim, uiFor(now, caption, box)));
  guarded(() => ambient(nightOf(sim)));
  if (now - lastPanels >= PANEL_MS) { lastPanels = now; guarded(refreshPanels); }
  requestAnimationFrame(frame);
}

PANELS.forEach(applyPanel);
applySizes();
r.resize();
fit();
refreshPanels();
requestAnimationFrame(frame);

export { sim, r, state }; // for the console: (await import('./src/ui.js')).sim
