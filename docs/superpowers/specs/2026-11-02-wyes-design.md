# Wyes: the Keddie junction and the Tampa terminus

Amends the three earlier specs (`2026-10-31-idleswitch-design.md`, `2026-11-01-bidirectional-mains-design.md`,
`2026-11-01-idle-ambience-design.md`). Where they disagree, this document wins.

## Intent

Everything on the panel runs east or west today. The user wants trains that leave the horizontal, and named
two real wyes as the model:

- **Keddie**: two main lines merge and diverge at a wye. On the panel: a single-track branch main arrives
  from the top or bottom edge through its own portal, joins the near main at a wye, and traffic flows
  between the branch and both directions of the main. No reversing.
- **Tampa**: a stub-end station off a wye. A passenger train arrives, pulls past the wye, backs through a
  leg into the stub platform, dwells, and departs forward the way it came. Reversing moves, pushing, a
  train whose loco is at the back.

Both need the same thing underneath: track that is vertical or diagonal, and a direction model built on
*where the train is going next* rather than on east and west. This spec builds that model once and
delivers the two wyes as two phases: **Phase 1** the model and the Keddie junction, **Phase 2** reversing
and the Tampa terminus. A terminal has at most one wye; the seed decides whether it has one and which kind.
It stays a screensaver: same seed same day, no gridlock, nothing jumps.

## Goals

- A seeded wye in a widened gap between two modules, north of Main 1 or south of Main 2, with 45° legs
  and a vertical stem. Phase 1: the stem runs to a third portal at the panel's top or bottom edge. Phase 2:
  the stem is a stub platform with a buffer stop.
- Trains enter from the branch portal bound east or west, and trains from either end leave by it. The
  operator routes all of it; a human can NX all of it; the interlocking refuses head-on and wedge moves
  as today, including on the single-track stem.
- Phase 2: a terminus train arrives from either end, pulls ahead, reverses, backs into the stub at
  restricted speed with its loco trailing, dwells, departs forward and leaves toward the portal it came
  from. The headlight leads whichever end is leading; the tail marker trails.
- Signals stand on the right-hand side of travel on every heading, with their direction chevron along the
  track. Tags sit on the right of travel too. Labels gain `N`/`S` facings.
- Every existing invariant holds on every seed (with or without a wye): no double occupancy, no passed
  red, no stall in the soak, one wrong-main train (with the junction exemption below), same seed same day
  at the same density and day length. Layouts without a wye are unchanged pixel for pixel except where
  this spec says otherwise (signal labels, board columns).

## Non-goals

- Crossings, diamonds, flyovers: still none. That is the grade-separation project that follows.
- A branch with its own modules or stations. The branch is a stem to a portal (Phase 1) or a stub
  (Phase 2).
- Two wyes in one terminal; a wye inside a module; a wye on both mains at once.
- Light rail or any new traffic class.

## The direction model

Today `dir ∈ {+1, −1}` means three things at once: which end a train is bound for, which way it travels
along an edge (the sign of Δx), and which signals it reads (`node:dir`). The wye breaks the second and
third. The new model keeps `train.dir` for identity and takes travel from the path.

**Travel sense from the path.** A train's path is a chain of edges from a known start node:
`train.pathStart` is the node at `pathOff` (the entry portal at spawn; advanced by `sectionalRelease` as
edges drop off the front). The node order of every path edge follows by chaining (`far(edge, prev)`), so
`headNode`, `pointAt`, `trainBlocks` and `occupy` no longer use the x rule. `toNode(edge, dir)` is removed.

**Forward edges.** `forwardEdges(sim, node, dir, from)` returns the edges a dir train may leave `node` by
when it arrived on edge `from` (`null` at a portal):
1. not `from`;
2. the edge permits travel in that node order (`edge.oneWay` is `null` for both ways, else the node id the
   edge may be entered from; replaces `dirs`, which encoded the x rule);
3. **x-monotone for the train's dir**: `(far.x − node.x) × dir ≥ 0` — a dir train never moves against its
   dir, and edges with Δx = 0 (vertical) are neutral; so a train never doubles back, and for the existing
   geometry this is exactly today's rule;
4. at a switch node, only trunk ↔ leg (never leg ↔ leg; never trunk ↔ trunk).

