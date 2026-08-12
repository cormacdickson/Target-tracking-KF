"use strict";
/* ================================================================
 * CURSOR — estimating how fast the user's hand is actually moving
 * ================================================================
 * Needs:    config.js (CURSOR_*), kalman.js (KF1D), tracking.js
 *           (pendingClean, lastClean, pointerOver)
 * Provides: cursorKFX, cursorKFY, updateCursorFilter, cursorVelocity,
 *           cursorVelSd
 *
 * Pointer events give position; the attention layer needs velocity. That
 * is a latent-state problem, which is exactly what a Kalman filter is
 * for — and unlike an estimate of "attention", every assumption here is
 * literally true: position really is the integral of velocity, and the
 * measurement noise really is pointer coordinate quantisation.
 *
 * Reading `.vel` gives a velocity that no single pair of samples can
 * supply, and `.p11` gives the variance of that velocity — the basis for
 * the gate in attention.js that discards observations made while the
 * estimate is untrustworthy.
 *
 * This is the CLEAN cursor path: these filters see the true pointer
 * position, never the injected noise. (The tracking filters in main.js
 * see only the noisy copy.)
 */
const cursorKFX = new KF1D();
const cursorKFY = new KF1D();

// Called once per unpaused frame, before the attention pipeline runs.
function updateCursorFilter(dt) {
  if (cursorKFX.initialized) {
    cursorKFX.predict(dt, CURSOR_SIGMA_A);
    cursorKFY.predict(dt, CURSOR_SIGMA_A);
  }

  // A fresh sample is the normal case; otherwise, if the pointer is still
  // over the canvas but has gone quiet, it is genuinely sitting still.
  let obs = null;
  if (pendingClean !== null) {
    obs = pendingClean;
    lastClean = pendingClean;
    pendingClean = null;
  } else if (pointerOver && lastClean !== null &&
             performance.now() / 1000 - lastClean.t > ATT_STILL_S) {
    // Pointer events fire only on MOTION, so silence from a pointer that
    // is still over the canvas means it has not moved. Re-observing the
    // last position is a true statement about the world, and the filter
    // works out for itself that the velocity must be zero.
    //
    // This matters: predict() alone advances position but leaves velocity
    // untouched, so without these repeat observations a cursor stopped
    // dead would report its last travelling speed forever, and a lapse
    // would never be detected.
    obs = lastClean;
  }

  if (obs !== null) {
    if (cursorKFX.initialized) {
      cursorKFX.update(obs.x, CURSOR_SIGMA_R);
      cursorKFY.update(obs.y, CURSOR_SIGMA_R);
    } else {
      cursorKFX.init(obs.x);
      cursorKFY.init(obs.y);
    }
  }

  // Guard against a numerical fault, matching the tracking filters.
  if (cursorKFX.initialized && !(cursorKFX.isHealthy() && cursorKFY.isHealthy())) {
    cursorKFX.initialized = false;
    cursorKFY.initialized = false;
  }
}

// Hand velocity in CSS px/s, or null before the first sample.
function cursorVelocity() {
  return cursorKFX.initialized
    ? { x: cursorKFX.vel, y: cursorKFY.vel }
    : null;
}

// Standard deviation of that velocity estimate, in px/s. Large right after
// the pointer returns from off-canvas, small once updates have settled.
function cursorVelSd() {
  return Math.sqrt(Math.max(cursorKFX.p11, cursorKFY.p11));
}
