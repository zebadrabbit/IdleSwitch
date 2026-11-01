# Idle Ambience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lighting cycle with glows and fades, night-shifted traffic, slow orders, a named operator, resizable docks, an idle camera, and HUD seed entry and zoom controls, all eased, no hard cuts.

**Architecture:** The sim gains a night level, a second rng stream for slow orders and the operator, and an `edgeSpeed` indirection; the renderer gains per-id colour easing, glows drawn with `lighter`, and a caption; a new pure `camera.js` holds tweens and the idle-camera state machine; `ui.js` wires settings, HUD, dock handles, the seed popover, zoom buttons and the camera into the frame loop. Nothing new touches `gen.js`.

**Tech Stack:** Vanilla ES modules, Canvas 2D, CSS; `node:assert` tests run by `manage.sh test` and CI.

**Spec:** `docs/superpowers/specs/2026-11-01-idle-ambience-design.md`

## Global Constraints

- Pure modules (`sim.js`, `ui-util.js`, `camera.js`) never touch `window`, `document`, `Math.random`, `Date`, `performance`.
- Same seed, same layout, same day: slow orders and the operator draw from `sim.extras = makeRng(seed + ':extras')`, never `sim.rng`.
- Every colour or position change on the canvas is eased: colour fades `τ` 120 ms (lamps 60 ms, headlight 200 ms), camera moves `MOVE_MS = 1000` smoothstep, caption crossfade 400 ms.
- Existing invariants hold in the soak with slow orders on: no double occupancy, no passed red, no stall, section and wrong-main rules.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Run `./manage.sh test` before every commit.
- Ponytail: the shortest diff that works; mark deliberate ceilings with `// ponytail:`.

## Review Focus

1. A tab returning from the background: frame `dt` is seconds long; fades, the caption and the camera must not snap or overshoot (clamp `dt` to 100 ms in the renderer, `MAX_DT` already clamps the sim). Test: Task 5 tween with `dt` > `MOVE_MS` lands exactly on the target.
2. A train that leaves mid-follow: the follow shot must end the same frame and the camera ease home, not read a missing train. Test: Task 5 "follow ends when the train is removed".
3. Slow orders off while one is active: it must run out, not vanish, and must not throw when `sim.slowOrders` is false. Test: Task 1 "turning off lets it run out".
4. A saved layout from before this round (no `size`): docks must get the default sizes, not `undefined` px. Test: Task 4 `cleanLayout` without `size`.
5. Dock handle drags past the clamp or a window smaller than the saved dock: sizes clamp live, never leave the map box below the 240 × 160 fit floor. Test: Task 4 `clampDock` helper cases.

---

### Task 1: Sim: night level, traffic mix, slow orders, operator

**Files:**
- Modify: `src/sim.js` (createSim, trafficMenu, moveTrains, step, logEvent users, exports)
- Test: `tests/test_sim.mjs`

**Interfaces:**
- Consumes: `makeRng` from `rng.js`, `sim.sectionEdges` (section → main edge ids), `sim.layout.mainRow`.
- Produces: `export function nightLevel(time, dayLength) -> number` (0..1; `dayLength <= 0` → 0; time measured from `6 * 3600`); `export const SLOW_ORDER = { gap: 1200, min: 300, max: 600, mph: 20 }`; `export const edgeSpeed = (sim, e) -> mph` (`e` an edge object); `export const OPERATORS` (24 surnames from the spec); `createSim(layout, seed, opts)` accepting `opts.dayLength` (sim s, default 2400), `opts.slowOrders` (default true); sim fields `dayLength`, `slowOrders`, `extras`, `slowOrder: null | { section, until, main, x0, x1 }`, `nextSlowOrder`, `operator` (string), `nextShift` (sim s); `export function nightOf(sim) -> nightLevel(sim.time, sim.dayLength)`; `export function slowOrderLabel(sim) -> 'Main 1 12–40'` style text for the active order (used by the log and the renderer).

- [ ] **Step 1: Write the failing tests** (append to `tests/test_sim.mjs` before the soak section; `S` helpers as the file already uses)

