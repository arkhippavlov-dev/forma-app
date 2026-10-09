/* ============================================================
   FORMA — BACKEND API
   V0.22

   Browser -> Kelly strong-pose backend.
   - fast health check so MediaPipe fallback does not wait forever
   - longer POST timeout for GPU analysis
   ============================================================ */

const BackendAPI = (function () {

  const HEALTH_TIMEOUT_MS = 5000;
  const ANALYZE_TIMEOUT_MS = 120000;

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
