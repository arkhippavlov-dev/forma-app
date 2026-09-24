/* FORMA SquatAnalysis V1 — observations from one 2D view, not a clinical
   assessment. No model-specific landmarks, universal ideal pose or /100 score.
   Every measurement carries availability, data confidence and a reason.
   Confidence is a conservative data-quality indicator, NOT a calibrated
   probability of correct technique. Thresholds below are engineering guards. */
const SquatAnalysisService = (function () {
  const MIN_VIS = 0.35;
  const METRICS = ['depth', 'symmetry', 'torso', 'control', 'knees'];
  const LIMITS = {
    symmetryDeg: 16, symmetryRomDeg: 20, symmetryPersistence: 0.6,
    torsoChangeDeg: 18, trajectoryExcess: 0.18, kneeShiftRatio: 0.12,
    maxGapMs: 300
  };
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  function quantile(values, q) {
    const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const n = (a.length - 1) * q, i = Math.floor(n);
    return a[i] + (a[Math.min(i + 1, a.length - 1)] - a[i]) * (n - i);
  }
  const median = a => quantile(a, 0.5);
  const round = (v, n = 2) => Number.isFinite(v) ? Number(v.toFixed(n)) : null;
  const point = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  function aspect(f) { return Number.isFinite(f?.aspectRatio) && f.aspectRatio > 0 ? f.aspectRatio : 1; }
  function quality(f, keys, threshold = MIN_VIS) {
    if (!keys.every(k => point(f.pose?.[k]))) return 0;
    if (!keys.every(k => f.pose[k][0] >= 0 && f.pose[k][0] <= 1 && f.pose[k][1] >= 0 && f.pose[k][1] <= 1)) return 0;
    // An absent reliability map is unknown; it must not become confidence=1.
    const values = keys.map(k => f.visibility?.[k]);
    if (!values.every(Number.isFinite)) return 0;
    const q = clamp(Math.min(...values));
    return q >= threshold ? q : 0;
  }
  function length(f, a, b) {
    return Math.hypot((a[0] - b[0]) * aspect(f), a[1] - b[1]);
  }
  function angle(f, a, b, c) {
    const x1 = (a[0] - b[0]) * aspect(f), y1 = a[1] - b[1];
    const x2 = (c[0] - b[0]) * aspect(f), y2 = c[1] - b[1];
    const denom = Math.hypot(x1, y1) * Math.hypot(x2, y2);
    return denom > 0.0004 ? Math.acos(clamp((x1 * x2 + y1 * y2) / denom, -1, 1)) * 180 / Math.PI : null;
  }
  function unavailable(reason, extra = {}) {
    return { available: false, value: null, status: 'unavailable', confidence: 0, reason, ...extra };
  }
  function metric(value, status, confidence, reason, extra = {}) {
    return { available: true, value, status, confidence: round(clamp(confidence)), reason, ...extra };
  }
  function timeline(rep) {
    const byTime = new Map();
    for (const f of [...(rep?.frames || []), rep?.bottomFrame]) {
      if (f && Number.isFinite(f.t) && f.pose) byTime.set(f.t, f);
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }
  function coverage(rows, frames) { return clamp(rows.length / Math.max(1, frames.length)); }
  function gap(rows) {
    let max = 0;
    for (let i = 1; i < rows.length; i++) max = Math.max(max, rows[i].t - rows[i - 1].t);
    return max;
  }
  function smoothRows(rows) {
    return rows.map((r, i) => ({ ...r, v: median(rows.slice(Math.max(0, i - 1), i + 2).map(x => x.v)) }));
  }
  function sideRows(frames, parts, compute, threshold = MIN_VIS) {
    return ['l', 'r'].map(side => ({ side, rows: frames.flatMap(f => {
      const q = quality(f, parts.map(p => side + p), threshold);
      if (!q) return [];
      const value = compute(f, side);
      return Number.isFinite(value) ? [{ t: f.t, v: value, q, f }] : [];
    }) }));
  }
  function bestSide(sides) { return sides.slice().sort((a, b) => b.rows.length - a.rows.length)[0]; }

  function analyzeDepth(rep, frames) {
    const empty = { depthValue: null, leftDepth: null, rightDepth: null, kneeAngle: null };
    if (!rep?.bottomFrame || !frames.length) return unavailable('Нижняя часть движения не записана.', empty);
    const radius = Math.min(300, Math.max(150, (rep.durationMs || 1000) * 0.12));
    const bottom = frames.filter(f => Math.abs(f.t - rep.bottomFrame.t) <= radius);
    function samples(method) {
      return ['l', 'r'].map(side => ({ side, rows: bottom.flatMap(f => {
        const parts = method === 'shin' ? ['hip', 'knee', 'ankle'] : ['hip', 'knee', 'shoulder'];
        const q = quality(f, parts.map(p => side + p));
        if (!q) return [];
        const p = f.pose;
        const scale = method === 'shin' ? length(f, p[side + 'knee'], p[side + 'ankle'])
          : length(f, p[side + 'shoulder'], p[side + 'hip']);
        if (scale < 0.025) return [];
        return [{ v: (p[side + 'hip'][1] - p[side + 'knee'][1]) / scale, q, t: f.t }];
      }) })).filter(s => s.rows.length >= 2);
    }
    let method = 'shin', sides = samples(method);
    if (!sides.length) { method = 'torso'; sides = samples(method); }
    if (!sides.length) return unavailable('Мало надёжных hip/knee и масштаба тела возле нижней точки.', empty);
    const values = sides.map(s => median(s.rows.map(r => r.v)));
    const depthValue = mean(values);
    const confidence = mean(sides.map(s => mean(s.rows.map(r => r.q)) * coverage(s.rows, bottom))) *
      (sides.length === 2 ? 0.85 : 0.65) * (method === 'torso' ? 0.65 : 1);
    const status = depthValue < -0.12 ? 'projected_above' : depthValue > 0.12 ? 'projected_below' : 'projected_level';
    const position = { projected_above: 'выше колена', projected_below: 'ниже колена', projected_level: 'примерно на уровне колена' }[status];
    const left = sides.find(s => s.side === 'l'), right = sides.find(s => s.side === 'r');
    return metric(round(depthValue, 3), status, confidence,
      `В нижней части повтора таз ${position} в проекции камеры. ` +
      (method === 'torso' ? 'Стопа не подтверждена: масштаб по корпусу, надёжность ниже.' : 'Масштаб — видимая длина голени; это не норматив глубины.'), {
        depthValue: round(depthValue, 3), leftDepth: left ? round(median(left.rows.map(r => r.v)), 3) : null,
        rightDepth: right ? round(median(right.rows.map(r => r.v)), 3) : null,
        kneeAngle: method === 'shin' ? rep.bottomFrame.kneeAngle ?? null : null,
        method, sides: sides.map(s => s.side), sampleCount: sides.reduce((n, s) => n + s.rows.length, 0),
        unit: method === 'shin' ? 'длины голени' : 'длины корпуса',
        comparisonKey: method + ':' + sides.map(s => s.side).join('')
      });
  }

  function analyzeSymmetry(frames) {
    const rows = frames.flatMap(f => {
      const q = quality(f, ['lhip', 'lknee', 'lankle', 'rhip', 'rknee', 'rankle'], 0.5);
      if (!q) return [];
      const p = f.pose;
      const l = angle(f, p.lhip, p.lknee, p.lankle), r = angle(f, p.rhip, p.rknee, p.rankle);
      const ll = length(f, p.lhip, p.lknee), rl = length(f, p.rhip, p.rknee);
      if (l === null || r === null || Math.min(ll, rl) < 0.025) return [];
      return [{ t: f.t, l, r, q, projectionRatio: Math.max(ll, rl) / Math.min(ll, rl),
        ly: p.lhip[1], ry: p.rhip[1], scale: (ll + rl) / 2 }];
    });
    if (rows.length < 6 || coverage(rows, frames) < 0.55 || gap(rows) > LIMITS.maxGapMs)
      return unavailable('Для сравнения нужны обе ноги с надёжными коленями и стопами на большей части повтора.');
    if (median(rows.map(r => r.projectionRatio)) > 1.45)
      return unavailable('Проекции ног сильно различаются: ракурс мешает сравнивать стороны.');
    const baseline = median(rows.slice(0, 3).map(r => r.l - r.r));
    const differences = rows.map(r => Math.abs(r.l - r.r - baseline));
    const dynamicDifference = median(differences);
    const lRom = quantile(rows.map(r => r.l), 0.9) - quantile(rows.map(r => r.l), 0.1);
    const rRom = quantile(rows.map(r => r.r), 0.9) - quantile(rows.map(r => r.r), 0.1);
    if (Math.min(lRom, rRom) < 12) return unavailable('В проекции слишком мало изменения углов для сравнения сторон.');
    const bottomTime = key => {
      const min = quantile(rows.map(r => r[key]), 0.1);
      return median(rows.filter(r => r[key] <= min + 3).map(r => r.t));
    };
    const timing = Math.abs(bottomTime('l') - bottomTime('r'));
    const persistent = differences.filter(d => d > LIMITS.symmetryDeg).length / rows.length;
    const differs = persistent >= LIMITS.symmetryPersistence &&
      (Math.abs(lRom - rRom) > LIMITS.symmetryRomDeg || timing > 250);
    return metric({ dynamicDifferenceDeg: round(dynamicDifference, 1),
      leftRomDeg: round(lRom, 1), rightRomDeg: round(rRom, 1), romDifferenceDeg: round(Math.abs(lRom - rRom), 1),
      bottomTimingDeltaMs: Math.round(timing), persistentFraction: round(persistent),
      hipExcursionDifference: round(Math.abs(
        (quantile(rows.map(r => r.ly), 0.9) - quantile(rows.map(r => r.ly), 0.1)) -
        (quantile(rows.map(r => r.ry), 0.9) - quantile(rows.map(r => r.ry), 0.1))) / median(rows.map(r => r.scale)), 3)
    }, differs ? 'observed_difference' : 'no_sustained_difference',
    mean(rows.map(r => r.q)) * coverage(rows, frames) * 0.65,
    'Сравнение изменений углов относительно начала повтора, а не абсолютного положения сторон. Ракурс около 45° всё ещё может создавать разницу.');
  }

  function analyzeTorso(frames) {
    const side = bestSide(sideRows(frames, ['shoulder', 'hip'], (f, s) => {
      const sh = f.pose[s + 'shoulder'], hip = f.pose[s + 'hip'];
      if (length(f, sh, hip) < 0.04) return null;
      return Math.atan2((sh[0] - hip[0]) * aspect(f), hip[1] - sh[1]) * 180 / Math.PI;
    }));
    if (side.rows.length < 5 || coverage(side.rows, frames) < 0.5 || gap(side.rows) > LIMITS.maxGapMs)
      return unavailable('Плечо и таз недостаточно надёжно видны по ходу повтора.');
    const rows = smoothRows(side.rows);
    let maxChange = 0;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length && rows[j].t - rows[i].t <= 300; j++) {
        if (rows[j].t - rows[i].t >= 120) maxChange = Math.max(maxChange, Math.abs(rows[j].v - rows[i].v));
      }
    }
    const excursion = quantile(rows.map(r => r.v), 0.9) - quantile(rows.map(r => r.v), 0.1);
    return metric({ medianTiltDeg: round(median(rows.map(r => Math.abs(r.v))), 1),
      tiltExcursionDeg: round(excursion, 1), maxChangeIn300msDeg: round(maxChange, 1) },
    maxChange > LIMITS.torsoChangeDeg ? 'rapid_change' : 'measured',
    mean(rows.map(r => r.q)) * coverage(rows, frames) * 0.75,
    'Изменение наклона в плоскости камеры. Сам по себе наклон вперёд не считается ошибкой.', { side: side.side });
  }

  function analyzeControl(rep, frames) {
    const side = bestSide(sideRows(frames, ['hip', 'knee'], (f, s) => f.pose[s + 'hip'][1]));
    if (side.rows.length < 8 || coverage(side.rows, frames) < 0.65 || gap(side.rows) > LIMITS.maxGapMs || rep.truncated)
      return unavailable('Для темпа и траектории нужна непрерывная запись большей части повтора.');
    const rows = smoothRows(side.rows);
    const scale = median(side.rows.map(r => length(r.f, r.f.pose[side.side + 'hip'], r.f.pose[side.side + 'knee'])));
    const lo = Math.min(...rows.map(r => r.v)), hi = Math.max(...rows.map(r => r.v));
    if (scale < 0.025 || (hi - lo) / scale < 0.12) return unavailable('Недостаточно видимого движения таза для оценки темпа.');
    const bottom = rows.filter(r => r.v >= hi - scale * 0.035);
    const bottomStart = bottom[0].t, bottomEnd = bottom[bottom.length - 1].t;
    if (bottomStart <= rows[0].t || bottomEnd >= rows[rows.length - 1].t)
      return unavailable('Не видны обе фазы движения вокруг нижней точки.');
    let travel = 0, reversals = 0, dir = 0, extreme = rows[0].v;
    for (let i = 1; i < rows.length; i++) {
      travel += Math.abs(rows[i].v - rows[i - 1].v);
      const delta = rows[i].v - extreme;
      if (!dir && Math.abs(delta) > scale * 0.04) dir = Math.sign(delta);
      if (dir * delta > 0) extreme = rows[i].v;
      else if (dir && dir * delta < -scale * 0.07) { reversals++; dir = -dir; extreme = rows[i].v; }
    }
    const idealTravel = (hi - rows[0].v) + (hi - rows[rows.length - 1].v);
    const excess = Math.max(0, (travel - idealTravel) / Math.max(idealTravel, scale * 0.12));
    return metric({ eccentricMs: Math.round(bottomStart - rows[0].t), bottomMs: Math.round(bottomEnd - bottomStart),
      concentricMs: Math.round(rows[rows.length - 1].t - bottomEnd),
      measuredDurationMs: Math.round(rows[rows.length - 1].t - rows[0].t),
      extraDirectionChanges: Math.max(0, reversals - 1), excessTravelRatio: round(excess, 3) },
    excess > LIMITS.trajectoryExcess && reversals >= 3 ? 'variable_path' : 'measured',
    mean(rows.map(r => r.q)) * coverage(rows, frames) * 0.8,
    'Темп по записанной траектории таза; границы фаз приблизительные. Быстрое выполнение само по себе не штрафуется.',
    { side: side.side, timingResolutionMs: Math.round(gap(rows)) });
  }

  function analyzeKnees(rep, frames) {
    const sideResults = [];
    for (const s of ['l', 'r']) {
      const rows = frames.flatMap(f => {
        const q = quality(f, [s + 'hip', s + 'knee', s + 'ankle'], 0.6);
        if (!q) return [];
        const h = f.pose[s + 'hip'], k = f.pose[s + 'knee'], a = f.pose[s + 'ankle'];
        const scale = length(f, k, a);
        if (scale < 0.04 || Math.abs(a[1] - h[1]) < 0.06) return [];
        const proportion = (k[1] - h[1]) / (a[1] - h[1]);
        const lineX = h[0] + proportion * (a[0] - h[0]);
        return [{ t: f.t, q, hipY: h[1], v: (k[0] - lineX) * aspect(f) / scale }];
      });
      if (rows.length < 10 || coverage(rows, frames) < 0.65 || gap(rows) > LIMITS.maxGapMs) continue;
      const low = Math.min(...rows.map(r => r.hipY)), high = Math.max(...rows.map(r => r.hipY));
      if (high - low < 0.04) continue;
      const down = rows.filter(r => r.t < rep.bottomFrame?.t), up = rows.filter(r => r.t > rep.bottomFrame?.t);
      if (down.length < 4 || up.length < 4) continue;
      // Compare ascent with descent at similar hip heights. This measures a
      // change in the person's own projected path, not deviation from an ideal.
      const pairs = [], used = new Set();
      for (const d of down) {
        const matches = up.filter(u => !used.has(u.t)).sort((a, b) => Math.abs(a.hipY - d.hipY) - Math.abs(b.hipY - d.hipY));
        const u = matches[0];
        if (u && Math.abs(u.hipY - d.hipY) / (high - low) <= 0.12) {
          used.add(u.t);
          pairs.push({ delta: Math.abs(u.v - d.v), q: Math.min(u.q, d.q) });
        }
      }
      if (pairs.length < 4) continue;
      const shift = median(pairs.map(p => p.delta));
      const persistent = pairs.filter(p => p.delta > LIMITS.kneeShiftRatio).length / pairs.length;
      sideResults.push({ side: s, shift, persistent, q: mean(pairs.map(p => p.q)) * coverage(rows, frames), pairs: pairs.length });
    }
    if (!sideResults.length) return unavailable('Мало надёжных сопоставимых точек колена на спуске и подъёме. Положение стоп и вальгус не определяются.');
    const shifted = sideResults.some(s => s.shift > LIMITS.kneeShiftRatio && s.persistent >= 0.6);
    return metric({ projectedShiftRatio: round(mean(sideResults.map(s => s.shift)), 3), sides: sideResults.map(s => ({
      side: s.side, shiftRatio: round(s.shift, 3), matchedSamples: s.pairs })) },
    shifted ? 'observed_shift' : 'no_sustained_shift',
    mean(sideResults.map(s => s.q)) * (sideResults.length === 2 ? 0.6 : 0.45),
    'Сравнение собственной траектории колена на спуске и подъёме. Смещение в 2D не доказывает завал внутрь или наружу.');
  }

  function analyze(rep) {
    const frames = timeline(rep);
    const r = {
      index: rep?.index ?? null, repIndex: rep?.index ?? null, durationMs: rep?.durationMs ?? null,
      depth: analyzeDepth(rep, frames), symmetry: analyzeSymmetry(frames),
      torso: analyzeTorso(frames), control: analyzeControl(rep || {}, frames), knees: analyzeKnees(rep || {}, frames),
      issues: [], strengths: [], score: null
    };
    const issue = (key, m, title, body) => {
      if (m.available && m.confidence >= 0.35) r.issues.push({ key, severity: 'warn', title, body, confidence: m.confidence });
    };
    if (r.symmetry.status === 'observed_difference') issue('symmetry', r.symmetry, 'Разница движения сторон', 'Разница изменений углов сохраняется в течение повтора. Проверь запись и ракурс; это не диагноз асимметрии.');
    if (r.torso.status === 'rapid_change') issue('torso', r.torso, 'Быстрое изменение наклона корпуса', 'В проекции заметно быстрое изменение наклона. Сопоставь этот участок с видео.');
    if (r.control.status === 'variable_path') issue('control', r.control, 'Дополнительные изменения направления', 'В траектории таза видны изменения направления помимо обычного спуска и подъёма. Возможны движение камеры или ошибка отслеживания.');
    if (r.knees.status === 'observed_shift') issue('knees', r.knees, 'Изменение траектории колена', 'На подъёме колено идёт по другой проекции, чем на спуске. Для уточнения нужен дополнительный ракурс.');
    if (r.control.available && r.control.status === 'measured' && r.control.confidence >= 0.5)
      r.strengths.push('На видимом участке нет выраженных дополнительных изменений направления таза.');
    if (r.symmetry.status === 'no_sustained_difference' && r.symmetry.confidence >= 0.5)
      r.strengths.push('Устойчивой разницы изменений углов сторон на этом ракурсе не обнаружено.');
    const available = METRICS.map(k => r[k]).filter(m => m.available);
    r.confidence = round(mean(available.map(m => m.confidence)) || 0);
    r.coverage = { available: available.length, total: METRICS.length };
    return r;
  }

  function summarize(reps) {
    const duration = reps.map(r => r.control.available ? r.control.value.measuredDurationMs : null).filter(Number.isFinite);
    const depthGroups = new Map();
    for (const r of reps) if (r.depth.available) {
      const key = r.depth.comparisonKey;
      if (!depthGroups.has(key)) depthGroups.set(key, []);
      depthGroups.get(key).push(r);
    }
    const comparableDepth = [...depthGroups.values()].sort((a, b) => b.length - a.length)[0] || [];
    const depthValues = comparableDepth.map(r => r.depth.depthValue);
    const recurring = new Map();
    for (const r of reps) for (const i of r.issues) {
      if (!recurring.has(i.key)) recurring.set(i.key, { ...i, count: 0, reps: [] });
      const item = recurring.get(i.key); item.count++; item.reps.push(r.index);
    }
    const summaries = {};
    for (const k of METRICS) {
      const available = reps.filter(r => r[k].available);
      summaries[k] = { available: available.length > 0, measuredReps: available.length,
        totalReps: reps.length, confidence: round(mean(available.map(r => r[k].confidence)) || 0) };
    }
    const changes = [];
    const comparisonsChecked = [];
    if (reps.length >= 4) {
      const n = Math.floor(reps.length / 2), first = reps.slice(0, n), last = reps.slice(-n);
      const compare = (key, getter, threshold, reason) => {
        const a = first.map(getter).filter(Number.isFinite), b = last.map(getter).filter(Number.isFinite);
        if (a.length < 2 || b.length < 2) return;
        comparisonsChecked.push(key);
        const delta = median(b) - median(a);
        if (Math.abs(delta) > threshold) changes.push({ key, delta: round(delta, 3), reason });
      };
      const depthKey = comparableDepth[0]?.depth.comparisonKey;
      compare('depth', r => r.depth.available && r.depth.comparisonKey === depthKey ? r.depth.depthValue : null, 0.15,
        'Изменилась глубина в проекции между началом и концом подхода.');
      const medianTime = median(duration);
      if (medianTime) compare('tempo', r => r.control.available ? r.control.value.measuredDurationMs / medianTime : null, 0.25,
        'Изменился темп между началом и концом подхода; причина по видео не определяется.');
      const torsoSide = reps.find(r => r.torso.available)?.torso.side;
      compare('torso', r => r.torso.available && r.torso.side === torsoSide ? r.torso.value.tiltExcursionDeg : null, 8,
        'Изменился диапазон наклона корпуса между началом и концом подхода.');
    }
    // Compare like-for-like metrics only. A repetition with missing metrics
    // cannot become the most stable merely because it has fewer observations.
    const candidates = reps.filter(r => r.depth.available && r.control.available &&
      r.depth.confidence >= 0.35 && r.control.confidence >= 0.5 &&
      r.depth.comparisonKey === comparableDepth[0]?.depth.comparisonKey);
    let stability = unavailable('Нужно хотя бы три повтора с сопоставимыми глубиной и темпом.');
    let mostStableRep = null;
    if (candidates.length >= 3) {
      const dm = median(candidates.map(r => r.depth.depthValue));
      const tm = median(candidates.map(r => r.control.value.measuredDurationMs));
      const deviations = candidates.map(r => ({ index: r.index,
        depthDeviation: Math.abs(r.depth.depthValue - dm),
        tempoDeviation: Math.abs(r.control.value.measuredDurationMs - tm) / tm }));
      mostStableRep = deviations.slice().sort((a, b) =>
        (a.depthDeviation / 0.15 + a.tempoDeviation / 0.25) - (b.depthDeviation / 0.15 + b.tempoDeviation / 0.25))[0].index;
      stability = metric({ depthSpread: round(quantile(depthValues, 0.9) - quantile(depthValues, 0.1), 3),
        tempoVariation: round((quantile(duration, 0.9) - quantile(duration, 0.1)) / median(duration), 3) },
        'descriptive', mean(candidates.map(r => Math.min(r.depth.confidence, r.control.confidence))),
        'Разброс сопоставимых глубины и темпа. Самый стабильный повтор ближе всего к типичным значениям подхода.');
    }
    const noted = reps.filter(r => r.issues.length).sort((a, b) => b.issues.length - a.issues.length);
    return {
      repetitions: reps.length, metrics: summaries, consistency: stability,
      mostStableRep, mostNotedRep: noted[0]?.index ?? null,
      recurringIssues: [...recurring.values()].filter(i => i.count >= 2), changes, comparisonsChecked,
      depth: depthValues.length ? { median: round(median(depthValues), 3), min: round(Math.min(...depthValues), 3),
        max: round(Math.max(...depthValues), 3), comparableReps: comparableDepth.map(r => r.index),
        method: comparableDepth[0].depth.method } : null,
      tempo: duration.length ? { medianMs: Math.round(median(duration)), minMs: Math.min(...duration), maxMs: Math.max(...duration) } : null,
      confidence: round(mean(reps.map(r => r.confidence)) || 0),
      note: !reps.length ? 'Завершённых повторений нет. Неполный цикл в результат не включён.' :
        changes.length ? changes.map(c => c.reason).join(' ') :
        reps.length < 4 ? 'Для сравнения начала и конца подхода нужно хотя бы четыре повтора.' :
        !comparisonsChecked.length ? 'Недостаточно сопоставимых данных для сравнения начала и конца подхода.' :
        'На сопоставимых измерениях выраженного изменения к концу подхода не найдено. Недоступные показатели не оценивались.'
    };
  }
  function analyzeSet(completedReps, cached) {
    const reps = (completedReps || []).map(rep => cached?.find(r => r.index === rep.index) || analyze(rep));
    return { reps, summary: summarize(reps) };
  }
  return { analyze, analyzeSet };
})();
