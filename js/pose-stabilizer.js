/* ============================================================
   FORMA — POSE STABILIZER V0.3
   Model-independent temporal filtering of FORMA 2D keypoints.

   update(pose, visibility, timestampMs) returns display keypoints.
   getVisibility() returns matching reliability for analysis:
   a held/rejected point is drawable, but has reliability zero.

   Projected limb lengths may change with viewing angle. Only
   abrupt relative changes are questioned, never clamped to a
   fixed anatomy template. Consistency is not proof of accuracy.
   ============================================================ */

const PoseStabilizer = (function () {
  const CONFIG = {
    minVisibility: 0.35,
    releaseVisibility: 0.22,  // hysteresis: keep a tracked knee through small dips
    minCutoffHz: 1.5,
    speedGain: 5.5,           // body lengths / second -> adaptive cutoff
    maxCutoffHz: 18,
    velocityCutoffHz: 4,
    maxJump: 0.18,            // upper bound in normalized image coordinates
    holdMs: 350,
    predictMs: 80,
    reacquireMs: 160,
    confirmFrames: 3,
    confirmMs: 60,
    maxCandidateGapMs: 200,
    jumpBodyRatio: 0.40,
    lengthChangeRatio: 0.45,
    lengthBodyRatio: 0.12,
    candidateBodyRatio: 0.09
  };

  // Compatibility with earlier saved frames. New backends should provide
  // reliability under the same FORMA names as their coordinates.
  const LEGACY_VISIBILITY = {
    head: 'NOSE',
    lshoulder: 'LEFT_SHOULDER', rshoulder: 'RIGHT_SHOULDER',
    lelbow: 'LEFT_ELBOW', relbow: 'RIGHT_ELBOW',
    lwrist: 'LEFT_WRIST', rwrist: 'RIGHT_WRIST',
    lhip: 'LEFT_HIP', rhip: 'RIGHT_HIP',
    lknee: 'LEFT_KNEE', rknee: 'RIGHT_KNEE',
    lankle: 'LEFT_ANKLE', rankle: 'RIGHT_ANKLE'
  };

  const SEGMENTS = [
    ['lshoulder', 'lelbow'], ['lelbow', 'lwrist'],
    ['rshoulder', 'relbow'], ['relbow', 'rwrist'],
    ['lshoulder', 'lhip'], ['rshoulder', 'rhip'],
    ['lhip', 'lknee'], ['lknee', 'lankle'],
    ['rhip', 'rknee'], ['rknee', 'rankle']
  ];
  const PARENT = {
    head: 'lshoulder',
    lelbow: 'lshoulder', lwrist: 'lelbow',
    relbow: 'rshoulder', rwrist: 'relbow',
    lknee: 'lhip', lankle: 'lknee',
    rknee: 'rhip', rankle: 'rknee'
  };

  let state = {};
  let lastTime = null;
  let lastPose = null;
  let effectiveVisibility = {};
  let analysisPose = {};
  let displayVisibility = {};
  let filteredScale = 0.25;
  const JOINTS = Object.keys(LEGACY_VISIBILITY);

  function validPoint(p) {
    return Array.isArray(p) && p.length >= 2 &&
      Number.isFinite(p[0]) && Number.isFinite(p[1]);
  }

  function clonePoint(p) { return validPoint(p) ? [p[0], p[1]] : null; }
  function distance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function subtract(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function alphaFor(hz, dt) { return 1 - Math.exp(-2 * Math.PI * hz * dt); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function clonePose(pose) {
    if (!pose) return null;
    return Object.fromEntries(Object.entries(pose).map(([key, p]) => [key, clonePoint(p)]));
  }
  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  function visibilityFor(joint, visibility) {
    const value = visibility?.[joint] ?? visibility?.[LEGACY_VISIBILITY[joint]];
    // No map is the legacy optional-visibility contract. A supplied map
    // with a missing/invalid entry does not establish reliability.
    if (value === undefined && visibility == null) return 1;
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }

  function update(pose, visibility, timestamp) {
    const now = Number.isFinite(timestamp) ? timestamp : performance.now();
    if (lastTime !== null && now < lastTime) reset();
    // Re-rendering the same video frame must not confirm a suspect point.
    if (lastTime === now) return clonePose(lastPose);
    const dt = lastTime === null ? 1000 / 30 : now - lastTime;
    lastTime = now;
    const seconds = clamp(dt / 1000, 0.001, 0.1);
    const frameFactor = clamp(dt / (1000 / 30), 1, 3);
    const input = pose || {};
    const joints = JOINTS;
    const reliable = {};
    const vis = {};
    for (const joint of joints) {
      vis[joint] = visibilityFor(joint, visibility);
      const tracked = state[joint] && now - state[joint].time <= CONFIG.holdMs;
      reliable[joint] = validPoint(input[joint]) &&
        vis[joint] >= (tracked ? CONFIG.releaseVisibility : CONFIG.minVisibility);
    }
    const fresh = joint => state[joint] && now - state[joint].time <= CONFIG.holdMs;

    // Estimate scale from accepted torso segments, falling back to limbs.
    // Never use a questionable new coordinate to enlarge its own tolerance.
    const lengths = pairs => pairs.flatMap(([a, b]) => {
      if (!fresh(a) || !fresh(b)) return [];
      const length = distance(state[a].raw, state[b].raw);
      return length > 0.015 ? [length] : [];
    });
    const torso = lengths([['lshoulder', 'lhip'], ['rshoulder', 'rhip']]);
    const limb = torso.length ? torso : lengths(SEGMENTS);
    if (limb.length) {
      const measuredScale = clamp(median(limb), 0.06, 0.65);
      filteredScale += (measuredScale - filteredScale) * alphaFor(1, seconds);
    }
    const bodyScale = filteredScale;

    // Remove coherent body translation before testing individual jumps.
    // Three anchors are required so one stray hip cannot move the baseline.
    const deltas = ['lshoulder', 'rshoulder', 'lhip', 'rhip']
      .filter(key => reliable[key] && fresh(key))
      .map(key => subtract(input[key], state[key].raw));
    const translation = deltas.length >= 3
      ? [median(deltas.map(p => p[0])), median(deltas.map(p => p[1]))]
      : [0, 0];
    // Coherent movement is usually legitimate, but a one-frame whole-body
    // teleport must not bypass rejection just because every anchor jumped.
    if (Math.hypot(...translation) > Math.min(0.16, bodyScale * 0.7) * frameFactor) {
      translation[0] = 0;
      translation[1] = 0;
    }
    const movement = {};
    const suspect = new Set();
    const jumpLimit = Math.min(CONFIG.maxJump,
      Math.max(0.025, bodyScale * CONFIG.jumpBodyRatio)) * frameFactor;
    for (const joint of joints) {
      if (!reliable[joint] || !fresh(joint)) continue;
      movement[joint] = distance(subtract(input[joint], state[joint].raw), translation);
      if (movement[joint] > jumpLimit) suspect.add(joint);
    }

    // Compare successive projections, not a fixed bone length. Attribute
    // a sudden distortion only when one endpoint moves markedly more.
    for (const [a, b] of SEGMENTS) {
      if (!reliable[a] || !reliable[b] || !fresh(a) || !fresh(b)) continue;
      const oldLength = distance(state[a].raw, state[b].raw);
      const newLength = distance(input[a], input[b]);
      const tolerance = Math.max(0.02, bodyScale * CONFIG.lengthBodyRatio,
        oldLength * CONFIG.lengthChangeRatio) * frameFactor;
      if (Math.abs(newLength - oldLength) <= tolerance) continue;
      const fast = movement[a] > movement[b] ? a : b;
      const slow = fast === a ? b : a;
      if (movement[fast] > movement[slow] * 1.5 + Math.max(0.012, bodyScale * 0.05)) {
        suspect.add(fast);
      }
    }

    const result = {};
    effectiveVisibility = {};
    analysisPose = {};
    displayVisibility = {};
    for (const joint of joints) {
      const raw = input[joint];
      const previous = state[joint];
      const age = previous ? now - previous.time : Infinity;
      let accept = reliable[joint];
      const needsConfirmation = previous && (suspect.has(joint) || age > CONFIG.holdMs);
      if (!accept) {
        if (previous) previous.candidate = null;
      } else if (needsConfirmation) {
        const parent = PARENT[joint];
        const anchor = parent && reliable[parent] && !suspect.has(parent) ? parent : null;
        const candidatePoint = anchor ? subtract(raw, input[anchor]) : clonePoint(raw);
        const candidate = previous.candidate;
        const radius = Math.max(0.018, bodyScale * CONFIG.candidateBodyRatio);
        // Follow a moving candidate, not a fixed origin. A fast, consistent
        // leg movement must be accepted after three real camera frames.
        const candidateDt = candidate ? (now - candidate.lastTime) / 1000 : 0;
        const predicted = candidate ? [
          candidate.point[0] + candidate.vx * candidateDt,
          candidate.point[1] + candidate.vy * candidateDt
        ] : null;
        const continues = candidate && candidate.anchor === anchor &&
          now - candidate.lastTime <= CONFIG.maxCandidateGapMs &&
          distance(candidatePoint, predicted) <= radius + bodyScale * 1.8 * candidateDt;
        previous.candidate = continues
          ? { anchor, point: candidatePoint, startTime: candidate.startTime,
              lastTime: now, count: candidate.count + 1,
              vx: (candidatePoint[0] - candidate.point[0]) / Math.max(0.001, candidateDt),
              vy: (candidatePoint[1] - candidate.point[1]) / Math.max(0.001, candidateDt) }
          : { anchor, point: candidatePoint, startTime: now, lastTime: now, count: 1, vx: 0, vy: 0 };
        accept = previous.candidate.count >= CONFIG.confirmFrames &&
          now - previous.candidate.startTime >= CONFIG.confirmMs;
      }

      if (accept) {
        const returning = previous && (age > 65 || previous.candidate);
        const born = !previous || age > CONFIG.holdMs;
        const speedAlpha = alphaFor(CONFIG.velocityCutoffHz, seconds);
        const velocityOK = previous && age <= 120 && !previous.candidate;
        const vx = velocityOK ? previous.vx + speedAlpha *
          ((raw[0] - previous.raw[0]) / Math.max(age / 1000, 0.001) - previous.vx) : 0;
        const vy = velocityOK ? previous.vy + speedAlpha *
          ((raw[1] - previous.raw[1]) / Math.max(age / 1000, 0.001) - previous.vy) : 0;
        const speed = Math.hypot(vx, vy) / bodyScale;
        const quality = clamp(vis[joint] / CONFIG.minVisibility, 0.65, 1);
        const cutoff = clamp(CONFIG.minCutoffHz + CONFIG.speedGain * speed,
          CONFIG.minCutoffHz, CONFIG.maxCutoffHz) * quality;
        const alpha = alphaFor(cutoff, seconds);
        const recoverUntil = returning ? now + CONFIG.reacquireMs : (previous?.recoverUntil || 0);
        const point = born ? clonePoint(raw) : [
          previous.point[0] + (raw[0] - previous.point[0]) * alpha,
          previous.point[1] + (raw[1] - previous.point[1]) * alpha
        ];
        if (!born && now < recoverUntil) {
          const step = distance(previous.point, point);
          const limit = Math.max(0.004, bodyScale * 3 * seconds);
          if (step > limit) {
            point[0] = previous.point[0] + (point[0] - previous.point[0]) * limit / step;
            point[1] = previous.point[1] + (point[1] - previous.point[1]) * limit / step;
          }
        }
        // Expired points reappear with a fade; short gaps reconnect with a
        // bounded correction. No anatomy clamp and no second display filter.
        const opacity = previous ? Math.min(1, (born ? 0 : previous.opacity) + dt / 100) : 1;
        state[joint] = { point, holdPoint: clonePoint(point), raw: clonePoint(raw),
          time: now, vx, vy, opacity, recoverUntil, candidate: null };
        result[joint] = clonePoint(point);
        const observedInFrame = raw[0] >= 0 && raw[0] <= 1 && raw[1] >= 0 && raw[1] <= 1;
        effectiveVisibility[joint] = observedInFrame ? vis[joint] : 0;
        analysisPose[joint] = observedInFrame ? clonePoint(raw) : null;
        displayVisibility[joint] = opacity;
      } else {
        if (previous && age <= CONFIG.holdMs) {
          // Damped prediction is limited to 80 ms and a small displacement.
          const horizon = CONFIG.predictMs / 1000 * (1 - Math.exp(-age / CONFIG.predictMs));
          const speed = Math.hypot(previous.vx, previous.vy);
          const travel = Math.min(horizon, bodyScale * 0.08 / Math.max(speed, 0.001));
          previous.point = [previous.holdPoint[0] + previous.vx * travel,
            previous.holdPoint[1] + previous.vy * travel];
          previous.opacity = clamp((CONFIG.holdMs - age) / (CONFIG.holdMs - CONFIG.predictMs), 0, 1);
          result[joint] = clonePoint(previous.point);
          displayVisibility[joint] = previous.opacity;
        } else {
          result[joint] = null;
          displayVisibility[joint] = 0;
          if (previous) previous.opacity = 0;
        }
        effectiveVisibility[joint] = 0;
        analysisPose[joint] = null;
      }
    }

    const ls = result.lshoulder;
    const rs = result.rshoulder;
    result.neck = validPoint(ls) && validPoint(rs)
      ? [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2]
      : null;
    effectiveVisibility.neck = Math.min(effectiveVisibility.lshoulder, effectiveVisibility.rshoulder);
    displayVisibility.neck = Math.min(displayVisibility.lshoulder, displayVisibility.rshoulder);
    const als = analysisPose.lshoulder, ars = analysisPose.rshoulder;
    analysisPose.neck = als && ars ? [(als[0] + ars[0]) / 2, (als[1] + ars[1]) / 2] : null;
    lastPose = clonePose(result);
    return result;
  }

  function getVisibility() { return { ...effectiveVisibility }; }
  function getAnalysisPose() { return clonePose(analysisPose); }
  function getDisplayVisibility() { return { ...displayVisibility }; }
  function reset() {
    state = {};
    lastTime = null;
    lastPose = null;
    effectiveVisibility = {};
    analysisPose = {};
    displayVisibility = {};
    filteredScale = 0.25;
  }

  return { update, reset, getVisibility, getAnalysisPose, getDisplayVisibility };
})();
