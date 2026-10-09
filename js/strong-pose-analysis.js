/* =====================================================================
   STRONG POSE ANALYSIS — v0.1
   ---------------------------------------------------------------------
   Replays provider-neutral RTMW frames through FORMA's existing squat
   detector + RepCapture + SquatAnalysisService.

   This is the bridge that makes RTMW the PRIMARY post-set analysis source
   while MediaPipe remains the live-preview / fallback source.
   ===================================================================== */

const StrongPoseAnalysis = (function () {

  const VISIBILITY_BY_LEGACY = {
    head: 'NOSE',
    lshoulder: 'LEFT_SHOULDER',
    rshoulder: 'RIGHT_SHOULDER',
    lelbow: 'LEFT_ELBOW',
    relbow: 'RIGHT_ELBOW',
    lwrist: 'LEFT_WRIST',
    rwrist: 'RIGHT_WRIST',
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
    return Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]);
  }

  function responseFrames(response) {
    const pose = response?.strong_pose;

    if (
      !response?.ok ||
      pose?.format !== 'forma-pose/v1' ||
      !Array.isArray(pose?.frames)
    ) {
      return [];
    }

    return pose.frames
      .filter(frame =>
        frame &&
        frame.format === 'forma-pose/v1' &&
        Number.isFinite(frame.timestampMs)
      )
      .slice()
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  function canAnalyze(response) {
    return responseFrames(response).length > 0;
  }

  function legacyForServerFrame(frame) {
    const legacy = FormaPose.toLegacy(frame);

    // RTMW V0.24 exposes a provider-specific raw score whose numeric scale
    // is not yet calibrated to MediaPipe's 0..1 visibility. Do not pretend
    // that it is the same quantity. For the existing detector/analysis we
    // use presence (valid coordinate = usable) as a provisional visibility
    // gate. The raw score remains preserved inside frame.joints.
    const visibility = {};

    Object.entries(VISIBILITY_BY_LEGACY).forEach(([legacyName, visibilityKey]) => {
      visibility[visibilityKey] =
        validPoint(legacy.keypoints?.[legacyName])
          ? 1
          : 0;
    });

    return {
      keypoints: legacy.keypoints || {},
      visibility
    };
  }

  function buildRepVideoRanges(reps) {
    const ranges = {};

    (Array.isArray(reps) ? reps : []).forEach(rep => {
      if (
        !Number.isFinite(rep?.index) ||
        !Number.isFinite(rep?.startTime) ||
        !Number.isFinite(rep?.endTime)
      ) {
        return;
      }

      const startSec = Math.max(0, rep.startTime / 1000 - 0.35);
      const endSec = Math.max(
        startSec + 0.25,
        rep.endTime / 1000 + 0.35
      );

      ranges[rep.index] = {
        startSec,
        endSec
      };
    });

    return ranges;
  }

  function analyzeSquat(response) {
    const frames = responseFrames(response);

    if (!frames.length) {
      return {
        ok: false,
        reason: 'no-strong-pose-frames',
        squatSet: null,
        reps: [],
        repVideoRanges: {}
      };
    }

    SquatDetector.reset();
    RepCapture.reset();

    frames.forEach(frame => {
      const legacy = legacyForServerFrame(frame);

      const detectorResult = SquatDetector.update(
        legacy.keypoints,
        legacy.visibility
      );

      RepCapture.update(
        detectorResult,
        legacy.keypoints,
        legacy.visibility,
        frame.timestampMs,
        frame
      );
    });

    const reps = RepCapture.getCompletedReps();

    if (!reps.length) {
      return {
        ok: false,
        reason: 'no-strong-reps',
        squatSet: null,
        reps: [],
        repVideoRanges: {}
      };
    }

    const squatSet = SquatAnalysisService.analyzeSet(reps);

    squatSet.analysisSource = 'rtmw';
    squatSet.analysisSourceLabel = 'RTMW';
    squatSet.sourceMeta = {
      provider: response?.strong_pose?.provider || 'rtmw',
      model: response?.strong_pose?.model || null,
      format: response?.strong_pose?.format || null,
      sampledFrames: response?.strong_pose?.sampled_frames || frames.length,
      sampleFps: response?.strong_pose?.sample_fps || null,
      confidenceMode: 'presence-only-provisional'
    };

    return {
      ok: true,
      reason: null,
      squatSet,
      reps,
      repVideoRanges: buildRepVideoRanges(reps)
    };
  }

  return {
    canAnalyze,
    analyzeSquat
  };

})();
