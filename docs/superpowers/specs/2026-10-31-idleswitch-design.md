# IdleSwitch — design

*2026-10-31. Status: draft for approval.*

## What it is

A CTC-panel idle sim. A seeded rail terminal draws itself on a dark
dispatcher's screen, a virtual operator sets routes for arriving and
departing trains, and you watch. Nothing needs you. When you feel like
it, you take the panel and route trains yourself, NX-style; walk away and
the operator takes it back.

Sibling of Gridworks and GRANTRON-12 on firetailfab.com. Lives at
`https://firetailfab.com/idleswitch/`. Same shape as Gridworks: vanilla
HTML/CSS/JS, canvas, ES modules, no build step, no dependencies, no
backend, rsync deploy from `manage.sh`.

## Why

A screensaver with things to do. The pleasure is the panel itself:
track lighting red under trains, signals stepping green → yellow → red
behind them, switches thrown, a yard breathing in and out. Later, an
efficiency score for how well the incoming train was routed and
dispatched; the sim logs what that score needs from day one, but there
is no score in this version.

## Goals

- Looks and reads like a real CTC / dispatcher panel (reference: the
  seven screenshots in `docs/reference/panel-ref-*.png`, kept out of git:
  straight runs, 45° diverges, dark navy not black, occupied track red,
  train ID tags riding the track, named locations, right-hand signals
  with direction arrows; RailRoute's platform boxes and route arrows for
  the interactive layer).
- Runs itself indefinitely with no input, no dead ends, no pile-ups.
- Every element a real operator touches is on screen and works: signals,
  switches, routes, track circuits, platforms, industry spurs, sidings,
  train board, event log, clock, autopilot indicator.
- Same seed → same terminal, so a layout you liked can be revisited.
- Honest American signaling and occupancy rules at the level of a hobby
  panel, not a rulebook.

## Non-goals (this version)

- Scoring, money, economy, upgrades.
- Collisions, derailments, SPADs. The interlocking makes them impossible;
  a train at a red signal just waits.
- Building or editing track. Curves, diamond crossings, wyes, grade
  crossings, branch-line portals off the sides.
- Saving sim state. Reload regenerates from the seed with a fresh day.
- Mobile layout. Target is a desktop monitor. Must not break under touch,
  not optimised for it.
- Sound. Brand assets (a text wordmark is enough).

## Anti-goals

- Puzzle pressure. No timers that punish, no modals that demand input,
  nothing that stops because you weren't there.
- Black backgrounds, neon noise, visual clutter. It should be restful at
  3am on a second monitor.
- Micromanagement. We route trains; we do not load cars.

## The terminal (seeded generation)

**Seed.** A string. Hashed to a PRNG (xmur3 → mulberry32 or equivalent,
in-repo, ~20 lines). Shown in the HUD; `?seed=` in the URL loads it;
"New seed" rolls one. Layout *and* the day's traffic come from the seed,
so a seed reproduces a whole day (my call: easier to test and to report
bugs; the user only asked for the layout to be reproducible).

**Geometry.** Schematic, on a grid. Track runs horizontally along rows
and diverges at 45° across one row per column. No curves. Nothing
overlaps except at switches. A unit cell is ~36 px at zoom 1; the whole
terminal fits a 1366×768 window at the default fit-to-screen zoom.

**Spine.** Two mainline tracks, west to east, with portals at both
edges (W1/W2, E1/E2). Portals are named after generated places
("to Lebanon Jct", "to Cornwall Mine"). Crossovers join the mains near
both ends and at each module boundary so any track is reachable from any
portal.

**Direction (my call).** The mains are directional: Main 1 carries
westbound, Main 2 eastbound, right-hand running, signalled one way each.
No wrong-main running in this version. A "meet" is therefore an
overtake: the slower or lower-priority train steps into a siding or yard
track and the other passes on the main. This halves the signalling work
and removes head-on deadlock. Bidirectional CTC is a later upgrade.

**No reversing (my call).** Every platform, yard track, siding and
industry track is a through track with a ladder or switch at both ends.
A train keeps its direction from portal to portal; nothing backs up,
no ID flips. No stub bays or stub spurs this version. Real stub spurs
with reversing moves are a later upgrade.

**No gridlock.** A train only enters the territory when its destination
track, or a holding track it fits in, is free. Otherwise it waits off-
screen at its portal and shows on the train board as "holding at
<portal>". Trains on the main never wait for a track that cannot free
itself. If despite this a train has not moved for 30 sim minutes, it is
logged as a stall; no teleport cheat, we fix the rule instead.

