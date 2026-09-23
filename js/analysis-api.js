/* =====================================================================
   ANALYSIS API (mock)
   ---------------------------------------------------------------------
   The UI never reads pose/biomechanics internals directly — it only
   calls AnalysisAPI.analyzeVideo(...) and receives back a structured
   result. Today this function is served entirely in-browser from data
   already produced during the (simulated) recording pass. Later, this
   exact function signature becomes a real network call:

       POST /analyze-video
       body: { exercise_id, video_blob }
       ->  { exercise, score, repetitions, errors, sub_scores,
             joint_data, trajectory, recommendations, meta }

   MockAnalysisService (below) implements that contract now; a
   RealAnalysisService later just replaces the body of analyzeVideo()
   with an actual fetch() to a backend that runs PoseEstimation →
   RepDetector → BiomechanicsEngine server-side. Nothing that calls
   AnalysisAPI.analyzeVideo needs to change.
   ===================================================================== */

const AnalysisAPI = (function(){

  function recommendationsFor(exercise, detectedErrors){
    const problems = detectedErrors.filter(e=>e.severity!=='good');
    if(problems.length===0){
      return ['Продолжай в том же темпе и постепенно наращивай рабочий вес.'];
    }
    // primary rec = worst-severity issue's fix; secondary = next one, if any
    const sorted = [...problems].sort((a,b)=> (a.severity==='bad'?0:1) - (b.severity==='bad'?0:1));
    return sorted.slice(0,2).map(e=>e.fix).filter(Boolean);
  }

  /**
   * MockAnalysisService.analyzeVideo — simulates a POST /analyze-video call.
   * @param {Object} session - { exerciseId, repRecords, repFrames }
   *   repRecords: [{index, score, issues, snapshot}]
   *   repFrames:  { [repIndex]: [{keypoints, segColors, cyclePos}, ...] }
   * @returns {Promise<Object>} structured result, per the contract above.
   */
  function analyzeVideo(session){
    const { exerciseId, repRecords, repFrames } = session;
    const exercise = ExerciseLibrary.get(exerciseId);

    return new Promise(resolve=>{
      // simulated network + inference latency
      setTimeout(()=>{
        const overall = Math.round(repRecords.reduce((a,r)=>a+r.score,0)/repRecords.length);
        const errors = BiomechanicsEngine.detectedErrors(exercise, repRecords);
        const sub_scores = BiomechanicsEngine.subScores(exercise, repRecords);
        const fatigue_note = BiomechanicsEngine.fatigueNote(repRecords);
        const recommendations = recommendationsFor(exercise, errors);

        const sortedByScore = [...repRecords].sort((a,b)=>b.score-a.score);
        const bestIdx = sortedByScore[0].index - 1;
        const worstIdx = sortedByScore[sortedByScore.length-1].index - 1;

        resolve({
          exercise: exerciseId,
          score: overall,
          repetitions: repRecords.length,
          errors,                 // full error_rule objects (key, severity, title, body, why, fix)
          sub_scores,             // { amplitude, stability, symmetry, control, torso }
          reps: repRecords,       // [{index, score, issues, snapshot}]
          fatigue_note,
          recommendations,
          joint_data: {},         // reserved: raw per-frame joint-angle series from a real CV model
          trajectory: {
            best:  { index: bestIdx+1,  frames: repFrames[bestIdx]  || [] },
            worst: { index: worstIdx+1, frames: repFrames[worstIdx] || [] }
          },
          meta: { source: 'mock', generated_at: Date.now() }
        });
      }, 350);
    });
  }

  return { analyzeVideo };
})();
