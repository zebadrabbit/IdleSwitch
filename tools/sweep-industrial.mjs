// The industrial branch's long runs (spec "Tests"): every seed in s<lo>..s<hi> with a fan or a spur stub, 8 h busy in AUTO,
// one line per seed and a summary; exit 1 on any wedge. Takes a while (about 7 s a seed). Never commit its output.
//   node tools/sweep-industrial.mjs [lo hi] > sweep.txt     (default 0 399)
//   node tools/sweep-industrial.mjs --monkey [n]            the first n industrial seeds (default 20): 4 h of a human
//                                                           clicking at random, then 1 h hands-off AUTO
// Columns: seed; fan stubs + spur stubs; visits completed fan / spur; given up (missed events); STALL lines; longest stand
// (min, dwelling and holding aside); the longest any stub group stood all full or all empty (min: a fan's stubs together,
// each spur stub alone); stubs full / stubs at the end; a WEDGE when a train has stood 30 min at the end, or STALLed and
// never moved again. A monkey line: clicks, routes set by hand, then the same, with the longest stand in the last hour, and a
// WEDGE also for a train on the panel at the hand-off that has not moved since.
import { generate } from '../src/gen.js';
import { createSim, step, setRoute, cancelRoute, throwSwitch } from '../src/sim.js';
import { makeRng, pick } from '../src/rng.js';

const HOUR = 3600, STALL = 30 * 60, monkey = process.argv[2] === '--monkey';
const [lo, hi] = monkey ? [0, 399] : [Number(process.argv[2] ?? 0), Number(process.argv[3] ?? 399)];
const min = s => (s / 60).toFixed(1);

// One human action, about every 30 s: an NX from a random signal (half the time an industrial one: a fan's or a spur stub's,
// or a stub spur's exit signal) to a random exit of it; a cancel of a random un-entered route; a switch thrown; now and then
// AUTO/MANUAL toggled. Seeded per seed, so a run repeats.
function click(S, rng, ind, n) {
  const { signals, switches } = S.layout, r = rng();
  if (r < 0.6) {
    const g = ind.length && rng() < 0.5 ? pick(rng, ind) : pick(rng, signals).id, cs = S.routesFrom.get(g);
    if (cs.length && setRoute(S, g, pick(rng, cs).exitNode, { human: true }).ok) n.set++;
  } else if (r < 0.85) {
    const rs = [...S.routes.values()].filter(k => !k.entered);
    if (rs.length) cancelRoute(S, pick(rng, rs).id);
  } else if (r < 0.97) { if (switches.length) throwSwitch(S, pick(rng, switches).node); }
  else S.auto = !S.auto;
  n.clicks++;
}

