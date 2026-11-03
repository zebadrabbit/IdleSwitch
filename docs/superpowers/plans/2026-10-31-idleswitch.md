# IdleSwitch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seeded CTC-panel idle sim in the browser where a virtual operator routes trains through a generated terminal and a human can take the panel NX-style.

**Architecture:** Three pure modules with no DOM (`rng`+`gen.js` builds a track graph from a seed; `sim.js` runs interlocking, signals, trains, traffic and the operator over that graph with a fixed 1-sim-second step) and two browser modules (`render.js` draws the graph and trains on a canvas; `ui.js` owns HUD, panels, input, NX, keybinds, persistence). Edges are the unit of occupancy and locking; routes are edge lists; signals live at nodes; the mains are directional so every per-direction subgraph is a DAG.

**Tech Stack:** Vanilla ES modules, Canvas 2D, CSS. Node 22+ with `node:assert` for tests. No dependencies, no build.

**Spec:** `docs/superpowers/specs/2026-10-31-idleswitch-design.md`

## Global Constraints

- No dependencies, no build step, no backend. Site root is the repo root; `index.html` loads `src/*.js` as ES modules.
- Pure modules (`src/rng.js`, `src/gen.js`, `src/sim.js`) never touch `window`, `document`, `Math.random`, or `Date`.
- Same seed string → identical layout and identical traffic.
- Geometry: horizontal runs and 45° diagonals only; no curves; no diamond crossings; a node has at most 3 edges.
- Mains directional: Main 1 (top row) westbound (−x), Main 2 (bottom row) eastbound (+x). No reversing, every track is a through track.
- Signals right-hand: for +x travel the signal is drawn on the +y side, for −x on the −y side, each with a direction chevron.
- Trains never pass a Stop aspect; two trains never occupy the same edge.
- Dark navy background, never pure black. Base `#0b1020`.
- Deploy target the git-ignored `.deploy` file; rsync flags and exclusions as `../Gridworks/manage.sh`.
- Repo `zebadrabbit/IdleSwitch`, public, MIT, homepage `https://firetailfab.com/idleswitch/`.
- Units: 1 cell = 0.05 mile. `MPH = 1/180` cells per sim-second per mph. Car block `CAR = 0.6` cells, locomotive `LOCO = 0.8` cells. `CELL = 24` px at zoom 1.
- Mark every deliberate shortcut with a `// ponytail:` comment naming the ceiling.

## Review Focus

1. **Odd seeds.** `?seed=` empty, whitespace, emoji, 500 chars: must still produce a valid terminal, never throw. Pinned in Task 2 (`test_gen` seeds list).
2. **A human routes a train somewhere the operator wouldn't** (an express into a siding). The train must take it and the operator must still get it to its portal. Pinned in Task 6.
3. **Every spawnable train type must fit somewhere in its direction**, including a holding track for through freights. Pinned in Task 2 (capacity floors) and Task 6 (spawn gate soak).
4. **Background tab for an hour, then return.** `requestAnimationFrame` resumes with a huge delta; the sim must clamp, not run 36,000 steps in one frame. Pinned in Task 8 (`dt` clamp, manual check).
5. **localStorage missing or holding garbage** (private window, old schema). UI must fall back to defaults silently. Pinned in Task 8.

---

### Task 1: Repository scaffold

**Files:**
- Create: `.gitignore`, `LICENSE`, `README.md`, `manage.sh`, `.github/workflows/test.yml`, `index.html`, `src/style.css`, `tests/test_gen.mjs`, `tests/test_sim.mjs` (both a single `console.log('ok')` placeholder)

**Interfaces:**
- Produces: `./manage.sh test` runs `node tests/test_gen.mjs && node tests/test_sim.mjs`; `./manage.sh start` serves the root on `PORT` (default `8890`, 8889 is Gridworks).

- [ ] **Step 1: `git init`, write `.gitignore`**

```
.server.pid
.server.log
.claude/settings.local.json
.superpowers/
docs/reference/
```

- [ ] **Step 2: Write `LICENSE`** — MIT, `Copyright (c) 2026 zebadrabbit`.

- [ ] **Step 3: Write `manage.sh`** — copy `../Gridworks/manage.sh`, change `PORT` default to 8890, `test` to the two test files, `deploy` target path to `.../firetailfab/idleswitch/`, drop the `Brand/` include lines, keep `--exclude docs --exclude tests`.

- [ ] **Step 4: Write `.github/workflows/test.yml`** — copy Gridworks', run `node tests/test_gen.mjs` and `node tests/test_sim.mjs`.

- [ ] **Step 5: Write `index.html` and `src/style.css` skeleton**

`index.html`: `<title>IdleSwitch</title>`, `<meta name="theme-color" content="#0b1020">`, `<canvas id="map">`, `<header id="hud">` with placeholders for: wordmark text `IdleSwitch`, `#hud-clock`, `#btn-pause`, `#btn-speed`, `#hud-auto`, `#hud-seed`, panel toggle buttons `[data-panel="board|log|inspector|legend|settings"]`, `#btn-fullscreen`. Five `<section class="panel" id="panel-board|log|inspector|legend|settings">` each with `<div class="panel-title">Name <button class="panel-hide">×</button></div><div class="panel-body"></div>`. `<script type="module" src="src/ui.js">`.

