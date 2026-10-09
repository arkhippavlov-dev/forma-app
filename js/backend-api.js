/* ============================================================
   FORMA — BACKEND API
   V0.21-DIAG

   Temporary diagnostic build.
   Shows the exact server stage on screen and uses XHR so upload
   progress / timeout / network errors are visible on iPhone.
   ============================================================ */

const BackendAPI = (function () {

  const DEBUG_ID = 'forma-backend-debug-panel';

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

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function debugPanel() {
    let el = document.getElementById(DEBUG_ID);

    if (!el) {
      el = document.createElement('div');
      el.id = DEBUG_ID;

      Object.assign(el.style, {
        position: 'fixed',
        left: '12px',
        right: '12px',
        bottom: '16px',
        zIndex: '999999',
        padding: '12px 14px',
        borderRadius: '12px',
        background: 'rgba(0,0,0,.88)',
        color: '#fff',
        font: '12px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)'
      });

      document.body.appendChild(el);
    }

    return el;
  }

  function debug(message, extra = '') {
    const time = new Date().toLocaleTimeString();
    const line =
      '[' + time + '] ' +
      message +
      (extra ? '\n' + extra : '');

    window.__formaBackendDebug = {
      time,
      message,
      extra,
      backendUrl: baseUrl()
    };

    console.log('FORMA BACKEND DIAG:', line);

    try {
      debugPanel().textContent =
        'SERVER DEBUG\n' +
        line +
        '\nURL: ' + baseUrl();
    } catch (_) {}
  }

  async function health() {
    if (!isConfigured()) {
      debug('ОШИБКА: backend URL не настроен');

      return {
        ok: false,
        configured: false,
        error: 'Backend URL не настроен.'
      };
    }

    const url = endpoint('/health');
    debug('Проверяю Kelly /health…', url);

    let response;

    try {
      response = await fetch(url, {
        method: 'GET',
        cache: 'no-store'
      });
    } catch (error) {
      debug(
        'ОШИБКА /health на уровне сети',
        error?.name + ': ' + (error?.message || String(error))
      );
      throw error;
    }

    debug('Kelly /health ответил: HTTP ' + response.status);

    if (!response.ok) {
      throw new Error(
        'Backend health check failed: HTTP ' + response.status
      );
    }

    const payload = await response.json();

    debug(
      'Kelly доступен ✓',
      'service=' + (payload?.service || '?') +
      ' | status=' + (payload?.status || payload?.ok || '?')
    );

    return payload;
  }

  function uploadWithXHR(url, form, totalBlobBytes) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.open('POST', url, true);
      xhr.responseType = 'text';
      xhr.timeout = 180000;

      xhr.upload.onloadstart = function () {
        debug(
          'Началась отправка видео → Kelly',
          'Видео: ' + formatBytes(totalBlobBytes)
        );
      };

      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) {
          debug(
            'Отправляю видео…',
            formatBytes(event.loaded)
          );
          return;
        }

        const percent = Math.min(
          100,
          Math.round((event.loaded / event.total) * 100)
        );

        debug(
          'Загрузка на Kelly: ' + percent + '%',
          formatBytes(event.loaded) + ' / ' + formatBytes(event.total)
        );
      };

      xhr.upload.onload = function () {
        debug(
          'Видео загружено на сервер ✓',
          'Жду RTMW-анализ…'
        );
      };

      xhr.onload = function () {
        const status = xhr.status;
        let payload = null;

        try {
          payload = xhr.responseText
            ? JSON.parse(xhr.responseText)
            : null;
        } catch (_) {
          payload = null;
        }

        if (status >= 200 && status < 300) {
          debug(
            'Kelly вернул результат ✓ HTTP ' + status,
            'RTMW frames=' +
              (payload?.strong_pose_raw?.sampled_frames ?? '?')
          );
          resolve(payload);
          return;
        }

        const detail =
          payload?.detail ||
          payload?.error ||
          xhr.responseText ||
          ('HTTP ' + status);

        debug(
          'ОШИБКА ответа Kelly: HTTP ' + status,
          String(detail).slice(0, 700)
        );

        reject(
          new Error('Backend upload failed: ' + detail)
        );
      };

      xhr.onerror = function () {
        debug(
          'СЕТЕВАЯ ОШИБКА при POST',
          'xhr.status=' + xhr.status +
          '. Запрос не получил HTTP-ответ.'
        );

        reject(
          new Error(
            'Network error during POST /api/v1/analyze'
          )
        );
      };

      xhr.ontimeout = function () {
        debug(
          'ТАЙМАУТ',
          'Kelly не завершил запрос за 180 секунд.'
        );

        reject(
          new Error(
            'Backend upload timeout after 180 seconds'
          )
        );
      };

      xhr.onabort = function () {
        debug(
          'ЗАПРОС ПРЕРВАН',
          'Браузер отменил отправку видео.'
        );

        reject(
          new Error('Backend upload aborted')
        );
      };

      try {
        xhr.send(form);
      } catch (error) {
        debug(
          'ОШИБКА xhr.send()',
          error?.name + ': ' + (error?.message || String(error))
        );
        reject(error);
      }
    });
  }

  async function uploadApproach({
    videoBlob,
    exerciseId,
    repCount,
    clientSessionId,
    clientDurationMs,
    poseFormatVersion
  }) {

    debug(
      'uploadApproach() вызван',
      'URL=' + baseUrl()
    );

    if (!isConfigured()) {
      debug('ОШИБКА: Backend URL не настроен');

      return {
        ok: false,
        configured: false,
        skipped: true,
        error: 'Backend URL не настроен.'
      };
    }

    if (!(videoBlob instanceof Blob) || !videoBlob.size) {
      debug(
        'ОШИБКА: нет видео Blob',
        'type=' + String(videoBlob?.type || '') +
        ' size=' + String(videoBlob?.size || 0)
      );
      throw new Error('Нет записанного видео для отправки.');
    }

    debug(
      'Видео Blob готов ✓',
      'size=' + formatBytes(videoBlob.size) +
      ' | type=' + (videoBlob.type || 'unknown')
    );

    // Diagnostic step: prove that browser JS itself can reach Kelly.
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

    const url = endpoint('/api/v1/analyze');

    debug(
      'FormData собрана ✓',
      'POST ' + url
    );

    return uploadWithXHR(
      url,
      form,
      videoBlob.size
    );
  }

  setTimeout(() => {
    debug(
      'BackendAPI V0.21-DIAG загружен ✓',
      'URL=' + baseUrl()
    );
  }, 0);

  return {
    isConfigured,
    health,
    uploadApproach
  };

})();
