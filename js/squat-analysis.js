/* ============================================================
   FORMA — SQUAT ANALYSIS
   V0.1

   First metric:
   squat depth measurement.

   IMPORTANT:
   This version MEASURES depth.
   It does not yet judge good/bad technique.
   ============================================================ */

const SquatAnalysisService = (function () {

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

    return {
      repIndex:
        rep && Number.isFinite(rep.index)
          ? rep.index
          : null,

      depth: analyzeDepth(rep)
    };
  }


  return {
    analyze
  };

})();