function run(seed) {
  const G = generate(seed), S = createSim(G, seed, { density: 'busy' }), { edges, tracks, signals } = G;
  S.auto = true;
  const fan = G.fan?.stubs ?? [], spur = G.spurStubs.map(k => k.stub), names = ids => new Set(ids.map(id => tracks[id].name));
  const groups = [...(fan.length ? [fan] : []), ...spur.map(id => [id])].map(ids => ({ ids, was: null, since: S.time }));
  const ind = signals.filter(g => S.adj.get(g.node).some(e => ['lead', 'stub'].includes(edges[e].cls))
    || (g.from !== null && tracks[edges[g.from].track]?.stubOf != null)).map(g => g.id);
  const rng = makeRng(seed + ':monkey'), n = { clicks: 0, set: 0 }, stalled = new Set();
  let stand = 0, stuck = 0, stalls = 0, handoff = null, h0 = -Infinity; // (a monkey's stands count from the hand-off)
  for (let i = 0; i < (monkey ? 5 : 8) * HOUR; i++) {
    if (monkey && i < 4 * HOUR && rng() < 1 / 30) click(S, rng, ind, n);
    if (monkey && i === 4 * HOUR) { S.auto = true; handoff = new Set(S.trains.keys()); h0 = S.time; stand = 0; }
    step(S);
    for (const t of S.trains.values()) {
      if (t.state !== 'dwelling' && t.state !== 'holding') stand = Math.max(stand, S.time - Math.max(t.lastMoveTime, h0));
      if (t.stalled && !stalled.has(t.id)) { stalled.add(t.id); stalls++; } else if (!t.stalled) stalled.delete(t.id);
    }
    if (i % 60) continue;
    for (const g of groups) {
      const full = g.ids.filter(id => S.cuts.has(id)).length, now = full === 0 ? 'empty' : full === g.ids.length ? 'full' : 'mixed';
      if (now !== g.was) Object.assign(g, { was: now, since: S.time });
      if (now !== 'mixed') stuck = Math.max(stuck, S.time - g.since);
    }
  }
  const all = [...S.completed, ...S.trains.values()], fanN = names(fan), spurN = names(spur);
  const worked = set => S.completed.filter(c => c.events.some(e => (e.kind === 'setOut' || e.kind === 'pickUp') && set.has(e.track))).length;
  const wedged = [...S.trains.values()].filter(t => t.stalled
    || (t.state !== 'dwelling' && t.state !== 'holding' && S.time - t.lastMoveTime >= STALL)
    || (handoff?.has(t.id) && t.lastMoveTime < h0)).map(t => `${t.name} (${t.state}, ${min(S.time - t.lastMoveTime)} min)`);
  return { seed, fan: fan.length, spur: spur.length, visits: [worked(fanN), worked(spurN)],
    missed: all.reduce((s, t) => s + t.events.filter(e => e.kind === 'missed').length, 0), stalls, stand, stuck,
    full: [...fan, ...spur].filter(id => S.cuts.has(id)).length, stubs: fan.length + spur.length, wedged, ...n };
}

const seeds = [];
for (let i = lo; i <= hi; i++) { const G = generate(`s${i}`); if (G.fan || G.spurStubs.length) seeds.push(`s${i}`); }
const rows = [];
for (const seed of monkey ? seeds.slice(0, Number(process.argv[3] ?? 20)) : seeds) {
  const r = run(seed);
  rows.push(r);
  console.log([r.seed.padEnd(5), `stubs ${r.fan}+${r.spur}`, ...(monkey ? [`clicks ${r.clicks}`, `set ${r.set}`] : []),
    `visits ${r.visits.join('/')}`, `missed ${r.missed}`, `STALL ${r.stalls}`, `stand ${min(r.stand)}`, `stuck ${min(r.stuck)}`,
    `full ${r.full}/${r.stubs}`, r.wedged.length ? `WEDGE ${r.wedged.join(', ')}` : (monkey ? 'recovered' : 'ok')].join('  '));
}
if (!rows.length) { console.log('no industrial seeds in range'); process.exit(0); }
const sum = k => rows.reduce((s, r) => s + r[k], 0), top = k => rows.reduce((a, r) => (r[k] > a[k] ? r : a), rows[0]);
const wedges = rows.filter(r => r.wedged.length);
console.log(`\n${rows.length} seeds (${rows.filter(r => r.fan).length} fans, ${sum('spur')} spur stubs), ${monkey ? '4 h clicking + 1 h AUTO' : '8 h busy AUTO'}:`
  + ` visits ${rows.reduce((s, r) => s + r.visits[0], 0)} fan / ${rows.reduce((s, r) => s + r.visits[1], 0)} spur, given up ${sum('missed')},`
  + ` STALL ${sum('stalls')}, longest stand ${min(top('stand').stand)} min (${top('stand').seed}), longest all full/empty`
  + ` ${min(top('stuck').stuck)} min (${top('stuck').seed}), stubs full at the end ${sum('full')}/${sum('stubs')}`
  + ` (all full ${rows.filter(r => r.full === r.stubs).length} seeds, all empty ${rows.filter(r => !r.full).length}),`
  + ` ${wedges.length} wedges${wedges.length ? `: ${wedges.map(r => r.seed).join(' ')}` : ''}`);
process.exit(wedges.length ? 1 : 0);
