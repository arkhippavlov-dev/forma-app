/* =====================================================================
   SQUAT ANALYSIS — v0.7-frontal-knee-tracking
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

  function isRtmwRep(rep) {
    if (rep?.poseSource === 'rtmw') return true;

    const provider =
      rep?.bottomFrame?.formaPose?.source?.provider;

    return provider === 'rtmw';
  }

  function robustHigh(values) {
    const usable = values
      .filter(Number.isFinite)
      .slice()
      .sort((a, b) => b - a);

    if (!usable.length) return null;

    const count = usable.length >= 6
      ? Math.min(3, Math.ceil(usable.length * 0.20))
      : (usable.length >= 3 ? 2 : 1);

    return median(usable.slice(0, count));
  }

  function robustLow(values) {
    const usable = values
      .filter(Number.isFinite)
      .slice()
      .sort((a, b) => a - b);

    if (!usable.length) return null;

    const count = usable.length >= 6
      ? Math.min(3, Math.ceil(usable.length * 0.20))
      : (usable.length >= 3 ? 2 : 1);

    return median(usable.slice(0, count));
  }

  function pointDistance(a, b) {
    if (!validPoint(a) || !validPoint(b)) return null;
    const value = Math.hypot(
      b[0] - a[0],
      b[1] - a[1]
    );
    return Number.isFinite(value) ? value : null;
  }

  function thighAngleToHorizontal(hip, knee) {
    if (!validPoint(hip) || !validPoint(knee)) return null;

    const dx = Math.abs(knee[0] - hip[0]);
    const dy = knee[1] - hip[1];
    const length = Math.hypot(dx, dy);

    if (!Number.isFinite(length) || length < 0.001) return null;

    // 0° = hip and knee at the same image height.
    // Positive = hip is above knee. Negative = hip is below knee.
    return Math.atan2(dy, Math.max(dx, 0.000001)) * 180 / Math.PI;
  }


  function hipKneeDepthRatio(hip, knee) {
    if (!validPoint(hip) || !validPoint(knee)) return null;

    const thighLength = Math.hypot(
      knee[0] - hip[0],
      knee[1] - hip[1]
    );

    if (!Number.isFinite(thighLength) || thighLength < 0.001) {
      return null;
    }

    // Image Y grows downward:
    // positive => hip is lower than knee in this 2D projection,
    // negative => hip is still above knee.
    return (hip[1] - knee[1]) / thighLength;
  }

  function analyzeRtmwDepth(rep) {
    const frames = Array.isArray(rep?.frames)
      ? rep.frames
      : [];

    const pelvisDropValues = frames
      .map(frame => frame?.hipDropRatio)
      .filter(Number.isFinite);

    const pelvisDropRatio = robustHigh(pelvisDropValues);

    const frame = rep?.bottomFrame;
    const pose = frame?.pose || {};

    const leftThighAngle = thighAngleToHorizontal(
      pose.lhip,
      pose.lknee
    );

    const rightThighAngle = thighAngleToHorizontal(
      pose.rhip,
      pose.rknee
    );

    const thighAngleDegrees = averageAvailable(
      leftThighAngle,
      rightThighAngle
    );

    const leftHipKneeRatio = hipKneeDepthRatio(
      pose.lhip,
      pose.lknee
    );

    const rightHipKneeRatio = hipKneeDepthRatio(
      pose.rhip,
      pose.rknee
    );

    const visibleSideDepthEvidence = [
      leftHipKneeRatio,
      rightHipKneeRatio
    ].filter(Number.isFinite);

    const bestHipKneeRatio = visibleSideDepthEvidence.length
      ? Math.max(...visibleSideDepthEvidence)
      : null;

    const confidence = frame
      ? averageAvailable(
          visibilityForJoints(frame, ['lhip', 'lknee', 'lankle']),
          visibilityForJoints(frame, ['rhip', 'rknee', 'rankle'])
        )
      : null;

    return {
      available: Number.isFinite(pelvisDropRatio),

      // Primary RTMW depth-consistency signal:
      // vertical pelvis descent normalized by standing torso length.
      // Larger = deeper. This is stable enough for comparing repetitions
      // inside one set, but is not yet a universal "legal depth" threshold.
      depthValue: finiteOrNull(pelvisDropRatio),
      pelvisDropRatio: finiteOrNull(pelvisDropRatio),
      metric: 'pelvis_drop_over_torso',

      // Secondary geometric evidence from the bottom frame. Positive means
      // the hip projects lower than the knee on that side. At oblique camera
      // angles one side can be distorted, so this remains supporting evidence.
      leftHipKneeRatio: finiteOrNull(leftHipKneeRatio),
      rightHipKneeRatio: finiteOrNull(rightHipKneeRatio),
      bestHipKneeRatio: finiteOrNull(bestHipKneeRatio),

      leftDepth: null,
      rightDepth: null,
      kneeAngle: finiteOrNull(frame?.kneeAngle),
      leftThighAngleDegrees: finiteOrNull(leftThighAngle),
      rightThighAngleDegrees: finiteOrNull(rightThighAngle),
      thighAngleDegrees: finiteOrNull(thighAngleDegrees),
      confidence: clamp01(confidence)
    };
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
    if (isRtmwRep(rep)) {
      return analyzeRtmwDepth(rep);
    }

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

  function jointAngleDegrees(a, b, c) {
    if (
      !validPoint(a) ||
      !validPoint(b) ||
      !validPoint(c)
    ) {
      return null;
    }

    const ab = [
      a[0] - b[0],
      a[1] - b[1]
    ];

    const cb = [
      c[0] - b[0],
      c[1] - b[1]
    ];

    const abLen =
      Math.hypot(ab[0], ab[1]);

    const cbLen =
      Math.hypot(cb[0], cb[1]);

    if (
      !Number.isFinite(abLen) ||
      !Number.isFinite(cbLen) ||
      abLen < 0.001 ||
      cbLen < 0.001
    ) {
      return null;
    }

    const cosine =
      (
        ab[0] * cb[0] +
        ab[1] * cb[1]
      ) /
      (abLen * cbLen);

    const safeCosine =
      Math.max(
        -1,
        Math.min(1, cosine)
      );

    return (
      Math.acos(safeCosine) *
      180 /
      Math.PI
    );
  }

  function analyzeRtmwSymmetry(rep) {
    const observability =
      rtmwFrontalObservability(rep);

    if (!observability.valid) {
      return {
        available: false,
        status: 'view_not_validated',
        leftMinKneeAngle: null,
        rightMinKneeAngle: null,
        kneeAngleDifference: null,
        loadedMedianDifferenceDegrees: null,
        issueFrameCount: 0,
        sampledLoadedFrames: 0,
        confidence:
          finiteOrNull(
            observability.confidence
          ),
        label:
          'Нужен фронтальный ракурс для надёжной оценки симметрии',
        observability
      };
    }

    const frames =
      Array.isArray(rep?.frames)
        ? rep.frames
        : [];

    const deepestDrop =
      robustHigh(
        frames
          .map(
            frame =>
              frame?.hipDropRatio
          )
          .filter(Number.isFinite)
      );

    if (
      !Number.isFinite(deepestDrop) ||
      deepestDrop <= 0.001
    ) {
      return {
        available: false,
        status: 'unavailable',
        leftMinKneeAngle: null,
        rightMinKneeAngle: null,
        kneeAngleDifference: null,
        loadedMedianDifferenceDegrees: null,
        issueFrameCount: 0,
        sampledLoadedFrames: 0,
        confidence:
          finiteOrNull(
            observability.confidence
          ),
        label: 'Недостаточно данных',
        observability
      };
    }

    const measured =
      frames
        .map(frame => {
          const pose = frame?.pose || {};

          const leftAngle =
            jointAngleDegrees(
              pose.lhip,
              pose.lknee,
              pose.lankle
            );

          const rightAngle =
            jointAngleDegrees(
              pose.rhip,
              pose.rknee,
              pose.rankle
            );

          const depthFraction =
            Number.isFinite(
              frame?.hipDropRatio
            )
              ? frame.hipDropRatio /
                deepestDrop
              : null;

          if (
            !Number.isFinite(leftAngle) ||
            !Number.isFinite(rightAngle) ||
            !Number.isFinite(depthFraction) ||
            depthFraction < 0.40
          ) {
            return null;
          }

          return {
            leftAngle,
            rightAngle,
            difference:
              Math.abs(
                leftAngle -
                rightAngle
              )
          };
        })
        .filter(Boolean);

    if (measured.length < 3) {
      return {
        available: false,
        status: 'unavailable',
        leftMinKneeAngle: null,
        rightMinKneeAngle: null,
        kneeAngleDifference: null,
        loadedMedianDifferenceDegrees: null,
        issueFrameCount: 0,
        sampledLoadedFrames:
          measured.length,
        confidence:
          finiteOrNull(
            observability.confidence
          ),
        label: 'Недостаточно данных',
        observability
      };
    }

    const differences =
      measured.map(
        item =>
          item.difference
      );

    const peakDifference =
      robustHigh(differences);

    const medianDifference =
      median(differences);

    // V0.8 calibration:
    // dedicated frontal-good reps stayed below ~7° at the robust peak.
    // The deliberately one-sided knee-collapse reps produced ~30° and ~53°,
    // while the deliberately BILATERAL collapse stayed symmetric (~5°).
    //
    // This means the metric describes LEFT/RIGHT movement mismatch.
    // It is not another valgus detector: a symmetric bad movement can still
    // correctly be "symmetric".
    const issueFrameCount =
      differences.filter(
        value =>
          value >= 18
      ).length;

    const asymmetric =
      Number.isFinite(
        peakDifference
      ) &&
      peakDifference >= 18 &&
      issueFrameCount >= 2;

    return {
      available: true,
      status:
        asymmetric
          ? 'asymmetric'
          : 'stable',
      leftMinKneeAngle:
        finiteOrNull(
          Math.min(
            ...measured.map(
              item =>
                item.leftAngle
            )
          )
        ),
      rightMinKneeAngle:
        finiteOrNull(
          Math.min(
            ...measured.map(
              item =>
                item.rightAngle
            )
          )
        ),
      kneeAngleDifference:
        finiteOrNull(
          peakDifference
        ),
      loadedMedianDifferenceDegrees:
        finiteOrNull(
          medianDifference
        ),
      issueFrameCount,
      sampledLoadedFrames:
        measured.length,
      confidence:
        finiteOrNull(
          observability.confidence
        ),
      label:
        asymmetric
          ? 'Есть заметная разница между левой и правой стороной'
          : 'Левая и правая стороны двигаются похоже',
      observability
    };
  }

  function analyzeSymmetry(rep) {
    if (isRtmwRep(rep)) {
      return analyzeRtmwSymmetry(rep);
    }

    const left =
      finiteOrNull(
        rep?.leftMinKneeAngle
      );

    const right =
      finiteOrNull(
        rep?.rightMinKneeAngle
      );

    if (
      !Number.isFinite(left) ||
      !Number.isFinite(right)
    ) {
      return {
        available: false,
        status: 'unavailable',
        leftMinKneeAngle: left,
        rightMinKneeAngle: right,
        kneeAngleDifference: null,
        loadedMedianDifferenceDegrees: null,
        issueFrameCount: 0,
        sampledLoadedFrames: 0,
        confidence: null,
        label: 'Недостаточно данных'
      };
    }

    const leftConfidence =
      averageLegVisibility(
        rep,
        'left'
      );

    const rightConfidence =
      averageLegVisibility(
        rep,
        'right'
      );

    const confidence =
      averageAvailable(
        leftConfidence,
        rightConfidence
      );

    return {
      available: true,
      status: 'descriptive_only',
      leftMinKneeAngle: left,
      rightMinKneeAngle: right,
      kneeAngleDifference:
        Math.abs(left - right),
      loadedMedianDifferenceDegrees: null,
      issueFrameCount: 0,
      sampledLoadedFrames: 0,
      confidence:
        clamp01(confidence),
      label:
        'Разница L/R доступна только как описательная 2D-метрика'
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

    // Practical toe-tracking cue in the 2D projection. We do NOT demand
    // literal geometric parallelism (a 2D camera cannot recover that
    // reliably). Instead we detect the strong contradiction case: the toe
    // points outward while the knee has crossed inward relative to the ankle.
    function toeDirection(side) {
      const ankle = side === 'left' ? pose.lankle : pose.rankle;
      const foot = side === 'left' ? pose.lfoot : pose.rfoot;
      const knee = side === 'left' ? pose.lknee : pose.rknee;

      if (!validPoint(ankle) || !validPoint(foot) || !validPoint(knee)) {
        return { toeOut: null, kneeOut: null, conflict: false };
      }

      // Positive means away from the body centre for this side.
      const outwardSign = ankle[0] >= hipCenter[0] ? 1 : -1;
      const toeOut = ((foot[0] - ankle[0]) * outwardSign) / stanceWidth;
      const kneeOut = ((knee[0] - ankle[0]) * outwardSign) / stanceWidth;

      return {
        toeOut,
        kneeOut,
        conflict:
          Number.isFinite(toeOut) &&
          Number.isFinite(kneeOut) &&
          toeOut >= 0.035 &&
          kneeOut <= -0.025
      };
    }

    const leftToe = toeDirection('left');
    const rightToe = toeDirection('right');

    const visibilityValues = [
      visibilityForJoints(frame, ['lhip', 'rhip', 'lknee', 'rknee', 'lankle', 'rankle']),
      supportVisibility(frame, 'left'),
      supportVisibility(frame, 'right')
    ].filter(Number.isFinite);

    return {
      leftMedialGap,
      rightMedialGap,
      kneeWidthRatio,
      leftToeOut: finiteOrNull(leftToe.toeOut),
      rightToeOut: finiteOrNull(rightToe.toeOut),
      leftKneeOut: finiteOrNull(leftToe.kneeOut),
      rightKneeOut: finiteOrNull(rightToe.kneeOut),
      leftToeConflict: leftToe.conflict,
      rightToeConflict: rightToe.conflict,
      confidence: visibilityValues.length ? Math.min(...visibilityValues) : null
    };
  }

  function topReferenceMeasurements(rep) {
    const frames = Array.isArray(rep?.frames) ? rep.frames : [];

    if (!frames.length) return [];

    // IMPORTANT: build the reference ONLY from the beginning of the rep.
    // V0.2 used every near-top frame, including late ascent. If the athlete
    // caved the knees only while standing back up, those bad frames could
    // contaminate the baseline and hide the very error we wanted to detect.
    const earlyCount = Math.max(2, Math.min(5, Math.ceil(frames.length * 0.28)));
    const earlyFrames = frames.slice(0, earlyCount);

    let topFrames = earlyFrames.filter(frame => {
      const hasHipDrop = Number.isFinite(frame?.hipDropRatio);
      if (hasHipDrop) return frame.hipDropRatio <= 0.14;
      return Number.isFinite(frame?.kneeAngle) && frame.kneeAngle >= 140;
    });

    // If capture started a little late, keep the earliest available frames
    // rather than borrowing frames from the ascent.
    if (topFrames.length < 2) {
      topFrames = earlyFrames.slice(0, Math.min(3, earlyFrames.length));
    }

    return topFrames
      .map(kneeTrackingMeasurement)
      .filter(Boolean);
  }


  function rtmwFrontalFrameEvidence(frame) {
    const pose = frame?.pose;
    if (!pose) return null;

    const required = [
      pose.lshoulder,
      pose.rshoulder,
      pose.lhip,
      pose.rhip,
      pose.lknee,
      pose.rknee,
      pose.lankle,
      pose.rankle
    ];

    if (!required.every(validPoint)) return null;

    const shoulderMid = midpoint(
      pose.lshoulder,
      pose.rshoulder
    );

    const hipMid = midpoint(
      pose.lhip,
      pose.rhip
    );

    const shoulderWidth = pointDistance(
      pose.lshoulder,
      pose.rshoulder
    );

    const torsoLength = pointDistance(
      shoulderMid,
      hipMid
    );

    const leftFemur = pointDistance(
      pose.lhip,
      pose.lknee
    );

    const rightFemur = pointDistance(
      pose.rhip,
      pose.rknee
    );

    const leftShin = pointDistance(
      pose.lknee,
      pose.lankle
    );

    const rightShin = pointDistance(
      pose.rknee,
      pose.rankle
    );

    if (
      !Number.isFinite(shoulderWidth) ||
      !Number.isFinite(torsoLength) ||
      !Number.isFinite(leftFemur) ||
      !Number.isFinite(rightFemur) ||
      !Number.isFinite(leftShin) ||
      !Number.isFinite(rightShin) ||
      shoulderWidth < 0.001 ||
      torsoLength < 0.001 ||
      leftFemur < 0.001 ||
      rightFemur < 0.001 ||
      leftShin < 0.001 ||
      rightShin < 0.001
    ) {
      return null;
    }

    const femurSymmetry =
      Math.min(leftFemur, rightFemur) /
      Math.max(leftFemur, rightFemur);

    const shinSymmetry =
      Math.min(leftShin, rightShin) /
      Math.max(leftShin, rightShin);

    const shoulderVerticalSkew =
      Math.abs(
        pose.lshoulder[1] -
        pose.rshoulder[1]
      ) /
      shoulderWidth;

    const shoulderWidthOverTorso =
      shoulderWidth /
      torsoLength;

    return {
      femurSymmetry,
      shinSymmetry,
      shoulderVerticalSkew,
      shoulderWidthOverTorso
    };
  }

  function rtmwFrontalObservability(rep) {
    const frames = Array.isArray(rep?.frames)
      ? rep.frames
      : [];

    const evidence =
      frames
        .map(rtmwFrontalFrameEvidence)
        .filter(Boolean);

    if (evidence.length < 3) {
      return {
        valid: false,
        confidence: null,
        signalCount: 0,
        femurSymmetry: null,
        shinSymmetry: null,
        shoulderVerticalSkew: null,
        shoulderWidthOverTorso: null
      };
    }

    const femurSymmetry =
      median(
        evidence.map(
          item => item.femurSymmetry
        )
      );

    const shinSymmetry =
      median(
        evidence.map(
          item => item.shinSymmetry
        )
      );

    const shoulderVerticalSkew =
      median(
        evidence.map(
          item => item.shoulderVerticalSkew
        )
      );

    const shoulderWidthOverTorso =
      median(
        evidence.map(
          item => item.shoulderWidthOverTorso
        )
      );

    // Conservative frontal-view gate. The first 45° calibration set failed
    // these symmetry tests, while the dedicated frontal set passed them with
    // a wide margin. Requiring 3/4 signals makes one unusual body proportion
    // or a little camera tilt insufficient to reject an otherwise frontal view.
    const signals = [
      Number.isFinite(femurSymmetry) &&
        femurSymmetry >= 0.92,

      Number.isFinite(shinSymmetry) &&
        shinSymmetry >= 0.94,

      Number.isFinite(shoulderVerticalSkew) &&
        shoulderVerticalSkew <= 0.08,

      Number.isFinite(shoulderWidthOverTorso) &&
        shoulderWidthOverTorso >= 0.95
    ];

    const signalCount =
      signals.filter(Boolean).length;

    return {
      valid: signalCount >= 3,
      confidence: signalCount / 4,
      signalCount,
      femurSymmetry: finiteOrNull(femurSymmetry),
      shinSymmetry: finiteOrNull(shinSymmetry),
      shoulderVerticalSkew: finiteOrNull(shoulderVerticalSkew),
      shoulderWidthOverTorso: finiteOrNull(shoulderWidthOverTorso)
    };
  }

  function rtmwKneeOffsetMeasurement(frame) {
    const pose = frame?.pose;
    if (!pose) return null;

    const hipCenter = midpoint(
      pose.lhip,
      pose.rhip
    );

    if (
      !validPoint(hipCenter) ||
      !validPoint(pose.lknee) ||
      !validPoint(pose.rknee) ||
      !validPoint(pose.lankle) ||
      !validPoint(pose.rankle)
    ) {
      return null;
    }

    const stanceWidth =
      Math.abs(
        pose.lankle[0] -
        pose.rankle[0]
      );

    if (
      !Number.isFinite(stanceWidth) ||
      stanceWidth < 0.025
    ) {
      return null;
    }

    function sideOffset(side) {
      const knee =
        side === 'left'
          ? pose.lknee
          : pose.rknee;

      const ankle =
        side === 'left'
          ? pose.lankle
          : pose.rankle;

      // Positive = knee is lateral to the ankle (away from body centre).
      // Near zero / negative during the loaded phase means the knee has
      // approached or crossed the ankle line in this frontal projection.
      const outwardSign =
        ankle[0] >= hipCenter[0]
          ? 1
          : -1;

      return (
        (knee[0] - ankle[0]) *
        outwardSign
      ) / stanceWidth;
    }

    return {
      leftOffset: sideOffset('left'),
      rightOffset: sideOffset('right')
    };
  }

  function analyzeRtmwFrontalKnees(rep) {
    const observability =
      rtmwFrontalObservability(rep);

    if (!observability.valid) {
      return {
        available: false,
        status: 'view_not_validated',
        side: null,
        leftInwardDelta: null,
        rightInwardDelta: null,
        kneeWidthNarrowing: null,
        confidence: finiteOrNull(observability.confidence),
        label: 'Нужен более фронтальный ракурс для надёжной оценки',
        observability
      };
    }

    const frames = Array.isArray(rep?.frames)
      ? rep.frames
      : [];

    const deepestDrop =
      robustHigh(
        frames
          .map(frame => frame?.hipDropRatio)
          .filter(Number.isFinite)
      );

    if (
      !Number.isFinite(deepestDrop) ||
      deepestDrop <= 0.001
    ) {
      return {
        available: false,
        status: 'unavailable',
        side: null,
        leftInwardDelta: null,
        rightInwardDelta: null,
        kneeWidthNarrowing: null,
        confidence: finiteOrNull(observability.confidence),
        label: 'Недостаточно данных',
        observability
      };
    }

    const measured =
      frames
        .map(frame => {
          const measurement =
            rtmwKneeOffsetMeasurement(frame);

          const depthFraction =
            Number.isFinite(frame?.hipDropRatio)
              ? frame.hipDropRatio / deepestDrop
              : null;

          if (
            !measurement ||
            !Number.isFinite(depthFraction)
          ) {
            return null;
          }

          return {
            frame,
            depthFraction,
            ...measurement
          };
        })
        .filter(Boolean);

    // Ignore the near-standing part of the rep. In normal squat mechanics
    // knees naturally return toward the ankle line as the legs straighten.
    // Valgus here is evaluated only while the athlete is still meaningfully
    // loaded / flexed.
    const loaded =
      measured.filter(
        item =>
          item.depthFraction >= 0.40
      );

    const deep =
      measured.filter(
        item =>
          item.depthFraction >= 0.85
      );

    if (
      loaded.length < 3 ||
      deep.length < 2
    ) {
      return {
        available: false,
        status: 'unavailable',
        side: null,
        leftInwardDelta: null,
        rightInwardDelta: null,
        kneeWidthNarrowing: null,
        confidence: finiteOrNull(observability.confidence),
        label: 'Недостаточно данных',
        observability
      };
    }

    function sideSummary(side) {
      const key =
        side === 'left'
          ? 'leftOffset'
          : 'rightOffset';

      const minimumLoadedOffset =
        robustLow(
          loaded.map(
            item => item[key]
          )
        );

      const deepReferenceOffset =
        median(
          deep.map(
            item => item[key]
          )
        );

      const inwardCollapse =
        (
          Number.isFinite(minimumLoadedOffset) &&
          Number.isFinite(deepReferenceOffset)
        )
          ? deepReferenceOffset -
            minimumLoadedOffset
          : null;

      // Calibration V0.7:
      // frontal-good reps stayed >= ~0.20 stance widths from the ankle line
      // and showed <= ~0.13 inward excursion. Intentional valgus reps reached
      // <= ~0.14 and collapsed inward by >= ~0.26. These deliberately
      // conservative boundaries leave a margin between the two groups.
      const clearCollapse =
        Number.isFinite(minimumLoadedOffset) &&
        Number.isFinite(inwardCollapse) &&
        minimumLoadedOffset <= 0.16 &&
        inwardCollapse >= 0.20;

      return {
        minimumLoadedOffset:
          finiteOrNull(
            minimumLoadedOffset
          ),

        deepReferenceOffset:
          finiteOrNull(
            deepReferenceOffset
          ),

        inwardCollapse:
          finiteOrNull(
            inwardCollapse
          ),

        clearCollapse
      };
    }

    const left =
      sideSummary('left');

    const right =
      sideSummary('right');

    let side = null;

    if (
      left.clearCollapse &&
      right.clearCollapse
    ) {
      side = 'both';
    } else if (left.clearCollapse) {
      side = 'left';
    } else if (right.clearCollapse) {
      side = 'right';
    }

    const status =
      side
        ? 'valgus'
        : 'stable';

    let label =
      'Колени стабильно';

    if (side === 'both') {
      label =
        'Оба колена заметно уходят внутрь';
    } else if (side === 'left') {
      label =
        'Левое колено заметно уходит внутрь';
    } else if (side === 'right') {
      label =
        'Правое колено заметно уходит внутрь';
    }

    return {
      available: true,
      status,
      side,
      leftInwardDelta:
        left.inwardCollapse,
      rightInwardDelta:
        right.inwardCollapse,
      kneeWidthNarrowing: null,
      confidence:
        finiteOrNull(
          observability.confidence
        ),
      label,
      observability,
      diagnostics: {
        loadedFrameCount:
          loaded.length,
        deepFrameCount:
          deep.length,
        left,
        right
      }
    };
  }

  function analyzeKneeTracking(rep) {
    // RTMW V0.7: knees are evaluated only when the pose itself looks
    // sufficiently frontal. Oblique views stay limited instead of producing
    // a confident but perspective-driven valgus verdict.
    if (isRtmwRep(rep)) {
      return analyzeRtmwFrontalKnees(rep);
    }

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

        // The important change from V0.2: NEVER cut off the late ascent.
        // A knee can collapse only while the athlete is standing back up.
        if (state === 'ascending' || state === 'bottom') return true;

        if (state === 'descending') {
          // Ignore only the tiniest setup wobble before an actual descent.
          if (Number.isFinite(frame?.hipDropRatio)) {
            return frame.hipDropRatio >= 0.025;
          }
          return true;
        }

        return false;
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

    // V0.4 intentionally returns to a CONSERVATIVE, side-specific rule.
    // V0.3 became too eager because a noisy toe landmark or a temporary
    // narrowing of BOTH knees could label a clean repetition as valgus.
    //
    // A side is now flagged only when THAT SAME knee shows a sustained
    // medial shift relative to its own early-rep reference.  We still inspect
    // the whole descent + ascent, so a collapse that appears only on the way
    // up can be detected.  Foot/toe data stays available for diagnostics, but
    // it is not allowed to decide the verdict by itself on the current 2D
    // MediaPipe model.
    const requiredIssueFrames =
      active.length >= 8 ? 3 :
      active.length >= 4 ? 2 :
      1;

    let leftHits = 0;
    let rightHits = 0;
    let bilateralHits = 0;

    let strongest = null;
    let strongestScore = -Infinity;

    active.forEach(item => {
      const m = item.measurement;

      // These thresholds are deliberately stricter than V0.3.  A normal
      // squat naturally lets the knees move somewhat inward relative to a
      // wide stance; we only care about a clear extra medial shift.
      const leftIssue =
        Number.isFinite(item.leftDelta) &&
        item.leftDelta >= 0.055 &&
        m.leftMedialGap >= 0.10;

      const rightIssue =
        Number.isFinite(item.rightDelta) &&
        item.rightDelta >= 0.055 &&
        m.rightMedialGap >= 0.10;

      // Keep this only as a diagnostic number.  Perspective at ~45 degrees
      // can make the knee-to-knee width shrink even when just one side moved,
      // so it must NEVER turn one-sided motion into "both knees".
      const bilateralNarrowing =
        Number.isFinite(item.widthNarrowing) &&
        item.widthNarrowing >= 0.14 &&
        m.kneeWidthRatio <= 0.92;

      if (leftIssue) leftHits++;
      if (rightIssue) rightHits++;
      if (bilateralNarrowing) bilateralHits++;

      const score = Math.max(
        Number.isFinite(item.leftDelta) ? item.leftDelta : -Infinity,
        Number.isFinite(item.rightDelta) ? item.rightDelta : -Infinity
      );

      if (score > strongestScore) {
        strongestScore = score;
        strongest = item;
      }
    });

    const leftIssue = leftHits >= requiredIssueFrames;
    const rightIssue = rightHits >= requiredIssueFrames;

    let side = null;
    if (leftIssue && rightIssue) {
      side = 'both';
    } else if (leftIssue) {
      side = 'left';
    } else if (rightIssue) {
      side = 'right';
    }

    const sideDeltas = side === 'left'
      ? [leftDelta]
      : side === 'right'
        ? [rightDelta]
        : side === 'both'
          ? [leftDelta, rightDelta]
          : [];

    const strongestDelta = Math.max(
      ...sideDeltas.filter(Number.isFinite),
      -Infinity
    );

    const strong = side !== null && strongestDelta >= 0.115;
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

  function standardDeviation(values) {
    const usable =
      values.filter(Number.isFinite);

    if (usable.length < 2) {
      return null;
    }

    const mean =
      average(usable);

    const variance =
      usable.reduce(
        (sum, value) =>
          sum +
          Math.pow(value - mean, 2),
        0
      ) /
      usable.length;

    return Math.sqrt(variance);
  }

  function coefficientOfVariation(values) {
    const usable =
      values.filter(
        value =>
          Number.isFinite(value) &&
          value > 0.001
      );

    if (usable.length < 3) {
      return null;
    }

    const mean =
      average(usable);

    const sd =
      standardDeviation(usable);

    if (
      !Number.isFinite(mean) ||
      mean <= 0.001 ||
      !Number.isFinite(sd)
    ) {
      return null;
    }

    return sd / mean;
  }

  function rtmwDataQuality(rep) {
    const frames =
      Array.isArray(rep?.frames)
        ? rep.frames
        : [];

    const joints = [
      'lshoulder', 'rshoulder',
      'lhip', 'rhip',
      'lknee', 'rknee',
      'lankle', 'rankle'
    ];

    if (!frames.length) {
      return {
        available: false,
        status: 'low',
        confidence: 0,
        sampledFrames: 0,
        jointCoverage: 0,
        completeFrameRatio: 0,
        geometryConsistencyScore: null,
        medianBoneLengthCv: null,
        sampleScore: 0,
        limitations: [
          'Нет кадров для анализа'
        ]
      };
    }

    let validJointCount = 0;
    let completeFrameCount = 0;

    frames.forEach(frame => {
      const pose =
        frame?.pose || {};

      let validInFrame = 0;

      joints.forEach(joint => {
        if (validPoint(pose[joint])) {
          validJointCount++;
          validInFrame++;
        }
      });

      if (validInFrame === joints.length) {
        completeFrameCount++;
      }
    });

    const possibleJointCount =
      frames.length * joints.length;

    const jointCoverage =
      possibleJointCount > 0
        ? validJointCount /
          possibleJointCount
        : 0;

    const completeFrameRatio =
      frames.length > 0
        ? completeFrameCount /
          frames.length
        : 0;

    const bonePairs = [
      ['lshoulder', 'lhip'],
      ['rshoulder', 'rhip'],
      ['lhip', 'lknee'],
      ['rhip', 'rknee'],
      ['lknee', 'lankle'],
      ['rknee', 'rankle']
    ];

    const boneVariation =
      bonePairs
        .map(pair =>
          coefficientOfVariation(
            frames
              .map(frame => {
                const pose =
                  frame?.pose || {};

                return pointDistance(
                  pose[pair[0]],
                  pose[pair[1]]
                );
              })
              .filter(Number.isFinite)
          )
        )
        .filter(Number.isFinite);

    const medianBoneLengthCv =
      median(boneVariation);

    // Apparent segment lengths legitimately change somewhat in 2D because of
    // perspective and rotation. Therefore this is a deliberately loose guard:
    // it catches gross landmark instability, not normal projection effects.
    let geometryConsistencyScore = 0.60;

    if (Number.isFinite(medianBoneLengthCv)) {
      if (medianBoneLengthCv <= 0.14) {
        geometryConsistencyScore = 1;
      } else if (medianBoneLengthCv >= 0.40) {
        geometryConsistencyScore = 0;
      } else {
        geometryConsistencyScore =
          1 -
          (
            medianBoneLengthCv - 0.14
          ) /
          0.26;
      }
    }

    geometryConsistencyScore =
      clamp01(geometryConsistencyScore);

    const sampleScore =
      clamp01(
        frames.length / 10
      );

    // Coordinate coverage matters most. Geometry consistency is a secondary
    // tracking sanity-check, while sample count prevents very short captures
    // from receiving a deceptively high score.
    let confidence =
      clamp01(
        jointCoverage * 0.50 +
        completeFrameRatio * 0.20 +
        geometryConsistencyScore * 0.20 +
        sampleScore * 0.10
      );

    // A weighted average must not hide one catastrophic failure. These caps
    // make quality a guardrail: too few frames, large landmark loss, or gross
    // geometric instability can never be reported as "high confidence" just
    // because the remaining signals look clean.
    if (frames.length < 5) {
      confidence = Math.min(
        confidence,
        0.55
      );
    }

    if (
      jointCoverage < 0.75 ||
      completeFrameRatio < 0.50
    ) {
      confidence = Math.min(
        confidence,
        0.60
      );
    }

    if (
      Number.isFinite(geometryConsistencyScore) &&
      geometryConsistencyScore < 0.35
    ) {
      confidence = Math.min(
        confidence,
        0.60
      );
    }

    const status =
      confidence >= 0.85
        ? 'high'
        : (
            confidence >= 0.65
              ? 'medium'
              : 'low'
          );

    const limitations = [];

    if (jointCoverage < 0.92) {
      limitations.push(
        'Часть ключевых точек терялась'
      );
    }

    if (completeFrameRatio < 0.75) {
      limitations.push(
        'Не на всех кадрах виден полный набор ключевых точек'
      );
    }

    if (
      Number.isFinite(medianBoneLengthCv) &&
      medianBoneLengthCv > 0.22
    ) {
      limitations.push(
        'Точки тела заметно нестабильны между кадрами'
      );
    }

    if (frames.length < 8) {
      limitations.push(
        'Слишком мало кадров внутри повторения'
      );
    }

    return {
      available: true,
      status,
      confidence,
      sampledFrames:
        frames.length,
      jointCoverage:
        finiteOrNull(jointCoverage),
      completeFrameRatio:
        finiteOrNull(completeFrameRatio),
      geometryConsistencyScore:
        finiteOrNull(
          geometryConsistencyScore
        ),
      medianBoneLengthCv:
        finiteOrNull(
          medianBoneLengthCv
        ),
      sampleScore:
        finiteOrNull(sampleScore),
      limitations
    };
  }

  function analyzeDataQuality(rep) {
    if (isRtmwRep(rep)) {
      return rtmwDataQuality(rep);
    }

    const frames = [];

    if (rep?.bottomFrame) {
      frames.push(rep.bottomFrame);
    }

    if (Array.isArray(rep?.frames)) {
      frames.push(...rep.frames);
    }

    const requiredKeys = [
      'LEFT_SHOULDER', 'RIGHT_SHOULDER',
      'LEFT_HIP', 'RIGHT_HIP',
      'LEFT_KNEE', 'RIGHT_KNEE',
      'LEFT_ANKLE', 'RIGHT_ANKLE'
    ];

    const values = [];

    frames.forEach(frame => {
      requiredKeys.forEach(key => {
        const value =
          visibilityValue(frame, key);

        if (Number.isFinite(value)) {
          values.push(value);
        }
      });
    });

    const confidence =
      clamp01(average(values));

    const status =
      !Number.isFinite(confidence)
        ? 'low'
        : (
            confidence >= 0.78
              ? 'high'
              : (
                  confidence >= 0.58
                    ? 'medium'
                    : 'low'
                )
          );

    return {
      available:
        Number.isFinite(confidence),
      status,
      confidence,
      sampledFrames:
        Array.isArray(rep?.frames)
          ? rep.frames.length
          : 0,
      jointCoverage: null,
      completeFrameRatio: null,
      geometryConsistencyScore: null,
      medianBoneLengthCv: null,
      sampleScore: null,
      limitations:
        status === 'low'
          ? [
              'Низкая уверенность MediaPipe'
            ]
          : []
    };
  }

  function capMetricConfidence(metric, qualityConfidence) {
    if (
      !metric ||
      !Number.isFinite(qualityConfidence)
    ) {
      return metric;
    }

    if (Number.isFinite(metric.confidence)) {
      metric.confidence =
        Math.min(
          metric.confidence,
          qualityConfidence
        );
    } else if (metric.available) {
      metric.confidence =
        qualityConfidence;
    }

    return metric;
  }

  function analyze(rep) {
    const dataQuality = analyzeDataQuality(rep);
    const qualityConfidence = dataQuality?.confidence;

    const depth = capMetricConfidence(
      analyzeDepth(rep),
      qualityConfidence
    );

    const tempo = analyzeTempo(rep);

    const symmetry = capMetricConfidence(
      analyzeSymmetry(rep),
      qualityConfidence
    );

    const torso = capMetricConfidence(
      analyzeTorso(rep),
      qualityConfidence
    );

    const kneeTracking = capMetricConfidence(
      analyzeKneeTracking(rep),
      qualityConfidence
    );

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

    if (confidence >= 0.85) {
      return 'Качество отслеживания высокое — выводам по этому повторению можно доверять больше.';
    }

    if (confidence >= 0.65) {
      return 'Качество отслеживания среднее — основные тенденции видны, но отдельные цифры могут плавать.';
    }

    return 'Отслеживание нестабильное — этот повтор лучше интерпретировать осторожно.';
  }


  function depthReferenceValue(repetitions) {
    return median(
      repetitions
        .map(item => item?.depth?.depthValue)
        .filter(Number.isFinite)
    );
  }

  function classifyRelativeDepth(value, reference) {
    if (
      !Number.isFinite(value) ||
      !Number.isFinite(reference) ||
      reference <= 0.001
    ) {
      return {
        status: 'unknown',
        delta: null,
        ratio: null
      };
    }

    const delta = value - reference;
    const ratio = value / reference;

    // Calibrated on the first RTMW squat dataset:
    // obvious intentional shallow reps were ~35-50% below the set reference,
    // while normal repetitions stayed much closer together.
    // This is deliberately a RELATIVE within-set rule, not a claim that one
    // absolute number is correct for every body / camera / stance.
    const noticeablyShallower =
      ratio <= 0.82 &&
      delta <= -0.12;

    const noticeablyDeeper =
      ratio >= 1.18 &&
      delta >= 0.12;

    return {
      status:
        noticeablyShallower
          ? 'shallower'
          : (noticeablyDeeper ? 'deeper' : 'consistent'),
      delta,
      ratio
    };
  }


  function torsoReferenceValue(repetitions) {
    return median(
      repetitions
        .map(item => item?.torso?.maxLeanDegrees)
        .filter(Number.isFinite)
    );
  }

  function classifyRelativeTorso(value, reference, repCount) {
    if (
      !Number.isFinite(value) ||
      !Number.isFinite(reference) ||
      reference <= 0.001 ||
      !Number.isFinite(repCount) ||
      repCount < 2
    ) {
      return { status: 'unknown', delta: null, ratio: null };
    }

    const delta = value - reference;
    const ratio = value / reference;

    // Calibrated conservatively on the first RTMW squat dataset.
    // This is a within-set consistency signal, not a universal torso limit.
    const moreLean = delta >= 10 && ratio >= 1.15;

    return {
      status: moreLean ? 'more_lean' : 'consistent',
      delta,
      ratio
    };
  }

  function buildRepInterpretation(rep, averages, depthReference, torsoReference, repCount) {
    const depth = rep?.depth?.depthValue;
    const duration = rep?.tempo?.totalMs;
    const torsoRange = rep?.torso?.rangeDegrees;
    const torsoPeak = rep?.torso?.maxLeanDegrees;
    const asymmetry = rep?.symmetry?.kneeAngleDifference;
    const confidence = rep?.dataQuality?.confidence;
    const kneeTracking = rep?.kneeTracking;
    const symmetry = rep?.symmetry;
    const dataQuality = rep?.dataQuality;

    const depthRelative = classifyRelativeDepth(
      depth,
      depthReference
    );

    const durationDelta =
      Number.isFinite(duration) &&
      Number.isFinite(averages.durationMs)
        ? duration - averages.durationMs
        : null;

    const torsoRelative = classifyRelativeTorso(
      torsoPeak,
      torsoReference,
      repCount
    );

    const notes = [];

    if (dataQuality?.status === 'low') {
      notes.push('Качество отслеживания низкое — выводы по этому повтору ограничены.');
    }

    if (
      kneeTracking?.available &&
      kneeTracking.status !== 'stable'
    ) {
      notes.push(kneeTracking.label + '.');
    }

    if (depthRelative.status === 'shallower') {
      notes.push('Заметно мельче остальных повторов.');
    } else if (depthRelative.status === 'deeper') {
      notes.push('Заметно глубже основного уровня подхода.');
    } else if (depthRelative.status === 'consistent') {
      notes.push('Глубина близка к основному уровню подхода.');
    }

    if (
      Number.isFinite(durationDelta) &&
      Number.isFinite(averages.durationMs)
    ) {
      const tempoTolerance =
        Math.max(
          160,
          averages.durationMs * 0.10
        );

      if (durationDelta > tempoTolerance) {
        notes.push('Повтор медленнее среднего темпа.');
      } else if (durationDelta < -tempoTolerance) {
        notes.push('Повтор быстрее среднего темпа.');
      } else {
        notes.push('Темп близок к среднему по подходу.');
      }
    }

    if (torsoRelative.status === 'more_lean') {
      notes.push('Корпус заметно сильнее наклонился вперёд, чем в остальных повторах.');
    } else if (torsoRelative.status === 'consistent') {
      notes.push('Наклон корпуса близок к основному уровню подхода.');
    }

    if (symmetry?.status === 'asymmetric') {
      notes.push('Есть заметная разница между движением левой и правой стороны.');
    } else if (symmetry?.status === 'stable') {
      notes.push('Левая и правая стороны двигаются похоже.');
    }

    if (
      dataQuality?.status === 'medium' &&
      notes.length < 4
    ) {
      notes.push('Качество отслеживания среднее — отдельные цифры стоит трактовать осторожно.');
    }

    if (!notes.length) {
      notes.push('По доступным метрикам повтор близок к среднему для этого подхода.');
    }

    return {
      summary: notes.slice(0, 2).join(' '),
      notes,
      tracking: trackingLabel(confidence),
      relative: {
        depth: relativeLabel(
          depth,
          depthReference,
          0.08
        ),
        tempo: relativeLabel(
          duration,
          averages.durationMs,
          Number.isFinite(averages.durationMs)
            ? Math.max(160, averages.durationMs * 0.10)
            : 160
        ),
        torsoRange: relativeLabel(
          torsoRange,
          averages.torsoRangeDegrees,
          2.5
        ),
        torsoPeak: relativeLabel(
          torsoPeak,
          torsoReference,
          6
        ),
        kneeDifference: relativeLabel(
          asymmetry,
          averages.kneeAngleDifference,
          6
        )
      }
    };
  }

  function buildSetInsights(repetitions, averages, depthReference, torsoReference) {
    const depthValues = metricValues(
      repetitions,
      item => item.depth?.depthValue
    );

    const durationValues = metricValues(
      repetitions,
      item => item.tempo?.totalMs
    );

    const torsoValues = metricValues(
      repetitions,
      item => item.torso?.maxLeanDegrees
    );

    const asymmetryValues = metricValues(
      repetitions,
      item => item.symmetry?.kneeAngleDifference
    );

    const kneeIssueReps = repetitions.filter(
      item =>
        item.kneeTracking?.available &&
        item.kneeTracking.status !== 'stable'
    );

    const asymmetryIssueReps = repetitions.filter(
      item =>
        item.symmetry?.available &&
        item.symmetry.status === 'asymmetric'
    );

    const symmetryEvaluatedReps = repetitions.filter(
      item => item.symmetry?.available
    );

    const lowQualityReps = repetitions.filter(
      item => item.dataQuality?.status === 'low'
    );

    const mediumQualityReps = repetitions.filter(
      item => item.dataQuality?.status === 'medium'
    );

    const shallowDepthReps = repetitions.filter(
      item =>
        classifyRelativeDepth(
          item?.depth?.depthValue,
          depthReference
        ).status === 'shallower'
    );

    const excessiveTorsoReps = repetitions.filter(
      item =>
        classifyRelativeTorso(
          item?.torso?.maxLeanDegrees,
          torsoReference,
          repetitions.length
        ).status === 'more_lean'
    );

    const depthSpread =
      depthValues.length >= 2
        ? maxValue(depthValues) -
          minValue(depthValues)
        : null;

    const durationSpread =
      durationValues.length >= 2
        ? maxValue(durationValues) -
          minValue(durationValues)
        : null;

    const torsoSpread =
      torsoValues.length >= 2
        ? maxValue(torsoValues) -
          minValue(torsoValues)
        : null;

    const first = repetitions[0] || null;
    const last = repetitions[repetitions.length - 1] || null;

    const firstDepth = first?.depth?.depthValue;
    const lastDepth = last?.depth?.depthValue;
    const firstDuration = first?.tempo?.totalMs;
    const lastDuration = last?.tempo?.totalMs;
    const firstTorso = first?.torso?.maxLeanDegrees;
    const lastTorso = last?.torso?.maxLeanDegrees;

    const depthEndDelta =
      Number.isFinite(firstDepth) &&
      Number.isFinite(lastDepth)
        ? lastDepth - firstDepth
        : null;

    const durationEndDelta =
      Number.isFinite(firstDuration) &&
      Number.isFinite(lastDuration)
        ? lastDuration - firstDuration
        : null;

    const torsoEndDelta =
      Number.isFinite(firstTorso) &&
      Number.isFinite(lastTorso)
        ? lastTorso - firstTorso
        : null;

    let depthText =
      'Недостаточно данных, чтобы сравнить глубину между повторениями.';

    if (shallowDepthReps.length) {
      const indexes =
        shallowDepthReps
          .map(item => item.repIndex)
          .join(', ');

      depthText =
        `Заметно мельче основного уровня подхода: ${shallowDepthReps.length === 1 ? 'повтор' : 'повторы'} ${indexes}.`;
    } else if (Number.isFinite(depthSpread)) {
      if (depthSpread <= 0.08) {
        depthText =
          'Глубина по подходу была очень ровной: повторы почти не отличались по RTMW-метрике.';
      } else if (depthSpread <= 0.16) {
        depthText =
          'Глубина немного менялась между повторениями, но явного недоседа относительно остальных не видно.';
      } else {
        depthText =
          'Глубина заметно менялась между повторениями, но ни один повтор не прошёл строгий критерий явного относительного недоседа.';
      }
    }

    let tempoText =
      'Недостаточно данных, чтобы сравнить темп.';

    if (
      durationValues.length >= 2 &&
      Number.isFinite(averages.durationMs) &&
      averages.durationMs > 0
    ) {
      const ratio =
        durationSpread /
        averages.durationMs;

      if (ratio <= 0.15) {
        tempoText =
          'Темп был достаточно ровным от повторения к повторению.';
      } else if (ratio <= 0.30) {
        tempoText =
          'Темп немного менялся по ходу подхода.';
      } else {
        tempoText =
          'Темп заметно отличался между повторениями.';
      }
    }

    let torsoText =
      'Недостаточно данных, чтобы сравнить наклон корпуса.';

    if (excessiveTorsoReps.length) {
      const indexes =
        excessiveTorsoReps
          .map(item => item.repIndex)
          .join(', ');

      torsoText =
        `Корпус заметно сильнее наклонился вперёд относительно остальных: ${excessiveTorsoReps.length === 1 ? 'повтор' : 'повторы'} ${indexes}.`;
    } else if (Number.isFinite(torsoSpread)) {
      torsoText =
        torsoSpread <= 6
          ? 'Максимальный наклон корпуса был похож от повторения к повторению.'
          : 'Наклон корпуса немного менялся между повторениями, но явного относительного выброса не обнаружено.';
    }

    let symmetryText =
      'Асимметрия не оценена: нужен достаточно фронтальный ракурс.';

    if (symmetryEvaluatedReps.length) {
      if (asymmetryIssueReps.length) {
        const indexes =
          asymmetryIssueReps
            .map(item => item.repIndex)
            .join(', ');

        symmetryText =
          `Заметная разница между левой и правой стороной: ${asymmetryIssueReps.length === 1 ? 'повтор' : 'повторы'} ${indexes}.`;
      } else {
        symmetryText =
          'На оценённых повторах выраженной разницы между левой и правой стороной не обнаружено.';
      }
    }

    const progression = [];

    if (Number.isFinite(depthEndDelta)) {
      if (depthEndDelta < -0.06) {
        progression.push(
          'К концу подхода глубина стала меньше.'
        );
      } else if (depthEndDelta > 0.06) {
        progression.push(
          'К концу подхода глубина стала больше.'
        );
      }
    }

    if (
      Number.isFinite(durationEndDelta) &&
      Number.isFinite(firstDuration) &&
      firstDuration > 0
    ) {
      if (durationEndDelta > firstDuration * 0.20) {
        progression.push(
          'Последний повтор заметно медленнее первого.'
        );
      } else if (durationEndDelta < -firstDuration * 0.20) {
        progression.push(
          'Последний повтор заметно быстрее первого.'
        );
      }
    }

    if (Number.isFinite(torsoEndDelta)) {
      if (torsoEndDelta > 10) {
        progression.push(
          'К концу подхода максимальный наклон корпуса заметно увеличился.'
        );
      } else if (torsoEndDelta < -10) {
        progression.push(
          'К концу подхода максимальный наклон корпуса заметно уменьшился.'
        );
      }
    }

    let mainFocus =
      'Подход выглядит достаточно ровным по текущим измерениям. Сохраняй одинаковую глубину и темп от первого до последнего повтора.';

    const tooManyLowQuality =
      repetitions.length > 0 &&
      lowQualityReps.length >=
        Math.ceil(repetitions.length / 2);

    if (
      tooManyLowQuality ||
      (
        Number.isFinite(averages.confidence) &&
        averages.confidence < 0.65
      )
    ) {
      mainFocus =
        'Качество отслеживания недостаточно стабильное — часть технических выводов ограничена.';
    } else if (shallowDepthReps.length) {
      const indexes =
        shallowDepthReps
          .map(item => item.repIndex)
          .join(', ');

      mainFocus =
        `Главное наблюдение: заметно мельче остальных ${shallowDepthReps.length === 1 ? 'получился повтор' : 'получились повторы'} ${indexes}.`;
    } else if (excessiveTorsoReps.length) {
      const indexes =
        excessiveTorsoReps
          .map(item => item.repIndex)
          .join(', ');

      mainFocus =
        `Главное наблюдение: корпус заметно сильнее наклонился вперёд относительно остальных ${excessiveTorsoReps.length === 1 ? 'в повторе' : 'в повторах'} ${indexes}.`;
    } else if (kneeIssueReps.length) {
      const indexes =
        kneeIssueReps
          .map(item => item.repIndex)
          .join(', ');

      mainFocus =
        `Колени уходят внутрь: повторы ${indexes}.`;
    } else if (asymmetryIssueReps.length) {
      const indexes =
        asymmetryIssueReps
          .map(item => item.repIndex)
          .join(', ');

      mainFocus =
        `Главное наблюдение: заметная разница между левой и правой стороной в повторах ${indexes}.`;
    } else if (
      Number.isFinite(depthEndDelta) &&
      depthEndDelta < -0.10
    ) {
      mainFocus =
        'Главное наблюдение: к концу подхода глубина уменьшилась. На следующем подходе попробуй сохранить глубину первых повторов.';
    } else if (
      Number.isFinite(torsoEndDelta) &&
      torsoEndDelta > 10
    ) {
      mainFocus =
        'Главное наблюдение: к концу подхода максимальный наклон корпуса заметно увеличился. Сравни последний повтор с первыми.';
    } else if (
      Number.isFinite(durationEndDelta) &&
      Number.isFinite(firstDuration) &&
      firstDuration > 0 &&
      durationEndDelta > firstDuration * 0.20
    ) {
      mainFocus =
        'Главное наблюдение: к концу подхода темп заметно замедлился. Это может быть признаком того, что последние повторы даются тяжелее.';
    } else if (
      Number.isFinite(depthSpread) &&
      depthSpread > 0.12
    ) {
      mainFocus =
        'Повторы заметно отличаются по глубине. Попробуй сделать следующий подход более одинаковым от повторения к повторению.';
    }

    return {
      tracking:
        trackingLabel(
          averages.confidence
        ),
      depth: depthText,
      tempo: tempoText,
      torso: torsoText,
      symmetry: symmetryText,
      progression:
        progression.length
          ? progression.join(' ')
          : 'От первого к последнему повтору нет заметного изменения по текущим метрикам.',
      mainFocus,
      kneeTracking: {
        issueCount:
          kneeIssueReps.length,
        issueRepIndexes:
          kneeIssueReps.map(
            item => item.repIndex
          )
      },
      symmetryTracking: {
        evaluatedCount:
          symmetryEvaluatedReps.length,
        issueCount:
          asymmetryIssueReps.length,
        issueRepIndexes:
          asymmetryIssueReps.map(
            item => item.repIndex
          )
      },
      quality: {
        averageConfidence:
          finiteOrNull(
            averages.confidence
          ),
        lowQualityRepIndexes:
          lowQualityReps.map(
            item => item.repIndex
          ),
        mediumQualityRepIndexes:
          mediumQualityReps.map(
            item => item.repIndex
          )
      },
      depthRelative: {
        referenceValue:
          finiteOrNull(depthReference),
        shallowRepIndexes:
          shallowDepthReps.map(
            item => item.repIndex
          )
      },
      torsoRelative: {
        referenceDegrees:
          finiteOrNull(torsoReference),
        excessiveLeanRepIndexes:
          excessiveTorsoReps.map(
            item => item.repIndex
          )
      },
      diagnostics: {
        depthSpread:
          finiteOrNull(depthSpread),
        durationSpread:
          finiteOrNull(durationSpread),
        torsoSpread:
          finiteOrNull(torsoSpread),
        asymmetryPeak:
          finiteOrNull(
            maxValue(asymmetryValues)
          ),
        depthEndDelta:
          finiteOrNull(depthEndDelta),
        durationEndDelta:
          finiteOrNull(durationEndDelta),
        torsoEndDelta:
          finiteOrNull(torsoEndDelta)
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

    const avgTorsoPeak = average(
      rawRepetitions.map(item => item.torso?.maxLeanDegrees)
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

    const symmetryIssueCount = rawRepetitions.filter(
      item => item.symmetry?.available && item.symmetry.status === 'asymmetric'
    ).length;

    const symmetryEvaluatedCount = rawRepetitions.filter(
      item => item.symmetry?.available
    ).length;

    const lowQualityCount = rawRepetitions.filter(
      item => item.dataQuality?.status === 'low'
    ).length;

    const mediumQualityCount = rawRepetitions.filter(
      item => item.dataQuality?.status === 'medium'
    ).length;

    const minConfidence = minValue(
      metricValues(
        rawRepetitions,
        item => item.dataQuality?.confidence
      )
    );

    const depthReference = depthReferenceValue(
      rawRepetitions
    );

    const torsoReference = torsoReferenceValue(
      rawRepetitions
    );

    const averages = {
      depthValue: finiteOrNull(avgDepth),
      depthReferenceValue: finiteOrNull(depthReference),
      durationMs: finiteOrNull(avgDurationMs),
      kneeAngleDifference: finiteOrNull(avgAsymmetry),
      torsoRangeDegrees: finiteOrNull(avgTorsoRange),
      torsoPeakDegrees: finiteOrNull(avgTorsoPeak),
      torsoReferenceDegrees: finiteOrNull(torsoReference),
      confidence: clamp01(avgConfidence),
      minConfidence: clamp01(minConfidence),
      kneeIssueCount,
      kneeEvaluatedCount,
      symmetryIssueCount,
      symmetryEvaluatedCount,
      lowQualityCount,
      mediumQualityCount
    };

    const repetitions = rawRepetitions.map(rep => ({
      ...rep,
      interpretation: buildRepInterpretation(rep, averages, depthReference, torsoReference, rawRepetitions.length)
    }));

    const insights = buildSetInsights(repetitions, averages, depthReference, torsoReference);

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
