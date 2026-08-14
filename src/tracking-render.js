"use strict";
/* ================================================================
 * TRACKING RENDER — everything drawn on the main canvas
 * ================================================================
 * Needs:    config.js (colours), canvas.js (ctx, W, H), tracking.js
 *           (trails, kfX/kfY, pointerOver, dotT), target.js (dotVelocity),
 *           attention.js (attSG, attKF — at runtime),
 *           main.js (pendingObsDrawn, at runtime)
 * Provides: draw(), showPosition, velSource, plus the drawing primitives
 */

// Whether to draw the position-denoising layer (orange observations, cyan
// estimate). Toggled by the button wired in ui.js. This is purely a
// rendering flag — the filter itself keeps running either way, so the RMSE
// figures are live the moment the layer is switched back on.
let showPosition = false;

// Which velocity estimator the arrows show. Defaults to the source that
// drives the on-task verdict, so what you see is what is being judged.
let velSource = "savgol";

// Resolved at call time, not load time: attention.js loads after this file.
// Going through the attention source object rather than calling sgVelocity()
// or cursorVelocity() directly is deliberate — the arrow then cannot drift
// out of agreement with the chart line, because both read the same object.
function activeVelSource() {
  return velSource === "savgol" ? attSG : attKF;
}

// Trail as a polyline of individually stroked segments so alpha can fade
// from `maxAlpha` at the newest point down to 0 at the oldest.
function drawTrail(trail, color, maxAlpha, lineWidth) {
  const n = trail.length;
  if (n < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  for (let i = 1; i < n; i++) {
    ctx.globalAlpha = maxAlpha * (i / (n - 1));
    ctx.beginPath();
    ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
    ctx.lineTo(trail[i].x, trail[i].y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Observation trail drawn as scattered points, not a polyline — it should
// read as noise scatter, not a path.
function drawScatter(trail, color, maxAlpha, radius) {
  const n = trail.length;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = maxAlpha * ((i + 1) / n);
    ctx.beginPath();
    ctx.arc(trail[i].x, trail[i].y, radius, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawCircle(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fill();
}

function drawXMark(x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
  ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y - r);
  ctx.stroke();
}

// A line with a small triangular head. Below VEL_ARROW_MIN the head is
// skipped: a stationary hand produces a near-zero vector, and that should
// degenerate to a dot rather than a spray of arrowhead geometry.
function drawArrow(x0, y0, dx, dy, color, width) {
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len)) return;
  const tipX = x0 + dx, tipY = y0 + dy;

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  if (len < VEL_ARROW_MIN) return;

  const ux = dx / len, uy = dy / len;   // along the arrow
  const px = -uy, py = ux;              // perpendicular to it
  const head = Math.min(9, len * 0.4);
  const baseX = tipX - head * ux, baseY = tipY - head * uy;
  const half = head * 0.4;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX + half * px, baseY + half * py);
  ctx.lineTo(baseX - half * px, baseY - half * py);
  ctx.closePath();
  ctx.fill();
}

// The two velocity vectors, drawn from a common origin at the cursor. This
// is the picture of what the attention score actually measures: the amber
// segment joining the tips IS the mismatch.
function drawVelocityArrows() {
  const src = activeVelSource();
  const v = src.velFn();
  if (v === null || !pointerOver) return;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return;

  // Both modes share this origin, so switching sources changes only the
  // vector under comparison and not where it is anchored.
  const ox = cursorKFX.pos, oy = cursorKFY.pos;
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;

  // The target's velocity as the attention layer sees it FOR THIS SOURCE:
  // ATT_LAG plus however far in the past this estimator's answer refers to.
  // Using a shared ATT_LAG reference would quietly break the invariant that
  // the connector below is the mismatch — a lagged Savitzky-Golay estimate
  // would be drawn against a target instant it was never compared to.
  const tv = dotVelocity(dotT - ATT_LAG - src.lagFn());
  const tdx = tv.dnx * W * VEL_ARROW_SCALE, tdy = tv.dny * H * VEL_ARROW_SCALE;
  const udx = v.x * VEL_ARROW_SCALE, udy = v.y * VEL_ARROW_SCALE;

  // Mismatch connector first, so the arrows draw over it.
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = COL_MISMATCH;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(ox + tdx, oy + tdy);
  ctx.lineTo(ox + udx, oy + udy);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.globalAlpha = 0.75;
  drawArrow(ox, oy, tdx, tdy, COL_TRUE, 2);
  ctx.globalAlpha = 1;
  drawArrow(ox, oy, udx, udy, src.color, 2.5);
}

function drawLegend() {
  // Only list what is actually on screen.
  const src = activeVelSource();
  const entries = [
    { color: COL_TRUE, label: "true target" },
    ...(showPosition ? [
      { color: COL_OBS, label: "noisy observation" },
      { color: COL_EST, label: "Kalman estimate" },
    ] : []),
    { color: src.color, label: "your velocity (" + src.label + ")" },
    { color: COL_MISMATCH, label: "velocity mismatch" },
  ];
  ctx.font = "13px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  let y = 48; // clears the calibration banner across the top of the canvas
  for (const e of entries) {
    drawCircle(16, y, 5, e.color);
    ctx.fillStyle = "rgba(216, 216, 232, 0.8)";
    ctx.fillText(e.label, 28, y);
    y += 20;
  }
}

function drawOverlay(text) {
  ctx.fillStyle = "rgba(26, 26, 46, 0.6)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(216, 216, 232, 0.9)";
  ctx.font = "18px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, W / 2, H / 2);
  ctx.textAlign = "start";
}

function draw(trueX, trueY) {
  ctx.clearRect(0, 0, W, H);

  drawTrail(trueTrail, COL_TRUE, 0.6, 2);

  if (showPosition) {
    drawScatter(obsTrail, COL_OBS, 0.35, 2);
    drawTrail(estTrail, COL_EST, 0.6, 2);

    // Thin cyan line from the estimate to the true dot: the current error.
    if (kfX.initialized && kfY.initialized) {
      ctx.strokeStyle = COL_EST;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(kfX.pos, kfY.pos);
      ctx.lineTo(trueX, trueY);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  drawCircle(trueX, trueY, 10, COL_TRUE);

  if (showPosition) {
    if (pendingObsDrawn) drawXMark(pendingObsDrawn.x, pendingObsDrawn.y, 4, COL_OBS);
    if (kfX.initialized && kfY.initialized) drawCircle(kfX.pos, kfY.pos, 7, COL_EST);
  }

  // Arrows on top of the dots: this is the attention layer made visible.
  drawVelocityArrows();

  drawLegend();

  if (!(kfX.initialized && kfY.initialized)) {
    drawOverlay("move your cursor to start");
  }
}
