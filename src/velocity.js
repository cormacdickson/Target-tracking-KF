"use strict";
/* ================================================================
 * VELOCITY — the shared sample stream feeding both estimators
 * ================================================================
 * Needs:    config.js (ATT_STILL_S), util.js (gaussian),
 *           cursor.js (updateCursorFilter), savgol.js (sgPush),
 *           tracking.js (pointerOver), attention.js (pendingSample, lastSample)
 * Provides: nextCleanSample, updateVelocityEstimators
 *
 * The Kalman filter and the Savitzky-Golay fit are meant to be compared, so
 * they must see exactly the same input. Sample selection therefore happens
 * ONCE, here, and the result is handed to both — rather than each estimator
 * pulling from `pendingSample` itself, where one could quietly consume a
 * sample the other never saw and make the whole comparison meaningless.
 *
 * These samples carry the injected noise, the same reading the position
 * filter gets. That is the point: on clean input both estimators sit far
 * below the noise floor and agree to within a few px/s, so there is nothing
 * to compare.
 */

// The sample for this frame: a fresh pointer event if one arrived, otherwise
// a re-observation of the last known position if the pointer is still over
// the canvas but has gone quiet. Null when there is nothing to say.
function nextCleanSample(nowS) {
  if (pendingSample !== null) {
    lastSample = pendingSample;
    pendingSample = null;
    return lastSample;
  }

  // Pointer events fire only on MOTION, so silence from a pointer that is
  // still over the canvas means it has not moved. Re-observing the last
  // position is a true statement about the world, and both estimators work
  // out for themselves that the velocity must be zero.
  //
  // This matters: the filter's predict() advances position but leaves
  // velocity untouched, so without these repeats a cursor stopped dead would
  // report its last travelling speed forever and a lapse would never be
  // detected. The SG fit would freeze on a stale window for the same reason.
  if (pointerOver && lastSample !== null && nowS - lastSample.t > ATT_STILL_S) {
    // FRESH noise on the clean position, not a copy of the last reading. A
    // real sensor keeps producing new readings from a still hand, and the
    // difference is not cosmetic: repeating one value drives the innovations
    // to zero, which drags the adaptive sigma_r estimate in cursor.js down to
    // its floor and leaves the filter badly mistuned the moment the hand
    // moves again.
    //
    // A NEW object, stamped with the current time. Two things depend on that:
    // the SG fit needs its window to span real time (identical timestamps
    // collapse the span and make the normal equations singular), and
    // lastSample.t must keep its ORIGINAL stamp, since that is what the
    // silence test one line above measures against. Mutating lastSample would
    // break both at once.
    return {
      x: lastSample.cx + gaussian() * params.sigmaN,
      y: lastSample.cy + gaussian() * params.sigmaN,
      t: nowS,
      cx: lastSample.cx, cy: lastSample.cy,
    };
  }

  return null;
}

// Called once per unpaused frame, before the attention pipeline reads either
// estimator.
function updateVelocityEstimators(dt) {
  const obs = nextCleanSample(performance.now() / 1000);
  updateCursorFilter(dt, obs);
  sgPush(obs);
}
