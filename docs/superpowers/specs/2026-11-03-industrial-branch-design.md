# Industrial branches: dead-end leads with set-outs and pick-ups

Amends the four earlier specs (`2026-10-31-idleswitch-design.md`, `2026-11-01-bidirectional-mains-design.md`,
`2026-11-01-idle-ambience-design.md`, `2026-11-02-wyes-design.md`). Where they disagree, this document wins.

## Intent

Every freight destination today is a through track: a spur is entered at one end and left at the other, and the train
stands on it for its whole visit. The user wants the other kind of industry trackage, the kind every real yard map is
full of: dead-end tracks off a lead, entered by backing in and left the way you came. Reference images were a model
railway plan (a fan of stub sidings off a ladder, a loco shed with stub roads), a Derail Valley harbour map (through
yards on the main, and off to the side a military base, a fluids yard and a crane yard each hanging on one stem and
ending at bumpers) and the terminal's own screenshots.

The user's words on the move: "usually a train will back in and drop the cars off then pick up another consist and
wander off, sometimes if it's a local shunt then the loco will go back home without a consist", and on the scope:
"we don't have to do a full shunting operation, but pulling a consist into an industrial branch, dropping it off, then
grabbing a totally separate consist and taking it away would be more appropriate". The through spurs stay: "spurs
are important to efficiency". And "to really push in craziness the dead-end branches can occur off a spur as well".

So this spec adds two things built from one mechanism:

- the **industrial lead**: a 45° lead off a main in its own inter-module gap, laddering into a fan of two or three
  dead-end **stubs** (count by seed), each with an industry name and, most of the time, a standing **cut** of cars;
- the **spur stub**: one dead-end stub hanging off a yard spur, one row deeper, worked the same way.

A train bound for one of them pulls past the switch, shoves its cars back onto an empty stub, cuts off, and leaves
either light or with the cut that was waiting on another stub. Between visits the cuts sit there, so the branch never
looks dead, and a train that leaves light makes the yard look busier than when it came. It stays a screensaver: same
seed same day, no gridlock, nothing jumps.

## Goals

- A seeded industrial lead in a widened gap, north of Main 1 (worked by westbound trains) or south of Main 2 (worked by
  eastbound trains), with the fan's stub count, industries and initial cuts all from the seed.
- A seeded single stub off some yard spurs.
- The **visit**: arrive, pull past, reverse, back in pushing at 15 mph with the loco trailing, set out the cars as a
  standing cut (a short dwell), run light back to the lead, reverse, back onto a full stub, couple to its cut (a short
  dwell), pull out loco first and continue the way the train was going. A train with nothing to pick up leaves light. A
  train that arrives light picks up and leaves loaded.
- Standing cuts drawn as cars with no loco, which never move on their own and which nothing ever runs into.
- The operator runs all of it; a human can NX all of it with the existing signals (every route is from a signal); the
  interlocking refuses head-on, wedge and run-into-the-cut moves.
- Every existing invariant holds on every seed: no double occupancy, no passed red, no stall in the soak, one wrong-main
  train, same seed same day. Layouts without an industrial lead or a spur stub are **unchanged byte for byte** (the
  frozen fixtures under `tests/fixtures` still pass), and their traffic is unchanged.

## Non-goals

- Sorting, kicking, running round, splitting a consist across stubs, loco sheds. One drop and one pick-up per visit.
- Unit trains on dead ends. Stubs take cuts of at most `CUT_MAX` cars (see Traffic); unit coal and grain trains keep
  using the through spurs.
- A lead with its own signals for through traffic, a second train in a fan, a lead in a margin, two leads in a
  terminal, a lead sharing a gap with a wye.
- Light rail, grade separation, the background map: still the queued ideas, unchanged.

## Vocabulary

- **Fan**: the whole industrial lead (lead, ladder, stubs). `layout.fan`.
- **Stub**: a dead-end track, class `stub`, flagged `stub: true` like the terminus's platform (both are dead ends that
  only a shunt route may enter); distinguished from it by class. Horizontal; its exit signal (a dwarf, `dir 0`) stands
  one cell from its ladder node, facing the buffer edge, like the terminus's `S`.
- **Cut**: `{ track, type, cars }`, a standing consist on a stub with no loco. `sim.cuts`, a `Map` keyed by track id.
  A stub is **full** when it holds a cut, **empty** otherwise.
- **Visitor**: a train whose destination is a stub. **Loaded** (comes with cars) or **light** (a lone loco, `cars: 0`).
- **Stand**: where a visitor stops before it reverses: the pull-ahead column `P` of a fan, the spur's exit signal for a
  spur stub.

## The fan (geometry)

One fan at most, placed by the seed in one inter-module gap that the wye does not use (never a margin), on a side the
seed picks: **north** (lead off Main 1, fan above it) or **south** (lead off Main 2, fan below it). A north fan is
worked by westbound trains, which arrive from the east; a south fan by eastbound trains, which arrive from the west.
The lead **trails** the working direction, so a visit is one pull-past and one shove with no runaround, and the other
direction's trains never visit. Probability a terminal has a fan: `FAN_P = 0.5`, given a free gap; a terminal with two
modules and a wye has none. Stub count `2` or `3` by a fair coin.

