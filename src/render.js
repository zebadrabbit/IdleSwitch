// Canvas renderer for the CTC panel: track, platforms, portals, switches, signals, trains, queue counts.
// Reads the sim, never writes it. Positions go through the camera; sizes are screen px (text never below
// 11 px, strokes never below 2 px) so a four-module terminal fitted to 1366 px (~15 px a cell) stays legible.
// World px = grid cell * CELL. camera {x, y} is the world-px point at the canvas's top-left corner and zoom
// the screen px per world px: screen = (world - camera) * zoom.
import { aspectOf, signalHeads, lamps, trainBlocks, switchLocked, nightOf, SLOW_ORDER } from './sim.js';

export const CELL = 24;
export const COLORS = {
  bg: '#0b1020', track: '#8a93ab', trackDim: '#3a4463', route: '#39d353', occupied: '#ff4d4f', human: '#5aa9ff',
  label: '#cfd6ea', platform: '#1c2744', dim: '#7d88a6', // dim = --dim in style.css
  slow: '#b8862b', // slow order
  lamp: { R: '#ff3b30', Y: '#ffcc00', G: '#34c759' },
  types: { X: '#f5d90a', P: '#ffd166', Z: '#c77dff', M: '#5aa9ff', C: '#9aa0a6', G: '#e0a458', I: '#4cc9f0', L: '#8ac926' },
};
const TAG_BG = '#121a2e', LAMP_OFF = '#283252', WHITE = '#ffffff';
const SANS = 'system-ui, sans-serif', MONO = 'ui-monospace, Menlo, Consolas, monospace';
const HIT = 12;   // pick radius, screen px
const STUB = 0.6; // cells of a switch's unselected leg drawn dim at the points
const MARGIN = 40;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// '#rrggbb' a blended toward b by t (0..1), per channel.
export const mix = (a, b, t) => `#${[1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t)
  + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('')}`;
const lerp = (a, b, t) => a + (b - a) * t;
// from moved toward to over dt ms at time constant tau ms (63 % in tau, 95 % in 3 tau).
export const ease = (from, to, dt, tau) => from + (to - from) * (1 - Math.exp(-dt / tau));
// ponytail: one entry per distinct target; targets are constants or a night mix (a few dozen values).
const rgbOf = new Map(); // '#rrggbb' -> [r, g, b], parsed once
const rgb = hex => rgbOf.get(hex) ?? rgbOf.set(hex, [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))).get(hex);
const rgba = ([r, g, b], a) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

