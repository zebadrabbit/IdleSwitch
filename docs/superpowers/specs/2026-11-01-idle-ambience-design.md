# Idle ambience: lighting cycle, glows, slow orders, resizable docks, idle camera

Amends `2026-10-31-idleswitch-design.md` and `2026-11-01-bidirectional-mains-design.md`. Where they
disagree, this document wins.

## Intent

IdleSwitch is a screensaver first. After the bidirectional mains, the user asked for *idle variation*: a
day/night cycle that darkens the already-dark panel a little and lets lights glow; traffic that shifts
from passenger to freight at night; an idle camera that follows a passing train or sits at a mainline
signal and watches trains go by; resizable docks so the board and log fit smaller monitors; and the eye
candy proposed alongside: a blinking end-of-train marker, platform lights at dusk, occupancy that fades
instead of snapping, an occasional slow order on a stretch of main, a sun/moon in the HUD, a named
operator who changes at shift change, and a camera that drifts slowly so nothing is ever perfectly still.
Their one rule for all of it: **all motion is smooth and eased, transitions crossfade in half a second or
less, no hard cuts.**

## Goals

- A lighting cycle of a few minutes with dusk and dawn, driven by the sim clock so a seed still gives
  the same day; the whole page (canvas and chrome) darkens slightly at night.
- Glows: headlights ahead of every moving loco, halos on lit signal lamps, a warm band of light along
  platforms at night, all stronger at night. A blinking red end-of-train marker on the last car.
- Nothing on the canvas changes colour in a single frame: track occupancy, routes, switch dots and
  signal lamps fade between states.
- Traffic mix follows the cycle: passenger weight falls at night, freight rises.
- Slow orders: now and then one stretch of main carries a temporary 20 mph restriction, drawn in amber
  and logged, lifted after a few minutes.
- A sun/moon glyph in the HUD; an operator name in the HUD and a shift-change line in the log.
- Side docks resizable in width, the bottom dock in height, by dragging their inner edge; floating
  panels resizable from their corner. Sizes persist with the layout.
- An idle camera that, after a minute without input, alternates between the fitted overview and close
  shots (following a train; watching a mainline signal), with eased moves, a slow drift while locked, and
  a crossfaded caption. Any input hands the camera straight back.
- Every existing invariant holds: same seed same day, no double occupancy, no passed red, no stall in
  the soak (now with slow orders active).

## Non-goals

- Weather, sound, a real 24-hour day on the HUD clock, scoring.
- Collision avoidance for tags or captions.
- Persisting the size of floating panels (native CSS resize; it lasts until reload).
- Touch gestures for dock resizing beyond what pointer events give for free.

## The lighting cycle

`sim.dayLength` is the period in sim seconds. Setting `dayLength` in real minutes at 1x: `2 | 4 | 8 | 0`
(0 = always day), default 4; sim seconds = minutes × 60 × `SIM_PER_SEC` (10) = 2400 at the default.
Phase `p = ((time - 06:00) mod dayLength) / dayLength`. The **night level** `n ∈ [0, 1]`:

```
p in [0.00, 0.40)  day    n = 0
p in [0.40, 0.50)  dusk   n = smoothstep((p - 0.40) / 0.10)
p in [0.50, 0.90)  night  n = 1
p in [0.90, 1.00)  dawn   n = 1 - smoothstep((p - 0.90) / 0.10)
```

`export function nightLevel(time, dayLength)` in `sim.js`, pure; `dayLength <= 0` gives 0. Dusk and
dawn last 10 % of the period (24 s at the default), so the fade is slow enough to notice and never a cut.
The HUD clock is untouched: the cycle is ambient lighting, not the time of day (ruling: a real sim day is
2.4 real hours at 1x, far from "a couple of minutes", and racing the clock would make delays unreadable).

**Palette at night** (linear blend by `n` between day and night values):

| thing | day | night |
|---|---|---|
| canvas bg | `#0b1020` | `#070b17` |
| idle track | `#8a93ab` | `#6c7590` |
| labels (`label`, `dim`) | as today | × 0.85 brightness |
| CSS `--bg`, `--panel` | as today | `#070b17`, `#0d1424` |

`ui.js` sets `--bg` and `--panel` on `:root` when `n` moves by more than 0.01 since the last set (the HUD and
panels use them already). Routes, occupancy, lamp colours and train colours do not dim: they are the lights.

