# Bidirectional Mains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both mains signalled both ways with crossover pairs, traffic locking that makes head-on meets and wedges impossible, and an operator that passes standing trains on the other main.

**Architecture:** The generator moves the mains to the middle rows with the module tracks outside them, adds a six-column crossover pair in every gap and margin, and tags main edges with their home direction and section. The sim adds two `setRoute` refusals (opposing traffic in a section, a second wrong-main train) and teaches `findPath` the costs that make the operator divert only round standing trains. Renderer and panels need a few lines; tests carry the invariants.

**Tech Stack:** Vanilla ES modules, Canvas 2D, node `assert` tests. No dependencies, no build.

**Spec:** `docs/superpowers/specs/2026-11-01-bidirectional-mains-design.md` (amends `docs/superpowers/specs/2026-10-31-idleswitch-design.md`).

## Global Constraints

- Pure modules (`gen.js`, `sim.js`, `ui-util.js`) never touch window, document, Math.random or Date.
- Same seed, same layout, same day: `JSON.stringify(generate(seed))` is stable, and the sim draws only from `sim.rng`.
- Grid: horizontal runs and 45° diagonals only, no crossings, nodes have at most 3 edges, ids are array indices.
- Travel direction is decided by x alone; edge `dirs` must allow it. No reversing.
- Switch lock = trunk edge occupied or routed. One un-entered route per signal. Sectional release.
- Constants exactly as the spec: `MARGIN = 8`, `GAP = 9`, pair geometry `A: M1(a)->M2(a+2)`, `B: M2(a+3)->M1(a+5)`, `CLASS_SPEED.crossover = 30`, `WRONG_MAIN_COST = 3`, `MOVING_COST = 10`, `STANDING_COST = 60`, `PASS_WAIT = 60`.
- `./manage.sh test` must exit 0 with `gen ok`, `sim core ok`, `aspects ok`, `trains ok`, `traffic ok`, `ui ok` after every task.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A human lines two routes toward the same boundary signal node from both sides: the second is refused `'opposing'`, never two trains nose to nose. (Task 2)
2. A human lines a wrong-main route while another train is already wrong main: refused `'wrong main'`; the wrong-main train itself may still line its way home. (Task 2)
3. A wrong-main train whose home main never frees still reaches the far end and leaves on the wrong row, while a queued train of the other direction waits at that node and enters afterwards without ever sharing an edge. (Task 3)
4. A human wrong-main route with no train coming must not hold the opposing sections forever: the operator clears it after the grace period like other dead routes. (Task 3)
5. Two signals at one column on different rows, or two tracks on one side, must not share a label in the log or inspector. (Task 2)

---

### Task 1: Generator — mains in the middle, crossover pairs, edge tags

**Files:**
- Modify: `src/gen.js`
- Test: `tests/test_gen.mjs`

**Interfaces:**
- Produces: `Layout` as before plus `layout.mainRow = { 1: T+2, '-1': T }`; main edges `{ cls: 'main', dirs: [1, -1], main: 1 | -1, section: number }`; crossover edges `{ cls: 'crossover', dirs: [1, -1], main: null, section: null, len: 2 * Math.SQRT2 }`; all other edges `main: null, section: null`. `CLASS_SPEED.crossover === 30`. Four `high` signals per module boundary column (`x0-1`, `x1+1`): dirs ±1 on both main rows. `places[].y === -1`. Portals unchanged in meaning: eastbound entry `(0, T+2)`, westbound entry `(cols-1, T)`.

- [ ] **Step 1: Rewrite the geometry assertions in `tests/test_gen.mjs`**

Replace the portal assertion with `[[0, L.mainRow[1], 1], [L.cols - 1, L.mainRow[-1], -1]]` and the `exitPortal` map with the far-end nodes of both rows per direction (reachability: from each portal, following dirs, both far-end nodes of its direction are reachable). Add, inside the seed loop:

```js
const T = L.mainRow[-1]; assert.equal(L.mainRow[1], T + 2);
const mains = L.edges.filter(e => e.cls === 'main'), cross = L.edges.filter(e => e.cls === 'crossover');
for (const e of mains) { const y = L.nodes[e.a].y; assert.equal(y, L.nodes[e.b].y); assert.equal(e.main, y === T ? -1 : 1); assert.deepEqual(e.dirs, [1, -1]); assert.equal(typeof e.section, 'number'); }
for (const e of L.edges) if (e.cls !== 'main') assert.equal(e.main, null), assert.equal(e.section, null);
for (const e of cross) { assert.deepEqual(e.dirs, [1, -1]); assert.equal(Math.abs(L.nodes[e.a].x - L.nodes[e.b].x), 2); assert.deepEqual([L.nodes[e.a].y, L.nodes[e.b].y].sort(byNum), [T, T + 2]); assert.equal(e.speed, 30); }
// a section is a contiguous run on one row that splits exactly at switch nodes
const swNodes = new Set(L.switches.map(s => s.node));
for (const p of mains) for (const q of mains) if (p !== q && (p.b === q.a || p.a === q.b || p.a === q.a || p.b === q.b)) {
  const shared = [p.a, p.b].find(n => n === q.a || n === q.b);
  assert.equal(p.section === q.section, !swNodes.has(shared), `${seed}: section split at node ${shared}`);
}
// one pair per gap and margin, A then B
const gaps = [[0, L.modules[0].x0], ...L.modules.slice(1).map((m, i) => [L.modules[i].x1, m.x0]), [L.modules.at(-1).x1, L.cols - 1]];
assert.equal(cross.length, 2 * gaps.length);
for (const [lo, hi] of gaps) {
  const inGap = cross.filter(e => L.nodes[e.a].x > lo && L.nodes[e.b].x > lo && L.nodes[e.a].x < hi && L.nodes[e.b].x < hi).sort((e, f) => Math.min(L.nodes[e.a].x, L.nodes[e.b].x) - Math.min(L.nodes[f.a].x, L.nodes[f.b].x));
  assert.equal(inGap.length, 2);
  const west = e => L.nodes[L.nodes[e.a].x < L.nodes[e.b].x ? e.a : e.b], east = e => L.nodes[L.nodes[e.a].x < L.nodes[e.b].x ? e.b : e.a];
  assert.deepEqual([west(inGap[0]).y, east(inGap[0]).y, west(inGap[1]).y, east(inGap[1]).y], [T, T + 2, T + 2, T]);
  assert.equal(west(inGap[1]).x, west(inGap[0]).x + 3);
}
for (const m of L.modules) for (const x of [m.x0 - 1, m.x1 + 1]) for (const y of [T, T + 2]) for (const d of [1, -1])
  assert.ok(L.signals.some(s => s.kind === 'high' && s.dir === d && L.nodes[s.node].x === x && L.nodes[s.node].y === y), `${seed}: signal ${d} at ${x},${y}`);
for (const p of L.places) assert.equal(p.y, -1);
```

Keep every existing invariant (degree, geometry, no diamond, no overlap, no node inside an edge, switches, track signals, capacity, determinism). The track signal assertions still hold: a track's exit signal is one cell before its exit node.

- [ ] **Step 2: Run `node tests/test_gen.mjs`** — expect failure on `mainRow`.

- [ ] **Step 3: Implement in `src/gen.js`**

`MARGIN = 8`, `GAP = 9`, `CLASS_SPEED.crossover = 30`. `T = max top count`, `R2 = T + 2`, `rows = R2 + 1 + max bottom count`. `edge(a, b, cls, dirs, track, extra)` spreads `extra` (`main`, `section`) with defaults null. Mains: node columns `xs` = `[0, cols-1]`, every module's `x0-1, x0, x1, x1+1`, and every pair's `a, a+2, a+3, a+5` where `a = 1` for the west margin, `a = prev.x1 + 2` between modules and after the last; main edges on rows `T` (`main: -1`) and `R2` (`main: 1`) with `dirs [1, -1]`; crossovers `A: (a,T)->(a+2,R2)`, `B: (a+3,R2)->(a+5,T)`. Ladders: top side from `(x1, T)` stepping `(-1,-1)` (entry) and `(x0, T)` stepping `(+1,-1)` (exit); bottom side from `(x0, R2)` stepping `(+1,+1)` and `(x1, R2)` stepping `(-1,+1)`. Signals: for each module, for `x in [x0-1, x1+1]`, `y in [T, R2]`, `d in [1, -1]`: `signal(node(x, y), d, 'high')`. Sections: after switches are found, walk each main row's edges sorted by x and assign `section` ids, incrementing when the shared node is a switch (ids unique across both rows). Return `mainRow: { 1: R2, '-1': T }`. Update the file's header comment and the "no crossovers" ponytail note.