`style.css`: `:root` tokens `--bg:#0b1020; --panel:#121a2e; --panel-border:#243052; --text:#cfd6ea; --dim:#7d88a6; --accent:#5aa9ff; --green:#39d353; --amber:#f0b429; --red:#ff4d4f;`. `html,body{margin:0;height:100%;background:var(--bg);overflow:hidden}` `canvas#map{position:fixed;inset:0}` HUD fixed top, 32px, translucent panel colour. `.panel{position:fixed;min-width:220px;background:var(--panel);border:1px solid var(--panel-border);border-radius:6px;font:12px/1.4 system-ui,monospace}` `.panel.hidden{display:none}` `.panel.dock-left/.dock-right/.dock-bottom` set `top/bottom/left/right` and `height`/`width`. `body.bare #hud, body.bare .panel {display:none}`.

- [ ] **Step 6: `README.md` stub** — title, one-paragraph description from the spec, `## Running it` with `./manage.sh start`, `## Tests` with `./manage.sh test`, license line.

- [ ] **Step 7: Run `./manage.sh test`** — Expected: both placeholders print `ok`, exit 0.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "chore: scaffold IdleSwitch (static shell, manage.sh, CI, MIT)"`

---

### Task 2: Seeded terminal generation

**Files:**
- Create: `src/rng.js`, `src/gen.js`
- Test: `tests/test_gen.mjs`

**Interfaces:**
- Produces (`src/rng.js`): `export function makeRng(seed: string): () => number` (xmur3 hash → mulberry32; returns floats in [0,1)); `export function pick(rng, arr)`, `export function randInt(rng, lo, hi)` inclusive.
- Produces (`src/gen.js`): `export function generate(seed: string): Layout`, `export const CLASS_SPEED = {main:60, ladder:30, platform:30, yard:15, siding:15, spur:15}`, `export const CAPACITY_MIN = {platform:6, yard:12, siding:14, spur:14}`.

```ts
type Layout = {
  seed: string, cols: number, rows: number,
  nodes:  {id:number, x:number, y:number}[],
  edges:  {id:number, a:number, b:number, cls:'main'|'ladder'|'platform'|'yard'|'siding'|'spur',
           dirs:number[] /* [1], [-1] or [1,-1] */, speed:number /* mph */, len:number /* cells */,
           track:number|null}[],
  switches: {node:number, trunk:number, normal:number, reverse:number}[],
  signals:  {id:number, node:number, dir:1|-1, kind:'high'|'dwarf'}[],
  tracks:   {id:number, cls:'platform'|'yard'|'siding'|'spur', name:string, dir:1|-1,
             edges:number[], capacity:number, industry:null|{key:string, label:string, trainType:string}}[],
  portals:  {node:number, name:string, dir:1|-1 /* direction trains ENTER with */}[],
  places:   {name:string, x:number, y:number}[],   // module labels (station / yard / siding group names)
  modules:  {kind:'station'|'yard'|'sidings', x0:number, x1:number, name:string}[],
}
```

Geometry decisions the implementer must follow:

- Main 1 on row 0, Main 2 on row `R = 1 + Ktop + Kbot` where `Ktop`/`Kbot` are the largest top-side / bottom-side track counts over all modules. Rows `1..Ktop` are westbound (dir −1) tracks, rows `R-Kbot..R-1` eastbound (dir +1). Main edges `dirs` are `[-1]` on row 0 and `[1]` on row R.
- Portal nodes: `(0,0)` named west place, dir −1 is the *exit* there so its entering portal is `(cols-1, 0)` dir −1; `(0,R)` dir +1 entry; `(cols-1,R)` exit. `portals` lists the two **entry** portals only: `{node:(0,R), dir:+1}`, `{node:(cols-1,0), dir:-1}`. Trains leave at the far end of their main.
- A module with `kt` top tracks and `kb` bottom tracks spanning columns `x0..x1`:
  - Westbound exit ladder (left end): diagonals `(x0,0)→(x0+1,1)→…→(x0+kt,kt)`; at row `r` the track runs right from `(x0+r, r)`. Edge `dirs=[-1]`, cls `ladder`.
  - Westbound entry ladder (right end): `(x1,0)→(x1-1,1)→…→(x1-kt,kt)`; row `r` track ends at `(x1-r, r)`. `dirs=[-1]`.
  - Eastbound entry ladder (left end): `(x0,R)→(x0+1,R-1)→…→(x0+kb,R-kb)`; `dirs=[1]`. Exit ladder (right end) mirrors.
  - Track `r` edges `dirs` equal its side's direction. Each track gets one **signal node** inserted one cell before its exit ladder node (westbound: at `(x0+r+1, r)`; eastbound: at `(x1-j-1, R-j)` for bottom row index `j`). Signal kind `dwarf` if cls ∈ {yard, siding, spur}, else `high`.
  - Main signals: westbound at `(x1+1, 0)` (entry) and `(x0-1, 0)` (exit); eastbound at `(x0-1, R)` and `(x1+1, R)`. Plus one signal at each entry portal node. Insert plain nodes where needed.
  - Width: `x1 - x0 = max over the module's tracks of (CAPACITY_MIN[cls] + 2*row_index + 2)`, so the deepest row still meets its floor. Modules separated by a 4-column gap; 3 columns from portal to first module.
  - `capacity` of a track = sum of `len` of its edges from the entry ladder node to the signal node, minus 0.5.
  - Switch `normal` = the edge that continues the trunk's direction vector (main continues main, ladder continues ladder); `reverse` = the other. At the deepest ladder node there is no switch (2 edges).
