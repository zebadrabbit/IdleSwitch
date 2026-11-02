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
- **Rows.** A north wye needs `T ≥ 4` (apex at row 2, stem rows 2..0) and the terminus's stub needs
  `T ≥ 10`; the generator pads `T` up to the need (empty rows above the top tracks). A south wye pads
  `rows` likewise. Place names stay at `y = −1`; the branch portal's name sits beside the portal.
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

**Rendering a pushing train.** `trainBlocks` returns the loco block at the head unless `locoAtTail`, in
which case the loco is the last block; the headlight goes at the leading end (the path head) in both
cases and the tail marker at the trailing end. The tag stays with the loco.

## Rendering and panels

- **Signal placement** from the signal's facing: `facing` = unit vector from `from`'s far node to the
  signal node (portal signals: into the panel). Heads sit at `node + right(facing) × offset` with
  `right(v) = (−v.y, v.x)` in screen coordinates (y down): east → +y, west → −y, south-facing (travelling
  down) → −x, north-facing → +x. Two-head stacking continues outward along `right`. The chevron points
  along `facing`. The pick radius is unchanged.
- **Tags** sit on the right of travel of the head block (same `right()`), 10 px off; the existing above /
  below rule is this rule for horizontal travel.
- **Track labels and platform boxes** follow the track's first-to-last node segment: horizontal as today;
  vertical tracks (the stub) draw the box rotated along the edge and the name reading upward beside it,
  on the right of travel of its exit direction. The branch portal's `to <name>` label sits beside the
  portal node on the right of entering travel, with the queue count under it.
- **Legs and stem** draw as track (`wye` and `branch` are track classes; `COLORS` unchanged). The
  junction section gets no special colour.
- **Signal labels**: `${E|W|N|S}${x}${row letter}${d?}` with the letter from `facing` (dominant axis;
  diagonals never carry signals).
- **Board**: From → To from the train's entry and exit portals; status words `backing in` and
  `reversing`. Inspector: `Direction` reads `eastbound to <exit portal>` / `westbound …` / for a `dir 0`
  head position on the stem the same with its dir; `Signal ahead` uses `signalAhead`.
- **Legend**: a `wye / branch` line under Track. README "What's on the panel" gains two short
  paragraphs (junction; terminus).
- **Camera**: `followCandidates` and `signalCandidates` are unchanged (main rows only); a follow shot
  continues up the stem since it tracks the head point. The caption's `eastbound to <portal>` uses
  `train.exit`.

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
