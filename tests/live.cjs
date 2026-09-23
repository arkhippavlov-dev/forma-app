const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
async function scenario(useVideoCallback) {
  let now = 0, serial = 0, inferCount = 0, rafs = new Map(), vfcs = new Map();
  const hud = {hidden:true}, body = {textContent:''}, summary = {textContent:''};
  const draws = [], measurements = [], win = {}, listeners = new Map();
  const video = {currentTime:0,readyState:2,videoWidth:720,videoHeight:960,
    srcObject:{getVideoTracks:()=>[{getSettings:()=>({frameRate:30})}]}};
  if (useVideoCallback) {
    video.requestVideoFrameCallback = f => {const id=++serial;vfcs.set(id,f);return id;};
    video.cancelVideoFrameCallback = id => vfcs.delete(id);
  }
  let resolveHeld = null, hold = false;
  const service = {
    getStatus:()=>({backend:'worker/CPU',busy:false}),
    estimateFrame: (v,media) => {
      inferCount++;
      const frame={keypoints:{head:[.4 + media * .02,.2]},visibility:{head:1},
        timestampMs:media*1000,capturedAt:now,inferenceMs:20,latencyMs:21};
      if (hold) return new Promise(r=>{resolveHeld=()=>r(frame);});
      return Promise.resolve(frame);
    }
  };
  const ctx = vm.createContext({console,performance:{now:()=>now},window:win,
    document:{hidden:false,getElementById:id=>({'forma-squat-hud':hud,'forma-stats-body':body,'forma-stats-summary':summary}[id]),
      addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n)},
    requestAnimationFrame:f=>{const id=++serial;rafs.set(id,f);return id;},
    cancelAnimationFrame:id=>rafs.delete(id),PoseEstimationService:service,
    SkeletonRenderer:{drawUser:(c,w,h,p,col,vis)=>draws.push({p,vis})}
  });
  for (const f of ['pose-stabilizer.js','pose-display.js','pose-live.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',f),'utf8'),ctx);
  }
  const live = vm.runInContext('PoseLive',ctx).start(video,{width:390,height:650,getContext:()=>({clearRect(){}})},
    (p,v,t)=>measurements.push({p,v,t}));
  const flush = async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
  for (let i=0;i<120;i++) {
    now += 1000/60;
    if (i%2===0) {
      video.currentTime=(i/2+1)/30;
      const callbacks=[...vfcs.values()];vfcs.clear();
      callbacks.forEach(f=>f(now,{mediaTime:video.currentTime,presentedFrames:i/2+1}));
    }
    const callbacks=[...rafs.values()];rafs.clear();callbacks.forEach(f=>f(now));
    await flush();
  }
  assert.equal(inferCount,60);
  assert.equal(measurements.length,60);
  assert.equal(draws.length,120);
  assert(body.textContent.includes('CAPTURED') && body.textContent.includes('FPS позы'));
  assert(Math.abs(win.__formaPerformance.renderFPS-60)<2);
  assert(Math.abs(win.__formaPerformance.poseFPS-30)<2);
  assert.equal(win.__formaPerformance.cameraMeasured,useVideoCallback);
  // Stop while an inference is still pending. It must not update the next session.
  hold=true;now+=34;video.currentTime+=.034;
  for(const f of [...vfcs.values()])f(now,{mediaTime:video.currentTime,presentedFrames:62});
  for(const f of [...rafs.values()])f(now);
  assert(resolveHeld);
  const before=measurements.length;
  live.stop();resolveHeld();await flush();
  assert.equal(measurements.length,before);
  assert.equal(hud.hidden,true);
  assert.equal(listeners.size,0);
  console.log('PASS live clocks',useVideoCallback?'rVFC':'poll fallback',
    '120 draws / 60 observations, measured rates, stale-session discard');
}
(async()=>{await scenario(true);await scenario(false);})().catch(e=>{console.error(e);process.exitCode=1;});
