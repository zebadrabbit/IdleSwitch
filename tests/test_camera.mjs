// node tests/test_camera.mjs — the idle camera (src/camera.js): eased tweens, centring, shots, drift, caption fades.
import assert from 'node:assert/strict';
import { generate } from '../src/gen.js';
import { createSim, step, pointAt, despawnTrain, spawnTrain, setRoute, moveTrains, signalAhead, exitNodes } from '../src/sim.js';
import { makeRng } from '../src/rng.js';
import { CELL } from '../src/render.js';
import { smoothstep, tween, centreOn, createIdleCamera, followCandidates, signalCandidates, pauseSkip, MOVE_MS, CAPTION_MS,
  IDLE_CAM_MS, PAUSE_MS, FRAME_MS } from '../src/camera.js';

assert.deepEqual([MOVE_MS, CAPTION_MS, IDLE_CAM_MS, PAUSE_MS, FRAME_MS], [1000, 400, 60000, 100, 16]);
assert.deepEqual([pauseSkip(16), pauseSkip(100), pauseSkip(5000)], [0, 0, 4984]);

// Smoothstep: clamped, monotonic. Tween: x/y linear, zoom geometric, lands exactly however late the frame.
assert.deepEqual([smoothstep(-1), smoothstep(0), smoothstep(0.5), smoothstep(1), smoothstep(2)], [0, 0, 0.5, 1, 1]);
for (let x = 0; x < 1; x += 0.1) assert.ok(smoothstep(x + 0.1) >= smoothstep(x));
const tw = tween({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 50, zoom: 4 }, 1000);
assert.deepEqual(tw.at(1500), { x: 50, y: 25, zoom: 2, done: false });
assert.deepEqual(tw.at(5000), { x: 100, y: 50, zoom: 4, done: true }); // dt far past MOVE_MS lands exactly
// Pivot: the world point under a screen pivot moves linearly (a zoom about the box centre keeps it still).
const pv = { x: 500, y: 250 }, under = c => [c.x + pv.x / c.zoom, c.y + pv.y / c.zoom];
const mid2 = tween({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 50, zoom: 4 }, 1000, pv).at(1500);
const [u0, u1, uh] = [{ x: 0, y: 0, zoom: 1 }, { x: 100, y: 50, zoom: 4 }, mid2].map(under);
assert.ok(mid2.zoom === 2 && [0, 1].every(i => Math.abs(uh[i] - (u0[i] + u1[i]) / 2) < 1e-9), 'pivot point moves linearly');
// Tweens copy their endpoints: the caller mutating its camera in place mid-move changes nothing.
const fm = { x: 0, y: 0, zoom: 1 }, tm = { x: 100, y: 50, zoom: 4 }, twm = tween(fm, tm, 1000, pv), atm = twm.at(1500);
Object.assign(fm, { x: 7, y: 7, zoom: 3 }), Object.assign(tm, { x: 9, y: 9, zoom: 2 });
assert.deepEqual([twm.at(1500), twm.at(2000)], [atm, { x: 100, y: 50, zoom: 4, done: true }]);
// A move carries the velocity it starts with (world px/ms of the point under the pivot, log-zoom/ms): its first instant
// moves at v, the smoothstep then blends the still-moving start into the target, and it lands exactly.
const vv = { x: 0.2, y: -0.1, z: 0.001 }, twv = tween({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 50, zoom: 2 }, 0, pv, vv);
const [w0, w1] = [twv.at(0), twv.at(1)], [p0, p1] = [w0, w1].map(under);
assert.ok(Math.abs(p1[0] - p0[0] - vv.x) < 0.002 && Math.abs(p1[1] - p0[1] - vv.y) < 0.002
  && Math.abs(Math.log(w1.zoom / w0.zoom) - vv.z) < 2e-5, 'a move starts at the velocity carried in');
assert.deepEqual(twv.at(1000), { x: 100, y: 50, zoom: 2, done: true });
assert.deepEqual(tween({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 50, zoom: 4 }, 1000, pv, { x: 0, y: 0, z: 0 }).at(1500), mid2, 'still v: as before');
const box = { x: 0, y: 0, w: 1000, h: 500 };
assert.deepEqual(centreOn({ x: 240, y: 120 }, box, 2), { x: 240 - 250, y: 120 - 125, zoom: 2 });

