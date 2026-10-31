// Throwaway smoke harness for the renderer (Task 7). Task 8 replaces this file with the real UI.
import { generate } from './gen.js';
import { createSim, step } from './sim.js';
import { createRenderer } from './render.js';

const seed = new URLSearchParams(location.search).get('seed') ?? 'lebanon';
const layout = generate(seed);
const sim = createSim(layout, seed, { density: 'normal' });
sim.auto = true;
// Fast-forward 20 sim-minutes so the first frame (and the headless screenshot) has trains. Task 8 removes this.
for (let i = 0; i < 1200; i++) step(sim);

document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden')); // Task 8 lays the panels out
const r = createRenderer(document.getElementById('map'));
r.resize();
r.fit(layout);
addEventListener('resize', () => { r.resize(); r.fit(layout); });

const SIM_PER_SEC = 10;
let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(0.25, Math.max(0, now - last) / 1000) * SIM_PER_SEC;
  last = now;
  for (; acc >= 1; acc--) step(sim);
  r.draw(sim, { blink: Math.floor(now / 500) % 2 === 0, now });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
