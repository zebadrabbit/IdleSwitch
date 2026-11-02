// Idle camera (spec "Idle camera"): after IDLE_CAM_MS without input ui.js hands the camera to this module, which
// alternates the fitted overview with close shots (follow a moving train, or watch a mainline signal), every move
// eased, a slow drift while a shot holds, a crossfaded caption. Pure: all time comes in as now (ms), randomness from
// the rng handed in. Camera convention as render.js: {x, y} the world-px point at the canvas's top-left, zoom screen
// px per world px.
import { pointAt, exitNodes, signalLabel, MPH } from './sim.js';
import { CELL } from './render.js';
import { pick } from './rng.js';

export const MOVE_MS = 1000, CAPTION_MS = 400, IDLE_CAM_MS = 60000;
export const PAUSE_MS = 100, FRAME_MS = 16; // a gap between frames over PAUSE_MS is a pause (background tab): counts as FRAME_MS
const CHASE_MS = 500; // tau of the chase after a shot's target (a follow's moving head, a resized fit)
const FOLLOW_S = 8;   // real seconds a follow candidate must still run, at its speed, before its exit end
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v)); // lo wins: a close shot never zooms out past the fit

export const smoothstep = x => (x = clamp(x, 0, 1)) * x * (3 - 2 * x);
// ms the clocks skip for a gap of gap ms between frames: all of it but one frame when it was a pause, else none.
export const pauseSkip = gap => (gap > PAUSE_MS ? gap - FRAME_MS : 0);

// Smoothstep over MOVE_MS: the world point under pivot (screen px) moves linearly and zoom geometrically, so a move
// pivoting on the box centre glides that centre straight; done (and exactly to) from MOVE_MS on. v: the velocity the
// camera had when the move began ({x, y} world px/ms of the point under pivot, z log-zoom/ms; default still), carried
// in: the start point keeps moving at v, slowing with tau CHASE_MS, and the smoothstep blends it into the target, so
// a move never starts with a jolt.
export function tween(from, to, startMs, pivot = { x: 0, y: 0 }, v = null) {
  from = { ...from }; to = { ...to }; pivot = { ...pivot }; v = { x: 0, y: 0, z: 0, ...v }; // copies: callers mutate theirs
  const under = c => ({ x: c.x + pivot.x / c.zoom, y: c.y + pivot.y / c.zoom }), a = under(from), b = under(to);
  return {
    at(nowMs) {
      const t = (nowMs - startMs) / MOVE_MS, s = smoothstep(t);
      if (t >= 1) return { x: to.x, y: to.y, zoom: to.zoom, done: true };
      const k = CHASE_MS * (1 - Math.exp(-Math.max(0, nowMs - startMs) / CHASE_MS)); // ms travelled at v so far
      const ax = a.x + v.x * k, ay = a.y + v.y * k, zoom = from.zoom * Math.exp(v.z * k * (1 - s)) * (to.zoom / from.zoom) ** s;
      return { x: ax + (b.x - ax) * s - pivot.x / zoom, y: ay + (b.y - ay) * s - pivot.y / zoom, zoom, done: false };
    },
  };
}

// The camera putting world point w (px) at the centre of box (screen px) at zoom.
export const centreOn = (w, box, zoom) =>
  ({ x: w.x - (box.x + box.w / 2) / zoom, y: w.y - (box.y + box.h / 2) / zoom, zoom });

const headAt = (sim, t, lag = () => 0) => pointAt(sim, t, t.headDist - lag(t)); // the drawn head, grid cells

// Moving over 15 mph on a path, its head at least FOLLOW_S real seconds short of its exit end at its speed. simSpeed:
// sim seconds per real second (default 10, the UI's 1x).
export const followCandidates = (sim, lag, simSpeed = 10) => [...sim.trains.values()].filter(t => {
  const h = t.speed / MPH > 15 && t.path.length && headAt(sim, t, lag);
  return h && Math.abs(sim.layout.nodes[exitNodes(sim, t)[0]].x - h.x) / (t.speed * simSpeed) >= FOLLOW_S;
});