**Modules**, placed along the spine by the seed. Each terminal gets two
to four modules from:

- **Passenger station** — 2 to 4 through platform tracks off the mains,
  numbered in boxes (RailRoute style). Named ("Union Station", "Ridge",
  "Colebrook").
- **Freight yard** — 2 to 4 yard tracks on a ladder, plus 1 to 3
  **industry spurs**. Industry drawn from a list that fixes the freight
  type: coal power plant (unit coal, long), steel mill (coil/slab
  hoppers), grain elevator (covered hoppers), intermodal ramp (well
  cars), lumber mill (centerbeams), auto plant (autoracks), oil terminal
  (tank cars). Industry name on the map.
- **Siding group** — 1 to 3 passing / holding sidings, where waiting
  trains go.

Guarantee: at least one of station or yard exists; every module is
reachable from both portals by at least one path; every track has a
length in cells and nothing is generated that no train can use.

The detailed placement algorithm is the builder's; the constraints above
and the screenshots are the spec. Prefer boring and legible over dense.

## Traffic (derived from the map)

Traffic types follow what the seed built:

| Map has | Trains you get |
|---|---|
| mains (always) | through trains, both directions, passenger and freight |
| passenger station | terminating / originating passenger trains that call at a platform |
| freight yard + industries | freights that arrive, go to their industry spur (or yard track), dwell, depart |
| sidings | nothing extra; they exist to hold trains that must wait |

Each train has a **mission**: enter at portal A → (optionally) reach a
destination track and dwell → leave by portal B. Through trains are
portal to portal. Destination and dwell depend on type: passenger
dwell a few sim minutes; freight at an industry dwells longer (loading).
Builder tunes numbers.

**Priority** (high → low): express passenger, local passenger, priority
intermodal, through freight, local/industry freight, yard moves. Used by
the operator to decide who waits.

**Length.** Fixed per type, a handful of sizes (passenger 4–8 cars,
manifest 10–16, unit trains ~20, locals 5–8). "If it fits it sits": the
sim never sends a train to a track shorter than itself; the generator
guarantees every train type it will spawn has at least one destination
it fits. Nothing to tune or overthink.

**IDs** in the CTC style: a type letter plus a number, even numbers
eastbound, odd westbound. P passenger, X express, Z priority intermodal,
M manifest, C coal, G grain, I intermodal, L local. E.g. `P 343`,
`C 52`.

**Density.** A setting: light / normal / busy. Spawn rate is derived
from the terminal's capacity so "normal" keeps roughly half the
platforms and spurs working. Spawns are seeded like everything else.

**Delay.** Every train has a scheduled portal-exit time. Delay is
actual minus scheduled. Shown on the train board. The sim logs per
train: spawn, each route set, arrival, dwell start/end, departure,
distance, stops made, final delay. That log is the raw material for the
future score; nothing in the UI uses it yet beyond the delay column.

## Signaling and interlocking

**Track circuits / blocks.** Track is divided into blocks at signals and
at switch clearance points. One train per block. A block is one of:
clear, locked (part of a set route), occupied.

**Switches.** Normal / reverse. A switch cannot move while its block is
occupied or locked. Drawn with the lie visible: the unset leg draws dim.
Locked switches show a small lock glyph. (Flank protection is skipped;
`ponytail:` comment in code.)

**Routes.** NX. A route is entrance signal → exit signal: an ordered list
of blocks and the switch positions it needs. Setting succeeds only if
every block is clear and unlocked and every switch is free or already
lying right; then blocks lock, switches throw and lock, the entrance
signal clears. Sectional release: as the train vacates each block, it
unlocks behind it. A set, unoccupied route can be cancelled; the signal
drops to stop first.

**Signals.** Right-hand running: the signal stands on the right of the
track for the direction it governs, drawn with a small direction
chevron. Two kinds:

- **High signal** (mainline and controlled entries): one head on plain
  track, two heads where the route ahead can diverge (top head = straight,
  bottom = diverging).
- **Dwarf** (yard tracks, siding exits, spur exits): one small head, no
  mast, slow-speed aspects only.

Aspects (American practice, single-colour lenses, flashing where noted):

