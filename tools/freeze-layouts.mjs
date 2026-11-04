// Freeze the layout lists of a few seeds into tests/fixtures/layouts.json, so test_gen can prove a
// generator refactor leaves those layouts unchanged (the base generator: industry off), and the whole layout of a few
// industrial seeds into tests/fixtures/layouts-industrial.json. Re-runnable:
//   node tools/freeze-layouts.mjs [path/to/gen.js]   (default: src/gen.js)
// To freeze from an older generator, copy it into src/ under another name (it imports ./rng.js), e.g.
//   git show HEAD:src/gen.js > src/_gen_old.js && node tools/freeze-layouts.mjs src/_gen_old.js
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const SEEDS = ['lebanon', 's0', 's7', 's42', 's47'];
// The first of s0.. with a north two-stub fan, a south three-stub fan, a spur stub on each side of one terminal.
const INDUSTRIAL = ['s7', 's5', 's3'];
const genPath = resolve(process.argv[2] ?? new URL('../src/gen.js', import.meta.url).pathname);
const { generate } = await import(pathToFileURL(genPath).href);

// `dirs` as the pre-oneWay generator wrote it; derived from `oneWay` once `dirs` is gone.
const dirsOf = (L, e) => e.dirs ?? (e.oneWay === null ? [1, -1]
  : [Math.sign(L.nodes[e.oneWay === e.a ? e.b : e.a].x - L.nodes[e.oneWay].x)]);

const freeze = seed => {
  const L = generate(seed, { industrial: false });
  return {
    nodes: L.nodes.map(n => [n.x, n.y]),
    edges: L.edges.map(e => [e.a, e.b, e.cls, dirsOf(L, e).join(''), e.track, e.main, e.section]),
    switches: L.switches.map(s => [s.node, s.trunk, s.normal, s.reverse]),
    tracks: L.tracks.map(t => [t.id, t.cls, t.name, t.dir, t.edges, t.capacity]),
    signals: L.signals.map(s => [s.node, s.dir, s.kind]),
    portals: L.portals.map(p => [p.node, p.name, p.dir]),
  };
};

// One row per line, so a changed layout shows up as a readable diff.
const list = rows => `[\n${rows.map(r => `      ${JSON.stringify(r)}`).join(',\n')}\n    ]`;
const seed = s => `  ${JSON.stringify(s)}: {\n${Object.entries(freeze(s)).map(([k, v]) => `    "${k}": ${list(v)}`).join(',\n')}\n  }`;
const out = new URL('../tests/fixtures/layouts.json', import.meta.url);
writeFileSync(out, `{\n${SEEDS.map(seed).join(',\n')}\n}\n`);
// Industrial seeds: every key of the layout, arrays one row per line.
const whole = s => `  ${JSON.stringify(s)}: {\n${Object.entries(generate(s)).map(([k, v]) =>
  `    "${k}": ${Array.isArray(v) ? list(v) : JSON.stringify(v)}`).join(',\n')}\n  }`;
writeFileSync(new URL('../tests/fixtures/layouts-industrial.json', import.meta.url), `{\n${INDUSTRIAL.map(whole).join(',\n')}\n}\n`);
console.log(`froze ${SEEDS.length} layouts and ${INDUSTRIAL.length} industrial from ${genPath}`);