**Signals face an edge.** A signal is `{ id, node, from, dir, kind }`: it stands at `node` for trains
arriving on edge `from` (`null` for portal signals). `sim.signalAt` is keyed `${node}:${from}`;
`signalAhead(sim, node, from)` looks one up. `dir` is `+1`, `−1`, or `0` ("either": the branch's own
signals serve both directions). For every signal in a layout without a wye there is exactly one `from`
edge per `node:dir`, so the mapping from today's signals is mechanical.

**Routes carry a dir.** `candidates(sim, sig)` walks `forwardEdges` with the signal's `dir`; for a `dir 0`
signal it walks with each of `+1` and `−1` and tags each candidate `cand.dir` (the dir whose rule admitted
it; a candidate admitted by both, e.g. straight down the stem to the next stem signal, is one candidate
with `dir 0`). A train adopts only candidates whose `dir` is `0` or its own. `route.dir = cand.dir`.
`candidate` also records `cand.nodes` (it already walks them) and `cand.from` (the signal's `from` edge).

**Switch geometry.** The trunk of a 3-edge node is the edge whose direction vector has a negative dot
product with both others (a lone edge on one x-side for every switch that exists today; the stem at a
wye apex; the main-side edge at a wye foot). `normal` is the leg with the larger dot product against the
trunk's continuation; on a tie (the apex, both legs 45° off the stem) the leg with the smaller x. The
existing switch rules (trunk-edge lock, lie, `switchLocked`) are unchanged.

**Pathfinding.** `findPath(sim, fromNode, dir, goal, penalty, from = null)` tracks the arriving edge per
node and expands with `forwardEdges(u, dir, cameBy)`. `goal.exit` is now a portal id (see Portals);
`{ node }` and `{ track }` are unchanged.

**Aspects.** `aspectOf` follows `cand.exitSignal`, which is `signalAhead(exitNode, lastEdge)`. The branch
is a dead-end line (stem to a portal or a buffer) and routes are x-monotone with neutral verticals, so
the recursion still terminates; the memo stays.

**Where it is used.** `headNode`, `adopt` (`signalAhead(headNode, lastPathEdge)`; before the first route,
`signalAhead(entryNode, null)`), `canEnter`, the operator (`sig = signalAhead(...)`, `findPath(..., from)`),
`deadRoute`, `camera.js` (`headAt` already uses `pointAt`), `panels.js` (`Signal ahead`), the renderer.

## Portals and traffic

`layout.portals[i] = { id, node, name, dir, side }`. The west portal (`dir +1`, `side 'west'`) and east
portal (`dir −1`, `side 'east'`) are as today. A junction wye adds `{ dir: 0, side: 'north' | 'south' }`
at the stem's top (`y = 0`) or bottom (`y = rows − 1`).

- **Entry.** `sim.queue` and `sim.nextSpawn` are keyed by **portal id**. A queue entry carries `dir`: at
  the west and east portals the portal's dir; at the branch portal `+1` or `−1` by a fair coin from
  `sim.rng`. Train numbers still count per dir (`nextName[dir]`). The spawn gate `canEnter` reads
  `forwardEdges(portal.node, q.dir, null)[0]` and "no train still at this portal" per portal. The log
  line `<train> entered from <portal name>` and the board's From column use the entry portal.
- **Exit.** Every train gets `train.exit`, a portal id: the far end of its dir, or, with probability
  `BRANCH_SHARE = 0.3` when a junction exists and the branch is reachable for its dir, the branch portal.
  `exitNodes(sim, train)` → the far end's two row nodes, or the branch portal node. `goal: { exit }`.
  `despawnTrain` logs `out via <exit portal name>`; completed records carry `from` and `to` names, and
  the board shows them.
- **Spawn rate.** Total traffic is unchanged: with three portals each portal's mean interval is
  `DENSITY × 1.5` (ruling: a terminal with a junction is not busier, the traffic is shared three ways).
  `QUEUE_MAX` is per portal.
- **Reachability.** `createSim` computes, on the empty layout with `findPath`, which tracks each
  `(portal, dir)` can reach and which exits each `(track, dir)` and `(portal, dir)` can reach.
  `trafficMenu(sim, dir, portal)` drops destinations the entry cannot reach (a branch arrival bound east
  never draws a platform west of the wye). The exit coin and the branch arrival's direction coin come from `sim.branchRng = makeRng(seed +
  ':branch')` (one draw per entry, always drawn, so traffic on layouts without a wye is unchanged) sends the train to the branch only when the branch is reachable from its
  destination for its dir (or from its entry when it has none); otherwise it keeps the far end. So no
  train is ever born unable to finish. Scheduled time (`newEntry`) keeps the home-main formula.

## The wye (geometry)

One wye at most, placed by the seed in one inter-module gap (never a margin), on the side the seed picks:
**north** (legs on Main 1, apex above it) or **south** (legs on Main 2, apex below it). Probability a
terminal has a wye: `0.6`; given one, Phase 1 makes it a junction; Phase 2 makes it a junction or a
terminus by a fair coin.

**Gap layout** (west to east; `b` = boundary signal column of the module to the west, `x1 + 1`; `b'` =
`x0 − 1` of the module to the east; `.` = one empty column):