- [ ] **Step 4: Run `node tests/test_gen.mjs`** — expect `gen ok 206`. Other suites will fail until Task 2; that is expected.

- [ ] **Step 5: Commit** — `feat(gen): mains in the middle, crossover pairs, bidirectional main edges with home main and section`

---

### Task 2: Interlocking — exits on both rows, opposing and wrong-main refusals, labels

**Files:**
- Modify: `src/sim.js`, `src/panels.js:3,23`, `tests/test_sim.mjs` (Task 3–5 sections)

**Interfaces:**
- Consumes: Task 1's `edge.main`, `edge.section`, `layout.mainRow`.
- Produces: `exitNodes(sim, dir) -> [nodeId, nodeId]` (both rows at the far end; `exitPortalNode` removed); `isWrongMain(sim, train) -> boolean` (any edge in `train.path` has `main === -train.dir`); `wrongMainTrains(sim) -> Train[]`; `sim.sectionEdges: Map<section, edgeId[]>`; candidates gain `wrongMain: boolean` (last edge with `main !== null` has `main === -dir`; false if none); `setRoute` reasons, in order after the existing five: `'opposing'`, `'wrong main'`; `findPath(sim, from, dir, goal, penalty)` where `goal.exit === true` is reached at any of `exitNodes(sim, dir)`, and `penalty` takes `trainId`, `blockedCost` (edges locked by another route or occupied by a train that moved within `PASS_WAIT`), `standingCost` (occupied by a train with `sim.time - lastMoveTime >= PASS_WAIT`, or by an id that is not a live train), `wrongMainCost` (per main edge with `main === -dir`); an omitted cost means impassable for its class except `wrongMainCost`, which defaults to 0. `export const PASS_WAIT = 60`. `signalLabel` → `` `${E|W}${x}${String.fromCharCode(65 + y)}${d?}` ``.

- [ ] **Step 1: Update the Task 3–5 test sections for the new geometry**

Replace `exitPortalNode` uses with `exitNodes`; the fresh-sim checks become: `exitNodes(sim, E)` are `(cols-1, mainRow[1])` and `(cols-1, mainRow[-1])`, likewise W at x=0; `forwardEdges(sim, n, d)` is empty at each exit node of d; the old "mains are one-way" assertion becomes `forwardEdges(sim, exitNode, -d).length === 1` (the main runs both ways). Candidate checks: a candidate with `exitSignal === null` ends at one of `exitNodes(S, sig.dir)`. Chain tests use `exitNodes(...).includes(...)`. Where a test picked "the straight candidate" with `!k.diverging && !k.slow`, keep it; every main signal now also has a diverging crossover candidate. `signalLabel` tests: `W${cols-1}${letter}` and `E0${letter}` with the row letter, dwarf `...d`.

- [ ] **Step 2: Add the new tests (Task 3 section, after setRoute)**

```js
// opposing: a westbound occupying an edge of a section refuses an eastbound route into that section, and vice versa
{ const S = createSim(L, 'opp'), G = S.layout;
  const sigE = G.signals.find(s => s.dir === E && G.nodes[s.node].y === G.mainRow[-1] && S.routesFrom.get(s.id).some(c => !c.diverging));
  const c = S.routesFrom.get(sigE.id).find(k => !k.diverging), sec = G.edges[c.edges[0]].section;
  const other = S.sectionEdges.get(sec).find(e => !c.edges.includes(e)) ?? c.edges.at(-1);
  const w = spawnTrain(S, { type: 'M', dir: W }); S.edgeState[other].occ.add(w.id);
  assert.equal(setRoute(S, sigE.id, c.exitNode).reason, 'opposing');
  S.edgeState[other].occ.clear();
  assert.equal(setRoute(S, sigE.id, c.exitNode).ok, true); }
// nose to nose: routes toward one boundary node from both sides; the second is refused
{ const S = createSim(L, 'nose'), G = S.layout, T = G.mainRow[-1];
  const node = G.signals.find(s => G.nodes[s.node].y === T && G.signals.filter(o => o.node === s.node).length === 2).node;
  const into = d => [...S.routesFrom].flatMap(([id, cs]) => cs.filter(c => c.exitNode === node && G.signals[id].dir === d).map(c => ({ id, c })))[0];
  const a = into(E), b = into(W);
  assert.equal(setRoute(S, a.id, a.c.exitNode).ok, true);
  assert.equal(setRoute(S, b.id, b.c.exitNode).reason, 'opposing'); }
// wrong main: only one train at a time; the train at the signal is exempt
{ const S = createSim(L, 'wm'), G = S.layout;
  const [sigA, sigB] = G.signals.filter(s => S.routesFrom.get(s.id).some(c => c.wrongMain));
  const cA = S.routesFrom.get(sigA.id).find(c => c.wrongMain), cB = S.routesFrom.get(sigB.id).find(c => c.wrongMain);
  const t = spawnTrain(S, { type: 'M', dir: sigA.dir }); t.path = [...cA.edges]; // standing on the wrong main
  assert.equal(isWrongMain(S, t), true); assert.deepEqual(wrongMainTrains(S), [t]);
  assert.equal(setRoute(S, sigB.id, cB.exitNode).reason, 'wrong main');
  const next = S.signalAt.get(`${headNode(S, t)}:${t.dir}`), cN = S.routesFrom.get(next).find(c => c.wrongMain);
  if (cN) assert.equal(setRoute(S, next, cN.exitNode, { trainId: t.id }).ok, true, 'the wrong-main train may continue'); }
// signalLabel unique over 50 seeds
for (let i = 0; i < 50; i++) { const S = createSim(generate(`lab${i}`), 'x'); const ls = S.layout.signals.map(s => signalLabel(S, s.id)); assert.equal(new Set(ls).size, ls.length, `lab${i}`); }
```

