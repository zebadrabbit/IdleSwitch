// Idle camera (spec "Idle camera"): after IDLE_CAM_MS without input ui.js hands the camera to this module, which
// alternates the fitted overview with close shots (follow a moving train, or watch a mainline signal), every move
// eased, a slow drift while a shot holds, a crossfaded caption. Pure: all time comes in as now (ms), randomness from
// the rng handed in. Camera convention as render.js: {x, y} the world-px point at the canvas's top-left, zoom screen
// px per world px.
import { pointAt, exitNodes, signalLabel, routeFrom, MPH } from './sim.js';
import { CELL } from './render.js';
import { pick } from './rng.js';

export const MOVE_MS = 1000, CAPTION_MS = 400, IDLE_CAM_MS = 60000;
const CHASE_MS = 500; // tau of the chase after a shot's target (a follow's moving head, a resized fit)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v)); // lo wins: a close shot never zooms out past the fit

export const smoothstep = x => (x = clamp(x, 0, 1)) * x * (3 - 2 * x);

// Smoothstep over MOVE_MS: the world point under pivot (screen px) moves linearly and zoom geometrically, so a move
// pivoting on the box centre glides that centre straight; done (and exactly to) from MOVE_MS on.
export function tween(from, to, startMs, pivot = { x: 0, y: 0 }) {
  const under = c => ({ x: c.x + pivot.x / c.zoom, y: c.y + pivot.y / c.zoom }), a = under(from), b = under(to);
  return {
    at(nowMs) {
      const t = (nowMs - startMs) / MOVE_MS, s = smoothstep(t), zoom = from.zoom * (to.zoom / from.zoom) ** s;
      if (t >= 1) return { x: to.x, y: to.y, zoom: to.zoom, done: true };
      return { x: a.x + (b.x - a.x) * s - pivot.x / zoom, y: a.y + (b.y - a.y) * s - pivot.y / zoom, zoom, done: false };
    },
  };
}

// The camera putting world point w (px) at the centre of box (screen px) at zoom.
export const centreOn = (w, box, zoom) =>
  ({ x: w.x - (box.x + box.w / 2) / zoom, y: w.y - (box.y + box.h / 2) / zoom, zoom });

const headAt = (sim, t, lag = () => 0) => pointAt(sim, t, t.headDist - lag(t)); // the drawn head, grid cells

// Moving over 15 mph on a path, head at least 6 cells short of its exit end.
export const followCandidates = (sim, lag) => [...sim.trains.values()].filter(t => {
  const h = t.speed / MPH > 15 && t.path.length && headAt(sim, t, lag);
  return h && Math.abs(sim.layout.nodes[exitNodes(sim, t.dir)[0]].x - h.x) >= 6;
});

// High signals on a main with a route set from them, or a train of their direction approaching within 12 cells.
export function signalCandidates(sim) {
  const { signals, nodes, mainRow } = sim.layout;
  return signals.filter(s => {
    const n = nodes[s.node];
    return s.kind === 'high' && (n.y === mainRow[1] || n.y === mainRow[-1]) && (routeFrom(sim, s.id) ||
      [...sim.trains.values()].some(t => {
        const h = t.dir === s.dir && headAt(sim, t);
        return h && (n.x - h.x) * s.dir > 0 && Math.abs(n.x - h.x) <= 12;
      }));
  }).map(s => s.id);
}

// Lissajous drift of the centre (cells) and zoom, t s into the shot; k scales the amplitudes (overview a third).
function drift(c, box, t, k) {
  const sin = p => Math.sin(2 * Math.PI * t / p);
  const x = c.x + (box.x + box.w / 2) / c.zoom, y = c.y + (box.y + box.h / 2) / c.zoom; // c's centre, world px
  return centreOn({ x: x + 0.6 * k * CELL * sin(23), y: y + 0.35 * k * CELL * sin(31) }, box,
    c.zoom * (1 + 0.04 * k * sin(37)));
}