- Module mix from the seed: `n = randInt(2,4)` modules, order shuffled, drawn from `station` (kt,kb ∈ {1,2} each, at least 1 per side, platforms named `1..k` top-to-bottom), `yard` (per side: 1–2 yard tracks named `Y1…` plus 0–1 spur; at least one spur per yard overall; spur industry from `INDUSTRIES`), `sidings` (1 per side, named `Siding 1/2`). Guarantee at least one station or yard; never two of the same kind adjacent. Max one yard, max one station.
- `INDUSTRIES = [{key:'coal',label:'… Power Plant',trainType:'C'},{key:'steel',label:'… Steel',trainType:'M'},{key:'grain',label:'… Elevator',trainType:'G'},{key:'intermodal',label:'… Intermodal',trainType:'I'},{key:'lumber',label:'… Lumber',trainType:'M'},{key:'auto',label:'… Assembly',trainType:'M'},{key:'oil',label:'… Terminal',trainType:'M'}]` where `…` is a seeded place name. Place names: 24 short syllable-built names (`Lebanon`, `Cornwall`, `Colebrook` style) from two syllable lists; suffixes `Jct`, `Yard`, `Mine` for portals/yards.
- Spec deviation, decided here: no crossovers between mains (dead track under directional running). `// ponytail:` note in gen.js.

- [ ] **Step 1: Write failing tests in `tests/test_gen.mjs`**

```js
import assert from 'node:assert/strict';
import { generate, CAPACITY_MIN } from '../src/gen.js';
const seeds = ['', ' ', 'a', 'lebanon', '🚂', 'x'.repeat(500), ...Array.from({length:200},(_,i)=>`s${i}`)];
for (const seed of seeds) {
  const L = generate(seed);
  const deg = new Map(); for (const e of L.edges) for (const n of [e.a,e.b]) deg.set(n,(deg.get(n)||0)+1);
  for (const [n,d] of deg) assert.ok(d<=3, `${seed}: node ${n} degree ${d}`);
  for (const e of L.edges) { const A=L.nodes[e.a],B=L.nodes[e.b]; assert.ok(Math.abs(A.x-B.x)>0 && (A.y===B.y || Math.abs(A.y-B.y)===Math.abs(A.x-B.x)), 'horizontal or 45°'); }
  // no diamond: no two diagonal edges with opposite slopes in the same column pair and overlapping rows
  // no overlap: no two horizontal edges on the same row with overlapping open x-intervals
  // switches: each listed node has exactly 3 edges with trunk on one side, normal+reverse on the other
  // every track reachable (following dirs) from its direction's entry portal, and the far portal reachable from the track
  // for each track: capacity >= CAPACITY_MIN[cls]
  // at least one module of kind station or yard; every track has exactly one signal of its dir at its exit end
  // deterministic: JSON.stringify(generate(seed)) === JSON.stringify(L)
}
console.log('gen ok', seeds.length);
```
Write each comment as an assertion. Reachability uses a BFS that only follows edges whose `dirs` include the travel direction and only leaves a node through edges on the far side (x increasing for +1).

- [ ] **Step 2: Run** `node tests/test_gen.mjs` — Expected: FAIL, cannot find `../src/gen.js`.

- [ ] **Step 3: Implement `src/rng.js`** (~25 lines) and `src/gen.js` per the geometry above. Keep a `Builder` of plain closures: `node(x,y)` (dedupes by key), `edge(a,b,cls,dirs,track)`, then `ladder(...)`, `module(...)`, finish by computing `switches`, `signals`, `capacity`, `cols`.

- [ ] **Step 4: Run** `node tests/test_gen.mjs` — Expected: `gen ok 206`.

- [ ] **Step 5: Commit** — `git commit -am "feat(gen): seeded terminal generation with ladders, tracks, signals"` (add new files).

---

### Task 3: Interlocking core — graph, routes, switches

**Files:**
- Create: `src/sim.js`
- Test: `tests/test_sim.mjs`

**Interfaces:**
- Consumes: `Layout` from Task 2.
- Produces (`src/sim.js`):
  - `export function createSim(layout, seed, opts = {density:'normal'}): Sim` — builds adjacency, `routesFrom`, empty train state, `time = 6*3600` (sim seconds), `log = []`.
  - `Sim` fields used by later tasks: `layout`, `adj: Map<nodeId, edgeId[]>`, `edgeState: {occ:Set<trainId>, route:number|null}[]` indexed by edge id, `switchState: Map<nodeId,{lie:'normal'|'reverse'}>`, `signalAt: Map<string /*`${node}:${dir}`*/, signalId>`, `routesFrom: Map<signalId, Candidate[]>`, `routes: Map<routeId, Route>`, `trains: Map<trainId, Train>`, `reserved: Map<trackId, trainId>`, `queue: {1: Pending[], '-1': Pending[]}`, `nextSpawn: {1:number, '-1':number}`, `completed: []`, `time`, `log`, `auto: boolean`, `rng`, `_aspects: Map`.
  - `type Candidate = {edges:number[], switches:{node:number, lie:'normal'|'reverse'}[], exitNode:number, exitSignal:number|null, diverging:boolean, slow:boolean, len:number}` — `slow` = the last edge's cls ∈ {yard, siding, spur}; `diverging` = any switch lie `reverse`.
  - `type Route = {id, signal:number, cand:Candidate, trainId:number|null, human:boolean, entered:boolean}`
  - `export function setRoute(sim, signalId, exitNode, {human=false, trainId=null}={}): {ok:true, route:Route} | {ok:false, reason:string}` — reasons: `'no such route'`, `'occupied'`, `'locked'`, `'switch busy'`, `'already set'`.
  - `export function cancelRoute(sim, routeId): boolean` (false if entered).
  - `export function throwSwitch(sim, node): boolean` (false if locked).
  - `export function switchLocked(sim, node): boolean` — any adjacent edge occupied or routed.
  - `export function forwardEdges(sim, node, dir): number[]` — edges at `node` whose far node has greater x for `dir=+1` (smaller for −1) and whose `dirs` include `dir`.
  - `export function findPath(sim, fromNode, dir, goal: {node?:number, track?:number}, penalty = {}): number[]|null` — Dijkstra over forward edges; cost = `len + (edge is ladder ? 1 : 0)`; `penalty[edgeId]` adds; avoids edges with `occ.size>0` or `route` set unless that route's `trainId` is the caller (pass `penalty.trainId`).
  - `export function releaseEdge(sim, edgeId)` — clears `route` on that edge; when a route has no edges left it is deleted from `sim.routes`.
  - `export function sectionalRelease(sim, train)` — called by movement: releases edges the tail has left (Task 5 calls it).

