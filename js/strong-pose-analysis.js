/* =====================================================================
   FORMA — RTMW SIMPLE TRACKING (2026-10-14)
   No technique scores / no knee, depth, torso or view-angle gates.
   RTMW supplies per-frame skeletons. Live MediaPipe supplies rep windows.
   This is NOT an independent RTMW repetition detector.
   ===================================================================== */
const StrongPoseAnalysis = (function () {
  function getFrames(response) {
    const pose = response?.strong_pose;
    if (!response?.ok || pose?.format !== 'forma-pose/v1' ||
        !Array.isArray(pose.frames)) return [];
    return pose.frames
      .filter(frame => frame && Number.isFinite(frame.timestampMs))
      .slice()
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  function hasSkeleton(frame) {
    const joints = frame?.joints;
    return Boolean(joints && Object.values(joints).some(point =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ));
  }

  function canAnalyze(response) {
    return getFrames(response).length > 0;
  }

  function analyzeSquat(response, {
    localReps = [],
    mediaStartPerf = null,
    localVideoRanges = {}
  } = {}) {
    const frames = getFrames(response);
    const reps = Array.isArray(localReps) ? localReps : [];
    const repetitions = reps.map((rep, position) => {
      // Boundaries were recorded by existing live MediaPipe counter.
      // No spatial, confidence, view-angle or posture thresholds are used.
      const validWindow = Number.isFinite(mediaStartPerf) &&
        Number.isFinite(rep?.startTime) && Number.isFinite(rep?.endTime);
      const startMs = validWindow ? Math.max(0, rep.startTime - mediaStartPerf) : null;
      const endMs = validWindow ? Math.max(0, rep.endTime - mediaStartPerf) : null;
      const inWindow = validWindow ? frames.filter(frame =>
        frame.timestampMs >= startMs - 180 &&
        frame.timestampMs <= endMs + 180
      ) : [];
      const poseFrames = inWindow.filter(hasSkeleton);

      return {
        repIndex: Number.isFinite(rep?.index) ? rep.index : position + 1,
        durationMs: Number.isFinite(rep?.durationMs) ? rep.durationMs :
          (validWindow ? Math.max(0, rep.endTime - rep.startTime) : null),
        serverFrames: inWindow.length,
        skeletonFrames: poseFrames.length,
        firstSkeletonMs: poseFrames.length ? poseFrames[0].timestampMs : null,
        lastSkeletonMs: poseFrames.length ? poseFrames[poseFrames.length - 1].timestampMs : null,
        // A frame reference is sufficient for post-run manual inspection.
        // No quality/technique judgment is made.
        exampleFrame: poseFrames.length ? poseFrames[Math.floor(poseFrames.length / 2)] : null
      };
    });

    const squatSet = {
      analysisSource: frames.length ? 'rtmw' : 'mediapipe',
      analysisSourceLabel: frames.length ? 'RTMW tracking only' : 'MediaPipe counter only',
      repCount: repetitions.length,
      repetitions,
      observedRepCount: repetitions.filter(rep => rep.skeletonFrames > 0).length,
      sourceMeta: {
        provider: response?.strong_pose?.provider || null,
        model: response?.strong_pose?.model || null,
        sampleFps: response?.strong_pose?.sample_fps ?? null,
        serverFrameCount: frames.length,
        totalSkeletonFrames: frames.filter(hasSkeleton).length,
        repSegmentation: 'mediapipe-live-boundaries',
        techniqueAnalysis: 'disabled'
      }
    };

    return {
      ok: frames.length > 0,
      reason: frames.length ? null : 'no-rtmw-frames',
      squatSet,
      reps: repetitions,
      repVideoRanges: localVideoRanges || {}
    };
  }

  return { canAnalyze, analyzeSquat };
})();
