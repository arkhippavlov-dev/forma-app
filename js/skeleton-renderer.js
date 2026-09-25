/* ============================================================
   FORMA — SKELETON RENDERER
   V0.1
   Real MediaPipe landmarks → canvas overlay
   ============================================================ */

const SkeletonRenderer = (function () {

  function cssVar(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }

  function colorFor(severity) {
    if (severity === 'bad') return cssVar('--bad');
    if (severity === 'warn') return cssVar('--warn');
    return cssVar('--good');
  }

  /*
    MediaPipe body connections.

    We deliberately don't draw every MediaPipe landmark yet.
    For V0.1 we want a clean human skeleton.
  */
  const SEGMENTS = [
    // shoulders
    ['neck', 'lshoulder', 'shoulders'],
    ['neck', 'rshoulder', 'shoulders'],

    // torso
    ['lshoulder', 'lhip', 'spine'],
    ['rshoulder', 'rhip', 'spine'],
    ['lhip', 'rhip', 'hips'],

    // left arm
    ['lshoulder', 'lelbow', 'leftElbow'],
    ['lelbow', 'lwrist', 'leftWrist'],

    // right arm
    ['rshoulder', 'relbow', 'rightElbow'],
    ['relbow', 'rwrist', 'rightWrist'],

    // left leg
    ['lhip', 'lknee', 'leftKnee'],
    ['lknee', 'lankle', 'leftKnee'],

    // right leg
    ['rhip', 'rknee', 'rightKnee'],
    ['rknee', 'rankle', 'rightKnee']
  ];

  const JOINT_PART = {
    head: 'head',

    lshoulder: 'shoulders',
    rshoulder: 'shoulders',

    lelbow: 'leftElbow',
    relbow: 'rightElbow',

    lwrist: 'leftWrist',
    rwrist: 'rightWrist',

    lhip: 'hips',
    rhip: 'hips',

    lknee: 'leftKnee',
    rknee: 'rightKnee',

    lankle: 'leftKnee',
    rankle: 'rightKnee'
  };


  // V0.2: do not try to invent or hold lost joints.
  // If MediaPipe says a point is unreliable, that point/segment simply
  // disappears until the point is reliable again. This is intentionally
  // renderer-only: movement detection still receives the original pose.
  const MIN_DRAW_VISIBILITY = 0.45;

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


  function visibilityFor(joint, visibility) {

    // No visibility object = old behaviour (used by compare/replay data).
    if (!visibility) return 1;

    if (joint === 'neck') {
      const left = visibility.LEFT_SHOULDER;
      const right = visibility.RIGHT_SHOULDER;

      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return 0;
      }

      return Math.min(left, right);
    }

    const key = VISIBILITY_KEY[joint];
    if (!key) return 1;

    const value = visibility[key];
    return Number.isFinite(value) ? value : 0;
  }


  /*
    Convert MediaPipe normalized coordinates:

      x = 0..1
      y = 0..1

    into canvas pixels.

    IMPORTANT:
    We do NOT mirror here.

    The video/canvas should use the same visual orientation.
  */
  function toPx(pose, w, h, videoW, videoH, visibility) {

    const P = {};

    if (!videoW || !videoH) {
      return P;
    }

    /*
      The video is displayed with object-fit: cover.

      MediaPipe coordinates are based on the real video frame.
      Canvas coordinates are based on the visible cropped area.

      We reproduce the same cover transformation here.
    */

    const scale = Math.max(
      w / videoW,
      h / videoH
    );

    const displayedW = videoW * scale;
    const displayedH = videoH * scale;

    const offsetX =
      (w - displayedW) / 2;

    const offsetY =
      (h - displayedH) / 2;


    Object.keys(pose || {}).forEach(key => {

      const point = pose[key];

      if (
        !point ||
        point.length < 2 ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1])
      ) {
        P[key] = null;
        return;
      }

      // Low-confidence landmark: do not draw it at all.
      if (visibilityFor(key, visibility) < MIN_DRAW_VISIBILITY) {
        P[key] = null;
        return;
      }

      // A point predicted outside the real camera frame is not useful for
      // the visual overlay. Dropping it is much better than a long flying
      // segment across the screen.
      if (
        point[0] < 0 || point[0] > 1 ||
        point[1] < 0 || point[1] > 1
      ) {
        P[key] = null;
        return;
      }

      const x =
        point[0] * displayedW + offsetX;

      const y =
        point[1] * displayedH + offsetY;

      // object-fit: cover can crop a perfectly valid video landmark out of
      // the visible canvas. If it is not actually visible to the user, do
      // not connect another joint to it.
      if (
        x < 0 || x > w ||
        y < 0 || y > h
      ) {
        P[key] = null;
        return;
      }

      P[key] = [x, y];
    });

    return P;
  }


  function validPoint(P, name) {
    return (
      P &&
      P[name] &&
      Number.isFinite(P[name][0]) &&
      Number.isFinite(P[name][1])
    );
  }


  function drawLine(ctx, P, a, b, color, width) {

    if (!validPoint(P, a) || !validPoint(P, b)) {
      return;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();

    ctx.moveTo(
      P[a][0],
      P[a][1]
    );

    ctx.lineTo(
      P[b][0],
      P[b][1]
    );

    ctx.stroke();
  }


  function drawJoint(ctx, point, color, radius) {

    if (!point) return;

    ctx.fillStyle = color;

    ctx.beginPath();

    ctx.arc(
      point[0],
      point[1],
      radius,
      0,
      Math.PI * 2
    );

    ctx.fill();
  }


  /*
    Draw user's real skeleton.
  */
  function drawUser(
    ctx,
    w,
    h,
    pose,
    segColors,
    visibility
  ) {

    if (!ctx || !pose) return;

    const P = toPx(
  pose,
  w,
  h,
  window.__formaVideoWidth,
  window.__formaVideoHeight,
  visibility
);

    /*
      Head
    */
    if (validPoint(P, 'head')) {

      ctx.strokeStyle =
        cssVar('--text-dim') || '#888';

      ctx.lineWidth = 3;

      ctx.beginPath();

      ctx.arc(
        P.head[0],
        P.head[1],
        12,
        0,
        Math.PI * 2
      );

      ctx.stroke();
    }


    /*
      Body segments
    */
    SEGMENTS.forEach(
      ([a, b, part]) => {

        const severity =
          (segColors || {})[part] || 'good';

        drawLine(
          ctx,
          P,
          a,
          b,
          colorFor(severity),
          5
        );
      }
    );


    /*
      Joints
    */
    Object.keys(JOINT_PART).forEach(
      joint => {

        if (!validPoint(P, joint)) {
          return;
        }

        const part =
          JOINT_PART[joint];

        const severity =
          (segColors || {})[part] || 'good';

        drawJoint(
          ctx,
          P[joint],
          colorFor(severity),
          5
        );
      }
    );
  }


  /*
    Draw reference / optimal skeleton.
  */
  function drawOptimal(
    ctx,
    w,
    h,
    pose
  ) {

    if (!ctx || !pose) return;

    const P = toPx(
  pose,
  w,
  h,
  window.__formaVideoWidth,
  window.__formaVideoHeight
);

    const optimalColor =
      cssVar('--optimal') || '#7C6CFF';


    /*
      Head
    */
    if (validPoint(P, 'head')) {

      ctx.strokeStyle =
        optimalColor;

      ctx.lineWidth = 3;

      ctx.setLineDash([6, 5]);

      ctx.beginPath();

      ctx.arc(
        P.head[0],
        P.head[1],
        12,
        0,
        Math.PI * 2
      );

      ctx.stroke();
    }


    /*
      Reference skeleton
    */
    SEGMENTS.forEach(
      ([a, b]) => {

        drawLine(
          ctx,
          P,
          a,
          b,
          optimalColor,
          3
        );
      }
    );


    /*
      Restore normal line mode.
    */
    ctx.setLineDash([]);


    /*
      Reference joints
    */
    Object.keys(JOINT_PART).forEach(
      joint => {

        if (!validPoint(P, joint)) {
          return;
        }

        ctx.globalAlpha = 0.85;

        drawJoint(
          ctx,
          P[joint],
          optimalColor,
          4
        );

        ctx.globalAlpha = 1;
      }
    );
  }


  return {
    drawUser,
    drawOptimal
  };

})();