```js
// Lighting cycle: day, dusk midpoint, night, dawn midpoint; off when dayLength is 0
const T0 = 6 * 3600, P = 2400;
assert.deepEqual([0, 0.2, 0.45, 0.5, 0.7, 0.95].map(f => +nightLevel(T0 + f * P, P).toFixed(2)), [0, 0, 0.5, 1, 1, 0.5]);
assert.equal(nightLevel(T0 + 0.6 * P, 0), 0);
assert.ok(nightLevel(T0 + 0.42 * P, P) > 0 && nightLevel(T0 + 0.42 * P, P) < 0.5, 'dusk ramps');

// Traffic mix: at full night passenger weights are 30 % of day, freight 170 %, locals unchanged
{
  const A = createSim(L, 'lebanon'), B = createSim(L, 'lebanon');
  B.time = T0 + 0.6 * B.dayLength; // night
  const w = (S, pred) => trafficMenu(S, E).filter(pred).reduce((s, m) => s + m.weight, 0);
  const pax = m => m.type === 'X' || m.type === 'P', frt = m => ['Z', 'M', 'C', 'G', 'I'].includes(m.type), loc = m => m.type === 'L';
  assert.ok(close(w(B, pax), 0.3 * w(A, pax)) && close(w(B, frt), 1.7 * w(A, frt)) && w(B, loc) === w(A, loc));
}

// Slow orders: appear, apply, lift, log; only on main sections; separate rng stream; off lets one run out
{
  const S1 = createSim(L, 's7'), S2 = createSim(L, 's7', { slowOrders: false }); // normal density: queues never fill, so both draw the same entries
  let seen = null;
  for (let i = 0; i < 4 * SLOW_ORDER.gap && !seen; i++) { step(S1); if (S1.slowOrder) seen = { ...S1.slowOrder }; }
  assert.ok(seen, 'a slow order appears within 4 mean gaps');
  assert.ok(S1.sectionEdges.has(seen.section), 'on a main section');
  const inSec = S1.sectionEdges.get(seen.section);
  assert.ok(inSec.every(e => edgeSpeed(S1, L.edges[e]) === SLOW_ORDER.mph));
  assert.ok(L.edges.filter(e => e.section !== seen.section).every(e => edgeSpeed(S1, e) === e.speed));
  assert.ok(S1.log.some(l => l.text.startsWith(`Slow order: ${slowOrderLabel(S1)}, 20 mph until `)));
  S1.slowOrders = false; // turned off mid-order: it runs out on schedule
  while (S1.time <= seen.until) step(S1);
  assert.equal(S1.slowOrder, null);
  assert.ok(S1.log.some(l => l.text === `Slow order lifted: Main ${seen.main} ${seen.x0}–${seen.x1}`));
  for (let i = 0; i < 4 * SLOW_ORDER.gap; i++) step(S2);
  assert.equal(S2.slowOrder, null, 'none when off');
  const names = S => [...S.queue[E], ...S.queue[W], ...S.trains.values(), ...S.completed].map(t => t.name).sort();
  assert.deepEqual(names(S1).slice(0, 20), names(S2).slice(0, 20), 'traffic unchanged by slow orders');
}

// Operator: named at boot, changes at 14:00 with a new name, logged
{
  const S = createSim(L, 'lebanon');
  assert.match(S.operator, /^[A-Z]\. [A-Z][a-z]+$/);
  assert.ok(OPERATORS.includes(S.operator.slice(3)));
  assert.equal(S.log[0]?.text, `${S.operator} on duty`);
  const first = S.operator;
  while (S.time < 14 * 3600 + 5) step(S);
  assert.notEqual(S.operator, first);
  assert.ok(S.log.some(l => l.text === `Shift change: ${S.operator} takes the desk`));
}
```

Add `nightLevel, trafficMenu, SLOW_ORDER, edgeSpeed, slowOrderLabel, OPERATORS` to the import list. Also in the soak: after each step assert `S.slowOrder === null || S.sectionEdges.has(S.slowOrder.section)`, and the existing invariants stay (slow orders are on by default there).

- [ ] **Step 2: Run to verify failure**

Run: `node tests/test_sim.mjs` — Expected: FAIL, `nightLevel` is not exported.