// Idle camera: nothing moving -> overview; a moving train -> follow leads its head by 3 cells; train gone -> shot ends
const S = createSim(generate('lebanon'), 'lebanon', { density: 'busy' }); S.auto = true;
const fit = { x: 0, y: 0, zoom: 0.5 }, lag = () => 0, cam = createIdleCamera({ rng: makeRng('cam') });
const first = cam.update(S, 0, { fit, box, lag, active: true });
assert.ok(first && Math.abs(first.zoom - fit.zoom) <= 0.05 * fit.zoom, 'starts on the overview (drift allowed)');
while (!followCandidates(S, lag).length) step(S);
// Follow candidates still have 8 real s of running before their exit end at their speed: d cells to go at s cells per
// sim second qualifies at simSpeed d / 8s (sim s per real s) and not above it.
const fc = followCandidates(S, lag)[0], togo = Math.abs(S.layout.nodes[exitNodes(S, fc)[0]].x - pointAt(S, fc, fc.headDist).x);
const edge = togo / (fc.speed * 8);
assert.ok(edge >= 10 && followCandidates(S, lag, edge * 0.99).includes(fc) && !followCandidates(S, lag, edge * 1.01).includes(fc),
  'follow margin: 8 real seconds at the sim speed');
for (const id of signalCandidates(S)) {
  const s = S.layout.signals[id];
  assert.ok(s.kind === 'high' && Object.values(S.layout.mainRow).includes(S.layout.nodes[s.node].y), 'signal shots: high signals on a main');
}
// Signal candidates need a moving train of their direction approaching on their row: a lone train standing at the
// portal with a route set ahead gives none, running toward the route's exit signal gives it (not the signal level
// with it on the other main), stopped short of it none.
const S2 = createSim(generate('lebanon'), 'lebanon'), sig0 = signalAhead(S2, S2.layout.portals.find(p => p.dir === 1).node, null);
const cand = S2.routesFrom.get(sig0).find(c => c.exitSignal != null && S2.layout.nodes[c.exitNode].y === S2.layout.mainRow[1]);
const other = S2.routesFrom.get(sig0).find(c => c !== cand && c.exitSignal != null), lone = spawnTrain(S2, { type: 'P', dir: 1 });
assert.ok(S2.layout.nodes[other.exitNode].y === S2.layout.mainRow[-1]);
assert.ok(setRoute(S2, sig0, cand.exitNode, { trainId: lone.id }).ok);
assert.deepEqual(signalCandidates(S2), [], 'standing train and a set route: dead air');
for (let i = 0; i < 20; i++) moveTrains(S2);
const moving = signalCandidates(S2);
assert.ok(lone.speed > 0 && moving.includes(cand.exitSignal) && !moving.includes(other.exitSignal), 'moving on the row toward it');
for (let i = 0; i < 200 && lone.speed > 0; i++) moveTrains(S2);
assert.ok(lone.speed === 0 && pointAt(S2, lone, lone.headDist).x < S2.layout.nodes[cand.exitNode].x, 'stopped short of it');
assert.deepEqual(signalCandidates(S2), [], 'a stopped train is dead air');
cam.reset();
const opts = { fit, box, lag, active: true }, idleOpts = { ...opts, active: false };
// Frames every 16 ms after t0 up to t1: a gap over PAUSE_MS is a pause, so time passes in frames.
const play = (c, t0, t1, o = opts, sim = S) => { for (let t = t0 + 16; t < t1; t += 16) c.update(sim, t, o); return c.update(sim, t1, o); };
let shot = null;
for (let t = 0; t < 60000 && !shot; t += 100) { const u = cam.update(S, t, opts); if (u?.caption?.text.startsWith('following')) shot = { t, u }; }
assert.ok(shot, 'a follow shot starts within a minute');
assert.match(shot.u.caption.text, /^following \S+ \d+ · (east|west)bound to \S+/);
// Caption fade-in: the shot began one frame (100 ms) before its caption first shows; 200 ms in it is half up.
const fadeIn = cam.update(S, shot.t + 100, { fit, box, lag, active: true }).caption;
assert.ok(fadeIn.text === shot.u.caption.text && Math.abs(fadeIn.alpha - 0.5) <= 0.1, `caption fades in (${fadeIn.alpha})`);
const tr = [...S.trains.values()].find(t => shot.u.caption.text.startsWith(`following ${t.name}`));
assert.ok(shot.u.caption.text.endsWith(`bound to ${S.layout.portals[tr.exit].name}`), 'the caption names its exit portal');
const late = play(cam, shot.t + 100, shot.t + MOVE_MS + 5000);
const head = pointAt(S, tr, tr.headDist), want = centreOn({ x: (head.x + 3 * tr.dir) * CELL, y: head.y * CELL }, box, late.zoom);
assert.ok(Math.abs(late.x - want.x) < 0.7 * CELL && Math.abs(late.y - want.y) < 0.4 * CELL, 'follows the head led by 3 cells (drift allowed)');
assert.ok(Math.abs(late.zoom - 1.5) <= 0.04 * 1.5, 'follow zoom clamp(3 x fit, fit, 3) (drift allowed)');
despawnTrain(S, tr);
cam.update(S, shot.t + MOVE_MS + 5100, { fit, box, lag, active: true }); // the frame the train vanished: shot ends, caption starts fading
// Caption fade-out: 200 ms after the change the old text is half down.
const fadeOut = play(cam, shot.t + MOVE_MS + 5100, shot.t + MOVE_MS + 5300).caption;
assert.ok(fadeOut.text === shot.u.caption.text && Math.abs(fadeOut.alpha - 0.5) <= 0.1, `caption fades out (${fadeOut.alpha})`);
const after = play(cam, shot.t + MOVE_MS + 5300, shot.t + MOVE_MS + 5100 + CAPTION_MS + 50);
assert.ok(!after.caption || !after.caption.text.startsWith(`following ${tr.name}`), 'follow ends when the train is gone');
assert.ok(after.zoom < late.zoom, 'and the camera is easing back toward the overview');
cam.reset();
assert.equal(cam.update(S, 99999, { fit, box, lag, active: false }), null);

