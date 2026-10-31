# IdleSwitch

Sit back and watch a CTC rail terminal run itself. A seeded terminal draws itself on a dark dispatcher's panel: track lights red under trains, signals step green, yellow, red behind them, switches throw, a yard breathes in and out. A virtual operator sets the routes. When you feel like it, take the panel and route trains yourself, NX-style; walk away and the operator takes it back. Nothing needs you and nothing punishes you for leaving. The same seed gives the same terminal and the same day of traffic. Vanilla JS and canvas, no dependencies, no build step. Live at https://firetailfab.com/idleswitch/.

## Controls

| Key | Does |
|---|---|
| Space | Pause / resume |
| + / - | Faster / slower sim speed |
| A | Toggle AUTO / MANUAL |
| F | Fit the terminal to the window |
| H | Hide all chrome for a bare panel |
| Esc | Clear the selection |
| 1 - 5 | Toggle panels: train board, log, inspector, legend, settings |
| ? | Toggle the legend |
| N | New random seed |

Mouse: drag to pan, wheel to zoom about the cursor. To route a train, click an entrance signal, then an exit signal; the route sets if the interlocking allows, otherwise the entrance signal flashes red and the log says why. Click a train to pre-arm its next signal. Click a set, unoccupied route to cancel it.

## What's on the panel

Track: grey is idle, green is a route set by the operator, blue is a route you set, red is occupied. The unset leg of a switch draws dim.

Signal aspects (American practice):

| Name | High (1 head) | High (2 head) | Dwarf | Meaning |
|---|---|---|---|---|
| Clear | G | G / R | — | track speed |
| Approach | Y | Y / R | — | be prepared to stop at next signal; medium speed by then |
| Advance Approach / Approach Medium | flashing Y | flashing Y / R | — | next signal is Approach or shows a diverging aspect; slow to medium |
| Diverging Clear | — | R / G | — | medium through the turnout, then track speed |
| Diverging Approach | — | R / Y | — | medium through turnout, prepared to stop at next |
| Restricting | — | R / flashing R | flashing R | enter at restricted speed, prepared to stop short of anything |
| Slow Clear | — | — | G | proceed at slow speed |
| Stop | R | R / R | R | stop |

Trains are a locomotive block plus one block per car, with an ID tag (type letter plus number; even eastbound, odd westbound):

| Letter | Type | Priority | Colour |
|---|---|---|---|
| X | Express | 5 | yellow |
| P | Passenger | 4 | amber |
| Z | Priority intermodal | 3 | purple |
| M | Manifest | 2 | blue |
| C | Unit coal | 1 | grey |
| G | Grain | 1 | orange |
| I | Intermodal | 1 | cyan |
| L | Local | 0 | green |

Higher priority wins when two trains want the same track.

## Seeds

`?seed=anything` loads that seed; the HUD shows the current one (click to copy) and N rolls a new one. Same seed, same terminal, same day of traffic. Density (light / normal / busy) is a setting in the HUD. `?ff=N` fast-forwards N sim seconds at boot (debug; used for headless screenshots).

## Design notes

- The mains are directional: the top main runs westbound, the bottom eastbound. A meet is an overtake: the lower-priority train steps into a siding or yard track.
- Every track is a through track. Nothing reverses, so a train keeps its direction and ID from portal to portal.
- A switch is held only by its trunk edge (occupied or routed); there is no flank protection.
- Yard tracks must be clear to receive a train.
- Trains wait off-screen in a portal queue until a destination fits; the first eligible train in the queue enters, so one waiting for a full spur does not block the rest.

## Layout

```
index.html                  page shell
manage.sh                   dev server, tests, deploy
src/rng.js                  seeded PRNG
src/gen.js                  terminal generator
src/sim.js                  interlocking, routes, signals, trains, traffic
src/render.js               canvas renderer
src/ui.js                   app, HUD, panels, keybinds
src/ui-util.js              pure UI helpers
src/panels.js               panel bodies
src/style.css
tests/                      test_gen, test_sim, test_ui (plain node)
.github/workflows/test.yml  CI
docs/superpowers/specs/     design spec
docs/superpowers/plans/     implementation plan
```

Design: [docs/superpowers/specs/2026-10-31-idleswitch-design.md](docs/superpowers/specs/2026-10-31-idleswitch-design.md). Plan: [docs/superpowers/plans/2026-10-31-idleswitch.md](docs/superpowers/plans/2026-10-31-idleswitch.md).

## Running it

```
./manage.sh start
```

Serves the repo root on http://localhost:8890 (override with `PORT=nnnn ./manage.sh start`). Also `stop`, `restart`, `status`, `logs`.

## Tests

```
./manage.sh test
```

Needs Node 22. No packages to install.

## Deploy

`./manage.sh deploy` rsyncs the repo root to firetailfab.com/idleswitch, minus dev-only files. Needs SSH access to the host (override the target with `DEPLOY_TARGET`).

## Status

v0.1. The seeded generator, interlocking, traffic, canvas panel, AUTO and MANUAL (NX) routing, dockable panels and saved layout all work, with tests in CI. Later: an efficiency score for how well trains were routed (the sim already logs what it needs), bidirectional mains, stub spurs with reversing moves, sound.

## License

MIT, see LICENSE.
