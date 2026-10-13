/* ============================================================
   FORMA — BACKEND API
   V0.23 — fixed subject ROI

   Browser -> Kelly strong-pose backend.
   - fast health check so MediaPipe fallback does not wait forever
   - longer POST timeout for GPU analysis
   ============================================================ */

const BackendAPI = (function () {

  const HEALTH_TIMEOUT_MS = 5000;
  const ANALYZE_TIMEOUT_MS = 120000;

  const SUBJECT_BBOX_JOINTS = [
    'head',
    'leftShoulder', 'rightShoulder',
    'leftElbow', 'rightElbow',
    'leftWrist', 'rightWrist',
    'leftHip', 'rightHip',
    'leftKnee', 'rightKnee',
    'leftAnkle', 'rightAnkle',
    'leftHeel', 'rightHeel',
    'leftFoot', 'rightFoot'
  ];

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function quantile(values, q) {
    const usable = values
      .filter(Number.isFinite)
      .slice()
      .sort((a, b) => a - b);

    if (!usable.length) return null;
    if (usable.length === 1) return usable[0];

    const position =
      Math.max(0, Math.min(1, q)) *
      (usable.length - 1);

    const low = Math.floor(position);
    const high = Math.ceil(position);
    const fraction = position - low;

    return usable[low] * (1 - fraction) +
      usable[high] * fraction;
  }

  /**
   * Build one stable subject ROI from the athlete MediaPipe already tracked
   * during the completed repetitions.
   *
   * IMPORTANT:
   * - front-camera local coordinates are stored as mirrored;
   * - MediaRecorder/server video is unmirrored;
   * - therefore X is flipped before the bbox is sent to Kelly.
   *
   * This ROI is NOT used for technique scoring. It only tells RTMW which
   * person/crop to run on, preventing YOLOX/first-person switching.
   */
  function buildSubjectBboxFromCompletedReps() {
    if (
      typeof RepCapture === 'undefined' ||
      typeof RepCapture.getCompletedReps !== 'function'
    ) {
      return null;
    }

    const reps = RepCapture.getCompletedReps();

    if (!Array.isArray(reps) || !reps.length) {
      return null;
    }

    const frameBoxes = [];

    reps.forEach(rep => {
      (rep?.frames || []).forEach(frame => {
        const formaPose = frame?.formaPose;
        const joints = formaPose?.joints || {};
        const mirrored =
          formaPose?.image?.mirrored === true;

        const points = [];

        SUBJECT_BBOX_JOINTS.forEach(name => {
          const point = joints[name];

          if (
            !point ||
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y)
          ) {
            return;
          }

          let x = point.x;
          const y = point.y;

          // Local selfie preview/pose is mirrored, uploaded video is not.
          if (mirrored) {
            x = 1 - x;
          }

          if (
            x < 0 || x > 1 ||
            y < 0 || y > 1
          ) {
            return;
          }

          points.push([x, y]);
        });

        // Build a FULL-BODY box per frame first. This is important: taking a
        // quantile over all joints directly can accidentally discard the head
        // because there is only one head landmark among many body landmarks.
        if (points.length >= 10) {
          const xs = points.map(point => point[0]);
          const ys = points.map(point => point[1]);

          frameBoxes.push({
            x1: Math.min(...xs),
            y1: Math.min(...ys),
            x2: Math.max(...xs),
            y2: Math.max(...ys)
          });
        }
      });
    });

    if (frameBoxes.length < 4) {
      return null;
    }

    // Robust against a few jittery MediaPipe frames while keeping the whole
    // athlete (head-to-feet) inside the ROI across the complete set.
    let x1 = quantile(frameBoxes.map(box => box.x1), 0.05);
    let y1 = quantile(frameBoxes.map(box => box.y1), 0.05);
    let x2 = quantile(frameBoxes.map(box => box.x2), 0.95);
    let y2 = quantile(frameBoxes.map(box => box.y2), 0.95);

    if (
      ![x1, x2, y1, y2].every(Number.isFinite) ||
      x2 <= x1 ||
      y2 <= y1
    ) {
      return null;
    }

    const width = x2 - x1;
    const height = y2 - y1;

    // Generous padding. RTMPose internally adds another crop padding.
    const padX = Math.max(0.04, width * 0.28);
    const padY = Math.max(0.025, height * 0.06);

    x1 = clamp01(x1 - padX);
    x2 = clamp01(x2 + padX);
    y1 = clamp01(y1 - padY);
    y2 = clamp01(y2 + padY);

    if (
      x2 - x1 < 0.12 ||
      y2 - y1 < 0.35
    ) {
      return null;
    }

    return {
      x1,
      y1,
      x2,
      y2,
      normalized: true,
      mirrored: false,
      source: 'mediapipe-completed-reps'
    };
  }

  function baseUrl() {
    const raw = window.FORMA_CONFIG?.backendUrl || '';
    return String(raw).trim().replace(/\/+$/, '');
  }

  function isConfigured() {
    return /^https?:\/\//i.test(baseUrl());
  }

  function endpoint(path) {
    return baseUrl() + path;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...(options || {}),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function health() {
    if (!isConfigured()) {
      return {
        ok: false,
        configured: false,
        error: 'Backend URL не настроен.'
      };
    }

    let response;

    try {
      response = await fetchWithTimeout(
        endpoint('/health'),
        {
          method: 'GET',
          cache: 'no-store'
        },
        HEALTH_TIMEOUT_MS
      );
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('Kelly не ответил на /health за 5 секунд.');
      }
      throw error;
    }

    if (!response.ok) {
      throw new Error(
        'Backend health check failed: HTTP ' + response.status
      );
    }

    return response.json();
  }

  async function uploadApproach({
    videoBlob,
    exerciseId,
    repCount,
    clientSessionId,
    clientDurationMs,
    poseFormatVersion
  }) {

    if (!isConfigured()) {
      return {
        ok: false,
        configured: false,
        skipped: true,
        error: 'Backend URL не настроен.'
      };
    }

    if (!(videoBlob instanceof Blob) || !videoBlob.size) {
      throw new Error('Нет записанного видео для отправки.');
    }

    // If Kelly is frozen/offline, fail quickly and let MediaPipe fallback win.
    await health();

    const form = new FormData();

    const ext = videoBlob.type?.includes('webm')
      ? 'webm'
      : 'mp4';

    form.append(
      'video',
      videoBlob,
      'forma-approach.' + ext
    );

    form.append(
      'exercise',
      exerciseId || 'unknown'
    );

    form.append(
      'rep_count',
      String(Number.isFinite(repCount) ? repCount : 0)
    );

    form.append(
      'client_session_id',
      clientSessionId || ''
    );

    form.append(
      'client_duration_ms',
      String(
        Number.isFinite(clientDurationMs)
          ? Math.round(clientDurationMs)
          : 0
      )
    );

    form.append(
      'pose_format_version',
      poseFormatVersion || 'forma-pose/v1'
    );

    const subjectBbox =
      buildSubjectBboxFromCompletedReps();

    if (subjectBbox) {
      form.append(
        'subject_bbox',
        JSON.stringify(subjectBbox)
      );

      console.log(
        'FORMA backend: fixed subject ROI',
        subjectBbox
      );
    }

    let response;

    try {
      response = await fetchWithTimeout(
        endpoint('/api/v1/analyze'),
        {
          method: 'POST',
          body: form
        },
        ANALYZE_TIMEOUT_MS
      );
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('Серверный анализ не завершился за 120 секунд.');
      }
      throw error;
    }

    let payload = null;

    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      const detail =
        payload?.detail ||
        payload?.error ||
        ('HTTP ' + response.status);

      throw new Error(
        'Backend upload failed: ' + detail
      );
    }

    return payload;
  }

  return {
    isConfigured,
    health,
    uploadApproach
  };

})();
