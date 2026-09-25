/* ============================================================
   FORMA — POSE STABILIZER
   V0.1

   Raw MediaPipe pose
        ↓
   stable pose

   Goals:
   - smooth small landmark jitter
   - reject impossible single-frame jumps
   - briefly keep the last reliable position
   - never let one bad joint destroy the whole skeleton
   ============================================================ */

const PoseStabilizer = (function () {

  const CONFIG = {

    // 0 = frozen
    // 1 = raw MediaPipe
    //
    // Higher value = more responsive.
    // Lower value = smoother.
    smoothing: 0.55,

    // If MediaPipe visibility falls below this,
    // the point is considered unreliable.
    minVisibility: 0.35,

    // Maximum normalized movement of one joint
    // between frames before we treat it as suspicious.
    maxJump: 0.18,

    // How long we keep the last reliable point
    // when MediaPipe temporarily loses it.
    holdMs: 350
  };


  /*
    MediaPipe visibility uses names like:
      LEFT_KNEE

    FORMA pose uses:
      lknee

    This maps one to the other.
  */
  const VISIBILITY_KEY = {

    head: 'NOSE',

    lshoulder: 'LEFT_SHOULDER',
    rshoulder: 'RIGHT_SHOULDER',

    lelbow: 'LEFT_ELBOW',
    relbow: 'RIGHT_ELBOW',

    lwrist: 'LEFT_WRIST',
    rwrist: 'RIGHT_WRIST',

    lhip: 'LEFT_HIP',
    rhip: 'RIGHT_HIP',

    lknee: 'LEFT_KNEE',
    rknee: 'RIGHT_KNEE',

    lankle: 'LEFT_ANKLE',
    rankle: 'RIGHT_ANKLE'
  };


  let state = {};


  function validPoint(point) {

    return (
      Array.isArray(point) &&
      point.length >= 2 &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1])
    );
  }


  function clonePoint(point) {

    if (!validPoint(point)) {
      return null;
    }

    return [
      point[0],
      point[1]
    ];
  }


  function distance(a, b) {

    if (!validPoint(a) || !validPoint(b)) {
      return Infinity;
    }

    return Math.hypot(
      a[0] - b[0],
      a[1] - b[1]
    );
  }


  function lerpPoint(previous, current, alpha) {

    return [
      previous[0] +
        (current[0] - previous[0]) * alpha,

      previous[1] +
        (current[1] - previous[1]) * alpha
    ];
  }


  function visibilityFor(
    joint,
    visibility
  ) {

    /*
      "neck" is generated from both shoulders,
      so it has no direct MediaPipe visibility entry.
    */
    if (joint === 'neck') {

      const left =
        visibility?.LEFT_SHOULDER;

      const right =
        visibility?.RIGHT_SHOULDER;

      const values = [];

      if (Number.isFinite(left)) {
        values.push(left);
      }

      if (Number.isFinite(right)) {
        values.push(right);
      }

      if (!values.length) {
        return 1;
      }

      return Math.min(...values);
    }


    const key =
      VISIBILITY_KEY[joint];

    if (!key) {
      return 1;
    }


    const value =
      visibility?.[key];

    return Number.isFinite(value)
      ? value
      : 1;
  }


  function update(
    pose,
    visibility,
    timestamp
  ) {

    if (!pose) {
      return null;
    }


    const now =
      Number.isFinite(timestamp)
        ? timestamp
        : performance.now();


    const stablePose = {};


    Object.keys(pose).forEach(
      joint => {

        const raw =
          pose[joint];

        const previous =
          state[joint];


        const visible =
          visibilityFor(
            joint,
            visibility
          );


        const rawIsValid =
          validPoint(raw);


        const reliable =
          rawIsValid &&
          visible >= CONFIG.minVisibility;


        /*
          We have never seen this joint before.
        */
        if (!previous) {

          if (reliable) {

            const point =
              clonePoint(raw);

            state[joint] = {
              point,
              lastReliableTime: now
            };

            stablePose[joint] =
              clonePoint(point);

          } else {

            stablePose[joint] = null;
          }

          return;
        }


        /*
          MediaPipe currently gives us a
          low-confidence / missing point.

          Briefly keep the last reliable position.
        */
        if (!reliable) {

          const age =
            now -
            previous.lastReliableTime;


          if (age <= CONFIG.holdMs) {

            stablePose[joint] =
              clonePoint(
                previous.point
              );

          } else {

            stablePose[joint] = null;
          }

          return;
        }


        const jump =
          distance(
            previous.point,
            raw
          );


        /*
          Huge one-frame teleport:
          do not immediately trust it.

          Keep previous position briefly.
        */
        if (jump > CONFIG.maxJump) {

          const age =
            now -
            previous.lastReliableTime;


          if (age <= CONFIG.holdMs) {

            stablePose[joint] =
              clonePoint(
                previous.point
              );

            return;
          }

          /*
            If the new location persists for long enough,
            accept it. This prevents the point from being
            permanently frozen when the person really moves.
          */
        }


        /*
          Normal movement:
          smooth previous → current.
        */
        const smoothed =
          lerpPoint(
            previous.point,
            raw,
            CONFIG.smoothing
          );


        state[joint] = {
          point: smoothed,
          lastReliableTime: now
        };


        stablePose[joint] =
          clonePoint(smoothed);
      }
    );


    /*
      Rebuild neck from stabilized shoulders.
      This is safer than independently filtering
      the derived raw neck point.
    */
    const ls =
      stablePose.lshoulder;

    const rs =
      stablePose.rshoulder;


    if (
      validPoint(ls) &&
      validPoint(rs)
    ) {

      stablePose.neck = [
        (ls[0] + rs[0]) / 2,
        (ls[1] + rs[1]) / 2
      ];
    }


    return stablePose;
  }


  function reset() {

    state = {};
  }


  return {
    update,
    reset
  };

})();