| Name | High (1 head) | High (2 head) | Dwarf | Meaning |
|---|---|---|---|---|
| Clear | G | G / R | — | track speed |
| Approach | Y | Y / R | — | be prepared to stop at next signal; medium speed by then |
| Advance Approach / Approach Medium | flashing Y | flashing Y / R | — | next signal is Approach or shows a diverging aspect; slow to medium |
| Diverging Clear | — | R / G | — | medium through the turnout, then track speed |
| Diverging Approach | — | R / Y | — | medium through turnout, prepared to stop at next |
| Restricting | — | R / flashing R | flashing R | enter at restricted speed, prepared to stop short of anything (yard tracks, occupied-permitted moves) |
| Slow Clear | — | — | G | proceed at slow speed |
| Stop | R | R / R | R | stop |

Aspect is computed from: is a route set from this signal; does it
diverge; what is the next signal showing; are the blocks ahead clear.
Trains entering yard tracks and spurs get Restricting from a dwarf or
the bottom head, so a yard track may already hold a train if the
combined length fits. (My call: keeps yards feeling like yards without
a second locking model. If it complicates the interlocking, builder may
drop it and require yard tracks to be clear.)

**Speeds** (mph, sim scale): track speed 60 passenger / 50 freight;
medium 30 (diverging through a turnout); slow 15 (yard, dwarf-governed
moves); restricted 15 and stopping short. Trains accelerate and brake at
simple per-type rates and brake to meet the aspect ahead. Nobody passes
a red. Ever.

## The virtual operator (autopilot)

Runs every tick when AUTO is on. For each train that needs a route
beyond its next signal:

1. Pathfind from that signal to the mission's next goal (destination
   track if it has one and it fits, else exit portal) over the track
   graph. Dijkstra; cost = distance + penalty per diverging move +
   penalty for using a main a higher-priority train will need soon.
2. Try to set the route to the next signal along that path. If it can't
   (blocked, locked, switch busy), the train waits; try again next tick.
3. Meets and passes: if two trains want the same main, the lower
   priority is routed to a siding or yard track it fits in, if one is
   reachable, and holds until the other is past. Simple rule, no
   lookahead beyond "someone of higher priority is inside N blocks and
   heading this way".
4. Human-set routes are never overridden or cancelled by the operator.

That's it. No timetable planning, no optimisation. It's an operator who
keeps things moving, not a scheduler.

## Taking the panel (manual)

- `A` toggles AUTO / MANUAL. The HUD indicator is always visible: green
  **AUTO** or amber **MANUAL**.
- NX: click an entrance signal (it highlights), click an exit signal; the
  route sets if the interlocking allows, else the entrance signal
  flashes a refusal and the log says why. Clicking a train selects it and
  pre-arms its next signal as the entrance.
- Click a set, unoccupied route to cancel it. Click a free switch to
  throw it.
- Escape clears the selection.
- In MANUAL, after 2 sim-idle minutes of real time without input, the
  panel returns to AUTO (setting; default on). It's a screensaver; it
  must never sit dead because you walked away mid-route.
- Human routes persist until a train uses them or they're cancelled.

## Screen

**Canvas** fills the window. Background dark navy (around `#0b1020`),
never pure black. Pan by drag, zoom by wheel, `F` fits the terminal to
the window (also the initial view).

**Track colours.** Idle track light grey; route set bright green (CTC
white/green convention); occupied red; the dim leg of a switch
desaturated. Platforms as labelled boxes alongside their track;
industries and yard tracks named; portals labelled with their place
name and an arrow.

**Trains** as block chains: a locomotive block plus one block per car,
snapped along the track path, coloured by type (passenger, express,
freight types each get a hue). The ID tag rides above the head of the
train in a small box, as in the CTC screenshot.

**Signals** drawn on the track at their location, on the right of the
direction they govern, with a direction chevron; high signals with a
short mast and one or two heads, dwarfs as a small head on the ground.
Flashing aspects actually flash (~1 Hz).

**HUD bar** (top, thin): wordmark, sim clock, pause and speed
(1×/2×/4×/8×), AUTO/MANUAL indicator, seed with copy, density, buttons
toggling each panel, fullscreen button (Fullscreen API; F11 also works
because the layout has no borders or fixed chrome that assumes a window
frame). `H` hides all chrome for a bare panel.

**Panels** — plain divs, movable by a title bar, dockable (snap to left /
right / bottom edge when released near it), hideable, each with a key.
Positions and visibility remembered in localStorage; "Reset layout" in
Settings. Panels:

