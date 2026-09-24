/* ============================================================
   FORMA — POSE STABILIZER V0.3
   Stable display tracking for real gym conditions.

   Main idea:
   - high visibility = trust normally
   - low visibility is NOT an automatic rejection
   - if a low-confidence landmark continues along a plausible path,
     keep tracking it but smooth it more aggressively
   - impossible jumps are rejected / briefly held
   - analysis reliability remains the real MediaPipe visibility, so a
     visually stable point is not automatically treated as trustworthy
     for biomechanics
   ============================================================ */

const PoseStabilizer = (function () {
  const CONFIG = {
    // Visibility policy.
    strongVisibility: 0.35,
    weakVisibility: 0.06,

    // How long a temporarily lost point can stay visible.
    holdMs: 500,

    // Hard jump guard in normalized image coordinates.
    maxJump: 0.18,
    jumpBodyRatio: 0.40,

    // Sudden bone-projection change guard.
    lengthChangeRatio: 0.48,
    lengthBodyRatio: 0.13,

    // Confirmation for genuinely suspicious relocations.
    confirmFrames: 3,
    confirmMs: 60,
    maxCandidateGapMs: 220,
    candidateBodyRatio: 0.10,

    // Adaptive smoothing.
    // Standing / tiny movement is smoothed strongly.
    // Fast real movement becomes more responsive.
    alphaStill: 0.18,
    alphaNormal: 0.34,
    alphaFast: 0.62,
    alphaWeak: 0.14,
    slowMotionBodyRatio: 0.025,
    fastMotionBodyRatio: 0.10
  };

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

  function validPoint(p) {
    return Array.isArray(p) && p.length >= 2 &&
      Number.isFinite(p[0]) && Number.isFinite(p[1]);
  }

  function clonePoint(p) {
    return validPoint(p) ? [p[0], p[1]] : null;
  }

  function clonePose(pose) {
    if (!pose) return null;
    return Object.fromEntries(
      Object.entries(pose).map(([key, p]) => [key, clonePoint(p)])
    );
  }

  function distance(a, b) {
    if (!validPoint(a) || !validPoint(b)) return Infinity;
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function subtract(a, b) {
    return [a[0] - b[0], a[1] - b[1]];
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function visibilityFor(joint, visibility) {
    const value = visibility?.[joint] ?? visibility?.[LEGACY_VISIBILITY[joint]];

    // Old callers without a visibility map are treated as unknown, not bad.
    if (value === undefined && visibility == null) return 1;

    return Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : 0;
  }

  function alphaFor(rawMotion, bodyScale, visibility, frameFactor) {
    let base;

    if (visibility < CONFIG.strongVisibility) {
      // Wide clothes / partial occlusion: keep coherent landmarks, but calm
      // down their frame-to-frame noise much more strongly.
      base = CONFIG.alphaWeak;
    } else {
      const slow = Math.max(0.003, bodyScale * CONFIG.slowMotionBodyRatio) * frameFactor;
      const fast = Math.max(0.012, bodyScale * CONFIG.fastMotionBodyRatio) * frameFactor;

      if (rawMotion <= slow) base = CONFIG.alphaStill;
      else if (rawMotion >= fast) base = CONFIG.alphaFast;
      else {
        const t = (rawMotion - slow) / Math.max(0.0001, fast - slow);
        base = CONFIG.alphaNormal +
          (CONFIG.alphaFast - CONFIG.alphaNormal) * t;
      }
    }

    // Preserve approximately the same response when video FPS varies.
    return 1 - Math.pow(1 - base, frameFactor);
  }

  function update(pose, visibility, timestamp) {
    const now = Number.isFinite(timestamp) ? timestamp : performance.now();

    if (lastTime !== null && now < lastTime) reset();

    // app.js can render the same camera frame more than once. Do not let a
    // duplicate frame advance filters or confirm a suspicious candidate.
    if (lastTime === now) return clonePose(lastPose);

    const dt = lastTime === null ? 1000 / 30 : Math.max(1, now - lastTime);
    lastTime = now;

    const frameFactor = Math.max(0.5, Math.min(3, dt / (1000 / 30)));
    const input = pose || {};

    const joints = [...new Set([
      ...Object.keys(LEGACY_VISIBILITY),
      ...Object.keys(state),
      ...Object.keys(input)
    ])].filter(key => key !== 'neck');

    const vis = {};
    const strong = {};
    const weak = {};

    for (const joint of joints) {
      vis[joint] = visibilityFor(joint, visibility);
      const valid = validPoint(input[joint]);
      strong[joint] = valid && vis[joint] >= CONFIG.strongVisibility;
      weak[joint] = valid && vis[joint] >= CONFIG.weakVisibility;
    }

    const fresh = joint =>
      state[joint] && now - state[joint].time <= CONFIG.holdMs;

    // Body scale comes only from previously accepted coordinates, never
    // from a new questionable landmark.
    const lengths = pairs => pairs.flatMap(([a, b]) => {
      if (!fresh(a) || !fresh(b)) return [];
      const length = distance(state[a].raw, state[b].raw);
      return length > 0.015 ? [length] : [];
    });

    const torso = lengths([
      ['lshoulder', 'lhip'],
      ['rshoulder', 'rhip']
    ]);

    const limb = torso.length ? torso : lengths(SEGMENTS);
    const bodyScale = limb.length ? median(limb) : 0.25;

    // Estimate common body translation from the most stable torso anchors.
    // Weak landmarks may be used only when there are not enough strong ones.
    const anchorKeys = ['lshoulder', 'rshoulder', 'lhip', 'rhip'];
    let anchorSource = anchorKeys.filter(key => strong[key] && fresh(key));
    if (anchorSource.length < 3) {
      anchorSource = anchorKeys.filter(key => weak[key] && fresh(key));
    }

    const deltas = anchorSource
      .map(key => subtract(input[key], state[key].raw));

    const translation = deltas.length >= 3
      ? [
          median(deltas.map(p => p[0])),
          median(deltas.map(p => p[1]))
        ]
      : [0, 0];

    const movement = {};
    const suspect = new Set();

    const jumpLimit = Math.min(
      CONFIG.maxJump,
      Math.max(0.025, bodyScale * CONFIG.jumpBodyRatio)
    ) * frameFactor;

    for (const joint of joints) {
      if (!weak[joint] || !fresh(joint)) continue;

      const residual = subtract(
        subtract(input[joint], state[joint].raw),
        translation
      );

      movement[joint] = Math.hypot(residual[0], residual[1]);

      if (movement[joint] > jumpLimit) {
        suspect.add(joint);
      }
    }

    // A knee hidden by wide trousers can have low visibility while still
    // moving coherently. Bone-length continuity helps distinguish that from
    // an actual landmark teleport.
    for (const [a, b] of SEGMENTS) {
      if (!weak[a] || !weak[b] || !fresh(a) || !fresh(b)) continue;

      const oldLength = distance(state[a].raw, state[b].raw);
      const newLength = distance(input[a], input[b]);

      const tolerance = Math.max(
        0.02,
        bodyScale * CONFIG.lengthBodyRatio,
        oldLength * CONFIG.lengthChangeRatio
      ) * frameFactor;

      if (Math.abs(newLength - oldLength) <= tolerance) continue;

      const moveA = movement[a] ?? 0;
      const moveB = movement[b] ?? 0;
      const fast = moveA > moveB ? a : b;
      const slow = fast === a ? b : a;
      const fastMove = movement[fast] ?? 0;
      const slowMove = movement[slow] ?? 0;

      if (
        fastMove > slowMove * 1.5 +
          Math.max(0.012, bodyScale * 0.05)
      ) {
        suspect.add(fast);
      }
    }

    const result = {};
    effectiveVisibility = {};

    for (const joint of joints) {
      const raw = input[joint];
      const previous = state[joint];
      const age = previous ? now - previous.time : Infinity;

      // KEY CHANGE vs V0.2:
      // low MediaPipe visibility no longer automatically kills the point.
      // A weak point may continue if its trajectory is geometrically sane.
      let accept = weak[joint] && !suspect.has(joint);

      const needsConfirmation = weak[joint] && previous &&
        (suspect.has(joint) || age > CONFIG.holdMs);

      if (!weak[joint]) {
        if (previous) previous.candidate = null;
        accept = false;

      } else if (needsConfirmation) {
        const parent = PARENT[joint];
        const anchor = parent && weak[parent] && !suspect.has(parent)
          ? parent
          : null;

        const candidatePoint = anchor
          ? subtract(raw, input[anchor])
          : clonePoint(raw);

        const candidate = previous.candidate;
        const radius = Math.max(
          0.012,
          bodyScale * CONFIG.candidateBodyRatio
        );

        const continues = candidate &&
          candidate.anchor === anchor &&
          now - candidate.lastTime <= CONFIG.maxCandidateGapMs &&
          distance(candidatePoint, candidate.origin) <= radius;

        previous.candidate = continues
          ? {
              ...candidate,
              lastTime: now,
              count: candidate.count + 1
            }
          : {
              anchor,
              origin: candidatePoint,
              startTime: now,
              lastTime: now,
              count: 1
            };

        accept = previous.candidate.count >= CONFIG.confirmFrames &&
          now - previous.candidate.startTime >= CONFIG.confirmMs;
      }

      if (accept) {
        const rawMotion = previous
          ? distance(previous.raw, raw)
          : 0;

        const alpha = alphaFor(
          rawMotion,
          bodyScale,
          vis[joint],
          frameFactor
        );

        // After a prolonged loss, reacquire at the real point instead of
        // drawing a long artificial sweep from an ancient location.
        const point = previous && age <= CONFIG.holdMs
          ? [
              previous.point[0] + (raw[0] - previous.point[0]) * alpha,
              previous.point[1] + (raw[1] - previous.point[1]) * alpha
            ]
          : clonePoint(raw);

        state[joint] = {
          point,
          raw: clonePoint(raw),
          time: now,
          candidate: null
        };

        result[joint] = clonePoint(point);

        // IMPORTANT: analysis sees the real confidence. We do not promote a
        // low-confidence but visually coherent knee into a "high confidence"
        // biomechanics measurement.
        effectiveVisibility[joint] = vis[joint];

      } else {
        result[joint] = previous && age <= CONFIG.holdMs
          ? clonePoint(previous.point)
          : null;

        // Held/rejected coordinates are display-only.
        effectiveVisibility[joint] = 0;
      }
    }

    const ls = result.lshoulder;
    const rs = result.rshoulder;

    result.neck = validPoint(ls) && validPoint(rs)
      ? [
          (ls[0] + rs[0]) / 2,
          (ls[1] + rs[1]) / 2
        ]
      : null;

    effectiveVisibility.neck = Math.min(
      effectiveVisibility.lshoulder || 0,
      effectiveVisibility.rshoulder || 0
    );

    lastPose = clonePose(result);
    return result;
  }

  function getVisibility() {
    return { ...effectiveVisibility };
  }

  function reset() {
    state = {};
    lastTime = null;
    lastPose = null;
    effectiveVisibility = {};
  }

  return {
    update,
    reset,
    getVisibility
  };
})();
