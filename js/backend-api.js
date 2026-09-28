/* ============================================================
   FORMA — BACKEND API
   V0.21

   Browser → backend foundation.
   This module does NOT decide technique quality yet.
   It only proves that the recorded approach video can leave the
   phone, reach the server, and return a verified response.
   ============================================================ */

const BackendAPI = (function () {

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

  async function health() {
    if (!isConfigured()) {
      return {
        ok: false,
        configured: false,
        error: 'Backend URL не настроен.'
      };
    }

    const response = await fetch(
      endpoint('/health'),
      {
        method: 'GET',
        cache: 'no-store'
      }
    );

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
      String(
        Number.isFinite(repCount)
          ? repCount
          : 0
      )
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

    const response = await fetch(
      endpoint('/api/v1/analyze'),
      {
        method: 'POST',
        body: form
      }
    );

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
