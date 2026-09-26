/* =====================================================================
   SQUAT DETECTOR — v0.2
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
     visibility: { LEFT_HIP, RIGHT_HIP, LEFT_KNEE, RIGHT_KNEE,
                   LEFT_ANKLE, RIGHT_ANKLE, ... } (optional, 0..1 each)

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

    missingDataGraceFrames: 15, // frames with no usable angle at all before we flag data as "stale" in debug

    // Startup guard: do not let unstable pose construction create a fake rep.
    // The detector becomes armed only after it has seen a normal squat top
    // position for a few consecutive frames. The user does NOT need to freeze.
    startupStandingAngle: 160,
    startupConfirmFrames: 4,

    // Secondary movement signal. A squat must not disappear just because
    // a deliberately bad knee position makes the 2D hip-knee-ankle angle
    // unreliable. Hip descent is measured in standing torso lengths.
    hipDescendEnter: 0.18,
    hipBottomEnter: 0.55,
    hipAscentDelta: 0.12,
    hipStandingExit: 0.18,
    hipBaselineAlpha: 0.05
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
  let armed = false;               // becomes true after the first plausible standing/top position
  let startupStandingFrames = 0;   // consecutive startup frames at/above startupStandingAngle
  let standingHipY = null;          // standing reference for the secondary hip-descent signal
  let standingTorsoScale = null;    // shoulder->hip length at the standing reference
  let maxHipDropThisRep = null;     // deepest hip descent seen in the current movement
  let bottomRequiresHipAscent = false; // true when knee angle was unreliable at bottom entry

  function reset() {
    reps = 0;
    state = 'standing';
    smoothedAngle = null;
    pending = { target: null, count: 0 };
    framesWithoutData = 0;
    minAngleThisRep = null;
    lastLeftAngle = null;
    lastRightAngle = null;
    armed = false;
    startupStandingFrames = 0;
    standingHipY = null;
    standingTorsoScale = null;
    maxHipDropThisRep = null;
    bottomRequiresHipAscent = false;
  }

  // ---------------------------------------------------------------------
  // geometry
  // ---------------------------------------------------------------------
  function isPoint(p) {
    return Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number';
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

  function getVis(visibility, key) {
    if (!visibility) return null;
    const v = visibility[key];
    return (typeof v === 'number') ? v : null;
  }

  // lowest visibility among hip/knee/ankle for one leg; null if we simply
  // don't have visibility data at all (treated as "unknown", not "bad")
  function legVisibility(visibility, side) {
    const keys = side === 'left'
      ? ['LEFT_HIP', 'LEFT_KNEE', 'LEFT_ANKLE']
      : ['RIGHT_HIP', 'RIGHT_KNEE', 'RIGHT_ANKLE'];
    const vals = keys.map(k => getVis(visibility, k)).filter(v => v !== null);
    if (vals.length === 0) return null;
    return Math.min(...vals);
  }

  function ema(prev, current, alpha) {
    if (prev === null || prev === undefined) return current;
    return prev + alpha * (current - prev);
  }

  function midpoint(a, b) {
    if (!isPoint(a) || !isPoint(b)) return null;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  function pointDistance(a, b) {
    if (!isPoint(a) || !isPoint(b)) return null;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    return Number.isFinite(d) ? d : null;
  }

  function hipMotionSignal(kp) {
    const hips = midpoint(kp.lhip, kp.rhip);
    if (!hips) return { hipY: null, torsoScale: null, hipDropRatio: null };

    const shoulders = midpoint(kp.lshoulder, kp.rshoulder);
    const currentTorsoScale = shoulders ? pointDistance(shoulders, hips) : null;

    let hipDropRatio = null;
    if (Number.isFinite(standingHipY) &&
        Number.isFinite(standingTorsoScale) &&
        standingTorsoScale > 0.04) {
      hipDropRatio = (hips[1] - standingHipY) / standingTorsoScale;
    }

    return {
      hipY: hips[1],
      torsoScale: currentTorsoScale,
      hipDropRatio: Number.isFinite(hipDropRatio) ? hipDropRatio : null
    };
  }

  function setStandingReference(signal) {
    if (!signal) return;
    if (Number.isFinite(signal.hipY)) standingHipY = signal.hipY;
    if (Number.isFinite(signal.torsoScale) && signal.torsoScale > 0.04) {
      standingTorsoScale = signal.torsoScale;
    }
  }

  function gentlyUpdateStandingReference(signal) {
    if (!signal || !Number.isFinite(signal.hipY)) return;

    standingHipY = Number.isFinite(standingHipY)
      ? ema(standingHipY, signal.hipY, CONFIG.hipBaselineAlpha)
      : signal.hipY;

    if (Number.isFinite(signal.torsoScale) && signal.torsoScale > 0.04) {
      standingTorsoScale = Number.isFinite(standingTorsoScale)
        ? ema(standingTorsoScale, signal.torsoScale, CONFIG.hipBaselineAlpha)
        : signal.torsoScale;
    }
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
      maxHipDropThisRep = null;
      bottomRequiresHipAscent = false;
    }
    state = newState;
  }

  function stepStateMachine(angle, hipDropRatio) {
    const hasHipDrop = Number.isFinite(hipDropRatio);

    if (state === 'descending' || state === 'bottom') {
      minAngleThisRep = (minAngleThisRep === null) ? angle : Math.min(minAngleThisRep, angle);
      if (hasHipDrop) {
        maxHipDropThisRep = (maxHipDropThisRep === null)
          ? hipDropRatio
          : Math.max(maxHipDropThisRep, hipDropRatio);
      }
    }

    if (state === 'standing') {
      const descendingByKnee = angle <= CONFIG.descendEnterAngle;
      const descendingByHip = hasHipDrop && hipDropRatio >= CONFIG.hipDescendEnter;

      if (confirmTransition('descending', descendingByKnee || descendingByHip)) {
        maxHipDropThisRep = hasHipDrop ? hipDropRatio : null;
        commit('descending');
      }

    } else if (state === 'descending') {
      // Primary signal: knee flexion. Fallback: the pelvis has clearly moved
      // down relative to the person's own standing torso length.
      const bottomByKnee = angle <= CONFIG.bottomEnterAngle;
      const bottomByHip = hasHipDrop && hipDropRatio >= CONFIG.hipBottomEnter;

      if (confirmTransition('bottom', bottomByKnee || bottomByHip)) {
        bottomRequiresHipAscent = bottomByHip && !bottomByKnee;
        commit('bottom');
        return;
      }

      // Aborted on the way down: require both a straight leg and (when we
      // have the hip signal) a return near the standing pelvis height.
      const backAtTop = angle >= CONFIG.standingAngle &&
        (!hasHipDrop || hipDropRatio <= CONFIG.hipStandingExit);
      if (confirmTransition('standing', backAtTop)) commit('standing');

    } else if (state === 'bottom') {
      const ascendingByKnee = !bottomRequiresHipAscent && angle >= CONFIG.ascendExitAngle;
      const ascendingByHip = hasHipDrop &&
        Number.isFinite(maxHipDropThisRep) &&
        hipDropRatio <= (maxHipDropThisRep - CONFIG.hipAscentDelta);

      if (confirmTransition('ascending', ascendingByKnee || ascendingByHip)) {
        commit('ascending');
      }

    } else if (state === 'ascending') {
      const topByKnee = angle >= CONFIG.standingExitAngle;
      const topByHip = hasHipDrop && hipDropRatio <= CONFIG.hipStandingExit;

      if (confirmTransition('standing', topByKnee || topByHip)) {
        commit('standing');
        return;
      }

      // If the athlete drops down again before finishing, keep it as the
      // same repetition. Either signal may tell us that we are deep again.
      const backToBottomByKnee = angle <= CONFIG.bottomEnterAngle;
      const backToBottomByHip = hasHipDrop && hipDropRatio >= CONFIG.hipBottomEnter;
      if (confirmTransition('bottom', backToBottomByKnee || backToBottomByHip)) {
        if (backToBottomByHip && !backToBottomByKnee) bottomRequiresHipAscent = true;
        commit('bottom');
      }
    }
  }

  // ---------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------

  /**
   * update(pose, visibility?) -> result
   * pose: the keypoints object for this frame (may be null/incomplete).
   * visibility: optional per-landmark visibility map.
   */
  function update(pose, visibility) {
    const kp = pose || {};
    const motionSignal = hipMotionSignal(kp);

    const rawLeft = angleAt(kp.lhip, kp.lknee, kp.lankle);
    const rawRight = angleAt(kp.rhip, kp.rknee, kp.rankle);

    const leftVis = legVisibility(visibility, 'left');
    const rightVis = legVisibility(visibility, 'right');

    // exclude a leg only if we positively know its visibility is low —
    // no visibility data at all is treated as "unknown", not "bad"
    const leftUsable = rawLeft !== null && !(leftVis !== null && leftVis < CONFIG.minLegVisibility);
    const rightUsable = rawRight !== null && !(rightVis !== null && rightVis < CONFIG.minLegVisibility);

    if (rawLeft !== null) lastLeftAngle = rawLeft;
    if (rawRight !== null) lastRightAngle = rawRight;

    const parts = [];
    if (leftUsable) parts.push({ angle: rawLeft, weight: leftVis !== null ? leftVis : 0.5 });
    if (rightUsable) parts.push({ angle: rawRight, weight: rightVis !== null ? rightVis : 0.5 });

    let combinedAngle = null;
    if (parts.length > 0) {
      const totalWeight = parts.reduce((s, p) => s + p.weight, 0) || parts.length;
      combinedAngle = parts.reduce((s, p) => s + p.angle * p.weight, 0) / totalWeight;
    }

    let confidence = 0;
    if (parts.length === 2) confidence = CONFIG.dualLegConfidence;
    else if (parts.length === 1) confidence = CONFIG.singleLegConfidence;

    let dataStale = false;
    if (combinedAngle === null) {
      framesWithoutData++;
      dataStale = framesWithoutData > CONFIG.missingDataGraceFrames;
      // no usable angle this frame: freeze the state machine rather than
      // guessing or resetting anything.
    } else {
      framesWithoutData = 0;

      // ---------------------------------------------------------------
      // STARTUP GUARD
      // ---------------------------------------------------------------
      // While MediaPipe is first constructing the body, knee landmarks can
      // briefly jump through squat-like angles. If we fed those frames into
      // the normal state machine, "building the skeleton" could look like:
      // descending -> bottom -> ascending -> standing and create REP 1.
      //
      // A real squat begins from a top/standing position anyway, so we simply
      // wait until that position has been observed for a handful of frames.
      // This is NOT the old "stand still" readiness system: position may move
      // naturally and there is no timer/UI gate.
      if (!armed) {
        if (combinedAngle >= CONFIG.startupStandingAngle) {
          startupStandingFrames++;
        } else {
          startupStandingFrames = 0;
        }

        if (startupStandingFrames >= CONFIG.startupConfirmFrames) {
          armed = true;
          state = 'standing';
          pending = { target: null, count: 0 };
          minAngleThisRep = null;
          maxHipDropThisRep = null;
          smoothedAngle = combinedAngle;
          setStandingReference(motionSignal);
        } else {
          // Do not preserve the unstable startup angles in the EMA.
          smoothedAngle = null;
        }
      } else {
        smoothedAngle = ema(smoothedAngle, combinedAngle, CONFIG.smoothingAlpha);

        // While genuinely standing, let the reference follow tiny camera/body
        // drift very slowly. Once descent starts, the reference freezes.
        const currentHipDrop = motionSignal.hipDropRatio;
        if (state === 'standing' &&
            smoothedAngle >= CONFIG.standingAngle &&
            (!Number.isFinite(currentHipDrop) || currentHipDrop <= CONFIG.hipStandingExit)) {
          gentlyUpdateStandingReference(motionSignal);
        }

        // Recompute after a possible tiny baseline adjustment.
        const refreshedMotion = hipMotionSignal(kp);
        stepStateMachine(smoothedAngle, refreshedMotion.hipDropRatio);
        motionSignal.hipDropRatio = refreshedMotion.hipDropRatio;
      }
    }

    const phase = (state === 'standing' || state === 'ascending') ? 'up' : 'down';

    return {
      reps: reps,
      state: state,
      phase: phase,

      kneeAngle: smoothedAngle !== null ? Math.round(smoothedAngle * 10) / 10 : null,
      leftKneeAngle: lastLeftAngle !== null ? Math.round(lastLeftAngle * 10) / 10 : null,
      rightKneeAngle: lastRightAngle !== null ? Math.round(lastRightAngle * 10) / 10 : null,

      confidence: confidence,
      hipDropRatio: Number.isFinite(motionSignal.hipDropRatio)
        ? Math.round(motionSignal.hipDropRatio * 1000) / 1000
        : null,

      debug: {
        legsUsed: parts.length,
        leftUsable: leftUsable,
        rightUsable: rightUsable,
        leftVisibility: leftVis,
        rightVisibility: rightVis,
        framesWithoutData: framesWithoutData,
        dataStale: dataStale,
        pendingTarget: pending.target,
        pendingCount: pending.count,
        minAngleThisRep: minAngleThisRep !== null ? Math.round(minAngleThisRep * 10) / 10 : null,
        maxHipDropThisRep: Number.isFinite(maxHipDropThisRep) ? Math.round(maxHipDropThisRep * 1000) / 1000 : null,
        bottomRequiresHipAscent: bottomRequiresHipAscent,
        standingHipY: Number.isFinite(standingHipY) ? Math.round(standingHipY * 1000) / 1000 : null,
        standingTorsoScale: Number.isFinite(standingTorsoScale) ? Math.round(standingTorsoScale * 1000) / 1000 : null,
        armed: armed,
        startupStandingFrames: startupStandingFrames
      }
    };
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