And in the findPath section: `{ exit: true }` from each portal returns a path ending at one of `exitNodes`; with `wrongMainCost: 3` the path from the westbound portal never uses a `main === E` edge when the home main is clear; with the home main's first section occupied by a train whose `lastMoveTime = S.time - 60` and `standingCost: 60, blockedCost: 10, wrongMainCost: 3`, the path crosses over (contains a `crossover` edge); with `lastMoveTime = S.time` it does not.

- [ ] **Step 3: Run `node tests/test_sim.mjs`** — expect failures at `exitNodes`.

- [ ] **Step 4: Implement in `src/sim.js`**

`createSim`: build `sim.sectionEdges`. `exitNodes`: both nodes at `x = dir > 0 ? cols-1 : 0` on rows `mainRow[1]` and `mainRow[-1]`. `candidate`: add `wrongMain`. `setRoute`: after `'switch busy'`, `opposing(sim, cand, dir)` (any edge of any section touched by the candidate occupied by a train with `dir !== sig.dir` or locked by a route whose signal has the other dir) → `'opposing'`; then if `cand.wrongMain` and `wrongMainTrains(sim).some(t => t.id !== trainId && headNode(sim, t) !== sig.node)` → `'wrong main'`. `findPath`: cost classes above; `goal.exit`. `headNode`/`moveTrains` `runOff`: `exitNodes(...).includes(headNode)`. `spawnTrain` goal `{ exit: true }`; `missions` and `operator` give-up use the same. `newEntry` mainLen sums `e.main === dir`. `despawnTrain` portal name unchanged (the far end's place). `signalLabel` with row letter. Replace `exitPortalNode` in `src/panels.js` `exitLabel`: `for (const d of [1,-1]) if (exitNodes(sim, d).includes(c.exitNode)) ...`.

- [ ] **Step 5: Run `./manage.sh test`** — expect all six `ok` lines (the Task 6 section may need `exitNodes` substitutions too; make them).

- [ ] **Step 6: Commit** — `feat(sim): exits on both rows; opposing-traffic and wrong-main refusals; unique signal labels`

---

### Task 3: Operator — passing on the wrong main, dead wrong-main routes, soak invariants

**Files:**
- Modify: `src/sim.js` (operator, deadRoute, logging), `src/panels.js:37-42` (`trainStatus`)
- Test: `tests/test_sim.mjs` (Task 6 section)

**Interfaces:**
- Consumes: Task 2's `findPath` penalties, `wrongMain` candidates, `isWrongMain`, `exitNodes`.
- Produces: exported `WRONG_MAIN_COST = 3`, `MOVING_COST = 10`, `STANDING_COST = 60`; `trainStatus(t, sim)` appends `' · wrong main'` when `isWrongMain(sim, t)` (signature gains `sim`; update its callers in `panels.js`).

- [ ] **Step 1: Write the tests (Task 6 section)**

```js
// passing: a train standing 60 s on the home main is passed on the other main; a moving one is followed
{ const S = busySim('pass'); /* spawn M eastbound, give it the first two routes by hand, let it stand (set state 'stopped', lastMoveTime = S.time - 60);
  spawn X eastbound behind; step until X has a route; assert X's path includes a crossover edge and S.log has an 'AUTO: ... (wrong main)' line;
  then repeat with the M moving (lastMoveTime = S.time) and assert X's first route is not wrongMain */ }
// exit on the wrong row: the home main held for good, the wrong-main train still leaves; the opposing queued train enters after
{ /* occupy the home main's last section with a foreign id; run; assert the train despawns (sim.completed grows) and no edge ever had occ.size > 1 */ }
// dead wrong-main human route: lined with no train of its direction at the signal, cleared after GRACE (180 s), logged 'AUTO: cleared route'
// trainStatus appends ' · wrong main'
```

Spell each out as real assertions (the comments are the shape). In the soak loop add per step:

```js
for (const [sec, es] of S.sectionEdges) { const dirs = new Set(es.flatMap(e => [...S.edgeState[e].occ].map(id => S.trains.get(id)?.dir))); dirs.delete(undefined); assert.ok(dirs.size <= 1, `${seed}: opposing trains in section ${sec}`); }
assert.ok(wrongMainTrains(S).length <= 1, `${seed}: two wrong-main trains`);
if (wrongMainTrains(S).length) sawWrongMain = true;
```

and after the four seeds `assert.ok(sawWrongMain, 'no wrong-main run in 32 busy hours: the feature is dormant')`.

- [ ] **Step 2: Run** — expect failures.

- [ ] **Step 3: Implement**

`operator`: `findPath(sim, node, t.dir, t.goal, { trainId: t.id, blockedCost: MOVING_COST, standingCost: STANDING_COST, wrongMainCost: WRONG_MAIN_COST })`; log `AUTO: ${label} → ${t.name}${cand.wrongMain ? ' (wrong main)' : ''}`; the adopt `route` event gains `wrongMain: true` when the route's candidate is. `deadRoute`: a human route is also dead when `r.cand.wrongMain` (or its signal stands on the row `mainRow[-dir]`) and no train of its direction has `headNode === signal node`, after `GRACE`. Everything else in the operator (holds, starvation rank, give-up, never-into-a-track) stands. If the soak stalls on a seed, first suspect the opposing rule blocking a train whose own section is shared with a standing opposite train at a boundary node; the escape hatch is `STANDING_COST` below the detour cost, which makes the feature dormant and fails the `sawWrongMain` assertion on purpose.

- [ ] **Step 4: Run `./manage.sh test`** — all six `ok`. Also run a 4-hour probe on `s7`, `s42`, `s100` at `normal` density and report worst delay and wrong-main count in the report.

- [ ] **Step 5: Commit** — `feat(sim): the operator passes standing trains on the other main; dead wrong-main routes cleared`

---

### Task 4: Renderer, panels, docs

**Files:**
- Modify: `src/render.js` (padlock side, portal label clearance), `src/panels.js` (legend/help copy if needed), `README.md`, `docs/superpowers/specs/2026-10-31-idleswitch-design.md` (one line under Amendments pointing at the new spec)
- Test: `tests/test_ui.mjs` (unchanged unless a pure helper moves)

- [ ] **Step 1: Renderer** — padlock `up = n.y <= L.mainRow[-1] ? -1 : 1`; the east-end portal label sits above Main 1 and the west-end below Main 2 as before (check it clears the crossover pair and the inner signals at zoom 0.5); remove the `R` variable if unused.
- [ ] **Step 2: README** — in "What's on the panel": two sentences on the mains being signalled both ways, the crossover pairs, and wrong-main running with its one-at-a-time rule; add `'opposing'`/`'wrong main'` to the refusal reasons if they are listed; signal label format.
- [ ] **Step 3: Old spec** — under "Amendments made during the build" add: "2026-11-01: directional mains replaced by bidirectional mains with crossover pairs; see `2026-11-01-bidirectional-mains-design.md`."
- [ ] **Step 4: Screenshot** — `./manage.sh start`, then headless Chromium at 1920×1080 on `?seed=s42&ff=3600` and `?seed=lebanon&ff=1800`, saved to the plan workspace; look for overlapping inner signals, labels over the pair, padlocks on the wrong side. Fix what you see.
- [ ] **Step 5: `./manage.sh test`** — all six `ok`. Commit — `feat(ui): panel copy and padlocks for bidirectional mains`.
