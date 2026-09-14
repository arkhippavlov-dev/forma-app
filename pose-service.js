/* =====================================================================
   POSE ESTIMATION SERVICE
   ---------------------------------------------------------------------
   Computer-vision layer, per the pipeline in the brief:

     Camera Video → Pose Estimation Model → Human Skeleton →
     Movement Data → Exercise-specific Analysis → AI Reasoning → Text Feedback

   PoseEstimationService below is the INTERFACE the rest of the app talks
   to. `MockPoseEstimationService` implements it with a procedural stick-
   figure generator (no real video is analyzed yet — this is explicitly
   demo/mock data, per the current MVP stage).

   To plug in a real model later (e.g. MoveNet / BlazePose running via
   TensorFlow.js on-device, or a server-side pose model behind the
   /analyze-video API), implement a `RealPoseEstimationService` with the
   exact same method signatures and swap the export at the bottom of this
   file. Nothing in RepDetector, BiomechanicsEngine, or the UI needs to
   change — they only ever consume the {keypoints, jointAngles} shape.

   Keypoint set (normalized 0..1 image coordinates), matching the spec's
   minimum tracked points: head, neck, shoulders, elbows, wrists, hips,
   knees, ankles.
   ===================================================================== */

const PoseEstimationService = {
  /**
   * estimateFrame(exerciseId, t, repIndex) -> { keypoints, jointAngles, cyclePos }
   * Real implementation would instead take a video frame / ImageBitmap
   * and return keypoints detected by the CV model.
   */
  estimateFrame(){ throw new Error('Not implemented — use MockPoseEstimationService or a Real* implementation'); },

  /**
   * idealKeypointsAt(exerciseId, cyclePos) -> keypoints
   * Returns the "textbook" pose for a given point in the movement cycle
   * (0 = top/start, 1 = bottom/peak, back to 0). Used for the "optimal
   * technique" overlay (spec §11). A real system would derive this from
   * a biomechanical reference model personalized to the user's
   * anthropometry, rather than a fixed procedural pose.
   */
  idealKeypointsAt(){ throw new Error('Not implemented'); }
};

