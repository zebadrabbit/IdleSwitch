# Industrial Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dead-end industry trackage: a seeded fan of two or three stubs off a 45° lead in its own gap, single stubs off some yard spurs, standing cuts of cars on them, and trains that pull past, shove in, set out, pick up and leave loaded or light.

**Architecture:** The generator grows the fan gap and the spur stub on a new `:industrial` rng stream behind a test knob that proves every other layout byte-identical. The sim gains per-train `cars`, a `sim.cuts` map, a stop-point rule that makes a cut a wall, stub traffic items, and a `train.shunt` stage machine driven from `missions()` the way the terminus is, reusing `reverse()`, shunt signals and the pull-ahead arithmetic unchanged. The renderer draws stubs, buffers and cuts; panels gain two status words. Pure modules stay pure.

**Tech Stack:** Vanilla ES modules, Canvas 2D; `node:assert` tests via `./manage.sh test` and CI.

**Spec:** `docs/superpowers/specs/2026-11-03-industrial-branch-design.md` (binding; read the sections named in each task). It amends `2026-11-02-wyes-design.md`, whose "Phase 2" and "Interlocking additions" sections are the mechanics this builds on.

## Global Constraints

- Pure modules (`gen.js`, `sim.js`, `camera.js`, `ui-util.js`, `rng.js`) never touch window/document/Math.random/Date/performance.
- Same seed, same layout, same day at the same density and day length. **Layouts without a fan or a spur stub are unchanged byte for byte** and their traffic is unchanged: all industrial draws come from `makeRng(seed + ':industrial')` (generator) and `makeRng(seed + ':cuts')` (sim), never from the main streams; `generate(seed, { industrial: false })` must equal the pre-feature generator on every seed (fixtures), and `generate(seed)` must equal it on every seed that draws no fan and no stub.
- No crossings, no diamonds, ≤ 3 edges per node, switches = exactly the 3-edge nodes, every edge horizontal, vertical or 45°.
- Existing soak invariants: no double occupancy, no passed red, no STALL, no section with trains of both main directions, at most one wrong-main train, queues ≤ `QUEUE_MAX`, every path chained from `pathStart`, a tail never off its path. New: one train in a fan at a time; no train's head past a cut's near end.
- No hard cuts on the panel: new drawing goes through the renderer's existing easing; a set-out or pick-up changes no pixel.
- Exact values from the spec: `FAN_P = 0.5`, `SPUR_STUB_P = 0.4`, `GAP_FAN = { 2: 33, 3: 34 }`, fan columns from `b`: `P = 8`, `X = 15`, east pair `17..22`, `Lt = 17`, `J = 20`, stub `i` ladder node at `20 + i` (row `T−2−i`), its signal one cell on, its buffer 7 further; spur stub: `Xs` 7 cells upstream of the exit signal, `Q` one 45° cell back and deeper, `Sq` one cell on, `Bq` 7 further; classes `lead` and `stub` speed 15, both slow, `stub` a dwarf-exit class; `CUT_MIN = 3`, `CUT_MAX = 8`; `DWELL.setOut = 180`, `DWELL.pickUp = 120`; loaded weight `3 × frt`, light `2 × frt`; valve at `2 × STARVE`; `PUSH_MPH` unchanged.
- Commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` after a blank line. `./manage.sh test` green before every commit. Ponytail: shortest diff that works; `// ponytail:` on deliberate ceilings. `style.css` untouched (no `?v=` bump needed) unless a task says otherwise.

## Review Focus

