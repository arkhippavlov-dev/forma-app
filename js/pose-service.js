/* ============================================================
   REAL POSE ESTIMATION — MediaPipe Pose Landmarker
   V0.1:
   camera → real pose → skeleton
   ============================================================ */

const PoseEstimationService = (function () {

  let poseLandmarker = null;
  let initialized = false;
  let lastVideoTime = -1;
  let worker = null;
  let pending = null;
  let busy = false;
  let initializing = null;
  let sequence = 0;
  let lastTimestamp = 0;
  let backend = 'loading';
  let fallbackReason = '';
  const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

  function workerRequest(message, transfer = [], timeout = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        if (pending?.id === id) pending = null;
        reject(new Error('Pose worker timeout'));
      }, timeout);
      pending = { id, resolve, reject, timer };
      try { worker.postMessage({ ...message, id }, transfer); }
      catch (error) { clearTimeout(timer); pending = null; reject(error); }
    });
  }

  function closeWorker() {
    worker?.terminate();
    worker = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Pose worker stopped'));
      pending = null;
    }
  }

  async function initMain() {
    const vision = window.vision || await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs');
    const files = await vision.FilesetResolver.forVisionTasks(WASM);
    // Compatibility fallback: the original CPU path, processed once per
    // new frame. The HUD explicitly reports this blocking backend.
    poseLandmarker = await vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL }, runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    backend = 'main/CPU';
  }

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

  async function init() {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        if (!window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) {
          throw new Error('Worker camera processing unavailable');
        }
        worker = new Worker(new URL('js/pose-worker.js?v=smooth-hud-1', document.baseURI));
        worker.onmessage = ({ data }) => {
          if (!pending || data.id !== pending.id) return;
          const request = pending;
          pending = null;
          clearTimeout(request.timer);
          if (data.error) request.reject(new Error(data.error));
          else request.resolve(data);
        };
        worker.onerror = event => {
          event.preventDefault();
          if (pending) {
            const request = pending; pending = null;
            clearTimeout(request.timer);
            request.reject(new Error(event.message || 'Pose worker error'));
          }
        };
        const ready = await workerRequest({ type: 'init', wasm: WASM, model: MODEL }, [], 20000);
        backend = ready.backend;
      } catch (error) {
        fallbackReason = error.message;
        closeWorker();
        await initMain();
      }
      initialized = true;
      lastVideoTime = -1;
    })();
    try { await initializing; } finally { initializing = null; }
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

      result[point] = p
        ? (p.visibility ?? 1)
        : 0;
    });

    result.neck = Math.min(
      result.lshoulder,
      result.rshoulder
    );

    return result;
  }

  async function estimateFrame(video, frameTime = video?.currentTime) {
    // undefined = no NEW measurement; null keypoints = a real empty frame.
    if (!initialized || busy || !video || video.readyState < 2 || frameTime === lastVideoTime) return;
    lastVideoTime = frameTime;
    busy = true;
    const timestamp = Math.max(performance.now(), lastTimestamp + 0.01);
    lastTimestamp = timestamp;
    let bitmap;
    try {
      let result, inferenceMs;
      if (worker) {
        bitmap = await createImageBitmap(video);
        const reply = await workerRequest({ type: 'detect', bitmap, timestamp }, [bitmap]);
        result = reply.result;
        inferenceMs = reply.inferenceMs;
      } else {
        const started = performance.now();
        result = poseLandmarker.detectForVideo(video, timestamp);
        inferenceMs = performance.now() - started;
      }
      const landmarks = result?.landmarks?.[0];
      return {
        keypoints: landmarks ? mapLandmarks(landmarks) : null,
        visibility: landmarks ? getVisibility(landmarks) : null,
        timestampMs: frameTime * 1000,
        capturedAt: timestamp,
        inferenceMs,
        latencyMs: performance.now() - timestamp
      };
    } catch (error) {
      if (worker) {
        fallbackReason = error.message;
        closeWorker();
        backend = 'fallback loading';
        await initMain();
        return;
      }
      throw error;
    } finally {
      bitmap?.close();
      busy = false;
    }
  }

  return {
    init,
    estimateFrame,
    reset: () => { lastVideoTime = -1; },
    getStatus: () => ({ backend, busy, fallbackReason })
  };

})();
