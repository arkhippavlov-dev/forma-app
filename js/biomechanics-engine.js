/* =====================================================================
   BIOMECHANICAL ANALYSIS ENGINE
   ---------------------------------------------------------------------
   Consumes the metrics produced by the Pose/CV layer for one rep and
   applies the exercise's `error_rules` + `scoring_rules` (see
   exercise-library.js) to produce:
     - a 0-100 score for that rep
     - which named errors were present
     - per-category sub-scores (amplitude, stability, symmetry, control,
       torso position) aggregated across a whole set

   This is intentionally rule-based/deterministic for the MVP. The seam
   for a real "AI Reasoning" layer (an LLM turning
   { elbow_angle: 42, torso_angle: 31, ... } into natural-language
   coaching, personalized to the user's Personal Biomechanical Profile)
   is `explainIssue()` below — right now it looks up a templated string
   from the exercise config; later it can call an actual model with the
   same structured input and return generated text instead.
   ===================================================================== */

const BiomechanicsEngine = (function(){

  function ruleFor(exercise, key){ return exercise.error_rules.find(r=>r.key===key); }

  // metrics: plain object of metric_name -> 0..1 severity value (higher = worse)
  function evaluateRep(exercise, metrics){
    const issues = [];
    const issueLevels = {};
    let score = 100;
    let measuredMetrics = 0;
    exercise.error_rules.forEach(rule=>{
      if(rule.severity==='good' || !rule.metric) return;
      const v = metrics[rule.metric];
      if(v === undefined) return;
      if(!Number.isFinite(v)) return;
      measuredMetrics++;
      if(v >= rule.bad){
        issues.push(rule.key);
        issueLevels[rule.key] = 'bad';
        score -= 22;
      } else if(v >= rule.warn){
        issues.push(rule.key);
        issueLevels[rule.key] = 'warn';
        score -= 10;
      }
    });
    score = measuredMetrics
      ? Math.max(35, Math.min(100, Math.round(score)))
      : null;
    return { score, issues, issueLevels, measuredMetrics };
  }

  // Aggregate only evidenced errors. A rule with no measured metric is not
  // presented as a strength; uncertainty must stay visible to the user.
  function detectedErrors(exercise, repRecords){
    const levels = {};
    repRecords.forEach(r=>r.issues.forEach(k=>{
      const level = r.issueLevels?.[k] || 'warn';
      if (!levels[k] || level === 'bad') levels[k] = level;
    }));
    return exercise.error_rules
      .filter(rule => levels[rule.key])
      .map(rule => ({ ...rule, severity: levels[rule.key] }));
  }

  const SUBSCORE_LABELS = {
    amplitude:'Амплитуда', stability:'Стабильность', symmetry:'Симметрия',
    control:'Контроль движения', torso:'Положение корпуса'
  };

  function subScores(exercise, repRecords){
    const cats = Object.keys(exercise.scoring_rules);
    const out = {};
    cats.forEach(cat=>{
      const keys = exercise.scoring_rules[cat];
      if(!keys || keys.length===0){ out[cat] = null; return; }
      const measured = repRecords.filter(rep =>
        keys.some(key => Number.isFinite(rep.metrics?.[ruleFor(exercise, key)?.metric]))
      );
      if(!measured.length){ out[cat] = null; return; }
      let penalty = 0;
      measured.forEach(rep=>{
        rep.issues.forEach(k=>{
          if(!keys.includes(k)) return;
          const rule = ruleFor(exercise,k);
          penalty += rep.issueLevels?.[k] === 'bad' ? 16 : 7;
        });
      });
      const avgPenalty = penalty / measured.length;
      out[cat] = Math.max(30, Math.min(100, Math.round(100 - avgPenalty)));
    });
    return out;
  }

  // Detects whether technique degraded in the back half of the set —
  // i.e. a fatigue signal, per spec §15.
  function fatigueNote(repRecords){
    if(repRecords.some(rep => !Number.isFinite(rep.score))){
      return 'Недостаточно измерений для оценки изменения техники в подходе.';
    }
    const half = Math.ceil(repRecords.length/2);
    const firstHalf = repRecords.slice(0, half);
    const secondHalf = repRecords.slice(half);
    const avg = arr => arr.reduce((a,b)=>a+b.score,0)/arr.length;
    if(secondHalf.length===0) return 'Недостаточно повторений для оценки динамики в подходе.';
    const drop = Math.round(avg(firstHalf) - avg(secondHalf));
    if(drop >= 8){
      const dropIdx = repRecords.findIndex(r => r.score < avg(firstHalf) - 8);
      return `Начиная примерно с повторения ${Math.max(3, dropIdx+1)}, техника начала ухудшаться — вероятная причина: накопление усталости.`;
    }
    return 'Техника оставалась стабильной на протяжении всего подхода.';
  }

  // Templated natural-language explanation for one error rule — the stand-in
  // described above for a future LLM-based "AI Reasoning" step.
  function explainIssue(rule){
    return { title: rule.title, body: rule.body, why: rule.why, fix: rule.fix };
  }

  return { evaluateRep, detectedErrors, subScores, SUBSCORE_LABELS, fatigueNote, explainIssue };
})();
