// Canvas renderer for the CTC panel: track, platforms, portals, switches, signals, trains, queue counts.
// Reads the sim, never writes it. Positions go through the camera; sizes are screen px (text never below
// 11 px, strokes never below 2 px) so a four-module terminal fitted to 1366 px (~15 px a cell) stays legible.
// World px = grid cell * CELL. camera {x, y} is the world-px point at the canvas's top-left corner and zoom
// the screen px per world px: screen = (world - camera) * zoom.
import { aspectOf, signalHeads, lamps, trainBlocks, switchLocked } from './sim.js';

export const CELL = 24;
export const COLORS = {
  bg: '#0b1020', track: '#8a93ab', trackDim: '#3a4463', route: '#39d353', occupied: '#ff4d4f', human: '#5aa9ff',
  label: '#cfd6ea', platform: '#1c2744', dim: '#7d88a6', // dim = --dim in style.css
  lamp: { R: '#ff3b30', Y: '#ffcc00', G: '#34c759' },
  types: { X: '#f5d90a', P: '#ffd166', Z: '#c77dff', M: '#5aa9ff', C: '#9aa0a6', G: '#e0a458', I: '#4cc9f0', L: '#8ac926' },
};
const TAG_BG = '#121a2e', LAMP_OFF = '#283252', WHITE = '#ffffff';
const SANS = 'system-ui, sans-serif', MONO = 'ui-monospace, Menlo, Consolas, monospace';
const HIT = 12;   // pick radius, screen px
const STUB = 0.6; // cells of a switch's unselected leg drawn dim at the points
const MARGIN = 40;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  function ring(x, y, rad, color, width) {
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }
  // `size` is the half-height; the point faces dir (+1 east, -1 west).
  function chevron(x, y, dir, size, color, width = 2) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - dir * size / 2, y - size); ctx.lineTo(x + dir * size / 2, y); ctx.lineTo(x - dir * size / 2, y + size);
    ctx.stroke();
  }

  function edgeColor(sim, id) {
    const st = sim.edgeState[id];
    if (st.occ.size) return COLORS.occupied;
    if (st.route === null) return COLORS.track;
    return sim.routes.get(st.route)?.human ? COLORS.human : COLORS.route;
  }

  // Signal sizes at this zoom (brief sizes at zoom >= 1, never below 3 px a lamp). Two heads stack outward
  // (top head nearest the track) when a row has room for them; at tighter zooms they sit side by side, the
  // bottom head upstream, so the glyph never reaches the neighbouring track. reach: the largest glyph's
  // extent from the track centre.
  function sigSize() {
    const z = r.camera.zoom, lw = lineW(), rad = clamp(4 * z, 3, 4), off = clamp(7 * z, 4, 7);
    const stack = CELL * z >= off + 4 * rad + 2 + lw;
    return { lw, rad, off, stack, reach: off + (stack ? 4 * rad + 1 : 2 * rad) };
  }
  // Head centres in screen px, on the right-hand side of travel: +y eastbound, -y westbound.
  function signalGeom(sim, sig) {
    const n = sim.layout.nodes[sig.node], x = X(n.x), y = Y(n.y), v = sig.dir, { lw, rad, off, stack } = sigSize();
    if (sig.kind === 'dwarf') {
      const dr = clamp(3.5 * r.camera.zoom, 3, 3.5), c = [x, y + v * (lw / 2 + 2 + dr)];
      return { x, y, v, rad: dr, heads: [c], centre: c, extent: dr };
    }
    const h1 = y + v * (off + rad), heads = [[x, h1]];
    if (signalHeads(sim, sig.id) === 2) heads.push(stack ? [x, h1 + v * (2 * rad + 1)] : [x - v * (2 * rad + 1), h1]);
    const centre = [(heads[0][0] + heads.at(-1)[0]) / 2, (heads[0][1] + heads.at(-1)[1]) / 2];
    return { x, y, v, rad, heads, centre, extent: rad + (heads.length - 1) * (rad + 0.5) };
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
  // the area its docked panels leave free).
  r.fit = (layout, box = { x: 0, y: 0, w: innerWidth, h: innerHeight }) => {
    const { w, h } = box, bw = (layout.cols - 1) * CELL, bh = (layout.rows + 1) * CELL;
    const zoom = Math.min((w - 2 * MARGIN) / bw, (h - 2 * MARGIN) / bh);
    r.camera.zoom = zoom;
    r.camera.x = bw / 2 - (box.x + w / 2) / zoom;
    r.camera.y = (layout.rows - 1) * CELL / 2 - (box.y + h / 2) / zoom;
  };

  // ponytail: redraws everything every frame (a few hundred paths on the largest seed). Cache the static
  // track/label layer in an offscreen canvas if it ever shows in a profile.
  r.draw = (sim, ui = {}) => {
    const L = sim.layout, { nodes, edges } = L, z = r.camera.zoom, lw = lineW(), cellPx = CELL * z;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Background (no grid).
    ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    // 2. Edges, idle first so routes and occupancy win at shared nodes. The unselected leg of each switch
    // is dim for its first STUB cells at the points, so the lie reads without dimming a whole track.
    const dimAt = new Map(); // edge id -> nodes where it is the unselected leg
    for (const [node, sw] of sim.switchAt) {
      const leg = sim.switchState.get(node).lie === 'normal' ? sw.reverse : sw.normal;
      dimAt.set(leg, [...(dimAt.get(leg) ?? []), node]);
    }
    const rank = c => (c === COLORS.track ? 0 : c === COLORS.occupied ? 2 : 1);
    for (const pass of [0, 1, 2]) for (const e of edges) {
      const color = edgeColor(sim, e.id);
      if (rank(color) !== pass) continue;
      const a = nodes[e.a], b = nodes[e.b], dims = dimAt.get(e.id) ?? [], f = Math.min(0.5, STUB / e.len);
      const t0 = dims.includes(e.a) ? f : 0, t1 = dims.includes(e.b) ? 1 - f : 1;
      const px = t => X(a.x + t * (b.x - a.x)), py = t => Y(a.y + t * (b.y - a.y));
      if (t0) line(px(0), py(0), px(t0), py(t0), COLORS.trackDim, 2, 'butt');
      if (t1 < 1) line(px(t1), py(t1), px(1), py(1), COLORS.trackDim, 2, 'butt');
      line(px(t0), py(t0), px(t1), py(t1), color, lw);
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
        text(t.name, (x0 + x1) / 2, cy, `bold ${labelPx}px ${SANS}`, WHITE);
      } else {
        const cy = y + t.dir * Math.min(cellPx / 2, lw / 2 + 9);
        text(t.name, X((lo + hi) / 2), cy, `small-caps ${labelPx}px ${SANS}`, COLORS.dim);
      }
    }
    ctx.letterSpacing = '1px'; // names lifted 6 px clear of a row-0 label or platform box at tight zooms
    for (const p of L.places) text(p.name.toUpperCase(), X(p.x), Y(p.y) - 6, `13px ${SANS}`, COLORS.label);
    ctx.letterSpacing = '0px';

    // 4. Portals: a chevron pointing in just off the end of the main; the place name beyond the main on the
    // right-hand side of travel (below Main 2 at the west end, above Main 1 at the east end), clear of the
    // signals and the tag of a train standing there, running inward. 8. puts the queue count a line further out.
    const reach = Math.max(sigSize().reach + 12, 36);
    const portalAt = p => { const n = nodes[p.node]; return { x: X(n.x), y: Y(n.y), align: p.dir > 0 ? 'left' : 'right' }; };
    for (const p of L.portals) {
      const a = portalAt(p);
      chevron(a.x - p.dir * 14, a.y, p.dir, 5, COLORS.label);
      text(`to ${p.name}`, a.x - p.dir * 6, a.y + p.dir * reach, `12px ${SANS}`, COLORS.label, a.align);
    }

    // 5. Switches: a dot coloured like the trunk; a padlock when locked, above at or above Main 1, else below.
    for (const sw of L.switches) {
      const n = nodes[sw.node], x = X(n.x), y = Y(n.y), up = n.y <= L.mainRow[-1] ? -1 : 1;
      disc(x, y, Math.max(2.5, 0.8 * lw), edgeColor(sim, sw.trunk));
      if (switchLocked(sim, sw.node)) {
        const ly = y + up * (lw / 2 + 9);
        ctx.strokeStyle = COLORS.label; ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 3.5, ly - 1.5, 7, 5.5);
        ctx.beginPath(); ctx.arc(x, ly - 1.5, 2.5, Math.PI, 0); ctx.stroke();
      }
      if (ui.selectedSwitch === sw.node)
        text(sim.switchState.get(sw.node).lie === 'normal' ? 'N' : 'R', x, y - up * 12, `bold 11px ${SANS}`, WHITE);
    }

    // 6. Signals.
    for (const sig of L.signals) {
      const g = signalGeom(sim, sig), lp = lamps(aspectOf(sim, sig.id), sig.kind, g.heads.length);
      if (sig.kind !== 'dwarf') { // stub mast from the track to the heads; a bar joins side-by-side heads
        const [hx, hy] = g.heads.at(-1);
        line(g.x, g.y + g.v * lw / 2, g.x, g.heads[0][1], COLORS.track, 2, 'butt');
        line(g.x, g.heads[0][1], hx, hy, COLORS.track, 2, 'butt');
      }
      g.heads.forEach(([hx, hy], i) => {
        const code = i ? lp.bottom : lp.top, lit = code[0] !== 'F' || ui.blink;
        disc(hx, hy, g.rad, lit ? COLORS.lamp[code.at(-1)] : LAMP_OFF, COLORS.bg);
      });
      chevron(g.x + sig.dir * (g.rad + 5), g.heads[0][1], sig.dir, 4, COLORS.label); // 4 px wide, pointing in dir
      const [cx, cy] = g.centre, rr = g.extent + 4;
      if (ui.refusedSignal === sig.id) ring(cx, cy, rr + 1, COLORS.lamp.R, 3); // NX refusal flash
      else if (ui.armedSignal === sig.id) {
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin((ui.now ?? 0) / 120);
        ring(cx, cy, rr + 1, WHITE, 2);
        ctx.globalAlpha = 1;
      } else if (ui.selectedSignal === sig.id) ring(cx, cy, rr, WHITE, 2);
      else if (ui.hoverSignal === sig.id) ring(cx, cy, rr, COLORS.dim, 1.5);
    }

    // 7. Trains: loco in the type colour, cars at 70 % alpha over a bg underlay, 1 px gaps; tags on top.
    // ponytail: no collision avoidance; tags draw after everything else on the panel, so they stay readable.
    const tw = Math.max(4, 5 * z), tags = [];
    for (const t of sim.trains.values()) {
      const bl = trainBlocks(sim, t);
      if (!bl.length) continue;
      const col = COLORS.types[t.type] ?? COLORS.label, sel = ui.selectedTrain === t.id;
      for (const b of bl) {
        const x1 = X(b.x1), y1 = Y(b.y1), x2 = X(b.x2), y2 = Y(b.y2), len = Math.hypot(x2 - x1, y2 - y1);
        if (!len) continue;
        const trim = Math.max(0, Math.min(tw / 2 + 0.5, len / 2 - 0.25)), ux = (x2 - x1) / len * trim, uy = (y2 - y1) / len * trim;
        if (sel) line(x1 + ux, y1 + uy, x2 - ux, y2 - uy, WHITE, tw + 3);
        line(x1 + ux, y1 + uy, x2 - ux, y2 - uy, COLORS.bg, tw);
        ctx.globalAlpha = b.kind === 'loco' ? 1 : 0.7;
        line(x1 + ux, y1 + uy, x2 - ux, y2 - uy, col, tw);
        ctx.globalAlpha = 1;
      }
      tags.push({ t, col, sel, x: (X(bl[0].x1) + X(bl[0].x2)) / 2, y: (Y(bl[0].y1) + Y(bl[0].y2)) / 2 });
    }
    ctx.font = `11px ${MONO}`;
    const gap = Math.max(10, tw / 2 + 5);
    for (const { t, col, sel, x, y } of tags) { // 10 px above the head block, below for eastbound
      const tw2 = ctx.measureText(t.name).width + 8, th = 15, ty = t.dir > 0 ? y + gap : y - gap - th;
      ctx.fillStyle = TAG_BG; ctx.fillRect(x - tw2 / 2, ty, tw2, th);
      ctx.strokeStyle = sel ? WHITE : col; ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(x - tw2 / 2 + 0.5, ty + 0.5, tw2 - 1, th - 1);
      text(t.name, x, ty + th / 2 + 0.5, `11px ${MONO}`, col);
    }

    // 8. Queue at each entry portal, under its name.
    for (const p of L.portals) {
      const n = sim.queue[p.dir]?.length ?? 0, a = portalAt(p);
      if (n) text(`+${n} waiting`, a.x - p.dir * 6, a.y + p.dir * (reach + 15), `12px ${SANS}`, COLORS.dim, a.align);
    }
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
