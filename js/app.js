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
  if(id !== 's-record'){
    stopCameraStream(streamRegistry.rec);
  }

  if(id !== 's-compare' && compareState){
    compareState.playing = false;
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


    recState = {

      startTime: Date.now(),

      reps: [],

      repFrames: {},

      repIndex: 0,

      t: 0,

      finished: false

    };
     SquatDetector.reset();
     RepCapture.reset();
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


  // Get real skeleton.
  const frame =
    PoseEstimationService
      .estimateFrame(video);


  if(frame){

    window.__formaVideoWidth = video.videoWidth;
   window.__formaVideoHeight = video.videoHeight;

SkeletonRenderer.drawUser (
ctx,
canvas.width, 
canvas.height,
frame. keypoints,
{}
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
  performance.now()
);

window.__formaCaptureResult = captureResult;
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

const kneeText =
  Number.isFinite(squatResult.kneeAngle)
    ? `${Math.round(squatResult.kneeAngle)}°`
    : '—';

squatHud.innerHTML = `
  <b>FORMA SQUAT</b><br>
  REPS: ${squatResult.reps}<br>
  STATE: ${squatResult.state}<br>
  KNEE: ${kneeText}
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


function stopRecording(){

  if(recState){

    cancelAnimationFrame(
      recState.raf
    );

    clearInterval(
      recState.timerInt
    );

    recState.finished = true;

  }

  stopCameraStream(
    streamRegistry.rec
  );

  go('s-analyzing');

  runAnalysisPipeline();
}


// ================= ANALYSIS PIPELINE =================

function runAnalysisPipeline(){

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

        el.textContent =
          steps[i];

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
      460
    );

}


// ================= RESULTS RENDER =================

function renderResults(result){

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
