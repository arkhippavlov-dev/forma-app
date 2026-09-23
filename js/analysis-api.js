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
   * @param {Object} session - { exerciseId, capturedReps, repRecords, repFrames }
   *   repRecords: [{index, score, issues, snapshot}]
   *   repFrames:  { [repIndex]: [{keypoints, segColors, cyclePos}, ...] }
   * @returns {Promise<Object>} structured result, per the contract above.
   */
  function analyzeVideo(session){
    const { exerciseId, capturedReps = [], repRecords = [], repFrames = {} } = session;
    const exercise = ExerciseLibrary.get(exerciseId);

    return new Promise(resolve=>{
      // simulated network + inference latency
      setTimeout(()=>{
        const liveSquatRecords = exerciseId === 'squat'
          ? capturedReps.map(rep => {
              const analysis = SquatAnalysisService.analyze(rep);
              const evaluation = BiomechanicsEngine.evaluateRep(exercise, analysis.metrics);

              return {
                index: rep.index,
                score: evaluation.score,
                issues: evaluation.issues,
                issueLevels: evaluation.issueLevels,
                metrics: analysis.metrics,
                measuredMetrics: evaluation.measuredMetrics,
                analysis,
                snapshot: null,
                sourceRep: rep
              };
            })
          : repRecords;

        const scoredRecords = liveSquatRecords.filter(r => Number.isFinite(r.score));
        const overall = scoredRecords.length
          ? Math.round(scoredRecords.reduce((a,r)=>a+r.score,0)/scoredRecords.length)
          : null;
        const errors = BiomechanicsEngine.detectedErrors(exercise, liveSquatRecords);
        const sub_scores = BiomechanicsEngine.subScores(exercise, liveSquatRecords);
        const fatigue_note = liveSquatRecords.length
          ? BiomechanicsEngine.fatigueNote(liveSquatRecords)
          : 'Подход не распознан. Встань целиком в кадр и повтори запись.';
        const hasUnavailableDepth = liveSquatRecords.some(rep =>
          rep.analysis?.depthResult?.available === false
        );
        const recommendations = hasUnavailableDepth
          ? ['Глубину пока не оцениваем: в нижней точке должны быть видны таз, колени и стопы. Остальные доступные данные сохранены.']
          : exerciseId === 'squat' && errors.length === 0
            ? ['По глубине замечаний нет. Остальные параметры техники пока не оцениваются.']
            : recommendationsFor(exercise, errors);

        const sortedByScore = [...liveSquatRecords].sort((a,b)=>
          (Number.isFinite(b.score) ? b.score : -Infinity) -
          (Number.isFinite(a.score) ? a.score : -Infinity)
        );
        const best = sortedByScore[0] || null;
        const worst = sortedByScore[sortedByScore.length-1] || null;
        const toTrajectoryFrames = rep => (rep?.sourceRep?.frames || [])
          .map((frame, index, frames) => ({
            keypoints: frame.pose,
            segColors: {},
            cyclePos: frames.length > 1 ? index / (frames.length - 1) : 0
          }));

        resolve({
          exercise: exerciseId,
          score: overall,
          repetitions: liveSquatRecords.length,
          scored_repetitions: scoredRecords.length,
          availability: {
            depth: liveSquatRecords.filter(rep => rep.analysis?.depthResult?.available).length,
            hasUnavailableDepth
          },
          errors,                 // full error_rule objects (key, severity, title, body, why, fix)
          sub_scores,             // { amplitude, stability, symmetry, control, torso }
          reps: liveSquatRecords, // live records for squat; legacy format elsewhere
          fatigue_note,
          recommendations,
          joint_data: {},         // reserved: raw per-frame joint-angle series from a real CV model
          trajectory: {
            best:  best ? { index: best.index, frames: toTrajectoryFrames(best) } : { index: null, frames: [] },
            worst: worst ? { index: worst.index, frames: toTrajectoryFrames(worst) } : { index: null, frames: [] }
          },
          meta: { source: 'live_capture', generated_at: Date.now() }
        });
      }, 350);
    });
  }

  return { analyzeVideo };
})();