**Traffic mix.** In `trafficMenu`, weights scale by the night level `n` at draw time: passenger types
(`X`, `P`) × `(1 - 0.7 n)`, freight (`Z`, `M`, and every spur's industry type) × `(1 + 0.7 n)`, `L`
unchanged. The spawn *rate* is unchanged.

## Glows and fades (renderer)

All glows draw with `globalCompositeOperation = 'lighter'` and radial gradients, after the track and
before the trains, except the lamp halos, which draw with their lamps. Intensities blend by `n`:

| glow | shape | alpha day → night | colour |
|---|---|---|---|
| headlight | ellipse ahead of the loco: length `2.5` cells, half-width `0.6` cells, from the loco's front, along travel | 0.22 → 0.55 | `#fff1c4` |
| lamp halo | disc radius `3 × lamp radius` on each **lit** lamp | 0.18 → 0.45 | the lamp colour |
| platform light | band over the platform box, height `0.5` cells, fading upward from the box | 0 → 0.35 | `#ffd9a0` |

The headlight only shows while the train moves (`train.speed > 0`); it fades in and out through the
colour fade below rather than popping. A loco's front is `trainBlocks(...)[0]` end `(x1, y1)`.

**End-of-train marker.** A red disc (`COLORS.lamp.R`, radius `max(1.5, 1.6 × zoom)`) at the tail end
of the last block, blinking 1 Hz in step with `ui.blink`; obeys the "flashing aspects flash" setting
(steady when off). Drawn after the train blocks, before the tags.

**Fades.** The renderer keeps a per-id colour state and eases it toward its target every frame with
`c += (target - c) × (1 - exp(-dt / τ))`:

| what | id | τ |
|---|---|---|
| edge colour (idle / route / human / occupied / slow order) | edge id | 120 ms |
| switch dot | node id | 120 ms |
| signal lamp (lit colour or `LAMP_OFF`) | `${signal}:${head}` | 60 ms |
| headlight alpha (on/off with motion) | train id | 200 ms |

`τ = 120 ms` reaches 95 % in 360 ms: inside the half-second rule. Flashing lamps still toggle at 1 Hz;
the 60 ms lamp fade just softens the edge like a filament. State for ids that vanish (trains that left)
is dropped when it is not touched for a frame. `dt` is the real frame time from `ui.now`, clamped to
`100 ms` so a background tab does not snap on return.

## Slow orders

A seeded, occasional temporary speed restriction on one main **section** (the stretch between two
crossover pairs, from the bidirectional-mains spec). Constants in `sim.js`:

```
SLOW_ORDER = { gap: 20 * 60, min: 5 * 60, max: 10 * 60, mph: 20 }   // sim s; mean gap, duration range
```

- `sim.slowOrder` is `null` or `{ section, until }`; `sim.nextSlowOrder` is the sim time of the next
  one (first at `start + gap × (-ln(1 - u))`, exponential like spawns; after one lifts, the next gap is
  drawn the same way). Draws use `sim.extras`, a second rng stream `makeRng(seed + ':extras')`, so the
  day's traffic is unchanged by slow orders being on or off.
- When due and `sim.slowOrders` is true, pick a section uniformly from `sim.sectionEdges` keys; duration
  uniform in `[min, max]`. Log `Slow order: <main> <x0>–<x1>, 20 mph until HH:MM` (`main` is `Main 1` for
  row `mainRow[-1]`, `Main 2` otherwise; `x0`, `x1` the section's column span) and, when lifted,
  `Slow order lifted: <main> <x0>–<x1>`. Each section's main and span are what `sectionEdges` gives.
- `export const edgeSpeed = (sim, e)`: the edge's speed, or `SLOW_ORDER.mph` when its `section` is the
  active slow order's. `moveTrains` reads speed limits through it. Aspects are unchanged (a slow order is
  a bulletin, not a signal indication). `findPath` is unchanged (costs are lengths).
- Renderer: idle edges of the slow-order section take colour `#b8862b` (amber, dimmer than `--amber`)
  through the fade; routed and occupied colours still win. A small `SLOW 20` label in `#f0b429`,
  `11px` sans, sits on the section's outer side (above Main 1, below Main 2) at its midpoint, `lw/2 + 9`
  px off the track, drawn once per active order. Legend gains a `slow order` bar.
- Setting `slowOrders` (boolean, default true) → `sim.slowOrders`. Turning it off while one is active
  lets that one run out.

## Shift change and the HUD

- `sim.operator`: a name drawn from `sim.extras` at `createSim`: `<Initial>. <Surname>` from
  `OPERATORS = ['Alvarez', 'Brennan', 'Chen', 'Dubois', 'Ekwueme', 'Fischer', 'Garza', 'Haddad', 'Iyer',
  'Jensen', 'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quinn', 'Reyes', 'Sato',
  'Tremblay', 'Ueda', 'Varga', 'Whitfield', 'Zhang']` and an initial `A`–`Z`. Shifts change every 8 sim
  hours from 06:00 (14:00, 22:00, 06:00). At each change a new name is drawn (not equal to the current
  one) and logged: `Shift change: <name> takes the desk`. At boot the log opens with `<name> on duty`.
- HUD: after the AUTO button, a dim span `#hud-operator` showing the name. Between the clock and the pause
  button, `#hud-sky`: two stacked glyphs `☀` (`#f0b429`) and `☾` (`#cfd6ea`), opacities `1 - n` and `n`,
  updated each frame with the night level, `title` "lighting: day | dusk | night | dawn".

## Resizable docks and panels

- `panels` (saved layout) gains `size: { left: number, right: number, bottom: number }` in px, defaults
  `{ left: 420, right: 420, bottom: 200 }` (`cleanLayout` fills bad or missing values). The CSS variables
  `--side-w-left`, `--side-w-right`, `--bottom-h` are set on `:root` from it; `#docks .panel.dock-left`
  uses `--side-w-left`, `.dock-right` `--side-w-right`.
- Each dock has a handle element along its inner edge: `#dock-left .dock-handle` on its right edge,
  `#dock-right .dock-handle` on its left, `#dock-bottom .dock-handle` on its top; `6px` wide, cursor
  `col-resize` / `row-resize`, transparent, `--accent` at 40 % while dragging or hovered. A handle is only
  shown when its dock has a visible panel. Pointer capture drag changes the size live (the map refits every
  move when `state.fitted`), clamped to `[200, 0.6 × innerWidth]` for sides and `[80, 0.7 × innerHeight]`
  for the bottom; release saves the layout. Double-click a handle resets that dock to its default size.
- Floating panels: `.panel:not(#docks .panel) { resize: both; overflow: hidden; min-width: 220px;
  min-height: 60px; }`. Body keeps scrolling. Not persisted.
- Board default side width drops from `clamp(280px, 33vw, 480px)` to the fixed 420 px default above;
  the user resizes from there.

## Idle camera

New module `src/camera.js`, pure: no DOM, no `Math.random`, no `performance.now`. `ui.js` owns the
timing and the renderer camera and calls it each frame.

```
createIdleCamera({ rng })                       -> cam
cam.update(sim, now, { fit, box, lag, active }) -> { x, y, zoom, caption } | null
cam.reset()                                      // forget the current shot (on input)
```

- `fit` is the fitted overview camera `{ x, y, zoom }`, `box` the dock-centre rect in screen px,
  `lag(train)` the renderer's interpolation lag so the camera tracks the drawn position, `active` whether
  the idle camera may run (setting on, not paused, idle for `IDLE_CAM_MS = 60000`). When not active,
  `update` returns null and the camera eases home (below) before the UI stops calling it.
- **Shots.** The camera alternates `overview` and a close shot. Overview holds `25–45 s` (uniform, from
  `rng`). A close shot is `follow` with probability 0.6 if a candidate exists, else `signal`, else overview
  again. A shot that loses its subject ends early.
  - `follow`: candidate trains have `speed > 15 mph`, a non-empty path, and a head at least 6 cells from
    their exit end. Target: centre on the head point (through `lag`) led by `3` cells in the direction of
    travel; zoom `clamp(3 × fit.zoom, fit.zoom, 3)`. Ends when the train leaves, has stood (`speed === 0`)
    for `8 s`, or after `40 s`.
  - `signal`: candidate signals are high signals on a main row (`mainRow[1]` or `mainRow[-1]`) with a
    route set from them or a train of their direction whose head is within `12` cells and approaching.
    Target: centre on the signal node, zoom `clamp(2.5 × fit.zoom, fit.zoom, 2.5)`. Ends `6 s` after any
    train's head passes the node (its head x crosses the node x in its direction of travel), or after `45 s`.
  - **Drift** while a shot holds: the centre moves on a slow Lissajous, `x += 0.6 cell × sin(2π t / 23 s)`,
    `y += 0.35 cell × sin(2π t / 31 s)`, and zoom scales by `1 + 0.04 × sin(2π t / 37 s)`, `t` seconds
    since the shot began. Overview drifts too, at a third of these amplitudes. Nothing is still.
- **Moves.** Every change of target (shot to shot, and the return home on input) tweens `x`, `y` and
  `log(zoom)` with smoothstep over `MOVE_MS = 1000` (ruling: half a second between the overview and a 3×
  close-up reads as a lurch; the half-second rule applies to crossfades, and the caption crossfades in
  `400 ms`). While following, the target itself moves; the camera chases it with an exponential approach,
  `τ = 500 ms`, after the initial tween lands, so it glides rather than tracks rigidly.
- **Caption.** `caption` is `{ text, alpha }`: `following P 326 · eastbound to Hartford` or
  `watching E12C` (signal label) or null on overview; alpha crossfades over 400 ms (old text fades out
  while the new fades in). The renderer draws it bottom-left of `box`, `12px` sans, `COLORS.dim`, 16 px
  in from the edges, as `ui.caption`. It draws in bare mode too.
- **Input.** Any pointer, wheel or key input (what `touch()` sees) calls `cam.reset()`; `ui.js` then tweens
  the camera back to the fitted overview over `MOVE_MS` and sets `state.fitted` true; a drag or wheel during
  that tween takes over immediately (the tween is abandoned where it is, `state.fitted` false). Idle camera
  never runs while `state.paused`.
- **Setting** `idleCamera` (boolean) defaults to true, or false when
  `matchMedia('(prefers-reduced-motion: reduce)').matches` at first run (the default is computed once by
  `ui.js` and passed to `cleanSettings` as the default; a saved value wins).
- Centre maths: the camera `{x, y}` is the world point at the canvas's top-left; to centre world point `w`
  in `box` at zoom `z`: `x = w.x - (box.x + box.w / 2) / z`, `y = w.y - (box.y + box.h / 2) / z` (world px =
  cells × `CELL`).

## HUD: seed entry and zoom controls

The user could not find a way to enter a seed (the Settings panel has one, hidden by default) or to reset
the view (`F` fits, undocumented on the HUD).

- **Seed.** Clicking `#hud-seed` opens a small popover anchored under it (`#seed-pop`, same look as a
  panel): a text input prefilled with the current seed, `Load`, `New seed`, and a `Copy` button that does
  what the click did before (`copied` / `copy failed` feedback on the button for 1.2 s). Enter loads,
  Escape or a click elsewhere closes. The Settings seed row stays.
- **Zoom.** Three HUD buttons after the fullscreen button: `−`, `+` and `⌖` (title "reset view (F)").
  `−`/`+` zoom by a factor of `1.25` about the centre of the dock-centre box, within the wheel's limits
  (`min(0.4, fitZoom)` to `4`), and set `state.fitted` false; `⌖` calls `fit()`. Keys: `0` also resets
  the view (added to the legend's key list). Zoom buttons tween over `MOVE_MS` like camera moves (the
  same tween helper from `camera.js`), so a click glides rather than jumps.

## Deferred to its own spec: north/south running

Vertical track (industry spurs running north or south off a module, wyes) touches the direction model:
`dir` is ±1 along x, `forwardEdges` filters edges by the sign of Δx, signals stand on the right-hand side
of travel defined by x, and the tag side, portal labels and the fit box all assume a wide, short panel.
It is a generator-and-interlocking project, not an ambience item, and follows this round.

## Settings panel

An **Ambient** group after Density: `Day length` select (`2 min`, `4 min`, `8 min`, `off`), checkbox
`slow orders`, checkbox `idle camera after 1 idle minute`. `cleanSettings` validates all three;
`DEFAULT_SETTINGS` gains `dayLength: 4, slowOrders: true, idleCamera: true`.

## Tests

- `test_sim`: `nightLevel` at phases 0, 0.45, 0.5, 0.95 and with `dayLength 0`; `trafficMenu` passenger
  weight at `n = 1` is 30 % of day and freight 170 %; slow orders: with `slowOrders` on, one appears by the
  mean gap × 4, only on a main section, `edgeSpeed` reads 20 mph on its edges and the class speed elsewhere,
  it lifts by `until`, both log lines appear; the train-name and type sequence of the first 20 entries is
  identical with slow orders on and off (separate rng stream); shift change logs at 14:00 with a different
  name; the soak runs with slow orders on and still meets every invariant.
- `test_ui`: `cleanSettings` fills `dayLength`, `slowOrders`, `idleCamera` and rejects bad values;
  `cleanLayout` fills `size` and clamps nothing (clamping is the UI's job); `DEFAULT_LAYOUT.size`.
- `test_camera` (new, in `manage.sh test` and CI): smoothstep endpoints and monotonicity; a tween's
  midpoint zoom is the geometric mean; with no moving train and no live signal, `update` returns overview;
  with a moving train the follow target leads its head by 3 cells in its direction; the follow ends when the
  train is removed from `sim.trains`; `reset()` then `update` with `active: false` returns null; caption
  alpha crossfades (two consecutive calls 200 ms apart give 0.5 ± 0.1).

## Rulings made without the user (they said "start with those ideas")

- The lighting cycle runs on the sim clock, not the HUD clock, with a period setting defaulting to 4 real
  minutes at 1x; "night" on the panel while the clock says 12:30 is accepted. A sun/moon glyph shows the
  phase.
- Camera moves ease over one second; the half-second rule is applied to crossfades (captions, colour
  fades, headlights). Revisit if a move feels slow.
- Slow orders use a separate rng stream so existing seeds keep their traffic.
- Floating panel sizes are not persisted (native CSS resize).
- The idle camera defaults off under `prefers-reduced-motion`.
- One slow order at a time, on main sections only; it does not change aspects.
