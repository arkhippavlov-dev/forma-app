/* =====================================================================
   APP — screens, navigation, and glue between the modules above.
   Front camera is used for testing/preview.
   ===================================================================== */

// ---------------- shared state ----------------
let PROFILE = null;
let HISTORY = {};
let currentExercise = null;
let currentScreen = 's-intro';
let lastResult = null;
let recState = null;
let compareState = null;
const streamRegistry = {};

// ---------------- utils ----------------
function getCss(v){
  return getComputedStyle(document.documentElement)
    .getPropertyValue(v)
    .trim();
}

function scorePillClass(score){
  return score >= 80 ? 'pill-good' :
         score >= 65 ? 'pill-warn' :
         'pill-bad';
}

function scoreColor(score){
  return score >= 80 ? getCss('--good') :
         score >= 65 ? getCss('--warn') :
         getCss('--bad');
}

function ruleByKey(exercise, key){
  return exercise.error_rules.find(r => r.key === key);
}

// ---------------- navigation ----------------
function go(id){
  document.querySelectorAll('.screen')
    .forEach(s => s.classList.remove('active'));

  document.getElementById(id).classList.add('active');

  document.getElementById('tabbar').style.display =
    (id === 's-home' ||
     id === 's-historytab' ||
     id === 's-profile')
      ? 'flex'
      : 'none';

  currentScreen = id;

  // --------------------------------------------------
  // CAMERA
  // --------------------------------------------------
  // Front camera for onboarding selfie.
  if(id === 's-capture'){
    attachCamera(
      document.getElementById('capvideo'),
      'cap',
      'user',
      'capnoperm'
    );
  } else {
    stopCameraStream(streamRegistry.cap);
  }

  // Front camera for exercise setup/check.
  // Changed from "environment" to "user".
  if(id === 's-check'){
    attachCamera(
      document.getElementById('checkvideo'),
      'check',
      'user',
      'checknoperm'
    );

    runFrameCheck();
  } else {
    stopCameraStream(streamRegistry.check);
  }

  // Stop recording camera whenever we leave recording.
  // EXCEPTION: when Stop is pressed we switch to the analyzing screen
  // immediately, but MediaRecorder still needs the live camera track for a
  // moment to finalize the MP4 on iPhone/Safari. Stopping the track here
  // could leave us with no videoUrl at all. stopRecording() explicitly stops
  // the camera right after MediaRecorder has finished.
  const keepRecStreamForVideoFinalize =
    id === 's-analyzing' &&
    recState?.stopping &&
    recState?.mediaRecorder &&
    recState.mediaRecorder.state !== 'inactive';

  if(id !== 's-record' && !keepRecStreamForVideoFinalize){
    stopCameraStream(streamRegistry.rec);
  }

  if(id !== 's-compare' && compareState){
    compareState.playing = false;
  }

  if(id !== 's-repdetail' && repPlaybackState?.video){
    repPlaybackState.video.pause();
    repPlaybackState = null;
  }

  // --------------------------------------------------
  // SCREEN RENDERING
  // --------------------------------------------------
  if(id === 's-home') renderHome();
  if(id === 's-exselect') renderExerciseSelect();
  if(id === 's-setup') renderSetup();
  if(id === 's-historytab') renderHistoryTab();
  if(id === 's-profile') renderProfile();
}


function switchTab(id){
  document.querySelectorAll('.tabbtn')
    .forEach(t =>
      t.classList.toggle('active', t.dataset.tab === id)
    );

  go(id);
}


// ---------------- camera helpers ----------------

/**
 * attachCamera
 *
 * facing:
 *   "user"        = front/selfie camera
 *   "environment" = rear/main camera
 */
async function attachCamera(videoEl, key, facing, noPermId){

  const noPermEl =
    noPermId
      ? document.getElementById(noPermId)
      : null;

  if(noPermEl){
    noPermEl.style.display = 'none';
  }

  // Camera requires HTTPS or localhost.
  if(
    !(window.isSecureContext &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia)
  ){

    if(noPermEl){
      noPermEl.innerHTML =
        'Камера недоступна: страница должна быть открыта по https:// ' +
        '(или localhost).<br><br>' +
        'Открой FORMA по защищённой ссылке.';
      noPermEl.style.display = 'flex';
    }

    return false;
  }

  const videoConstraints = {
  width: {
    ideal: 720
  },
  height: {
    ideal: 960
  },
  aspectRatio: {
    ideal: 0.75
  }
};

  // First try exact requested camera.
  // Then a softer request.
  // Then any available camera.
  const attempts = [

    {
      ...videoConstraints,
      facingMode: {
        exact: facing
      }
    },

    {
      ...videoConstraints,
      facingMode: facing
    },

    true

  ];

  for(const constraint of attempts){

    try{

      const stream =
        await navigator.mediaDevices.getUserMedia({
          video: constraint,
          audio: false
        });

      // Stop previous camera on this slot.
      stopCameraStream(streamRegistry[key]);

      // Attach new stream.
      videoEl.srcObject = stream;

      // Mirror only front camera.
      videoEl.classList.toggle(
        'mirror',
        facing === 'user'
      );

      // iPhone sometimes requires explicit play().
      try{
        await videoEl.play();
      }catch(e){
        // autoplay attribute should normally handle this
      }

      streamRegistry[key] = stream;

      return true;

    }catch(e){

      console.warn(
        'Camera attempt failed:',
        facing,
        e
      );

    }

  }

  if(noPermEl){

    noPermEl.innerHTML =
      'Нет доступа к камере.<br><br>' +
      'Разреши доступ к камере в Safari: ' +
      'адресная строка → «aA» → Настройки сайта → Камера → Разрешить, ' +
      'затем обнови страницу.';

    noPermEl.style.display = 'flex';
  }

  return false;
}


function stopCameraStream(stream){

  if(stream){
    stream.getTracks().forEach(track => {
      track.stop();
    });
  }

}


// ---------------- approach video recording ----------------

function chooseRecordingMimeType(){

  if(
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ){
    return '';
  }

  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  return candidates.find(type =>
    MediaRecorder.isTypeSupported(type)
  ) || '';
}


function releasePreviousApproachVideo(){

  if(recState && recState.videoUrl){

    try{
      URL.revokeObjectURL(recState.videoUrl);
    }catch(e){
      // nothing to do
    }

    recState.videoUrl = null;
  }

}


function finalizeApproachVideo(state){

  if(
    !state ||
    state.videoUrl ||
    !Array.isArray(state.mediaChunks) ||
    !state.mediaChunks.length
  ){
    return;
  }

  const type =
    state.mediaChunks.find(chunk => chunk && chunk.type)?.type ||
    state.mediaMimeType ||
    'video/mp4';

  const blob =
    new Blob(
      state.mediaChunks,
      { type }
    );

  if(!blob.size){
    return;
  }

  state.videoBlob = blob;
  state.videoUrl = URL.createObjectURL(blob);
}


function startApproachVideoRecording(stream){

  if(
    !recState ||
    !stream ||
    typeof MediaRecorder === 'undefined'
  ){
    if(recState){
      recState.videoRecordingSupported = false;
    }
    return false;
  }

  // Capture the current recording state once. Safari may deliver the final
  // dataavailable event asynchronously; using the captured object prevents a
  // later screen/state change from making the event write into another session.
  const state = recState;

  try{

    const recorder = new MediaRecorder(stream);

    state.mediaRecorder = recorder;
    state.mediaChunks = [];
    state.mediaMimeType = recorder.mimeType || '';
    state.videoRecordingSupported = true;
    state.videoError = null;

    state.mediaFinalizePromise = new Promise(resolve => {
      state.mediaFinalizeResolve = resolve;
    });

    const resolveFinalVideo = () => {
      finalizeApproachVideo(state);

      if(state.videoBlob?.size && state.mediaFinalizeResolve){
        state.mediaFinalizeResolve(true);
        state.mediaFinalizeResolve = null;
      }
    };

    recorder.addEventListener(
      'dataavailable',
      event => {
        if(event.data && event.data.size > 0){
          state.mediaChunks.push(event.data);
        }

        // On iOS the final data payload can arrive extremely close to (or in
        // practice after) the stop callback. Try finalization from both events.
        resolveFinalVideo();
      }
    );

    recorder.addEventListener(
      'error',
      event => {
        state.videoError =
          event?.error?.message ||
          'Ошибка записи видео.';

        if(state.mediaFinalizeResolve){
          state.mediaFinalizeResolve(false);
          state.mediaFinalizeResolve = null;
        }

        console.warn(
          'FORMA MediaRecorder:',
          event?.error || event
        );
      }
    );

    recorder.addEventListener(
      'stop',
      () => {
        resolveFinalVideo();
      },
      { once: true }
    );

    state.mediaStartPerf = performance.now();

    // Keep one continuous native recording. No timeslice: concatenated MP4
    // fragments previously produced broken duration/seeking on iPhone Safari.
    recorder.start();

    return true;

  }catch(error){

    state.videoRecordingSupported = false;
    state.videoError = error?.message || String(error);

    if(state.mediaFinalizeResolve){
      state.mediaFinalizeResolve(false);
      state.mediaFinalizeResolve = null;
    }

    console.warn(
      'FORMA: approach video recording unavailable:',
      error
    );

    return false;
  }

}