// High signals on a main with a moving train of their direction approaching on their row within 12 cells (a standing
// train or a route alone is dead air).
export function signalCandidates(sim) {
  const { signals, nodes, mainRow } = sim.layout, trains = [...sim.trains.values()];
  return signals.filter(s => {
    const n = nodes[s.node];
    return s.kind === 'high' && (n.y === mainRow[1] || n.y === mainRow[-1]) && trains.some(t => {
      const h = t.dir === s.dir && t.speed > 0 && headAt(sim, t);
      return h && h.y === n.y && (n.x - h.x) * s.dir > 0 && Math.abs(n.x - h.x) <= 12;
    });
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
  let skew = 0, vel = null, prev = null; // ms skipped over pauses; the box-centre point's velocity and where it was
  const reset = () => { shot = last = chase = vel = prev = null; cap.want = null; }; // the caption fades out, never cut

  // Overview after a close shot (or to start); after an overview, follow (0.6 if any), else signal, else overview.
  function next(sim, now, lag, simSpeed) {
    const overview = { kind: 'overview', until: now + 25000 + 20000 * rng() };
    if (shot?.kind !== 'overview') return overview;
    const f = followCandidates(sim, lag, simSpeed), s = signalCandidates(sim);
    if (f.length && rng() < 0.6) return { kind: 'follow', train: pick(rng, f).id, moved: now, until: now + 40000 };
    if (!s.length) return overview;
    const id = pick(rng, s);
    return { kind: 'signal', signal: id, passed: Infinity, until: now + 45000, text: `watching ${signalLabel(sim, id)}` };
  }

  // Ends early when the subject is lost: a follow's train gone, off its path or stood 8 s; a signal 6 s after a head
  // passes its node (any train, crossing in its direction of travel). ponytail: a terminus train reversing at a pull-ahead
  // signal counts as passing it (its head moves back past the node and its direction flips): the shot ends 6 s later.
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

  // A follow's caption, read every frame: a terminus train's direction flips when it reverses, its exit when it departs.
  const textOf = (sim, sh) => {
    const t = sh.kind === 'follow' && sim.trains.get(sh.train);
    return t ? `following ${t.name} · ${t.dir > 0 ? 'east' : 'west'}bound to ${sim.layout.portals[t.exit].name}` : sh.text ?? null;
  };

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
    // camera: the renderer's camera, where the first move of a fresh run starts (default fit). simSpeed: sim seconds per
    // real second (default 10). Not active: the caption alone while it fades ({x: null, y: null, zoom: null, caption}),
    // then null. Active: the camera, its caption and the shot ({kind, since}). A gap over PAUSE_MS between calls is a
    // pause: every clock (shots, moves, drift, caption) picks up where it left off.
    update(sim, now, { fit, box, lag, active, camera, simSpeed = 10 }) {
      const gap = then == null ? 0 : now - then, dt = gap > PAUSE_MS ? FRAME_MS : gap;
      then = now;
      now -= (skew += pauseSkip(gap));
      if (!active) {
        reset();
        const c = caption(null, dt);
        return c && { x: null, y: null, zoom: null, caption: c };
      }
      if (!shot || over(sim, now, lag)) { // a new move starts where and when the last frame was, at the velocity it had
        shot = { ...next(sim, now, lag, simSpeed), since: prev?.now ?? now, from: { ...(last ?? camera ?? fit) }, v: vel };
        chase = null;
      }
      // Every target is chased (tau CHASE_MS); a still one is simply sat on. The opening tween lands on the chase.
      const to = target(sim, fit, box, lag), k = 1 - Math.exp(-dt / CHASE_MS);
      chase = chase ? { x: chase.x + (to.x - chase.x) * k, y: chase.y + (to.y - chase.y) * k,
        zoom: chase.zoom + (to.zoom - chase.zoom) * k } : { ...to };
      const pivot = { x: box.x + box.w / 2, y: box.y + box.h / 2 }; // moves glide the box centre straight
      const { x, y, zoom } = tween(shot.from, chase, shot.since, pivot, shot.v).at(now);
      last = drift({ x, y, zoom }, box, (now - shot.since) / 1000, shot.kind === 'overview' ? 1 / 3 : 1);
      const p = { x: last.x + pivot.x / last.zoom, y: last.y + pivot.y / last.zoom, z: Math.log(last.zoom), now }, d = now - prev?.now;
      if (d > 0) vel = { x: (p.x - prev.x) / d, y: (p.y - prev.y) / d, z: (p.z - prev.z) / d };
      prev = p;
      return { ...last, caption: caption(textOf(sim, shot), dt), shot: { kind: shot.kind, since: shot.since } };
    },
  };
}