1. A human routes a **loaded** visitor from `X` into the **full** stub, or a light one into the empty one. Expected: it stops short of the cut (or at the buffer), nothing is set out or picked up, it reverses and runs out light/loaded as it came, no STALL. Test: Task 3 "adapts to a human route".
2. A visitor reverses at `P` while a train behind it at `b'` already holds a route to `P`'s signal. Expected: impossible (the route needs the run free); if `clearToReverse` ever sees another lock on the run, it waits. Test: Task 3 soak invariant (the terminus's "reversed with another train in section" check extended to visitors).
3. A wrong-main eastbound train (a passing move on Main 1) routed from `b` toward `P` while the visitor is up in the fan: allowed, and it stands at `P`'s eastbound signal on the run. The visitor's departure from `Lt` then needs the run and waits; the eastbound train's way on to `b'` is free, so it clears and the visitor follows. Expected: no deadlock, no STALL. Test: Task 3 "departure waits for a train at P".
4. A seed where the fan's gap is the only gap and a wye wants it. Expected: the wye wins (drawn first), the fan is not placed, the layout equals the no-industrial layout. Test: Task 1 "wye keeps its gap".
5. Window at overview zoom with a three-stub north fan and a module whose top side has two tracks: the fan's label, the module name and the stub names must not overlap the branch label of a north junction in another gap. Expected: labels on row `−1` only, readable. Test: Task 5 visual check, both seeds in the screenshot list.

---

### Task 1: Generator: the fan gap and the spur stub, byte-identical otherwise

**Files:**
- Modify: `src/gen.js`
- Modify: `tools/freeze-layouts.mjs` (pass `{ industrial: false }`; add `tests/fixtures/layouts-industrial.json` for the seeds below)
- Test: `tests/test_gen.mjs`

**Interfaces:**
- Produces: `generate(seed, opts = { industrial: true })`. `CLASS_SPEED.lead = 15`, `CLASS_SPEED.stub = 15`; `DWARF` and the sim's `SLOW_CLS` gain `'stub'` (the sim half in Task 2). Tracks of class `stub` are `{ id, cls: 'stub', dir: 0, name, stub: true, edges: [<ladder node–S>, <S–buffer>], capacity: 6.5, industry }`. `layout.fan = null | { side: 'north'|'south', gap, count, x0: b, x1: b', main: feetMain (-1 north, +1 south), P: <node>, X: <node>, Lt: <node>, J: <node>, stubs: [trackId...], shunt: { X: <signalId>, J: <signalId> }, leadSignal: <signalId at Lt>, name: '<Place> Industrial' }`. Spur stubs: `tracks[spur].stubOf = <stub track id>` and `tracks[stub].spur = <spur track id>`, with `layout.spurStubs = [{ spur, stub, Xs: <node>, shunt: <signalId> }]`. Every fan and spur-stub signal has `dir: 0`; `X`, `J`, `Xs` are `kind: 'shunt'`; `Lt` and each stub's exit signal are `kind: 'dwarf'`. The fan's lead, ladder and stub edges share one new section id; a spur stub's edges have `section` null like the spur's. `layout.places` gains the fan's label at `y: −1` over the fan's middle column.
- Consumes: the wye's gap and row bookkeeping in `generate` (`wye.gap`, `off`, `T`, `rows`, `wb`, `pairs`, `xs`, `mainIn`, `signal`, `edge`, `node`, `ladder`).

- [ ] **Step 1: Fixtures.** Before changing `gen.js`, confirm `node tools/freeze-layouts.mjs` reproduces `tests/fixtures/layouts.json` unchanged (`git status` clean). Then change the tool to call `generate(seed, { industrial: false })` and add a second output `tests/fixtures/layouts-industrial.json` from `generate(seed)` for seeds chosen in Step 4 (a north two-stub fan, a south three-stub fan, a seed with a spur stub on each side; the tool takes the list as a constant).
- [ ] **Step 2: Failing tests** in `test_gen.mjs`:
  - for every seed in the existing `seeds` list, `generate(seed, { industrial: false })` deep-equals `generate(seed)` whenever the latter has `fan === null` and no track has `stubOf`; and `layouts.json` fixtures match `generate(seed, { industrial: false })`;
  - over `s0..s199`: ≥ 50 seeds with a fan, both sides and both counts seen; ≥ 40 seeds with at least one spur stub, both sides seen; no seed with a fan in the wye's gap; a seed with two modules and a wye has no fan;
  - for every fan seed: the column table of spec "The fan (geometry)" holds exactly (assert node coordinates of `P`, `X`, `Lt`, `J`, each `Ki`, `Si`, `Bi`, both pairs' columns via the crossover edges in the gap, `b'`); `x0` of the next module is `x1 + GAP_FAN[count]`; `T ≥ count + 1` (north) / `rows − 1 − R2 ≥ count + 1` (south); every fan edge `oneWay === null`; the lead/ladder/stub edges share one section that no main edge has; the run `P–X` is one 7-cell main edge; `X`'s switch trunk is the run; signals at `P` both ways both mains; `X` and `J` are `shunt`, `Lt` and `Si` are `dwarf`, all `dir 0`; each stub has `stub: true`, `cls: 'stub'`, capacity `6.5`, a distinct industry key, a name distinct from every other track;
  - for every spur stub: `Xs` is 7 cells upstream of the spur's exit signal on the spur's row, the spur track's edges are now three with the signal's `from` the middle one and capacity unchanged from the no-industrial layout; `Q` is one row deeper and one column back; `Bq` is 9 columns back; no other node on the stub's row inside the module; the module's `x1 − x0 ≥ 2i + 17`;
  - the existing invariants loop (degree ≤ 3, no crossing, switch well-formedness, id = index, determinism) runs over the same seed list and now covers industrial layouts.
  Run: `node tests/test_gen.mjs` — FAIL (`generate` ignores `opts`, no `fan`).
- [ ] **Step 3: Implement** in `gen.js` per the spec: constants `FAN_P`, `SPUR_STUB_P`, `GAP_FAN`, `FAN_COLS = { P: 8, X: 15, pair: 17, Lt: 17, J: 20 }`; `const ir = makeRng(seed + ':industrial')` drawn **after** the wye's stream; `fan = opts.industrial !== false && ir() < FAN_P ? { side: ir() < 0.5 ? 'north' : 'south', gap: <randInt over gaps ≠ wye.gap, or null if none>, count: ir() < 0.5 ? 2 : 3 } : null`; then per spur in module order `ir() < SPUR_STUB_P`. Widen the fan's gap in the `mods.forEach` column pass; add the fan's `P` and `X` columns and both pairs to `xs`/`pairs`; pad `T`/`rows`; build nodes/edges/signals/tracks with the existing helpers (write the fan directly; `ladder()`'s one-way rule does not apply); mirror for south by `sx = −1`; insert `Xs` into `side()` for a stub spur (three edges) and build its stub; tag the fan section after the wye's. Industries: shuffle `INDUSTRIES` on `ir`, skip keys the terminal's spurs use.
- [ ] **Step 4: Pick the fixture seeds** (first of `s0..` meeting each description), put them in `tools/freeze-layouts.mjs`, run it, commit the new fixture, and add a test that `layouts-industrial.json` matches `generate(seed)` for those seeds.
- [ ] **Step 5: Run** `./manage.sh test` — all `ok` (`test_sim` still passes: it never sees a stub route yet because the sim treats `stub` tracks like the terminus's; if `candidates()` throws on the new classes, fix `candidate()`'s `slow`/`into` only as far as the test needs, nothing more).
- [ ] **Step 6: Commit** — `feat(gen): industrial fan gap and spur stubs on the :industrial stream`

---

### Task 2: Sim: `cars` per train, cuts, the cut as a wall

**Files:**
- Modify: `src/sim.js` (`TYPES`-dependent code: `trainLength`, `spawnTrain`, `newEntry`, `trainBlocks`, `moveTrains`, `createSim`), `src/panels.js:107` (`Length` row)
- Test: `tests/test_sim.mjs`, `tests/test_ui.mjs`

**Interfaces:**
- Produces: `trainLength(type, cars = TYPES[type].cars)`; `train.cars` (set in `spawnTrain` from the spawn args, default the type's); `trainBlocks` builds `n = train.cars` car blocks; `sim.cuts: Map<trackId, { track, type, cars }>`; `sim.cutRng = makeRng(seed + ':cuts')`; `cutLen(cut) = cut.cars * CAR`; `initialCuts(sim)` called at the end of `createSim` (every stub of a fan but one, chosen by `cutRng`, gets `{ type: industry.trainType, cars: randInt(cutRng, CUT_MIN, CUT_MAX) }`; each spur stub by `cutRng() < 0.5`); `export const CUT_MIN = 3, CUT_MAX = 8`; `SLOW_CLS` gains `'stub'` and `'lead'`; `stopDist(sim, train)` = the path's end less `FOUL`, less `cutLen` when the path's last edge belongs to a stub holding a cut, used by `moveTrains` for `remaining` (the only change to motion). `isLight(train) = train.cars === 0`. `panels.js` `Length`: `${t.cars} cars`, or `light engine` when 0.
- Consumes: Task 1's `stub` tracks and `layout.fan`.

- [ ] **Step 1: Failing tests** in `test_sim.mjs` (a fan seed `fN` from Task 1's picker, re-derived in the test the way `termSeed` is):
  - `trainLength('M', 5) === LOCO + 5 * CAR`; `spawnTrain(sim, { type: 'M', dir: W, cars: 0 }).len === LOCO` and its `trainBlocks` is one `loco` block; with `cars: 4` four car blocks;
  - `createSim` on `fN`: `sim.cuts.size === fan.count − 1`, every cut on a fan stub with `CUT_MIN ≤ cars ≤ CUT_MAX` and the stub's industry type; a second `createSim` gives the same cuts (determinism); on `lebanon`, `sim.cuts.size === 0` and `sim.rng` state is unaffected (the `run-s42.json` fixture test, now run on `generate('s42', { industrial: false })`, still passes);
  - the wall: hand-place a light engine at `J`'s shunt (as the terminus tests place a train at a foot) with a route into a full stub, step until stopped: `headDist` equals the path's length less `FOUL` less `cutLen` within `1e-6`, and the same route into the empty stub stops `FOUL` short of the buffer.
  Run: FAIL.
- [ ] **Step 2: Implement** the interfaces above; `trainBlocks`, `fits`, `newEntry` read `cars` from the train/entry, not `TYPES`; `panels.js` `Length` row.
- [ ] **Step 3: Run** `./manage.sh test` — all `ok`; `test_ui` gets one assertion: `inspectorHTML` for a `cars: 0` train contains `light engine`.
- [ ] **Step 4: Commit** — `feat(sim): cars per train, standing cuts, a cut stops a train short`

---

### Task 3: Sim: stub traffic, the fan visit, operator rules

**Files:**
- Modify: `src/sim.js` (`trafficMenu`, `newEntry`, `canEnter`, `spawnTrain`, `trackFree`, `missions`, `operator`, `trainBehind`, `hold`, `clearToReverse`, `DWELL`, log lines), `src/panels.js` (`status()`)
- Test: `tests/test_sim.mjs`, `tests/test_ui.mjs`

**Interfaces:**
- Produces: `DWELL.setOut = 180`, `DWELL.pickUp = 120`; menu items `{ type, cars, dest: stubId, weight, shunt: true }` (loaded: `cars` drawn `randInt(cutRng, CUT_MIN, CUT_MAX)`; light: `cars: 0`) for the fan's serving portal and dir only, present per spec "Traffic" (empty stub → loaded, full stub → light, none while the fan is busy or a `shunt` entry is queued); `fanOf(sim, trackId) -> layout.fan | null`; `trackFree(sim, trackId, forTrainId)` false for a fan stub while any fan track is occupied, routed or reserved by another train; `train.shunt = { kind: 'fan', stage: 'approach' | 'in' | 'setOut' | 'out' | 'pickUp' | 'depart', stand: <P node>, lead: <Lt node>, leadSignal, fan }` set by `spawnTrain` when the entry has `shunt`; `train.terminus`-style exemptions: `trainBehind` skips `t.shunt`, `hold()` returns false for it; `missions()` drives the stages per spec "The visit" using `reverse()`; `clearToReverse(sim, t, es)` unchanged, called with the run edge; reverse 1 additionally requires `wrongMainTrains(sim).every(u => u === t)`; `missShunt(sim, t)` logs `missed`, clears `dest`/`shunt`/reservation, `goal = { exit }`; the valve and the "past the stand" give-up in `operator()` next to the terminus's; log lines exactly as spec "Rendering and panels" lists them; `status()` returns `setting out` / `picking up` while dwelling in a stub by stage. `newEntry` returns `cars` and `shunt` from the menu item, draws `cars` for a loaded item from `cutRng`, and gives a visitor `exit = portalFor(sim, −dir)` whatever its exit coin said (the coin is still drawn); its `sched` allowance is `DWELL.setOut + DWELL.pickUp + 5 × 60` in place of the industry dwell. The fan's serving dir is `layout.fan.main` (the home dir of the main the lead leaves), its serving portal `portalFor(sim, fan.main)`; stubs have `dir 0`, so they are added to the menu by `layout.fan`, not through `mine`. `senseIn` for a non-main edge measures distance to **its own section's main row**: `createSim` builds `sim.sectionMain: Map<section, mainRow>` for the wye's branch section (`wye.feetMain`) and the fan's section (`fan.main`); the current `wye.feetMain` lookup crashes on a fan seed without a wye. "One in the offing" is per unit: no loaded or light item for a fan while any queue holds a `shunt` entry whose `dest` is one of that fan's stubs.
- Consumes: Task 2's `cars`, `cuts`, `cutLen`, `stopDist`; Task 1's `layout.fan`.

- [ ] **Step 1: Failing tests** in `test_sim.mjs` on `fN` (north) and a south fan seed `fS`:
  - **menu**: `trafficMenu(sim, W, eastPortal)` on `fN` has exactly one loaded item (`cars` in range, `dest` the empty stub) and one light item (`cars: 0`, `dest` a full stub) with `shunt: true`; `trafficMenu(sim, E, westPortal)` has none; after `sim.cuts.set(emptyStub, …)` the loaded item is gone; with every stub empty the light item is gone; while a `shunt` entry sits in any queue both are gone; `trackFree(sim, stub0)` is false while a train is reserved for `stub1`;
  - **loaded visit**, driven in AUTO at `density: 'light'` with the menu forced (push a loaded entry onto the east queue and empty the rest): the event kinds on the train appear in order `entered, route…, reversing, backing, arrived, setOut, reversing, route, reversing, backing, arrived, pickUp, reversing, route…, out`; at `setOut` the train's `len === LOCO` and `sim.cuts.get(dest).cars` equals the cars it came with; at `pickUp` `len` is `LOCO + cut.cars × CAR` and the cut is gone; the loco block's endpoints before and after the set-out step are equal within `1e-9` (call `trainBlocks` either side of the `missions` call: wrap `step` or compare the last-drawn block pair); it leaves by its original exit and `completed.at(-1).to` is the west portal's name; its tail never left the run reversed before `wrongMainTrains` was only itself;
  - **light visit**: `entered … reversing, backing, arrived, pickUp, reversing, route…, out`, no `setOut`;
  - **drop-only**: a loaded visit with the other stubs emptied first ends `setOut, reversing, route, …, out` with `cars === 0` at exit and the log line `departed <stub> light`;
  - **adapts to a human route**: a loaded visitor reversed at `P`, routed by hand (`setRoute(sim, shuntX, buffer of the full stub, { human: true })`): it stops at the cut, no `setOut` event, then reverses and its next route is to `Lt`, then out; a light one sent into the empty stub likewise picks nothing up;
  - **gate**: with another train made wrong main (the existing tests' way), a visitor stopped at `P` stays `stopped` (no `reversing` event) until that train is home, then reverses within 5 s;
  - **valve**: with the gate held for `2 × STARVE`, the visitor logs `missed`, keeps its cars and leaves west; the fan's reservation is dropped and the menu offers the fan again;
  - **past the stand**: a human route from `P` westward before reversal → `missed`;
  - **departure waits for a train at P**: with the visitor standing at `Lt` after its pick-up, hand-place an eastbound train on Main 1 at `P`'s eastbound signal (as the wrong-main tests place one); the operator's route for the visitor is refused until that train is routed on to `b'` and clear, then set within 5 s; no STALL;
  - **status words**: `trainStatus` reads `setting out` / `picking up` in the two dwells, `backing in` while pushing;
  - **soak**: add `fN`, `fS` and a three-stub seed to the soak list with the existing invariants plus: at most one train with any fan edge in its path or occupancy; for every train whose path ends in a full stub, `headDist ≤ stopDist + 1e-6`; visitors' reversals pass the "no other train in my sections" check (the terminus block, keyed on `T.shunt || T.terminus`); every visitor out within 40 min of entering; completed visitors from and to the correct portals; ≥ 3 visits completed per seed in 8 h; the `wrongTicks` ceiling holds.
  Run: FAIL.
- [ ] **Step 2: Implement** per spec "Traffic", "The visit" and "Interlocking additions and operator rules". Keep the stage machine in one function `shuntStep(sim, t)` called from `missions()` after the existing terminus clause; reuse `clearToReverse`, `reverse`, `logEvent`, `missBranch`'s shape. The operator's `findPath` goal for a visitor is `goal` as the stage sets it (`{ node: P }`, `{ track }`, `{ node: Lt }`, `{ exit }`); its candidate pick already handles `runsOn` into a stub to the buffer.
- [ ] **Step 3: Run** `./manage.sh test` — all `ok`. Then `node tools/freeze-run.mjs` must leave `run-s42.json` unchanged (`git status`): the no-industrial run is identical.
- [ ] **Step 4: Commit** — `feat(sim): stub traffic and the fan visit: back in, set out, pick up, leave`

---

### Task 4: Sim: the spur stub visit and the long runs

**Files:**
- Modify: `src/sim.js` (`trafficMenu`, `spawnTrain`, `shuntStep`, `trackFree`), `tools/sweep-industrial.mjs` (create)
- Test: `tests/test_sim.mjs`

**Interfaces:**
- Produces: for a spur with `stubOf`, the menu's spur item is replaced by loaded/light `shunt` items with `dest: spur` (the spawn gate and `reserved` work on the spur as today) and `stub: stubId`, absent while any queue holds a `shunt` entry for that spur; `train.shunt = { kind: 'spur', stage, stand: <spur exit signal node>, lead: <that same node>, leadSignal: <the spur's exit signal>, stub }`; the visit's reverse 1 happens when the train is `stopped` with `trackAhead === spur` (its arrival stand) instead of dwelling `DWELL.industry`; stages as the fan's with no pick-up after a set-out; `tools/sweep-industrial.mjs`: runs every seed in `s0..s399` with a fan or a spur stub for 8 h busy in AUTO and prints per seed: wedges (any train stood ≥ 30 min), STALL lines, visits completed, valve firings, max stub-full/empty streak; exits non-zero on any wedge.
- Consumes: Task 3's machine and menu items; Task 1's `stubOf`/`spur` links.

- [ ] **Step 1: Failing tests** on a spur-stub seed on each side (`pN`, `pS`): the menu for that spur's dir offers loaded (stub empty) or light (stub full) `shunt` items with `dest: spur` and no plain spur item; a loaded visit's events `entered, route…, arrived(spur)?` — define: it stops at the spur's exit signal with no `arrived` event, then `reversing, backing, arrived(stub), setOut, reversing, route(to the spur's exit signal), route…, out` leaving light; a light visit picks up and leaves loaded; a unit train of that industry is never drawn for that spur (`cars ≤ CUT_MAX` on every entry for it over 8 h); the spur's other-direction neighbour spur (if any) is unchanged; soak adds `pN`, `pS` with the same invariants as Task 3 (one train in the spur+stub, no head past a cut).
  Run: FAIL.
- [ ] **Step 2: Implement.** The spur variant of `shuntStep` differs only in `stand`, `lead` and the absence of a step 7; `missions()`'s existing `stopped && at === dest → dwelling` clause must not fire for a spur visitor on its first stop at the spur (check `t.shunt` first).
- [ ] **Step 3: Write `tools/sweep-industrial.mjs`** and run it: `node tools/sweep-industrial.mjs` — expected `0 wedges, 0 STALL` across every industrial seed; fix the operator rules until it is (each fix gets its spec amendment note and, if it is a rule, a test). Then the monkey run: the existing random-human harness in `test_sim` (the `wedgeSim` block's style) over 20 industrial seeds × 4 h clicking then 1 h hands-off: all recover.
- [ ] **Step 4: Run** `./manage.sh test` — all `ok`.
- [ ] **Step 5: Commit** — `feat(sim): spur stub visits; industrial sweep tool` (and a separate `fix(sim): …` commit per sweep fix, with its amendment in the spec).

---

### Task 5: Renderer, panels, docs

**Files:**
- Modify: `src/render.js` (tracks pass: stub names and buffer bars; a cuts pass before trains; fan label via `layout.places`), `src/panels.js` (`legendHTML` trains block), `README.md` ("What's on the panel": one paragraph; signal naming line mentions stub dwarfs; keys table unchanged), `docs/superpowers/specs/2026-11-03-industrial-branch-design.md` (amendment notes for anything ruled during the build)
- Test: `tests/test_ui.mjs`

**Interfaces:**
- Consumes: `sim.cuts`, `layout.fan`, `layout.spurStubs`, `t.cls === 'stub'`, `trainBlocks` for a cut: compute the cut's blocks with a helper `cutBlocks(sim, cut)` exported from `sim.js` (positions along the stub's buffer edge from `FOUL` short of the buffer back `cars × CAR`, as `[ {x1,y1,x2,y2,kind:'car'} ]`).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Failing tests** in `test_ui.mjs`: `cutBlocks` for a cut of 4 on a horizontal north stub returns 4 blocks each `CAR` long ending `FOUL` short of the buffer node's x; the renderer on a recording canvas draws, for a fan seed, one buffer bar per stub (count the `lineCap 'butt'` strokes of length `2 × lw` at buffer nodes, as the terminus test counts its bar) and `cuts × cars` car strokes at alpha `0.7`; `legendHTML()` contains `standing cut`.
- [ ] **Step 2: Implement.** In the tracks pass, `cls === 'stub'` tracks draw like yard tracks (small-caps name on the side away from the main: north stubs above, south below, spur stubs on the deeper side) plus the buffer bar (reuse the terminus's bar code: factor it into `bufferBar(nodeA, nodeB)`). New pass 6½ "cuts": for each cut, `cutBlocks` → the same underlay + 70 % colour strokes as cars, no markers, no tags. Shunt dwarfs at `X`, `J`, `Xs` already stand back along the edge they face (`signalGeom`'s `shunt` branch); check the `J` shunt's glyph clears `K1`'s padlock and the stub 0 line at zoom 0.6 and 2; if not, the fix is in `signalGeom`'s `back` only. Place names: `layout.places` carries the fan's label, so the existing name pass draws it.
- [ ] **Step 3: Visual check** with headless Chromium (the session's recipe: `--window-size`, `--virtual-time-budget=4000`, `?seed=<fan seed>&ff=N`): north fan and south fan at overview and at zoom 2, day and night; a spur stub each side; a train backing in; a loco running out past a cut; the frame after a set-out (pixel-compare the stub region before/after: identical). Fix overlaps found (Review Focus 5).
- [ ] **Step 4: README** paragraph after the terminus one: industrial leads and spur stubs in the voice of the existing text (what you see, how the visit goes, what `missed` means); the signal-naming line gains a stub-dwarf example. Legend: `standing cut` in the trains block.
- [ ] **Step 5: Run** `./manage.sh test` — all `ok`.
- [ ] **Step 6: Commit** — `feat(render): stubs, buffer stops and standing cuts; README`

---

### Task 6: Final review wave and merge

- [ ] **Step 1:** Whole-branch review on the most capable model (the standing process); one fix wave; every fix's reason in a spec amendment note.
- [ ] **Step 2:** `./manage.sh test` green; `node tools/sweep-industrial.mjs` clean; `node tools/freeze-run.mjs` and `node tools/freeze-layouts.mjs` leave their fixtures unchanged.
- [ ] **Step 3:** Fast-forward merge to `main`, push, wait for CI green. The deploy is the user's (`./manage.sh deploy` from their terminal); tell them `style.css` was not touched.
