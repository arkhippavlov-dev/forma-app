/* ============================================================
   FORMA — SKELETON RENDERER
   V0.2

   Real MediaPipe landmarks → canvas overlay

   Important:
   MediaPipe gives normalized coordinates based on the
   ORIGINAL video frame.

   The video on screen uses object-fit: cover.
   Therefore we reproduce the same scaling/cropping
   transformation before drawing the skeleton.

   Mirror is NOT handled here.
   Video and canvas should be mirrored together via CSS.
   ============================================================ */

const SkeletonRenderer = (function () {

  // ------------------------------------------------------------
  // CSS VARIABLES
  // ------------------------------------------------------------

  function cssVar(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }


  function colorFor(severity) {

    if (severity === 'bad') {
      return cssVar('--bad');
    }

    if (severity === 'warn') {
      return cssVar('--warn');
    }

    return cssVar('--good');
  }


  // ------------------------------------------------------------
  // SKELETON STRUCTURE
  // ------------------------------------------------------------

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


  // ------------------------------------------------------------
  // COORDINATE TRANSFORMATION
  // ------------------------------------------------------------

  /*
    MediaPipe coordinates:

      x = 0..1
      y = 0..1

    They describe the ORIGINAL video frame.

    But the video element on screen uses:

      object-fit: cover

    That means the original video is scaled until the entire
    canvas/container is covered, and the excess part is cropped.

    We reproduce exactly that transformation here.
  */

  function toPx(
    pose,
    canvasW,
    canvasH,
    videoW,
    videoH
  ) {

    const P = {};

    if (
      !videoW ||
      !videoH ||
      !canvasW ||
      !canvasH
    ) {
      return P;
    }


    /*
      Same logic as CSS object-fit: cover.

      We need the scale that makes the video large enough
      to completely cover the canvas.
    */

    const scale = Math.max(
      canvasW / videoW,
      canvasH / videoH
    );


    const displayedW =
      videoW * scale;

    const displayedH =
      videoH * scale;


    /*
      Because the displayed video can be larger than the
      canvas, part of it is cropped.

      Negative offset = cropped area.
    */

    const offsetX =
      (canvasW - displayedW) / 2;

    const offsetY =
      (canvasH - displayedH) / 2;


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


      /*
        Convert normalized MediaPipe coordinates
        into coordinates of the displayed video.
      */

      P[key] = [

        point[0] * displayedW
          + offsetX,

        point[1] * displayedH
          + offsetY

      ];

    });


    return P;
  }


  // ------------------------------------------------------------
  // VALIDATION
  // ------------------------------------------------------------

  function validPoint(P, name) {

    return (
      P &&
      P[name] &&
      Number.isFinite(P[name][0]) &&
      Number.isFinite(P[name][1])
    );
  }


  // ------------------------------------------------------------
  // DRAW LINE
  // ------------------------------------------------------------

  function drawLine(
    ctx,
    P,
    a,
    b,
    color,
    width
  ) {

    if (
      !validPoint(P, a) ||
      !validPoint(P, b)
    ) {
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


  // ------------------------------------------------------------
  // DRAW JOINT
  // ------------------------------------------------------------

  function drawJoint(
    ctx,
    point,
    color,
    radius
  ) {

    if (!point) {
      return;
    }


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


  // ------------------------------------------------------------
  // DRAW USER SKELETON
  // ------------------------------------------------------------

  function drawUser(
    ctx,
    w,
    h,
    pose,
    segColors,
    videoEl
  ) {

    if (
      !ctx ||
      !pose ||
      !videoEl
    ) {
      return;
    }


    const videoW =
      videoEl.videoWidth;

    const videoH =
      videoEl.videoHeight;


    if (
      !videoW ||
      !videoH
    ) {
      return;
    }


    const P = toPx(
      pose,
      w,
      h,
      videoW,
      videoH
    );


    // ----------------------------------------------------------
    // HEAD
    // ----------------------------------------------------------

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


    // ----------------------------------------------------------
    // BODY
    // ----------------------------------------------------------

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


    // ----------------------------------------------------------
    // JOINTS
    // ----------------------------------------------------------

    Object.keys(JOINT_PART).forEach(
      joint => {

        if (
          !validPoint(
            P,
            joint
          )
        ) {
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


  // ------------------------------------------------------------
  // DRAW OPTIMAL / REFERENCE SKELETON
  // ------------------------------------------------------------

  function drawOptimal(
    ctx,
    w,
    h,
    pose,
    videoEl
  ) {

    if (
      !ctx ||
      !pose ||
      !videoEl
    ) {
      return;
    }


    const videoW =
      videoEl.videoWidth;

    const videoH =
      videoEl.videoHeight;


    if (
      !videoW ||
      !videoH
    ) {
      return;
    }


    const P = toPx(
      pose,
      w,
      h,
      videoW,
      videoH
    );


    const optimalColor =
      cssVar('--optimal') || '#7C6CFF';


    // ----------------------------------------------------------
    // HEAD
    // ----------------------------------------------------------

    if (
      validPoint(
        P,
        'head'
      )
    ) {

      ctx.strokeStyle =
        optimalColor;

      ctx.lineWidth = 3;

      ctx.setLineDash([
        6,
        5
      ]);


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


    // ----------------------------------------------------------
    // REFERENCE SKELETON
    // ----------------------------------------------------------

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


    // ----------------------------------------------------------
    // RESTORE NORMAL LINE MODE
    // ----------------------------------------------------------

    ctx.setLineDash([]);


    // ----------------------------------------------------------
    // REFERENCE JOINTS
    // ----------------------------------------------------------

    Object.keys(JOINT_PART).forEach(
      joint => {

        if (
          !validPoint(
            P,
            joint
          )
        ) {
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


  // ------------------------------------------------------------
  // PUBLIC API
  // ------------------------------------------------------------

  return {

    drawUser,

    drawOptimal

  };

})();
