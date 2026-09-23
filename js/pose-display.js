/* Visual interpolation ONLY. Never feed these points into a detector.
   No extrapolation: a missing hand cannot fly on along a guessed path. */
const PoseDisplay = (() => {
  const valid = p => Array.isArray(p) && p.every(Number.isFinite);
  function create() {
    let joints = {}, lastSample = null, interval = 33;
    function at(j, now) {
      const t = Math.max(0, Math.min(1, (now - j.start) / j.duration));
      return [j.from[0] + (j.to[0] - j.from[0]) * t,
        j.from[1] + (j.to[1] - j.from[1]) * t];
    }
    function push(pose, visibility, now, latencyMs = 0) {
      const measured = lastSample === null ? latencyMs : now - lastSample;
      // Expand immediately for a slow detector; contract gradually. Holding
      // the latest observed pose between results does not make it a new sample.
      interval = Math.max(interval * 0.7 + Math.min(1000, measured) * 0.3,
        Math.min(1000, measured), Math.min(1000, latencyMs));
      lastSample = now;
      for (const key of new Set([...Object.keys(joints), ...Object.keys(pose || {})])) {
        const raw = pose?.[key];
        const good = valid(raw) && (visibility == null || (visibility[key] || 0) > 0);
        let j = joints[key];
        if (!good) { if (j) { j.visible = false; j.pending = null; } continue; }
        if (!j) {
          joints[key] = { from: raw.slice(), to: raw.slice(), start: now,
            duration: 1, lastGood: now, visible: true, pending: null };
          continue;
        }
        const current = at(j, now);
        const jump = Math.hypot(raw[0] - current[0], raw[1] - current[1]);
        // Large reacquisition: fade the old point, then place the new one.
        // Never morph an old skeleton across the whole screen.
        if (jump > 0.22 && now - j.lastGood < 500) {
          if (!j.pending) j.pending = { since: now };
          j.visible = false;
          if (now - j.pending.since < 230) continue;
        }
        const snap = !!j.pending || now - j.lastGood > 500;
        j.from = snap ? raw.slice() : current;
        j.to = raw.slice();
        j.start = now;
        j.duration = Math.max(16, Math.min(45, interval * 0.8));
        j.lastGood = now;
        j.visible = true;
        j.pending = null;
      }
    }
    function sample(now) {
      const pose = {}, visibility = {};
      for (const [key, j] of Object.entries(joints)) {
        pose[key] = at(j, now);
        const holdMs = Math.max(200, Math.min(1500, interval * 1.5));
        visibility[key] = j.visible && now - j.lastGood <= holdMs ? 1 : 0;
        // Keep stationary display points only long enough to fade out.
        if (!visibility[key] && now - j.lastGood > holdMs + 1000) delete joints[key];
      }
      if (valid(pose.lshoulder) && valid(pose.rshoulder)) {
        pose.neck = [(pose.lshoulder[0] + pose.rshoulder[0]) / 2,
          (pose.lshoulder[1] + pose.rshoulder[1]) / 2];
        visibility.neck = Math.min(visibility.lshoulder, visibility.rshoulder);
      }
      return { pose, visibility };
    }
    return { push, sample };
  }
  return { create };
})();
