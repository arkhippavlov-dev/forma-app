/* ============================================================
   FORMA — POSE STABILIZER V0.2
   ============================================================ */

const PoseStabilizer = (function () {
  const CONFIG = {
    smoothing: 0.55,
    minVisibility: 0.35,
    maxJump: 0.18,
    holdMs: 350,
    confirmFrames: 3,
    confirmMs: 60,
    maxCandidateGapMs: 200,
    jumpBodyRatio: 0.40,
    lengthChangeRatio: 0.45,
    lengthBodyRatio: 0.12,
    candidateBodyRatio: 0.09
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

  function distance(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function subtract(a, b) {
    return [a[0] - b[0], a[1] - b[1]];
  }

  function clonePose(pose) {
    if (!pose) return null;

    return Object.fromEntries(
      Object.entries(pose).map(([key, p]) => [key, clonePoint(p)])
    );
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

    if (value === undefined && visibility == null) {
      return 1;
    }

    return Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : 0;
  }

  function update(pose, visibility, timestamp) {
    const now = Number.isFinite(timestamp) ? timestamp : performance.now();

    if (lastTime !== null && now < lastTime) {
      reset();
    }

    if (lastTime === now) {
      return clonePose(lastPose);
    }

    const dt = lastTime === null ? 1000 / 30 : now - lastTime;
    lastTime = now;

    const frameFactor = Math.max(0.5, Math.min(3, dt / (1000 / 30)));
    const alpha = 1 - Math.pow(1 - CONFIG.smoothing, frameFactor);

    const input = pose || {};

    const joints = [
      ...new Set([
        ...Object.keys(LEGACY_VISIBILITY),
        ...Object.keys(state),
        ...Object.keys(input)
      ])
    ].filter(key => key !== 'neck');

    const reliable = {};
    const vis = {};

    for (const joint of joints) {
      vis[joint] = visibilityFor(joint, visibility);
      reliable[joint] = validPoint(input[joint]) &&
        vis[joint] >= CONFIG.minVisibility;
    }

    const fresh = joint =>
      state[joint] &&
      now - state[joint].time <= CONFIG.holdMs;

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

    const deltas = [
      'lshoulder',
      'rshoulder',
      'lhip',
      'rhip'
    ]
      .filter(key => reliable[key] && fresh(key))
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
      if (!reliable[joint] || !fresh(joint)) continue;

      movement[joint] = distance(
        subtract(input[joint], state[joint].raw),
        translation
      );

      if (movement[joint] > jumpLimit) {
        suspect.add(joint);
      }
    }

    for (const [a, b] of SEGMENTS) {
      if (!reliable[a] || !reliable[b] || !fresh(a) || !fresh(b)) {
        continue;
      }

      const oldLength = distance(state[a].raw, state[b].raw);
      const newLength = distance(input[a], input[b]);

      const tolerance = Math.max(
        0.02,
        bodyScale * CONFIG.lengthBodyRatio,
        oldLength * CONFIG.lengthChangeRatio
      ) * frameFactor;

      if (Math.abs(newLength - oldLength) <= tolerance) {
        continue;
      }

      const fast = movement[a] > movement[b] ? a : b;
      const slow = fast === a ? b : a;

      if (
        movement[fast] >
        movement[slow] * 1.5 + Math.max(0.012, bodyScale * 0.05)
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

      let accept = reliable[joint];

      const needsConfirmation = previous &&
        (suspect.has(joint) || age > CONFIG.holdMs);

      if (!accept) {
        if (previous) {
          previous.candidate = null;
        }
      } else if (needsConfirmation) {
        const parent = PARENT[joint];

        const anchor = parent &&
          reliable[parent] &&
          !suspect.has(parent)
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
        effectiveVisibility[joint] = vis[joint];
      } else {
        result[joint] = previous && age <= CONFIG.holdMs
          ? clonePoint(previous.point)
          : null;

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
      effectiveVisibility.lshoulder,
      effectiveVisibility.rshoulder
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
