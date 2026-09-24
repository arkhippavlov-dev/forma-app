/* =====================================================================
   SQUAT DETECTOR — v0.2 (standing readiness before counting)
   ---------------------------------------------------------------------
   Responsibility: MOVEMENT / REP DETECTION ONLY.
   Not responsible for: squat depth quality, knee valgus, torso angle,
   symmetry, per-rep scoring, recommendations. Those belong in a future
   SquatAnalysisService that can read this detector's output (and the
   same keypoints) without this file being rewritten.

   Input contract (unchanged, decided elsewhere in the app):
     keypoints: { lhip, rhip, lknee, rknee, lankle, rankle, ... }
       each point is [x, y] in MediaPipe-normalized coords, or null/undefined
       if not detected this frame. Coordinates are used exactly as given —
       no mirroring, no object-fit correction (already handled upstream).
     visibility: { lhip, rhip, lknee, rknee, lankle, rankle, ... }
       (optional, 0..1 each; FORMA-normalized, not backend-specific)

   No DOM, no canvas, no camera, no import/export — plain global object,
   loaded via <script src="js/squat-detector.js">.
   ===================================================================== */

const SquatDetector = (function () {

  // ---------------------------------------------------------------------
  // CONFIG — tune these to calibrate without touching the logic below.
  // Angles are knee angle in degrees (180 = leg fully straight).
  // Thresholds are intentionally beginner-friendly, not powerlifting-depth.
  // ---------------------------------------------------------------------
  const CONFIG = {
    standingAngle: 165,      // at/above this, the leg counts as "straight" (standing)
    standingExitAngle: 160,  // must climb back to at/above this from ascending to finish a rep
    descendEnterAngle: 155,  // from standing, drop to/below this to start "descending"
    bottomEnterAngle: 120,   // from descending, drop to/below this to reach "bottom"
    ascendExitAngle: 135,    // from bottom, climb to/above this to start "ascending"

    confirmFrames: 3,        // consecutive frames a condition must hold before a state actually changes
    smoothingAlpha: 0.25,    // EMA factor for the combined knee angle (0..1, higher = more responsive/less smooth)

    minLegVisibility: 0.35,  // below this (when visibility is supplied), that leg's angle is excluded
    singleLegConfidence: 0.6,// confidence reported when only one leg's angle is usable
    dualLegConfidence: 1.0,  // confidence reported when both legs' angles are usable

    // Partial mode is intentionally conservative. It can count a clear
    // squat from hip/knee motion when ankles are unavailable, but it does
    // not claim an ankle-dependent technique measurement is trustworthy.
    partialDescendEnter: 0.25,
    partialBottomEnter: 0.55,
    partialAscendExit: 0.38,
    partialStandingExit: 0.14,
    partialSingleSideConfidence: 0.35,
    partialDualSideConfidence: 0.45,
    standingReferenceAlpha: 0.08,

    missingDataGraceFrames: 15, // frames with no usable angle before data is stale

    readyHoldMs: 1000,          // continuous stable standing, not a blind delay
    readyMinFrames: 6,
    readyMaxFrameGapMs: 250,
    readyPositionTolerance: 0.08, // fraction of visible torso + thigh length
    reacquireAfterMs: 800       // prolonged loss cancels an incomplete rep
  };

  // ---------------------------------------------------------------------
  // internal state
  // ---------------------------------------------------------------------
  let reps = 0;
  let state = 'standing';           // 'standing' | 'descending' | 'bottom' | 'ascending'
  let smoothedAngle = null;         // EMA of the combined knee angle
  let pending = { target: null, count: 0 }; // transition-confirmation counter
  let framesWithoutData = 0;
  let minAngleThisRep = null;       // lowest smoothed angle seen since leaving "standing" (debug/future depth use)
  let lastLeftAngle = null;
  let lastRightAngle = null;
  let smoothedHipY = null;
  let standingHipY = null;
  let standingThighLength = null;
  let ready = false;
  let readyCandidate = null;
  let lastUpdateTime = null;
  let lastTrackingTime = null;
  let lastResult = null;

  // Keep completed reps while cancelling an uncertain in-progress movement.
  // Return standing while waiting so RepCapture discards an incomplete rep.
  function waitForStanding() {
    ready = false;
    readyCandidate = null;
    state = 'standing';
    smoothedAngle = null;
    pending = { target: null, count: 0 };
    framesWithoutData = 0;
    minAngleThisRep = null;
    lastLeftAngle = null;
    lastRightAngle = null;
    smoothedHipY = null;
    standingHipY = null;
    standingThighLength = null;
  }

  function reset() {
    reps = 0;
    waitForStanding();
    lastUpdateTime = null;
    lastTrackingTime = null;
    lastResult = null;
  }

  // ---------------------------------------------------------------------
  // geometry
  // ---------------------------------------------------------------------
  function isPoint(p) {
    return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  }

  // angle at point b, formed by rays b->a and b->c, in degrees
  function angleAt(a, b, c) {
    if (!isPoint(a) || !isPoint(b) || !isPoint(c)) return null;
    const v1x = a[0] - b[0], v1y = a[1] - b[1];
    const v2x = c[0] - b[0], v2y = c[1] - b[1];
    const mag1 = Math.hypot(v1x, v1y), mag2 = Math.hypot(v2x, v2y);
    if (mag1 === 0 || mag2 === 0) return null;
    let cos = (v1x * v2x + v1y * v2y) / (mag1 * mag2);
    cos = Math.max(-1, Math.min(1, cos));
    return Math.acos(cos) * 180 / Math.PI;
  }

  function getVis(visibility, key, legacyKey) {
    if (!visibility) return null;
    const v = visibility[key] ?? visibility[legacyKey];
    return Number.isFinite(v) ? v : null;
  }

  // lowest visibility among hip/knee/ankle for one leg; null if we simply
  // don't have visibility data at all (treated as "unknown", not "bad")
  function legVisibility(visibility, side) {
    const keys = side === 'left'
      ? [['lhip', 'LEFT_HIP'], ['lknee', 'LEFT_KNEE'], ['lankle', 'LEFT_ANKLE']]
      : [['rhip', 'RIGHT_HIP'], ['rknee', 'RIGHT_KNEE'], ['rankle', 'RIGHT_ANKLE']];
    const vals = keys.map(([key, legacyKey]) => getVis(visibility, key, legacyKey)).filter(v => v !== null);
    if (vals.length === 0) return null;
    return Math.min(...vals);
  }

  function hipKneeMeasurement(kp, visibility, side) {
    const hipKey = side === 'left' ? 'lhip' : 'rhip';
    const kneeKey = side === 'left' ? 'lknee' : 'rknee';
    const legacySide = side === 'left' ? 'LEFT' : 'RIGHT';
    const hip = kp[hipKey];
    const knee = kp[kneeKey];
    const visibilityValues = [
      getVis(visibility, hipKey, `${legacySide}_HIP`),
      getVis(visibility, kneeKey, `${legacySide}_KNEE`)
    ].filter(v => v !== null);
    const confidence = visibilityValues.length
      ? Math.min(...visibilityValues)
      : null;

    if (!isPoint(hip) || !isPoint(knee) ||
        (confidence !== null && confidence < CONFIG.minLegVisibility)) {
      return null;
    }

    const thighLength = Math.hypot(
      hip[0] - knee[0],
      hip[1] - knee[1]
    );

    return thighLength > 0.001
      ? { hipY: hip[1], thighLength }
      : null;
  }

  function ema(prev, current, alpha) {
    if (prev === null || prev === undefined) return current;
    return prev + alpha * (current - prev);
  }

  function readySample(kp, visibility, side) {
    const prefix = side === 'left' ? 'l' : 'r';
    const legacyPrefix = side === 'left' ? 'LEFT' : 'RIGHT';
    const usable = part => {
      const key = prefix + part;
      const v = getVis(visibility, key, legacyPrefix + '_' + part.toUpperCase());
      return isPoint(kp[key]) &&
        (visibility == null || (v !== null && v >= CONFIG.minLegVisibility));
    };
    if (!['hip', 'knee'].every(usable)) return null;
    const hasShoulder = usable('shoulder');
    const hasAnkle = usable('ankle');
    if (!hasShoulder && !hasAnkle) return null;
    const shoulder = kp[prefix + 'shoulder'];
    const hip = kp[prefix + 'hip'];
    const knee = kp[prefix + 'knee'];
    const torsoLength = hasShoulder ? Math.hypot(shoulder[0] - hip[0], shoulder[1] - hip[1]) : 0;
    const thighLength = Math.hypot(knee[0] - hip[0], knee[1] - hip[1]);
    if (thighLength < 0.01 || knee[1] <= hip[1]) return null;
    if (hasShoulder) {
      const hipAngle = angleAt(shoulder, hip, knee);
      if (torsoLength < 0.01 || shoulder[1] >= hip[1] ||
          hipAngle === null || hipAngle < CONFIG.standingExitAngle) return null;
    }

    if (hasAnkle) {
      const kneeAngle = angleAt(hip, knee, kp[prefix + 'ankle']);
      if (kneeAngle === null || kneeAngle < CONFIG.standingExitAngle) return null;
    } else if ((knee[1] - hip[1]) / thighLength < 0.65) {
      // Without feet, require an upright visible thigh and trunk. We do
      // not infer a knee angle or demand that all joints be in frame.
      return null;
    }

    const points = [hip, knee];
    if (hasShoulder) points.push(shoulder);
    if (hasAnkle) points.push(kp[prefix + 'ankle']);
    return { side, hasAnkle, hasShoulder, scale: (torsoLength || thighLength) + thighLength,
      points: points.map(p => [p[0], p[1]]) };
  }

  function updateReadiness(kp, visibility, now) {
    const samples = ['left', 'right'].map(side => readySample(kp, visibility, side)).filter(Boolean);
    const sample = samples.find(s => s.side === readyCandidate?.side) || samples[0];
    if (!sample) {
      readyCandidate = null;
      return;
    }
    const candidate = readyCandidate;
    const sameWindow = candidate && candidate.side === sample.side &&
      candidate.hasAnkle === sample.hasAnkle && candidate.hasShoulder === sample.hasShoulder &&
      now - candidate.lastTime <= CONFIG.readyMaxFrameGapMs &&
      sample.points.every((p, i) => Math.hypot(
        p[0] - candidate.points[i][0], p[1] - candidate.points[i][1]
      ) <= Math.max(0.008, candidate.scale * CONFIG.readyPositionTolerance));
    readyCandidate = sameWindow
      ? { ...candidate, lastTime: now, frames: candidate.frames + 1 }
      : { ...sample, startTime: now, lastTime: now, frames: 1 };
    ready = now - readyCandidate.startTime >= CONFIG.readyHoldMs &&
      readyCandidate.frames >= CONFIG.readyMinFrames;
  }

  // ---------------------------------------------------------------------
  // state machine
  // ---------------------------------------------------------------------

  // Confirms `target` state only after CONFIG.confirmFrames consecutive
  // frames where `condition` held. Returns true the frame it actually commits.
  function confirmTransition(target, condition) {
    if (condition) {
      if (pending.target === target) pending.count++;
      else pending = { target, count: 1 };
      if (pending.count >= CONFIG.confirmFrames) {
        pending = { target: null, count: 0 };
        return true;
      }
    } else if (pending.target === target) {
      pending = { target: null, count: 0 };
    }
    return false;
  }

  function commit(newState) {
    if (state === 'ascending' && newState === 'standing') {
      reps++;
    }
    if (newState === 'standing') {
      minAngleThisRep = null;
    }
    state = newState;
  }

  function stepFullStateMachine(angle) {
    if (state === 'descending' || state === 'bottom') {
      minAngleThisRep = (minAngleThisRep === null) ? angle : Math.min(minAngleThisRep, angle);
    }

    if (state === 'standing') {
      if (confirmTransition('descending', angle <= CONFIG.descendEnterAngle)) commit('descending');

    } else if (state === 'descending') {
      // reached real depth
      if (confirmTransition('bottom', angle <= CONFIG.bottomEnterAngle)) { commit('bottom'); return; }
      // aborted on the way down without reaching bottom — no rep counted
      if (confirmTransition('standing', angle >= CONFIG.standingAngle)) commit('standing');

    } else if (state === 'bottom') {
      if (confirmTransition('ascending', angle >= CONFIG.ascendExitAngle)) commit('ascending');

    } else if (state === 'ascending') {
      if (confirmTransition('standing', angle >= CONFIG.standingExitAngle)) { commit('standing'); return; }
      // sat back down again before finishing — still the same rep in progress
      if (confirmTransition('bottom', angle <= CONFIG.bottomEnterAngle)) commit('bottom');
    }
  }

  function stepPartialStateMachine(hipDrop) {
    if (state === 'standing') {
      if (confirmTransition('descending', hipDrop >= CONFIG.partialDescendEnter)) commit('descending');

    } else if (state === 'descending') {
      if (confirmTransition('bottom', hipDrop >= CONFIG.partialBottomEnter)) { commit('bottom'); return; }
      if (confirmTransition('standing', hipDrop <= CONFIG.partialStandingExit)) commit('standing');

    } else if (state === 'bottom') {
      if (confirmTransition('ascending', hipDrop <= CONFIG.partialAscendExit)) commit('ascending');

    } else if (state === 'ascending') {
      if (confirmTransition('standing', hipDrop <= CONFIG.partialStandingExit)) { commit('standing'); return; }
      if (confirmTransition('bottom', hipDrop >= CONFIG.partialBottomEnter)) commit('bottom');
    }
  }

  // ---------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------

  /**
   * update(pose, visibility?, timestampMs?) -> result
   * pose: the keypoints object for this frame (may be null/incomplete).
   * visibility: optional per-landmark visibility map.
   */
  function update(pose, visibility, timestamp) {
    const now = Number.isFinite(timestamp) ? timestamp : performance.now();
    if (lastUpdateTime === now && lastResult) return lastResult;
    if (lastUpdateTime !== null &&
        (now < lastUpdateTime || now - lastUpdateTime >= CONFIG.reacquireAfterMs)) {
      waitForStanding();
      lastTrackingTime = null;
    }
    lastUpdateTime = now;
    const kp = pose || {};

    const rawLeft = angleAt(kp.lhip, kp.lknee, kp.lankle);
    const rawRight = angleAt(kp.rhip, kp.rknee, kp.rankle);

    const leftVis = legVisibility(visibility, 'left');
    const rightVis = legVisibility(visibility, 'right');

    // exclude a leg only if we positively know its visibility is low —
    // no visibility data at all is treated as "unknown", not "bad"
    const leftUsable = rawLeft !== null && !(leftVis !== null && leftVis < CONFIG.minLegVisibility);
    const rightUsable = rawRight !== null && !(rightVis !== null && rightVis < CONFIG.minLegVisibility);

    lastLeftAngle = leftUsable ? rawLeft : null;
    lastRightAngle = rightUsable ? rawRight : null;

    const parts = [];
    if (leftUsable) parts.push({ angle: rawLeft, weight: leftVis !== null ? leftVis : 0.5 });
    if (rightUsable) parts.push({ angle: rawRight, weight: rightVis !== null ? rightVis : 0.5 });

    const partialParts = [
      hipKneeMeasurement(kp, visibility, 'left'),
      hipKneeMeasurement(kp, visibility, 'right')
    ].filter(Boolean);

    const trackingAvailable = parts.length > 0 || partialParts.length > 0;
    if (lastTrackingTime !== null && now - lastTrackingTime >= CONFIG.reacquireAfterMs) {
      waitForStanding();
      lastTrackingTime = null;
    }
    if (trackingAvailable) lastTrackingTime = now;
    else pending = { target: null, count: 0 };

    const wasReady = ready;
    if (!ready) updateReadiness(kp, visibility, now);
    const justReady = ready && !wasReady;

    let partialMotion = null;
    if (ready && partialParts.length) {
      const hipY = partialParts.reduce((sum, part) => sum + part.hipY, 0) / partialParts.length;
      const thighLength = partialParts.reduce((sum, part) => sum + part.thighLength, 0) / partialParts.length;

      smoothedHipY = ema(smoothedHipY, hipY, CONFIG.smoothingAlpha);

      if (state === 'standing') {
        standingHipY = ema(standingHipY, smoothedHipY, CONFIG.standingReferenceAlpha);
        standingThighLength = ema(standingThighLength, thighLength, CONFIG.standingReferenceAlpha);
      }

      if (Number.isFinite(standingHipY) && Number.isFinite(standingThighLength) && standingThighLength > 0.001) {
        partialMotion = Math.max(0, (smoothedHipY - standingHipY) / standingThighLength);
      }
    }

    let combinedAngle = null;
    if (parts.length > 0) {
      const totalWeight = parts.reduce((s, p) => s + p.weight, 0) || parts.length;
      combinedAngle = parts.reduce((s, p) => s + p.angle * p.weight, 0) / totalWeight;
    }

    let confidence = 0;
    let mode = 'unavailable';

    let dataStale = false;
    if (combinedAngle !== null) {
      mode = 'full';
      confidence = parts.length === 2
        ? CONFIG.dualLegConfidence
        : CONFIG.singleLegConfidence;
      framesWithoutData = 0;
      smoothedAngle = justReady ? combinedAngle : ema(smoothedAngle, combinedAngle, CONFIG.smoothingAlpha);
      if (ready && !justReady) stepFullStateMachine(smoothedAngle);

    } else if (partialParts.length) {
      mode = 'partial';
      confidence = partialParts.length === 2
        ? CONFIG.partialDualSideConfidence
        : CONFIG.partialSingleSideConfidence;
      framesWithoutData = 0;
      if (ready && !justReady && partialMotion !== null) stepPartialStateMachine(partialMotion);

    } else {
      framesWithoutData++;
      dataStale = framesWithoutData > CONFIG.missingDataGraceFrames;
      // no usable angle this frame: freeze the state machine and the
      // smoothed angle rather than guessing or resetting anything.
    }

    const phase = (state === 'standing' || state === 'ascending') ? 'up' : 'down';

    lastResult = {
      reps: reps,
      state: state,
      phase: phase,
      ready: ready,
      trackingAvailable: trackingAvailable,
      readiness: ready ? 'ready' : (readyCandidate ? 'stabilizing' : 'waiting'),
      readinessProgress: ready ? 1 : (readyCandidate
        ? Math.min(1, (now - readyCandidate.startTime) / CONFIG.readyHoldMs) : 0),

      kneeAngle: mode === 'full' && smoothedAngle !== null ? Math.round(smoothedAngle * 10) / 10 : null,
      leftKneeAngle: mode === 'full' && lastLeftAngle !== null ? Math.round(lastLeftAngle * 10) / 10 : null,
      rightKneeAngle: mode === 'full' && lastRightAngle !== null ? Math.round(lastRightAngle * 10) / 10 : null,

      mode: mode,
      motionValue: partialMotion !== null ? Math.round(partialMotion * 1000) / 1000 : null,
      // A larger value always means a deeper position, independent of mode.
      bottomMetric: mode === 'full' && smoothedAngle !== null
        ? -smoothedAngle
        : partialMotion,

      confidence: confidence,

      debug: {
        legsUsed: parts.length,
        partialSidesUsed: partialParts.length,
        partialMotion: partialMotion,
        mode: mode,
        leftUsable: leftUsable,
        rightUsable: rightUsable,
        leftVisibility: leftVis,
        rightVisibility: rightVis,
        framesWithoutData: framesWithoutData,
        dataStale: dataStale,
        pendingTarget: pending.target,
        pendingCount: pending.count,
        minAngleThisRep: minAngleThisRep !== null ? Math.round(minAngleThisRep * 10) / 10 : null
      }
    };
    return lastResult;
  }

  // Optional partial runtime re-calibration, e.g. SquatDetector.configure({bottomEnterAngle: 110})
  function configure(overrides) {
    if (!overrides) return;
    Object.keys(overrides).forEach(k => {
      if (Object.prototype.hasOwnProperty.call(CONFIG, k)) CONFIG[k] = overrides[k];
    });
  }

  function getConfig() {
    return Object.assign({}, CONFIG);
  }

  return { update, reset, configure, getConfig };
})();