// Screen directions, y down. facingOf: the unit vector a train passing the signal travels along, from the far node of
// the edge it faces (signal.from) to its node; a portal signal (from null) points into the panel from the portal's
// side. rightOf: v turned a quarter clockwise on screen, the right-hand side of travel (east -> below, as the rows
// always had it; west -> above; down -> west; up -> east).
const INTO = { west: { x: 1, y: 0 }, east: { x: -1, y: 0 }, north: { x: 0, y: 1 }, south: { x: 0, y: -1 } };
export function facingOf(layout, signal) {
  if (signal.from === null) return INTO[layout.portals.find(p => p.node === signal.node).side];
  const e = layout.edges[signal.from], n = layout.nodes[signal.node], o = layout.nodes[e.a === signal.node ? e.b : e.a];
  const dx = n.x - o.x, dy = n.y - o.y, l = Math.hypot(dx, dy);
  return { x: dx / l, y: dy / l };
}
export const rightOf = v => ({ x: -v.y, y: v.x });
// A w x h tag for a head block centred at (x, y) screen px travelling along unit u: its centre x and top y, on the right
// of travel. On a row 10 px (gap) below eastbound, above westbound, as always; off a row (the stem, a leg, a ladder)
// its nearest corner gap px off the train's line, the top on a whole px.
export function tagAt(x, y, u, w, h, gap) {
  const v = rightOf(u);
  if (!v.x) return { cx: x, ty: v.y > 0 ? y + gap : y - gap - h };
  const d = gap + Math.abs(v.x) * w / 2 + Math.abs(v.y) * h / 2;
  return { cx: x + v.x * d, ty: Math.round(y + v.y * d - h / 2) };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// The item closest to the pick point within HIT px, or null.
function nearest(items, dist) {
  let best = null, bd = HIT;
  for (const it of items) { const d = dist(it); if (d <= bd) { bd = d; best = it; } }
  return best;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = 1;
  const r = { camera: { x: 0, y: 0, zoom: 1 } };
  const X = gx => (gx * CELL - r.camera.x) * r.camera.zoom; // grid cell -> screen px
  const Y = gy => (gy * CELL - r.camera.y) * r.camera.zoom;
  const lineW = () => Math.max(2, 3 * r.camera.zoom);

  // Eased state per id (spec "Fades"): edge ids, 'sw:<node>', 'stub:<edge>:<node>', '<signal>:<head>' lamps and
  // 'h<signal>:<head>' their halos, scalars 'hl:<train>' headlight, 'eot:<train>' tail marker, 'tag:<train>' its tag,
  // 'lock:<node>' padlock, 'slow' label, 'night' the night level. First sight starts at `from` (default the target:
  // snaps); an id not drawn in a frame is dropped.
  const fade = new Map(), seen = new Set();
  let dt = 0, lastNow = -Infinity, lastSlow = null, capAt = null; // capAt: the caption's text and the box it shows in
  function eased(id, to, tau, from = to) {
    let s = fade.get(id);
    if (!s) fade.set(id, (s = [...from]));
    const k = ease(0, 1, dt, tau);
    for (let i = 0; i < s.length; i++) s[i] += (to[i] - s[i]) * k;
    seen.add(id);
    return s;
  }
  const faded = (id, hex, tau = 120) => rgba(eased(id, rgb(hex), tau), 1);

  function line(x1, y1, x2, y2, color, width, cap = 'round') {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = cap;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  function text(str, x, y, font, color, align = 'center') {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillText(str, x, y);
  }
  function disc(x, y, rad, fill, stroke = null) {
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI);
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  // Additive radial glow: an ellipse of radii rx, ry turned to ang, rgb c at alpha a in the middle fading to nothing.
  function glow(x, y, rx, ry, ang, c, a) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y); ctx.rotate(ang); ctx.scale(1, ry / rx);
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, rgba(c, a)); gr.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, rx, 0, 2 * Math.PI); ctx.fill();
    ctx.restore(); // back to source-over
  }
  function ring(x, y, rad, color, width) {
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }
  // `size` is the half-height; the point faces along unit vector u. n: across u, chosen so a chevron along a row
  // strokes from its upper arm either way.
  function chevron(x, y, u, size, color, width = 2) {
    const n = u.x < 0 ? { x: u.y, y: -u.x } : { x: -u.y, y: u.x };
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - u.x * size / 2 - n.x * size, y - u.y * size / 2 - n.y * size);
    ctx.lineTo(x + u.x * size / 2, y + u.y * size / 2);
    ctx.lineTo(x - u.x * size / 2 + n.x * size, y - u.y * size / 2 + n.y * size);
    ctx.stroke();
  }

  // Target colour: occupied, else its route's, else amber on the slow order's section, else idle.
  function edgeColor(sim, id, idle) {
    const st = sim.edgeState[id];
    if (st.occ.size) return COLORS.occupied;
    if (st.route === null) return sim.layout.edges[id].section === sim.slowOrder?.section ? COLORS.slow : idle;
    return sim.routes.get(st.route)?.human ? COLORS.human : COLORS.route;
  }

  // Signal sizes at this zoom (brief sizes at zoom >= 1, never below 3 px a lamp). Two heads stack outward
  // (top head nearest the track) when a row has room for them; at tighter zooms they sit side by side, the
  // bottom head upstream, so the glyph never reaches the neighbouring track. reach: the largest glyph's
  // extent from the track centre. Rows and the stem column share the cell, so the same sizes serve a stem.
  function sigSize() {
    const z = r.camera.zoom, lw = lineW(), rad = clamp(4 * z, 3, 4), off = clamp(7 * z, 4, 7);
    const stack = CELL * z >= off + 4 * rad + 2 + lw;
    return { lw, rad, off, stack, reach: off + (stack ? 4 * rad + 1 : 2 * rad) };
  }
  // Head centres in screen px, on the right-hand side of travel past it (v = rightOf(f), f its facing): below an
  // eastbound signal, above a westbound one, west of one facing down a stem, east of one facing up it. The second
  // head goes further out along v, or upstream (-f) when side by side.
  function signalGeom(sim, sig) {
    const n = sim.layout.nodes[sig.node], x = X(n.x), y = Y(n.y), f = facingOf(sim.layout, sig), v = rightOf(f);
    const { lw, rad, off, stack } = sigSize();
    if (sig.kind === 'dwarf') {
      const dr = clamp(3.5 * r.camera.zoom, 3, 3.5), c = [x + v.x * (lw / 2 + 2 + dr), y + v.y * (lw / 2 + 2 + dr)];
      return { x, y, f, v, rad: dr, heads: [c], centre: c, extent: dr };
    }
    const h1 = [x + v.x * (off + rad), y + v.y * (off + rad)], heads = [h1];
    if (signalHeads(sim, sig.id) === 2)
      heads.push(stack ? [h1[0] + v.x * (2 * rad + 1), h1[1] + v.y * (2 * rad + 1)] : [h1[0] - f.x * (2 * rad + 1), h1[1] - f.y * (2 * rad + 1)]);
    const centre = [(heads[0][0] + heads.at(-1)[0]) / 2, (heads[0][1] + heads.at(-1)[1]) / 2];
    return { x, y, f, v, rad, heads, centre, extent: rad + (heads.length - 1) * (rad + 0.5) };
  }

  // Fills the window (a fixed canvas keeps its 300x150 intrinsic size under inset:0) with a backing store
  // at devicePixelRatio; draw() maps CSS px onto it.
  r.resize = () => {
    dpr = devicePixelRatio || 1;
    canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  };

  // Fits columns 0..cols-1 and rows -1..rows (the module names above the top tracks, the portal labels
  // beyond both mains) with a 40 px margin, into box (screen px; default the whole window, the UI passes
  // the area its docked panels leave free); from row -2 with a north junction, whose branch label sits above the
  // module names. fitted computes that camera, fit applies it.
  r.fitted = (layout, box = { x: 0, y: 0, w: innerWidth, h: innerHeight }) => {
    const top = layout.wye?.side === 'north' ? -2 : -1, { w, h } = box, bw = (layout.cols - 1) * CELL, bh = (layout.rows - top) * CELL;
    const zoom = Math.min((w - 2 * MARGIN) / bw, (h - 2 * MARGIN) / bh);
    return { x: bw / 2 - (box.x + w / 2) / zoom, y: (layout.rows + top) * CELL / 2 - (box.y + h / 2) / zoom, zoom };
  };
  r.fit = (layout, box) => Object.assign(r.camera, r.fitted(layout, box));

  // ponytail: redraws everything every frame (a few hundred paths on the largest seed). Cache the static
  // track/label layer in an offscreen canvas if it ever shows in a profile.
  r.draw = (sim, ui = {}) => {
    const L = sim.layout, { nodes, edges } = L, z = r.camera.zoom, lw = lineW(), cellPx = CELL * z, now = ui.now ?? 0;
    dt = clamp(now - lastNow, 0, 100); lastNow = now; seen.clear();
    // The night level as shown: eased, so a Day length change crossfades the page (the sim's traffic reads the raw level);
    // within 0.001 it settles exactly. r.night: for the page chrome and the HUD sky.
    const n0 = nightOf(sim), nt = eased('night', [n0], 150);
    if (Math.abs(nt[0] - n0) < 1e-3) nt[0] = n0;
    const night = r.night = nt[0], dim = c => mix(c, '#000000', 0.15 * night); // night palette
    const P = { bg: mix(COLORS.bg, '#070b17', night), track: mix(COLORS.track, '#6c7590', night), label: dim(COLORS.label), dim: dim(COLORS.dim) };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; // a throw last frame can't leak state

    // 1. Background (no grid).
    ctx.fillStyle = P.bg; ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    // 2. Edges, idle first so routes and occupancy win at shared nodes. The unselected leg of each switch
    // is dim for its first STUB cells at the points, so the lie reads without dimming a whole track; the stub fades
    // (colour and width) when the switch throws.
    const legAt = new Map(); // edge id -> [node, unselected] per switch it is a leg of
    for (const [node, sw] of sim.switchAt) {
      const off = sim.switchState.get(node).lie === 'normal' ? sw.reverse : sw.normal;
      for (const leg of [sw.normal, sw.reverse]) legAt.set(leg, [...(legAt.get(leg) ?? []), [node, leg === off]]);
    }
    const rank = c => (c === COLORS.occupied ? 2 : c === COLORS.route || c === COLORS.human ? 1 : 0);
    for (const pass of [0, 1, 2]) for (const e of edges) {
      const color = edgeColor(sim, e.id, P.track);
      if (rank(color) !== pass) continue;
      const a = nodes[e.a], b = nodes[e.b], legs = legAt.get(e.id) ?? [], f = Math.min(0.5, STUB / e.len);
      const t0 = legs.some(([nd]) => nd === e.a) ? f : 0, t1 = legs.some(([nd]) => nd === e.b) ? 1 - f : 1;
      const px = t => X(a.x + t * (b.x - a.x)), py = t => Y(a.y + t * (b.y - a.y));
      for (const [nd, off] of legs) { // [r, g, b, dimness]: dim is trackDim at 2 px, else the edge's colour and width
        const st = eased(`stub:${e.id}:${nd}`, [...rgb(off ? COLORS.trackDim : color), off ? 1 : 0], 120), [u, v] = nd === e.a ? [0, t0] : [t1, 1];
        line(px(u), py(u), px(v), py(v), rgba(st, 1), lerp(lw, 2, st[3]), 'butt');
      }
      line(px(t0), py(t0), px(t1), py(t1), faded(e.id, color), lw);
    }

    // 3. Tracks. The right-hand side of travel is the outer side: no two labels or boxes share a gap. Mid-gap
    // when rows are tight, else hugging their own track so they don't read as the neighbour's.
    const labelPx = clamp(cellPx * 0.45, 11, 14), bh = clamp(cellPx * 0.56, 9, 18);
    for (const t of L.tracks) {
      const ns = t.edges.flatMap(id => [nodes[edges[id].a], nodes[edges[id].b]]), y = Y(ns[0].y);
      const lo = Math.min(...ns.map(n => n.x)), hi = Math.max(...ns.map(n => n.x));
      if (t.cls === 'platform') {
        // The exit signal stands a cell in from the exit end, its second head upstream at tight zooms; keep
        // the box clear of it and of both ladders.
        const x0 = X(lo + (t.dir < 0 ? 2 : 0.5)), x1 = X(hi - (t.dir > 0 ? 2 : 0.5));
        const cy = y + t.dir * Math.min(cellPx / 2, lw / 2 + 3 + bh / 2);
        ctx.fillStyle = COLORS.platform; ctx.beginPath(); ctx.roundRect(x0, cy - bh / 2, x1 - x0, bh, 3); ctx.fill();
        if (night) { // platform lights: a warm band beyond the box, fading away from it
          const b0 = cy + t.dir * bh / 2, b1 = b0 + t.dir * cellPx / 2, gr = ctx.createLinearGradient(0, b0, 0, b1);
          gr.addColorStop(0, rgba(rgb('#ffd9a0'), 0.35 * night)); gr.addColorStop(1, rgba(rgb('#ffd9a0'), 0));
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = gr; ctx.fillRect(x0, Math.min(b0, b1), x1 - x0, cellPx / 2);
          ctx.globalCompositeOperation = 'source-over';
        }
        text(t.name, (x0 + x1) / 2, cy, `bold ${labelPx}px ${SANS}`, WHITE);
      } else {
        const cy = y + t.dir * Math.min(cellPx / 2, lw / 2 + 9);
        text(t.name, X((lo + hi) / 2), cy, `small-caps ${labelPx}px ${SANS}`, P.dim);
      }
    }
    ctx.letterSpacing = '1px'; // names lifted 6 px clear of a row-0 label or platform box at tight zooms
    for (const p of L.places) text(p.name.toUpperCase(), X(p.x), Y(p.y) - 6, `13px ${SANS}`, P.label);
    ctx.letterSpacing = '0px';
    // Slow order: SLOW 20 at the section's midpoint in the row between the mains (empty but for crossovers, which sit
    // in the gaps between sections). The last order is kept so its label fades out with the amber.
    if (sim.slowOrder) lastSlow = sim.slowOrder;
    const sa = eased('slow', [sim.slowOrder ? 1 : 0], 120)[0];
    if (lastSlow && sa > 0.01) {
      ctx.globalAlpha = sa;
      text(`SLOW ${SLOW_ORDER.mph}`, X((lastSlow.x0 + lastSlow.x1) / 2), Y(L.mainRow[-1] + 1), `11px ${SANS}`, '#f0b429');
      ctx.globalAlpha = 1;
    }

    // Headlights: a glow 2.5 cells long ahead of each moving loco's front, along travel; fades with its motion, and in
    // from nothing when a train enters (as does its tail marker).
    const lagOf = t => (1 - (ui.alpha ?? 1)) * (t.adv ?? 0); // interpolate between sim steps
    const drawn = [...sim.trains.values()].map(t => [t, trainBlocks(sim, t, lagOf(t))]).filter(([, bl]) => bl.length);
    for (const [t, [h]] of drawn) {
      const a = eased(`hl:${t.id}`, [t.speed > 0 ? lerp(0.22, 0.55, night) : 0], 200, [0])[0];
      const fx = X(h.x1), fy = Y(h.y1), ang = Math.atan2(fy - Y(h.y2), fx - X(h.x2)), d = 1.25 * cellPx;
      if (a > 0.005 && d > 0) glow(fx + d * Math.cos(ang), fy + d * Math.sin(ang), d, 0.6 * cellPx, ang, rgb('#fff1c4'), a);
    }

    // 4. Portals: a chevron pointing in just off the end of the main or stem; the place name on the right-hand side
    // of entering travel. At a west or east portal it sits beyond the main (below Main 2 at the west end, above Main 1
    // at the east end), clear of the signals and the tag of a train standing there, running inward, and 8. puts the
    // queue count a line further out. At a junction's branch portal (a stem's end at the top or bottom edge) the
    // stem's signals and a train standing at them fill both sides of its last cells, so the name, with the count on
    // the line under it, sits beyond the panel edge beside the chevron, running away from the stem: below the bottom
    // edge; at the top above the module names' row (13 px, centred 6 px above row -1), since at overview zooms the
    // label is wider than the stretch between the stem and the next module's name.
    const reach = Math.max(sigSize().reach + 12, 36);
    const portalAt = p => {
      const n = nodes[p.node], x = X(n.x), y = Y(n.y), f = INTO[p.side];
      if (!f.y) return { x, y, f, tx: x - f.x * 6, ty: y + f.x * reach, qy: y + f.x * (reach + 15), align: f.x > 0 ? 'left' : 'right' };
      const v = rightOf(f), ty = f.y > 0 ? Y(-1) - 6 - 31 : y + 14;
      return { x, y, f, tx: x + v.x * 12, ty, qy: ty + 15, align: v.x < 0 ? 'right' : 'left' };
    };
    for (const p of L.portals) {
      const a = portalAt(p);
      chevron(a.x - a.f.x * 14, a.y - a.f.y * 14, a.f, 5, P.label);
      text(`to ${p.name}`, a.tx, a.ty, `12px ${SANS}`, P.label, a.align);
    }

    // 5. Switches: a dot coloured like the trunk; a padlock when locked (fading in and out), above at or above Main 1,
    // else below; at a junction's apex (its trunk the stem) beside it, on the left of travel toward the main, away
    // from the stem signal's heads and clear of the stem and both legs.
    for (const sw of L.switches) {
      const n = nodes[sw.node], x = X(n.x), y = Y(n.y), up = n.y <= L.mainRow[-1] ? -1 : 1, lk = `lock:${sw.node}`;
      const te = edges[sw.trunk], t = nodes[te.a === sw.node ? te.b : te.a];
      const [lx, ly] = t.x === n.x ? [x + Math.sign(n.y - t.y) * (lw / 2 + 9), y] : [x, y + up * (lw / 2 + 9)];
      disc(x, y, Math.max(2.5, 0.8 * lw), faded(`sw:${sw.node}`, edgeColor(sim, sw.trunk, P.track)));
      const locked = switchLocked(sim, sw.node), la = locked || fade.get(lk)?.[0] > 0.01 ? eased(lk, [locked ? 1 : 0], 120, [0])[0] : 0;
      if (la > 0.01) {
        ctx.globalAlpha = la; ctx.strokeStyle = P.label; ctx.lineWidth = 1.5;
        ctx.strokeRect(lx - 3.5, ly - 1.5, 7, 5.5);
        ctx.beginPath(); ctx.arc(lx, ly - 1.5, 2.5, Math.PI, 0); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (ui.selectedSwitch === sw.node)
        text(sim.switchState.get(sw.node).lie === 'normal' ? 'N' : 'R', x, y - up * 12, `bold 11px ${SANS}`, WHITE);
    }

    // 6. Signals.
    for (const sig of L.signals) {
      const g = signalGeom(sim, sig), lp = lamps(aspectOf(sim, sig.id), sig.kind, g.heads.length);
      if (sig.kind !== 'dwarf') { // stub mast from the track to the heads; a bar joins side-by-side heads
        const [hx, hy] = g.heads.at(-1);
        line(g.x + g.v.x * lw / 2, g.y + g.v.y * lw / 2, g.heads[0][0], g.heads[0][1], P.track, 2, 'butt');
        line(g.heads[0][0], g.heads[0][1], hx, hy, P.track, 2, 'butt');
      }
      const ls = g.heads.map((_, i) => { // [lamp, halo rgb]; an unlit halo fades to black, which adds nothing
        const code = i ? lp.bottom : lp.top, lit = code[0] !== 'F' || ui.blink, hex = COLORS.lamp[code.at(-1)];
        return [faded(`${sig.id}:${i}`, lit ? hex : LAMP_OFF, 60), eased(`h${sig.id}:${i}`, rgb(lit ? hex : '#000000'), 60)];
      });
      g.heads.forEach(([hx, hy], i) => { // a halo faded to (near) black adds nothing: skip its gradient
        if (ls[i][1].some(c => c >= 8)) glow(hx, hy, 3 * g.rad, 3 * g.rad, 0, ls[i][1], lerp(0.18, 0.45, night));
      });
      g.heads.forEach(([hx, hy], i) => disc(hx, hy, g.rad, ls[i][0], P.bg));
      chevron(g.heads[0][0] + g.f.x * (g.rad + 5), g.heads[0][1] + g.f.y * (g.rad + 5), g.f, 4, P.label); // 4 px wide, along the facing
      const [cx, cy] = g.centre, rr = g.extent + 4;
      if (ui.refusedSignal === sig.id) ring(cx, cy, rr + 1, COLORS.lamp.R, 3); // NX refusal flash
      else if (ui.armedSignal === sig.id) {
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin((ui.now ?? 0) / 120);
        ring(cx, cy, rr + 1, WHITE, 2);
        ctx.globalAlpha = 1;
      } else if (ui.selectedSignal === sig.id) ring(cx, cy, rr, WHITE, 2);
      else if (ui.hoverSignal === sig.id) ring(cx, cy, rr, P.dim, 1.5);
    }

    // 7. Trains: loco in the type colour, cars at 70 % alpha over a bg underlay, 1 px gaps; a red marker on the tail,
    // outlined like a lamp, blinking with flashing aspects (steady when they're off); tags on top.
    // ponytail: no collision avoidance; tags draw after everything else on the panel, so they stay readable.
    const tw = Math.max(4, 5 * z), tags = [];
    for (const [t, bl] of drawn) {
      const col = COLORS.types[t.type] ?? COLORS.label, sel = ui.selectedTrain === t.id;
      for (const b of bl) {
        const x1 = X(b.x1), y1 = Y(b.y1), x2 = X(b.x2), y2 = Y(b.y2), len = Math.hypot(x2 - x1, y2 - y1);
        if (!len) continue;
        const trim = Math.max(0, Math.min(tw / 2 + 0.5, len / 2 - 0.25)), ux = (x2 - x1) / len * trim, uy = (y2 - y1) / len * trim;
        if (sel) line(x1 + ux, y1 + uy, x2 - ux, y2 - uy, WHITE, tw + 3);
        line(x1 + ux, y1 + uy, x2 - ux, y2 - uy, P.bg, tw);
        ctx.globalAlpha = b.kind === 'loco' ? 1 : 0.7;
        line(x1 + ux, y1 + uy, x2 - ux, y2 - uy, col, tw);
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = eased(`eot:${t.id}`, [ui.blink ? 1 : 0], 60, [0])[0];
      disc(X(bl.at(-1).x2), Y(bl.at(-1).y2), Math.max(1.5, 1.6 * z), COLORS.lamp.R, P.bg);
      ctx.globalAlpha = 1;
      const a = eased(`tag:${t.id}`, [1], 120, [0])[0]; // fades in when the train enters
      const h = bl[0], dx = h.x1 - h.x2, dy = h.y1 - h.y2, l = Math.hypot(dx, dy); // the head block's travel (head end first)
      tags.push({ t, col, sel, a, x: Math.round((X(h.x1) + X(h.x2)) / 2), y: Math.round((Y(h.y1) + Y(h.y2)) / 2), // whole px: crisp text, no shimmer
        u: l ? { x: dx / l, y: dy / l } : { x: t.dir, y: 0 } });
    }
    ctx.font = `11px ${MONO}`;
    const gap = Math.max(10, tw / 2 + 5);
    for (const { t, col, sel, a, x, y, u } of tags) { // on the right of the head block's travel
      const tw2 = ctx.measureText(t.name).width + 8, th = 15, { cx, ty } = tagAt(x, y, u, tw2, th, gap);
      ctx.globalAlpha = a; ctx.fillStyle = TAG_BG; ctx.fillRect(cx - tw2 / 2, ty, tw2, th);
      ctx.strokeStyle = sel ? WHITE : col; ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(cx - tw2 / 2 + 0.5, ty + 0.5, tw2 - 1, th - 1);
      text(t.name, cx, ty + th / 2 + 0.5, `11px ${MONO}`, col);
    }
    ctx.globalAlpha = 1;

    // 8. Queue at each entry portal, with its name.
    for (const p of L.portals) {
      const n = sim.queue[p.id]?.length ?? 0, a = portalAt(p);
      if (n) text(`+${n} waiting`, a.tx, a.qy, `12px ${SANS}`, P.dim, a.align);
    }

    // Caption (the idle camera's), bottom-left of the box it frames: the box it was first shown in, until it fades to
    // nothing or changes text (a panel toggled mid-fade doesn't jump it).
    const cap = ui.caption?.text && ui.caption.alpha > 0 ? ui.caption : null;
    if (cap?.text !== capAt?.text) capAt = cap && { text: cap.text, box: { ...(ui.box ?? { x: 0, y: 0, w: canvas.width / dpr, h: canvas.height / dpr }) } };
    if (cap) {
      const { box } = capAt;
      ctx.globalAlpha = cap.alpha;
      text(cap.text, box.x + 16, box.y + box.h - 16, `12px ${SANS}`, P.dim, 'left');
      ctx.globalAlpha = 1;
    }
    for (const id of fade.keys()) if (!seen.has(id)) fade.delete(id);
  };

  // Signals first, then switches (id = node), then train blocks, then routed edges (id = route id).
  r.pick = (sim, clientX, clientY) => {
    const rect = canvas.getBoundingClientRect(), px = clientX - rect.left, py = clientY - rect.top;
    const { nodes, edges } = sim.layout;
    const sig = nearest(sim.layout.signals, s => { const [cx, cy] = signalGeom(sim, s).centre; return Math.hypot(px - cx, py - cy); });
    if (sig) return { kind: 'signal', id: sig.id };
    const sw = nearest(sim.layout.switches, s => Math.hypot(px - X(nodes[s.node].x), py - Y(nodes[s.node].y)));
    if (sw) return { kind: 'switch', id: sw.node };
    const tr = nearest(sim.trains.values(), t =>
      Math.min(...trainBlocks(sim, t).map(b => segDist(px, py, X(b.x1), Y(b.y1), X(b.x2), Y(b.y2)))));
    if (tr) return { kind: 'train', id: tr.id };
    const seg = e => segDist(px, py, X(nodes[e.a].x), Y(nodes[e.a].y), X(nodes[e.b].x), Y(nodes[e.b].y));
    const ed = nearest(edges.filter(e => sim.edgeState[e.id].route !== null), seg);
    return ed ? { kind: 'route', id: sim.edgeState[ed.id].route } : null;
  };

  return r;
}
