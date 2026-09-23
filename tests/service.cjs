const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const code = fs.readFileSync(path.join(__dirname, '../js/pose-service.js'), 'utf8');
async function run(mode) {
  let detects = 0, bitmapClosed = 0, terminated = 0, failureUsed = false;
  const result = {landmarks:[Array.from({length:33}, () => ({x:.2,y:.3,visibility:1}))]};
  class MockWorker {
    postMessage(msg) {
      setTimeout(() => {
        if (msg.type === 'init') this.onmessage({data:{id:msg.id,backend:'worker/CPU'}});
        else {
          detects++;
          if (mode === 'failure' && !failureUsed) {
            failureUsed = true; this.onmessage({data:{id:msg.id,error:'test worker failure'}});
          } else this.onmessage({data:{id:msg.id,result,inferenceMs:20}});
        }
      }, 1);
    }
    terminate() { terminated++; }
  }
  const vision = { FilesetResolver:{forVisionTasks:async()=>({})},
    PoseLandmarker:{createFromOptions:async()=>({ detectForVideo() {detects++;return result;} })} };
  const context = vm.createContext({ console, performance, URL, setTimeout, clearTimeout,
    Worker: MockWorker, window: { Worker: mode === 'main' ? undefined : MockWorker,
      OffscreenCanvas:class{}, createImageBitmap:()=>{}, vision },
    document:{baseURI:'http://localhost/'},
    createImageBitmap:async()=>({close(){bitmapClosed++;}})
  });
  const svc = vm.runInContext(code+'\nPoseEstimationService',context);
  await Promise.all([svc.init(),svc.init()]);
  const video = {readyState:2,currentTime:0};
  let frame = await svc.estimateFrame(video,0);
  if (mode === 'failure') {
    assert.equal(frame,undefined);
    assert.equal(terminated,1);
    assert.equal(svc.getStatus().backend,'main/CPU');
    frame = await svc.estimateFrame(video,.034);
    assert(svc.getStatus().fallbackReason.includes('test worker failure'));
  }
  assert.equal(frame.keypoints.head[0],.8); // front-camera mirroring unchanged
  assert.equal(frame.visibility.head,1);
  const before = detects;
  const same = mode === 'failure' ? .034 : 0;
  assert.equal(await svc.estimateFrame(video,same),undefined);
  assert.equal(detects,before);
  const p = svc.estimateFrame(video,.1);
  if (svc.getStatus().backend.startsWith('worker')) {
    assert.equal(await svc.estimateFrame(video,.12),undefined); // async single flight
  }
  await p;
  svc.reset();
  assert(await svc.estimateFrame(video,0)); // restart with reset media clock
  assert.equal(svc.getStatus().busy,false);
  if (mode !== 'main') assert(bitmapClosed > 0);
  console.log('PASS service',mode,'deduplication, one-in-flight, reset, coordinates');
}
(async()=>{for(const mode of ['worker','main','failure']) await run(mode);})()
  .catch(e=>{console.error(e);process.exitCode=1;});
