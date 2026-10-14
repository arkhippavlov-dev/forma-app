/* FORMA V0.5 — read-only diagnostic export, 2026-10-14.
   Deliberately does not modify detection, analysis, API calls or recording. */
(function () {
  'use strict';

  function valueOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }

  function localRanges(reps, mediaStartPerf) {
    return (reps || []).map(rep => {
      const start = Number.isFinite(rep.startTime) && Number.isFinite(mediaStartPerf)
        ? rep.startTime - mediaStartPerf : null;
      const end = Number.isFinite(rep.endTime) && Number.isFinite(mediaStartPerf)
        ? rep.endTime - mediaStartPerf : null;
      return {
        index: rep.index,
        startMs: valueOrNull(start),
        endMs: valueOrNull(end),
        durationMs: valueOrNull(rep.durationMs),
        capturedFrames: Array.isArray(rep.frames) ? rep.frames.length : 0
      };
    });
  }

  function downloadFormaSquatDiagnostics() {
    try {
      const state = typeof recState !== 'undefined' ? recState : null;
      const localReps = typeof RepCapture !== 'undefined' ? RepCapture.getCompletedReps() : [];
      const backend = window.__formaBackendResponse || null;
      const result = typeof lastResult !== 'undefined' ? lastResult : null;
      const source = state?.analysisSource || null;
      const strong = source === 'rtmw' ? (window.__formaStrongAnalysis || null) : null;
      const frames = backend?.strong_pose?.frames || [];

      const diagnostic = {
        diagnosticFormat: 'forma-squat-diagnostic/2026-10-14',
        appBaseline: 'FORMA APP V0.5 FIXED / Kelly V0.24',
        createdAt: new Date().toISOString(),
        url: location.origin + location.pathname,
        source,
        media: {
          startPerfMs: valueOrNull(state?.mediaStartPerf),
          stopPerfMs: valueOrNull(state?.mediaStopPerf),
          elapsedMs: Number.isFinite(state?.mediaStartPerf) && Number.isFinite(state?.mediaStopPerf)
            ? state.mediaStopPerf - state.mediaStartPerf : null,
          videoBytes: valueOrNull(state?.videoBlob?.size),
          videoMime: state?.videoBlob?.type || state?.mediaMimeType || null,
          supported: state?.videoRecordingSupported ?? null,
          recordingError: state?.videoError || null,
          repVideoRanges: state?.repVideoRanges || {}
        },
        server: {
          backendStatus: state?.backendStatus || null,
          backendError: state?.backendError || null,
          returnedPoseFrames: frames.length,
          sampleFps: backend?.strong_pose?.sample_fps ?? null,
          firstTimestampMs: valueOrNull(frames[0]?.timestampMs),
          lastTimestampMs: valueOrNull(frames[frames.length - 1]?.timestampMs),
          response: backend
        },
        local: {
          ranges: localRanges(localReps, state?.mediaStartPerf),
          reps: localReps
        },
        computed: {
          strong,
          displayedSquatSet: result?.squatSet || null
        }
      };

      const json = JSON.stringify(diagnostic, null, 2);
      if (!json || json.length < 100) throw new Error('Диагностика пустая.');
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'FORMA_SQUAT_DIAGNOSTIC_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      console.error('FORMA diagnostic export failed:', error);
      alert('Не удалось сохранить диагностику: ' + (error?.message || String(error)));
    }
  }

  window.downloadFormaSquatDiagnostics = downloadFormaSquatDiagnostics;
})();
