/* =====================================================================
   EXERCISE LIBRARY
   ---------------------------------------------------------------------
   The whole app is "exercise-based": every exercise is one config object
   with the shape below. Adding a new exercise later (deadlift, barbell
   row, overhead press...) means adding one object here — nothing in
   Camera / Pose / RepDetector / BiomechanicsEngine / UI needs to change,
   as long as the new config follows this same contract:

   Exercise
   ├── id, name, description
   ├── recommended_camera_angle   { deg, label, quote }
   ├── camera_setup               { distance, height, visible }
   ├── required_body_points       [ ... ]
   ├── movement_phases            [ ... ]
   ├── primary_signal             which joint-angle drives rep detection
   ├── technique_rules            [ human-readable checks the engine runs ]
   ├── error_rules                [ { key, severity, title, body, why, fix,
                                       metric, threshold_warn, threshold_bad } ]
   └── scoring_rules              { subscore_id -> [error keys it's hurt by] }
   ===================================================================== */

const ExerciseLibrary = (function(){

  const catalog = {
    bench_press: {
      id: 'bench_press',
      name: 'Жим лёжа',
      description: 'Базовое горизонтальное жимовое движение со штангой или гантелями.',
      recommended_camera_angle: { deg: 90, label: '90° строго сбоку', quote: 'Для наиболее точного анализа поставь камеру строго сбоку, на уровне груди.' },
      camera_setup: {
        distance: '2–2.5 м сбоку от скамьи.',
        height: 'На уровне груди в положении лёжа.',
        visible: 'Плечо, локоть, запястье, гриф — вся траектория движения.'
      },
      required_body_points: ['shoulder','elbow','wrist','hip','knee'],
      movement_phases: ['старт (руки выпрямлены)', 'опускание', 'нижняя точка (гриф у груди)', 'жим вверх'],
      primary_signal: 'elbowAngle',
      technique_rules: [
        'запястье должно находиться строго над локтем в каждой фазе',
        'угол между локтем и корпусом в диапазоне ~45–60° на опускании',
        'гриф движется по одной горизонтали для обеих рук',
        'полная амплитуда — гриф касается груди'
      ],
      error_rules: [
        { key:'wrist_align', metric:'wristOff', severity:'bad', warn:0.22, bad:0.5,
          title:'Запястье не над локтем', body:'В нижней точке запястье смещено вперёд относительно локтя.',
          why:'Создаёт лишний рычаг и нагрузку на лучезапястный сустав.',
          fix:'Держи гриф строго над предплечьем — линия запястье-локоть должна быть вертикальной.' },
        { key:'elbow_flare', metric:'elbowFlare', severity:'warn', warn:0.2, bad:0.45,
          title:'Локти сильно разведены в стороны', body:'Угол между локтем и корпусом превышает рекомендуемый на опускании.',
          why:'Увеличивает нагрузку на плечевой сустав.',
          fix:'Опускай гриф с локтями под углом примерно 45–60° к корпусу.' },
        { key:'asym_bar', metric:'asym', severity:'warn', warn:0.2, bad:0.45,
          title:'Гриф идёт не строго горизонтально', body:'Одна сторона опускается быстрее другой.',
          why:'Может говорить о разнице в контроле между левой и правой стороной.',
          fix:'Снизь темп и следи за симметрией через зеркало или видео.' },
        { key:'rom_ok', metric:null, severity:'good',
          title:'Полная амплитуда', body:'Гриф каждый раз касается груди без сокращения диапазона.', why:'', fix:'' },
      ],
      scoring_rules: {
        amplitude: ['rom_ok'],
        stability: ['wrist_align'],
        symmetry: ['asym_bar'],
        control: ['elbow_flare'],
        torso: [] // bench press: torso position less relevant, stays high by default
      }
    },

    squat: {
      id: 'squat',
      name: 'Приседания',
      description: 'Базовое приседание со штангой, гантелями или собственным весом.',
      recommended_camera_angle: { deg: 0, label: '0° строго сбоку', quote: 'Для наиболее точного анализа поставь камеру строго сбоку, на уровне таза.' },
      camera_setup: {
        distance: '2.5–3 м сбоку, чтобы видеть всё тело в нижней точке.',
        height: 'На уровне таза.',
        visible: 'Голова, плечи, таз, колени, стопы — весь силуэт сбоку.'
      },
      required_body_points: ['shoulder','hip','knee','ankle'],
      movement_phases: ['старт (стоя)', 'опускание', 'нижняя точка', 'подъём'],
      primary_signal: 'kneeAngle',
      technique_rules: [
        'колени двигаются по линии стоп, без завала внутрь',
        'таз опускается ниже уровня коленей (полная глубина)',
        'корпус остаётся относительно вертикальным',
        'стопы плотно стоят на полу'
      ],
      error_rules: [
        { key:'knee_valgus', metric:'kneeValgus', severity:'bad', warn:0.22, bad:0.5,
          title:'Колени уходят внутрь', body:'В нижней фазе приседа колени заваливаются к центру.',
          why:'Часто связано с недостаточной активацией ягодичных мышц или узкой постановкой стоп.',
          fix:'Снизь вес и сфокусируйся на разведении коленей по линии стоп на протяжении всего движения.' },
        { key:'depth', metric:'depthMissed', severity:'warn', warn:0.5, bad:0.9,
          title:'Неполная глубина приседа', body:'Таз не опускается ниже уровня коленей в нижней точке.',
          why:'Может ограничивать подвижность голеностопа или бедра.',
          fix:'Поработай над мобильностью и попробуй немного шире поставить стопы.' },
        { key:'torso_fwd', metric:'torsoLean', severity:'warn', warn:0.2, bad:0.45,
          title:'Излишний наклон корпуса вперёд', body:'Корпус заметно наклоняется вперёд в нижней фазе.',
          why:'Может смещать нагрузку на поясницу вместо ног.',
          fix:'Держи грудь приподнятой и контролируй положение штанги/центра тяжести.' },
        { key:'stance_ok', metric:null, severity:'good',
          title:'Стабильное положение стоп', body:'Стопы остаются плотно прижаты, без отрыва пятки.', why:'', fix:'' },
      ],
      scoring_rules: {
        amplitude: ['depth'],
        stability: ['stance_ok'],
        symmetry: ['knee_valgus'],
        control: ['knee_valgus','depth'],
        torso: ['torso_fwd']
      }
    },

    lat_pulldown: {
      id: 'lat_pulldown',
      name: 'Тяга верхнего блока',
      description: 'Тяга рукояти к груди сверху на блочном тренажёре, для широчайших мышц спины.',
      recommended_camera_angle: { deg: 45, label: '≈45° спереди-сбоку', quote: 'Для наиболее точного анализа поставь камеру под углом примерно 45° спереди-сбоку.' },
      camera_setup: {
        distance: '1.8–2.2 м от тренажёра, чтобы в кадр попал весь корпус и руки.',
        height: 'На уровне груди сидящего человека.',
        visible: 'Голова, плечи, локти, кисти, таз и колени — целиком.'
      },
      required_body_points: ['head','shoulder','elbow','wrist','hip','knee'],
      movement_phases: ['старт (руки вытянуты вверх)', 'тяга вниз', 'нижняя точка (у груди)', 'возврат'],
      primary_signal: 'elbowAngle',
      technique_rules: [
        'корпус остаётся относительно стабильным, без резкого отклонения назад',
        'локти двигаются вниз, а не назад',
        'обе стороны двигаются симметрично',
        'полная амплитуда движения'
      ],
      error_rules: [
        { key:'torso_lean', metric:'torsoLean', severity:'bad', warn:0.2, bad:0.45,
          title:'Слишком сильное отклонение корпуса', body:'Во время тяги корпус сильно отклоняется назад.',
          why:'Ты частично компенсируешь движение корпусом вместо того, чтобы выполнять основную работу за счёт рук и плечевого пояса.',
          fix:'Уменьши рабочий вес и сохраняй более стабильное положение корпуса.' },
        { key:'elbow_back', metric:'elbowBack', severity:'warn', warn:0.2, bad:0.45,
          title:'Локти уходят слишком далеко назад', body:'Во второй фазе повторения локти значительно отклоняются относительно рекомендуемой траектории.',
          why:'Плечи включаются раньше, чем широчайшие успевают начать движение.',
          fix:'Сконцентрируйся на движении локтей вниз и контролируй конечную позицию.' },
        { key:'asym', metric:'asym', severity:'warn', warn:0.18, bad:0.35,
          title:'Асимметрия между сторонами', body:'Левая и правая стороны опускают рукоять не синхронно.',
          why:'Может указывать на разницу в силе широчайших мышц спины или неровный хват.',
          fix:'Проверь хват и попробуй снизить темп, чтобы обе стороны двигались одинаково.' },
        { key:'rom', metric:null, severity:'good',
          title:'Амплитуда', body:'Амплитуда движения находится в хорошем диапазоне.', why:'', fix:'' },
      ],
      scoring_rules: {
        amplitude: ['rom'],
        stability: ['torso_lean'],
        symmetry: ['asym'],
        control: ['elbow_back'],
        torso: ['torso_lean']
      }
    }
  };

  function all(){ return Object.values(catalog); }
  function get(id){ return catalog[id] || null; }
  function isAvailable(id){ return !!catalog[id]; }

  // Placeholder for the future "AI exercise search" (spec §4/§22): a user
  // types a free-text exercise name, an LLM resolves it to a config (or
  // proposes generating a new one). For now this is a stub — it only
  // matches the 3 configs already in the catalog by name/substring, and
  // returns a clear "not available yet" result otherwise. The interface
  // shape (query -> {matched, exercise|null}) is what a real AI resolver
  // would implement, so swapping it in later doesn't touch the UI.
  function search(query){
    const q = (query||'').trim().toLowerCase();
    if(!q) return { matched:false, exercise:null };
    const found = all().find(ex => ex.name.toLowerCase().includes(q) || ex.id.includes(q));
    return found ? { matched:true, exercise: found } : { matched:false, exercise:null };
  }

  return { all, get, isAvailable, search };
})();