- [ ] **Step 1: Write failing tests** in `tests/test_sim.mjs`

```js
import assert from 'node:assert/strict';
import { generate } from '../src/gen.js';
import { createSim, setRoute, cancelRoute, throwSwitch, forwardEdges, findPath, switchLocked } from '../src/sim.js';
const L = generate('lebanon'); const sim = createSim(L, 'lebanon');
// every signal has >= 1 candidate; candidates end at a node that has a signal of that dir or is the exit portal
// setRoute on the westbound entry portal signal to its first straight candidate -> ok; a second setRoute over a shared edge -> {ok:false, reason:'locked'}
// after cancelRoute the second setRoute succeeds
// throwSwitch on a switch inside a set route -> false; after cancel -> true and lie flips
// findPath from west entry portal to the east exit portal node returns edges with strictly increasing x
// findPath to {track: id of first platform} ends inside that track's edges
// a manually occupied edge (edgeState[e].occ.add(99)) makes setRoute over it return reason 'occupied' and findPath avoid it
console.log('sim core ok');
```

- [ ] **Step 2: Run** `node tests/test_sim.mjs` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** the functions above in `src/sim.js`. `routesFrom` is a DFS from the signal node that stops at the first node carrying a signal for `dir` or with no forward edges (portal exit); record switch lies by checking, at each switch node passed, whether the chosen outgoing (or incoming, for trailing moves) edge is `normal` or `reverse`.

- [ ] **Step 4: Run** `node tests/test_sim.mjs` — Expected: `sim core ok`.

- [ ] **Step 5: Commit** — `git commit -m "feat(sim): interlocking core: routes, locks, switches, pathfinding"`

---

### Task 4: Signal aspects

**Files:**
- Modify: `src/sim.js`
- Test: `tests/test_sim.mjs`

**Interfaces:**
- Produces: `export const ASPECT = {STOP:'STOP', RESTRICTING:'RESTRICTING', APPROACH:'APPROACH', ADVANCE_APPROACH:'ADVANCE_APPROACH', CLEAR:'CLEAR', DIVERGING_CLEAR:'DIVERGING_CLEAR', DIVERGING_APPROACH:'DIVERGING_APPROACH', SLOW_CLEAR:'SLOW_CLEAR'}`
- `export function aspectOf(sim, signalId): string` — memoised per step in `sim._aspects` (cleared at the start of each `step`).
- `export function signalHeads(sim, signalId): 1|2` — 2 if any candidate is `diverging || slow` and kind is `high`.
- `export function lamps(aspect, kind, heads): {top:'R'|'Y'|'G'|'FR'|'FY', bottom?: 'R'|'Y'|'G'|'FR'}` per the spec table (`F` = flashing). Dwarf: `{top}` only.

Rules for `aspectOf`:
1. No route set from this signal, or its route is `entered` → `STOP`.
2. Let `c` = the route's candidate, `next` = `c.exitSignal ? aspectOf(next) : CLEAR`.
3. Dwarf: `c.slow || next === STOP` → `RESTRICTING`, else `SLOW_CLEAR`.
4. High: `c.slow` → `RESTRICTING`; else if `c.diverging` → `next ∈ {STOP, RESTRICTING} ? DIVERGING_APPROACH : DIVERGING_CLEAR`; else `next === STOP ? APPROACH : next === CLEAR ? CLEAR : ADVANCE_APPROACH`.

- [ ] **Step 1: Write failing tests** (append to `test_sim.mjs`)

```js
// fresh sim: every signal STOP
// set route westbound entry portal -> straight main -> aspect APPROACH (next signal STOP); set the next route too -> CLEAR
// set route from the main entry signal into a platform track -> DIVERGING_APPROACH; into a yard/siding/spur track -> RESTRICTING
// set route from a dwarf (yard track exit) to the main with next STOP -> RESTRICTING; set the onward main route -> SLOW_CLEAR
// chain: A straight->B straight->C set, C's next STOP: aspectOf(A) === ADVANCE_APPROACH
// lamps(DIVERGING_CLEAR,'high',2) deep-equals {top:'R', bottom:'G'}; lamps(RESTRICTING,'dwarf',1) -> {top:'FR'}; lamps(ADVANCE_APPROACH,'high',1) -> {top:'FY'}
```
Use `generate` over a few seeds and pick the first layout that has both a station and a yard (`L.modules`).

