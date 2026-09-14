/* =====================================================================
   SKELETON RENDERER
   ---------------------------------------------------------------------
   Draws the joint/segment overlay on a canvas. Two skeletons can be
   drawn on the same canvas: the user's (colour-coded per body part —
   🟢/🟡/🔴) and the "optimal technique" reference (single contrasting
   colour, dashed), for the comparison mode in spec §11/§12.
   ===================================================================== */

const SkeletonRenderer = (function(){

  function cssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function colorFor(sev){ return sev==='bad'? cssVar('--bad') : sev==='warn'? cssVar('--warn') : cssVar('--good'); }

  const SEGMENTS = [
    ['neck','lshoulder','shoulders'], ['neck','rshoulder','shoulders'],
    ['lshoulder','lhip','spine'], ['rshoulder','rhip','spine'],
    ['lhip','rhip','hips'],
    ['lshoulder','lelbow','leftElbow'], ['lelbow','lwrist','leftElbow'],
    ['rshoulder','relbow','rightElbow'], ['relbow','rwrist','rightElbow'],
    ['lhip','lknee','leftKnee'], ['lknee','lankle','leftKnee'],
    ['rhip','rknee','rightKnee'], ['rknee','rankle','rightKnee'],
  ];
  const JOINT_PART = {
    lelbow:'leftElbow', relbow:'rightElbow', lknee:'leftKnee', rknee:'rightKnee',
    lwrist:'leftWrist', rwrist:'rightWrist', lshoulder:'shoulders', rshoulder:'shoulders',
    lhip:'hips', rhip:'hips', lankle:'leftKnee', rankle:'rightKnee'
  };

  function toPx(pose, w, h){
    const P = {};
    Object.keys(pose).forEach(k=>{ P[k] = [pose[k][0]*w, pose[k][1]*h]; });
    return P;
  }

  /** Colour-coded user skeleton — segColors: { partName: 'good'|'warn'|'bad' } */
  function drawUser(ctx, w, h, pose, segColors){
    const P = toPx(pose, w, h);
    ctx.strokeStyle = cssVar('--text-dim'); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(P.head[0], P.head[1], 14, 0, Math.PI*2); ctx.stroke();

    SEGMENTS.forEach(([a,b,part])=>{
      ctx.strokeStyle = colorFor((segColors||{})[part]); ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(...P[a]); ctx.lineTo(...P[b]); ctx.stroke();
    });
    Object.keys(JOINT_PART).forEach(j=>{
      ctx.fillStyle = colorFor((segColors||{})[JOINT_PART[j]]);
      ctx.beginPath(); ctx.arc(P[j][0], P[j][1], 5, 0, Math.PI*2); ctx.fill();
    });
  }

  /** Single-colour dashed reference skeleton (the "optimal technique" overlay) */
  function drawOptimal(ctx, w, h, pose){
    const P = toPx(pose, w, h);
    const c = cssVar('--optimal');
    ctx.setLineDash([6,5]);
    ctx.strokeStyle = c; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(P.head[0], P.head[1], 14, 0, Math.PI*2); ctx.stroke();
    SEGMENTS.forEach(([a,b])=>{
      ctx.beginPath(); ctx.moveTo(...P[a]); ctx.lineTo(...P[b]); ctx.stroke();
    });
    ctx.setLineDash([]);
    Object.keys(JOINT_PART).forEach(j=>{
      ctx.fillStyle = c; ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(P[j][0], P[j][1], 4, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  return { drawUser, drawOptimal };
})();
