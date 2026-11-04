// Freeze a busy two-hour AUTO run of s42 into tests/fixtures/run-s42.json (the last 200 log lines and every completed
// train's name and delay), so test_sim can prove a sim refactor leaves its behaviour unchanged. Re-runnable:
//   node tools/freeze-run.mjs [path/to/sim.js]   (default: src/sim.js)
// To freeze from an older sim, copy it into src/ under another name (it imports ./rng.js), e.g.
//   git show HEAD:src/sim.js > src/_sim_old.js && node tools/freeze-run.mjs src/_sim_old.js
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { generate } from '../src/gen.js';

const SEED = 's42', STEPS = 7200;
const simPath = resolve(process.argv[2] ?? new URL('../src/sim.js', import.meta.url).pathname);
const { createSim, step } = await import(pathToFileURL(simPath).href);

const sim = createSim(generate(SEED, { industrial: false }), SEED, { density: 'busy' }); // the base layout
sim.auto = true;
for (let i = 0; i < STEPS; i++) step(sim);
const run = { log: sim.log.map(e => e.text), completed: sim.completed.map(c => [c.name, c.delay]) };
// One row per line, so a changed run shows up as a readable diff.
const list = rows => `[\n${rows.map(r => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]`;
writeFileSync(new URL('../tests/fixtures/run-s42.json', import.meta.url),
  `{\n${Object.entries(run).map(([k, v]) => `  "${k}": ${list(v)}`).join(',\n')}\n}\n`);
console.log(`froze ${SEED}: ${run.log.length} log lines, ${run.completed.length} completed, from ${simPath}`);