- [ ] **Step 2: Run** — Expected: FAIL, `aspectOf` not exported.
- [ ] **Step 3: Implement** `aspectOf`, `signalHeads`, `lamps`.
- [ ] **Step 4: Run** — Expected: pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(sim): American aspect table with flashing approach and dwarf aspects"`

---

### Task 5: Trains — movement, occupancy, route adoption

**Files:**
- Modify: `src/sim.js`
- Test: `tests/test_sim.mjs`

**Interfaces:**
- Produces:
  - `export const MPH = 1/180, CAR = 0.6, LOCO = 0.8, FOUL = 0.3`
  - `export const TYPES = { X:{name:'Express', prio:5, cars:8, max:60, acc:1.0, dec:1.5, passenger:true}, P:{name:'Passenger', prio:4, cars:5, max:60, acc:1.0, dec:1.5, passenger:true}, Z:{name:'Priority intermodal', prio:3, cars:12, max:60, acc:0.5, dec:0.8}, M:{name:'Manifest', prio:2, cars:14, max:50, acc:0.4, dec:0.7}, C:{name:'Unit coal', prio:1, cars:20, max:45, acc:0.3, dec:0.6}, G:{name:'Grain', prio:1, cars:16, max:45, acc:0.3, dec:0.6}, I:{name:'Intermodal', prio:1, cars:12, max:50, acc:0.4, dec:0.7}, L:{name:'Local', prio:0, cars:6, max:40, acc:0.5, dec:0.8} }` (acc/dec in mph per sim-second).
  - `export function trainLength(type): number` = `LOCO + cars*CAR`.
  - `export function spawnTrain(sim, {type, dir, dest=null, name}): Train` — places the train with its head at the entry portal node (`headDist = 0`, `path = []`), state `'entering'`. Caller guarantees the portal edge is free (Task 6).
  - `type Train = {id, name, type, dir, prio, len, maxSpeed /*cells/s*/, path:number[], pathOff:number /*cumulative len of released edges removed from path front*/, headDist, speed /*cells/s*/, state:'entering'|'running'|'stopped'|'dwelling'|'holding'|'done', dest:number|null, goal:{track?:number, node?:number}, dwellUntil:number, holdFor:number|null, spawnTime, sched:number, lastMoveTime:number, stops:number, events:[{t,kind,text}]}`
  - `export function pathLength(sim, train): number` — total length of `train.path` edges plus `pathOff`.
  - `export function pointAt(sim, train, dist): {x,y}|null` — world grid coords at `dist` along the train's path (dist measured like `headDist`); `null` if before path start.
  - `export function trainBlocks(sim, train): {x1,y1,x2,y2,kind:'loco'|'car'}[]` — one segment per block from head backwards (`LOCO` then `cars × CAR`), clipped to the path.
  - `export function moveTrains(sim, dt=1)` — per train: (1) **adopt**: if the head's path ends at a node with a set route from the signal there (`route.trainId ∈ {null, train.id}`), append `route.cand.edges`, set `route.trainId = train.id`; (2) **limit**: `vAllowed = min(train.maxSpeed, speed of edge under head, for each upcoming edge e within braking distance: sqrt(v_e² + 2·dec·d_e), sqrt(2·dec·max(0, remaining)))` where `remaining = pathLength − headDist − FOUL` unless the path ends at an exit portal (then no stop target); (3) accelerate toward `vAllowed` by `acc·dt`, never exceed it (brake instantly to `vAllowed` if above: `// ponytail: brake curve is one-sided; fine for a panel sim`); (4) advance `headDist`; (5) **occupy**: edges overlapping `[headDist−len, headDist]` get `occ.add(id)`, the route whose first edge the head just entered gets `entered=true`; (6) `sectionalRelease` for edges the tail left: `occ.delete`, `releaseEdge`, drop from `path` front and add to `pathOff`; (7) **despawn**: if the tail has passed the exit portal node → `state='done'`, delete from `sim.trains`, release everything; (8) state `'stopped'` when `speed===0 && remaining<=0.05`, `'running'` otherwise (dwell/hold states set by Task 6 and respected: a dwelling/holding train has `vAllowed=0`).

- [ ] **Step 1: Write failing tests**

```js
// spawn an X westbound at the east entry portal; set the straight route from the portal signal and every onward straight main route by hand (loop: for each candidate chain to the west exit portal, pick the candidate with !diverging && !slow);
// run moveTrains 1 sim-second at a time up to 2 hours: assert each step: for every edge, occ.size <= 1; speed <= 60*MPH + 1e-9
// assert the train reached 'done' and is gone from sim.trains; assert it took between 2 and 12 sim-minutes
// spawn a P with no routes set: after 600 steps it is 'stopped' with headDist within FOUL+0.05 of pathLength and never moved past the portal signal node
// trainBlocks on a running train returns 1 + cars segments and the first segment's x1,y1 equals pointAt(headDist)
// a train entering a route makes aspectOf(entrance signal) === STOP and after it passes, the route is gone from sim.routes and all its edges have route===null
```

- [ ] **Step 2: Run** — Expected: FAIL, `spawnTrain` not exported.
- [ ] **Step 3: Implement** the above in `src/sim.js`.
- [ ] **Step 4: Run** — Expected: pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(sim): train movement, braking to aspects, occupancy and sectional release"`

---

### Task 6: Traffic and the virtual operator

**Files:**
- Modify: `src/sim.js`
- Test: `tests/test_sim.mjs`

