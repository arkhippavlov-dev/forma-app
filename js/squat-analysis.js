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
   - knee tracking / inward collapse signal in the 2D projection
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
    rankle: 'RIGHT_ANKLE',
    lheel: 'LEFT_HEEL',
    rheel: 'RIGHT_HEEL',
    lfoot: 'LEFT_FOOT_INDEX',
    rfoot: 'RIGHT_FOOT_INDEX'
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

  function median(values) {
    const usable = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!usable.length) return null;
    const mid = Math.floor(usable.length / 2);
    return usable.length % 2
      ? usable[mid]
      : (usable[mid - 1] + usable[mid]) / 2;
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

  // -------------------------------------------------------------------
  // Knee tracking V0.1
  // -------------------------------------------------------------------
  // This is intentionally a RELATIVE 2D signal, not a medical diagnosis.
  // We compare the knee's medial position at the bottom with the athlete's
  // own near-top frames from the same rep. That makes it less dependent on
  // stance width/body proportions than a single universal screen threshold.
  //
  // Positive inwardDelta means the knee moved further toward the body's
  // centre relative to its support point (foot/ankle) as the rep descended.
  // -------------------------------------------------------------------

  function supportPoint(frame, side) {
    const pose = frame?.pose;
    if (!pose) return null;

    const ankle = side === 'left' ? pose.lankle : pose.rankle;
    const foot = side === 'left' ? pose.lfoot : pose.rfoot;

    // Foot index helps us reference where the foot points, but it can be
    // noisier than the ankle. Averaging both gives a useful provisional
    // support point; if the foot is missing we safely fall back to ankle.
    if (validPoint(ankle) && validPoint(foot)) {
      return [
        (ankle[0] + foot[0]) / 2,
        (ankle[1] + foot[1]) / 2
      ];
    }

    return validPoint(ankle) ? ankle : null;
  }

  function supportVisibility(frame, side) {
    const ankleKey = side === 'left' ? 'LEFT_ANKLE' : 'RIGHT_ANKLE';
    const footKey = side === 'left' ? 'LEFT_FOOT_INDEX' : 'RIGHT_FOOT_INDEX';

    const ankle = visibilityValue(frame, ankleKey);
    const foot = visibilityValue(frame, footKey);

    if (Number.isFinite(ankle) && Number.isFinite(foot)) {
      return Math.min(ankle, foot);
    }

    return Number.isFinite(ankle) ? ankle : null;
  }

  function kneeTrackingMeasurement(frame) {
    const pose = frame?.pose;
    if (!pose) return null;

    const hipCenter = midpoint(pose.lhip, pose.rhip);
    const leftSupport = supportPoint(frame, 'left');
    const rightSupport = supportPoint(frame, 'right');

    if (
      !validPoint(hipCenter) ||
      !validPoint(pose.lknee) ||
      !validPoint(pose.rknee) ||
      !validPoint(leftSupport) ||
      !validPoint(rightSupport)
    ) {
      return null;
    }

    const stanceWidth = Math.abs(leftSupport[0] - rightSupport[0]);
    if (!Number.isFinite(stanceWidth) || stanceWidth < 0.025) return null;

    const leftKneeRadius = Math.abs(pose.lknee[0] - hipCenter[0]);
    const rightKneeRadius = Math.abs(pose.rknee[0] - hipCenter[0]);
    const leftSupportRadius = Math.abs(leftSupport[0] - hipCenter[0]);
    const rightSupportRadius = Math.abs(rightSupport[0] - hipCenter[0]);

    const leftMedialGap = (leftSupportRadius - leftKneeRadius) / stanceWidth;
    const rightMedialGap = (rightSupportRadius - rightKneeRadius) / stanceWidth;

    const kneeWidth = Math.abs(pose.lknee[0] - pose.rknee[0]);
    const kneeWidthRatio = kneeWidth / stanceWidth;

    const visibilityValues = [
      visibilityForJoints(frame, ['lhip', 'rhip', 'lknee', 'rknee', 'lankle', 'rankle']),
      supportVisibility(frame, 'left'),
      supportVisibility(frame, 'right')
    ].filter(Number.isFinite);

    return {
      leftMedialGap,
      rightMedialGap,
      kneeWidthRatio,
      confidence: visibilityValues.length ? Math.min(...visibilityValues) : null
    };
  }

  function topReferenceMeasurements(rep) {
    const frames = Array.isArray(rep?.frames) ? rep.frames : [];

    // Only use near-top frames. The OR makes this tolerant of poor knee-angle
    // tracking: hipDropRatio can still tell us the athlete is close to the top.
    let topFrames = frames.filter(frame => {
      const hasHipDrop = Number.isFinite(frame?.hipDropRatio);
      if (hasHipDrop) {
        return frame.hipDropRatio <= 0.12;
      }

      // Only fall back to the knee angle when pelvis motion is unavailable.
      // A deliberately collapsed knee can make the 2D knee angle look almost
      // straight even at the bottom, so it must not override hipDropRatio.
      return Number.isFinite(frame?.kneeAngle) && frame.kneeAngle >= 145;
    });

    // On very short captures there may be only 1–2 sampled frames before the
    // descent. Falling back to the first 30% is preferable to dropping the
    // metric entirely, while still keeping the reference near the top.
    if (topFrames.length < 2 && frames.length) {
      const count = Math.max(2, Math.ceil(frames.length * 0.30));
      topFrames = frames.slice(0, count);
    }

    return topFrames
      .map(kneeTrackingMeasurement)
      .filter(Boolean);
  }

  function robustHigh(values) {
    const usable = values.filter(Number.isFinite).slice().sort((a, b) => b - a);
    if (!usable.length) return null;

    // Do not let one noisy landmark frame decide the whole repetition.
    // With a normal 12 Hz rep timeline this uses the strongest 2–3 frames.
    const count = usable.length >= 6
      ? Math.min(3, Math.ceil(usable.length * 0.20))
      : (usable.length >= 3 ? 2 : 1);

    return median(usable.slice(0, count));
  }

  function analyzeKneeTracking(rep) {
    const top = topReferenceMeasurements(rep);
    const frames = Array.isArray(rep?.frames) ? rep.frames.slice() : [];

    if (rep?.bottomFrame && !frames.includes(rep.bottomFrame)) {
      frames.push(rep.bottomFrame);
    }

    if (!top.length || !frames.length) {
      return {
        available: false,
        status: 'unavailable',
        side: null,
        leftInwardDelta: null,
        rightInwardDelta: null,
        kneeWidthNarrowing: null,
        confidence: null,
        label: 'Недостаточно данных'
      };
    }

    const baseLeft = median(top.map(item => item.leftMedialGap));
    const baseRight = median(top.map(item => item.rightMedialGap));
    const baseWidthRatio = median(top.map(item => item.kneeWidthRatio));

    // V0.2: inspect the WHOLE active repetition, not only bottomFrame.
    // A knee can collapse late in the ascent while the bottom itself looks fine.
    const active = frames
      .filter(frame => {
        const state = frame?.state;
        if (state === 'standing') return false;

        // When pelvis motion is available, ignore tiny near-top setup noise.
        if (Number.isFinite(frame?.hipDropRatio)) {
          return frame.hipDropRatio >= 0.06 || state === 'bottom';
        }

        return state === 'descending' || state === 'bottom' || state === 'ascending';
      })
      .map(frame => {
        const m = kneeTrackingMeasurement(frame);
        if (!m) return null;

        return {
          frame,
          measurement: m,
          leftDelta: Number.isFinite(baseLeft) ? m.leftMedialGap - baseLeft : null,
          rightDelta: Number.isFinite(baseRight) ? m.rightMedialGap - baseRight : null,
          widthNarrowing: Number.isFinite(baseWidthRatio) ? baseWidthRatio - m.kneeWidthRatio : null
        };
      })
      .filter(Boolean);

    if (!active.length) {
      return {
        available: false,
        status: 'unavailable',
        side: null,
        leftInwardDelta: null,
        rightInwardDelta: null,
        kneeWidthNarrowing: null,
        confidence: null,
        label: 'Недостаточно данных'
      };
    }

    const topConfidence = median(top.map(item => item.confidence));
    const activeConfidence = median(active.map(item => item.measurement.confidence));
    const confidence = clamp01(averageAvailable(topConfidence, activeConfidence));

    if (!Number.isFinite(confidence) || confidence < 0.45) {
      return {
        available: false,
        status: 'low_confidence',
        side: null,
        leftInwardDelta: null,
        rightInwardDelta: null,
        kneeWidthNarrowing: null,
        confidence,
        label: 'Низкая уверенность'
      };
    }

    const leftDelta = robustHigh(active.map(item => item.leftDelta));
    const rightDelta = robustHigh(active.map(item => item.rightDelta));
    const widthNarrowing = robustHigh(active.map(item => item.widthNarrowing));

    // Require the problem to exist in more than one sampled frame whenever
    // possible. This rejects a single MediaPipe twitch but still catches a
    // deliberate collapse during ascent/descent.
    const requiredIssueFrames = active.length >= 4 ? 2 : 1;

    let leftHits = 0;
    let rightHits = 0;
    let bilateralHits = 0;

    let strongest = null;
    let strongestScore = -Infinity;

    active.forEach(item => {
      const m = item.measurement;
      const leftIssue =
        Number.isFinite(item.leftDelta) &&
        item.leftDelta >= 0.055 &&
        m.leftMedialGap >= 0.10;

      const rightIssue =
        Number.isFinite(item.rightDelta) &&
        item.rightDelta >= 0.055 &&
        m.rightMedialGap >= 0.10;

      const bilateralNarrowing =
        Number.isFinite(item.widthNarrowing) &&
        item.widthNarrowing >= 0.14 &&
        m.kneeWidthRatio <= 0.92;

      if (leftIssue) leftHits++;
      if (rightIssue) rightHits++;
      if (bilateralNarrowing) bilateralHits++;

      const score = Math.max(
        Number.isFinite(item.leftDelta) ? item.leftDelta : -Infinity,
        Number.isFinite(item.rightDelta) ? item.rightDelta : -Infinity,
        Number.isFinite(item.widthNarrowing) ? item.widthNarrowing * 0.65 : -Infinity
      );

      if (score > strongestScore) {
        strongestScore = score;
        strongest = item;
      }
    });

    const leftIssue = leftHits >= requiredIssueFrames;
    const rightIssue = rightHits >= requiredIssueFrames;
    const bilateralNarrowing = bilateralHits >= requiredIssueFrames;

    let side = null;
    if ((leftIssue && rightIssue) || (bilateralNarrowing && (leftIssue || rightIssue))) {
      side = 'both';
    } else if (leftIssue) {
      side = 'left';
    } else if (rightIssue) {
      side = 'right';
    } else if (bilateralNarrowing) {
      side = 'both';
    }

    const strongestDelta = Math.max(
      Number.isFinite(leftDelta) ? leftDelta : -Infinity,
      Number.isFinite(rightDelta) ? rightDelta : -Infinity,
      Number.isFinite(widthNarrowing) ? widthNarrowing * 0.65 : -Infinity
    );

    const strong = side !== null && strongestDelta >= 0.105;
    const status = side === null
      ? 'stable'
      : (strong ? 'inward_strong' : 'inward');

    let label = 'Колени стабильно';
    if (side === 'both') label = strong ? 'Оба колена заметно внутрь' : 'Оба колена уходят внутрь';
    if (side === 'left') label = strong ? 'Левое колено заметно внутрь' : 'Левое колено уходит внутрь';
    if (side === 'right') label = strong ? 'Правое колено заметно внутрь' : 'Правое колено уходит внутрь';

    const bottom = kneeTrackingMeasurement(rep?.bottomFrame);

    return {
      available: true,
      status,
      side,
      leftInwardDelta: finiteOrNull(leftDelta),
      rightInwardDelta: finiteOrNull(rightDelta),
      kneeWidthNarrowing: finiteOrNull(widthNarrowing),
      bottomKneeWidthRatio: finiteOrNull(bottom?.kneeWidthRatio),
      confidence,
      issuePhase: side !== null ? (strongest?.frame?.state || null) : null,
      issueTime: side !== null ? finiteOrNull(strongest?.frame?.t) : null,
      sampledActiveFrames: active.length,
      issueFrames: {
        left: leftHits,
        right: rightHits,
        bilateral: bilateralHits
      },
      label
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
    const kneeTracking = analyzeKneeTracking(rep);
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
      kneeTracking,
      dataQuality
    };
  }

  function metricValues(repetitions, getter) {
    return repetitions
      .map(getter)
      .filter(Number.isFinite);
  }

  function minValue(values) {
    return values.length ? Math.min(...values) : null;
  }

  function maxValue(values) {
    return values.length ? Math.max(...values) : null;
  }

  function relativeLabel(value, averageValue, tolerance) {
    if (!Number.isFinite(value) || !Number.isFinite(averageValue)) {
      return 'Нет данных для сравнения';
    }

    const delta = value - averageValue;

    if (Math.abs(delta) <= tolerance) {
      return 'Примерно на уровне среднего по подходу';
    }

    return delta > 0
      ? 'Выше среднего по подходу'
      : 'Ниже среднего по подходу';
  }

  function trackingLabel(confidence) {
    if (!Number.isFinite(confidence)) {
      return 'Качество отслеживания не определено';
    }

    if (confidence >= 0.78) {
      return 'Отслеживание уверенное — выводам по этому повторению можно доверять больше.';
    }

    if (confidence >= 0.58) {
      return 'Отслеживание среднее — основные тенденции видны, но отдельные цифры могут плавать.';
    }

    return 'Отслеживание нестабильное — этот повтор лучше интерпретировать осторожно.';
  }

  function buildRepInterpretation(rep, averages) {
    const depth = rep?.depth?.depthValue;
    const duration = rep?.tempo?.totalMs;
    const torsoRange = rep?.torso?.rangeDegrees;
    const asymmetry = rep?.symmetry?.kneeAngleDifference;
    const confidence = rep?.dataQuality?.confidence;
    const kneeTracking = rep?.kneeTracking;

    const depthDelta = Number.isFinite(depth) && Number.isFinite(averages.depthValue)
      ? depth - averages.depthValue
      : null;

    const durationDelta = Number.isFinite(duration) && Number.isFinite(averages.durationMs)
      ? duration - averages.durationMs
      : null;

    const torsoDelta = Number.isFinite(torsoRange) && Number.isFinite(averages.torsoRangeDegrees)
      ? torsoRange - averages.torsoRangeDegrees
      : null;

    const asymmetryDelta = Number.isFinite(asymmetry) && Number.isFinite(averages.kneeAngleDifference)
      ? asymmetry - averages.kneeAngleDifference
      : null;

    const notes = [];

    if (kneeTracking?.available && kneeTracking.status !== 'stable') {
      notes.push(kneeTracking.label + '.');
    }

    if (Number.isFinite(depthDelta)) {
      if (depthDelta > 0.04) {
        notes.push('Глубже среднего по этому подходу.');
      } else if (depthDelta < -0.04) {
        notes.push('Мельче среднего по этому подходу.');
      } else {
        notes.push('Глубина близка к средней по подходу.');
      }
    }

    if (Number.isFinite(durationDelta) && Number.isFinite(averages.durationMs)) {
      const tempoTolerance = Math.max(160, averages.durationMs * 0.10);
      if (durationDelta > tempoTolerance) {
        notes.push('Повтор медленнее среднего темпа.');
      } else if (durationDelta < -tempoTolerance) {
        notes.push('Повтор быстрее среднего темпа.');
      } else {
        notes.push('Темп близок к среднему по подходу.');
      }
    }

    if (Number.isFinite(torsoDelta)) {
      if (torsoDelta > 2.5) {
        notes.push('Положение корпуса менялось сильнее, чем в среднем по подходу.');
      } else if (torsoDelta < -2.5) {
        notes.push('Корпус был стабильнее, чем в среднем по подходу.');
      }
    }

    if (Number.isFinite(asymmetryDelta)) {
      if (asymmetryDelta > 3) {
        notes.push('Разница L/R колена выше средней по этому подходу.');
      } else if (asymmetryDelta < -3) {
        notes.push('Разница L/R колена ниже средней по этому подходу.');
      }
    }

    if (!notes.length) {
      notes.push('По доступным метрикам повтор близок к среднему для этого подхода.');
    }

    return {
      summary: notes.slice(0, 2).join(' '),
      notes,
      tracking: trackingLabel(confidence),
      relative: {
        depth: relativeLabel(depth, averages.depthValue, 0.04),
        tempo: relativeLabel(
          duration,
          averages.durationMs,
          Number.isFinite(averages.durationMs)
            ? Math.max(160, averages.durationMs * 0.10)
            : 160
        ),
        torsoRange: relativeLabel(torsoRange, averages.torsoRangeDegrees, 2.5),
        kneeDifference: relativeLabel(asymmetry, averages.kneeAngleDifference, 3)
      }
    };
  }

  function buildSetInsights(repetitions, averages) {
    const depthValues = metricValues(repetitions, item => item.depth?.depthValue);
    const durationValues = metricValues(repetitions, item => item.tempo?.totalMs);
    const torsoValues = metricValues(repetitions, item => item.torso?.rangeDegrees);
    const asymmetryValues = metricValues(repetitions, item => item.symmetry?.kneeAngleDifference);
    const kneeIssueReps = repetitions.filter(
      item => item.kneeTracking?.available && item.kneeTracking.status !== 'stable'
    );

    const depthSpread = depthValues.length >= 2
      ? maxValue(depthValues) - minValue(depthValues)
      : null;

    const durationSpread = durationValues.length >= 2
      ? maxValue(durationValues) - minValue(durationValues)
      : null;

    const torsoSpread = torsoValues.length >= 2
      ? maxValue(torsoValues) - minValue(torsoValues)
      : null;

    const first = repetitions[0] || null;
    const last = repetitions[repetitions.length - 1] || null;

    const firstDepth = first?.depth?.depthValue;
    const lastDepth = last?.depth?.depthValue;
    const firstDuration = first?.tempo?.totalMs;
    const lastDuration = last?.tempo?.totalMs;
    const firstTorso = first?.torso?.rangeDegrees;
    const lastTorso = last?.torso?.rangeDegrees;

    const depthEndDelta = Number.isFinite(firstDepth) && Number.isFinite(lastDepth)
      ? lastDepth - firstDepth
      : null;

    const durationEndDelta = Number.isFinite(firstDuration) && Number.isFinite(lastDuration)
      ? lastDuration - firstDuration
      : null;

    const torsoEndDelta = Number.isFinite(firstTorso) && Number.isFinite(lastTorso)
      ? lastTorso - firstTorso
      : null;

    let depthText = 'Недостаточно данных, чтобы сравнить глубину между повторениями.';
    if (Number.isFinite(depthSpread)) {
      if (depthSpread <= 0.05) {
        depthText = 'Глубина по подходу была очень ровной: повторы почти не отличались по текущей 2D-метрике.';
      } else if (depthSpread <= 0.12) {
        depthText = 'Глубина немного менялась между повторениями, но без резких скачков.';
      } else {
        depthText = 'Глубина заметно менялась между повторениями — часть повторов получилась существенно глубже других.';
      }
    }

    let tempoText = 'Недостаточно данных, чтобы сравнить темп.';
    if (durationValues.length >= 2 && Number.isFinite(averages.durationMs) && averages.durationMs > 0) {
      const ratio = durationSpread / averages.durationMs;
      if (ratio <= 0.15) {
        tempoText = 'Темп был достаточно ровным от повторения к повторению.';
      } else if (ratio <= 0.30) {
        tempoText = 'Темп немного менялся по ходу подхода.';
      } else {
        tempoText = 'Темп заметно отличался между повторениями.';
      }
    }

    let torsoText = 'Недостаточно данных, чтобы сравнить стабильность корпуса.';
    if (Number.isFinite(torsoSpread)) {
      if (torsoSpread <= 4) {
        torsoText = 'Изменение корпуса было похоже от повторения к повторению.';
      } else {
        torsoText = 'Стабильность корпуса менялась между повторениями: в части повторов наклон менялся заметно сильнее.';
      }
    }

    let symmetryText = 'Недостаточно данных для сравнения левой и правой стороны.';
    if (asymmetryValues.length) {
      const maxAsymmetry = maxValue(asymmetryValues);
      const maxRep = repetitions.find(
        item => item.symmetry?.kneeAngleDifference === maxAsymmetry
      );
      symmetryText =
        `Средняя разница L/R колена — ${averages.kneeAngleDifference.toFixed(1)}°. ` +
        (maxRep ? `Самая большая разница была в повторе ${maxRep.repIndex}. ` : '') +
        'Это 2D-наблюдение: ракурс камеры может влиять на значение.';
    }

    const progression = [];

    if (Number.isFinite(depthEndDelta)) {
      if (depthEndDelta < -0.06) {
        progression.push('К концу подхода глубина стала меньше.');
      } else if (depthEndDelta > 0.06) {
        progression.push('К концу подхода глубина стала больше.');
      }
    }

    if (Number.isFinite(durationEndDelta) && Number.isFinite(firstDuration) && firstDuration > 0) {
      if (durationEndDelta > firstDuration * 0.20) {
        progression.push('Последний повтор заметно медленнее первого.');
      } else if (durationEndDelta < -firstDuration * 0.20) {
        progression.push('Последний повтор заметно быстрее первого.');
      }
    }

    if (Number.isFinite(torsoEndDelta)) {
      if (torsoEndDelta > 3.5) {
        progression.push('К концу подхода положение корпуса менялось сильнее.');
      } else if (torsoEndDelta < -3.5) {
        progression.push('К концу подхода корпус двигался стабильнее.');
      }
    }

    let mainFocus = 'Подход выглядит достаточно ровным по текущим измерениям. Сохраняй одинаковую глубину и темп от первого до последнего повтора.';

    if (Number.isFinite(averages.confidence) && averages.confidence < 0.58) {
      mainFocus = 'Кадр нестабилен — часть выводов может быть неточной.';
    } else if (kneeIssueReps.length) {
      const indexes = kneeIssueReps.map(item => item.repIndex).join(', ');
      mainFocus = `Колени уходят внутрь: повторы ${indexes}.`;
    } else if (Number.isFinite(depthEndDelta) && depthEndDelta < -0.06) {
      mainFocus = 'Главное наблюдение: к концу подхода глубина уменьшилась. На следующем подходе попробуй сохранить глубину первых повторов.';
    } else if (Number.isFinite(torsoEndDelta) && torsoEndDelta > 3.5) {
      mainFocus = 'Главное наблюдение: к концу подхода корпус стал двигаться менее стабильно. Сравни последние повторы с первыми.';
    } else if (
      Number.isFinite(durationEndDelta) &&
      Number.isFinite(firstDuration) &&
      firstDuration > 0 &&
      durationEndDelta > firstDuration * 0.20
    ) {
      mainFocus = 'Главное наблюдение: к концу подхода темп заметно замедлился. Это может быть признаком того, что последние повторы даются тяжелее.';
    } else if (Number.isFinite(depthSpread) && depthSpread > 0.12) {
      mainFocus = 'Повторы заметно отличаются по глубине. Попробуй сделать следующий подход более одинаковым от повторения к повторению.';
    }

    return {
      tracking: trackingLabel(averages.confidence),
      depth: depthText,
      tempo: tempoText,
      torso: torsoText,
      symmetry: symmetryText,
      progression: progression.length
        ? progression.join(' ')
        : 'От первого к последнему повтору нет заметного изменения по текущим метрикам.',
      mainFocus,
      kneeTracking: {
        issueCount: kneeIssueReps.length,
        issueRepIndexes: kneeIssueReps.map(item => item.repIndex)
      },
      diagnostics: {
        depthSpread: finiteOrNull(depthSpread),
        durationSpread: finiteOrNull(durationSpread),
        torsoSpread: finiteOrNull(torsoSpread),
        depthEndDelta: finiteOrNull(depthEndDelta),
        durationEndDelta: finiteOrNull(durationEndDelta),
        torsoEndDelta: finiteOrNull(torsoEndDelta)
      }
    };
  }

  function analyzeSet(reps) {
    const list = Array.isArray(reps) ? reps : [];
    const rawRepetitions = list.map(analyze);

    const avgDepth = average(
      rawRepetitions.map(item => item.depth?.depthValue)
    );

    const avgDurationMs = average(
      rawRepetitions.map(item => item.tempo?.totalMs)
    );

    const avgAsymmetry = average(
      rawRepetitions.map(item => item.symmetry?.kneeAngleDifference)
    );

    const avgTorsoRange = average(
      rawRepetitions.map(item => item.torso?.rangeDegrees)
    );

    const avgConfidence = average(
      rawRepetitions.map(item => item.dataQuality?.confidence)
    );

    const kneeIssueCount = rawRepetitions.filter(
      item => item.kneeTracking?.available && item.kneeTracking.status !== 'stable'
    ).length;

    const kneeEvaluatedCount = rawRepetitions.filter(
      item => item.kneeTracking?.available
    ).length;

    const averages = {
      depthValue: finiteOrNull(avgDepth),
      durationMs: finiteOrNull(avgDurationMs),
      kneeAngleDifference: finiteOrNull(avgAsymmetry),
      torsoRangeDegrees: finiteOrNull(avgTorsoRange),
      confidence: clamp01(avgConfidence),
      kneeIssueCount,
      kneeEvaluatedCount
    };

    const repetitions = rawRepetitions.map(rep => ({
      ...rep,
      interpretation: buildRepInterpretation(rep, averages)
    }));

    const insights = buildSetInsights(repetitions, averages);

    return {
      repCount: repetitions.length,
      repetitions,
      averages,
      insights
    };
  }

  return {
    analyze,
    analyzeSet
  };

})();
