"use strict";
/* ================================================================
 * MAIN — the animation loop, and the one place everything meets
 * ================================================================
 * Needs:    every other file (loaded before this one)
 * Provides: pendingObsDrawn, frame(), and the startup call
 *
 * Read this file first if you want the shape of the demo: one
 * requestAnimationFrame loop that advances the dot, steps the two Kalman
 * filters, updates the metrics, runs the attention pipeline, and draws.
 */

let pendingObsDrawn = null; // last observation, kept around for drawing

function frame(now) {
  requestAnimationFrame(frame);

  // dt from performance.now() deltas. A raw gap beyond DT_MAX (tab switch,
  // long stall) clamps to DT_MAX and clears the trails, which would
  // otherwise show a long straight teleport segment.
  const rawDt = (now - lastNow) / 1000;
  lastNow = now;
  let dt = rawDt;
  if (dt > DT_MAX) {
    dt = DT_MAX;
    clearTrails();
  }
  dt = Math.max(DT_MIN, dt);

  if (!paused) {
    // --- advance the dot ---
    dotT += dt;
    const { nx, ny } = dotPosition(dotT);
    const trueX = nx * W;
    const trueY = ny * H;
    pushTrail(trueTrail, trueX, trueY);

    // --- filter: predict every frame ---
    if (kfX.initialized && kfY.initialized) {
      kfX.predict(dt, params.sigmaA);
      kfY.predict(dt, params.sigmaA);
    }

    // --- filter: update only if a fresh sample arrived this frame ---
    if (pendingObs !== null) {
      if (kfX.initialized && kfY.initialized) {
        kfX.update(pendingObs.x, params.sigmaR);
        kfY.update(pendingObs.y, params.sigmaR);
      } else {
        // First sample (or recovery): initialize instead of updating.
        kfX.init(pendingObs.x);
        kfY.init(pendingObs.y);
      }
      pendingObsDrawn = pendingObs;
      pushTrail(obsTrail, pendingObs.x, pendingObs.y);
      pendingObs = null;
    }

    // --- numerical guard: reinitialize from the next sample if broken ---
    if (kfX.initialized && kfY.initialized && !(kfX.isHealthy() && kfY.isHealthy())) {
      kfX.initialized = false;
      kfY.initialized = false;
      pendingObsDrawn = null;
      clearTrails();
      resetMetrics();
    }

    if (kfX.initialized && kfY.initialized) {
      pushTrail(estTrail, kfX.pos, kfY.pos);

      // --- metrics: only while the pointer is over the canvas ---
      if (pointerOver && pendingObsDrawn) {
        const dox = pendingObsDrawn.x - trueX, doy = pendingObsDrawn.y - trueY;
        const dex = kfX.pos - trueX, dey = kfY.pos - trueY;
        pushWindow(obsSqErr, dox * dox + doy * doy, RMSE_WINDOW);
        pushWindow(estSqErr, dex * dex + dey * dey, RMSE_WINDOW);
      }
    }

    // --- both velocity estimators, then the attention pipeline that reads
    //     them. All of this runs on the CLEAN cursor path and never sees
    //     the injected noise. ---
    updateVelocityEstimators(dt);
    attentionFrame(dt);

    draw(trueX, trueY);
    renderMetrics();
  } else {
    // Paused: dot, filter, and metrics are frozen, but rAF keeps rendering.
    // lastNow still advances every frame above, so resuming has no dt spike.
    const { nx, ny } = dotPosition(dotT);
    draw(nx * W, ny * H);
  }

  // The attention panel renders every frame; while paused its clock is
  // frozen, so the chart simply holds still.
  drawAttChart();
  renderAttHeader();
}

/* ---------------- start ---------------- */
resizeCanvas();
resizeAttCanvas();
lastNow = performance.now();
requestAnimationFrame(frame);