**Interfaces:**
- Produces:
  - `export const DENSITY = {light: 12*60, normal: 7*60, busy: 4*60}` — mean spawn interval per direction, sim seconds.
  - `export const DWELL = {P: 3*60, L: 15*60, industry: 25*60}`.
  - `export function step(sim)` — one sim second: clear `_aspects`; `operator(sim)` if `sim.auto`; `spawner(sim)`; `moveTrains(sim)`; `missions(sim)`; `sim.time += 1`.
  - `export function trafficMenu(sim, dir): {type, dest:number|null, weight:number}[]` — derived from the layout for that direction: `X` w3, `Z` w2, `M` w3 always; `P` w6 per platform of that dir (dest = that platform); for each spur: its `trainType` w2 (dest = spur); `L` w2 per yard track (dest = yard track). Through freights get `dest=null`.
  - `export function fits(sim, train|{len}, trackId): boolean` — `len <= track.capacity`.
  - `export function trackFree(sim, trackId, forTrainId=null): boolean` — no edge occupied or routed (except by `forTrainId`) and `!sim.reserved.get(trackId)` (or reserved by `forTrainId`). Decided here: yard tracks must be clear; the spec's optional Restricting entry onto an occupied yard track is dropped (`// ponytail:` note).
  - `export function holdingTracks(sim, dir): number[]` — tracks of cls siding or yard for that dir.
  - `spawner(sim)`: per entry portal keep `nextSpawn[dir]`; when `sim.time >= nextSpawn`, draw a menu item (weighted, seeded rng), create a **pending** entry in `sim.queue[dir]` and set `nextSpawn += exponential(mean)`. Each step, the head of each queue enters when: the portal node's forward edge is free and unrouted, and (`dest === null` or (`fits` and `trackFree(dest)`)), in which case `sim.reserved.set(dest, id)`. Names: `${type} ${n}` with `n` odd for westbound, even for eastbound, counting up per direction from a seeded start in 100..400. Set `train.sched = spawnTime + distanceToExit/(0.8*max) + dwell + 5*60`. Log `"${name} entered from ${portal.name}"`. Queue entries show on the train board as holding at the portal.
  - `missions(sim)`: a train whose `dest` track contains its head edge and is `stopped` → `state='dwelling'`, `dwellUntil = time + DWELL[...]`, log arrival; when `time >= dwellUntil` → `dest = null`, `reserved.delete`, `goal = {node: exitPortal}`, `state='running'`, log departure. A train in `holding` with `holdFor` whose held-for train is `done` or has its head past the holder's exit node → `state='running'`. A train not `dwelling`/`holding` whose `lastMoveTime` is 30 min old logs `"STALL ${name}"` once (`stalled=true`). On despawn: `delay = time − sched`, log `"${name} out via ${portal} (${±mm} min)"`, push `{name, type, delay, spawnTime, exitTime, stops}` to `sim.completed`.
  - `operator(sim)`: for each train in states entering/running/stopped whose path ends at a signal node with no set route from it and that is not `dwelling`/`holding`: `goal = dest ? {track: dest} : {node: exit portal}`; `path = findPath(sim, node, dir, goal, {trainId})`; if null, skip; pick the candidate from `routesFrom[signal]` whose edges are a prefix of `path`; **overtake rule**: if the train's `dest === null`, prio ≤ 2, and some train with higher prio and same dir is behind it within 20 cells (compare x of head nodes) or is first in that direction's queue with higher prio, and a candidate exists into a `holdingTracks` entry that `fits` and is `trackFree` → set that route instead, `state='holding'` on arrival (`holdFor = that train id`), log `"${name} holding at ${track.name} for ${other}"`; otherwise `setRoute(sim, signal, cand.exitNode, {trainId})`; log `"AUTO: ${signal label} → ${name}"` only on success. Human routes (`route.human`) are never cancelled by the operator.
  - `export function signalLabel(sim, signalId): string` — `"${dir===1?'E':'W'}${node x}"` style short label used in logs and the inspector.
  - `export function logEvent(sim, text)` — pushes `{t: sim.time, text}`; keep last 200.

- [ ] **Step 1: Write failing tests**

```js
// soak: for seed of ['lebanon','s7','s42']: sim = createSim(generate(seed), seed, {density:'busy'}); sim.auto = true;
//   run 8*3600 steps; every step assert occ.size<=1 on every edge, and no train has (time - lastMoveTime) > 30*60 while state not dwelling/holding
//   after: sim.completed.length >= 20; at least one completed P (if a station exists) and one freight with dest (if a yard exists)
// determinism: two sims same seed, 3600 steps each: JSON of (time, trains' headDist/speed/state, completed) equal
// spawn gate: with density 'busy', no queued train with dest ever enters while trackFree(dest) is false (instrument by checking at every entry)
// human override: sim.auto=true; wait until an X is running on the main approaching a module with a siding on its side; set a human route from its next signal into the siding; assert the X adopts it (its path contains the siding's edges) and that within 60 sim-minutes it is 'done'
// fits: a fake train with len 99 -> fits() false for every track
```

- [ ] **Step 2: Run** — Expected: FAIL, `step` not exported.
- [ ] **Step 3: Implement** `trafficMenu`, `spawner`, `missions`, `operator`, `step`, helpers.
- [ ] **Step 4: Run** — Expected: pass. If the soak stalls, fix the rule, do not add a teleport.
- [ ] **Step 5: Commit** — `git commit -m "feat(sim): seeded traffic, missions, dwell, delay log and the virtual operator"`

---

### Task 7: Canvas renderer

**Files:**
- Create: `src/render.js`
- Modify: `index.html` (nothing new), `src/style.css` (nothing new)

