/* Small results adapter: keeps the existing screens and the main app's
   navigation, while isolating the new per-repetition metric presentation. */
const SQUAT_METRIC_LABELS = {
  depth: 'Глубина', symmetry: 'Различия сторон', control: 'Темп и контроль', torso: 'Корпус', knees: 'Траектория коленей'
};
function metricValueText(key, m){
  if (!m.available) return 'Недостаточно данных';
  const v = m.value;
  if (key === 'depth') return `${m.depthValue.toFixed(2)} ${m.unit}`;
  if (key === 'symmetry') return `Разница ROM ${v.romDifferenceDeg}° · нижняя точка ±${v.bottomTimingDeltaMs} мс`;
  if (key === 'control') return `↓ ${(v.eccentricMs / 1000).toFixed(2)} с · низ ${(v.bottomMs / 1000).toFixed(2)} с · ↑ ${(v.concentricMs / 1000).toFixed(2)} с`;
  if (key === 'torso') return `Диапазон наклона ${v.tiltExcursionDeg}°`;
  return `Смещение ${v.projectedShiftRatio.toFixed(2)} длины голени`;
}
function squatMetricCards(rep){
  return Object.entries(SQUAT_METRIC_LABELS).map(([key, title]) => {
    const m = rep[key];
    return `<div class="metric-card"><div class="metric-heading"><b>${title}</b><span>${m.available ? Math.round(m.confidence * 100) + '%' : '—'}</span></div>
      <div class="metric-value">${escapeHtml(metricValueText(key, m))}</div>
      <p>${escapeHtml(m.reason)}</p></div>`;
  }).join('');
}
function renderSquatResults(result){
  const summary = result.summary;
  document.getElementById('resultsTitle').textContent = ExerciseLibrary.get(result.exercise).name;
  document.querySelector('#s-results .score-hero').hidden = true;
  const context = document.getElementById('resultContext');
  context.hidden = false;
  context.innerHTML = `<b>${result.repetitions} завершённых повторений</b>
    <p>Надёжность данных: ${Math.round(result.confidence * 100)}%. Это показатель качества наблюдений, а не оценка техники.</p>
    ${result.supported ? '' : '<p>Анализ этого упражнения ещё не подключён.</p>'}`;
  document.getElementById('subscoreWrap').innerHTML = Object.entries(SQUAT_METRIC_LABELS).map(([key, title]) => {
    const m = summary.metrics[key];
    let value = `${m.measuredReps} из ${m.totalReps} повторов`;
    if (key === 'depth' && summary.depth) value += ` · медиана ${summary.depth.median.toFixed(2)} (${summary.depth.method === 'shin' ? 'голень' : 'корпус'})`;
    if (key === 'control' && summary.tempo) value += ` · медиана ${(summary.tempo.medianMs / 1000).toFixed(2)} с`;
    return `<div class="metric-card"><div class="metric-heading"><b>${title}</b><span>${m.available ? Math.round(m.confidence * 100) + '%' : '—'}</span></div><p>${value}</p></div>`;
  }).join('');
  const issues = summary.recurringIssues;
  const unique = [...new Map(result.errors.map(i => [i.key, i])).values()];
  document.getElementById('issuesWrap').innerHTML = unique.length ? unique.map(i => {
    const recurring = issues.find(r => r.key === i.key);
    return `<div class="issue-card warn"><div class="issue-head">${escapeHtml(i.title)}</div><div class="issue-body">${escapeHtml(i.body)}
      ${recurring ? `<b>В повторах ${recurring.reps.join(', ')}</b>` : '<b>Подробности — в отдельных повторах</b>'}</div></div>`;
  }).join('') : '<div class="metric-card"><p>На доступных измерениях заметных повторяющихся отклонений не обнаружено. Невидимые участки не оценивались.</p></div>';
  const strengths = [...new Set(result.reps.flatMap(r => r.strengths))];
  document.getElementById('strengthsWrap').innerHTML = strengths.length
    ? strengths.map(t => `<div class="strength-row">${escapeHtml(t)}</div>`).join('')
    : '<p class="metric-note">Недостаточно данных для отдельного вывода о сильных сторонах.</p>';
  document.getElementById('repList').innerHTML = result.reps.length ? result.reps.map(r => `
    <button type="button" class="rep-item rep-measured" onclick="openRepDetail(${r.index})">
      <span class="idx">Повтор ${r.index}</span><span>${(r.durationMs / 1000).toFixed(2)} с · ${r.coverage.available}/5 показателей</span>
      <span class="sc">${Math.round(r.confidence * 100)}%</span></button>`).join('')
    : '<p class="metric-note">Завершённых повторов пока нет.</p>';
  document.getElementById('fatigueNote').textContent = summary.note;
  const compare = document.getElementById('compareWrap');
  const choices = [
    { index: summary.mostStableRep, label: 'Самый стабильный по глубине и темпу' },
    { index: summary.mostNotedRep, label: 'Больше наблюдений для проверки' }
  ].filter(c => c.index != null);
  compare.innerHTML = choices.length ? choices.map(c => `<button type="button" class="metric-card compare-col" onclick="openRepDetail(${c.index})">
    <b>Повтор ${c.index}</b><p>${c.label}</p></button>`).join('')
    : '<p class="metric-note">Для сравнения пока недостаточно сопоставимых данных.</p>';
  const replay = document.getElementById('trajectoryButton');
  replay.disabled = !result.trajectory.worst.frames.length;
  replay.textContent = 'Посмотреть записанную траекторию';
  document.getElementById('mainRecommendation').textContent = result.recommendations[0];
}
function openSquatRepDetail(index){
  const rep = lastResult.reps.find(r => r.index === index);
  if (!rep) return;
  document.getElementById('repDetailTitle').textContent = `Повторение ${rep.index}`;
  document.getElementById('repDetailBody').innerHTML = `
    <div class="card result-context"><b>${(rep.durationMs / 1000).toFixed(2)} с · надёжность ${Math.round(rep.confidence * 100)}%</b>
      <p>Доступно ${rep.coverage.available} из ${rep.coverage.total} показателей. Проценты отражают качество данных.</p></div>
    <div class="metric-list">${squatMetricCards(rep)}</div>
    ${rep.issues.map(i => `<div class="issue-card warn"><div class="issue-head">${escapeHtml(i.title)}</div><div class="issue-body">${escapeHtml(i.body)}</div></div>`).join('')}
    <p class="metric-note">Один 2D ракурс не определяет нагрузку на суставы, положение позвоночника, отрыв пятки и истинный вальгус/варус.</p>`;
  go('s-repdetail');
}
