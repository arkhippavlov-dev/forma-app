/* ============================================================
   FORMA — SKELETON RENDERER
   V0.1
   Real MediaPipe landmarks → canvas overlay
   ============================================================ */

const SkeletonRenderer = (function () {

  let palette = null;
  function refreshPalette() {
    const style = getComputedStyle(document.documentElement);
    palette = {};
    ['--good', '--warn', '--bad', '--text-dim', '--optimal'].forEach(name => {
      palette[name] = style.getPropertyValue(name).trim();
    });
  }

  function cssVar(name) {
    if (!palette) refreshPalette();
    return palette[name] || '';
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

  // This state affects only the overlay opacity. Pose coordinates and all
  // analysis inputs remain exactly as they are.
  const FADE_IN_MS = 180;
  const FADE_OUT_MS = 220;
  let visualOpacity = {};
  let lastDrawTime = null;


  /*
    Convert MediaPipe normalized coordinates:

      x = 0..1
      y = 0..1

    into canvas pixels.

    IMPORTANT:
    We do NOT mirror here.

    The video/canvas should use the same visual orientation.
  */
  function toPx(pose, w, h, videoW, videoH) {

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

    if (!point || point.length < 2) {
      P[key] = null;
      return;
    }

    P[key] = [
  point[0] * displayedW + offsetX,
  point[1] * displayedH + offsetY
];
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


  function alphaFor(appearance, joint) {
    const value = appearance?.[joint];
    return Number.isFinite(value)
      ? Math.max(0, Math.min(1, value))
      : 1;
  }

  function updateAppearance(pose, visibility) {
    const now = performance.now();
    const dt = lastDrawTime === null
      ? 1000 / 60
      : Math.min(80, Math.max(0, now - lastDrawTime));
    lastDrawTime = now;

    const hasVisibility = !!visibility && Object.keys(visibility).length > 0;
    const joints = new Set([
      ...Object.keys(visualOpacity),
      ...Object.keys(pose || {})
    ]);

    joints.forEach(joint => {
      const point = pose?.[joint];
      const reliable = hasVisibility
        ? Number.isFinite(visibility[joint]) && visibility[joint] > 0
        : Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
      const current = visualOpacity[joint] ?? 0;
      const target = reliable ? 1 : 0;
      const step = dt / (target > current ? FADE_IN_MS : FADE_OUT_MS);

      visualOpacity[joint] = target > current
        ? Math.min(1, current + step)
        : Math.max(0, current - step);
    });

    return visualOpacity;
  }

  function drawLine(ctx, P, a, b, color, width, opacity = 1) {

    if (!validPoint(P, a) || !validPoint(P, b) || opacity <= 0.01) {
      return;
    }

    ctx.save();
    ctx.globalAlpha *= opacity;
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
    ctx.restore();
  }


  function drawJoint(ctx, point, color, radius, opacity = 1) {

    if (!point || opacity <= 0.01) return;

    ctx.save();
    ctx.globalAlpha *= opacity;
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
    ctx.restore();
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
    appearance
  ) {

    if (!ctx || !pose) return;

const P = toPx(
  pose,
  w,
  h,
  window.__formaVideoWidth,
  window.__formaVideoHeight
);
    appearance = updateAppearance(pose, appearance);

    /*
      Head
    */
    const headOpacity = alphaFor(appearance, 'head');
    if (validPoint(P, 'head') && headOpacity > 0.01) {

      ctx.save();
      ctx.globalAlpha = headOpacity;
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
      ctx.restore();
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
          5,
          Math.min(alphaFor(appearance, a), alphaFor(appearance, b))
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
          5,
          alphaFor(appearance, joint)
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

  function reset() {
    visualOpacity = {};
    lastDrawTime = null;
    palette = null;
  }


  return {
    drawUser,
    drawOptimal,
    reset
  };

})();
