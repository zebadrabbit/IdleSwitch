// Freeze an AUTO wedge into tests/fixtures/wedge-<seed>.json: the layout and every train, route, occupancy, route lock,
// switch lie and reservation at sim time T, so test_sim can replay a fix on exactly that state (the layout travels with
// it, so later generator changes cannot move it: s142's has, its stem is four cells since Task 6, so its recipe below
// needs the generator of that day too). Run it with the sim the wedge happened under:
//   node tools/freeze-wedge.mjs path/to/sim.js [seed T]   (default: s142 37100)
// - s142 at 37100 (10:18), busy, south junction. Under the sim of 5a6371f (before the liveness valve) P 411, bound for
//   the branch, stood at b' with its way up the stem occupied by P 264, which waited on L 268, which was opposed by
//   M 425 (wrong main), which waited on Z 419, which waited on P 411: for good.
//     git show 5a6371f:src/sim.js > src/_sim_wedge.js && node tools/freeze-wedge.mjs src/_sim_wedge.js; rm src/_sim_wedge.js
// - s687 at 23700 (06:35), busy, south junction, 16 s before the operator of e578790 routed M 237 (a branch arrival
//   bound west) from the stem signal across the gap to b (W46B) while M 144 was wrong main: M 237 stood at b with its
//   tail on Main 2's junction edges, against Z 146; M 144 waited on Z 146, M 245 on M 144, M 237 on M 245: for good.
//   Frozen before that route rather than with the cycle closed: the fix keeps the cycle from forming, and frozen at
//   25560 (07:06: two wrong-main trains, every way on held) it stays wedged under the fixed sim too.
//     git show e578790:src/sim.js > src/_sim_wedge.js && node tools/freeze-wedge.mjs src/_sim_wedge.js s687 23700; rm src/_sim_wedge.js
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { generate } from '../src/gen.js';

const [simArg, SEED = 's142', time = '37100'] = process.argv.slice(2), T = Number(time);
// No default sim: frozen from the current one, a fixed wedge would not be a wedge.
if (!simArg) { console.error('usage: node tools/freeze-wedge.mjs path/to/sim.js [seed T]'); process.exit(1); }
const simPath = resolve(simArg);
const { createSim, step } = await import(pathToFileURL(simPath).href);

const layout = generate(SEED), sim = createSim(layout, SEED, { density: 'busy' });
sim.auto = true;
while (sim.time < T) step(sim);
const fx = {
  seed: SEED, time: sim.time, nextTrainId: sim.nextTrainId, nextRouteId: sim.nextRouteId,
  trains: [...sim.trains.values()].map(({ events, adv, ...t }) => t),
  routes: [...sim.routes.values()].map(({ cand, sense, dir, ...r }) => ({ ...r, exitNode: cand.exitNode, sense: [...sense] })),
  occ: sim.edgeState.flatMap((st, e) => [...st.occ].map(id => [e, id])),
  locks: sim.edgeState.flatMap((st, e) => (st.route === null ? [] : [[e, st.route]])),
  lies: [...sim.switchState].map(([n, s]) => [n, s.lie]),
  reserved: [...sim.reserved],
  layout,
};
writeFileSync(new URL(`../tests/fixtures/wedge-${SEED}.json`, import.meta.url), JSON.stringify(fx) + '\n');
// Still wedged two hours on? The trains standing longest then, and how long they had stood at the freeze.
const at = new Map([...sim.trains.values()].map(t => [t.name, sim.time - t.lastMoveTime]));
console.log(`froze ${SEED} at ${T}: ${fx.trains.length} trains, ${fx.routes.length} routes`);
for (let i = 0; i < 7200; i++) step(sim);
const stood = [...sim.trains.values()].filter(t => t.state !== 'dwelling' && t.state !== 'holding')
  .sort((a, b) => a.lastMoveTime - b.lastMoveTime).slice(0, 6);
console.log(`two hours on, from ${simPath}: ${sim.completed.length} completed; stood longest: ${stood.map(t =>
  `${t.name} ${((sim.time - t.lastMoveTime) / 60).toFixed(0)} min (${at.has(t.name) ? `${(at.get(t.name) / 60).toFixed(0)} at the freeze` : 'entered since'})`).join(', ')}`);
