# Bidirectional mains and crossovers

Amends `2026-10-31-idleswitch-design.md`. Where the two disagree, this document wins.

## Intent

Today each main runs one way and a train blocked by a standing train ahead waits. The user picked
"bidirectional mains and crossovers" as the next thing to build: both mains signalled in both
directions, crossover pairs between them, and the operator allowed to run a train on the other main
("wrong main") to get round a train standing on its own. The payoff is visual: trains overtaking on the
main, crossing over and back, meets held at the crossovers, the panel showing traffic direction on each
stretch of main. It stays a screensaver with things to do: no reversing, no score, no gridlock, ever.

## Goals

- A train can be routed onto, along, and back off the other main through crossover pairs.
- The virtual operator uses this to pass a train that has stood on the main for a while, and returns to
  the home main at the first chance.
- A human can line the same moves by NX; the interlocking refuses anything that could meet head-on or
  wedge the line, with the usual red refusal flash.
- Same seed, same layout, same day. Every existing invariant (no double occupancy, no passed red, no
  stall in the soak) still holds, plus: no two opposing trains in one main section, and at most one
  wrong-main train at a time.

## Non-goals

- Reversing, stub spurs, trains changing direction. A train still runs one way, portal to portal.
- Universal (diamond) crossovers. The grid forbids crossings; a pair of single crossovers does the job.
- Per-block traffic levers on the HUD. Traffic direction shows through route colour and occupancy, as
  today.

## Layout

The mains move to the middle and the module tracks flank them, as on a real panel:

```
row 0 .. T-1   westbound tracks (platforms, yard, sidings, spurs) of each module, nearest Main 1 lowest
row T          Main 1   home main of westbound (dir -1), signalled both ways
row T+1        empty    (room for the inner signals and the crossover diagonals)
row T+2        Main 2   home main of eastbound (dir +1), signalled both ways
row T+3 ..     eastbound tracks of each module, nearest Main 2 highest
```

`T = max top-side track count`, `rows = T + 3 + max bottom-side count`. Place names sit at row -1.
Ladders leave Main 1 upward (dy -1) and Main 2 downward (dy +1); otherwise modules are as today.

**Crossover pair.** In every gap between modules and in both end margins, two single crossovers in
sequence, six columns wide, with `a` the pair's first column:

```
A: Main 1 (a)   -> Main 2 (a+2)   slope +1   eastbound Main 1->Main 2, westbound Main 2->Main 1
B: Main 2 (a+3) -> Main 1 (a+5)   slope -1   eastbound Main 2->Main 1, westbound Main 1->Main 2
```

Each crossover is one 45° edge of length 2√2 (class `crossover`, speed 30, both dirs), so every
direction has exactly one way across in each pair. `MARGIN = 8`, `GAP = 9` (portal/exit signal, pair,
entry signal). Switches stay 3-edge nodes found by the existing rule.

**Edges.** Main edges: `dirs [1, -1]`, `main` = the direction whose home main it is (-1 on row T, +1 on
row T+2), `section` = an integer; sections split at every switch node along the row (crossover and
ladder nodes), so a section is the stretch of one main between two sets of points. Crossover edges have
`main: null, section: null`. Other edges unchanged.

**Signals.** At each module boundary column (`x0-1`, `x1+1`) four signals: both directions on both
mains, all `high`. The two entry portal signals as today. Track exit signals as today. Nothing else.

**Portals.** Entry portals unchanged (eastbound enters Main 2 at x=0, westbound enters Main 1 at
x=cols-1). A train exits at the far end on *either* main: both rows continue off-panel as the two-track
main. `layout.mainRow = { 1: T+2, -1: T }`.

## Interlocking

Everything from the first spec stands (edge occupancy and route locks, trunk-edge switch lock, one
un-entered route per signal, sectional release, aspects). Two rules are added to `setRoute`, checked
after the existing ones, in this order:

