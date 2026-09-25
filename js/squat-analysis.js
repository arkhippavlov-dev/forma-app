/* =====================================================================
   SQUAT ANALYSIS — v0.2
   ---------------------------------------------------------------------
   Reads a completed repetition produced by RepCapture and extracts
   descriptive biomechanics metrics. This module intentionally avoids
   hard "good/bad" technique thresholds for now: current 2D data and
   camera-angle dependence are not calibrated well enough for universal
   judgments yet.

   Current metrics:
   - depth (existing V0.1 metric, now with confidence)
   - tempo / phase timing
   - left/right knee-angle asymmetry
   - torso lean and torso-change through the rep
   - overall data confidence
   ===================================================================== */

const SquatAnalysisService = (function () {

  const VIS_KEYS = {
    lshoulder: 'LEFT_SHOULDER',
    rshoulder: 'RIGHT_SHOULDER',
    lhip: 'LEFT_HIP',
    rhip: 'RIGHT_HIP',
    lknee: 'LEFT_KNEE',
    rknee: 'RIGHT_KNEE',
    lankle: 'LEFT_ANKLE',
    rankle: 'RIGHT_ANKLE'
  };

  function validPoint(point) {
    return (
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1])
    );
  }

  function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }

  function clamp01(value) {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(1, value));
  }

  function average(values) {
    const usable = values.filter(Number.isFinite);
    if (!usable.length) return null;
    return usable.reduce((sum, value) => sum + value, 0) / usable.length;
  }

  function averageAvailable(a, b) {
    return average([a, b]);
  }

  function midpoint(a, b) {
    if (!validPoint(a) || !validPoint(b)) return null;
    return [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2
    ];
  }

  function visibilityValue(frame, key) {
    const value = frame?.visibility?.[key];
    return Number.isFinite(value) ? value : null;
  }

  function visibilityForJoints(frame, joints) {
    const values = [];

    joints.forEach(joint => {
      const key = VIS_KEYS[joint];
      if (!key) return;
      const value = visibilityValue(frame, key);
      if (Number.isFinite(value)) values.push(value);
    });

    if (!values.length) return null;

    // For a metric that needs several joints, the weakest required point
    // is the limiting factor. This is intentionally conservative.
    return clamp01(Math.min(...values));
  }

  function sideDepth(hip, knee, ankle) {
    if (
      !validPoint(hip) ||
      !validPoint(knee) ||
      !validPoint(ankle)
    ) {
      return null;
    }

    const lowerLegLength = Math.hypot(
      ankle[0] - knee[0],
      ankle[1] - knee[1]
    );

    if (
      !Number.isFinite(lowerLegLength) ||
      lowerLegLength < 0.001
    ) {
      return null;
    }

    const verticalDifference = hip[1] - knee[1];
    return verticalDifference / lowerLegLength;
  }

  function analyzeDepth(rep) {
    if (!rep?.bottomFrame?.pose) {
      return {
        available: false,
        depthValue: null,
        leftDepth: null,
        rightDepth: null,
        kneeAngle: null,
        confidence: null
      };
    }

    const frame = rep.bottomFrame;
    const pose = frame.pose;

    const leftDepth = sideDepth(
      pose.lhip,
      pose.lknee,
      pose.lankle
    );

    const rightDepth = sideDepth(
      pose.rhip,
      pose.rknee,
      pose.rankle
    );

    const leftConfidence = Number.isFinite(leftDepth)
      ? visibilityForJoints(frame, ['lhip', 'lknee', 'lankle'])
      : null;

    const rightConfidence = Number.isFinite(rightDepth)
      ? visibilityForJoints(frame, ['rhip', 'rknee', 'rankle'])
      : null;

    const depthValue = averageAvailable(leftDepth, rightDepth);
    const confidence = averageAvailable(leftConfidence, rightConfidence);

    return {
      available: Number.isFinite(depthValue),
      depthValue: finiteOrNull(depthValue),
      leftDepth: finiteOrNull(leftDepth),
      rightDepth: finiteOrNull(rightDepth),
      kneeAngle: finiteOrNull(frame.kneeAngle),
      confidence: clamp01(confidence)
    };
  }

  function analyzeTempo(rep) {
    const frames = Array.isArray(rep?.frames)
      ? rep.frames.filter(frame => Number.isFinite(frame?.t))
      : [];

    const totalMs = Number.isFinite(rep?.durationMs)
      ? rep.durationMs
      : null;

    if (!frames.length || !Number.isFinite(totalMs)) {
      return {
        available: Number.isFinite(totalMs),
        totalMs: finiteOrNull(totalMs),
        descentMs: null,
        bottomMs: null,
        ascentMs: null
      };
    }

    const startTime = Number.isFinite(rep.startTime)
      ? rep.startTime
      : frames[0].t;

    const endTime = Number.isFinite(rep.endTime)
      ? rep.endTime
      : frames[frames.length - 1].t;

    const firstBottom = frames.find(frame => frame.state === 'bottom') || null;

    let firstAscending = null;
    const bottomIndex = firstBottom ? frames.indexOf(firstBottom) : -1;

    for (let i = Math.max(0, bottomIndex); i < frames.length; i++) {
      if (frames[i].state === 'ascending') {
        firstAscending = frames[i];
        break;
      }
    }

    const descentEnd = firstBottom || firstAscending;

    const descentMs = descentEnd
      ? Math.max(0, descentEnd.t - startTime)
      : null;

    const bottomMs = (firstBottom && firstAscending)
      ? Math.max(0, firstAscending.t - firstBottom.t)
      : null;

    const ascentMs = firstAscending
      ? Math.max(0, endTime - firstAscending.t)
      : null;

    return {
      available: true,
      totalMs: finiteOrNull(totalMs),
      descentMs: finiteOrNull(descentMs),
      bottomMs: finiteOrNull(bottomMs),
      ascentMs: finiteOrNull(ascentMs)
    };
  }

  function averageLegVisibility(rep, side) {
    const frames = [];
    if (rep?.bottomFrame) frames.push(rep.bottomFrame);
    if (Array.isArray(rep?.frames)) frames.push(...rep.frames);

    const joints = side === 'left'
      ? ['lhip', 'lknee', 'lankle']
      : ['rhip', 'rknee', 'rankle'];

    const values = frames
      .map(frame => visibilityForJoints(frame, joints))
      .filter(Number.isFinite);

    return clamp01(average(values));
  }

  function analyzeSymmetry(rep) {
    const left = finiteOrNull(rep?.leftMinKneeAngle);
    const right = finiteOrNull(rep?.rightMinKneeAngle);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return {
        available: false,
        leftMinKneeAngle: left,
        rightMinKneeAngle: right,
        kneeAngleDifference: null,
        confidence: null
      };
    }

    const leftConfidence = averageLegVisibility(rep, 'left');
    const rightConfidence = averageLegVisibility(rep, 'right');
    const confidence = averageAvailable(leftConfidence, rightConfidence);

    return {
      available: true,
      leftMinKneeAngle: left,
      rightMinKneeAngle: right,
      kneeAngleDifference: Math.abs(left - right),
      confidence: clamp01(confidence)
    };
  }

  // Angle from the image vertical. 0° means a vertical torso in the 2D
  // projection. It is descriptive only: more vertical is NOT automatically
  // "better", especially with different anthropometry and camera angles.
  function torsoLean(frame) {
    const pose = frame?.pose;
    if (!pose) return null;

    const shoulders = midpoint(pose.lshoulder, pose.rshoulder);
    const hips = midpoint(pose.lhip, pose.rhip);

    if (!validPoint(shoulders) || !validPoint(hips)) return null;

    const dx = shoulders[0] - hips[0];
    const dy = shoulders[1] - hips[1];
    const length = Math.hypot(dx, dy);

    if (!Number.isFinite(length) || length < 0.001) return null;

    return Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI;
  }

  function torsoVisibility(frame) {
    return visibilityForJoints(
      frame,
      ['lshoulder', 'rshoulder', 'lhip', 'rhip']
    );
  }

  function analyzeTorso(rep) {
    const frames = Array.isArray(rep?.frames) ? rep.frames : [];
    const allFrames = frames.slice();

    if (rep?.bottomFrame && !allFrames.includes(rep.bottomFrame)) {
      allFrames.push(rep.bottomFrame);
    }

    const measured = allFrames
      .map(frame => ({
        angle: torsoLean(frame),
        confidence: torsoVisibility(frame),
        t: frame?.t
      }))
      .filter(item => Number.isFinite(item.angle));

    if (!measured.length) {
      return {
        available: false,
        startLeanDegrees: null,
        bottomLeanDegrees: null,
        minLeanDegrees: null,
        maxLeanDegrees: null,
        rangeDegrees: null,
        bottomChangeDegrees: null,
        confidence: null
      };
    }

    measured.sort((a, b) => (a.t || 0) - (b.t || 0));

    const start = measured[0].angle;
    const bottom = torsoLean(rep?.bottomFrame);
    const angles = measured.map(item => item.angle);

    const min = Math.min(...angles);
    const max = Math.max(...angles);
    const confidence = average(
      measured.map(item => item.confidence).filter(Number.isFinite)
    );

    return {
      available: true,
      startLeanDegrees: finiteOrNull(start),
      bottomLeanDegrees: finiteOrNull(bottom),
      minLeanDegrees: finiteOrNull(min),
      maxLeanDegrees: finiteOrNull(max),
      rangeDegrees: finiteOrNull(max - min),
      bottomChangeDegrees:
        Number.isFinite(bottom) && Number.isFinite(start)
          ? bottom - start
          : null,
      confidence: clamp01(confidence)
    };
  }

  function analyzeDataQuality(rep) {
    const frames = [];
    if (rep?.bottomFrame) frames.push(rep.bottomFrame);
    if (Array.isArray(rep?.frames)) frames.push(...rep.frames);

    const requiredKeys = [
      'LEFT_SHOULDER', 'RIGHT_SHOULDER',
      'LEFT_HIP', 'RIGHT_HIP',
      'LEFT_KNEE', 'RIGHT_KNEE',
      'LEFT_ANKLE', 'RIGHT_ANKLE'
    ];

    const values = [];

    frames.forEach(frame => {
      requiredKeys.forEach(key => {
        const value = visibilityValue(frame, key);
        if (Number.isFinite(value)) values.push(value);
      });
    });

    const confidence = clamp01(average(values));

    return {
      available: Number.isFinite(confidence),
      confidence,
      sampledFrames: Array.isArray(rep?.frames) ? rep.frames.length : 0
    };
  }

  function analyze(rep) {
    const depth = analyzeDepth(rep);
    const tempo = analyzeTempo(rep);
    const symmetry = analyzeSymmetry(rep);
    const torso = analyzeTorso(rep);
    const dataQuality = analyzeDataQuality(rep);

    return {
      repIndex:
        rep && Number.isFinite(rep.index)
          ? rep.index
          : null,
      depth,
      tempo,
      symmetry,
      torso,
      dataQuality
    };
  }

  function analyzeSet(reps) {
    const list = Array.isArray(reps) ? reps : [];
    const repetitions = list.map(analyze);

    const avgDepth = average(
      repetitions.map(item => item.depth?.depthValue)
    );

    const avgDurationMs = average(
      repetitions.map(item => item.tempo?.totalMs)
    );

    const avgAsymmetry = average(
      repetitions.map(item => item.symmetry?.kneeAngleDifference)
    );

    const avgTorsoRange = average(
      repetitions.map(item => item.torso?.rangeDegrees)
    );

    const avgConfidence = average(
      repetitions.map(item => item.dataQuality?.confidence)
    );

    return {
      repCount: repetitions.length,
      repetitions,
      averages: {
        depthValue: finiteOrNull(avgDepth),
        durationMs: finiteOrNull(avgDurationMs),
        kneeAngleDifference: finiteOrNull(avgAsymmetry),
        torsoRangeDegrees: finiteOrNull(avgTorsoRange),
        confidence: clamp01(avgConfidence)
      }
    };
  }

  return {
    analyze,
    analyzeSet
  };

})();