// No hard cuts: 5 minutes of 60 fps frames over a running sim at 1x (10 sim steps a second) and 4x (40). Frame to frame
// the box centre moves under 40 px with its velocity changing under 4 px/frame, at shot boundaries too (a new move
// carries the velocity the last frame had), zoom steps under 5 %, and the caption only changes text near alpha 0.
function sweep(speed) {
  const S = createSim(generate('lebanon'), 'lebanon', { density: 'busy' }), stepMs = 100 / speed, simSpeed = 10 * speed;
  S.auto = true;
  const c = createIdleCamera({ rng: makeRng('sweep') }), mid = c => ({ x: c.x + 500 / c.zoom, y: c.y + 250 / c.zoom });
  let p = null, v0 = null, changes = 0, now = 0;
  const bounds = []; // [speed into the boundary, velocity change across it], px/frame
  for (let acc = 0; now < 300000; now += 16) {
    for (acc += 16; acc >= stepMs; acc -= stepMs) step(S);
    const u = c.update(S, now, { fit, box, lag: t => (1 - acc / stepMs) * (t.adv ?? 0), active: true, simSpeed });
    if (p) {
      const a = mid(p), b = mid(u), v = { x: (b.x - a.x) * u.zoom, y: (b.y - a.y) * u.zoom };
      assert.ok(Math.hypot(v.x, v.y) < 40 && (!v0 || Math.hypot(v.x - v0.x, v.y - v0.y) < 4), `smooth at ${now} ms (${speed}x)`);
      assert.ok(Math.abs(Math.log(u.zoom / p.zoom)) < 0.05, `zoom eases at ${now} ms (${speed}x)`);
      if (p.caption?.text !== u.caption?.text) changes++, assert.ok(Math.max(p.caption?.alpha ?? 0, u.caption?.alpha ?? 0) <= 0.05);
      if (v0 && u.shot.since !== p.shot.since) bounds.push([Math.hypot(v0.x, v0.y), Math.hypot(v.x - v0.x, v.y - v0.y)]);
      v0 = v;
    }
    p = u;
  }
  assert.ok(changes >= 4, `the ${speed}x sweep covers several shots (${changes} caption changes)`);
  assert.ok(bounds.length >= 6 && bounds.every(([, dv]) => dv < 4), `${speed}x shot boundaries keep the velocity: ${JSON.stringify(bounds)}`);
  return { c, S, now, bounds };
}
const sw1 = sweep(1), sw4 = sweep(4);
const fastest = Math.max(...[...sw1.bounds, ...sw4.bounds].map(([s]) => s));
assert.ok(fastest > 4, `a shot ended mid-move (${fastest.toFixed(1)} px/frame), so the carry is exercised`);