- **Train board** — all trains in territory and due soon: ID, type,
  from → to, destination track, status (approaching / routed / holding /
  dwelling / departing), delay.
- **Log** — operator and human actions and notable events, timestamped
  in sim time: "06:14 AUTO: route 21→43 set for P 343", "06:20 C 52
  holding at siding 2 for X 12".
- **Inspector** — whatever is selected: a train (mission, speed, aspect
  it's obeying, length), a signal (aspect, route from it), a switch
  (lie, locked by).
- **Legend / keybinds** — aspects, track colours, train colours, keys.
- **Settings** — speed, density, idle-return-to-AUTO, flashing, panel
  reset, seed load / new seed.

**Time.** Sim clock HH:MM, starts 06:00. Tunable time scale; target: a
through train crosses the screen in roughly 20–30 real seconds at 1×.

## Code layout

```
index.html                  shell: canvas, HUD, panel containers
manage.sh                   start|stop|restart|status|logs|test|deploy
src/gen.js                  seed → track graph, places, modules (pure, no DOM)
src/sim.js                  blocks, switches, signals, routes, trains, operator (pure, no DOM)
src/render.js               canvas drawing, camera
src/ui.js                   HUD, panels, drag/dock, input, NX, keybinds, localStorage
src/style.css               dark theme
tests/test_gen.mjs          node + assert: N seeds → valid, connected terminals
tests/test_sim.mjs          node + assert: interlocking never double-occupies a block;
                            a train runs portal→portal under AUTO; a human NX route sets and releases
.github/workflows/test.yml  runs both on push
README.md  LICENSE (MIT)  .gitignore
docs/superpowers/specs/     this file, and plans
```

Deploy target: `dogzrbar@firetailfab.com:/home/dogzrbar/public_html/firetailfab/idleswitch/`,
same rsync flags and exclusions as Gridworks.

## Repository

`github.com/zebadrabbit/IdleSwitch`, public, MIT. Creating the repo,
setting description / website / topics, and the first push are part of
this build. `manage.sh deploy` is written and tested dry; whether the
builder runs the live rsync is the owner's call at the end.

Description: *Sit back and watch a CTC rail terminal run itself. A
seeded idle sim where a virtual operator routes passenger trains to
platforms, freight to industries, and through trains down the main, or
take the panel yourself. Vanilla JS, no build step.*

Website: `https://firetailfab.com/idleswitch/`

Topics: idle-game, simulation, railroad, railway, train, ctc,
interlocking, signalling, dispatcher, browser-game, canvas, javascript,
no-dependencies, screensaver.

## Left to the builder

- Generation algorithm details, module sizes, place-name lists.
- All numeric tuning: speeds in cells/tick, accel rates, dwell times,
  spawn rates per density, time scale, idle timeout.
- Exact palette within "dark navy, restful, red/yellow/green read
  instantly".
- Drag/dock implementation details, panel default positions.
- Whether yard tracks permit Restricting entry onto an occupied track
  (see Signals) or must be clear.

## Later (not now)

Efficiency score from the logged events. Bidirectional mains and
wrong-main running. Stub spurs and reversing moves. Branch-line portals.
Sound. Brand assets. Save/restore of a running day.

## Amendments made during the build

Decisions taken while building, each recorded with its reason in the
implementation ledger and summarised here so this document stays true.

- **Dead human routes are cleared.** "Human-set routes are never
  overridden" has one exception: a human route that no train can ever
  take (set from the exit signal of an empty track, or into a track the
  waiting train does not fit) is cancelled by the operator after a
  3-minute grace, with a log line. Otherwise one click could stop a
  whole direction for good, and "must never sit dead because you walked
  away" outranks the no-override rule.
- **Human routes respect fit.** A train does not take a human route into
  a track shorter than itself. The route then counts as dead (above).
- **Portal queue admits the first eligible train**, not strictly the
  head, so a freight waiting for a full spur does not hold the main.
- **A switch is held by its trunk edge only.** Every route through a
  switch uses the trunk, so this protects every conflicting move while
  letting a train dwell on one yard track without locking its neighbours.
- **Yard tracks must be clear** to receive a train; the optional
  Restricting entry onto an occupied yard track was dropped.
- **No crossovers between the mains** (dead track under directional
  running); modules' tracks sit between the mains, split by side.
- **Density is a fixed mean spawn interval** per setting, not derived
  from terminal capacity.
