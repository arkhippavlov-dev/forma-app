/* =====================================================================
   FORMA POSE FORMAT — v1
   ---------------------------------------------------------------------
   Provider-neutral pose frame used inside FORMA.

   Why this exists:
   - MediaPipe is only the current live-preview provider.
   - A stronger server-side model will later produce the same frame shape.
   - Exercise logic must not care which neural network produced the points.

   Coordinates are normalized [0..1] in the current displayed camera space.
   Every joint stores its own confidence score.
   ===================================================================== */

const FormaPose = (function () {

  const VERSION = 'forma-pose/v1';

  const JOINT_MAP = {
    head: 'head',
    neck: 'neck',
    lshoulder: 'leftShoulder',
    rshoulder: 'rightShoulder',
    lelbow: 'leftElbow',
    relbow: 'rightElbow',
    lwrist: 'leftWrist',
    rwrist: 'rightWrist',
    lhip: 'leftHip',
    rhip: 'rightHip',
    lknee: 'leftKnee',
    rknee: 'rightKnee',
    lankle: 'leftAnkle',
    rankle: 'rightAnkle',
    lheel: 'leftHeel',
    rheel: 'rightHeel',
    lfoot: 'leftFoot',
    rfoot: 'rightFoot'
  };

  const VISIBILITY_KEY = {
    head: 'NOSE',
    leftShoulder: 'LEFT_SHOULDER',
    rightShoulder: 'RIGHT_SHOULDER',
    leftElbow: 'LEFT_ELBOW',
    rightElbow: 'RIGHT_ELBOW',
    leftWrist: 'LEFT_WRIST',
    rightWrist: 'RIGHT_WRIST',
    leftHip: 'LEFT_HIP',
    rightHip: 'RIGHT_HIP',
    leftKnee: 'LEFT_KNEE',
    rightKnee: 'RIGHT_KNEE',
    leftAnkle: 'LEFT_ANKLE',
    rightAnkle: 'RIGHT_ANKLE',
    leftHeel: 'LEFT_HEEL',
    rightHeel: 'RIGHT_HEEL',
    leftFoot: 'LEFT_FOOT_INDEX',
    rightFoot: 'RIGHT_FOOT_INDEX'
  };

  const LEGACY_KEY = Object.fromEntries(
    Object.entries(JOINT_MAP).map(([legacy, canonical]) => [canonical, legacy])
  );

  function validPoint(point) {
    return Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]);
  }

  function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }

  function visibilityScore(visibility, canonicalName) {
    if (canonicalName === 'neck') {
      const left = visibility?.LEFT_SHOULDER;
      const right = visibility?.RIGHT_SHOULDER;
      const values = [left, right].filter(Number.isFinite);
      return values.length ? Math.min(...values) : null;
    }

    const key = VISIBILITY_KEY[canonicalName];
    if (!key) return null;
    return finiteOrNull(visibility?.[key]);
  }

  function fromMediaPipeFrame(frame, meta) {
    if (!frame || !frame.keypoints) return null;

    const joints = {};

    Object.entries(JOINT_MAP).forEach(([legacyName, canonicalName]) => {
      const point = frame.keypoints[legacyName];

      if (!validPoint(point)) {
        joints[canonicalName] = null;
        return;
      }

      joints[canonicalName] = {
        x: point[0],
        y: point[1],
        z: null,
        score: visibilityScore(frame.visibility, canonicalName)
      };
    });

    return {
      format: VERSION,
      source: {
        provider: 'mediapipe',
        model: 'pose_landmarker_full'
      },
      timestampMs: Number.isFinite(meta?.timestampMs)
        ? meta.timestampMs
        : null,
      image: {
        width: Number.isFinite(meta?.width) ? meta.width : null,
        height: Number.isFinite(meta?.height) ? meta.height : null,
        normalized: true,
        mirrored: meta?.mirrored !== false,
        origin: 'top-left'
      },
      joints
    };
  }

  function toLegacy(frame) {
    if (!frame || !frame.joints) {
      return { keypoints: {}, visibility: {} };
    }

    const keypoints = {};
    const visibility = {};

    Object.entries(frame.joints).forEach(([canonicalName, joint]) => {
      const legacyName = LEGACY_KEY[canonicalName];
      if (!legacyName) return;

      keypoints[legacyName] = joint && Number.isFinite(joint.x) && Number.isFinite(joint.y)
        ? [joint.x, joint.y]
        : null;

      const visibilityKey = VISIBILITY_KEY[canonicalName];
      if (visibilityKey) {
        visibility[visibilityKey] = Number.isFinite(joint?.score)
          ? joint.score
          : 0;
      }
    });

    // Neck is synthetic in the current MediaPipe adapter and therefore has
    // no dedicated visibility key. Existing code expects the keypoint only.
    if (!Object.prototype.hasOwnProperty.call(keypoints, 'neck')) {
      keypoints.neck = null;
    }

    return { keypoints, visibility };
  }

  function clone(frame) {
    if (!frame) return null;

    const joints = {};
    Object.entries(frame.joints || {}).forEach(([name, joint]) => {
      joints[name] = joint
        ? {
            x: finiteOrNull(joint.x),
            y: finiteOrNull(joint.y),
            z: finiteOrNull(joint.z),
            score: finiteOrNull(joint.score)
          }
        : null;
    });

    return {
      format: frame.format || VERSION,
      source: {
        provider: frame.source?.provider || null,
        model: frame.source?.model || null
      },
      timestampMs: finiteOrNull(frame.timestampMs),
      image: {
        width: finiteOrNull(frame.image?.width),
        height: finiteOrNull(frame.image?.height),
        normalized: frame.image?.normalized !== false,
        mirrored: frame.image?.mirrored === true,
        origin: frame.image?.origin || 'top-left'
      },
      joints
    };
  }

  return {
    VERSION,
    fromMediaPipeFrame,
    toLegacy,
    clone
  };

})();