```
junction:  b | pair(6) | . | F1 . A . F2 | . | pair(6) | b'                 b' = x1 + 21,  GAP_WYE  = 22
terminus:  b | pair(6) | P | run(7) | F1 . A . F2 | run(7) | P | pair(6) | b'   b' = x1 + 34,  GAP_TERM = 35
```

(Amended 2026-11-01, Task 6: the terminus as built is `b | pair(6) | . | P | run(7) | F1 . A . F2 | run(7) | P | . |
pair(6) | b'`. Counted from `b`: the pairs are at `b+1..b+6` and `b+28..b+33`, `P` at `b+8` and `b+26`, `F1 = b+15`,
`A = b+17`, `F2 = b+19`, and `b' = b+34 = x1 + 35`, so **`GAP_TERM = 36`** (the next module's `x0 = x1 + 36`). The empty
column between each pair and its `P` makes the gap symmetric about the apex; the 35 above was approximate. Both mains
carry nodes at the `P` and foot columns, so each run is one 7-cell main edge on either main. A terminus's `layout.wye` is
`{ kind: 'terminus', side, gap, F1, F2, A, feetMain, x0: b, x1: b', P: { 1: <east P node>, '-1': <west P node> }, stub:
<track id>, shunt: { F1: <signal id>, F2: <signal id> }, stubSignal }`. `P` is on the feet's main, keyed by arrival
dir. There is no branch portal. The kind coin is the fourth draw of the `:junction` stream, after presence, side and
gap, so a seed's presence, side and gap are the same as before termini existed.)

- `F1`, `F2` are the **feet** on the main (two nodes four columns apart); `A` the **apex** two rows off the
  main, between them: north wye `A = (F1.x + 2, T − 2)`, south wye `A = (F1.x + 2, R2 + 2)`. Legs
  `F1–A` and `F2–A` are 45° edges of class `wye` (speed 30, both ways, len 2√2), like crossovers.
- **No signal stands inside the junction** (between the two pairs) except the two shunt signals of a
  terminus, below. Every through move across the gap, every move into the branch and every arrival out
  of it is therefore **one route from a signal outside the junction** (`b`, `b'`, a `P` column, the stem
  signal, the stub signal): a train is either outside the junction or committed through it with its whole
  route set. That is what keeps the junction deadlock-free (a train can never stand inside it waiting for
  the branch while a branch train waits for the main). Signals never sit on a switch node.
- `P` marks the **pull-ahead columns** of a terminus: signals in both main directions on both mains, as
  at module boundaries. The 7-cell **run** between a foot and its `P` is a single edge, so a terminus
  train stopped at `P` (`FOUL` short) has its tail `7 − 0.3 − 5.6 = 1.1` cells clear of the foot and its
  reversed head node is the foot.
- **Shunt signals** (terminus only): at `F1` facing east (`from` = the west run) and at `F2` facing west
  (`from` = the east run), `kind: 'shunt'`, `dir 0`, drawn as dwarfs, aspects as dwarfs. A shunt signal
  **does not end a route**: `candidates()` walks through its node as if it carried no signal, so through
  routes from `P` cross the whole junction; only a train whose head node is the foot (a reversed terminus
  train) reads it through `signalAhead`. Its own candidates are walked normally: the near leg into the
  stub, and the main onward. Because the foot is a switch node, `switchLocked(sim, node, forTrain)` ignores
  the trunk occupancy of `forTrain` itself when the route being set is for that train and starts at that
  node: the standing train's head is ≥ 1.1 cells clear of the points, so the points may move for it.
- The **stem** is vertical from `A` away from the main. Junction: to the branch portal at the panel edge,
  at least two cells long, class `branch` (speed 45, both ways), with a **stem signal** (`dir 0`, facing
  toward the main) one cell before the apex and the portal signal (`dir 0`) at the portal. Terminus: the
  stem is the **stub platform**: a node one cell past the apex (the stub's exit signal node, `dir 0`,
  facing the apex) then a 7-cell `platform` edge to the buffer stop; the track is
  `{ cls: 'platform', dir: 0, name: '<Place> Union 1', stub: true, capacity: 7 − 0.5 }`.
  (Amended 2026-11-01, Task 6: a junction stem is at least **four** cells long. This was ruled from screenshots: at
  two cells, the stem's two signals and the tag of an arrival standing there crowd each other. The stub is two
  `platform` edges, `A–S` (1 cell) and `S–buffer` (7). Both have `oneWay null` and belong to the stub track
  (`edges: [A–S, S–buffer]`, capacity 6.5, `industry: null`). They share the branch section with the legs. The stub
  signal faces `S–buffer`, and the buffer node has one edge.)
- **Rows.** A north wye needs `T ≥ 4` (apex at row 2, stem rows 2..0) and the terminus's stub needs
  `T ≥ 10`; the generator pads `T` up to the need (empty rows above the top tracks). A south wye pads
  `rows` likewise. Place names stay at `y = −1`; the branch portal's name sits beside the portal.
  (Amended 2026-11-01, Task 6, with the four-cell stem: north `T ≥ 6` for a junction (apex at row 4 or below) and
  `T ≥ 10` for a terminus (apex 8, `S` 7, buffer 0); south `rows − 1 − R2 ≥ 6` and `≥ 10`.)
- Both pairs in a wye gap are ordinary crossover pairs; sections split at crossover ends as today. Every
  main edge strictly between `b` and `b'` is tagged `junction: true` (both mains, including the one-cell
  pieces inside the pairs): the **junction gap**.
- The generator's no-crossing and ≤ 3-edges invariants hold by construction: the legs sit in rows the
  modules do not use in that gap, the stem is in the gap's middle column, nothing crosses.

## Interlocking additions

- **Branch section.** The two legs and the stem form one section (`section` id, not a main). Its sense is
  **inbound** (toward the main) or **outbound**. `opposing()` generalises: for each section a candidate
  touches, the candidate's sense in that section is its `dir` on a main section, and inbound/outbound on
  the branch section (from the node order of its first edge there); it is refused when any edge of that
  section is occupied by a train whose sense there is opposite, or route-locked by a route whose sense
  there is opposite. `route.sense` is stored per section at `setRoute`; a train's sense in a section comes
  from the node order of its path edges there. On main sections this is exactly today's rule.
- **Junction exemption to one-wrong-main.** Wrong-main edges tagged `junction` do not count toward the
  one-wrong-main-train rule (`isWrongMain` ignores them), so a train whose only wrong-main running is
  inside the junction gap may be routed while another train is wrong main elsewhere. Reason: an eastbound
  arrival onto Main 1 (north wye) crosses to Main 2 at the east pair a few cells on; an eastbound
  departure crosses to Main 1 at the west pair to reach `F1`; on a south wye the westbound moves use the
  one-cell Main 2 piece inside a pair. Safe because every junction move is one atomic route set from
  outside the gap: a wrong-main train inside the gap always holds its route out of it, and traffic
  locking per section keeps opposing trains out of the pieces it uses. The soak keeps "at most one" for
  non-exempt trains and asserts that exempt wrong-main running only ever happens on `junction` edges.
- **Stem one at a time.** The branch section's sense rule means one direction of flow at a time on the
  stem. A train standing at the stem signal waiting for the main is the normal picture.
- Everything else (trunk lock, one un-entered route per signal, sectional release, dead routes) stands.
  `deadRoute`'s "wrong main with no train at its signal" clause treats a `dir 0` signal as having a train
  when any train's head is at it.
  (Amended 2026-11-02, Task 7: **an un-entered route owns its switches.** `switchLocked` also holds every switch
  listed in the `cand.switches` of a set route that its train has not entered. Every other route through a switch
  already holds it by its trunk lock. A route from a shunt signal leaves its foot by a leg and never locks the trunk,
  and before this its points could be thrown under it. "Any set route", the first wording, changed traffic on every
  seed: sectional release frees a trunk behind the train while the route lives on. Once entered, the train stands on
  the run, which is the trunk, and its occupancy holds the points. The switch inspector's `Locked` names such a route
  (`route from <signal>`) as it names a trunk route (Task 8).)
  (Amended 2026-11-02, Task 7: **dead shunt routes.** In AUTO, `deadRoute` also clears a human route from a shunt
  signal GRACE after it was set when no train's head is at that signal, i.e. its head node is the foot, arrived on
  the signal's `from` edge. Only a reversed terminus train ever comes there; an unused back-in route at the other
  foot kept an arrival reversing for hours.)

## Phase 2: reversing and the terminus

**Reversal.** `reverse(sim, train, newDir)` requires `train.speed === 0`. It sets `train.dir = newDir`,
`train.path` to the reverse of the occupied edges (those overlapping `(tail, head]`, in reverse order),
`train.pathStart` to the old `headNode`, `pathOff` to `0`, and `headDist` to `r + train.len` where `r` is
the unused remainder of the old head's edge beyond the old head (so the new tail sits exactly where the
old head was: no jump). The distance the train has run so far is banked in `train.run += old pathOff`
before the reset, and `despawnTrain` records `run + pathOff`. It clears
`train.routes` (releasing any un-entered route set for it), toggles `train.locoAtTail`, and sets
`train.pushing = !train.locoAtTail ? false : true` (pushing when the loco trails). Occupancy is unchanged
by construction (`occupy` recomputes from the new path and agrees with the old set). A pushing train's
speed is capped at `PUSH_MPH = 15`.

**The terminus mission** for a train with `dest` = the stub track (`train.terminus = true`; drawn from the
menu for both main portals with weight `6 × pax`, types `P` and `X`, like a platform):
1. **Approach.** `goal = { node: pullAhead }` where `pullAhead` is the `P` node on its main beyond the
   far foot for its arrival dir (east of `F2` for eastbound, west of `F1` for westbound). Its last route
   ends at the `P` signal and it stops there; with the goal reached the operator sets nothing further.
2. **Reverse 1.** Stopped at `P`: `reverse(sim, t, −arrivalDir)`. Its head node is now the far foot (the
   run is one edge and the tail cleared the foot by 1.1 cells), where the shunt signal stands.
   `goal = { track: stub }`. State `'reversing'`, status word `backing in`.
3. **Back in.** The operator (or a human) routes it from the shunt signal down the near leg to the stub's
   exit-signal node and on to the buffer (one candidate, `slow`; the foot's points may move for it per
   the `switchLocked` rule above). It runs at `PUSH_MPH`, stops `FOUL` short of the buffer (the path's
   end), and dwells `DWELL.terminus = 10 × 60`. Nothing else can be inside the junction gap or on the run
   at this point: its own atomic route held them, and no other route could include the occupied run.
4. **Reverse 2.** `reverse(sim, t, −arrivalDir)` again (the dir is unchanged: it leaves the way it came,
   by the other leg). The head node is the stub's exit-signal node. `goal = { exit }` with `exit` = the
   portal it arrived from; `dest = null`. The loco now leads; `pushing` is false.
5. **Depart.** Routed from the stub signal up the leg toward its exit, onto the main (wrong main in the
   junction section, exempt) and across at the pair.

`missions()` drives steps 2 and 4 the way it drives `arrived`/`departed` today (log lines `<train>
reversing at <signal>`, `<train> backing into <stub>`, `<train> departed <stub>`). `trackAhead`,
`fits`, `trackFree`, `reserved` and the spawn gate treat the stub like a platform. `holdingTracks` never
includes it. A terminus train is never held or passed (`prio` as its type).

(Amended 2026-11-02, Task 7: **five operator rules.** Long runs showed the terminus gap wedging without them. With
them, every terminus seed in s0..s399 (116 seeds) ran 8 h busy in AUTO with no wedge and no STALL. Each costs some
terminus visits under busy traffic; the alternative is a smarter gap scheduler.
1. **Followers.** While a terminus train that has not reversed holds the feet main's junction edges, no other train
   gets a route from `b` or `b'` onto them (`setRoute` refuses `terminus`, humans included). The train reverses only
   with no other train and no route not its own on the sections it stands in, nor, at `P`, on those edges.
2. **One in the offing.** The stub is on the menus only while it is free and no terminus train is queued. Otherwise
   terminus entries fill every portal's queue and about a third fewer trains get through.
3. **Turn-round hold.** When a terminus train has stood STARVE (10 min) at `b` or `b'` before reversing, or at the
   stub signal after departing, the operator routes no train of the other direction into the gap and sends no train
   wrong main, both only while no train is wrong main.
4. **The visit is the wrong-main move.** From its first route into the gap until it is out again, a terminus train's
   visit is the one wrong-main move: no other train is sent wrong main meanwhile, and its own routes count as wrong
   main only past the gap (`wrongMainOut`). It leaves the stub against the feet main only while no train is wrong
   main. Other trains get **no junction exemption in a terminus gap**: its `P` columns are stands inside it, and on
   s200 an exempt through train stood at `P`, wrong main, on the main a wrong-main train had to get home by. Junction
   wyes are unchanged.
5. **The valve.** A terminus train that has stood 2 × STARVE (20 min) at `b` or `b'` with its way into the gap
   refused gives the stub up (`missed <stub>`) and runs through for the far end. It fired twice in 116 seeds × 8 h.)

(Amended 2026-11-02, Task 7: **five accepted deviations** from the text above.
1. `runOff` is unchanged: true at any portal's exit node. The buffer is none, so the train stops `FOUL` short of it
   as at any path end. Narrowing it to the train's own exit portal would strand a train a human routes out by another
   portal.
2. No train runs head first into the stub. With the shunt signals route-transparent, a `P` signal's walk up a leg
   would reach the buffer; only a shunt signal's walk may end there.
3. `reverse` drops the train's entered routes' locks too, not only its un-entered routes, and any path edge ahead
   of its head. Otherwise its own stale back-in lock on the stub (outbound) opposes its departure (inbound).
4. A reversal waits one still step (`!adv`): the step in which the train runs up to `P` is still being drawn with
   the renderer's lag, and reversing a step later keeps the new tail exactly where the head is drawn.
5. `reversing` is a state, which holds the train until it adopts a route. `backing in` is the status word for a
   running train that is pushing, not a state value.

A train sent on past `P` by a human before it reverses gives the stub up for good; one sent away from the stub
after reversing runs back for its entry portal, still pushing at 15 mph.)

**Rendering a pushing train.** `trainBlocks` returns the loco block at the head unless `locoAtTail`, in
which case the loco is the last block; the headlight goes at the leading end (the path head) in both
cases and the tail marker at the trailing end. The tag stays with the loco.
(Amended 2026-11-02, Task 8: the tag's anchor is the loco block (the last while it pushes), on the right of that
block's own travel, i.e. of the whole train's. For every other train it is the head block as before, so they are
unchanged pixel for pixel. A reversal swaps the ends, so a train's headlight, tail marker and tag are keyed by
which end its loco is at: the old ones fade out where they stood (the train is standing) while the new ones fade
in, under half a second, instead of jumping (the standing rule: no hard cuts). Reverse 2 keeps the dir but still
swaps them.)

## Rendering and panels

- **Signal placement** from the signal's facing: `facing` = unit vector from `from`'s far node to the
  signal node (portal signals: into the panel). Heads sit at `node + right(facing) × offset` with
  `right(v) = (−v.y, v.x)` in screen coordinates (y down): east → +y, west → −y, south-facing (travelling
  down) → −x, north-facing → +x. Two-head stacking continues outward along `right`. The chevron points
  along `facing`. The pick radius is unchanged.
  (Amended 2026-11-02, Task 8: shunt signals draw as dwarfs, on the right of their facing as dwarfs are. Each stands
  on a foot, a switch node, where the right of one of them is inside the wye's triangle: drawn at the node, its
  chevron lay on the leg and its head under the foot's padlock. So a shunt dwarf stands back from the points along
  the run it faces, `dr + 13` px (16.5 at zoom 1), its chevron's tip 6 px short of the node.)
- **Tags** sit on the right of travel of the head block (same `right()`), 10 px off; the existing above /
  below rule is this rule for horizontal travel. (Amended 2026-11-02, Task 8: of the loco block, which is the head
  block except while a train pushes; see "Rendering a pushing train".)
- **Track labels and platform boxes** follow the track's first-to-last node segment: horizontal as today;
  vertical tracks (the stub) draw the box rotated along the edge and the name reading upward beside it,
  on the right of travel of its exit direction. The branch portal's `to <name>` label sits beside the
  portal node on the right of entering travel, with the queue count under it.
  (Amended 2026-11-02, Task 8: the stub's box lies along its `S`–buffer edge, not from `A`. As on a row, it starts a
  cell clear of the exit signal at `S` and ends half a cell short of the buffer, with the same thickness and lights.
  It sits on the right of departure travel (from the buffer toward `A`): west of a north stub, east of a south one.
  It hugs the stub at `lw/2 + 3 + bh/2` at every zoom, since nothing stands beside a stub to need the rows' mid-gap
  rule. The name sits in the box turned a quarter, and **always reads bottom to top**, north or south. A name longer
  than the box (at overview zooms "<Place> Union 1" is longer than the stub) starts 4 px in from the box's `S` end,
  clear of a second head standing upstream at tight zooms, and runs on past the buffer into the margin beyond the
  panel's edge row. The buffer stop is a bar across the track's end, 2 × `lw` long, in track colour. A departing
  train's tag, on the right of its travel, draws over the box, as tags draw over everything; a train standing at `S`
  to leave has its tag beside `S`'s heads, as at a junction's stem signal. The apex padlock, east of a north apex and
  west of a south one, stays clear of the box.)
- **Legs and stem** draw as track (`wye` and `branch` are track classes; `COLORS` unchanged). The
  junction section gets no special colour.
- **Signal labels**: `${E|W|N|S}${x}${row letter}${d?}` with the letter from `facing` (dominant axis;
  diagonals never carry signals). (Amended 2026-11-01, Task 6: a shunt signal has an `s` suffix where a dwarf has
  `d`: `E<x><row>s` at `F1`, `W<x><row>s` at `F2`. `lamps()` lights it as a dwarf.)
- **Board**: From → To from the train's entry and exit portals; status words `backing in` and
  `reversing`. Inspector: `Direction` reads `eastbound to <exit portal>` / `westbound …` / for a `dir 0`
  head position on the stem the same with its dir; `Signal ahead` uses `signalAhead`.
  (Amended 2026-11-02, Task 8: the inspector's `State` is the board's status word, so it reads `reversing` and
  `backing in`. `Kind` reads `high`, `dwarf` or `shunt`. A switch's `Locked` names an un-entered route through the
  points (`route from <signal>`) when neither a train nor a route holds its trunk: a shunt route alone holds its
  foot. A terminus train's `exit` changes only when it departs the stub, so while it backs in its `Direction`
  reads the reversed dir toward the far end, e.g. `westbound to <east portal>`.)
- **Legend**: a `wye / branch` line under Track. README "What's on the panel" gains two short
  paragraphs (junction; terminus). (Amended 2026-11-02, Task 8: the line reads `wye / branch / stub`.)
- **Camera**: `followCandidates` and `signalCandidates` are unchanged (main rows only); a follow shot
  continues up the stem since it tracks the head point. The caption's `eastbound to <portal>` uses
  `train.exit`. (Amended 2026-11-02, Task 8: a follow's caption is read from its train every frame, its dir and
  `exit` as they are then, and the caption's crossfade carries the change. A terminus train followed through its
  reversal at `P` goes from `eastbound to …` to `westbound to …` in the same shot. At a reversal the follow target
  (the head plus 3 cells along dir) swings by about the train's length plus 6 cells, eased by the chase: accepted.
  A signal shot on a `P` signal counts a terminus train's reversal there as a pass, because its head moves back
  past the node and its dir flips, so the shot ends 6 s later: accepted.)

## Tests

- `test_gen`: wye seeds exist among s0–s99 (count ≥ 40 with a wye; Phase 2: both kinds ≥ 15); every
  layout keeps no-crossing, ≤ 3 edges, switch trunk/normal/reverse well-formed under the new trunk rule
  (and identical to the old rule on all non-wye nodes); a wye gap has the exact column layout above;
  `T` and `rows` padding; the branch portal at the panel edge with its stem; foot signals both
  directions; the stem signal and portal signal `dir 0`; sections: legs + stem one section, the
  junction section between the two pairs; every track reachable; from each portal every exit reachable
  by at least one dir; determinism. Non-wye seeds: identical node, edge, switch and track lists to the
  previous generator except `dirs` → `oneWay` and signals gaining `from`.
- `test_sim`: `forwardEdges` on a straight main equals the old rule; at the apex, trunk ↔ leg only;
  `candidates` from the stem signal give one eastbound and one westbound candidate; a branch arrival
  bound east is routed stem → east leg → Main 1 → east pair → Main 2 and is exempt from the wrong-main
  count; a departure bound for the branch from the west crosses at the west pair and climbs the west
  leg; `opposing` refuses an outbound route while an inbound train is on the stem and vice versa, and
  allows two inbound routes in sequence; the branch portal queue spawns both dirs and names count per
  dir; three-portal spawn intervals; `exitNodes(train)` per exit; `signalAhead` and labels with `N`/`S`;
  Phase 2: `reverse` preserves the occupied edge set, flips `locoAtTail`, puts the head node at the foot
  / at the stub signal; the full terminus mission on a terminus seed logs the five steps in order, the
  train leaves via its arrival portal, `pushing` caps speed at 15 mph, `trainBlocks` puts the loco last
  while pushing; the soak adds four wye seeds (two junction, Phase 2 two terminus) to the existing four
  with every invariant plus: no two opposing senses in the branch section, exempt wrong-main trains
  only in the junction section, no train stands at a stem or foot signal longer than `STALL`.
- `test_ui` / `test_camera`: labels and status words; `followCandidates` ignores trains on the stem
  without breaking; the camera follows a train up the stem without a jump (head point continuous).
- Visual: screenshots of a north junction, a south junction and a terminus seed, day and night; a
  pushing train with the headlight at the leading car end.

## Rulings made without the user

- One wye per terminal, in a gap, never a margin; north on Main 1, south on Main 2; 60 % of seeds.
- No signals inside the junction gap (atomic routes through it) and a gap-wide wrong-main exemption,
  after the builder check showed that an intermediate signal at the feet deadlocks a branch-bound train
  against a branch arrival, that signals on switch nodes break the trunk lock, and that the south wye's
  moves use the one-cell Main 2 piece inside a pair.
- Terminus shunt signals are route-transparent dwarfs at the feet; the points may move for the standing
  train that reads them.
- Destinations and exits are filtered by reachability (computed once per layout), the exit coin is
  always drawn.
- Wye gaps carry two crossover pairs so every move at the junction is at most a few cells wrong main,
  and those cells are exempt from the one-wrong-main rule.
- The branch (Keddie) is single track with one direction of flow at a time; its signals are "either
  direction" (`dir 0`) and its arrivals pick east or west by a fair coin.
- Total traffic is shared across three portals, not increased.
- The terminus is a single 7-cell stub platform, vertical, directly off the apex; pull-ahead runs are
  7 cells so the longest passenger train clears the foot; pushing is 15 mph; terminus dwell 10 min.
- A terminus train leaves toward the portal it arrived from (the Tampa story), by the other leg.
- The trunk rule becomes "negative dot product with both other edges"; on the apex tie the west leg is
  `normal`.
- (2026-11-01/02, Tasks 6–8; details in the amendment notes above.) The terminus gap is 36 columns, symmetric
  about the apex. Shunt signals take an `s` suffix. A junction stem is at least four cells. The terminus needs five
  operator rules against wedges, and Task 7 made five accepted deviations. An un-entered route owns its switches,
  and a shunt route with no train at its signal is dead after GRACE. On the panel: the tag rides the loco, a
  train's ends crossfade at a reversal, the stub's box lies on the right of departure travel, its name reads bottom
  to top, the buffer stop is a bar, shunt dwarfs stand back from the points, and the follow caption is read every
  frame.
