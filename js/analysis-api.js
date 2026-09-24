/* In-browser analysis of completed captures. The API seam stays asynchronous
   so a future backend can keep this result contract. */
const AnalysisAPI = (function () {
  async function analyzeVideo(session) {
    const exercise = session.exerciseId;
    const supported = exercise === 'squat';
    const captures = supported ? (session.completedReps || []) : [];
    const analyzed = SquatAnalysisService.analyzeSet(captures, session.repRecords);
    const { reps, summary } = analyzed;
    const trajectoryFor = index => {
      const capture = captures.find(r => r.index === index);
      return { index: index ?? null, frames: (capture?.frames || []).map(f => ({
        t: f.t, keypoints: f.displayPose || f.pose, visibility: f.visibility,
        displayVisibility: f.displayVisibility, segColors: {}
      })) };
    };
    const repeated = summary.recurringIssues;
    return {
      exercise, supported, score: null, sub_scores: {}, repetitions: reps.length,
      reps, summary, confidence: summary.confidence,
      errors: reps.flatMap(r => r.issues), fatigue_note: summary.note,
      recommendations: !supported ? ['Анализ этого упражнения ещё не подключён. Сейчас доступен разбор приседаний.'] :
        !reps.length ? ['Запиши полный цикл приседа: опускание и возврат наверх. Останавливаться перед началом не нужно.'] :
        repeated.length ? repeated.map(i => i.body) :
        ['Посмотри измерения каждого повтора. Для уточнения различий сторон полезен второй ракурс.'],
      trajectory: {
        best: trajectoryFor(summary.mostStableRep ?? reps[0]?.index),
        worst: trajectoryFor(summary.mostNotedRep ?? reps[0]?.index)
      },
      meta: { source: 'squat-2d-v1', generated_at: Date.now(),
        videoWidth: session.videoWidth || 0, videoHeight: session.videoHeight || 0,
        confidenceMeaning: 'Качество и полнота наблюдений, не вероятность правильной техники.',
        scoreReason: 'Общая шкала качества техники по одному 2D ракурсу не валидирована.' }
    };
  }
  return { analyzeVideo };
})();