const MockPoseEstimationService = (function(){

  // ---- procedural stick-figure pose generators (normalized 0..1 coords) ----
  function poseSquat(depth, valgus, lean){
    const hipY = 0.42 + depth*0.22;
    const kneeY = 0.62 + depth*0.06;
    const ankleY = 0.86;
    const kneeXOffset = valgus*0.045;
    const shoulderX = 0.5 - lean*0.05;
    const hipX = 0.5;
    return {
      head:[0.5 - lean*0.08, 0.18 - depth*0.03],
      neck:[shoulderX, 0.24 - depth*0.04],
      lshoulder:[shoulderX-0.09, 0.26-depth*0.04], rshoulder:[shoulderX+0.09,0.26-depth*0.04],
      lhip:[hipX-0.07, hipY], rhip:[hipX+0.07, hipY],
      lknee:[hipX-0.09+kneeXOffset, kneeY], rknee:[hipX+0.09-kneeXOffset*0.6, kneeY],
      lankle:[hipX-0.08, ankleY], rankle:[hipX+0.08, ankleY],
      lelbow:[shoulderX-0.14,0.36], relbow:[shoulderX+0.14,0.36],
      lwrist:[shoulderX-0.16,0.46], rwrist:[shoulderX+0.16,0.46],
    };
  }
  function poseBench(press, wristOff, flare){
    const elbowY = 0.5 - press*0.14;
    const wristY = 0.42 - press*0.2;
    return {
      head:[0.28,0.5], neck:[0.36,0.5],
      lshoulder:[0.4,0.46], rshoulder:[0.4,0.54],
      lhip:[0.62,0.47], rhip:[0.62,0.53],
      lknee:[0.78,0.44], rknee:[0.78,0.56],
      lankle:[0.9,0.4], rankle:[0.9,0.6],
      lelbow:[0.42 - flare*0.05, elbowY-0.09], relbow:[0.42-flare*0.05, elbowY+0.09],
      lwrist:[0.42+wristOff*0.09, wristY-0.09], rwrist:[0.42+wristOff*0.09, wristY+0.09],
    };
  }
  function poseLatPulldown(pull, lean, elbowBack, asym){
    const elbowY = 0.42 + pull*0.22;
    const wristY = 0.2 + pull*0.14;
    return {
      head:[0.5+lean*0.06,0.18], neck:[0.5+lean*0.08,0.24],
      lshoulder:[0.5+lean*0.08-0.09,0.27], rshoulder:[0.5+lean*0.08+0.09,0.27],
      lhip:[0.5-0.07,0.55], rhip:[0.5+0.07,0.55],
      lknee:[0.5-0.09,0.72], rknee:[0.5+0.09,0.72],
      lankle:[0.5-0.08,0.9], rankle:[0.5+0.08,0.9],
      lelbow:[0.5-0.22-elbowBack*0.06, elbowY], relbow:[0.5+0.22+elbowBack*0.03, elbowY-asym*0.05],
      lwrist:[0.5-0.1, wristY], rwrist:[0.5+0.1, wristY+asym*0.06],
    };
  }

  // cycle position 0..1..0 per rep using a sine wave; injects worse form
  // after rep 3 to simulate fatigue, plus a bit of per-rep randomness.
  let _lastCyclePhase = 0;
  function estimateFrame(exerciseId, t, repIndex){
    const cycleLen = 2.6; // seconds per rep
    const localT = (t % cycleLen)/cycleLen;
    const cyclePos = (Math.sin((localT*Math.PI*2) - Math.PI/2)+1)/2;
    const completedNow = (localT < 0.02 && _lastCyclePhase > 0.9 && t>0.1);
    _lastCyclePhase = localT;

    const fatigue = Math.max(0, repIndex-2) * 0.16 + Math.random()*0.05;
    let keypoints, metrics, segColors;

    if(exerciseId==='squat'){
      const depth = cyclePos;
      const kneeValgus = Math.min(0.9, fatigue*0.9 + (repIndex%2===0? 0.15:0));
      const torsoLean = Math.min(0.8, fatigue*0.7);
      keypoints = poseSquat(depth, kneeValgus, torsoLean);
      metrics = { kneeValgus, torsoLean, depthMissed: depth>0.72 ? 0 : (0.72-depth) };
      segColors = {
        leftKnee: kneeValgus>0.55?'bad':kneeValgus>0.25?'warn':'good',
        rightKnee: kneeValgus>0.5?'warn':'good',
        spine: torsoLean>0.5?'bad':torsoLean>0.22?'warn':'good',
        hips: depth>0.72?'good':'warn',
      };
    } else if(exerciseId==='bench_press'){
      const press = cyclePos;
      const wristOff = Math.min(0.9, fatigue*0.85);
      const elbowFlare = Math.min(0.85, fatigue*0.6 + (repIndex%3===0?0.2:0));
      keypoints = poseBench(press, wristOff, elbowFlare);
      metrics = { wristOff, elbowFlare, asym: fatigue*0.3 };
      segColors = {
        leftWrist: wristOff>0.55?'bad':wristOff>0.25?'warn':'good',
        rightWrist: wristOff>0.5?'warn':'good',
        leftElbow: elbowFlare>0.5?'warn':'good',
        rightElbow: elbowFlare>0.5?'warn':'good',
      };
    } else { // lat_pulldown
      const pull = cyclePos;
      const torsoLean = Math.min(0.85, fatigue*0.75);
      const elbowBack = Math.min(0.85, fatigue*0.65 + (repIndex%2===1?0.15:0));
      const asym = Math.min(0.7, fatigue*0.4);
      keypoints = poseLatPulldown(pull, torsoLean, elbowBack, asym);
      metrics = { torsoLean, elbowBack, asym };
      segColors = {
        spine: torsoLean>0.55?'bad':torsoLean>0.25?'warn':'good',
        leftElbow: elbowBack>0.5?'warn':'good',
        rightElbow: elbowBack>0.55?'warn':'good',
        shoulders: asym>0.4?'warn':'good',
      };
    }

    return { keypoints, metrics, segColors, cyclePos, repJustCompleted: completedNow };
  }

  function idealKeypointsAt(exerciseId, cyclePos){
    if(exerciseId==='squat') return poseSquat(cyclePos, 0, 0);
    if(exerciseId==='bench_press') return poseBench(cyclePos, 0, 0);
    return poseLatPulldown(cyclePos, 0, 0, 0);
  }

  return { estimateFrame, idealKeypointsAt };
})();
