/* =====================================================================
   SQUAT DETECTOR — v0.1
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

    missingDataGraceFrames: 15 // frames with no usable angle at all before we flag data as "stale" in debug
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

  function reset() {
    reps = 0;
    state = 'standing';
    smoothedAngle = null;
    pending = { target: null, count: 0 };
    framesWithoutData = 0;
    minAngleThisRep = null;
    lastLeftAngle = null;
    lastRightAngle = null;
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

  function stepStateMachine(angle) {
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
      // no usable angle this frame: freeze the state machine and the
      // smoothed angle rather than guessing or resetting anything.
    } else {
      framesWithoutData = 0;
      smoothedAngle = ema(smoothedAngle, combinedAngle, CONFIG.smoothingAlpha);
      stepStateMachine(smoothedAngle);
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
        minAngleThisRep: minAngleThisRep !== null ? Math.round(minAngleThisRep * 10) / 10 : null
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