function sleepMs(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function waitForApproachVideoReady(state, maxWaitMs = 1800){

  if(!state) return false;

  const started = performance.now();

  while(performance.now() - started < maxWaitMs){

    finalizeApproachVideo(state);

    if(state.videoUrl && state.videoBlob?.size){
      return true;
    }

    // Safari can dispatch the final dataavailable payload a little after
    // the recorder's stop event. Give that payload time to land before the
    // results screen becomes interactive.
    await sleepMs(60);
  }

  finalizeApproachVideo(state);
  return Boolean(state.videoUrl);
}


async function stopApproachVideoRecording(){

  const state = recState;

  if(!state || !state.mediaRecorder){
    return false;
  }

  const recorder = state.mediaRecorder;

  if(recorder.state !== 'inactive'){

    try{
      recorder.stop();
    }catch(error){
      state.videoError = error?.message || String(error);
    }
  }

  // Wait for the actual final data payload, not only for MediaRecorder's stop
  // event. This is the part that could race on iPhone and leave videoBlob null.
  if(state.mediaFinalizePromise){
    await Promise.race([
      state.mediaFinalizePromise,
      sleepMs(8000)
    ]);
  }

  // Fallback polling in case Safari fired events in an unusual order.
  await waitForApproachVideoReady(state, 5000);

  finalizeApproachVideo(state);

  if(!state.videoBlob?.size){
    state.videoError =
      state.videoError ||
      'MediaRecorder завершился без видео-данных.';

    console.warn('FORMA: no final video blob', {
      supported: state.videoRecordingSupported,
      recorderState: recorder.state,
      chunks: state.mediaChunks?.length || 0,
      mimeType: state.mediaMimeType || '',
      error: state.videoError
    });

    return false;
  }

  return true;
}



function showBackendToast(text, ok = true){

  let toast = document.getElementById('forma-backend-toast');

  if(!toast){
    toast = document.createElement('div');
    toast.id = 'forma-backend-toast';
    toast.style.cssText = `
      position: fixed;
      left: 50%;
      bottom: calc(24px + env(safe-area-inset-bottom));
      transform: translateX(-50%);
      z-index: 100000;
      max-width: calc(100vw - 32px);
      padding: 9px 12px;
      border-radius: 999px;
      background: rgba(10, 12, 15, 0.92);
      border: 1px solid rgba(255,255,255,0.12);
      color: #F2F3F5;
      font: 12px/1.2 -apple-system, BlinkMacSystemFont, sans-serif;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity 160ms ease;
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = text;
  toast.style.borderColor = ok
    ? 'rgba(74,222,128,0.35)'
    : 'rgba(251,90,76,0.38)';
  toast.style.opacity = '1';

  clearTimeout(showBackendToast._timer);
  showBackendToast._timer = setTimeout(() => {
    toast.style.opacity = '0';
  }, 2200);
}


function setBackendBadge(text, state = ''){

  const badge = document.querySelector('#s-analyzing .api-badge');
  if(!badge) return;

  badge.textContent = text;
  badge.dataset.state = state;
}


function formatUploadBytes(bytes){

  if(!Number.isFinite(bytes) || bytes <= 0){
    return '';
  }

  if(bytes < 1024 * 1024){
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}


function makeBackendSessionId(){
  return 'forma-' +
    Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 8);
}


async function uploadCurrentApproachToBackend(){

  const state = recState;

  if(!state){
    setBackendBadge('SERVER · нет записи', 'error');
    return null;
  }

  // One last Safari-safe chance to receive/finalize the recording before we
  // decide there is no uploadable file. This does not block the local fallback
  // analysis; the upload runs in parallel.
  if(!state.videoBlob?.size){
    setBackendBadge('SERVER · готовлю видео…', 'uploading');
    await waitForApproachVideoReady(state, 6000);
    finalizeApproachVideo(state);
  }

  if(!state.videoBlob?.size){
    state.backendStatus = 'no-video';
    state.backendError = state.videoError || 'Видео Blob не создан.';
    setBackendBadge('SERVER · видео не создано', 'error');
    showBackendToast('SERVER · видео не создано', false);
    console.warn('FORMA backend: upload skipped, no video blob', {
      supported: state.videoRecordingSupported,
      chunks: state.mediaChunks?.length || 0,
      mimeType: state.mediaMimeType || '',
      videoError: state.videoError || null
    });
    return null;
  }

  if(
    typeof BackendAPI === 'undefined' ||
    !BackendAPI.isConfigured()
  ){
    state.backendStatus = 'not-configured';
    setBackendBadge('SERVER · не подключён', 'idle');
    return null;
  }

  state.backendStatus = 'uploading';
  setBackendBadge('SERVER · отправляю видео…', 'uploading');

  try{

    const completedReps = RepCapture.getCompletedReps();

    const response = await BackendAPI.uploadApproach({
      videoBlob: state.videoBlob,
      exerciseId: currentExercise?.id || 'unknown',
      repCount: completedReps.length,
      clientSessionId: state.backendSessionId,
      clientDurationMs:
        Number.isFinite(state.mediaStartPerf) &&
        Number.isFinite(state.mediaStopPerf)
          ? state.mediaStopPerf - state.mediaStartPerf
          : 0,
      poseFormatVersion: 'forma-pose/v1'
    });

    state.backendStatus = 'received';
    state.backendResponse = response;
    window.__formaBackendResponse = response;

    const size = formatUploadBytes(response?.video?.size_bytes);

    const successText =
      'SERVER ✓ видео принято' + (size ? ' · ' + size : '');

    setBackendBadge(successText, 'ok');
    showBackendToast(successText, true);

    console.log('FORMA backend response:', response);

    return response;

  }catch(error){

    state.backendStatus = 'error';
    state.backendError = error?.message || String(error);
    window.__formaBackendResponse = null;

    setBackendBadge('SERVER · ошибка отправки', 'error');
    showBackendToast('SERVER · ошибка отправки', false);

    console.warn('FORMA backend upload:', error);

    return null;
  }
}


function buildRepVideoRanges(completedReps){

  if(
    !recState ||
    !Number.isFinite(recState.mediaStartPerf) ||
    !Array.isArray(completedReps)
  ){
    return {};
  }

  const ranges = {};

  completedReps.forEach(rep => {

    if(
      !Number.isFinite(rep?.index) ||
      !Number.isFinite(rep?.startTime) ||
      !Number.isFinite(rep?.endTime)
    ){
      return;
    }

    const rawStart =
      (rep.startTime - recState.mediaStartPerf) / 1000;

    const rawEnd =
      (rep.endTime - recState.mediaStartPerf) / 1000;

    const startSec =
      Math.max(
        0,
        rawStart - 0.35
      );

    const endSec =
      Math.max(
        startSec + 0.25,
        rawEnd + 0.35
      );

    ranges[rep.index] = {
      startSec,
      endSec
    };

  });

  return ranges;
}


let repPlaybackState = null;


function setupRepVideoPlayer(repIndex){

  const video =
    document.getElementById('repVideoPlayer');

  const range =
    recState?.repVideoRanges?.[repIndex];

  const sourceUrl =
    recState?.videoUrl;

  if(
    !video ||
    !sourceUrl ||
    !range
  ){
    return;
  }

  const state = {
    video,
    startSec: range.startSec,
    endSec: range.endSec
  };

  repPlaybackState = state;

  video.src = sourceUrl;

  let initialSeekDone = false;

  const seekToStart = () => {

    const duration = video.duration;

    // Safari can emit loadedmetadata before the final MP4 duration is ready.
    // Wait for a later durationchange/loadeddata rather than clamping a rep
    // against a temporary 0/Infinity duration.
    if(
      !Number.isFinite(duration) ||
      duration <= 0.05
    ){
      return false;
    }

    const end = Math.min(
      range.endSec,
      duration
    );

    const maxStart = Math.max(
      0,
      duration - 0.05
    );

    state.startSec = Math.min(
      range.startSec,
      maxStart
    );

    state.endSec = Math.max(
      state.startSec + 0.1,
      Math.min(end, duration)
    );

    try{
      video.currentTime = state.startSec;
      initialSeekDone = true;
    }catch(e){
      return false;
    }

    return true;
  };

  const tryInitialSeek = () => {
    if(!initialSeekDone){
      seekToStart();
    }
  };

  const seekAndAutoplay = () => {
    const ready = seekToStart();

    if(!ready) return;

    const playPromise = video.play();
    if(playPromise && typeof playPromise.catch === 'function'){
      playPromise.catch(() => {});
    }
  };

  video.addEventListener('loadedmetadata', seekAndAutoplay);
  video.addEventListener('durationchange', tryInitialSeek);
  video.addEventListener('loadeddata', seekAndAutoplay);

  // No native controls: on a 1–3 second repetition Safari's overlay covers
  // most of the movement and often never has time to fade away. A tap on the
  // video is enough to pause/resume; the header keeps the explicit Replay button.
  video.addEventListener('click', () => {
    if(video.paused){
      if(video.currentTime >= state.endSec - 0.03){
        try{ video.currentTime = state.startSec; }catch(e){}
      }
      const playPromise = video.play();
      if(playPromise && typeof playPromise.catch === 'function'){
        playPromise.catch(() => {});
      }
    }else{
      video.pause();
    }
  });

  video.addEventListener(
    'play',
    () => {

      if(!initialSeekDone){
        seekToStart();
      }

      if(
        video.currentTime < state.startSec - 0.05 ||
        video.currentTime >= state.endSec - 0.03
      ){
        try{
          video.currentTime = state.startSec;
        }catch(e){
          // ignore
        }
      }

    }
  );

  video.addEventListener(
    'timeupdate',
    () => {

      if(video.currentTime >= state.endSec){

        video.pause();

        try{
          video.currentTime = state.endSec;
        }catch(e){
          // ignore
        }

      }

    }
  );

  video.load();
}


function replayCurrentRepVideo(){

  const state = repPlaybackState;

  if(!state?.video){
    return;
  }

  try{
    state.video.currentTime = state.startSec;
  }catch(e){
    // ignore
  }

  const playPromise = state.video.play();

  if(playPromise && typeof playPromise.catch === 'function'){
    playPromise.catch(() => {});
  }

}


// ---------------- page visibility ----------------

let pageHidden = false;

document.addEventListener(
  'visibilitychange',
  () => {
    pageHidden = document.hidden;
  }
);


// ================= INIT / ONBOARDING =================

document.addEventListener(
  'DOMContentLoaded',
  init
);


async function init(){

  const savedProfile =
    await ProfileStore.load();

  const savedHistory =
    await HistoryStore.load();

  if(savedHistory){
    HISTORY = savedHistory;
  }

  if(savedProfile){
    PROFILE = savedProfile;
    go('s-home');
  }else{
    go('s-intro');
  }
}


let profilePhotoData = null;


function captureProfilePhoto(){

  const video =
    document.getElementById('capvideo');

  const c =
    document.createElement('canvas');

  c.width = 300;
  c.height = 400;

  const ctx =
    c.getContext('2d');

  if(video.videoWidth){

    ctx.save();

    ctx.translate(
      c.width,
      0
    );

    ctx.scale(
      -1,
      1
    );

    ctx.drawImage(
      video,
      0,
      0,
      c.width,
      c.height
    );

    ctx.restore();

  }else{

    ctx.fillStyle = '#1C2027';

    ctx.fillRect(
      0,
      0,
      c.width,
      c.height
    );

  }

  profilePhotoData =
    c.toDataURL(
      'image/jpeg',
      0.8
    );

  go('s-anthro');
}


function recalcAnthro(){

  const h =
    parseFloat(
      document.getElementById('heightInput').value
    );

  const wrap =
    document.getElementById('anthroResults');

  const finishBtn =
    document.getElementById('finishOnboardBtn');

  if(
    !h ||
    h < 120 ||
    h > 230
  ){

    wrap.style.display = 'none';
    finishBtn.disabled = true;

    return;
  }

  const seed =
    Math.round(h) % 7;

  const legRatio =
    0.485 + (seed - 3) * 0.004;

  const torsoRatio =
    0.295 + (3 - seed) * 0.003;

  const armRatio =
    0.44 + (seed - 3) * 0.002;

  const legLen =
    Math.round(h * legRatio);

  const torsoLen =
    Math.round(h * torsoRatio);

  const armLen =
    Math.round(h * armRatio);

  const asymNote =
    (seed % 4 === 0)
      ? 'Небольшая асимметрия в высоте плеч'
      : 'Плечи расположены симметрично';

  window._anthroDraft = {
    legLen,
    torsoLen,
    armLen,
    legRatio,
    torsoRatio,
    asymNote
  };

  document.getElementById('anthroList').innerHTML = `

    <div class="checklist-item">
      <div class="dot">🦵</div>
      <div>
        <b>Длина ног (расчётно)</b>
        <span>
          ${legLen} см —
          ${legRatio > 0.49
            ? 'выше среднего для приседа'
            : 'стандартная пропорция'}
        </span>
      </div>
    </div>

    <div class="checklist-item">
      <div class="dot">🧍</div>
      <div>
        <b>Длина корпуса</b>
        <span>${torsoLen} см</span>
      </div>
    </div>

    <div class="checklist-item">
      <div class="dot">💪</div>
      <div>
        <b>Длина рук</b>
        <span>${armLen} см</span>
      </div>
    </div>

    <div class="checklist-item">
      <div class="dot">↔️</div>
      <div>
        <b>Стойка</b>
        <span>${asymNote}</span>
      </div>
    </div>

  `;

  wrap.style.display = 'block';
  finishBtn.disabled = false;
}


async function finishOnboarding(){

  const h =
    parseFloat(
      document.getElementById('heightInput').value
    );

  PROFILE = {
    heightCm: h,
    photo: profilePhotoData,
    anthro: window._anthroDraft,
    createdAt: Date.now()
  };

  await ProfileStore.save(PROFILE);

  go('s-home');
}


// ================= HOME =================

function exIcon(exId){

  const icons = {

    lat_pulldown:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7C6CFF" stroke-width="1.8"><path d="M12 3v4M6 7h12M8 7l-2 5M16 7l2 5M12 11v6M9 21l3-4 3 4"/></svg>',

    squat:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7C6CFF" stroke-width="1.8"><circle cx="12" cy="4" r="1.6"/><path d="M12 6v6l-3 4v5M12 12l3 4v5"/></svg>',

    bench_press:
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7C6CFF" stroke-width="1.8"><path d="M2 12h4M18 12h4M6 9v6M18 9v6M6 12h12"/></svg>'

  };

  return icons[exId] || '';
}


function renderHome(){

  const recentWrap =
    document.getElementById('recentList');

  const histWrap =
    document.getElementById('historyEntry');

  recentWrap.innerHTML = '';
  histWrap.innerHTML = '';

  const entries = [];

  Object.keys(HISTORY).forEach(
    exId => {

      const arr = HISTORY[exId];

      if(arr && arr.length){

        entries.push({
          exId,
          last: arr[arr.length - 1],
          count: arr.length
        });

      }

    }
  );


  if(entries.length === 0){

    recentWrap.innerHTML = `
      <div class="empty-state">
        <div style="font-size:32px;">🏋️</div>
        <div>
          Пока нет анализов.<br>
          Добавь первое упражнение,
          чтобы увидеть результат здесь.
        </div>
      </div>
    `;

  }else{

    entries
      .sort(
        (a,b) =>
          b.last.date - a.last.date
      )
      .forEach(e => {

        const ex =
          ExerciseLibrary.get(e.exId);

        const row =
          document.createElement('div');

        row.className = 'exrow';

        row.onclick =
          () => openExerciseFromHistory(e.exId);

        row.innerHTML = `
          <div class="ico">
            ${exIcon(e.exId)}
          </div>

          <div class="meta">
            <b>${ex.name}</b>
            <span>${e.count} анализ(ов)</span>
          </div>

          <div class="scorepill ${scorePillClass(e.last.score)}">
            ${e.last.score}
          </div>
        `;

        recentWrap.appendChild(row);

      });

  }


  let deltaTotal = 0;
  let deltaCount = 0;

  Object.values(HISTORY).forEach(
    arr => {

      if(arr.length > 1){

        deltaTotal +=
          arr[arr.length - 1].score -
          arr[0].score;

        deltaCount++;

      }

    }
  );

  const pct =
    deltaCount
      ? Math.round(deltaTotal / deltaCount)
      : 0;

  document.getElementById('progressNum').textContent =
    (pct >= 0 ? '+' : '') +
    pct +
    '%';


  ExerciseLibrary.all().forEach(
    ex => {

      const arr =
        HISTORY[ex.id] || [];

      const row =
        document.createElement('div');

      row.className = 'exrow';

      row.onclick =
        () => openExerciseFromHistory(ex.id);

      row.innerHTML =
        arr.length

          ? `
            <div class="ico">
              ${exIcon(ex.id)}
            </div>

            <div class="meta">
              <b>${ex.name}</b>
              <span>
                Прогресс:
                ${arr.map(a => a.score).join(' → ')}
              </span>
            </div>

            <div class="chev">›</div>
          `

          : `
            <div class="ico">
              ${exIcon(ex.id)}
            </div>

            <div class="meta">
              <b>${ex.name}</b>
              <span>Ещё не анализировалось</span>
            </div>

            <div class="chev">›</div>
          `;

      histWrap.appendChild(row);

    }
  );

}


function openExerciseFromHistory(exId){

  const arr =
    HISTORY[exId];

  if(arr && arr.length){

    renderResults(
      arr[arr.length - 1].fullResult
    );

    go('s-results');

  }else{

    selectExercise(exId);

  }
}


// ================= EXERCISE LIBRARY =================

function renderExerciseSelect(){

  document.getElementById('exSearchInput').value = '';

  document.getElementById('exSearchEmpty').style.display =
    'none';

  const wrap =
    document.getElementById('exSelectList');

  wrap.style.display = 'flex';

  wrap.innerHTML = '';

  ExerciseLibrary.all().forEach(
    ex => {

      const row =
        document.createElement('div');

      row.className = 'exrow';

      row.onclick =
        () => selectExercise(ex.id);

      row.innerHTML = `
        <div class="ico">
          ${exIcon(ex.id)}
        </div>

        <div class="meta">
          <b>${ex.name}</b>
          <span>
            Ракурс съёмки:
            ${ex.recommended_camera_angle.label}
          </span>
        </div>

        <div class="chev">›</div>
      `;

      wrap.appendChild(row);

    }
  );

  wrap.insertAdjacentHTML(
    'beforeend',
    `<div class="addex-row">
      + Больше упражнений скоро появится здесь
    </div>`
  );
}


function onExerciseSearch(){

  const q =
    document.getElementById('exSearchInput')
      .value
      .trim()
      .toLowerCase();

  const wrap =
    document.getElementById('exSelectList');

  const emptyWrap =
    document.getElementById('exSearchEmpty');

  if(!q){

    renderExerciseSelect();

    return;
  }

  const matches =
    ExerciseLibrary.all()
      .filter(
        ex =>
          ex.name
            .toLowerCase()
            .includes(q)
      );


  if(matches.length > 0){

    wrap.style.display = 'flex';

    emptyWrap.style.display = 'none';

    wrap.innerHTML = '';

    matches.forEach(
      ex => {

        const row =
          document.createElement('div');

        row.className = 'exrow';

        row.onclick =
          () => selectExercise(ex.id);

        row.innerHTML = `
          <div class="ico">
            ${exIcon(ex.id)}
          </div>

          <div class="meta">
            <b>${ex.name}</b>

            <span>
              Ракурс съёмки:
              ${ex.recommended_camera_angle.label}
            </span>
          </div>

          <div class="chev">›</div>
        `;

        wrap.appendChild(row);

      }
    );

    return;
  }


  wrap.style.display = 'none';

  emptyWrap.style.display = 'block';

  emptyWrap.innerHTML = `
    <div class="exlibrary-empty">

      <div class="icowrap">
        🔍
      </div>

      <b>
        «${escapeHtml(
          document.getElementById('exSearchInput').value
        )}»
        пока недоступно
      </b>

      <span>
        Мы добавим это упражнение в библиотеку
        в будущем. Сейчас доступны:
        жим лёжа, приседания, тяга верхнего блока.
      </span>

    </div>

    <div class="ai-search-stub">

      <b>Скоро:</b>
      опиши упражнение своими словами,
      и AI сам подберёт нужную модель анализа —
      суставы для отслеживания,
      ракурс камеры и правила техники.

    </div>
  `;
}


function escapeHtml(s){

  const d =
    document.createElement('div');

  d.textContent = s;

  return d.innerHTML;
}


let currentExerciseId = null;


function selectExercise(exId){

  currentExercise =
    ExerciseLibrary.get(exId);

  currentExerciseId =
    exId;

  go('s-setup');
}


// ================= CAMERA SETUP =================

function renderSetup(){

  const ex =
    currentExercise;

  document.getElementById('setupTitle').textContent =
    ex.name;

  document.getElementById('setupQuote').textContent =
    '"' +
    ex.recommended_camera_angle.quote +
    '"';

  document.getElementById('setupDist').textContent =
    ex.camera_setup.distance;

  document.getElementById('setupHeight').textContent =
    ex.camera_setup.height;

  document.getElementById('setupVisible').textContent =
    ex.camera_setup.visible;

  drawAngleDiagram(
    ex.recommended_camera_angle.deg
  );
}


function drawAngleDiagram(deg){

  const svg =
    document.getElementById('angleSvg');

  const brand =
    getCss('--brand');

  svg.innerHTML = `

    <circle
      cx="70"
      cy="70"
      r="60"
      fill="none"
      stroke="${getCss('--border')}"
      stroke-width="1.5"
    />

    <circle
      cx="70"
      cy="90"
      r="14"
      fill="${getCss('--surface-2')}"
      stroke="${getCss('--text-dim')}"
      stroke-width="1.3"
    />

    <line
      x1="70"
      y1="76"
      x2="70"
      y2="55"
      stroke="${getCss('--text-dim')}"
      stroke-width="3"
      stroke-linecap="round"
    />

    <line
      x1="70"
      y1="60"
      x2="55"
      y2="45"
      stroke="${getCss('--text-dim')}"
      stroke-width="3"
      stroke-linecap="round"
    />

    <line
      x1="70"
      y1="60"
      x2="85"
      y2="45"
      stroke="${getCss('--text-dim')}"
      stroke-width="3"
      stroke-linecap="round"
    />

    <g transform="rotate(${-deg} 70 70)">

      <rect
        x="20"
        y="8"
        width="18"
        height="11"
        rx="2.5"
        fill="${brand}"
      />

      <line
        x1="29"
        y1="19"
        x2="70"
        y2="70"
        stroke="${brand}"
        stroke-width="1.4"
        stroke-dasharray="3,3"
      />

    </g>

    <text
      x="70"
      y="132"
      text-anchor="middle"
      font-size="11"
      fill="${getCss('--text-dim')}"
      font-family="monospace"
    >
      ${deg}°
    </text>
  `;
}


// ================= FRAME CHECK =================

function runFrameCheck(){

  const ids = [
    'chk1',
    'chk2',
    'chk3',
    'chk4',
    'chk5'
  ];

  ids.forEach(
    id =>
      document
        .getElementById(id)
        .classList
        .remove('ok')
  );

  document.getElementById(
    'beginAnalysisBtn'
  ).disabled = true;

  let i = 0;

  const timer =
    setInterval(
      () => {

        if(i >= ids.length){

          clearInterval(timer);

          document.getElementById(
            'beginAnalysisBtn'
          ).disabled = false;

          return;
        }

        document
          .getElementById(ids[i])
          .classList
          .add('ok');

        i++;

      },
      420
    );
}


function startCheckScreen(){
  go('s-check');
}


// ================= RECORDING =================

async function startRecording(){

  try{

    go('s-record');

    const video =
      document.getElementById('recvideo');

    // IMPORTANT:
    // Front camera for current testing.
    await attachCamera(
      video,
      'rec',
      'user',
      'recnoperm'
    );
     
    document.getElementById(
      'recExName'
    ).textContent =
      currentExercise.name;


    // Load real Pose Landmarker.
    await PoseEstimationService.init();


    // The previous approach video only lives in memory for the current result.
    // Release it before starting a fresh approach.
    releasePreviousApproachVideo();


    recState = {

      startTime: Date.now(),

      reps: [],

      repFrames: {},

      repIndex: 0,

      t: 0,

      finished: false,

      stopping: false,

      mediaRecorder: null,
      mediaChunks: [],
      mediaStartPerf: null,
      mediaMimeType: '',
      videoBlob: null,
      videoUrl: null,
      videoRecordingSupported: null,
      videoError: null,
      repVideoRanges: {},
      backendSessionId: makeBackendSessionId(),
      backendStatus: 'idle',
      backendResponse: null,
      backendError: null,
      backendUploadPromise: null,
      analysisSource: null,
      mediaStopPerf: null,
      mediaFinalizePromise: null,
      mediaFinalizeResolve: null

    };
     SquatDetector.reset();
     RepCapture.reset();
     window.__formaLastSquatAnalysis = null;
     window.__formaSquatAnalyses = [];
     window.__formaHudHidden = false;
     window.__formaBackendResponse = null;
     setBackendBadge('SERVER · ждёт видео', 'idle');
     const repCountEl = document.getElementById('repCount');

if (repCountEl) {
  repCountEl.textContent = '0';
}


    const canvas =
      document.getElementById(
        'reccanvas'
      );


    function resize(){

      canvas.width =
        canvas.clientWidth;

      canvas.height =
        canvas.clientHeight;

    }


    resize();

    window.addEventListener(
      'resize',
      resize
    );


    // Record the real camera feed for this whole approach.
    // Live MediaPipe remains only the preview / temporary analysis layer.
    startApproachVideoRecording(
      streamRegistry.rec
    );


    recState.raf =
      requestAnimationFrame(
        recordLoop
      );


    recState.timerInt =
      setInterval(
        () => {

          const s =
            Math.floor(
              (Date.now() -
                recState.startTime) /
              1000
            );

          document.getElementById(
            'recTimer'
          ).textContent =

            String(
              Math.floor(s / 60)
            ).padStart(2,'0')

            +

            ':'

            +

            String(
              s % 60
            ).padStart(2,'0');

        },
        250
      );


  }catch(error){

    console.error(
      'FORMA Pose Error:',
      error
    );

    alert(
      'Не удалось запустить распознавание позы.\n\n' +
      error.message
    );

  }

}


const LOOP_FPS_CAP = 30;


function recordLoop(){

  if(
    !recState ||
    recState.finished
  ){
    return;
  }


  const canvas =
    document.getElementById(
      'reccanvas'
    );

  const ctx =
    canvas.getContext('2d');


  ctx.clearRect(
    0,
    0,
    canvas.width,
    canvas.height
  );


  const video =
    document.getElementById(
      'recvideo'
    );


  // Get provider-specific pose (MediaPipe for the current live preview).
  const providerFrame =
    PoseEstimationService
      .estimateFrame(video);


  if(providerFrame){

    const poseTimestamp = performance.now();

    // Convert provider output into the provider-neutral FORMA Pose Format.
    // All future strong models will enter the app through this same shape.
    const formaPoseFrame = FormaPose.fromMediaPipeFrame(
      providerFrame,
      {
        timestampMs: poseTimestamp,
        width: video.videoWidth,
        height: video.videoHeight,
        mirrored: true
      }
    );

    // Current live detector / renderer still use their historical shape.
    // This compatibility conversion should be numerically identical to the
    // old MediaPipe frame, so v0.20 must not change visible behaviour.
    const frame = FormaPose.toLegacy(formaPoseFrame);

    window.__formaPoseFrame = formaPoseFrame;
    window.__formaVideoWidth = video.videoWidth;
   window.__formaVideoHeight = video.videoHeight;

SkeletonRenderer.drawUser (
ctx,
canvas.width, 
canvas.height,
frame.keypoints,
{},
frame.visibility
);
     // ============================================================
// REAL SQUAT REP DETECTION
// ============================================================

const squatResult = SquatDetector.update(
  frame.keypoints,
  frame.visibility
);

window.__formaSquatResult = squatResult;
     const captureResult = RepCapture.update(
  squatResult,
  frame.keypoints,
  frame.visibility,
  poseTimestamp,
  formaPoseFrame
);

window.__formaCaptureResult = captureResult;
     if (captureResult.newRep) {

  const squatAnalysis =
    SquatAnalysisService.analyze(
      captureResult.newRep
    );

  window.__formaLastSquatAnalysis =
    squatAnalysis;

  window.__formaSquatAnalyses =
    window.__formaSquatAnalyses || [];

  window.__formaSquatAnalyses.push(
    squatAnalysis
  );
}
     // Update visible rep counter.
const repCountEl = document.getElementById('repCount');

if (repCountEl) {
  repCountEl.textContent = squatResult.reps;
}
     // ============================================================
// SQUAT DEBUG HUD
// Temporary live information for testing on iPhone.
// ============================================================

let squatHud = document.getElementById('forma-squat-hud');

if (!squatHud) {
  squatHud = document.createElement('div');
  squatHud.id = 'forma-squat-hud';

  squatHud.style.cssText = `
    position: fixed;
    top: 70px;
    left: 16px;
    z-index: 99999;

    background: rgba(0, 0, 0, 0.82);
    color: white;

    padding: 12px 14px;
    border-radius: 12px;

    font-family: monospace;
    font-size: 14px;
    line-height: 1.6;

    pointer-events: none;
  `;

  document.body.appendChild(squatHud);
}

let squatHudToggle = document.getElementById('forma-squat-hud-toggle');

if (!squatHudToggle) {
  squatHudToggle = document.createElement('button');
  squatHudToggle.id = 'forma-squat-hud-toggle';

  squatHudToggle.style.cssText = `
    position: fixed;
    top: 70px;
    right: 14px;
    z-index: 100000;

    border: 1px solid rgba(255,255,255,0.14);
    background: rgba(0,0,0,0.64);
    color: rgba(255,255,255,0.82);

    padding: 7px 10px;
    border-radius: 10px;

    font: 600 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
    letter-spacing: 0.06em;
  `;

  squatHudToggle.addEventListener('click', () => {
    window.__formaHudHidden = !window.__formaHudHidden;

    const hud = document.getElementById('forma-squat-hud');
    if (hud) {
      hud.style.display = window.__formaHudHidden ? 'none' : 'block';
    }

    squatHudToggle.textContent = window.__formaHudHidden ? 'HUD +' : 'HUD −';
  });

  document.body.appendChild(squatHudToggle);
}

squatHud.style.display = window.__formaHudHidden ? 'none' : 'block';
squatHudToggle.textContent = window.__formaHudHidden ? 'HUD +' : 'HUD −';

const kneeText =
  Number.isFinite(squatResult.kneeAngle)
    ? `${Math.round(squatResult.kneeAngle)}°`
    : '—';

const capturedCount =
  captureResult.completedReps.length;

const lastRep =
  capturedCount > 0
    ? captureResult.completedReps[capturedCount - 1]
    : null;

     const lastRepTime =
  lastRep && Number.isFinite(lastRep.durationMs)
    ? (lastRep.durationMs / 1000).toFixed(2) + 's'
    : '—';

const lastRepMinKnee =
  lastRep && Number.isFinite(lastRep.minKneeAngle)
    ? Math.round(lastRep.minKneeAngle) + '°'
    : '—';

const lastRepFrames =
  lastRep
    ? lastRep.frameCount
    : '—';


// ============================================================
// SQUAT DEPTH DEBUG
// ============================================================

const depthAnalysis =
  window.__formaLastSquatAnalysis?.depth;

const lastAnalysis =
  window.__formaLastSquatAnalysis;

const depthText =
  depthAnalysis &&
  Number.isFinite(depthAnalysis.depthValue)
    ? depthAnalysis.depthValue.toFixed(3)
    : '—';

const descentText =
  Number.isFinite(lastAnalysis?.tempo?.descentMs)
    ? (lastAnalysis.tempo.descentMs / 1000).toFixed(2) + 's'
    : '—';

const ascentText =
  Number.isFinite(lastAnalysis?.tempo?.ascentMs)
    ? (lastAnalysis.tempo.ascentMs / 1000).toFixed(2) + 's'
    : '—';

const asymmetryText =
  Number.isFinite(lastAnalysis?.symmetry?.kneeAngleDifference)
    ? lastAnalysis.symmetry.kneeAngleDifference.toFixed(1) + '°'
    : '—';

const torsoText =
  Number.isFinite(lastAnalysis?.torso?.bottomLeanDegrees)
    ? lastAnalysis.torso.bottomLeanDegrees.toFixed(1) + '°'
    : '—';

const torsoRangeText =
  Number.isFinite(lastAnalysis?.torso?.rangeDegrees)
    ? lastAnalysis.torso.rangeDegrees.toFixed(1) + '°'
    : '—';

const confidenceText =
  Number.isFinite(lastAnalysis?.dataQuality?.confidence)
    ? Math.round(lastAnalysis.dataQuality.confidence * 100) + '%'
    : '—';


squatHud.innerHTML = `
  <b>FORMA SQUAT</b><br>

  REPS: ${squatResult.reps}<br>
  CAPTURED: ${capturedCount}<br>

  STATE: ${squatResult.state}<br>
  KNEE: ${kneeText}<br>

  <br>

  <b>LAST REP</b><br>
  TIME: ${lastRepTime}<br>
  DOWN / UP: ${descentText} / ${ascentText}<br>
  MIN KNEE: ${lastRepMinKnee}<br>
  DEPTH: ${depthText}<br>
  L/R DIFF: ${asymmetryText}<br>
  TORSO: ${torsoText}<br>
  TORSO RANGE: ${torsoRangeText}<br>
  CONF: ${confidenceText}<br>
  FRAMES: ${lastRepFrames}
`;


    // Store real points.
    // Rep detection will be connected later.

    if(!recState.repFrames[0]){
      recState.repFrames[0] = [];
    }


    recState.repFrames[0].push({
       keypoints:
          frame.keypoints,
       
       visibility:
          frame.visibility
       
    });

  }


  recState.raf =
    requestAnimationFrame(
      recordLoop
    );
}


function captureSnapshotDataUrl(){

  try{

    const rc =
      document.getElementById(
        'reccanvas'
      );

    const rv =
      document.getElementById(
        'recvideo'
      );

    const out =
      document.createElement(
        'canvas'
      );

    out.width = 300;
    out.height = 400;

    const ctx =
      out.getContext('2d');

    ctx.fillStyle = '#000';

    ctx.fillRect(
      0,
      0,
      300,
      400
    );


    if(rv.videoWidth){

      ctx.save();

      ctx.translate(
        300,
        0
      );

      ctx.scale(
        -1,
        1
      );

      ctx.drawImage(
        rv,
        0,
        0,
        300,
        400
      );

      ctx.restore();

    }


    ctx.drawImage(
      rc,
      0,
      0,
      300,
      400
    );


    return out.toDataURL(
      'image/jpeg',
      0.7
    );

  }catch(e){

    return null;

  }

}


async function stopRecording(){

  if(recState?.stopping){
    return;
  }

  if(recState){
    recState.stopping = true;
  }

  // Switch immediately so the user never stares at a frozen camera while
  // Safari finalizes the MediaRecorder file. The recording is still finalized
  // below before we build the result screen.
  go('s-analyzing');

  // Debug HUD is useful only while recording.
  // Remove it before the analysis/results screens so it cannot cover text.
  const squatHud =
    document.getElementById('forma-squat-hud');

  if (squatHud) {
    squatHud.remove();
  }

  const squatHudToggle =
    document.getElementById('forma-squat-hud-toggle');

  if (squatHudToggle) {
    squatHudToggle.remove();
  }

  if(recState){

    cancelAnimationFrame(
      recState.raf
    );

    clearInterval(
      recState.timerInt
    );

    recState.finished = true;

  }

  // Finalize the source video before the camera track is stopped.
  await stopApproachVideoRecording();

  if(recState){
    recState.mediaStopPerf = performance.now();

    // V0.22: start server analysis now. runAnalysisPipeline() will await
    // this promise and prefer RTMW when it succeeds; local MediaPipe data
    // has already been captured and remains the fallback.
    recState.backendUploadPromise = uploadCurrentApproachToBackend();
  }

  stopCameraStream(
    streamRegistry.rec
  );

  runAnalysisPipeline();
}


// ================= ANALYSIS PIPELINE =================

function runGenericAnalysisPipeline(){

  const steps = [
    'Video Input → Pose Detection…',
    'Body Tracking → Rep Detection…',
    'Biomechanical Analysis…',
    'Персонализация под твою антропометрию…',
    'Расчёт технического балла…',
    'Формирование рекомендаций…'
  ];

  let i = 0;

  const el =
    document.getElementById(
      'analyzingStep'
    );

  const timer =
    setInterval(
      () => {

        el.textContent = steps[i];
        i++;

        if(i >= steps.length){

          clearInterval(timer);

          AnalysisAPI
            .analyzeVideo({

              exerciseId:
                currentExercise.id,

              repRecords:
                recState.reps,

              repFrames:
                recState.repFrames

            })

            .then(
              result => {

                HISTORY[result.exercise] =
                  HISTORY[result.exercise] ||
                  [];

                HISTORY[result.exercise].push({

                  date:
                    result.meta.generated_at,

                  score:
                    result.score,

                  fullResult:
                    result

                });

                HistoryStore.save(
                  HISTORY
                );

                renderResults(
                  result
                );

                go('s-results');

              }
            );

        }

      },
      360
    );
}


async function runAnalysisPipeline(){

  const isRealSquat =
    currentExercise &&
    currentExercise.id === 'squat';

  if(!isRealSquat){
    runGenericAnalysisPipeline();
    return;
  }

  const el =
    document.getElementById(
      'analyzingStep'
    );

  const steps = [
    'Сохраняю локальный анализ как резервный…',
    'Отправляю видео на сильный анализ…',
    'RTMW отслеживает тело по всему подходу…',
    'Собираю повторения по сильным точкам…',
    'Анализирую глубину и траекторию коленей…',
    'Проверяю корпус и темп…'
  ];

  let stepIndex = 0;

  if(el){
    el.textContent = steps[0];
  }

  const stepTimer =
    setInterval(
      () => {
        stepIndex = (stepIndex + 1) % steps.length;
        if(el){
          el.textContent = steps[stepIndex];
        }
      },
      1100
    );

  // Snapshot the already-working local result BEFORE StrongPoseAnalysis
  // resets/replays SquatDetector + RepCapture.
  const localReps =
    RepCapture.getCompletedReps();

  const localSquatSet =
    SquatAnalysisService.analyzeSet(
      localReps
    );

  localSquatSet.analysisSource = 'mediapipe';
  localSquatSet.analysisSourceLabel = 'MediaPipe fallback';

  const localVideoRanges =
    buildRepVideoRanges(
      localReps
    );

  let chosenSquatSet =
    localSquatSet;

  let chosenVideoRanges =
    localVideoRanges;

  try{

    const backendResponse =
      recState?.backendUploadPromise
        ? await recState.backendUploadPromise
        : null;

    if(
      backendResponse &&
      typeof StrongPoseAnalysis !== 'undefined' &&
      StrongPoseAnalysis.canAnalyze(backendResponse)
    ){

      const strongResult =
        StrongPoseAnalysis.analyzeSquat(
          backendResponse
        );

      window.__formaStrongAnalysis =
        strongResult;

      if(
        strongResult?.ok &&
        strongResult?.squatSet?.repCount > 0
      ){
        chosenSquatSet =
          strongResult.squatSet;

        chosenVideoRanges =
          strongResult.repVideoRanges;

        if(recState){
          recState.analysisSource = 'rtmw';
        }

      }else{

        console.warn(
          'FORMA: RTMW frames received but strong squat replay produced no completed reps. Using MediaPipe fallback.',
          strongResult
        );

        if(recState){
          recState.analysisSource = 'mediapipe';
        }

      }

    }else{

      if(recState){
        recState.analysisSource = 'mediapipe';
      }

    }

  }catch(error){

    console.warn(
      'FORMA: strong analysis failed, using MediaPipe fallback:',
      error
    );

    if(recState){
      recState.analysisSource = 'mediapipe';
      recState.backendError =
        recState.backendError ||
        error?.message ||
        String(error);
    }

  }finally{

    clearInterval(
      stepTimer
    );

  }

  if(recState){
    recState.repVideoRanges =
      chosenVideoRanges;
  }

  if(el){
    el.textContent =
      chosenSquatSet?.analysisSource === 'rtmw'
        ? 'Готово · сильный анализ RTMW'
        : 'Готово · локальный резервный анализ';
  }

  renderRealSquatResults(
    chosenSquatSet
  );

  go('s-results');
}


// ================= REAL SQUAT RESULTS =================

function formatNumber(value, digits = 1){
  return Number.isFinite(value)
    ? value.toFixed(digits)
    : '—';
}


function formatSeconds(ms){
  return Number.isFinite(ms)
    ? (ms / 1000).toFixed(2) + ' c'
    : '—';
}


function formatPercent01(value){
  return Number.isFinite(value)
    ? Math.round(value * 100) + '%'
    : '—';
}


function kneeTrackingView(kneeTracking){
  if(!kneeTracking || !kneeTracking.available){
    return {
      text: '—',
      short: 'Колени: нет данных',
      color: 'var(--text-dim)'
    };
  }

  if(kneeTracking.status === 'stable'){
    return {
      text: 'Стабильно',
      short: '✓ Колени стабильно',
      color: 'var(--good)'
    };
  }

  return {
    text: kneeTracking.side === 'both'
      ? 'Оба внутрь'
      : (kneeTracking.side === 'left' ? 'Левое внутрь' : 'Правое внутрь'),
    short: '⚠ ' + (kneeTracking.label || 'Колено уходит внутрь'),
    color: 'var(--warn)'
  };
}


function realSquatMetricRow(label, value, note = ''){
  return `
    <div class="checklist-item">
      <div class="dot">•</div>
      <div>
        <b>${label}</b>
        <span>${value}${note ? ' · ' + note : ''}</span>
      </div>
    </div>
  `;
}


function realSquatInfoCard(title, body){
  return `
    <div class="card" style="margin-bottom:10px;">
      <div style="font-size:14px; font-weight:700; margin-bottom:6px;">
        ${title}
      </div>
      <div style="font-size:13px; color:var(--text-dim); line-height:1.55;">
        ${body}
      </div>
    </div>
  `;
}


function metricEntries(repetitions, getter){
  return repetitions
    .map(rep => ({
      index: rep.repIndex,
      value: getter(rep)
    }))
    .filter(item => Number.isFinite(item.value));
}


function minEntry(entries){
  if(!entries.length) return null;
  return entries.reduce(
    (best, item) => item.value < best.value ? item : best,
    entries[0]
  );
}


function maxEntry(entries){
  if(!entries.length) return null;
  return entries.reduce(
    (best, item) => item.value > best.value ? item : best,
    entries[0]
  );
}


function renderRealSquatResults(squatSet){

  const repetitions =
    Array.isArray(squatSet?.repetitions)
      ? squatSet.repetitions
      : [];

  const averages =
    squatSet?.averages || {};

  const insights =
    squatSet?.insights || {};

  lastResult = {
    kind: 'real_squat',
    exercise: 'squat',
    analysisSource: squatSet?.analysisSource || 'mediapipe',
    squatSet,
    reps: repetitions
  };

  const ex =
    ExerciseLibrary.get('squat');

  document.getElementById(
    'resultsTitle'
  ).textContent =
    `${ex.name} · ${repetitions.length} повт.`;

  const scoreHero =
    document.getElementById('scoreHero');

  if(scoreHero){
    // RTMW V0.24 raw score scale is not calibrated to MediaPipe visibility,
    // so do not present the current tracking ring as a comparable confidence
    // percentage yet. The biomechanical metrics still use RTMW coordinates.
    scoreHero.style.display =
      squatSet?.analysisSource === 'rtmw'
        ? 'none'
        : 'flex';
  }

  const confidence100 =
    Number.isFinite(averages.confidence)
      ? Math.round(averages.confidence * 100)
      : 0;

  const confidenceColor =
    scoreColor(confidence100);

  document.getElementById(
    'scoreNum'
  ).textContent =
    confidence100;

  document.getElementById(
    'scoreRing'
  ).style.background =
    `conic-gradient(
      ${confidenceColor}
      ${confidence100 * 3.6}deg,
      var(--surface-2) 0deg
    )`;

  const scoreLabel =
    document.getElementById('scoreLabel');

  scoreLabel.textContent =
    'Трекинг';

  scoreLabel.style.background =
    'var(--surface-2)';

  scoreLabel.style.color =
    confidenceColor;

  document.getElementById(
    'metricsTitle'
  ).textContent =
    squatSet?.analysisSource === 'rtmw'
      ? 'Подход · RTMW'
      : 'Подход · MediaPipe fallback';

  document.getElementById(
    'subscoreWrap'
  ).innerHTML =
    repetitions.length
      ? [
          realSquatMetricRow(
            'Глубина',
            formatNumber(averages.depthValue, 3)
          ),
          realSquatMetricRow(
            'Темп',
            formatSeconds(averages.durationMs)
          ),
          realSquatMetricRow(
            'Колени',
            Number.isFinite(averages.kneeEvaluatedCount) && averages.kneeEvaluatedCount > 0
              ? (averages.kneeIssueCount > 0
                  ? `${averages.kneeIssueCount} из ${averages.kneeEvaluatedCount} ⚠`
                  : 'Стабильно')
              : '—'
          ),
          realSquatMetricRow(
            'Корпус',
            Number.isFinite(averages.torsoRangeDegrees)
              ? formatNumber(averages.torsoRangeDegrees, 1) + '°'
              : '—'
          )
        ].join('')
      : '<div style="font-size:13px; color:var(--text-dim);">Нет завершённых повторений.</div>';

  document.getElementById(
    'issuesTitle'
  ).textContent =
    'Главное';

  document.getElementById(
    'issuesWrap'
  ).innerHTML =
    repetitions.length
      ? realSquatInfoCard(
          'FORMA',
          insights.mainFocus ||
          insights.progression ||
          'Повторы проанализированы.'
        )
      : realSquatInfoCard(
          'Нет данных',
          'Сделай хотя бы один полный повтор.'
        );

  const strengthsTitle =
    document.getElementById('strengthsTitle');
  const strengthsWrap =
    document.getElementById('strengthsWrap');

  if(strengthsTitle) strengthsTitle.style.display = 'none';
  if(strengthsWrap) strengthsWrap.style.display = 'none';

  document.getElementById(
    'repsTitle'
  ).textContent =
    'Повторения';

  const repList =
    document.getElementById('repList');

  repList.innerHTML =
    repetitions.length
      ? repetitions.map(rep => {

          const depth =
            Number.isFinite(rep.depth?.depthValue)
              ? rep.depth.depthValue.toFixed(3)
              : '—';

          const time =
            formatSeconds(rep.tempo?.totalMs);

          const kneeView =
            kneeTrackingView(rep.kneeTracking);

          return `
            <div
              class="rep-item"
              onclick="openRepDetail(${rep.repIndex})"
            >
              <div class="idx">
                ${rep.repIndex}
              </div>

              <div style="flex:1; min-width:0;">
                <div style="font-size:12.5px; line-height:1.4; font-family:var(--font-mono);">
                  DEPTH ${depth} · ${time}
                </div>
                <div style="font-size:11.5px; color:${kneeView.color}; margin-top:3px;">
                  ${kneeView.short}
                </div>
              </div>

              <div class="sc" style="width:auto; color:var(--text-dim);">
                ›
              </div>
            </div>
          `;
        }).join('')
      : '<div class="empty-state" style="padding:30px 10px;">Нет завершённых повторений.</div>';

  const fatigueNote =
    document.getElementById('fatigueNote');

  if(fatigueNote){
    fatigueNote.textContent = '';
    fatigueNote.style.display = 'none';
  }

  const compareTitle =
    document.getElementById('compareTitle');
  const compareWrap =
    document.getElementById('compareWrap');
  const compareButton =
    document.getElementById('compareButton');

  if(compareTitle) compareTitle.style.display = 'none';
  if(compareWrap) compareWrap.style.display = 'none';
  if(compareButton) compareButton.style.display = 'none';

  const recommendationCard =
    document.getElementById('mainRecommendationCard');

  if(recommendationCard){
    recommendationCard.style.display = 'none';
  }
}

function openRealSquatRepDetail(repIndex){

  const rep =
    lastResult?.squatSet?.repetitions?.find(
      item => item.repIndex === repIndex
    );

  if(!rep) return;

  const kneeView =
    kneeTrackingView(rep.kneeTracking);

  document.getElementById(
    'repDetailTitle'
  ).textContent =
    'Повтор ' + repIndex;

  const rows = [
    realSquatMetricRow(
      'Глубина',
      formatNumber(rep.depth?.depthValue, 3)
    ),
    realSquatMetricRow(
      'Время',
      formatSeconds(rep.tempo?.totalMs)
    ),
    realSquatMetricRow(
      'Колени',
      kneeView.text
    ),
    realSquatMetricRow(
      'Корпус',
      Number.isFinite(rep.torso?.rangeDegrees)
        ? formatNumber(rep.torso.rangeDegrees, 1) + '°'
        : '—'
    )
  ].join('');

  const hasRepVideo =
    Boolean(
      recState?.videoUrl &&
      recState?.repVideoRanges?.[repIndex]
    );

  const videoBlock =
    hasRepVideo
      ? `
        <div class="rep-video-card">
          <div class="rep-video-head">
            <span>Видео повтора</span>
            <button
              class="rep-video-replay"
              type="button"
              onclick="replayCurrentRepVideo()"
            >
              Повторить
            </button>
          </div>

          <video
            id="repVideoPlayer"
            class="rep-video"
            playsinline
            webkit-playsinline
            muted
            preload="auto"
            aria-label="Видео выбранного повторения. Нажмите, чтобы поставить на паузу или продолжить."
          ></video>
        </div>
      `
      : '';

  document.getElementById(
    'repDetailBody'
  ).innerHTML = `
    ${videoBlock}

    <div class="card stack">
      ${rows}
    </div>

    <div class="quotebox" style="margin-top:16px;">
      ${rep.interpretation?.summary || 'Повтор проанализирован.'}
    </div>
  `;

  go('s-repdetail');

  if(hasRepVideo){
    setupRepVideoPlayer(repIndex);
  }
}

function resetResultsLayoutForLegacy(){

  const compareTitle = document.getElementById('compareTitle');
  const compareWrap = document.getElementById('compareWrap');
  const compareButton = document.getElementById('compareButton');
  const recommendationCard = document.getElementById('mainRecommendationCard');

  if(compareTitle) compareTitle.style.display = '';
  if(compareWrap) compareWrap.style.display = '';
  if(compareButton) compareButton.style.display = '';
  if(recommendationCard) recommendationCard.style.display = '';

  const metricsTitle = document.getElementById('metricsTitle');
  const issuesTitle = document.getElementById('issuesTitle');
  const strengthsTitle = document.getElementById('strengthsTitle');
  const repsTitle = document.getElementById('repsTitle');
  const recommendationTitle = document.getElementById('mainRecommendationTitle');

  if(strengthsTitle) strengthsTitle.style.display = '';
  const strengthsWrap = document.getElementById('strengthsWrap');
  if(strengthsWrap) strengthsWrap.style.display = '';
  const fatigueNote = document.getElementById('fatigueNote');
  if(fatigueNote) fatigueNote.style.display = '';

  if(metricsTitle) metricsTitle.textContent = 'Показатели';
  if(issuesTitle) issuesTitle.textContent = 'Обнаружено';
  if(strengthsTitle) strengthsTitle.textContent = 'Сильные стороны';
  if(repsTitle) repsTitle.textContent = 'По повторениям';
  if(compareTitle) compareTitle.textContent = 'Лучшее vs худшее повторение';
  if(recommendationTitle) recommendationTitle.textContent = 'Главная рекомендация';
}


// ================= RESULTS RENDER =================

function renderResults(result){

  resetResultsLayoutForLegacy();

  lastResult = result;

  const ex =
    ExerciseLibrary.get(
      result.exercise
    );

  document.getElementById(
    'resultsTitle'
  ).textContent =
    ex.name;

  document.getElementById(
    'scoreNum'
  ).textContent =
    result.score;


  const c =
    scoreColor(
      result.score
    );


  document.getElementById(
    'scoreRing'
  ).style.background =
    `conic-gradient(
      ${c}
      ${result.score * 3.6}deg,
      var(--surface-2) 0deg
    )`;


  const lbl =
    document.getElementById(
      'scoreLabel'
    );


  lbl.textContent =
    result.score >= 80
      ? '🟢 Хорошо'
      : result.score >= 65
        ? '🟡 Есть над чем поработать'
        : '🔴 Требует внимания';


  lbl.style.background =
    result.score >= 80
      ? 'var(--good-dim)'
      : result.score >= 65
        ? 'var(--warn-dim)'
        : 'var(--bad-dim)';


  lbl.style.color = c;


  // sub-scores
  const order = [
    'amplitude',
    'stability',
    'symmetry',
    'control',
    'torso'
  ];


  const subWrap =
    document.getElementById(
      'subscoreWrap'
    );


  subWrap.innerHTML =
    order
      .filter(
        k =>
          result.sub_scores[k] !== undefined
      )
      .map(
        k => {

          const v =
            result.sub_scores[k];

          const col =
            scoreColor(v);

          return `

            <div class="subscore-row">

              <div class="lbl-line">

                <b>
                  ${BiomechanicsEngine.SUBSCORE_LABELS[k]}
                </b>

                <span style="color:${col}">
                  ${v}
                </span>

              </div>

              <div class="subscore-bar-wrap">

                <div
                  class="subscore-bar"
                  style="
                    width:${v}%;
                    background:${col};
                  "
                ></div>

              </div>

            </div>

          `;

        }
      )
      .join('');


  const issuesWrap =
    document.getElementById(
      'issuesWrap'
    );

  const strengthsWrap =
    document.getElementById(
      'strengthsWrap'
    );


  issuesWrap.innerHTML = '';
  strengthsWrap.innerHTML = '';


  const problems =
    result.errors
      .filter(
        d =>
          d.severity !== 'good'
      )
      .sort(
        (a,b) =>
          (a.severity === 'bad' ? 0 : 1) -
          (b.severity === 'bad' ? 0 : 1)
      );


  const goods =
    result.errors.filter(
      d =>
        d.severity === 'good'
    );


  if(problems.length === 0){

    issuesWrap.innerHTML = `

      <div class="issue-card good">

        <div class="issue-head">
          🟢 Существенных ошибок не найдено
        </div>

        <div class="issue-body">
          Продолжай в том же темпе
          и постепенно наращивай нагрузку.
        </div>

      </div>

    `;

  }


  problems.forEach(
    (p,idx) => {

      const icon =
        p.severity === 'bad'
          ? '🔴'
          : '🟡';

      const div =
        document.createElement(
          'div'
        );

      div.className =
        'issue-card ' +
        p.severity;

      div.innerHTML = `

        <div class="issue-head">
          ${icon} ${idx + 1}. ${p.title}
        </div>

        <div class="issue-body">

          ${p.body}

          <b>Что происходит</b>

          ${p.why}

          <b>Как исправить</b>

          ${p.fix}

        </div>

      `;

      issuesWrap.appendChild(
        div
      );

    }
  );


  strengthsWrap.innerHTML =
    goods.length

      ? goods
          .map(
            g =>
              `<div class="strength-row">
                🟢 ${g.title}
              </div>`
          )
          .join('')

      : `
        <div class="strength-row">
          🟢 Стабильное выполнение подхода
        </div>
      `;


  // reps
  const repListEl =
    document.getElementById(
      'repList'
    );


  repListEl.innerHTML =
    result.reps
      .map(
        r => {

          const barColor =
            scoreColor(
              r.score
            );

          return `

            <div
              class="rep-item"
              onclick="openRepDetail(${r.index})"
            >

              <div class="idx">
                Повтор ${r.index}
              </div>

              <div class="bar-wrap">

                <div
                  class="bar"
                  style="
                    width:${r.score}%;
                    background:${barColor};
                  "
                ></div>

              </div>

              <div
                class="sc"
                style="color:${barColor}"
              >
                ${r.score}
              </div>

            </div>

          `;

        }
      )
      .join('');


  document.getElementById(
    'fatigueNote'
  ).textContent =
    result.fatigue_note;


  const sorted =
    [...result.reps]
      .sort(
        (a,b) =>
          b.score - a.score
      );


  const best =
    sorted[0];

  const worst =
    sorted[sorted.length - 1];


  document.getElementById(
    'compareWrap'
  ).innerHTML = `

    <div class="compare-col">

      <img
        src="${best.snapshot || ''}"
      >

      <div
        class="cap"
        style="color:${getCss('--good')}"
      >
        Лучшее —
        повтор ${best.index}
        (${best.score})
      </div>

    </div>


    <div class="compare-col">

      <img
        src="${worst.snapshot || ''}"
      >

      <div
        class="cap"
        style="color:${getCss('--bad')}"
      >
        Худшее —
        повтор ${worst.index}
        (${worst.score})
      </div>

    </div>

  `;


  document.getElementById(
    'mainRecommendation'
  ).textContent =
    result.recommendations[0] ||
    'Постепенно увеличивай рабочий вес — техника уже стабильна.';
}


function openRepDetail(repIndex){

  if(lastResult?.kind === 'real_squat'){
    openRealSquatRepDetail(repIndex);
    return;
  }

  const rep =
    lastResult.reps.find(
      r =>
        r.index === repIndex
    );

  const ex =
    ExerciseLibrary.get(
      lastResult.exercise
    );


  document.getElementById(
    'repDetailTitle'
  ).textContent =
    'Повторение ' +
    rep.index;


  const c =
    scoreColor(
      rep.score
    );


  let issuesHtml =
    rep.issues.length
      ? ''
      : '<div class="strength-row">🟢 Без замечаний</div>';


  rep.issues.forEach(
    k => {

      const def =
        ruleByKey(
          ex,
          k
        );

      if(!def) return;

      const icon =
        def.severity === 'bad'
          ? '🔴'
          : '🟡';


      issuesHtml += `

        <div
          class="issue-card ${def.severity}"
        >

          <div class="issue-head">
            ${icon} ${def.title}
          </div>

          <div class="issue-body">

            ${def.body}

            <b>Как исправить</b>

            ${def.fix}

          </div>

        </div>

      `;

    }
  );


  document.getElementById(
    'repDetailBody'
  ).innerHTML = `

    <div class="score-hero">

      <div
        class="score-ring"
        style="
          background:
          conic-gradient(
            ${c}
            ${rep.score * 3.6}deg,
            var(--surface-2) 0deg
          )
        "
      >

        <div class="num">
          ${rep.score}
        </div>

        <div class="den">
          / 100
        </div>

      </div>

    </div>


    ${
      rep.snapshot
        ? `
          <img
            src="${rep.snapshot}"
            style="
              width:100%;
              border-radius:16px;
              border:1px solid var(--border);
              margin-bottom:16px;
            "
          >
        `
        : ''
    }


    ${issuesHtml}

  `;


  go('s-repdetail');
}


// ================= OPTIMAL TECHNIQUE / COMPARE =================

function openCompareScreen(){

  const worst =
    lastResult.trajectory.worst;

  const frames =
    worst.frames &&
    worst.frames.length
      ? worst.frames
      : [];


  document.getElementById(
    'compareRepTag'
  ).textContent =
    `Худшее повторение · ${
      worst.index
    }/${lastResult.reps.length}`;


  go('s-compare');


  const canvas =
    document.getElementById(
      'compareCanvas'
    );


  function resize(){

    canvas.width =
      canvas.clientWidth;

    canvas.height =
      canvas.clientHeight;

  }


  resize();


  if(compareState){
    compareState.playing = false;
  }


  compareState = {

    frames,

    i: 0,

    mode: 'mine',

    playing: true

  };


  document
    .querySelectorAll(
      '#s-compare .mode-btn'
    )
    .forEach(
      b =>
        b.classList.toggle(
          'active',
          b.dataset.mode === 'mine'
        )
    );


  renderCompareLegend(
    'mine'
  );


  requestAnimationFrame(
    compareLoop
  );
}


function setCompareMode(mode){

  if(!compareState){
    return;
  }

  compareState.mode =
    mode;

  document
    .querySelectorAll(
      '#s-compare .mode-btn'
    )
    .forEach(
      b =>
        b.classList.toggle(
          'active',
          b.dataset.mode === mode
        )
    );


  renderCompareLegend(
    mode
  );
}


function renderCompareLegend(mode){

  const el =
    document.getElementById(
      'compareLegend'
    );


  if(mode === 'mine'){

    el.innerHTML = `

      <span>
        <span
          class="legend-dot"
          style="background:${getCss('--good')}"
        ></span>
        верно
      </span>

      <span>
        <span
          class="legend-dot"
          style="background:${getCss('--warn')}"
        ></span>
        допустимо
      </span>

      <span>
        <span
          class="legend-dot"
          style="background:${getCss('--bad')}"
        ></span>
        ошибка
      </span>

    `;

  }else if(mode === 'optimal'){

    el.innerHTML = `

      <span>
        <span
          class="legend-dot"
          style="background:${getCss('--optimal')}"
        ></span>

        рекомендуемая траектория
      </span>

    `;

  }else{

    el.innerHTML = `

      <span>

        <span
          class="legend-dot"
          style="background:${getCss('--bad')}"
        ></span>

        твоя ошибка

      </span>

      <span>

        <span
          class="legend-dot"
          style="background:${getCss('--optimal')}"
        ></span>

        оптимальная траектория

      </span>

    `;

  }
}


function compareLoop(ts){

  if(
    !compareState ||
    !compareState.playing ||
    currentScreen !== 's-compare'
  ){
    return;
  }


  requestAnimationFrame(
    compareLoop
  );


  if(pageHidden){
    return;
  }


  if(
    compareState.lastTs === undefined
  ){
    compareState.lastTs = ts;
  }


  if(
    ts - compareState.lastTs <
    1000 / LOOP_FPS_CAP
  ){
    return;
  }


  compareState.lastTs =
    ts;


  const canvas =
    document.getElementById(
      'compareCanvas'
    );

  const ctx =
    canvas.getContext('2d');


  ctx.clearRect(
    0,
    0,
    canvas.width,
    canvas.height
  );


  const frames =
    compareState.frames;


  if(frames.length === 0){

    ctx.fillStyle =
      getCss('--text-faint');

    ctx.font =
      '13px sans-serif';

    ctx.textAlign =
      'center';

    ctx.fillText(
      'Нет данных траектории для этого повторения',
      canvas.width / 2,
      canvas.height / 2
    );

  }else{

    const f =
      frames[
        compareState.i %
        frames.length
      ];

    const exId =
      lastResult.exercise;


    if(
      compareState.mode === 'mine' ||
      compareState.mode === 'compare'
    ){

      SkeletonRenderer.drawUser(
        ctx,
        canvas.width,
        canvas.height,
        f.keypoints,
        f.segColors
      );

    }


    if(
      compareState.mode === 'optimal' ||
      compareState.mode === 'compare'
    ){

      const idealPose =
        PoseEstimationService
          .idealKeypointsAt(
            exId,
            f.cyclePos
          );

      SkeletonRenderer.drawOptimal(
        ctx,
        canvas.width,
        canvas.height,
        idealPose
      );

    }


    compareState.i++;

  }

}


// ================= HISTORY TAB =================

function renderHistoryTab(){

  const body =
    document.getElementById(
      'historyTabBody'
    );

  body.innerHTML = '';


  const exIds =
    ExerciseLibrary
      .all()
      .map(
        e => e.id
      )
      .filter(
        id =>
          HISTORY[id] &&
          HISTORY[id].length
      );


  if(exIds.length === 0){

    body.innerHTML = `

      <div
        class="empty-state"
        style="padding-top:80px;"
      >

        <div style="font-size:32px;">
          📈
        </div>

        <div>
          История появится после
          первого анализа.
        </div>

      </div>

    `;

    return;
  }


  exIds.forEach(
    exId => {

      const ex =
        ExerciseLibrary.get(
          exId
        );

      const arr =
        HISTORY[exId];


      const card =
        document.createElement(
          'div'
        );

      card.className =
        'card';

      card.style.marginBottom =
        '14px';


      const rows =
        arr
          .map(
            a =>
              `
              <div class="trend-row">

                <span class="d">
                  ${
                    new Date(
                      a.date
                    ).toLocaleDateString(
                      'ru-RU',
                      {
                        day:'2-digit',
                        month:'2-digit'
                      }
                    )
                  }
                </span>

                <span
                  style="
                    color:${scoreColor(a.score)};
                    font-family:var(--font-mono);
                    font-weight:700;
                  "
                >
                  ${a.score}/100
                </span>

              </div>
              `
          )
          .join('');


      card.innerHTML = `

        <div
          style="
            font-weight:700;
            font-size:15px;
            margin-bottom:6px;
          "
        >
          ${ex.name}
        </div>

        <canvas
          class="sparkline"
          width="340"
          height="60"
          id="spark-${exId}"
        ></canvas>

        ${rows}

      `;


      body.appendChild(
        card
      );


      setTimeout(
        () =>
          drawSparkline(
            'spark-' + exId,
            arr.map(
              a => a.score
            )
          ),
        0
      );

    }
  );
}


function drawSparkline(
  id,
  values
){

  const canvas =
    document.getElementById(
      id
    );

  if(!canvas){
    return;
  }


  const ctx =
    canvas.getContext(
      '2d'
    );

  const w =
    canvas.width;

  const h =
    canvas.height;


  ctx.clearRect(
    0,
    0,
    w,
    h
  );


  const min =
    Math.min(...values) - 5;

  const max =
    Math.max(...values) + 5;


  ctx.beginPath();


  values.forEach(
    (v,i) => {

      const x =
        (i /
          (values.length - 1 || 1)
        ) *
        (w - 10) +
        5;

      const y =
        h -
        ((v - min) /
          (max - min)
        ) *
        (h - 10) -
        5;


      if(i === 0){
        ctx.moveTo(x,y);
      }else{
        ctx.lineTo(x,y);
      }

    }
  );


  ctx.strokeStyle =
    getCss('--brand');

  ctx.lineWidth = 2.5;

  ctx.lineCap =
    'round';

  ctx.lineJoin =
    'round';

  ctx.stroke();


  values.forEach(
    (v,i) => {

      const x =
        (i /
          (values.length - 1 || 1)
        ) *
        (w - 10) +
        5;

      const y =
        h -
        ((v - min) /
          (max - min)
        ) *
        (h - 10) -
        5;


      ctx.fillStyle =
        getCss('--brand');

      ctx.beginPath();

      ctx.arc(
        x,
        y,
        3,
        0,
        Math.PI * 2
      );

      ctx.fill();

    }
  );

}


// ================= PROFILE =================

function renderProfile(){

  if(!PROFILE){
    return;
  }


  document.getElementById(
    'profileThumb'
  ).src =
    PROFILE.photo || '';


  document.getElementById(
    'profileHeight'
  ).textContent =
    PROFILE.heightCm +
    ' см';


  const a =
    PROFILE.anthro || {};


  document.getElementById(
    'profileAnthro'
  ).innerHTML = `

    <div class="checklist-item">

      <div class="dot">
        🦵
      </div>

      <div>

        <b>
          Длина ног
        </b>

        <span>
          ${a.legLen || '—'} см
        </span>

      </div>

    </div>


    <div class="checklist-item">

      <div class="dot">
        🧍
      </div>

      <div>

        <b>
          Длина корпуса
        </b>

        <span>
          ${a.torsoLen || '—'} см
        </span>

      </div>

    </div>


    <div class="checklist-item">

      <div class="dot">
        💪
      </div>

      <div>

        <b>
          Длина рук
        </b>

        <span>
          ${a.armLen || '—'} см
        </span>

      </div>

    </div>


    <div class="checklist-item">

      <div class="dot">
        ↔️
      </div>

      <div>

        <b>
          Стойка
        </b>

        <span>
          ${a.asymNote || '—'}
        </span>

      </div>

    </div>

  `;
}


async function resetApp(){

  await ProfileStore.clear();

  await HistoryStore.clear();

  PROFILE = null;

  HISTORY = {};

  location.reload();
}