// Input (reset) hands the camera back at once but fades the caption: caption only (no camera fields), then null.
const c2 = sw4.c;
let t0 = sw4.now;
while (c2.update(sw4.S, t0, opts).caption?.alpha !== 1 && t0 < sw4.now + 100000) t0 += 16;
assert.ok(t0 < sw4.now + 100000, 'a caption reaches full alpha before the reset check');
c2.reset();
const fading = play(c2, t0, t0 + 200, idleOpts, sw4.S);
assert.ok(fading && fading.x == null && fading.y == null && fading.zoom == null && Math.abs(fading.caption.alpha - 0.5) <= 0.1,
  'after reset the caption fades out alone');
assert.equal(play(c2, t0 + 200, t0 + 450, idleOpts, sw4.S), null);

// A pause (a background tab: no frames for 5 s) changes nothing: the next frame is the one 16 ms on, mid-move and
// mid-drift, and a fading caption picks up where it was.
{
  const mk = () => createIdleCamera({ rng: makeRng('pause') }), a = mk(), b = mk(), o = { ...opts, camera: { x: 300, y: 100, zoom: 2 } };
  play(a, -16, 400, o), play(b, -16, 400, o);
  assert.deepEqual([416, 432, 1600].map(t => a.update(S, t, o)), [5400, 5416, 6584].map(t => b.update(S, t, o)), 'a 5 s gap is one frame');
  a.reset(), b.reset();
  const ca = play(a, 1600, 1700, idleOpts), cb = play(b, 6584, 6684, idleOpts);
  assert.deepEqual([ca, a.update(S, 1716, idleOpts)], [cb, b.update(S, 11716, idleOpts)], 'and so is a 5 s gap in a caption fade');
}

// update copies the camera it starts from: Task 6 hands in r.camera and then assigns the result into it each frame.
const run = mutate => {
  const c = createIdleCamera({ rng: makeRng('copy') }), rc = { x: 300, y: 100, zoom: 2 }, out = [];
  for (let t = 0; t <= 1200; t += 100) {
    const u = c.update(S, t, { fit, box, lag, active: true, camera: rc });
    out.push([u.x, u.y, u.zoom]);
    if (mutate) Object.assign(rc, { x: u.x, y: u.y, zoom: u.zoom });
  }
  return out;
};
assert.deepEqual(run(true), run(false), 'the ease is unaffected by the caller mutating its camera');

// A junction (s3, north): a busy hour offers no shot of a stem signal (dir 0: off the mains), never follows a train up
// the stem to the branch (its exit is right above), and the head of a train on the stem, which a follow centres on,
// runs on without a jump through the turn onto a leg.
{
  const J = createSim(generate('s3'), 's3', { density: 'busy' }), sx = J.layout.nodes[J.layout.wye.A].x, prev = new Map();
  J.auto = true;
  let vertical = 0, jump = 0;
  for (let i = 0; i < 3600; i++) {
    step(J);
    assert.ok(signalCandidates(J).every(id => J.layout.signals[id].dir !== 0), 'no dir 0 signal shots');
    assert.ok(followCandidates(J, lag).every(t => t.exit !== J.layout.wye.portal || pointAt(J, t, t.headDist).x !== sx), 'no follow up the stem');
    for (const t of J.trains.values()) {
      const h = t.path.length && pointAt(J, t, t.headDist), p = prev.get(t.id);
      if (h && p && (h.x === sx || p.x === sx)) { jump = Math.max(jump, Math.hypot(h.x - p.x, h.y - p.y) - (t.adv ?? 0)); if (h.y !== p.y && h.x === sx) vertical++; }
      if (h) prev.set(t.id, h); else prev.delete(t.id);
    }
  }
  assert.ok(vertical > 0 && jump < 1e-9, `a head on the stem moves by its advance (${vertical} vertical steps, worst excess ${jump})`);
}

console.log('camera ok');