1. **Opposing traffic** (`'opposing'`). A route whose edges lie in sections S₁..Sₖ is refused if any
   edge of any of those sections is occupied by a train of the other direction or locked by a route from
   a signal of the other direction. This is traffic locking: it stops two trains being lined toward each
   other, including toward the same signal node from both sides (which would otherwise stand nose to
   nose for good).
2. **Wrong main in use** (`'wrong main'`). A candidate is *wrong main* when its last main edge has
   `main === -dir`. Such a route is refused if any train other than the one at this signal is currently
   wrong main (occupies or has routed any main edge with `main === -its dir`). One wrong-main train at a
   time, terminal-wide. With the home main always flowing in its own direction and both rows open at the
   far end, that one train can always get home or out, so the line cannot wedge. The train standing at
   or routed to the signal (its path ends at the signal's node) is exempt so it can continue or return.

Both apply to human routes. `routesFrom` candidates gain `wrongMain`.

## The operator

- `findPath` costs: a `crossover` edge costs its length +1 like a ladder; a main edge with
  `main === -dir` costs +3 (`WRONG_MAIN_COST`), so a train returns home at the first pair that is free; an
  edge blocked by a route or by a *moving* train costs +10 (`MOVING_COST`); an edge occupied by a train
  that has stood at least `PASS_WAIT = 60` s costs +60 (`STANDING_COST`). The detour round one module
  costs roughly 20-30, so a train diverts round a standing train, never round a moving one, and not
  round one two modules ahead.
- Goal `{ exit: true }` is reached at either far-end node of the train's direction (`exitNodes(sim,
  dir)`); `{ node }` and `{ track }` stay for tests and holds.
- The "never into a track that isn't its destination" rule stands; wrong-main candidates are allowed.
- The `AUTO:` log line and the train's `route` event carry `(wrong main)` / `wrongMain: true` when the
  candidate is. Board status appends ` · wrong main` while the train is.
- Scheduled time (`newEntry`) uses the home main's length (`edge.main === dir`), not every main edge.

## Rendering and panels

- Padlock side: above for switches at or above Main 1, below otherwise. `exit to <place>` for either
  far-end node. Signal labels become unique: `E12C`, `W41Ad` — direction letter, column, row letter
  (`A` = row 0), `d` for dwarfs.
- Legend gains `crossover` nowhere special: it is track. README "What's on the panel" describes the
  pair and wrong-main running in two sentences.

## Tests

- `test_gen`: existing invariants (no diamond, no overlap, ≤3 edges, switches, determinism, every
  track reachable from its portal) plus: every main edge has `dirs [1,-1]`, `main` and `section`;
  sections are contiguous runs split exactly at switch nodes; every gap and both margins contain one pair
  with the geometry above; four high signals per boundary column; `mainRow` matches the portals; from
  each portal the far end of *both* rows is reachable.
- `test_sim`: `'opposing'` and `'wrong main'` refusals with hand-set occupancy and routes; a nose-to-nose
  line at one signal node is refused; the exempt train may continue; `exitNodes` and `{exit}` goal;
  `findPath` prefers straight past a moving train and diverts round a standing one; `signalLabel`
  uniqueness over 50 seeds; the soak (8 sim-hours busy, four seeds) adds every step: no section holds
  trains of both directions, at most one wrong-main train, and asserts that at least one wrong-main run
  happened over the four seeds so the feature is proven live, not dormant.

## Rulings made without the user (they said "use your judgment")

- Mains in the middle with an empty row between (not the old top/bottom rows): crossovers become
  one short diagonal and the inner signals have room. Costs a wider terminal: worst case about 25
  columns more than today; four-module seeds want 1600 px or fullscreen.
- One wrong-main train at a time rather than per-section traffic levers: provably deadlock-free in a
  paragraph; the alternative needs lookahead. Revisit if the panel feels too tame.
- Only standing trains get passed (60 s), by any train regardless of priority.
- Both rows exit at both ends (a two-track main beyond the terminal). An exiting wrong-main train runs
  through the opposite direction's entry node; the spawn gate already waits for a free portal edge.
- Signal labels gain a row letter; the old `W41` style collided between two tracks on one side anyway.
