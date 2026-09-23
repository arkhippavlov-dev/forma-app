/* Independent camera/inference/render clocks; one inference in flight.
   Diagnostic rates are measured, never filled in with the requested 60. */
const PoseLive = (() => {
  function start(video, canvas, onMeasurement) {
    const display = PoseDisplay.create();
    const ctx = canvas.getContext('2d');
    const hud = document.getElementById('forma-squat-hud');
    const body = document.getElementById('forma-stats-body');
    const summary = document.getElementById('forma-stats-summary');
    let stopped = false, raf = null, vfc = null, busy = false;
    let lastMedia = -1, lastPresented = null, lastSubmit = -Infinity;
    let lastResultAt = performance.now(), lastMissingAt = 0;
    let lastAnalysisAt = -Infinity;
    let lastStats = 0, rateTime = performance.now();
    let cameras = 0, renders = 0, detections = 0;
    let cameraFPS = null, renderFPS = null, poseFPS = null;
    let inferenceMs = null, latencyMs = null, error = '';
    const cameraMeasured = typeof video.requestVideoFrameCallback === 'function';
    const settings = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.() || {};
    const fmt = (n, digits = 0) => Number.isFinite(n) ? n.toFixed(digits) : '—';
    if (hud) hud.hidden = false;

    function submit(mediaTime, now) {
      const status = PoseEstimationService.getStatus();
      const minInterval = status.backend.startsWith('main') ? 1000 / 30 : 1000 / 60;
      if (stopped || busy || status.busy || document.hidden || video.readyState < 2 ||
          mediaTime === lastMedia || now - lastSubmit < minInterval - 1) return;
      busy = true;
      lastMedia = mediaTime;
      lastSubmit = now;
      PoseEstimationService.estimateFrame(video, mediaTime).then(frame => {
        if (stopped || document.hidden || !frame) return;
        const completedAt = performance.now();
        detections++;
        inferenceMs = frame.inferenceMs;
        latencyMs = frame.latencyMs;
        lastResultAt = completedAt;
        error = '';
        // A slow, current request is still a valid observation. There is no
        // queued backlog: only one request can be in flight at a time.
        if (frame.capturedAt <= lastAnalysisAt) return;
        lastAnalysisAt = frame.capturedAt;
        const stable = PoseStabilizer.update(frame.keypoints, frame.visibility, frame.timestampMs);
        const visibility = PoseStabilizer.getVisibility();
        display.push(stable, visibility, completedAt, frame.latencyMs);
        onMeasurement(stable, visibility, frame.capturedAt);
      }).catch(err => {
        error = err.message || String(err);
        console.warn('FORMA pose:', err);
      }).finally(() => { busy = false; });
    }

    function cameraTick(now, meta) {
      if (stopped) return;
      if (!document.hidden) {
        cameras += lastPresented === null ? 1 : Math.max(0, meta.presentedFrames - lastPresented);
        lastPresented = meta.presentedFrames;
        submit(meta.mediaTime, now);
      } else lastPresented = null;
      vfc = video.requestVideoFrameCallback(cameraTick);
    }

    function updateHUD(now) {
      if (now - lastStats < 250) return;
      lastStats = now;
      const elapsed = now - rateTime;
      if (elapsed >= 1000) {
        cameraFPS = cameras * 1000 / elapsed;
        renderFPS = renders * 1000 / elapsed;
        poseFPS = detections * 1000 / elapsed;
        cameras = renders = detections = 0;
        rateTime = now;
      }
      const dr = window.__formaSquatResult;
      const reps = window.__formaCaptureResult?.completedReps || [];
      const last = reps[reps.length - 1];
      const depth = window.__formaLastSquatAnalysis?.depth?.depthValue;
      const status = PoseEstimationService.getStatus();
      const metrics = { cameraFPS, renderFPS, poseFPS, inferenceMs, latencyMs,
        backend: status.backend, cameraMeasured, cameraSettings: settings,
        fallbackReason: status.fallbackReason, error, updatedAt: now };
      window.__formaPerformance = metrics;
      if (summary) summary.textContent = `Экран ${fmt(renderFPS)} · поза ${fmt(poseFPS)} FPS`;
      if (!body) return;
      body.textContent = [
        `FPS камера${cameraMeasured ? '' : '≈'} ${fmt(cameraFPS)} / экран ${fmt(renderFPS)}`,
        `FPS позы ${fmt(poseFPS)} · цель экрана 60`,
        `Модель ${fmt(inferenceMs)} мс · ответ ${fmt(latencyMs)} мс`,
        `${status.backend} · камера ${fmt(settings.frameRate)} Hz`,
        `REPS ${dr?.reps ?? 0} / CAPTURED ${reps.length}`,
        `STATE ${dr?.state || '—'}`,
        `MODE ${dr?.mode || '—'} (${fmt((dr?.confidence || 0) * 100)}%)`,
        `KNEE ${fmt(dr?.kneeAngle)}°`,
        `LAST ${fmt(last?.durationMs / 1000, 2)} s · MIN ${fmt(last?.minKneeAngle)}°`,
        `DEPTH ${fmt(depth, 3)} · FRAMES ${last?.frameCount ?? '—'}`,
        error ? 'Ошибка распознавания: ' + error :
          status.fallbackReason ? 'Резервный режим (без worker)' : ''
      ].filter(Boolean).join('\n');
    }

    let observedMedia = -1;
    function draw(now) {
      if (stopped) return;
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      renders++;
      if (!cameraMeasured && video.currentTime !== observedMedia) {
        observedMedia = video.currentTime;
        cameras++;
        submit(video.currentTime, now);
      }
      // A stalled camera/worker must also release stale motion state.
      // An inference in progress is not evidence that the person disappeared.
      // Advancing the analysis clock here while it runs used to reject every
      // result taking over 300 ms, permanently hiding the skeleton.
      if (!busy && !PoseEstimationService.getStatus().busy &&
          now - lastResultAt > Math.max(300, (latencyMs || 0) * 2) &&
          now - lastMissingAt > 100) {
        lastMissingAt = now;
        lastAnalysisAt = now;
        onMeasurement(null, {}, now);
      }
      window.__formaVideoWidth = video.videoWidth;
      window.__formaVideoHeight = video.videoHeight;
      const visual = display.sample(now);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      SkeletonRenderer.drawUser(ctx, canvas.width, canvas.height, visual.pose, {}, visual.visibility);
      updateHUD(now);
    }

    function visibilityChange() {
      rateTime = performance.now();
      cameras = renders = detections = 0;
      lastPresented = null;
      lastResultAt = performance.now();
    }
    document.addEventListener('visibilitychange', visibilityChange);
    raf = requestAnimationFrame(draw);
    if (cameraMeasured) vfc = video.requestVideoFrameCallback(cameraTick);
    return {
      stop() {
        stopped = true;
        cancelAnimationFrame(raf);
        if (vfc !== null) video.cancelVideoFrameCallback?.(vfc);
        document.removeEventListener('visibilitychange', visibilityChange);
        if (hud) hud.hidden = true;
      }
    };
  }
  return { start };
})();
