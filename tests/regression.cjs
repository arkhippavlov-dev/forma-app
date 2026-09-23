// Run: node tests/regression.cjs (no dependencies).
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
function load(file, name, extra = {}) {
  const context = vm.createContext({ performance, console, ...extra });
  return vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8') + '\n' + name, context);
}
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS', name); }
const Display = load('pose-display.js', 'PoseDisplay');
test('display interpolates between real samples without changing measurements', () => {
  const d = Display.create();
  const raw = { lwrist: [0.4, 0.4] };
  d.push({ lwrist: [0.3, 0.4] }, { lwrist: 1 }, 0);
  d.push(raw, { lwrist: 1 }, 34);
  const a = d.sample(40).pose.lwrist[0], b = d.sample(50).pose.lwrist[0];
  assert(a > .3 && b > a && b < .4);
  assert.equal(raw.lwrist[0], .4);
  assert.equal(d.sample(120).pose.lwrist[0], .4); // no overshoot
});
test('missing arms freeze briefly and fade, never extrapolate', () => {
  const d = Display.create();
  d.push({ lwrist: [.4, .4] }, { lwrist: 1 }, 0);
  d.push(null, {}, 34);
  assert.equal(d.sample(50).pose.lwrist[0], .4);
  assert.equal(d.sample(50).visibility.lwrist, 0);
  d.push({ lwrist: [.45, .4] }, { lwrist: 1 }, 500);
  assert.equal(d.sample(550).visibility.lwrist, 1);
});
test('large reacquisition fades rather than sweeping across the screen', () => {
  const d = Display.create();
  d.push({ head: [.1, .1] }, { head: 1 }, 0);
  for (let t = 34; t < 250; t += 34) {
    d.push({ head: [.8, .1] }, { head: 1 }, t);
    assert.equal(d.sample(t).pose.head[0], .1);
    assert.equal(d.sample(t).visibility.head, 0);
  }
  d.push({ head: [.8, .1] }, { head: 1 }, 280);
  assert.equal(d.sample(280).pose.head[0], .8);
  assert.equal(d.sample(280).visibility.head, 1);
});
const stabilizer = load('pose-stabilizer.js', 'PoseStabilizer');
test('head-only and arm-only tracking needs no full body or standing pause', () => {
  stabilizer.reset();
  const p = stabilizer.update({ head: [.5, .1], lwrist: [.2, .4] }, { head: 1, lwrist: 1 }, 0);
  assert.equal(p.head[0], .5); assert.equal(p.lwrist[0], .2);
  assert.equal(stabilizer.getVisibility().lwrist, 1);
});
test('arm reacquires while moving after loss (no fixed-origin lock)', () => {
  stabilizer.reset();
  stabilizer.update({ lwrist: [.2, .4] }, { lwrist: 1 }, 0);
  stabilizer.update(null, null, 400);
  let p;
  for (let i = 0; i < 4; i++) p = stabilizer.update({ lwrist: [.4 + i * .04, .4] }, { lwrist: 1 }, 450 + 34 * i);
  assert(p.lwrist !== null);
  assert.equal(stabilizer.getVisibility().lwrist, 1);
});
test('short missing observation is drawable but not reliable for analysis', () => {
  stabilizer.reset();
  stabilizer.update({ head: [.5, .1] }, { head: 1 }, 0);
  assert(stabilizer.update(null, null, 34).head);
  assert.equal(stabilizer.getVisibility().head, 0);
  assert.equal(stabilizer.update(null, null, 500).head, null);
});
const detector = load('squat-detector.js', 'SquatDetector');
const capture = load('rep-capture.js', 'RepCapture');
function leg(angle, partial = false) {
  const a = angle * Math.PI / 180;
  const pose = { lhip: [.4, .4], lknee: [.4, .6] };
  if (!partial) pose.lankle = [.4 + .2 * Math.sin(a), .6 - .2 * Math.cos(a)];
  return pose;
}
test('one real squat produces one captured rep; renders do not duplicate it', () => {
  detector.reset(); capture.reset(); let t = 0, result;
  for (const angle of [180, 145, 110, 145, 180]) {
    for (let i = 0; i < 18; i++) {
      const pose = leg(angle), vis = { lhip: 1, lknee: 1, lankle: 1 };
      t += 34;
      result = detector.update(pose, vis, t);
      capture.update(result, pose, vis, t);
      const count = capture.getCurrentRep()?.frameCount;
      capture.update(result, pose, vis, t);
      assert.equal(capture.getCurrentRep()?.frameCount, count);
    }
  }
  assert.equal(result.reps, 1);
  assert.equal(capture.getCompletedReps().length, 1);
  for (let i = 0; i < 40; i++) detector.update(null, {}, t += 34);
  assert.equal(detector.update(leg(180), null, t += 34).reps, 1);
});
test('missing-data heartbeat does not inflate captured frame count', () => {
  capture.reset();
  capture.update({ state: 'descending', reps: 0, trackingAvailable: true }, leg(145), null, 0);
  const before = capture.getCurrentRep().frameCount;
  capture.update({ state: 'descending', reps: 0, trackingAvailable: false }, null, {}, 34);
  assert.equal(capture.getCurrentRep().frameCount, before);
});
test('renderer opacity fades, keeps arms, restores canvas state', () => {
  let now = 0; const stack = [], calls = [];
  const ctx = { globalAlpha: .8, save() { stack.push(this.globalAlpha); },
    restore() { this.globalAlpha = stack.pop(); }, beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
    stroke() { calls.push(this.globalAlpha); }, fill() { calls.push(this.globalAlpha); }, setLineDash() {} };
  const renderer = load('skeleton-renderer.js', 'SkeletonRenderer', {
    performance: { now: () => now }, window: { __formaVideoWidth: 100, __formaVideoHeight: 100 },
    document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => '#00ff00' })
  });
  const p = { lshoulder: [.4, .3], lelbow: [.3, .4], lwrist: [.2, .5] };
  const vis = { lshoulder: 1, lelbow: 1, lwrist: 1 };
  renderer.reset(); renderer.drawUser(ctx, 100, 100, p, {}, vis);
  assert(Math.max(...calls) < .8); calls.length = 0;
  for (let i = 0; i < 20; i++) { now += 17; renderer.drawUser(ctx, 100, 100, p, {}, vis); }
  assert(calls.includes(.8)); assert.equal(ctx.globalAlpha, .8);
  calls.length = 0; now += 34;
  renderer.drawUser(ctx, 100, 100, p, {}, { lshoulder: 0, lelbow: 0, lwrist: 0 });
  assert(Math.max(...calls) > 0 && Math.max(...calls) < .8);
});
console.log(`${checks} regression tests passed`);
