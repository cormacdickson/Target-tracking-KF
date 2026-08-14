"use strict";
/* ================================================================
 * CURSOR — estimating how fast the user's hand is actually moving
 * ================================================================
 * Needs:    config.js (CURSOR_*, ADAPT_*), util.js (median, mad),
 *           kalman.js (KF1D)
 * Provides: cursorKFX, cursorKFY, updateCursorFilter, cursorVelocity,
 *           cursorVelSd, sigmaRHat, resetAdaptiveR
 *
 * Pointer events give position; the attention layer needs velocity. That
 * is a latent-state problem, which is exactly what a Kalman filter is
 * for — and unlike an estimate of "attention", every assumption here is
 * literally true: position really is the integral of velocity, and the
 * measurement noise really is measurement noise.
 *
 * Reading `.vel` gives a velocity that no single pair of samples can
 * supply, and `.p11` gives the variance of that velocity — the basis for
 * the gate in attention.js that discards observations made while the
 * estimate is untrustworthy.
 *
 * Sample SELECTION lives in velocity.js, which hands the same `obs` to this
 * filter and to the Savitzky-Golay fit — the two are compared on the
 * attention chart, so they must never see different data. Those samples
 * carry the injected noise.
 *
 * ADAPTIVE MEASUREMENT NOISE — see below. The filter works out how noisy
 * its own input is instead of being told, which is the whole reason it can
 * stay tuned while the sigma_n slider moves. It is also the sharpest
 * difference between the two estimators on the chart: the Savitzky-Golay
 * fit has no equivalent mechanism.
 */
const cursorKFX = new KF1D();
const cursorKFY = new KF1D();

/* ---------------- adaptive measurement noise ----------------
 * The innovation y = z - Hx has variance S = p00_prior + R, so measuring
 * the spread of the innovations and subtracting the part the filter already
 * accounts for leaves an estimate of R:
 *
 *     R = S - p00_prior
 *
 * Deliberately estimated from the data rather than read off params.sigmaN.
 * Reading the slider would hand the filter the answer, and would do nothing
 * for noise arriving from anywhere other than our own noise generator.
 *
 * Two details that are not optional:
 *
 *  - The spread is measured with MAD, not variance. Real hand acceleration
 *    produces genuine innovation spikes, and a plain variance would read
 *    those as measurement noise and over-smooth exactly when the hand is
 *    doing something interesting.
 *  - sigma_r moves by a slow EMA. R and P feed each other — a bigger R
 *    lowers the gain, which raises p00, which lowers the next R estimate —
 *    and updating in one step makes that loop ring instead of settle.
 *
 * Both axes share one window. The injected noise is isotropic, so x and y
 * are independent draws from the same process, and pooling reaches a stable
 * estimate in half the time.
 *
 * The estimate runs slightly LOW, and most so near the quantisation floor:
 * measured bias is -1.5% at sigma_n=60, -3% at 25, -9% at 10 and -20% at 5.
 * Two causes, both inherent: underestimating R raises the gain, which makes
 * the filter chase its own measurements and shrinks the next innovation; and
 * the max() floor below truncates the estimate from one side only. It costs
 * little — velocity error stays within 25% of an oracle-tuned filter at
 * every noise level — but it is a bias, not scatter, so averaging longer
 * will not remove it.
 *
 * THE LIMITATION, stated plainly: this cannot distinguish "the measurements
 * got noisier" from "the process model is wrong". Both inflate the
 * innovations, and nothing in the innovation sequence separates them. While
 * the hand stays inside CURSOR_SIGMA_A the estimate is accurate — measured,
 * a sweep at 0.7x the assumed acceleration leaves it sitting exactly on the
 * quantisation floor — but a hand accelerating at 4.8x the model drives it
 * to ~360 px, reading its own model error as sensor noise. ADAPT_SIGMA_R_MAX
 * bounds the damage rather than pretending to fix it. In practice the margin
 * is large: the target peaks at 136 px/s² against a model of 2000.
 */
let sigmaRHat = CURSOR_SIGMA_R_MIN;
let innovWin = [];    // recent innovations, both axes
let priorWin = [];    // the matching p00 BEFORE each update

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function resetAdaptiveR() {
  sigmaRHat = CURSOR_SIGMA_R_MIN;
  innovWin = [];
  priorWin = [];
}

function noteInnovation(innov, p00Prior) {
  innovWin.push(innov);
  priorWin.push(p00Prior);
  if (innovWin.length > ADAPT_WIN) { innovWin.shift(); priorWin.shift(); }
  if (innovWin.length < ADAPT_WIN) return;   // no estimate until the window is full

  const sHat = Math.pow(1.4826 * mad(innovWin), 2);
  const rHat = Math.max(sHat - mean(priorWin), CURSOR_SIGMA_R_MIN * CURSOR_SIGMA_R_MIN);
  const next = (1 - ADAPT_SLEW) * sigmaRHat + ADAPT_SLEW * Math.sqrt(rHat);
  if (Number.isFinite(next)) sigmaRHat = Math.min(next, ADAPT_SIGMA_R_MAX);
}

// Called once per unpaused frame with this frame's sample, or null if there
// was none.
function updateCursorFilter(dt, obs) {
  if (cursorKFX.initialized) {
    cursorKFX.predict(dt, CURSOR_SIGMA_A);
    cursorKFY.predict(dt, CURSOR_SIGMA_A);
  }

  // Truthiness rather than `!== null` so a missing argument behaves like
  // "no sample this frame" instead of throwing on obs.x.
  if (obs) {
    if (cursorKFX.initialized) {
      // p00 is read BEFORE the update: S = p00_prior + R is a statement
      // about the prediction the innovation was measured against.
      const priorX = cursorKFX.p00, priorY = cursorKFY.p00;
      const innovX = cursorKFX.update(obs.x, sigmaRHat);
      const innovY = cursorKFY.update(obs.y, sigmaRHat);
      noteInnovation(innovX, priorX);
      noteInnovation(innovY, priorY);
    } else {
      cursorKFX.init(obs.x);
      cursorKFY.init(obs.y);
    }
  }

  // Guard against a numerical fault, matching the tracking filters.
  if (cursorKFX.initialized && !(cursorKFX.isHealthy() && cursorKFY.isHealthy())) {
    cursorKFX.initialized = false;
    cursorKFY.initialized = false;
    resetAdaptiveR();
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

// How uncertain a settled filter is at the CURRENT noise level. The raw
// bound is only meaningful at CURSOR_SIGMA_R_MIN, so it is scaled by the
// measured sqrt(p11) ∝ sigma_r^0.27 law (see config.js) to stay a constant
// multiple of the filter's own settled uncertainty. Without this the gate
// rejects every observation once sigma_n passes about 55 px.
function cursorVelSdMax() {
  return CURSOR_V_SD_MAX *
         Math.pow(sigmaRHat / CURSOR_SIGMA_R_MIN, CURSOR_V_SD_EXP);
}
