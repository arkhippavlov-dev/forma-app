/* =====================================================================
   FORMA — RTMW DEPTH ONLY (2026-10-14)
   One descriptive technique rule: relative squat depth within the set.
   No scores / knee, torso, quality or view-angle gates.
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

  // Use the same pelvis-drop metric as the early RTMW V0.4 experiment.
  // Image origin is top-left; greater hip y means the pelvis is lower.
  // This compares reps WITHIN a set, not absolute squat depth in 3D.
  function median(values) {
    const arr = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!arr.length) return null;
    const m = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
  }

  function midpoint(frame, left, right) {
    const a = frame?.joints?.[left], b = frame?.joints?.[right];
    if (![a?.x, a?.y, b?.x, b?.y].every(Number.isFinite)) return null;
    return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
  }

  function hipY(frame) {
    return midpoint(frame, 'leftHip', 'rightHip')?.y ?? null;
  }

  function torsoLength(frame) {
    const hip = midpoint(frame, 'leftHip', 'rightHip');
    const shoulder = midpoint(frame, 'leftShoulder', 'rightShoulder');
    return hip && shoulder ? Math.hypot(hip.x - shoulder.x, hip.y - shoulder.y) : null;
  }

  function relativePelvisDrop(poseFrames) {
    if (!poseFrames.length) return null;
    const hipSeries = poseFrames.map(hipY);
    // 3-frame median suppresses a single errant joint without discarding reps.
    const smooth = hipSeries.map((value, i) => {
      if (!Number.isFinite(value)) return null;
      return median(hipSeries.slice(Math.max(0, i - 1), i + 2));
    });
    const count = Math.max(2, Math.ceil(poseFrames.length * 0.30));
    const topIndices = [...Array(poseFrames.length).keys()]
      .filter(i => i < count || i >= poseFrames.length - count);
    const topHip = topIndices.map(i => smooth[i]).filter(Number.isFinite)
      .sort((a, b) => a - b);
    const topScale = topIndices.map(i => torsoLength(poseFrames[i]))
      .filter(v => Number.isFinite(v) && v > 0.001);
    const highPelvis = median(topHip.slice(0,
      Math.min(4, Math.max(1, Math.ceil(topHip.length * 0.35)))));
    const scale = median(topScale);
    if (!Number.isFinite(highPelvis) || !Number.isFinite(scale) || scale <= 0.001) {
      return null;
    }
    const drops = smooth.filter(Number.isFinite)
      .map(y => Math.max(0, (y - highPelvis) / scale))
      .sort((a, b) => b - a);
    if (!drops.length) return null;
    // A robust maximum (2–3 deepest samples), not a single noisy frame.
    const topN = drops.length >= 6 ? Math.min(3, Math.ceil(drops.length * 0.20))
      : (drops.length >= 3 ? 2 : 1);
    return median(drops.slice(0, topN));
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
        // The rule is independent of the live MediaPipe rep counter.
        depthValue: relativePelvisDrop(poseFrames),
        depthStatus: 'not_compared',
        depthRelativeRatio: null,
        firstSkeletonMs: poseFrames.length ? poseFrames[0].timestampMs : null,
        lastSkeletonMs: poseFrames.length ? poseFrames[poseFrames.length - 1].timestampMs : null,
        // A frame reference is sufficient for post-run manual inspection.
        // No quality/technique judgment is made.
        exampleFrame: poseFrames.length ? poseFrames[Math.floor(poseFrames.length / 2)] : null
      };
    });

    const usableDepths = repetitions.map(rep => rep.depthValue)
      .filter(Number.isFinite);
    const depthReference = usableDepths.length >= 3 ? median(usableDepths) : null;
    repetitions.forEach(rep => {
      if (!Number.isFinite(rep.depthValue) || !Number.isFinite(depthReference)
          || depthReference <= 0.001) return;
      rep.depthRelativeRatio = rep.depthValue / depthReference;
      // Exactly one previously calibrated comparison (V0.4 / V0.7 dataset).
      // It labels a noticeably shallower rep; it NEVER suppresses RTMW data.
      rep.depthStatus = rep.depthRelativeRatio <= 0.82 &&
        rep.depthValue - depthReference <= -0.12 ? 'shallower' : 'comparable';
    });

    const squatSet = {
      analysisSource: frames.length ? 'rtmw' : 'mediapipe',
      analysisSourceLabel: frames.length ? 'RTMW tracking only' : 'MediaPipe counter only',
      repCount: repetitions.length,
      repetitions,
      observedRepCount: repetitions.filter(rep => rep.skeletonFrames > 0).length,
      depthReference,
      depthComparedCount: repetitions.filter(rep => rep.depthStatus !== 'not_compared').length,
      shallowerRepIndexes: repetitions.filter(rep => rep.depthStatus === 'shallower')
        .map(rep => rep.repIndex),
      sourceMeta: {
        provider: response?.strong_pose?.provider || null,
        model: response?.strong_pose?.model || null,
        sampleFps: response?.strong_pose?.sample_fps ?? null,
        serverFrameCount: frames.length,
        totalSkeletonFrames: frames.filter(hasSkeleton).length,
        repSegmentation: 'mediapipe-live-boundaries',
        techniqueAnalysis: 'depth-only-relative'
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