**Interfaces:**
- Consumes: `Layout`, `Sim`, `aspectOf`, `signalHeads`, `lamps`, `trainBlocks`, `switchLocked`.
- Produces:
  - `export function createRenderer(canvas): Renderer` with `r.camera = {x, y, zoom}` (world px offset and scale), `r.fit(layout)` (fit the grid bounding box with 40 px margin), `r.draw(sim, ui)` where `ui = {selectedSignal, armedSignal, selectedTrain, hoverSignal, blink: boolean, now: ms}`, `r.resize()` (handles `devicePixelRatio`), `r.pick(sim, clientX, clientY): {kind:'signal'|'switch'|'train'|'route', id}|null` (12 px hit radius in screen space), `r.worldToScreen(x,y)`.
  - `export const COLORS = {bg:'#0b1020', track:'#8a93ab', trackDim:'#3a4463', route:'#39d353', occupied:'#ff4d4f', human:'#5aa9ff', label:'#cfd6ea', platform:'#1c2744', types:{X:'#f5d90a', P:'#ffd166', Z:'#c77dff', M:'#5aa9ff', C:'#9aa0a6', G:'#e0a458', I:'#4cc9f0', L:'#8ac926'}}`.

Draw order and rules:
1. Fill `bg`. Grid is not drawn.
2. Edges: width 3 px·zoom (min 2). Colour: occupied → `occupied`; routed → `route` (`human` tint if route.human); else `track`. The unselected leg of a switch (the one not matching its lie) is drawn `trackDim` and 2 px, so the lie reads.
3. Tracks: platform boxes — a filled rounded rect `platform` colour along the track on its outer side with the platform number centred, white; yard/siding/spur names in small caps `dim` text at the track's midpoint, offset outward. Module names (`places`) in 13 px uppercase `label` above the top main.
4. Portals: a short chevron `›`/`‹` and `to ${name}` text at each portal.
5. Switches: a 5 px dot at the node; a tiny lock glyph (padlock drawn with two strokes) when `switchLocked`. N/R letter when selected only.
6. Signals: at the node, offset 7 px to the right-hand side of travel; a 10 px stub mast perpendicular, head(s) as 4 px radius circles: top head nearest the track, bottom beyond it; dwarf = one 3.5 px circle without mast on the ground side. Lamp colours R `#ff3b30`, Y `#ffcc00`, G `#34c759`, flashing lamps drawn only when `ui.blink`. A 4 px chevron beside the mast pointing in the governed direction. Armed signal gets a pulsing white ring; selected a steady ring.
7. Trains: `trainBlocks` segments drawn as 5 px·zoom thick rounded lines, loco in the type colour full, cars same hue at 70 % alpha with 1 px gaps. ID tag: a `#121a2e` box with 1 px type-colour border and the name in 11 px monospace centred 10 px above the head block (below for eastbound). Selected train gets a white border.
8. Queue indicator: at each entry portal, `+N waiting` in `dim` when the queue is non-empty.

- [ ] **Step 1: Implement `src/render.js`** per the rules. `pick` tests signals first, then switches, then train blocks, then routed edges.

- [ ] **Step 2: Temporary smoke harness** — add to `src/ui.js` (to be replaced in Task 8) the minimal bootstrap: generate seed from URL or `'lebanon'`, `createSim`, `sim.auto=true`, renderer, a `requestAnimationFrame` loop stepping 10 sim-seconds per real second, `r.fit`.

- [ ] **Step 3: Verify visually** — `./manage.sh start`, then
```
~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome --headless --disable-gpu --window-size=1366,768 --virtual-time-budget=20000 --screenshot=/tmp/claude-1000/-home-winter-work-IdleSwitch/93af4d38-6c85-4926-b468-0bd4af656591/scratchpad/shot1.png http://localhost:8890/?seed=lebanon
```
Read the PNG. Expected: two mains, ladders, platform boxes with numbers, dwarf and high signals on the right-hand side with chevrons, at least one train chain with a tag, red under it, green ahead of it, nothing black. Fix what looks wrong.

- [ ] **Step 4: Commit** — `git add src/render.js src/ui.js && git commit -m "feat(render): CTC-style canvas renderer"`

---

### Task 8: UI — HUD, panels, NX, keybinds, persistence

**Files:**
- Create: `src/ui.js` (replace the smoke harness), modify `src/style.css`, `index.html`

**Interfaces:**
- Consumes everything above plus `setRoute`, `cancelRoute`, `throwSwitch`, `routesFrom`, `signalLabel`, `lamps`.
- Produces: the app. Module-level state `{sim, layout, r, speed:1|2|4|8, paused, armedSignal, selected, lastInput}`; `SIM_PER_SEC = 10` sim seconds per real second at 1×; frame delta clamped to 0.25 s real.