All of the fan's draws come from their own stream, `makeRng(seed + ':industrial')`: presence first, then side, gap,
count, the stubs' industries, and after the fan the spur-stub coins (below), in module order. The main stream is
untouched, as the wye's `:junction` stream left it, so every layout without a fan or a spur stub is as before.

**Gap layout** for a north fan, west to east (`b` = boundary signal column of the module to the west, `x1 + 1`; `b'`
the east module's `x0 − 1`; `.` one empty column; columns counted from `b`):

```
b | pair(6) | . | P | run(7) | X | pair(6) under the lead | ... | . | b'

pair   b+1 .. b+6        the west pair (a = b+1: a, a+2, a+3, a+5)
P      b+8               pull-ahead column: signals both ways on both mains, as at a module boundary
X      b+15              the lead switch on Main 1; the run P–X is one 7-cell main edge
pair   b+17 .. b+22      the east pair, on the mains under the lead's straight
Lt     b+17  row T−2     top of the lead: X–Lt is one 45° edge (2 cells up, 2 east), class `lead`
J      b+20  row T−2     ladder foot: Lt–J is one 3-cell edge, class `lead`
S0,B0  b+21, b+28 T−2    stub 0 straight on from J: J–S0 (1 cell) and S0–B0 (7 cells), class `stub`
K1     b+21  row T−3     J–K1 one 45° ladder cell, class `lead`
S1,B1  b+22, b+29 T−3    stub 1 from K1
K2     b+22  row T−4     K1–K2 (three stubs only)
S2,B2  b+23, b+30 T−4    stub 2 from K2
b'     b+31 (two stubs) / b+32 (three)        GAP_FAN = { 2: 33, 3: 34 } (the next module's x0 = x1 + GAP_FAN)
```

A **south fan** is the mirror image about the gap's centre: `P` is the east pull-ahead column, the lead leaves `X` on
Main 2 down and to the **west**, the straight and the stubs run west from it, with the east pair at the gap's east end
and the west pair under the lead. Rows `R2+2 .. R2+1+count`.

- Every edge of the fan is two-way (`oneWay null`). Classes: `lead` (speed 15, slow, drawn as track), `stub`
  (speed 15, slow, dwarf exit signal, `DWARF` and `SLOW_CLS` gain both).
- **Rows**: a north fan needs `T ≥ count + 1` (stub 2 on row `T−4`); the generator pads `T` as it does for a wye. A
  south fan pads `rows` likewise. The pads combine with a wye's by `max`.
- **Signals** (all `dir 0`):
  - at `P`, both ways on both mains (`high`), as at a terminus;
  - **`X` shunt**, route-transparent, on the switch node, facing along the run (`from` = the run `P–X`): read only by
    the reversed visitor whose head node is `X`. Its candidates are the three (or two) walks up the lead to a buffer,
    one per stub. Drawn as a dwarf standing back from the points along the run, like a terminus foot's;
  - **`J` shunt**, route-transparent, on the ladder foot, facing down the straight (`from` = `Lt–J`): read by the
    light loco standing reversed on the straight. Its candidates are the stubs;
  - **`Lt` dwarf**, the fan's exit signal, on a plain node, facing the straight (`from` = `Lt–J`): every route out of a
    stub ends here; its own candidate runs down the lead through `X` and along the run to `P`. Walks arriving at `Lt`
    on the lead edge see no signal (signals are keyed `node:from`), so the shove-in passes it;
  - a **stub signal** `Si` on each stub, a dwarf facing the buffer edge: a train in the stub leaves by it.
  - The boundary signals at `b`, `b'` as in any gap. No other signal stands between `P` and `b'`.
- **Switches** form by the existing rule. At `X` the trunk is the run (toward `P`), normal the main onward, reverse the
  lead; through traffic on Main 1 holds `X` by its trunk as at any switch. At `J` the trunk is the straight; at `K1`
  the ladder cell below it.
- **Sections**: the lead, ladder and stubs are one section (the fan section, not a main), with senses outbound (away
  from the main) and inbound, like the wye's branch section. The east pair under the lead splits Main 1 so the run
  `P..X` and the piece to `b+17` are one short section: the shove's wrong-sense running (below) opposes only trains in
  that stretch, never the next module.
- **Buffers** end a walk only from a shunt signal (the terminus rule), so no train is ever routed head first into a
  stub from `P` or `b'`; a walk from `P` up the lead reaches a buffer and is dropped.
- **Labels**: the fan takes one place name; `<Place> Industrial` sits with the module names at `y = −1` over the fan.
  Stubs take industry names like spurs (`<Place> Lumber`, `<Place> Steel`), distinct from each other and from the
  terminal's spurs (7 industries cover 2 spurs + 3 stubs + the spur stubs' own, which reuse their spur's industry).
  Signal labels follow the existing scheme: `Lt` is `W<x><row>d` on a north fan, the shunts take `s`.
- No-crossing and ≤ 3 edges hold by construction: the fan sits in rows the modules do not use in that gap, the east pair
  stays on the main rows, and the east module's exit ladder reaches row `T−2` at `x0 + 2`, five columns past the last
  buffer.

## The spur stub (geometry)

A yard spur (the deepest track of a yard module's side) may carry one stub, by coin `SPUR_STUB_P = 0.4` on the
`:industrial` stream, drawn for every spur in module order after the fan's draws. With `d` the spur's direction, `sig`
its exit signal node and `y` its row:

- a switch `Xs` is inserted on the spur **7 cells upstream of `sig`** (at `sig.x − 7d`), so the spur's edges become `a–Xs`, `Xs–sig`, `sig–b` (all `oneWay` as before; the exit signal's `from` is now `Xs–sig`; the
  track's capacity is unchanged: entry to signal less half a cell);
- the stub runs **back** (against `d`) one row **deeper** (away from the main): `Xs–Q` one 45° `lead` cell to
  `(Xs.x − d, y ∓ 1)`, then `Q–Sq` (1 cell) and `Sq–Bq` (7 cells) of class `stub`, so the buffer is 9 columns upstream
  of `Xs`. The row beyond a module's deepest track carries nothing else, and both ladders meet the spur row from the
  main side, so nothing crosses. The module's width requirement for a spur with a stub becomes `2i + 17` (one more
  than today's `CAPACITY_MIN.spur + 2i + 2`), and the generator pads `T` / `rows` by one row when a stub spur is the
  deepest track on its side;
- an **`Xs` shunt** (route-transparent, `from` = `Xs–sig`) with one candidate, into the stub to the buffer; a **stub
  signal** `Sq` (dwarf, `dir 0`) whose candidate runs `Q → Xs → sig` and ends at the spur's exit signal;
- the stub's name is the spur's industry with a suffix the industry carries (`… Power Plant` → `… Plant Track`; the
  builder picks short suffixes per industry); the stub shares the spur's `industry`.

A spur with a stub is an **industrial lead**: its trains are cuts (Traffic). Its visits take a few minutes instead of
the 25-minute industry dwell.

## Traffic

- **Cuts.** `CUT_MIN = 3`, `CUT_MAX = 8` cars. A train now carries `train.cars` (default `TYPES[type].cars`);
  `trainLength(type, cars)` and `trainBlocks` read it, the inspector's `Length` shows it. Cut sizes and the initial cuts
  come from `sim.cutRng = makeRng(seed + ':cuts')`, drawn only when a stub exists, so other seeds' traffic is untouched.
  A light engine has `cars: 0` (`len = LOCO`).
- **Initial state.** At `createSim`, every stub but one per fan holds a cut (which one is empty: `cutRng`); each spur
  stub holds a cut by a fair coin. A cut's `type` is its stub's industry train type, its size `CUT_MIN..CUT_MAX`.
  Cuts are sim state, saved and restored with it if the sim is ever persisted (it is not today).
- **Visitors.** The menu for the fan's working direction (from its serving portal only) offers, with the industry type
  of the stub concerned: a **loaded visit** (`cars` drawn `CUT_MIN..CUT_MAX`, `dest` = the first empty stub) while an
  empty stub exists, weight `3 × frt`; a **light visit** (`cars: 0`, `dest` = the first full stub) while a full stub
  exists, weight `2 × frt`. A spur with a stub replaces its spur item with the same two, keyed on its one stub. Both
  items drop from the menu while the fan (or the spur) is not free or while a visitor for it is queued (the terminus's
  "one in the offing" rule, for the same reason).
  (Amended 2026-11-04, Task 4 fix round 1: **a spur stub's items come from its dir's main portal only**, never a
  junction's branch portal, as the fan's. Drawn at the branch too, s166's visitors stood at the stem waiting to cross the
  gap until the valve gave the visit up: 1 visit and 4 given up in 8 busy hours, against 6 and none now.)
- **Reservation.** A fan is one unit: `trackFree` for any of its stubs is false while a train is in, routed into or
  reserved for any track of the fan (`sim.reserved` is set on the visitor's `dest` stub as today, and `fanOf(track)`
  widens the check). A spur stub is reached only over its spur, so reserving the spur covers both: a stub visitor's
  `dest` for the spawn gate is the spur, and `sim.reserved` holds the spur for the whole visit.
- **Schedule.** `sched` adds the visit's dwells plus five minutes of shunting, in place of the industry dwell.
- Nothing else changes: densities, the lighting-cycle weights, locals to yard tracks, passenger traffic, the wye's
  streams and the exit coin are as they were.

## The visit (the mission)

A visitor carries `train.shunt = { kind: 'fan' | 'spur', stage, stand, lead }` and is driven by `missions()` the way a
terminus train is. `arrival` is its dir on entry. Stages, for a **loaded** visitor at a **fan**:

1. **Approach.** `goal = { node: P }` (the fan's stand). Its last route ends at `P`'s signal for its arrival dir (route
   `b' → P` crosses `X`'s column; `X`'s shunt ends no route). It stops there with its tail `7 − 0.3 − len ≥ 1.1` cells
   clear of `X` (the longest cut is `0.8 + 8 × 0.6 = 5.6` cells, the terminus's run arithmetic). The operator sets
   nothing further for it.
2. **Reverse 1.** Stopped at `P`, with `!adv` (the still step), `clearToReverse(sim, t, runEdges)` and **no other train
   wrong main**: `reverse(sim, t, −arrival)`. Its head node is `X`, where the shunt stands; `goal = { track: dest }`;
   state `reversing`, status word `backing in` once it moves. From here until its tail clears the run it is the one
   wrong-main train (its path on the run reads against Main 1's home sense, so `isWrongMain` counts it with no new
   rule), which is why it waits for a moment when nobody else is.
3. **Back in.** The operator routes it from `X`'s shunt up the lead to its stub's buffer (one candidate per stub, it
   takes the one ending at `dest`; `slow`). It pushes at `PUSH_MPH`, the main behind it frees by sectional release as
   its tail climbs the lead, and it stops `FOUL` short of the buffer. The route lists `X` reverse, `J` and the ladder
   switches as needed; the fan section's sense is outbound.
4. **Set out.** Arrived (`stopped` at `dest`): state `dwelling`, status word `setting out`, `DWELL.setOut = 3 × 60`.
   When it is up: `sim.cuts.set(dest, { track: dest, type, cars })`, then the train becomes its loco: `cars = 0`,
   `len = LOCO`, `headDist −= oldLen − LOCO`. The loco's pixels are where they were; the cars' pixels are now the cut's,
   drawn the same way. Log `<train> set out <n> cars at <stub>`.
5. **Reverse 2.** `reverse(sim, t, arrival)`: the loco leads (`locoAtTail` false, `pushing` false), head node `Si`.
   `goal = { node: Lt }`.
6. **Run out.** Routed from `Si` down the ladder and the straight to `Lt`'s dwarf (one candidate; sense inbound). It
   stops `FOUL` short of `Lt`, on the straight, `3 − 0.3 − 0.8 = 1.9` cells clear of `J`'s points. The main is not
   touched.
7. **Decide.** If some other stub of the fan is full: `dest` = the first full stub, **reverse 3** (`−arrival`; the
   loco "pushes" alone; head node `J`), `goal = { track: dest }`, continue at 8. Otherwise skip to 11 and leave light.
   (Amended 2026-11-04, final review: **a fair coin on `sim.cutRng`.** A loaded visitor that has set out picks up at
   another full stub only on one side of a coin drawn on `sim.cutRng`; on the other it leaves light though a full stub
   exists. A light visitor still always picks up. The coin is drawn once, as the set-out ends, and only when another
   stub of the fan is full, so no other draw moves and traffic without a fan is untouched. Picking up every time drained
   each fan to one cut within the first hour: see "What is left to the builder".)
8. **Back on.** Routed from `J`'s shunt to that stub's buffer. The **stop point** on a path that ends in a full stub
   is `cut.cars × CAR` short of the usual one (`FOUL` short of the buffer): the loco runs up to the cut and touches it.
   `moveTrains` applies this to every train whose path ends at a stub holding a cut, so nothing can ever run into a
   cut, however it was routed.
9. **Pick up.** `stopped` at `dest`: `dwelling`, status word `picking up`, `DWELL.pickUp = 2 × 60`. When it is up:
   `train.cars = cut.cars`, `len = LOCO + cars × CAR`, `headDist += cars × CAR`, `sim.cuts.delete(dest)`. The train's
   `type` is unchanged (its loco's colour stays), the cars take the train's colour from here (the cut was drawn in its
   own type's colour; the two are the same industry type on a fan stub in practice, and where they differ the change is
   a colour step on standing blocks, allowed under the half-second crossfade rule: the renderer eases the cars' colour
   like any other eased state). Log `<train> picked up <n> cars at <stub>`.
10. **Reverse 4.** `reverse(sim, t, arrival)`; `goal = { node: Lt }`; routed to `Lt` as in 6.
11. **Depart.** At `Lt`, `dest = null`, `goal = { exit }` with `exit` the far portal for `arrival` (its original exit:
    a visitor's exit is never the branch of a junction wye; `newEntry` keeps its exit coin draw but a visitor ignores
    its result). Routed from `Lt` down the lead through `X` and along the run to `P`'s signal (home sense; it needs the
    run free and the section not opposed), then on as any train. Log `<train> departed <stub>`; a light departure logs
    `<train> departed <stub> light`.

A **light** visitor runs 1–3 to its full stub, then 8–11 (its reverse 1 puts it on the run; its route from `X` ends at
the cut). A visitor at a **spur stub** has the spur's exit signal for its stand and the spur itself for `Lt`: it enters
the spur by its ladder as today, stops at the exit signal, reverses (head node `Xs`), backs into the stub, sets out or
picks up, reverses, runs back to the exit signal, and departs by the spur's exit as today. With one stub there is never a
step 7 pick-up: loaded visitors set out and leave light; light visitors pick up and leave loaded.

**Human routes.** A visitor sent on past its stand before it reverses gives the visit up (`<train> missed <stub>`): a
loaded one keeps its cars and runs for its exit, a light one runs home light. A visitor a human routes into a stub other
than its `dest` adapts: loaded into an empty stub sets out there; light into a full stub picks up there; loaded into a
full stub or light into an empty one stops (short of the cut, or at the buffer), reverses and asks for the way out. In
AUTO the operator drives every stage; in MANUAL the human sets the same routes from the same signals and the stage
machine follows what actually happened (arrived where, with what). A human cannot reverse a train; reversals happen in
`missions()` when the train is stopped at a stand or in a stub with its dwell up.

(Amended 2026-11-04, Task 3: **four accepted deviations.**
1. `fits` counts a standing cut: a train fits a full stub only if it fits beside the cut. So a human route into a full stub
   is taken only by a train that fits there, and one that doesn't fit dies after GRACE (`deadRoute`). Otherwise the train
   would stop with its tail out across the ladder, and turned round it would read no signal.
2. The stop point is a cut short only on a path that ends at the stub's buffer. A train turned round in a full stub
   (after its set-out) has the cut behind it.
3. A reversal logs the signal the train stood at, or at a buffer (no signal) the stub signal it now reads.
4. The operator's "arriving, it dwells" skip does not apply to visitors: turned round in its stub, a visitor's path is
   still on the stub, and it is leaving.)

## Interlocking additions and operator rules

- **One train in a fan.** By reservation and the menu rule; a human route into the lead needs a train's head at `X` or
  `J`, which only a visitor has. So the fan section's inbound/outbound sense rule never actually refuses anything, but
  it stays, and the soak asserts no two trains ever hold fan edges at once.
- **The shove is the wrong-main move.** The visitor reverses at `P` only while no other train is wrong main
  (`wrongMainTrains(sim)` empty but for itself), and from its reversal until its tail is off the run it is the one
  wrong-main train, so `setRoute` refuses every other wrong-main route meanwhile by the existing rule. It needs no
  junction exemption: none of its routes has a main edge against the home sense (arrival and departure are home-sense
  runs, the shove's main running is on edges it already holds).
  (Amended 2026-11-04, Task 4 long runs: **nobody else goes wrong main while a fan visitor approaches.** The 8-hour busy
  AUTO sweep of the 252 seeds in s0..s399 with a fan or a spur stub (`tools/sweep-industrial.mjs`) logged 22 STALLs on 8
  fan seeds and no wedge. The base layouts of those seeds run clean. In three of the cycles the visitor's own wait for
  "no other train wrong main" closed the loop:
  - s230, 06:00 + 259 min: a train sent round the approaching visitor on Main 2 (the pathfinder passes a standing
    visitor, though the visitor "is not passed") stood at `b'`. Its way home ran over the visitor's run, and its way on
    along Main 2 was held head on by an eastbound at `P`.
  - s366, 294 min: a branch arrival sent across the junction gap waited on a train queued behind the visitor at `P`.
  - s125, 68 to 71 min: the visitor entered behind a train already wrong main in the terminus gap, whose way home was held
    by the queue behind the visitor's stand.
  Each held the visitor until the valve (20 min), and held a train behind them for 30 min. Two rules follow.
  - While a fan visitor is on its approach (entered, not yet turned round), the operator sends no other train wrong main,
    nor across a junction gap's other main (`gapWrong`). A train that has stood STARVE is exempt.
  - A fan visitor enters from its portal queue only while `wrongMainBusy`, the gate's predicate, is false.
  With them, the same sweep logs 7 STALLs on 6 seeds, again no wedge, and 66 visits given up instead of 84. Four of the
  six seeds are new: the rules move traffic on fan seeds. Five of the six show the older cycle kinds, where a wrong-main
  train meets an opposing train while its way home is held by a queue at a terminus gap or a junction: s12, s145, s93,
  s197 and s369. The sixth, s357, is a visitor cycle through the exemption. Without the exemption, a branch arrival
  already waiting at a junction stem starved behind successive visitors (s366), and s368 wedged.)
- **Nothing stands between `b'` and `P` but the visitor.** A route from `b'` ends at `P`, which the visitor occupies,
  so followers wait at `b'` with no new rule (the terminus's follower rule falls out of the geometry). While it backs
  in and once it is off the main, through traffic in both directions runs under the fan as normal: the gap is blocked
  for the working direction only during the stand and the shove, a minute or two.
- **Never passed, never held.** A visitor is not held for a faster train and is not passed (`prio` as its type), like a
  terminus train; `trainBehind` skips it.
- **Never wrong main.** A visitor that is wrong main (only a human can do that) gives the visit up at once and runs for
  its exit, as a branch-bound train does (`missed`).
- **The valve.** A visitor that has stood `2 × STARVE` (20 min) at its stand unable to reverse (another train wrong
  main all that time, or the section opposed) gives the visit up and runs on: at a fan, its route `P → b` is its home
  sense and always available when free; at a spur, it departs by the spur's exit. One that has stood `2 × STARVE` at
  `b'` with its way to `P` refused does the same. Expected to fire rarely; counted in the long runs.
  (Amended 2026-11-04, Task 3: the valve counts time stood anywhere short of the stand, not only at `b'`.)
  (Amended 2026-11-04, Task 3 review: **reverse 1 does not wait out a terminus visit** (see "Builder check" 4). With the
  gate waiting on every terminus visit, s14 busy wedged: a terminus train in its stub waited from 06:45 for the eastbound
  trains in its gap to clear, and they were queued behind a visitor standing at `P` from 06:54 that was waiting on that
  visit. The valve released the visitor a minute before the terminus train had stood 30 min (STALL). The first fix, a
  give-up at the stand while a terminus train was turning round, kept s14 under 30 min but gave up most visits on
  terminus seeds (s12: 1 visit, 8 given up in 8 h; s14: 6 and 4; s19: 5 and 5). It is withdrawn. With the gate below, the
  same 8 busy hours give s12 10 visits, s14 11 and s19 12, none given up, and s14's longest stand is 17.0 min.)
- **Dead routes.** Shunt routes with no train at their signal die after GRACE (the existing rule covers `X`, `J` and
  `Xs`).
  (Amended 2026-11-04, Task 4 monkey runs: **also from `Lt` and the stub signals.** A human route from a fan's lead signal,
  or from an industrial stub's signal (`Si`, `Sq`), with no train at it is dead after GRACE, like a shunt's: only a
  visitor ever stands there. `Lt`'s route runs down the lead onto the run. It is no wrong-main route and runs out of no
  track, so no clause caught it, and in a random-clicking run of s12 one held the run from 06:09 to 06:44. A stub
  signal's route was kept alive by the out-of-a-track clause while a visitor was bound for that stub.)
- **The cut is a wall.** The stop-point rule in stage 8 applies to every train and every stub. The soak asserts no
  train's head is ever past a cut's near end.
- Everything else stands: trunk lock, un-entered routes own their switches, one un-entered route per signal, sectional
  release, atomic routes across a terminus gap, the wye's rules.

## Rendering and panels

- **Stubs** draw as tracks with a yard-style name (small caps, dim) on the side away from the main, and a **buffer
  stop** bar across the end, `2 × lw`, as the terminus's. No platform box. The lead and ladder draw as track.
- **Cuts** draw as car blocks at the buffer end of their stub, `cars × CAR` long ending `FOUL` short of the buffer, in
  the cut's type colour at 70 % alpha over the bg underlay with 1 px gaps, exactly as a train's cars: no loco, no
  headlight, no tail marker, no tag. A cut appears and disappears only at a set-out or pick-up, where its pixels and the
  train's cars' pixels are the same, so there is nothing to fade. A cut cannot be selected or inspected (tracks have no
  inspector today and get none); the log says what was set out where, and a stub's signal inspector lists its exits as
  any signal's does.
- **Light engines** are a lone loco block with its tag; nothing new.
- **Signals**: `X`, `J`, `Xs` shunts draw as dwarfs standing back from the points along the edge they face, like the
  terminus feet's; `Lt`, `Si`, `Sq` as dwarfs. Padlocks at `X`, `J`, `K1`, `Xs` as at any switch.
- **Board / inspector**: status words `setting out` and `picking up` (dwelling in a stub), `backing in` (exists) while
  pushing, `light` appended to the type name of a train with no cars in the inspector's `Length` row (`light engine`).
  The inspector's `Destination` names the stub; `Direction` reads as for a terminus train (its `exit` is unchanged
  through the visit, so a westbound visitor reads `westbound to <west portal>` throughout, and `eastbound …` while it
  shoves, from its dir).
- **Legend**: the trains block gains `standing cut`. README "What's on the panel" gains a short paragraph on
  industrial leads and spur stubs. The About panel's text is unchanged.
- **Camera**: `followCandidates` unchanged (a follow continues up the lead by the head point; a reversal swings the
  target as it does at a terminus, accepted). The fan's label joins the overview fit as a module name does.
- **Log** lines: `reversing at <signal>`, `backing into <stub>` (exist), `set out <n> cars at <stub>`, `picked up <n>
  cars at <stub>`, `departed <stub>` / `departed <stub> light`, `missed <stub>`.

(Amended 2026-11-04, Task 5: **placement and the pick-up colour.**
1. A stub's name sits over its buffer edge, clear of the stub signal's dwarf (which stands on the same side, the right of
   travel out of the stub), centred there when it fits, else from just past the dwarf on past the buffer, as the
   terminus's name runs on past its buffer. Centred over the whole stub, the dwarf's lamp covered the name's first letter
   from zoom 0.85 down.
2. A spur with a stub is named over its entry edge short of the stub's lead (entry to `Q`): centred on the spur, the name
   sat where the lead leaves `Xs`, and the lead crossed it.
3. Step 9's "the two are the same industry type in practice" does not hold: a loaded visitor that sets out at one stub
   and picks up at another picks up the other industry's type (s7: a manifest sets out at a lumber stub and picks up an
   intermodal cut). The crossfade step 9 allows is built: the renderer remembers the cuts it last drew, and cars that
   appear on a train in the stub whose cut has just gone ease from the cut's colour to the train's (120 ms). Positions
   never move: a set-out or pick-up is pixel-identical in the stub, the colour aside.
4. The `J` shunt's glyph (below the straight on a north fan, above on a south one, back from `J` along `Lt–J`) clears
   `K1`'s padlock (on the far side of the ladder) and the stub 0 line at zoom 0.6 and 2: `signalGeom` is unchanged.
5. At the fit zoom of a wide fan seed (about 0.35 with the docks open) stub names overlap the neighbouring stub's line and
   one another, as yard track names do there; accepted.)

## Tests

- `test_gen`: among s0–s199, ≥ 25 % of seeds have a fan (both sides, both counts seen) and ≥ 20 % have at least one
  spur stub; a fan gap has the exact column layout above (per side and count) and `GAP_FAN` width; rows padded; the fan
  is one section, every fan edge two-way, every fan signal `dir 0`, `X`/`J`/`Xs` of kind `shunt` and transparent, each
  stub `{ cls: 'stub', stub: true }` with capacity ≥ 5.6; the spur stub's `Xs` is 7 cells upstream of the exit signal
  and the stub row is otherwise empty; no crossings, ≤ 3 edges, switches well-formed; names distinct; every stub
  reachable from its serving portal and from no other; **non-industrial seeds identical** to the current generator
  (the five frozen fixtures and a 200-seed byte comparison against a generator run with `FAN_P` and `SPUR_STUB_P`
  forced to 0), and industrial seeds identical to themselves across runs.
- `test_sim`: on a fan seed, a loaded visitor's full mission in order (stand, reverse, back in, set out with the cut
  created and `len === LOCO`, run out to `Lt`, reverse, back on, pick up with the cut removed and `len` restored,
  reverse, depart via `P`, out at its original exit), the loco block never moving at a set-out or pick-up (block
  positions equal before and after); a light visitor picks up only; a loaded visitor with no full stub leaves light; the
  stop point short of a cut from any signal; a spur-stub mission both ways; menus offer loaded only with an empty stub
  and light only with a full one, and nothing while a visitor is queued or the fan is busy; reverse 1 waits while
  another train is wrong main; the valve; a human route past the stand gives the visit up; `trackFree` on one stub
  false while another of the fan is held; the soak adds four fan seeds (north/south × two/three) and two spur-stub
  seeds with every invariant plus: one train in a fan at a time, no head past a cut, no train in a stub longer than
  `DWELL.setOut + STALL`. Long runs before merge: every fan seed and every spur-stub seed in s0..s399, 8 h busy, AUTO:
  0 wedges, 0 STALL, and the monkey runs (random human clicking) all recover.
  (Amended 2026-11-04, final review: the long runs, before step 7's coin, reached 0 wedges and 7 self-clearing STALLs
  on 6 of the 252 seeds, none of them a spur-stub cycle, accepted because breaking them means loosening "one wrong-main
  train": see the amendment under "The shove is the wrong-main move".)
- `test_ui` / `test_camera`: status words; the inspector's `Length` row for a light engine; `followCandidates` with
  light engines.
- Visual: screenshots of a north fan and a south fan, a spur stub on each side, day and night; a train backing in; a
  loco running light past a standing cut; the moment after a set-out.

## Rulings made without the user

- One fan per terminal, in a gap the wye does not use; `FAN_P = 0.5`; two or three stubs by a fair coin; north fans
  worked by westbounds, south by eastbounds, the lead trailing the working direction so no runaround is ever needed.
- Visitors are cuts of 3–8 cars, never unit trains; a spur with a stub becomes a cut-only industry. This keeps the
  terminus's proven 7-cell run and stub arithmetic and the gap at terminus size.
- Exactly one train in a fan at a time; the fan is one reservation unit; the spur's reservation covers its stub.
- The shove is the one wrong-main move and reverse 1 waits for a moment when nobody else is wrong main, instead of a
  junction-style exemption.
- The east pair sits under the lead so the run is its own short section and the gap stays 33–34 columns.
- The stop point short of a cut is a rule of motion for every train, not of routing.
- Set-out 3 min, pick-up 2 min; the visit's schedule allowance is their sum plus five minutes.
- A train with nothing to pick up leaves light; a light visitor exists as a traffic item so the stubs drain as well as
  fill. Initial cuts: all but one stub per fan full; spur stubs by a coin.
- Stubs are named by industry with the fan's one place name; the spur stub by its spur's industry with a short suffix.
- Cuts cannot be selected or inspected; the log records every set-out and pick-up.
- Byte-identity is tested through a generator knob (`generate(seed, { industrial: false })`), so the fixture seeds
  keep pinning the base generator whether or not the `:industrial` stream gives them a fan.

## Builder check (2026-11-03, before the plan ran)

A fresh reader planned from this document and asked four things; rulings:

1. **Fixture seeds that draw a fan or a stub.** Every fixture test that generates a layout (`layouts.json`,
   `run-s42.json`) does so with `generate(seed, { industrial: false })`; the wedge fixtures embed their layouts and
   are untouched. No stream-name search, no re-freeze, no lowered probabilities. The fixtures pin the base generator and the base sim; `layouts-industrial.json`
   (new) pins the industrial layouts.
2. **The `X` and `Xs` shunts' main candidates.** `candidates()` also gives `X` the main onward (straight on to `b'`
   on Main 1, wrong main, and across the east pair to `b'` on Main 2), as a terminus foot's shunt keeps the main
   onward. Kept: no new rule, and it is what makes a human-misrouted visitor possible. The operator never picks them
   for a visitor (its goal is the stub). A visitor a human sends onto a main at any stage gives the visit up
   (`missed`), keeps whatever it has coupled, and runs for the far end of the direction it is then facing
   (`exit = portalFor(sim, −dir)`), as a terminus train sent away after reversing does. `Xs` has only the stub
   candidate (the spur's edges are one-way).
3. **Reachability.** On the empty layout `findPath` reaches a fan's stubs only against the serving direction, so
   `sim.reach` is not how stubs get on the menu: `trafficMenu` adds them from `layout.fan` (serving dir `fan.main`,
   serving portal `portalFor(sim, fan.main)`) and from `tracks[].stubOf`; a visitor's exit is fixed to the far end
   of its arrival dir and `reach.exits` is not consulted for it. The generator test's reachability clause becomes:
   from `X` reversed (dir `−fan.main`, `from` the run) every stub is reachable; from no portal in the serving dir is
   any stub reachable on the empty layout (so no plain train is ever drawn for one).
4. **The reverse-1 wrong-main wait is for fan visitors only.** A spur-stub visitor reverses on the spur, on no main,
   and waits for nothing but `clearToReverse` on the spur's edges. The fan gate is the same predicate `setRoute` uses
   for `wrong main` (no other wrong-main train, no untaken wrong-main route, no terminus train on its visit),
   factored out as one function, so a fan and a terminus in one terminal cannot both be mid-move.
   (Amended 2026-11-04, Task 3 review: **the fan gate drops the terminus clause.** It waits only for another wrong-main
   train and for an untaken wrong-main route (`wrongMainBusy(…, { visits: false })`); `setRoute`'s predicate is unchanged.
   The two gaps share no section, and the shove needs nothing beyond its own run and lead, so neither move can block the
   other's way home. A shoving visitor still counts in `wrongMainTrains`, so the terminus train's own wrong-main routes
   (leaving its stub against the feet main) wait out that minute. The soak's "no train sent wrong main during a terminus
   visit" check exempts the shove. Waiting out every terminus visit, the gate gave up most visits on terminus seeds.)

Also noted by the check: `senseIn()` reads `mainRow[wye.feetMain]` (throws with no wye) and gives every horizontal
edge the same sense. The fan section defines its own: `+1` outbound `= sign(Δx) × (−fan.main)` (every fan edge has
`Δx ≠ 0`), and `createSim` keeps a `section → sense function` or `section → main` map for the wye's and the fan's
sections. The south fan's mirror leaves the gap's pairs at `b+9` and `b+25` rather than at `b+1`: fine, the pairs list
is arbitrary.

## What is left to the builder

The exact data shape of `train.shunt` and the stage names; how `cars` threads through `trainLength`, `trainBlocks`
and `newEntry`; the industry suffixes for spur-stub names; the exact menu weights if the long runs show stubs stuck
all full or all empty (the balance knob is the light-visit weight); label and buffer-bar placement at every zoom; the
order of the `:industrial` draws (fixed once, then frozen by the fixtures).

(Amended 2026-11-04, final review: **the balance knob was step 7, not the light-visit weight.** With step 7 picking up
every time, a loaded visit is net zero on a fan that holds a cut and a light visit is −1, so no weight lifts a fan back
above one cut once it is down to it. Measured on 8 three-stub fans × 8 busy hours, hours with 0/1/2/3 cuts were about
2.4/4.8/0.9/0.0, every fan below two cuts within 11–62 min (the review's seeds; on the first eight three-stub fans, s5,
s11, s14, s19, s20, s23, s25 and s28: 1.2/5.2/1.6/0.1). With step 7's coin (above) those eight give 0.7/2.9/3.4/1.0.)
