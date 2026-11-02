// Freeze the AUTO wedge on s142 (busy, south junction) into tests/fixtures/wedge-s142.json: the layout and every train,
// route, occupancy, route lock, switch lie and reservation at t = 37100 (10:18), so test_sim can replay the liveness
// valve on exactly that state (the layout travels with it, so later generator changes cannot move it). Under the sim of
// 5a6371f (before the valve) P 411, bound for the branch, stood at b' with its way up the stem occupied by P 264, which
// waited on L 268, which was opposed by M 425 (wrong main), which waited on Z 419, which waited on P 411: for good.
//   git show 5a6371f:src/sim.js > src/_sim_wedge.js && node tools/freeze-wedge.mjs src/_sim_wedge.js; rm src/_sim_wedge.js
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { generate } from '../src/gen.js';

const SEED = 's142', T = 37100;
const simPath = resolve(process.argv[2] ?? new URL('../src/sim.js', import.meta.url).pathname);
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
writeFileSync(new URL('../tests/fixtures/wedge-s142.json', import.meta.url), JSON.stringify(fx) + '\n');
// Still wedged an hour on? (true under the sim before the valve)
const names = ['P 411', 'P 264', 'L 268', 'M 425', 'Z 419'], stood = () => names.map(n => {
  const t = [...sim.trains.values()].find(k => k.name === n);
  return t ? `${n} ${((sim.time - t.lastMoveTime) / 60).toFixed(0)} min` : `${n} gone`;
});
console.log(`froze ${SEED} at ${T}: ${fx.trains.length} trains, ${fx.routes.length} routes; stood: ${stood().join(', ')}`);
for (let i = 0; i < 3600; i++) step(sim);
console.log(`an hour on, from ${simPath}: ${stood().join(', ')}`);
