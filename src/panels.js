// Panel bodies as HTML strings built from sim state (no DOM). ui.js puts them in place and wires the buttons
// through their data-* attributes. Everything from the sim or the URL goes through esc().
import { TYPES, MPH, DENSITY, aspectOf, signalHeads, lamps, signalLabel, routeFrom, signalAheadOf, portalAtNode, switchLocked,
  isWrongMain } from './sim.js';
import { COLORS } from './render.js';
import { SPEEDS, DAY_LENGTHS, formatClock, formatDelay } from './ui-util.js';

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const ASPECT_NAME = { CLEAR: 'Clear', APPROACH: 'Approach', ADVANCE_APPROACH: 'Advance Approach', DIVERGING_CLEAR: 'Diverging Clear',
  DIVERGING_APPROACH: 'Diverging Approach', RESTRICTING: 'Restricting', SLOW_CLEAR: 'Slow Clear', STOP: 'Stop' };

// ponytail: generated portal names are "Place Suffix" with a unique Place, so the first word tells them apart.
const short = name => name.split(' ')[0];
export const trackName = (L, id) => (L.tracks[id].cls === 'platform' ? `Platform ${L.tracks[id].name}` : L.tracks[id].name);
export const switchLabel = (sim, node) => `${sim.layout.nodes[node].x}.${sim.layout.nodes[node].y}`;
const trainLabel = (sim, id) => esc(sim.trains.get(id)?.name ?? sim.queue.flat().find(q => q.id === id)?.name ?? `#${id}`);

// Where a candidate route ends: its exit signal, else off the panel by a portal (either main's end, or a junction's
// branch), or a buffer stop.
export function exitLabel(sim, c) {
  if (c.exitSignal !== null) return signalLabel(sim, c.exitSignal);
  const p = portalAtNode(sim, c.exitNode);
  return p ? `exit to ${p.name}` : 'end of track';
}

const lamp = code => `<i class="lamp ${code.at(-1)}${code[0] === 'F' ? ' flash' : ''}"></i>`;
const heads = codes => `<span class="heads">${codes.map(lamp).join('')}</span>`;
function aspectHTML(sim, sig) {
  const a = aspectOf(sim, sig), lp = lamps(a, sim.layout.signals[sig].kind, signalHeads(sim, sig));
  return `${heads([lp.top, lp.bottom].filter(Boolean))} ${ASPECT_NAME[a]}`;
}
const swatch = color => `<i class="sw" style="background:${color}"></i>`;
const delayHTML = d => `<span class="delay ${d.cls}">${d.text}</span>`;

// Board status words (spec: approaching / routed / holding / dwelling / departing; plus waiting at a red), and
// ' · wrong main' while the train is.
export const trainStatus = (t, sim) => status(t) + (isWrongMain(sim, t) ? ' · wrong main' : '');
function status(t) {
  if (t.state === 'entering' || !t.path.length) return 'approaching'; // still at its portal, off the panel
  if (t.state === 'stopped') return 'waiting';
  if (t.state === 'running') return t.dwellUntil > 0 && t.dest === null ? 'departing' : 'routed';
  return t.state;
}

// ---- Board: queued, active, then the last 5 completed (dim). Active rows select their train on click. From -> To are
// the entry and exit portals' names.
export function boardHTML(sim, selectedTrain) {
  const L = sim.layout, dest = d => (d === null ? '–' : trackName(L, d).replace('Platform ', 'Plat '));
  const portal = id => L.portals[id].name;
  const row = (cls, id, name, type, a, b, track, status, delay) => {
    const t = esc(TYPES[type].name);
    return `<tr class="${cls}"${id === null ? '' : ` data-train="${id}"`}><td class="id">${swatch(COLORS.types[type])}${esc(name)}</td>`
      + `<td title="${t}">${t}</td><td title="${esc(a)} → ${esc(b)}">${esc(short(a))}\u202f→\u202f${esc(short(b))}</td>`
      + `<td title="${esc(track)}">${esc(track)}</td><td title="${esc(status)}">${esc(status)}</td>`
      + `<td class="num">${delayHTML(delay)}</td></tr>`;
  };
  const rows = [
    ...sim.queue.flat().map(q => row('queued', null, q.name, q.type, portal(q.entry), portal(q.exit), dest(q.dest),
      `holding at ${portal(q.entry)}`, formatDelay(sim.time - q.sched))),
    ...[...sim.trains.values()].map(t => row(t.id === selectedTrain ? 'sel' : '', t.id, t.name, t.type, portal(t.entry),
      portal(t.exit), dest(t.dest), trainStatus(t, sim), formatDelay(sim.time - t.sched))),
    ...sim.completed.slice(-5).reverse().map(c =>
      row('done', null, c.name, c.type, c.from, c.to, '–', `out ${formatClock(c.exitTime)}`, formatDelay(c.delay, true))),
  ];
  return `<table class="board"><colgroup><col class="c-id"><col class="c-type"><col class="c-ft"><col class="c-track"><col class="c-status"><col class="c-delay"></colgroup>`
    + '<thead><tr><th>ID</th><th>Type</th><th>From → To</th><th>Track</th><th>Status</th><th class="num">Delay</th></tr></thead>'
    + `<tbody>${rows.join('') || '<tr><td colspan="6" class="dim">No trains yet.</td></tr>'}</tbody></table>`;
}