Behaviour to implement:
- **Boot**: `seed = new URLSearchParams(location.search).get('seed') ?? randomSeed()` (6 lowercase letters from `Math.random`; this is the one allowed use). Bad or empty seeds still pass through to `generate`. `history.replaceState` to put the seed in the URL. `sim.auto = true`.
- **Loop**: `requestAnimationFrame`; accumulate `dt*SIM_PER_SEC*speed` sim seconds, `step` per whole second, `r.draw` once per frame, `ui.blink = Math.floor(now/500)%2===0`. Update DOM panels at most 4×/s.
- **HUD**: clock `HH:MM` from `sim.time`; pause/speed buttons; `#hud-auto` text `AUTO` with class `on` (green) or `MANUAL` (amber); seed text, click copies; density `<select>`; panel toggles; fullscreen button → `document.documentElement.requestFullscreen()` / `exitFullscreen()`.
- **NX**: click a signal → `armedSignal` (if a route from it is already set and unentered, click again cancels it with `cancelRoute`); click a second signal or exit node → find the candidate in `routesFrom[armed]` with `exitSignal === clicked` (or `exitNode`); call `setRoute(..., {human:true})`; on failure flash the armed signal red 3× and log `"Route refused: ${reason}"`. Click a train → select it and arm the signal at the end of its path. Click a switch → `throwSwitch`; refused → brief shake class on the inspector. `Escape` clears. Clicks never change AUTO/MANUAL; only `A` and the HUD button do. In AUTO a human route still sets and the operator leaves it alone (spec: "human-set routes are never overridden").
- **Idle return**: in MANUAL, if `performance.now() − lastInput > 120000` and setting `idleReturn` is on → `sim.auto = true`, log it.
- **Panels**: drag by `.panel-title` (pointer events); on release, if within 24 px of the left/right/bottom window edge add `dock-left/right/bottom` (removing any other dock class), else clear dock classes and set `left/top`. `.panel-hide` and the HUD toggle flip `.hidden`. Layout `{id:{x,y,dock,hidden}}` saved to `localStorage['idleswitch.layout']`; settings to `localStorage['idleswitch.settings']` (`{speed, density, idleReturn, flash}`); wrap every read/write in try/catch, validate shape, fall back to defaults. Default positions: board docked right, log docked bottom, inspector top-left under HUD, legend hidden, settings hidden.
- **Panel contents**:
  - Board: table `ID | Type | From → To | Track | Status | Delay`; rows for queued (status `holding at ${portal}`), active, and the last 5 completed (dim). Delay `+m`/`−m` coloured amber/green.
  - Log: last 60 `sim.log` entries newest first, `HH:MM text`.
  - Inspector: selected train (name, type name, dir, speed mph, state, dest track name, length in cars, delay so far, aspect of the signal ahead); selected signal (label, kind, heads, aspect, route set and to where, candidate exits list with buttons that call `setRoute`); selected switch (lie, locked, "throw" button).
  - Legend: the aspect table rows with drawn lamp swatches, track colour swatches, train type colours, keybinds list.
  - Settings: speed radio, density select, idle-return checkbox, flashing checkbox, "Reset layout", seed input + "Load" + "New seed" (reloads with `?seed=`).
- **Keybinds**: `Space` pause, `+`/`-` speed, `A` auto/manual, `F` fit, `H` bare mode (`body.bare`), `Esc` clear, `1..5` toggle panels in order board/log/inspector/legend/settings, `?` legend, `N` new seed. Ignore keys when focus is in an input.
- **Camera**: wheel zoom about cursor (0.4..4), drag on empty canvas pans, `resize` → `r.resize()`; first load `r.fit`.
- **Fullscreen / F11**: nothing in the layout depends on window chrome; verify both modes look identical except size.

- [ ] **Step 1: Implement `src/ui.js`, CSS for HUD, panels, docks, tables, lamp swatches.**
- [ ] **Step 2: Verify** — rerun the headless screenshot (1366×768 and 1920×1080) and read both: HUD visible with AUTO green, board docked right with rows, log docked bottom with AUTO entries, no horizontal scroll, panels not overlapping the clock. Then in a real browser: drag a panel to each edge and reload (position kept), press `H`, press `A` and set an NX route by clicking two signals, watch the train take it, press `Esc`, toggle fullscreen.
- [ ] **Step 3: Background-tab clamp check** — in the browser, switch tabs for 2 minutes, return: clock advanced by at most ~2.5 sim-seconds × speed per frame burst, no freeze (`dt` clamp).
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): HUD, dockable panels, NX routing, keybinds, persistence"`

---

### Task 9: README, GitHub repo, CI, deploy script check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the README** — hero paragraph (spec "What it is" and "Why" condensed), `## Controls` (keybinds table), `## What's on the panel` (track colours, aspects table, train types), `## Seeds` (`?seed=`), `## Layout` (file map as in the spec), `## Running it`, `## Tests`, `## Deploy` (`./manage.sh deploy`), `## License` MIT. Link the spec and plan under `docs/`.
- [ ] **Step 2: `bash -n manage.sh && ./manage.sh test`** — Expected: both test files pass.
- [ ] **Step 3: Create the repo and push**
```bash
gh repo create zebadrabbit/IdleSwitch --public --source=. --remote=origin \
  --description "Sit back and watch a CTC rail terminal run itself. A seeded idle sim where a virtual operator routes passenger trains to platforms, freight to industries, and through trains down the main, or take the panel yourself. Vanilla JS, no build step." \
  --homepage "https://firetailfab.com/idleswitch/" --push
gh repo edit zebadrabbit/IdleSwitch --add-topic idle-game --add-topic simulation --add-topic railroad --add-topic railway --add-topic train --add-topic ctc --add-topic interlocking --add-topic signalling --add-topic dispatcher --add-topic browser-game --add-topic canvas --add-topic javascript --add-topic no-dependencies --add-topic screensaver
```
- [ ] **Step 4: Verify CI** — `gh run watch` until the `test` workflow is green; `gh repo view --json description,homepageUrl,repositoryTopics,licenseInfo`.
- [ ] **Step 5: Deploy** — only on the owner's say-so: `./manage.sh deploy`, then `curl -sI https://firetailfab.com/idleswitch/ | head -1` → `200`.
