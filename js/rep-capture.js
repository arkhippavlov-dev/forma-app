/* =====================================================================
   REP CAPTURE — v0.1
   ---------------------------------------------------------------------
   Responsibility: given the ALREADY-COMPUTED state/reps from a movement
   detector (e.g. SquatDetector), record each completed repetition's
   data for later analysis. Does NOT run its own state machine and does
   NOT decide whether a rep happened — that's entirely the detector's
   job. This module only watches detectorResult.state / .reps and saves
   snapshots along the way.

   Designed to work with any detector that returns an object shaped like
   { state, reps, kneeAngle, leftKneeAngle, rightKneeAngle, ... } — the
   only fields actually required are `state` and `reps`; the three angle
   fields are used opportunistically if present (all optional, all
   tolerant of null). That's what makes it reusable later for a
   BenchPressDetector / DeadliftDetector without rewriting this file.

   No DOM, no canvas, no camera, no MediaPipe, no technique scoring,
   no import/export — plain global object via <script src="...">.
   ===================================================================== */

const RepCapture = (function () {

  // ---------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------
  const CONFIG = {
    sampleRateHz: 12,      // how many snapshots per second land in rep.frames
    maxFramesPerRep: 240   // hard safety cap (~20s of sampled frames) so a
                           // rep that never completes can't grow forever
  };

  // ---------------------------------------------------------------------
  // internal state
  // ---------------------------------------------------------------------
  let completedReps = [];
  let currentRep = null;     // working (mutable) capture object, or null
  let lastKnownReps = 0;     // last reps count reported by the detector
  let lastTimestamp = null;  // most recent valid timestamp we've seen

  function reset() {
    completedReps = [];
    currentRep = null;
    lastKnownReps = 0;
    lastTimestamp = null;
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------
  function numOrNull(v) { return (typeof v === 'number' && !Number.isNaN(v)) ? v : null; }
  function finiteOrNull(v) { return Number.isFinite(v) ? v : null; }

  // Safe, cheap snapshot of a keypoints object: new arrays, no shared
  // references with whatever the caller does to `pose` on the next frame.
  // Not a JSON.stringify round-trip — just copies the [x,y] pairs we need.
  function clonePose(pose) {
    if (!pose) return null;
    const out = {};
    for (const key in pose) {
      if (!Object.prototype.hasOwnProperty.call(pose, key)) continue;
      const v = pose[key];
      out[key] = (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number')
        ? [v[0], v[1]]
        : null;
    }
    return out;
  }

  function cloneVisibility(visibility) {
  if (!visibility) return null;

  const out = {};

  for (const key in visibility) {
    if (!Object.prototype.hasOwnProperty.call(visibility, key)) {
      continue;
    }

    const value = visibility[key];

    out[key] = Number.isFinite(value)
      ? value
      : null;
  }

  return out;
}


function makeSnapshot(detectorResult, pose, visibility, t) {
  return {
    t: t,

    state: detectorResult.state || null,

    kneeAngle: numOrNull(detectorResult.kneeAngle),
    leftKneeAngle: numOrNull(detectorResult.leftKneeAngle),
    rightKneeAngle: numOrNull(detectorResult.rightKneeAngle),
    detectorMode: detectorResult.mode || null,
    motionValue: numOrNull(detectorResult.motionValue),

    pose: clonePose(pose),

    visibility: cloneVisibility(visibility)
  };
}

  function startRep(t) {
    return {
      index: completedReps.length + 1,
      startTime: t,
      lastSampleTime: null,
      frameCount: 0,
      minKneeAngle: Infinity, maxKneeAngle: -Infinity,
      leftMinKneeAngle: Infinity, leftMaxKneeAngle: -Infinity,
      rightMinKneeAngle: Infinity, rightMaxKneeAngle: -Infinity,
      deepestMetric: null,
      bottomFrame: null,
      frames: []
    };
  }

  // Small, cheap-to-build view of the in-progress rep, returned from
  // update() on every call. The heavier snapshot (with the full sampled
  // `frames` timeline) is only built on demand via getCurrentRep().
  function buildLiveSummary(rep, t) {
    return {
      index: rep.index,
      startTime: rep.startTime,
      elapsedMs: t - rep.startTime,
      frameCount: rep.frameCount,
      minKneeAngle: finiteOrNull(rep.minKneeAngle),
      maxKneeAngle: finiteOrNull(rep.maxKneeAngle)
    };
  }

  function buildCompletedRep(rep, endTime) {
    return {
      index: rep.index,
      startTime: rep.startTime,
      endTime: endTime,
      durationMs: endTime - rep.startTime,
      frameCount: rep.frameCount,
      minKneeAngle: finiteOrNull(rep.minKneeAngle),
      maxKneeAngle: finiteOrNull(rep.maxKneeAngle),
      leftMinKneeAngle: finiteOrNull(rep.leftMinKneeAngle),
      leftMaxKneeAngle: finiteOrNull(rep.leftMaxKneeAngle),
      rightMinKneeAngle: finiteOrNull(rep.rightMinKneeAngle),
      rightMaxKneeAngle: finiteOrNull(rep.rightMaxKneeAngle),
      bottomFrame: rep.bottomFrame,   // deepest frame from the detector's mode-independent metric
      frames: rep.frames              // throttled timeline, ~CONFIG.sampleRateHz per second
    };
  }

  function buildStatus(newRep, t) {
    return {
      isCapturing: currentRep !== null,
      currentRep: currentRep ? buildLiveSummary(currentRep, t) : null,
      completedReps: completedReps.slice(),
      newRep: newRep
    };
  }

  // ---------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------

  /**
   * update(detectorResult, pose, visibility, timestamp) -> status
   * detectorResult: whatever SquatDetector.update() (or a similar
   *   detector) returned this frame — only `.state` and `.reps` are
   *   required; the angle fields are used if present.
   * pose: the same keypoints object passed to the detector this frame.
   * visibility: currently unused here (reserved — a future
   *   SquatAnalysisService is the natural place for per-landmark
   *   visibility to matter), accepted for a stable call signature.
   * timestamp: e.g. performance.now(); required for duration/sampling —
   *   if omitted, the last known timestamp (or, failing that, Date.now(),
   *   called at most once) is used so a bad caller can't crash this.
   */
  function update(detectorResult, pose, visibility, timestamp) {
    const dr = detectorResult || {};
    const t = (typeof timestamp === 'number') ? timestamp
      : (lastTimestamp !== null ? lastTimestamp : Date.now());

    const currState = dr.state || null;
    const currReps = (typeof dr.reps === 'number') ? dr.reps : lastKnownReps;

    // Render callbacks and missing-data heartbeats are not observations.
    if (t === lastTimestamp) return buildStatus(null, t);
    if (dr.trackingAvailable === false) {
      if (currState === 'standing') currentRep = null;
      lastTimestamp = t;
      lastKnownReps = currReps;
      return buildStatus(null, t);
    }

    // Lazily start a capture the moment we're not idle and nothing is
    // being recorded yet. This is tolerant of a missed/dropped exact
    // "standing -> descending" transition frame — we just start on
    // whatever the first non-standing state we actually observe is.
    if (!currentRep && currState && currState !== 'standing') {
      currentRep = startRep(t);
    }

    let newRep = null;

    if (currentRep) {
      currentRep.frameCount++;

      const ka = numOrNull(dr.kneeAngle);
      const lka = numOrNull(dr.leftKneeAngle);
      const rka = numOrNull(dr.rightKneeAngle);
      const bottomMetric = finiteOrNull(dr.bottomMetric);

      // `bottomMetric` is supplied by the detector and is deliberately
      // mode-independent: it is -kneeAngle in full mode and hip descent in
      // partial mode. RepCapture therefore stays reusable and does not need
      // to know which joints were visible.
      if (bottomMetric !== null &&
          (currentRep.deepestMetric === null || bottomMetric > currentRep.deepestMetric)) {
        currentRep.deepestMetric = bottomMetric;
        currentRep.bottomFrame = makeSnapshot(dr, pose, visibility, t);
      }

      // Precise angle min/max are retained for full-mode analysis. They may
      // remain null in partial mode rather than being invented from a held ankle.
      if (ka !== null) {
        if (ka < currentRep.minKneeAngle) {
          currentRep.minKneeAngle = ka;
        }
        if (ka > currentRep.maxKneeAngle) currentRep.maxKneeAngle = ka;
      }
      if (lka !== null) {
        if (lka < currentRep.leftMinKneeAngle) currentRep.leftMinKneeAngle = lka;
        if (lka > currentRep.leftMaxKneeAngle) currentRep.leftMaxKneeAngle = lka;
      }
      if (rka !== null) {
        if (rka < currentRep.rightMinKneeAngle) currentRep.rightMinKneeAngle = rka;
        if (rka > currentRep.rightMaxKneeAngle) currentRep.rightMaxKneeAngle = rka;
      }

      // Throttled timeline sampling (~CONFIG.sampleRateHz per second),
      // capped so a rep that never completes can't grow without bound.
      const sampleIntervalMs = 1000 / CONFIG.sampleRateHz;
      if (currentRep.frames.length < CONFIG.maxFramesPerRep &&
          (currentRep.lastSampleTime === null || (t - currentRep.lastSampleTime) >= sampleIntervalMs)) {
        currentRep.frames.push(
  makeSnapshot(
    dr,
    pose,
    visibility,
    t
  )
);
        currentRep.lastSampleTime = t;
      }

      if (currReps > lastKnownReps) {
        // The detector just confirmed this movement as one completed rep —
        // this is the one and only place a rep is finalized, so it can't
        // be double-completed.
        const completed = buildCompletedRep(currentRep, t);
        completedReps.push(completed);
        newRep = completed;
        currentRep = null;
      } else if (currState === 'standing') {
        // Back to standing without the detector's rep count increasing —
        // an aborted/shallow attempt. Discard silently, nothing to save.
        currentRep = null;
      }
    }

    lastKnownReps = currReps;
    lastTimestamp = t;

    return buildStatus(newRep, t);
  }

  function getCompletedReps() {
    return completedReps.slice();
  }

  // Fuller, on-demand view of the in-progress rep (includes the sampled
  // frames timeline and bottomFrame) — heavier than the summary returned
  // from update(), so it's only built when actually asked for.
  function getCurrentRep() {
    if (!currentRep) return null;
    return {
      index: currentRep.index,
      startTime: currentRep.startTime,
      frameCount: currentRep.frameCount,
      minKneeAngle: finiteOrNull(currentRep.minKneeAngle),
      maxKneeAngle: finiteOrNull(currentRep.maxKneeAngle),
      leftMinKneeAngle: finiteOrNull(currentRep.leftMinKneeAngle),
      leftMaxKneeAngle: finiteOrNull(currentRep.leftMaxKneeAngle),
      rightMinKneeAngle: finiteOrNull(currentRep.rightMinKneeAngle),
      rightMaxKneeAngle: finiteOrNull(currentRep.rightMaxKneeAngle),
      bottomFrame: currentRep.bottomFrame,
      frames: currentRep.frames.slice()
    };
  }

  return { update, getCompletedReps, getCurrentRep, reset };
})();