// ---- Log: the last 60 entries, newest first.
export const logHTML = sim => sim.log.slice(-60).reverse().map(e =>
  `<div class="${/refused|STALL|ERROR/.test(e.text) ? 'warn' : ''}"><span class="t">${formatClock(e.t)}</span> ${esc(e.text)}</div>`).join('')
  || '<p class="dim">Nothing yet.</p>';

// ---- Inspector: the selected train, signal or switch.
const kv = rows => `<table class="kv">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;

function exitsHTML(sim, sig) {
  const L = sim.layout;
  return (sim.routesFrom.get(sig) ?? []).map(c => {
    const tr = L.edges[c.edges.at(-1)].track, notes = [tr === null ? '' : trackName(L, tr), c.diverging ? 'diverging' : '', c.slow ? 'slow' : ''];
    return `<div class="exit"><button data-sig="${sig}" data-exit="${c.exitNode}">→ ${esc(exitLabel(sim, c))}</button>`
      + ` <span class="dim">${esc(notes.filter(Boolean).join(' · '))}</span></div>`;
  }).join('');
}

function signalHTML(sim, sig, armed) {
  const s = sim.layout.signals[sig], rt = routeFrom(sim, sig);
  const route = rt
    ? `to ${esc(exitLabel(sim, rt.cand))}${rt.human ? ' (human)' : ''}${rt.trainId !== null ? ` for ${trainLabel(sim, rt.trainId)}` : ''}`
      + ` <button data-cancel="${rt.id}">cancel</button>`
    : 'none';
  return kv([['Signal', `<b class="mono">${signalLabel(sim, sig)}</b>${armed ? ' <span class="armed">armed: click an exit signal</span>' : ''}`],
    ['Kind', s.kind === 'dwarf' ? 'dwarf' : 'high'], ['Heads', signalHeads(sim, sig)], ['Aspect', aspectHTML(sim, sig)], ['Route', route]])
    + `<div class="sub">Exits</div>${exitsHTML(sim, sig)}`;
}

function trainHTML(sim, t, armed) {
  const L = sim.layout, ahead = signalAheadOf(sim, t);
  let state = trainStatus(t, sim);
  if (t.holdFor !== null) state += ` for ${trainLabel(sim, t.holdFor)}`;
  return kv([['Train', `${swatch(COLORS.types[t.type])}<b class="mono">${esc(t.name)}</b>`], ['Type', esc(TYPES[t.type].name)],
    ['Direction', `${t.dir > 0 ? 'east' : 'west'}bound to ${esc(L.portals[t.exit].name)}`],
    ['Speed', `${Math.round(t.speed / MPH)} mph`], ['State', state],
    ['Destination', t.dest === null ? '–' : esc(trackName(L, t.dest))], ['Length', `${TYPES[t.type].cars} cars`],
    ['Delay', delayHTML(formatDelay(sim.time - t.sched))],
    ['Signal ahead', ahead === undefined ? 'none (exit)' : `<span class="mono">${signalLabel(sim, ahead)}</span> ${aspectHTML(sim, ahead)}`]])
    + (armed !== null ? `<div class="sub">Routes from ${signalLabel(sim, armed)}</div>${exitsHTML(sim, armed)}` : '');
}

function switchHTML(sim, node) {
  const sw = sim.switchAt.get(node), st = sim.edgeState[sw.trunk];
  let by = 'no';
  if (st.occ.size) by = `occupied by ${[...st.occ].map(id => trainLabel(sim, id)).join(', ')}`;
  else if (st.route !== null) by = `route from ${signalLabel(sim, sim.routes.get(st.route).signal)}`;
  return kv([['Switch', `<b class="mono">${switchLabel(sim, node)}</b>`], ['Lie', sim.switchState.get(node).lie],
    ['Locked', switchLocked(sim, node) ? by : 'no']]) + `<div class="sub"><button data-throw="${node}">throw</button></div>`;
}

export function inspectorHTML(sim, sel, armed) {
  if (sel?.kind === 'train' && sim.trains.has(sel.id)) return trainHTML(sim, sim.trains.get(sel.id), armed);
  if (sel?.kind === 'signal') return signalHTML(sim, sel.id, armed === sel.id);
  if (sel?.kind === 'switch') return switchHTML(sim, sel.id);
  return '<p class="dim">Click a train, signal or switch. NX: click an entrance signal, then an exit signal.</p>';
}

// ---- Legend (static): the spec's aspect table, track and train colours, keys.
const ASPECTS = [ // name, high 1 head, high 2 heads (top bottom), dwarf
  ['Clear', 'G', 'G R', ''], ['Approach', 'Y', 'Y R', ''], ['Advance Approach', 'FY', 'FY R', ''],
  ['Diverging Clear', '', 'R G', ''], ['Diverging Approach', '', 'R Y', ''], ['Restricting', '', 'R FR', 'FR'],
  ['Slow Clear', '', '', 'G'], ['Stop', 'R', 'R R', 'R']];
export const KEYS = [['Space', 'pause'], ['+ / −', 'speed'], ['A', 'AUTO / MANUAL'], ['F, 0', 'reset view'],
  ['H', 'hide chrome'], ['Esc', 'clear selection'], ['1–5', 'board, log, inspector, legend, settings'], ['?', 'legend'],
  ['N', 'new seed'], ['wheel / drag', 'zoom / pan']];

export function legendHTML() {
  const cell = codes => (codes ? heads(codes.split(' ')) : '<span class="dim">—</span>');
  const tracks = [['idle', COLORS.track], ['route set', COLORS.route], ['human route', COLORS.human], ['occupied', COLORS.occupied],
    ['unset switch leg', COLORS.trackDim], ['slow order', COLORS.slow]];
  return '<table class="legend"><thead><tr><th>Aspect</th><th>1 head</th><th>2 heads</th><th>dwarf</th></tr></thead><tbody>'
    + ASPECTS.map(([n, ...c]) => `<tr><td>${n}</td>${c.map(x => `<td>${cell(x)}</td>`).join('')}</tr>`).join('') + '</tbody></table>'
    + '<div class="sub">Track</div>' + tracks.map(([n, c]) => `<div><i class="bar" style="background:${c}"></i>${n}</div>`).join('')
    + '<div class="sub">Trains</div><div class="cols">'
    + Object.keys(TYPES).map(t => `<div>${swatch(COLORS.types[t])}<span class="mono">${t}</span> ${TYPES[t].name}</div>`).join('') + '</div>'
    + `<div class="sub">Keys</div>${kv(KEYS.map(([k, v]) => [`<kbd>${k}</kbd>`, v]))}`;
}

// ---- Settings (built once; ui.js keeps the controls in sync).
export function settingsHTML(settings, seed) {
  const radio = s => `<label><input type="radio" name="speed" value="${s}"${s === settings.speed ? ' checked' : ''}> ${s}×</label>`;
  const check = (name, label) => `<label><input type="checkbox" name="${name}"${settings[name] ? ' checked' : ''}> ${label}</label>`;
  const day = m => `<option value="${m}"${m === settings.dayLength ? ' selected' : ''}>${m ? `${m} min` : 'off'}</option>`;
  return `<div class="row"><span class="k">Speed</span>${SPEEDS.map(radio).join(' ')}</div>`
    + `<div class="row"><span class="k">Density</span><select name="density">${densityOptions(settings.density)}</select></div>`
    + `<div class="row">${check('idleReturn', 'return to AUTO after 2 idle minutes')}</div>`
    + `<div class="row">${check('flash', 'flashing aspects flash')}</div>`
    + '<div class="sub">Ambient</div>'
    + `<div class="row"><label>Day length <select name="dayLength">${DAY_LENGTHS.map(day).join('')}</select></label></div>`
    + `<div class="row">${check('slowOrders', 'slow orders')}</div>`
    + `<div class="row">${check('idleCamera', 'idle camera after 1 idle minute')}</div>`
    + '<div class="row"><button data-act="reset">Reset layout</button></div>'
    + `<div class="row"><span class="k">Seed</span><input name="seed" value="${esc(seed)}" spellcheck="false" autocomplete="off">`
    + '<button data-act="load">Load</button> <button data-act="new">New seed</button></div>';
}

export const densityOptions = cur => Object.keys(DENSITY).map(d => `<option${d === cur ? ' selected' : ''}>${d}</option>`).join('');
