/* =====================================================================
   STRONG POSE ANALYSIS — v0.2
   ---------------------------------------------------------------------
   IMPORTANT ARCHITECTURE CHANGE

   MediaPipe already detects repetition boundaries well in real time.
   RTMW should not have to re-prove that a rep happened before its stronger
   pose data can be used.

   V0.2 therefore:
   1) uses the LOCAL MediaPipe reps only as time windows / segmentation;
   2) selects RTMW frames that fall inside each rep;
   3) builds the repetition timeline entirely from RTMW coordinates;
   4) runs the existing SquatAnalysisService on those RTMW repetitions.

   Result:
   - repetition count / boundaries remain robust;
   - depth / knees / torso / symmetry are measured from RTMW;
   - MediaPipe remains the fallback if server data is unavailable.
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

  function midpoint(a, b) {
    if (!validPoint(a) || !validPoint(b)) return null;
    return [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2
    ];
  }

  function distance(a, b) {
    if (!validPoint(a) || !validPoint(b)) return null;
    return Math.hypot(
      a[0] - b[0],
      a[1] - b[1]
    );
  }

  function angleAt(a, b, c) {
    if (!validPoint(a) || !validPoint(b) || !validPoint(c)) {
      return null;
    }

    const bax = a[0] - b[0];
    const bay = a[1] - b[1];
    const bcx = c[0] - b[0];
    const bcy = c[1] - b[1];

    const lenBA = Math.hypot(bax, bay);
    const lenBC = Math.hypot(bcx, bcy);

    if (
      !Number.isFinite(lenBA) ||
      !Number.isFinite(lenBC) ||
      lenBA < 0.000001 ||
      lenBC < 0.000001
    ) {
      return null;
    }

    const cosine =
      Math.max(
        -1,
        Math.min(
          1,
          (bax * bcx + bay * bcy) /
          (lenBA * lenBC)
        )
      );

    return Math.acos(cosine) * 180 / Math.PI;
  }

  function averageAvailable(...values) {
    const usable = values.filter(Number.isFinite);
    if (!usable.length) return null;
    return usable.reduce((sum, value) => sum + value, 0) / usable.length;
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

    // RTMW V0.24 raw score is not calibrated to MediaPipe visibility 0..1.
    // For now, a valid coordinate means the landmark is usable. We preserve
    // the original RTMW score inside formaPose for later calibration.
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

  function clonePose(pose) {
    const out = {};

    Object.entries(pose || {}).forEach(([name, point]) => {
      out[name] = validPoint(point)
        ? [point[0], point[1]]
        : null;
    });

    return out;
  }

  function cloneVisibility(visibility) {
    const out = {};

    Object.entries(visibility || {}).forEach(([name, value]) => {
      out[name] = Number.isFinite(value)
        ? value
        : null;
    });

    return out;
  }

  function hipY(pose) {
    const hips = midpoint(
      pose?.lhip,
      pose?.rhip
    );

    return hips && Number.isFinite(hips[1])
      ? hips[1]
      : null;
  }

  function torsoScale(pose) {
    const hips = midpoint(
      pose?.lhip,
      pose?.rhip
    );

    const shoulders = midpoint(
      pose?.lshoulder,
      pose?.rshoulder
    );

    return distance(
      hips,
      shoulders
    );
  }

  function snapshotFromFrame(frame) {
    const legacy =
      legacyForServerFrame(frame);

    const pose =
      legacy.keypoints;

    const leftKneeAngle =
      angleAt(
        pose.lhip,
        pose.lknee,
        pose.lankle
      );

    const rightKneeAngle =
      angleAt(
        pose.rhip,
        pose.rknee,
        pose.rankle
      );

    return {
      t: frame.timestampMs,
      state: null,
      kneeAngle:
        averageAvailable(
          leftKneeAngle,
          rightKneeAngle
        ),
      leftKneeAngle,
      rightKneeAngle,
      hipDropRatio: null,
      pose: clonePose(pose),
      visibility:
        cloneVisibility(
          legacy.visibility
        ),
      formaPose:
        typeof FormaPose !== 'undefined' &&
        typeof FormaPose.clone === 'function'
          ? FormaPose.clone(frame)
          : frame
    };
  }

  function exactVideoWindow(localRep, mediaStartPerf) {
    if (
      !Number.isFinite(localRep?.startTime) ||
      !Number.isFinite(localRep?.endTime) ||
      !Number.isFinite(mediaStartPerf)
    ) {
      return null;
    }

    return {
      startMs:
        Math.max(
          0,
          localRep.startTime - mediaStartPerf
        ),
      endMs:
        Math.max(
          0,
          localRep.endTime - mediaStartPerf
        )
    };
  }

  function selectFramesForRep(
    allFrames,
    localRep,
    mediaStartPerf
  ) {
    const window =
      exactVideoWindow(
        localRep,
        mediaStartPerf
      );

    if (!window) return [];

    // Small context margin catches the top of the movement even when the
    // live detector began capture a fraction late. The rep itself is still
    // identified by MediaPipe; all measurements below come from RTMW.
    const start =
      Math.max(
        0,
        window.startMs - 180
      );

    const end =
      window.endMs + 180;

    return allFrames.filter(
      frame =>
        frame.timestampMs >= start &&
        frame.timestampMs <= end
    );
  }

  function assignPhases(snapshots, bottomIndex) {
    if (!snapshots.length) return;

    snapshots.forEach((snapshot, index) => {
      if (index < bottomIndex) {
        snapshot.state = 'descending';
      } else if (index === bottomIndex) {
        snapshot.state = 'bottom';
      } else {
        snapshot.state = 'ascending';
      }
    });
  }

  function buildRtmwRep(
    localRep,
    serverFrames,
    mediaStartPerf
  ) {
    const selected =
      selectFramesForRep(
        serverFrames,
        localRep,
        mediaStartPerf
      );

    if (selected.length < 3) {
      return null;
    }

    const snapshots =
      selected
        .map(snapshotFromFrame)
        .filter(snapshot =>
          snapshot &&
          Number.isFinite(snapshot.t)
        );

    if (snapshots.length < 3) {
      return null;
    }

    // Choose the bottom from RTMW itself: maximum pelvis Y in top-left image
    // coordinates = lowest pelvis position in the frame.
    let bottomIndex = -1;
    let deepestHipY = -Infinity;

    snapshots.forEach((snapshot, index) => {
      const value =
        hipY(snapshot.pose);

      if (
        Number.isFinite(value) &&
        value > deepestHipY
      ) {
        deepestHipY = value;
        bottomIndex = index;
      }
    });

    // If hips were unavailable in every sampled frame, use minimum knee angle
    // as a secondary bottom locator.
    if (bottomIndex < 0) {
      let minimumAngle = Infinity;

      snapshots.forEach((snapshot, index) => {
        if (
          Number.isFinite(snapshot.kneeAngle) &&
          snapshot.kneeAngle < minimumAngle
        ) {
          minimumAngle =
            snapshot.kneeAngle;

          bottomIndex =
            index;
        }
      });
    }

    if (bottomIndex < 0) {
      return null;
    }

    assignPhases(
      snapshots,
      bottomIndex
    );

    // Relative pelvis descent is useful metadata for the existing report.
    const startHipY =
      hipY(snapshots[0].pose);

    const startTorsoScale =
      torsoScale(snapshots[0].pose);

    if (
      Number.isFinite(startHipY) &&
      Number.isFinite(startTorsoScale) &&
      startTorsoScale > 0.001
    ) {
      snapshots.forEach(snapshot => {
        const currentHipY =
          hipY(snapshot.pose);

        snapshot.hipDropRatio =
          Number.isFinite(currentHipY)
            ? (
                currentHipY -
                startHipY
              ) /
              startTorsoScale
            : null;
      });
    }

    const leftAngles =
      snapshots
        .map(frame => frame.leftKneeAngle)
        .filter(Number.isFinite);

    const rightAngles =
      snapshots
        .map(frame => frame.rightKneeAngle)
        .filter(Number.isFinite);

    const allAngles =
      snapshots
        .map(frame => frame.kneeAngle)
        .filter(Number.isFinite);

    const hipDrops =
      snapshots
        .map(frame => frame.hipDropRatio)
        .filter(Number.isFinite);

    const firstT =
      snapshots[0].t;

    const lastT =
      snapshots[snapshots.length - 1].t;

    return {
      index:
        Number.isFinite(localRep?.index)
          ? localRep.index
          : null,

      // Server/video-relative timestamps keep all RTMW rep data internally
      // consistent. The displayed duration may use the local detector's
      // already reliable duration when available.
      startTime: firstT,
      endTime: lastT,
      durationMs:
        Number.isFinite(localRep?.durationMs)
          ? localRep.durationMs
          : Math.max(0, lastT - firstT),

      frameCount:
        snapshots.length,

      minKneeAngle:
        allAngles.length
          ? Math.min(...allAngles)
          : null,

      maxKneeAngle:
        allAngles.length
          ? Math.max(...allAngles)
          : null,

      leftMinKneeAngle:
        leftAngles.length
          ? Math.min(...leftAngles)
          : null,

      leftMaxKneeAngle:
        leftAngles.length
          ? Math.max(...leftAngles)
          : null,

      rightMinKneeAngle:
        rightAngles.length
          ? Math.min(...rightAngles)
          : null,

      rightMaxKneeAngle:
        rightAngles.length
          ? Math.max(...rightAngles)
          : null,

      maxHipDropRatio:
        hipDrops.length
          ? Math.max(...hipDrops)
          : null,

      bottomFrame:
        snapshots[bottomIndex],

      frames:
        snapshots
    };
  }

  function analyzeSquat(
    response,
    {
      localReps = [],
      mediaStartPerf = null,
      localVideoRanges = {}
    } = {}
  ) {
    const frames =
      responseFrames(response);

    if (!frames.length) {
      return {
        ok: false,
        reason: 'no-strong-pose-frames',
        squatSet: null,
        reps: [],
        repVideoRanges: {}
      };
    }

    if (
      !Array.isArray(localReps) ||
      !localReps.length ||
      !Number.isFinite(mediaStartPerf)
    ) {
      return {
        ok: false,
        reason: 'no-local-rep-windows',
        squatSet: null,
        reps: [],
        repVideoRanges: {}
      };
    }

    const reps =
      localReps
        .map(rep =>
          buildRtmwRep(
            rep,
            frames,
            mediaStartPerf
          )
        )
        .filter(Boolean);

    if (!reps.length) {
      return {
        ok: false,
        reason: 'no-rtmw-frames-inside-local-reps',
        squatSet: null,
        reps: [],
        repVideoRanges: {}
      };
    }

    // Require the strong report to cover every locally completed repetition.
    // Partial strong data is safer as a fallback than as a misleading hybrid.
    if (reps.length !== localReps.length) {
      return {
        ok: false,
        reason: 'partial-rtmw-rep-coverage',
        squatSet: null,
        reps,
        repVideoRanges: {}
      };
    }

    const squatSet =
      SquatAnalysisService.analyzeSet(
        reps
      );

    squatSet.analysisSource =
      'rtmw';

    squatSet.analysisSourceLabel =
      'RTMW';

    squatSet.sourceMeta = {
      provider:
        response?.strong_pose?.provider ||
        'rtmw',
      model:
        response?.strong_pose?.model ||
        null,
      format:
        response?.strong_pose?.format ||
        null,
      sampledFrames:
        response?.strong_pose?.sampled_frames ||
        frames.length,
      sampleFps:
        response?.strong_pose?.sample_fps ||
        null,
      repSegmentation:
        'mediapipe-live-boundaries',
      techniquePose:
        'rtmw',
      confidenceMode:
        'presence-only-provisional'
    };

    return {
      ok: true,
      reason: null,
      squatSet,
      reps,

      // Keep the already-working video playback windows from the local
      // recording path. They describe the same physical repetitions.
      repVideoRanges:
        localVideoRanges || {}
    };
  }

  return {
    canAnalyze,
    analyzeSquat
  };

})();