export function createIdleCamera({ rng }) {
  let shot = null, last = null, then = null, chase = null, cap = { text: null, want: null, a: 0 };
  const reset = () => { shot = last = chase = null; cap.want = null; }; // the caption fades out, never cut

  // Overview after a close shot (or to start); after an overview, follow (0.6 if any), else signal, else overview.
  function next(sim, now, lag) {
    const overview = { kind: 'overview', until: now + 25000 + 20000 * rng() };
    if (shot?.kind !== 'overview') return overview;
    const f = followCandidates(sim, lag), s = signalCandidates(sim);
    if (f.length && rng() < 0.6) {
      const t = pick(rng, f), to = sim.layout.portals.find(p => p.dir === -t.dir).name;
      return { kind: 'follow', train: t.id, moved: now, until: now + 40000,
        text: `following ${t.name} · ${t.dir > 0 ? 'east' : 'west'}bound to ${to}` };
    }
    if (!s.length) return overview;
    const id = pick(rng, s);
    return { kind: 'signal', signal: id, passed: Infinity, until: now + 45000, text: `watching ${signalLabel(sim, id)}` };
  }

  // Ends early when the subject is lost: a follow's train gone, off its path or stood 8 s; a signal 6 s after a head
  // passes its node (any train, crossing in its direction of travel).
  function over(sim, now, lag) {
    if (now >= shot.until) return true;
    if (shot.kind === 'follow') {
      const t = sim.trains.get(shot.train);
      if (t?.speed > 0) shot.moved = now;
      return !t || !headAt(sim, t, lag) || now - shot.moved >= 8000;
    }
    if (shot.kind === 'signal') {
      const x = sim.layout.nodes[sim.layout.signals[shot.signal].node].x, side = new Map();
      for (const t of sim.trains.values()) { const h = headAt(sim, t, lag); if (h) side.set(t.id, (x - h.x) * t.dir); }
      if (shot.passed === Infinity && [...side].some(([id, d]) => d <= 0 && shot.side?.get(id) > 0)) shot.passed = now;
      shot.side = side;
      return now - shot.passed >= 6000;
    }
    return false;
  }

  function target(sim, fit, box, lag) {
    if (shot.kind === 'overview') return fit;
    if (shot.kind === 'signal') {
      const n = sim.layout.nodes[sim.layout.signals[shot.signal].node];
      return centreOn({ x: n.x * CELL, y: n.y * CELL }, box, clamp(2.5 * fit.zoom, fit.zoom, 2.5));
    }
    const t = sim.trains.get(shot.train), h = headAt(sim, t, lag);
    return centreOn({ x: (h.x + 3 * t.dir) * CELL, y: h.y * CELL }, box, clamp(3 * fit.zoom, fit.zoom, 3));
  }

  // One text at a time: a changed text first fades the old one out, then rises, each linear over CAPTION_MS. The
  // frame's dt applies to the previous frame's wanted text, so a change at now still shows the old alpha at now.
  function caption(want, dt) {
    const d = dt / CAPTION_MS;
    if (cap.want === cap.text) cap.a = cap.text ? Math.min(1, cap.a + d) : 0;
    else if ((cap.a -= d) <= 0) cap.a = (cap.text = cap.want) ? Math.min(1, -cap.a) : 0;
    cap.want = want;
    return cap.text && { text: cap.text, alpha: cap.a };
  }

  return {
    reset,
    // camera: the renderer's camera, where the first move of a fresh run starts (default fit). Not active: the
    // caption alone while it fades ({x: null, y: null, zoom: null, caption}), then null.
    update(sim, now, { fit, box, lag, active, camera }) {
      const dt = then == null ? 0 : now - then;
      then = now;
      if (!active) {
        reset();
        const c = caption(null, dt);
        return c && { x: null, y: null, zoom: null, caption: c };
      }
      if (!shot || over(sim, now, lag)) {
        shot = { ...next(sim, now, lag), since: now, from: last ?? camera ?? fit };
        chase = null;
      }
      // Every target is chased (tau CHASE_MS); a still one is simply sat on. The opening tween lands on the chase.
      const to = target(sim, fit, box, lag), k = 1 - Math.exp(-dt / CHASE_MS);
      chase = chase ? { x: chase.x + (to.x - chase.x) * k, y: chase.y + (to.y - chase.y) * k,
        zoom: chase.zoom + (to.zoom - chase.zoom) * k } : to;
      const pivot = { x: box.x + box.w / 2, y: box.y + box.h / 2 }; // moves glide the box centre straight
      const { x, y, zoom } = tween(shot.from, chase, shot.since, pivot).at(now);
      last = drift({ x, y, zoom }, box, (now - shot.since) / 1000, shot.kind === 'overview' ? 1 / 3 : 1);
      return { ...last, caption: caption(shot.text ?? null, dt) };
    },
  };
}
