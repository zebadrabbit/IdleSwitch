// node tests/test_camera.mjs — the idle camera (src/camera.js): eased tweens, centring, shots, drift, caption fades.
import assert from 'node:assert/strict';
import { generate } from '../src/gen.js';
import { createSim, step, pointAt } from '../src/sim.js';
import { makeRng } from '../src/rng.js';
import { CELL } from '../src/render.js';
import { smoothstep, tween, centreOn, createIdleCamera, followCandidates, signalCandidates, MOVE_MS, CAPTION_MS,
  IDLE_CAM_MS } from '../src/camera.js';

assert.deepEqual([MOVE_MS, CAPTION_MS, IDLE_CAM_MS], [1000, 400, 60000]);

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
const box = { x: 0, y: 0, w: 1000, h: 500 };
assert.deepEqual(centreOn({ x: 240, y: 120 }, box, 2), { x: 240 - 250, y: 120 - 125, zoom: 2 });

// Idle camera: nothing moving -> overview; a moving train -> follow leads its head by 3 cells; train gone -> shot ends
const S = createSim(generate('lebanon'), 'lebanon', { density: 'busy' }); S.auto = true;
const fit = { x: 0, y: 0, zoom: 0.5 }, lag = () => 0, cam = createIdleCamera({ rng: makeRng('cam') });
const first = cam.update(S, 0, { fit, box, lag, active: true });
assert.ok(first && Math.abs(first.zoom - fit.zoom) <= 0.05 * fit.zoom, 'starts on the overview (drift allowed)');
while (!followCandidates(S, lag).length) step(S);
for (const id of signalCandidates(S)) {
  const s = S.layout.signals[id];
  assert.ok(s.kind === 'high' && Object.values(S.layout.mainRow).includes(S.layout.nodes[s.node].y), 'signal shots: high signals on a main');
}
cam.reset();
let shot = null;
for (let t = 0; t < 60000 && !shot; t += 100) { const u = cam.update(S, t, { fit, box, lag, active: true }); if (u?.caption?.text.startsWith('following')) shot = { t, u }; }
assert.ok(shot, 'a follow shot starts within a minute');
assert.match(shot.u.caption.text, /^following \S+ \d+ · (east|west)bound to \S+/);
// Caption fade-in: the shot began one frame (100 ms) before its caption first shows; 200 ms in it is half up.
const fadeIn = cam.update(S, shot.t + 100, { fit, box, lag, active: true }).caption;
assert.ok(fadeIn.text === shot.u.caption.text && Math.abs(fadeIn.alpha - 0.5) <= 0.1, `caption fades in (${fadeIn.alpha})`);
const tr = [...S.trains.values()].find(t => shot.u.caption.text.startsWith(`following ${t.name}`));
const late = cam.update(S, shot.t + MOVE_MS + 5000, { fit, box, lag, active: true });
const head = pointAt(S, tr, tr.headDist), want = centreOn({ x: (head.x + 3 * tr.dir) * CELL, y: head.y * CELL }, box, late.zoom);
assert.ok(Math.abs(late.x - want.x) < 0.7 * CELL && Math.abs(late.y - want.y) < 0.4 * CELL, 'follows the head led by 3 cells (drift allowed)');
assert.ok(Math.abs(late.zoom - 1.5) <= 0.04 * 1.5, 'follow zoom clamp(3 x fit, fit, 3) (drift allowed)');
S.trains.delete(tr.id);
cam.update(S, shot.t + MOVE_MS + 5100, { fit, box, lag, active: true }); // the frame the train vanished: shot ends, caption starts fading
// Caption fade-out: 200 ms after the change the old text is half down.
const fadeOut = cam.update(S, shot.t + MOVE_MS + 5300, { fit, box, lag, active: true }).caption;
assert.ok(fadeOut.text === shot.u.caption.text && Math.abs(fadeOut.alpha - 0.5) <= 0.1, `caption fades out (${fadeOut.alpha})`);
const after = cam.update(S, shot.t + MOVE_MS + 5100 + CAPTION_MS + 50, { fit, box, lag, active: true });
assert.ok(!after.caption || !after.caption.text.startsWith(`following ${tr.name}`), 'follow ends when the train is gone');
assert.ok(after.zoom < late.zoom, 'and the camera is easing back toward the overview');
cam.reset();
assert.equal(cam.update(S, 99999, { fit, box, lag, active: false }), null);

// No hard cuts: 5 minutes of 60 fps frames over a running sim (1x). Frame to frame the box centre moves under 40 px
// with its velocity changing under 4 px/frame, zoom steps under 5 %, and the caption only changes text near alpha 0.
const c2 = createIdleCamera({ rng: makeRng('sweep') }), mid = c => ({ x: c.x + 500 / c.zoom, y: c.y + 250 / c.zoom });
let p = null, v0 = null, changes = 0;
for (let now = 0, acc = 0; now < 300000; now += 16) {
  if ((acc += 16) >= 1000) { acc -= 1000; step(S); }
  const u = c2.update(S, now, { fit, box, lag: t => (1 - acc / 1000) * (t.adv ?? 0), active: true });
  if (p) {
    const a = mid(p), b = mid(u), v = { x: (b.x - a.x) * u.zoom, y: (b.y - a.y) * u.zoom };
    assert.ok(Math.hypot(v.x, v.y) < 40 && (!v0 || Math.hypot(v.x - v0.x, v.y - v0.y) < 4), `smooth at ${now} ms`);
    assert.ok(Math.abs(Math.log(u.zoom / p.zoom)) < 0.05, `zoom eases at ${now} ms`);
    if (p.caption?.text !== u.caption?.text) changes++, assert.ok(Math.max(p.caption?.alpha ?? 0, u.caption?.alpha ?? 0) <= 0.05);
    v0 = v;
  }
  p = u;
}
assert.ok(changes >= 4, `the sweep covers several shots (${changes} caption changes)`);

// Input (reset) hands the camera back at once but fades the caption: caption only (no camera fields), then null.
let t0 = 300000;
for (let u; !(u?.caption?.alpha === 1) && t0 < 400000; t0 += 16) u = c2.update(S, t0, { fit, box, lag, active: true });
t0 -= 16;
c2.reset();
const fading = c2.update(S, t0 + 200, { fit, box, lag, active: false });
assert.ok(fading && fading.x == null && fading.y == null && fading.zoom == null && Math.abs(fading.caption.alpha - 0.5) <= 0.1,
  'after reset the caption fades out alone');
assert.equal(c2.update(S, t0 + 450, { fit, box, lag, active: false }), null);

console.log('camera ok');
