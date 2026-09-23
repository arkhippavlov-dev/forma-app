/* No DOM access here: detection must not block the 60 Hz overlay. */
let detector;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const { FilesetResolver, PoseLandmarker } = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs'
      );
      const files = await FilesetResolver.forVisionTasks(data.wasm);
      const options = {
        baseOptions: { modelAssetPath: data.model },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      };
      // Keep the existing CPU delegate, but take it off the UI thread.
      detector = await PoseLandmarker.createFromOptions(files, options);
      self.postMessage({ id: data.id, backend: 'worker/CPU' });
    } else if (data.type === 'detect') {
      const start = performance.now();
      const result = detector.detectForVideo(data.bitmap, data.timestamp);
      self.postMessage({ id: data.id, result: { landmarks: result.landmarks },
        inferenceMs: performance.now() - start });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || String(error) });
  } finally {
    data.bitmap?.close();
  }
};
