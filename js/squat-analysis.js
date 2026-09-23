/* ============================================================
   FORMA — SQUAT ANALYSIS
   V0.2

   First live-analysis metric:
   squat depth measurement and a cautious depth signal for scoring.
   ============================================================ */

const SquatAnalysisService = (function () {

  const DEPTH_CALIBRATION = {
    // These are provisional image-space values, verified only as a trend
    // on early real tests: deep >= ~0.10, parallel ~= 0, shallow < 0.
    // Future camera-angle and anthropometry calibration can replace them
    // without touching capture, UI or the result contract.
    target: 0.10,
    clearlyShallow: -0.18
  };

  function validPoint(point) {
    return (
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1])
    );
  }


  /*
    Calculates vertical hip position relative to knee.

    MediaPipe Y:
      0 = top of image
      1 = bottom of image

    Therefore:

      positive value:
      hip is LOWER than knee on screen

      near zero:
      hip and knee are roughly level

      negative value:
      hip is ABOVE knee

    We normalize the difference by torso/leg scale so the result
    is more useful across different distances from the camera.
  */
  function visibilityFor(visibility, key, legacyKey) {
    const value = visibility?.[key] ?? visibility?.[legacyKey];
    return Number.isFinite(value) ? value : null;
  }

  function sideDepth(hip, knee, ankle, visibility, side) {

    const prefix = side === 'left' ? 'l' : 'r';
    const legacyPrefix = side === 'left' ? 'LEFT' : 'RIGHT';
    const requiredVisibility = [
      visibilityFor(visibility, `${prefix}hip`, `${legacyPrefix}_HIP`),
      visibilityFor(visibility, `${prefix}knee`, `${legacyPrefix}_KNEE`),
      visibilityFor(visibility, `${prefix}ankle`, `${legacyPrefix}_ANKLE`)
    ].filter(Number.isFinite);

    // A stabilizer may briefly hold a last known ankle position. Do not turn
    // that held point into a confident depth score once the backend says the
    // ankle is no longer visible.
    if (requiredVisibility.length && Math.min(...requiredVisibility) < 0.35) {
      return null;
    }

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

    const verticalDifference =
      hip[1] - knee[1];

    return verticalDifference / lowerLegLength;
  }


  function averageAvailable(a, b) {

    const values = [];

    if (Number.isFinite(a)) values.push(a);
    if (Number.isFinite(b)) values.push(b);

    if (values.length === 0) {
      return null;
    }

    return (
      values.reduce((sum, value) => sum + value, 0) /
      values.length
    );
  }


  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }


  function depthAssessment(depth) {

    if (!depth.available) {
      return {
        available: false,
        level: 'unavailable',
        label: 'Не определена',
        severity: null,
        confidence: 0
      };
    }

    const value = depth.depthValue;
    const severity = clamp(
      (DEPTH_CALIBRATION.target - value) /
      (DEPTH_CALIBRATION.target - DEPTH_CALIBRATION.clearlyShallow),
      0,
      1
    );

    return {
      available: true,
      level:
        value >= DEPTH_CALIBRATION.target
          ? 'deep'
          : value >= 0
            ? 'parallel'
            : 'shallow',
      label:
        value >= DEPTH_CALIBRATION.target
          ? 'Ниже параллели'
          : value >= 0
            ? 'Примерно параллель'
            : 'Выше параллели',
      severity,
      confidence:
        Number.isFinite(depth.leftDepth) &&
        Number.isFinite(depth.rightDepth)
          ? 1
          : 0.65
    };
  }


  function kneeSymmetry(rep) {

    const left = rep?.leftMinKneeAngle;
    const right = rep?.rightMinKneeAngle;

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return {
        available: false,
        differenceDegrees: null
      };
    }

    return {
      available: true,
      differenceDegrees: Math.abs(left - right)
    };
  }


  function analyzeDepth(rep) {

    if (
      !rep ||
      !rep.bottomFrame ||
      !rep.bottomFrame.pose
    ) {
      return {
        available: false,

        depthValue: null,
        leftDepth: null,
        rightDepth: null,

        kneeAngle: null
      };
    }


    const frame = rep.bottomFrame;
    const pose = frame.pose;


    const leftDepth = sideDepth(
      pose.lhip,
      pose.lknee,
      pose.lankle,
      frame.visibility,
      'left'
    );


    const rightDepth = sideDepth(
      pose.rhip,
      pose.rknee,
      pose.rankle,
      frame.visibility,
      'right'
    );


    const depthValue =
      averageAvailable(
        leftDepth,
        rightDepth
      );


    return {
      available:
        Number.isFinite(depthValue),

      depthValue:
        Number.isFinite(depthValue)
          ? depthValue
          : null,

      leftDepth:
        Number.isFinite(leftDepth)
          ? leftDepth
          : null,

      rightDepth:
        Number.isFinite(rightDepth)
          ? rightDepth
          : null,

      kneeAngle:
        Number.isFinite(frame.kneeAngle)
          ? frame.kneeAngle
          : null
    };
  }


  function analyze(rep) {

    const depth = analyzeDepth(rep);
    const depthResult = depthAssessment(depth);

    return {
      repIndex:
        rep && Number.isFinite(rep.index)
          ? rep.index
          : null,

      depth,

      depthResult,

      symmetry: kneeSymmetry(rep),

      durationMs:
        Number.isFinite(rep?.durationMs)
          ? rep.durationMs
          : null,

      // Metric names match ExerciseLibrary. A null metric means
      // "unavailable", not "good".
      metrics: {
        depthMissed: depthResult.severity
      }
    };
  }


  return {
    analyze
  };

})();