- [ ] **Step 3: Implement in `src/sim.js`**

- `nightLevel(time, dayLength)` per the spec table with `smoothstep(x) = x*x*(3-2*x)` on the clamped ramp.
- `createSim`: `dayLength: opts.dayLength ?? 2400`, `slowOrders: opts.slowOrders ?? true`, `extras: makeRng(seed + ':extras')`, `slowOrder: null`, `nextSlowOrder: start - SLOW_ORDER.gap * Math.log(1 - extras())`, `operator: drawOperator(extras, null)`, `nextShift: start + 8 * 3600`; push `${operator} on duty` as the first log line. `drawOperator(rng, not)` draws initial `A`–`Z` and a surname until the result differs from `not`.
- `trafficMenu`: multiply weights by `n = nightOf(sim)` factors (passenger `1 - 0.7n`, freight `1 + 0.7n`; freight = `Z`, `M` and spur industry types; `L` unchanged).
- `slowOrders(sim)` called in `step` after `spawner`: lift when `sim.time >= slowOrder.until` (log, set null, draw `nextSlowOrder = time + gap × (-ln(1-u))`); start when `slowOrders && !slowOrder && time >= nextSlowOrder` (section uniform over `[...sectionEdges.keys()]`, duration uniform in `[min, max]`, compute `main` (1 or 2) and `x0`/`x1` from the section's edge nodes, log with `formatClock`-style `HH:MM` built locally from `until`). When `slowOrders` is false and none is active, keep advancing `nextSlowOrder` past `time` without drawing (so toggling on later does not fire at once).
- `shifts(sim)` in `step`: when `time >= nextShift`, draw a new operator (≠ current), log, `nextShift += 8 * 3600`.
- `edgeSpeed(sim, e)`; `moveTrains` uses `edgeSpeed(sim, edges[e]) * MPH` where it read `edges[e].speed`.
- `slowOrderLabel(sim)` → `` `Main ${main} ${x0}–${x1}` `` (en dash).

- [ ] **Step 4: Run the suite** — `./manage.sh test` — Expected: all `ok`.

- [ ] **Step 5: Commit** — `feat(sim): lighting cycle, night traffic mix, slow orders, operator shifts`

---

### Task 2: Settings, HUD glyphs, night CSS, legend

**Files:**
- Modify: `src/ui-util.js` (DEFAULT_SETTINGS, cleanSettings), `src/panels.js` (settingsHTML, legendHTML, KEYS), `src/ui.js` (settings wiring, HUD updates, night vars), `index.html` (HUD spans), `src/style.css`
- Test: `tests/test_ui.mjs`

**Interfaces:**
- Consumes: `nightOf(sim)`, `sim.operator`, `sim.slowOrders`, `sim.dayLength`, `SIM_PER_SEC` (ui.js).
- Produces: `DEFAULT_SETTINGS = { speed: 1, density: 'normal', idleReturn: true, flash: true, dayLength: 4, slowOrders: true, idleCamera: true }`; `cleanSettings(v, densities, defaults = DEFAULT_SETTINGS)` (third arg lets ui.js pass a reduced-motion default); `export const DAY_LENGTHS = [2, 4, 8, 0]`; `export const SLOW_ORDER_COLOR = '#b8862b'` in `render.js` COLORS as `COLORS.slow`; `KEYS` gains `['0', 'reset view']` next to `F`.

- [ ] **Step 1: Failing tests** (append to `tests/test_ui.mjs`)

```js
// New settings: defaults, validation, and a caller-supplied default for idleCamera
assert.deepEqual(settings(null), DEFAULT_SETTINGS);
assert.deepEqual([settings({ dayLength: 8 }).dayLength, settings({ dayLength: 3 }).dayLength, settings({ dayLength: 0 }).dayLength], [8, 4, 0]);
assert.deepEqual([settings({ slowOrders: false }).slowOrders, settings({ slowOrders: 'no' }).slowOrders], [false, true]);
assert.equal(cleanSettings(null, D, { ...DEFAULT_SETTINGS, idleCamera: false }).idleCamera, false);
assert.equal(cleanSettings({ idleCamera: true }, D, { ...DEFAULT_SETTINGS, idleCamera: false }).idleCamera, true);
```

- [ ] **Step 2: Run** — `node tests/test_ui.mjs` — Expected: FAIL on the first deepEqual.

- [ ] **Step 3: Implement**

- `ui-util.js`: the three fields, `DAY_LENGTHS`, the `defaults` parameter.
- `panels.js` `settingsHTML`: after Density an `Ambient` group: `<div class="sub">Ambient</div>`, `Day length` select `name="dayLength"` with options `2 min | 4 min | 8 min | off` (values `2 4 8 0`), checkboxes `slowOrders` ("slow orders") and `idleCamera` ("idle camera after 1 idle minute"). `legendHTML` tracks list gains `['slow order', COLORS.slow]`. `KEYS` gains `['0', 'reset view']`.
- `render.js`: `COLORS.slow = '#b8862b'` (used by Task 3).
- `index.html`: `<span id="hud-sky" title="lighting"><i class="sun">☀</i><i class="moon">☾</i></span>` between the clock and pause; `<span id="hud-operator" class="dim"></span>` after `#hud-auto`.
- `style.css`: `#hud-sky { position: relative; width: 16px; display: inline-block; } #hud-sky i { position: absolute; left: 0; top: -9px; font-style: normal; } #hud-sky .sun { color: var(--amber); } #hud-sky .moon { color: var(--text); }`; `:root` keeps `--bg`/`--panel` as the day values (JS overrides them at night).
- `ui.js`: pass `{ density, dayLength: settings.dayLength * 60 * SIM_PER_SEC, slowOrders: settings.slowOrders }` to `createSim`; settings `change` handler: `dayLength` → `sim.dayLength = Number(v) * 60 * SIM_PER_SEC`, `slowOrders` → `sim.slowOrders`, `idleCamera` → settings only (Task 6 reads it); `hud()` sets `#hud-operator` text; a new `ambient(n)` called every frame from `frame()`: sun/moon opacities `1 - n` / `n`, `#hud-sky` title `lighting: day|dusk|night|dawn` (dusk when rising and 0 < n < 1, dawn when falling), and when `|n - lastN| > 0.01` set `--bg` and `--panel` on `document.documentElement.style` to the blend of the spec's day/night hex pairs (a `mix(hexA, hexB, t)` helper in `render.js`, exported, since Task 3 needs it too: returns `#rrggbb`). `idleCamera` default: `cleanSettings(v, keys, { ...DEFAULT_SETTINGS, idleCamera: !matchMedia('(prefers-reduced-motion: reduce)').matches })`.

- [ ] **Step 4: Run** — `./manage.sh test` all `ok`; `./manage.sh restart` and screenshot `?seed=s42&ff=1500` (phase 0.625 = night at the default period): the HUD moon is bright, the sun faint, the operator name shows after AUTO, panels are darker than the day screenshot `?seed=s42&ff=600`.

- [ ] **Step 5: Commit** — `feat(ui): ambient settings, sun/moon and operator in the HUD, night chrome`

---

### Task 3: Renderer: fades, glows, end-of-train marker, slow-order amber, caption

**Files:**
- Modify: `src/render.js`
- Verify: headless screenshots (no unit test; the renderer is DOM)

**Interfaces:**
- Consumes: `nightOf`, `edgeSpeed`, `sim.slowOrder`, `slowOrderLabel`, `COLORS.slow`, `mix`; `ui.now`, `ui.blink`, `ui.alpha`; new `ui.caption: { text, alpha } | null` (Task 6 supplies; null until then).
- Produces: `r.draw(sim, ui)` honours `ui.caption`; exported `mix(a, b, t)`; exported `ease(from, to, dtMs, tauMs) -> number` (the per-channel exponential approach, reused for the headlight alpha and unit-testable in Task 5's file if wanted).

- [ ] **Step 1: Colour state.** A `Map` `fade` of id → `[r, g, b]` and a helper `col(id, targetHex, dt, tau)` that eases each channel and returns `rgb(...)`; ids not touched this frame are deleted at the end of `draw` (track a `seen` set). `dt = min(100, ui.now - lastNow)`. Use it for: edge colours (`edgeColor` becomes the *target*; idle colour is the night-mixed track colour, or `COLORS.slow` when `e.section === sim.slowOrder?.section` and the edge is idle), switch dots (`sw:<node>`), signal lamps (`<sig>:<i>`, τ 60), headlight alpha (`hl:<train>`, τ 200: ease a scalar between 0 and the night-blended alpha).

- [ ] **Step 2: Night palette.** `n = nightOf(sim)`; `bg = mix('#0b1020', '#070b17', n)`, `track = mix('#8a93ab', '#6c7590', n)`, label and dim colours scaled by `1 - 0.15n` (a `dimBy(hex, f)` helper or `mix(hex, '#000000', 0.15n)`).

- [ ] **Step 3: Glows** with `ctx.globalCompositeOperation = 'lighter'`, restored to `source-over` after each group:
  - Platform light: for each platform track, a vertical linear gradient band of height `0.5 × cellPx` on the outer side of the platform box (the side its label sits on), `#ffd9a0` at alpha `0.35n` fading to 0 away from the box. Drawn right after the platform boxes.
  - Headlight: after the tracks, before the trains: for each train with blocks, an ellipse (`ctx.ellipse`, rotated to the block's direction) centred `1.25` cells ahead of the loco's front `(x1, y1)` along travel, radii `1.25` and `0.6` cells × zoom, radial gradient from `#fff1c4` at the eased alpha (target `mix(0.22, 0.55, n)` when `train.speed > 0`, else 0) to transparent.
  - Lamp halos: with each lamp, when lit, a radial gradient disc radius `3 × g.rad` in the lamp colour at alpha `mix(0.18, 0.45, n)`.
  - End-of-train marker: after the blocks of each train, a disc radius `max(1.5, 1.6z)` in `COLORS.lamp.R` at the last block's `(x2, y2)` when `ui.blink` (steady when flashing is off: `ui.blink` is already `true` then).

- [ ] **Step 4: Slow order label.** When `sim.slowOrder`, text `SLOW 20` at the section's midpoint x, on the outer side of its main (`y - (lw/2 + 9)` for Main 1, `y + (lw/2 + 9)` for Main 2), `11px` sans, `#f0b429`. Midpoint from the min/max node x of `sim.sectionEdges.get(section)`.

- [ ] **Step 5: Caption.** If `ui.caption?.text`, draw it at `(box.x + 16, box.y + box.h - 16)` with `ui.caption.alpha`, `12px` sans, dim colour, left-aligned; `box` is `ui.box ?? { x: 0, y: 0, w: innerWidth, h: innerHeight }` (Task 6 passes the dock-centre box).

- [ ] **Step 6: Verify.** `./manage.sh test` (unchanged), then screenshots: `?seed=s42&ff=600` (day) and `?seed=s42&ff=1500` (night) at 1600×900; and `?seed=s7&ff=2600`. Check: halos on lit lamps, headlights ahead of moving locos only, red tail dots, platform bands only in the night shot, no glow bleeding across the HUD, and an amber `SLOW 20` stretch in at least one of the three (if none shows, try `ff` values 1200 apart until one does; note which in the report). Read the screenshots.

- [ ] **Step 7: Commit** — `feat(render): eased colours, night palette, headlights, lamp halos, platform lights, EOT marker, slow-order amber`

---

### Task 4: Resizable docks and floating panels

**Files:**
- Modify: `src/ui-util.js` (DEFAULT_LAYOUT, cleanLayout, `clampDock`), `src/ui.js` (handles, CSS vars), `src/style.css`, `index.html` (handle elements)
- Test: `tests/test_ui.mjs`

**Interfaces:**
- Produces: `DEFAULT_LAYOUT.size = { left: 420, right: 420, bottom: 200 }`; `cleanLayout(v)` returns `size` with each of the three a finite number ≥ 0 else the default; `export function clampDock(side, px, W, H) -> number` (sides `[200, 0.6W]`, bottom `[80, 0.7H]`).

- [ ] **Step 1: Failing tests**

```js
// Dock sizes: defaults when missing or bad, kept when valid; clamps
assert.deepEqual(cleanLayout(null).size, { left: 420, right: 420, bottom: 200 });
assert.deepEqual(cleanLayout({ size: { left: 300, right: 'x', bottom: -5 } }).size, { left: 300, right: 420, bottom: 200 });
assert.deepEqual([clampDock('left', 10, 1366, 768), clampDock('right', 2000, 1366, 768), clampDock('bottom', 1000, 1366, 768), clampDock('bottom', 150, 1366, 768)],
  [200, Math.round(0.6 * 1366), Math.round(0.7 * 768), 150]);
```

- [ ] **Step 2: Run** — FAIL: `size` undefined.

- [ ] **Step 3: Implement**

- `ui-util.js`: `size` in the default layout, validation in `cleanLayout` (negative → default), `clampDock`.
- `index.html`: inside each dock div a `<div class="dock-handle" data-dock="left|right|bottom"></div>` as the last child.
- `style.css`: `.dock-handle { flex: none; pointer-events: auto; background: transparent; }`, side handles `width: 6px; cursor: col-resize; align-self: stretch` placed on the inner edge (left dock: handle after the panel, `flex-direction: row` wrapper needed → simplest: make `#dock-left`/`#dock-right` `display: grid; grid-template-columns: auto 6px` / `6px auto` with the handle in the inner column and the panel in the other; bottom dock `grid-template-rows: 6px auto` with the handle first), `:hover` and `.active` background `rgba(90,169,255,.4)`; `#docks .dock-handle:only-child { display: none }` hides a handle whose dock is empty; `#docks .panel.dock-left { width: var(--side-w-left) }`, `.dock-right { width: var(--side-w-right) }`, `.dock-bottom { height: var(--bottom-h) }`; floating: `body > .panel { resize: both; overflow: hidden; min-width: 220px; min-height: 60px; }` (the panels live directly under `body` when floating).
- `ui.js`: `applySizes()` sets the three CSS vars from `panels.size` (called at boot, after reset, and on resize with clamping); handle `pointerdown` → capture, on move `panels.size[dock] = clampDock(dock, …)` from the pointer position (left: `clientX`; right: `innerWidth - clientX`; bottom: `innerHeight - clientY`), `applySizes()`, `if (state.fitted) fit()`; on up `layoutChanged()`; `dblclick` resets that dock to its default and saves. `resetLayout` restores `size` too (it already clones `DEFAULT_LAYOUT` through `cleanLayout`).

- [ ] **Step 4: Verify** — `./manage.sh test`; screenshot at 1366×768 and 1920×1080 with the default layout: board 420 px, log 200 px, handles invisible until hover (not visible in the shot), map fitted into the remaining box.

- [ ] **Step 5: Commit** — `feat(ui): resizable docks and floating panels`

---

### Task 5: `camera.js`: tweens and the idle camera

**Files:**
- Create: `src/camera.js`
- Create: `tests/test_camera.mjs`; add it to `manage.sh test` and `.github/workflows/test.yml`

**Interfaces:**
- Consumes: `pointAt`, `headNode`, `exitNodes`, `signalLabel`, `TYPES`, `MPH` from `sim.js`; `CELL` from `render.js` (import the constant only; `render.js` has no top-level DOM access, so importing it in node is safe — verify with `node -e "import('./src/render.js')"`).
- Produces:
  - `export const smoothstep = x => …` (clamped);
  - `export const MOVE_MS = 1000, CAPTION_MS = 400, IDLE_CAM_MS = 60000`;
  - `export function tween(from, to, startMs) -> { at(nowMs) -> { x, y, zoom, done } }` interpolating `x`, `y` linearly and `zoom` geometrically on `smoothstep((now - start) / MOVE_MS)`;
  - `export function centreOn(w, box, zoom) -> { x, y, zoom }` (spec formula; `w` in world px);
  - `export function createIdleCamera({ rng }) -> { update(sim, now, { fit, box, lag, active }), reset() }` returning `{ x, y, zoom, caption }` or null; `caption` is `{ text, alpha }` or null, with the crossfade state inside the module (`alpha` ramps 0→1 over `CAPTION_MS` after a text change; during a change the *old* text is returned with falling alpha for the first half, then the new text rising: one text at a time keeps the renderer trivial).
  - `export function followCandidates(sim, lag) -> train[]`, `export function signalCandidates(sim) -> signalId[]` (spec rules), exported for tests.

- [ ] **Step 1: Failing tests** (`tests/test_camera.mjs`; build a sim from `generate('lebanon')`, run `step` until a train is moving on the main; `const rng = makeRng('cam')`)

```js
assert.deepEqual([smoothstep(-1), smoothstep(0), smoothstep(0.5), smoothstep(1), smoothstep(2)], [0, 0, 0.5, 1, 1]);
for (let x = 0; x < 1; x += 0.1) assert.ok(smoothstep(x + 0.1) >= smoothstep(x));
const tw = tween({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 50, zoom: 4 }, 1000);
assert.deepEqual(tw.at(1500), { x: 50, y: 25, zoom: 2, done: false });
assert.deepEqual(tw.at(5000), { x: 100, y: 50, zoom: 4, done: true }); // dt far past MOVE_MS lands exactly
const box = { x: 0, y: 0, w: 1000, h: 500 };
assert.deepEqual(centreOn({ x: 240, y: 120 }, box, 2), { x: 240 - 250, y: 120 - 125, zoom: 2 });
// Idle camera: nothing moving -> overview; a moving train -> follow leads its head by 3 cells; train gone -> shot ends
const S = createSim(generate('lebanon'), 'lebanon', { density: 'busy' }); S.auto = true;
const fit = { x: 0, y: 0, zoom: 0.5 }, lag = () => 0, cam = createIdleCamera({ rng: makeRng('cam') });
const first = cam.update(S, 0, { fit, box, lag, active: true });
assert.ok(first && Math.abs(first.zoom - fit.zoom) <= 0.05 * fit.zoom, 'starts on the overview (drift allowed)');
while (!followCandidates(S, lag).length) step(S);
cam.reset();
let shot = null;
for (let t = 0; t < 60000 && !shot; t += 100) { const u = cam.update(S, t, { fit, box, lag, active: true }); if (u?.caption?.text.startsWith('following')) shot = { t, u }; }
assert.ok(shot, 'a follow shot starts within a minute');
const tr = [...S.trains.values()].find(t => shot.u.caption.text.startsWith(`following ${t.name}`));
const late = cam.update(S, shot.t + MOVE_MS + 5000, { fit, box, lag, active: true });
const head = pointAt(S, tr, tr.headDist), want = centreOn({ x: (head.x + 3 * tr.dir) * CELL, y: head.y * CELL }, box, late.zoom);
assert.ok(Math.abs(late.x - want.x) < 0.7 * CELL && Math.abs(late.y - want.y) < 0.4 * CELL, 'follows the head led by 3 cells (drift allowed)');
S.trains.delete(tr.id);
cam.update(S, shot.t + MOVE_MS + 5100, { fit, box, lag, active: true }); // the frame the train vanished: shot ends, caption starts fading
const after = cam.update(S, shot.t + MOVE_MS + 5100 + CAPTION_MS + 50, { fit, box, lag, active: true });
assert.ok(!after.caption || !after.caption.text.startsWith(`following ${tr.name}`), 'follow ends when the train is gone');
assert.ok(after.zoom < late.zoom, 'and the camera is easing back toward the overview');
cam.reset();
assert.equal(cam.update(S, 99999, { fit, box, lag, active: false }), null);
```

Plus a caption crossfade check: after a text change at `t0`, `update` at `t0 + 200` reports alpha within `0.1` of `0.5` (either the old text falling or the new rising).

- [ ] **Step 2: Run** — `node tests/test_camera.mjs` — FAIL: cannot find module.

- [ ] **Step 3: Implement `src/camera.js`** per the spec: shot state `{ kind: 'overview'|'follow'|'signal', since, until, train?, signal?, passed? }`, a current `tween` toward the shot's target, then exponential chase (`τ = 500 ms`) while following; drift added after the tween/chase; `rng` for hold lengths and the 0.6 coin; candidate functions as specified; `reset()` clears the shot and the caption state. `update` with `active: false` returns null and clears the shot so the next activation starts from the overview.

- [ ] **Step 4: Add to `manage.sh test` and the workflow**, run `./manage.sh test` — all `ok` including `camera ok` (print it like the others).

- [ ] **Step 5: Commit** — `feat(camera): eased tweens and the idle camera state machine`

---

### Task 6: Wire the camera, zoom buttons, seed popover, docs

**Files:**
- Modify: `src/ui.js`, `index.html`, `src/style.css`, `src/panels.js` (KEYS already done), `README.md`, `docs/superpowers/specs/2026-11-01-idle-ambience-design.md` (only if a ruling changes)

**Interfaces:**
- Consumes: everything from Task 5; `ui.caption` and `ui.box` from Task 3.

- [ ] **Step 1: Frame loop.** `const idle = createIdleCamera({ rng: Math.random })` (the app's second and last use of `Math.random`, alongside `newSeed`; note it in the comment there). Each frame: `active = settings.idleCamera && !state.paused && now - state.lastInput > IDLE_CAM_MS`; `const u = idle.update(sim, now, { fit: fitCamera(), box: centreBox(), lag: lagOf, active })` where `fitCamera()` computes the fitted camera without applying it (factor `r.fit` into `r.fitted(layout, box) -> {x,y,zoom}` plus `r.fit` applying it) and `lagOf(t) = (1 - acc) * (t.adv ?? 0)`; when `u`, assign `r.camera` and set `state.idleCam = true`; pass `caption: u?.caption ?? null, box: centreBox()` in `uiFor`.
- [ ] **Step 2: Input hand-back.** In `touch()`: if `state.idleCam`, `idle.reset()`, `state.idleCam = false`, start `state.homeTween = tween(r.camera, fitCamera(), now)`; each frame while `homeTween`, apply `at(now)` and on `done` set `state.fitted = true`, clear it. A drag or wheel clears `homeTween` immediately (`state.fitted = false`). `fit()` also clears it.
- [ ] **Step 3: Zoom buttons.** `index.html`: `<button id="btn-zoom-out" title="zoom out">−</button><button id="btn-zoom-in" title="zoom in">+</button><button id="btn-fit" title="reset view (F, 0)">⌖</button>` after fullscreen. `zoomBy(f)`: target zoom clamped to the wheel's limits, centre of `centreBox()` fixed, tween over `MOVE_MS` via `state.homeTween`-style tween (`state.camTween`), `state.fitted = false`. Key `0` → `fit`.
- [ ] **Step 4: Seed popover.** `index.html`: `<div id="seed-pop" class="panel hidden"><div class="panel-body"><input name="seed" spellcheck="false" autocomplete="off"> <button data-act="load">Load</button> <button data-act="new">New seed</button> <button data-act="copy">Copy</button></div></div>`. `#hud-seed` click toggles it, positioned under the button (`left` = button's left, `top` = `var(--hud-h) + 4px`), input focused and selected; Enter loads; Escape or a `pointerdown` outside closes; `copy` does the old clipboard behaviour with feedback on the Copy button. Style: `#seed-pop { width: auto; padding: 0; } #seed-pop input { width: 120px; font-family: var(--mono); }`.
- [ ] **Step 5: README.** "What's on the panel" gains a short paragraph on the lighting cycle, glows, slow orders and the operator; "Controls" gains the zoom buttons, `0`, the seed popover, dock resizing; Settings list gains the Ambient group; Later list loses anything now built and gains "north/south running (spurs, wyes): its own spec".
- [ ] **Step 6: Verify.** `./manage.sh test`; `./manage.sh restart`; screenshots `?seed=s42&ff=1500` at 1366×768 show the new HUD buttons and no layout break; then the manual list for the hand-over: idle camera engages after a minute, eases, captions crossfade, mouse nudge eases home, zoom buttons glide, seed popover loads a seed, docks resize and persist across reload.
- [ ] **Step 7: Commit** — `feat(ui): idle camera, eased zoom buttons, seed popover; README`
