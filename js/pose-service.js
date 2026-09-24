/* ============================================================
   REAL POSE ESTIMATION — MediaPipe Pose Landmarker
   V0.1:
   camera → real pose → skeleton
   ============================================================ */

const PoseEstimationService = (function () {

  let poseLandmarker = null;
  let initialized = false;
  let initializing = null;
  let lastVideoTime = -1;
  let lastFrame = null;

  // MediaPipe landmark indexes
  const LANDMARKS = {
    NOSE: 0,

    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,

    LEFT_ELBOW: 13,
    RIGHT_ELBOW: 14,

    LEFT_WRIST: 15,
    RIGHT_WRIST: 16,

    LEFT_HIP: 23,
    RIGHT_HIP: 24,

    LEFT_KNEE: 25,
    RIGHT_KNEE: 26,

    LEFT_ANKLE: 27,
    RIGHT_ANKLE: 28
  };

  // Public FORMA contract. Everything after PoseEstimationService uses
  // these names, so a future pose backend only needs to produce this shape.
  const FORMA_POINTS = {
    head: 'NOSE',
    lshoulder: 'LEFT_SHOULDER', rshoulder: 'RIGHT_SHOULDER',
    lelbow: 'LEFT_ELBOW', relbow: 'RIGHT_ELBOW',
    lwrist: 'LEFT_WRIST', rwrist: 'RIGHT_WRIST',
    lhip: 'LEFT_HIP', rhip: 'RIGHT_HIP',
    lknee: 'LEFT_KNEE', rknee: 'RIGHT_KNEE',
    lankle: 'LEFT_ANKLE', rankle: 'RIGHT_ANKLE'
  };

  function init() {
    if (initialized) return Promise.resolve();
    if (!initializing) initializing = initialize().catch(error => { initializing = null; throw error; });
    return initializing;
  }

  async function initialize() {
    if (window.visionReady) await window.visionReady;
    if (!window.vision) {
      throw new Error('MediaPipe vision library не загрузилась.');
    }

    const {
      FilesetResolver,
      PoseLandmarker
    } = window.vision;

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    poseLandmarker = await PoseLandmarker.createFromOptions(
      vision,
      {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
        },

        runningMode: "VIDEO",

        numPoses: 1,

        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      }
    );

    initialized = true;
    lastVideoTime = -1;

    console.log("FORMA: MediaPipe Pose Landmarker готов.");
  }

  function mapLandmarks(landmarks) {

    const get = (index) => {
  const p = landmarks[index];

  if (!p) return null;

  return [
    1 - p.x,
    p.y
  ];
};

    return {
      head: get(LANDMARKS.NOSE),

      neck: average(
        get(LANDMARKS.LEFT_SHOULDER),
        get(LANDMARKS.RIGHT_SHOULDER)
      ),

      lshoulder: get(LANDMARKS.LEFT_SHOULDER),
      rshoulder: get(LANDMARKS.RIGHT_SHOULDER),

      lelbow: get(LANDMARKS.LEFT_ELBOW),
      relbow: get(LANDMARKS.RIGHT_ELBOW),

      lwrist: get(LANDMARKS.LEFT_WRIST),
      rwrist: get(LANDMARKS.RIGHT_WRIST),

      lhip: get(LANDMARKS.LEFT_HIP),
      rhip: get(LANDMARKS.RIGHT_HIP),

      lknee: get(LANDMARKS.LEFT_KNEE),
      rknee: get(LANDMARKS.RIGHT_KNEE),

      lankle: get(LANDMARKS.LEFT_ANKLE),
      rankle: get(LANDMARKS.RIGHT_ANKLE)
    };
  }

  function average(a, b) {
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;

    return [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2
    ];
  }

  function getVisibility(landmarks) {

    const result = {};

    Object.entries(FORMA_POINTS).forEach(([point, landmarkName]) => {

      const p = landmarks[LANDMARKS[landmarkName]];

      result[point] = p && Number.isFinite(p.visibility)
        ? Math.max(0, Math.min(1, p.visibility))
        : 0;
    });

    result.neck = Math.min(
      result.lshoulder,
      result.rshoulder
    );

    return result;
  }

  function estimateFrame(video, mediaTimeMs) {

    if (!poseLandmarker) {
      return null;
    }

    if (!video || video.readyState < 2) {
      return null;
    }

    const videoTime = Number.isFinite(mediaTimeMs) ? mediaTimeMs : video.currentTime * 1000;
    if (videoTime === lastVideoTime) return lastFrame;
    lastVideoTime = videoTime;
    const timestamp = performance.now();

    const result = poseLandmarker.detectForVideo(
      video,
      timestamp
    );

    if (
      !result ||
      !result.landmarks ||
      result.landmarks.length === 0
    ) {
      lastFrame = null;
      return null;
    }

    const landmarks = result.landmarks[0];

    lastFrame = {
      keypoints: mapLandmarks(landmarks),
      visibility: getVisibility(landmarks),
      worldLandmarks:
        result.worldLandmarks?.[0] || null
    };
    return lastFrame;
  }

  function resetFrameClock() { lastVideoTime = -1; lastFrame = null; }

  return {
    init,
    estimateFrame,
    resetFrameClock
  };

})();
