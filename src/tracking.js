"use strict";
/* ================================================================
 * TRACKING — filter state, trails, and pointer input
 * ================================================================
 * Needs:    config.js, util.js (gaussian), kalman.js, canvas.js
 * Provides: kfX, kfY, dotT, paused, pointerOver, pendingObs, lastNow,
 *           the three trails, clearTrails, pushTrail
 *
 * The pointer handler produces ONE noisy reading per event and hands the
 * same coordinates to everything downstream: the position filters, both
 * velocity estimators, and through them the attention layer. One sensor,
 * one reading — not two independently corrupted copies of the truth.
 *
 * The clean coordinates are kept alongside, but only so a stationary
 * cursor can be re-observed with FRESH noise (see velocity.js); nothing
 * estimates anything from them directly.
 */

const kfX = new KF1D();
const kfY = new KF1D();

let dotT = 0;             // dot-motion time, s — advances only while unpaused
let paused = false;
let pointerOver = false;  // false → predict-only coasting, metrics frozen
let pendingObs = null;    // most recent noisy sample since last frame, {x, y}
let lastNow = performance.now();

// Trails: explicit point arrays, oldest first (no translucent-rect fade —
// it ghosts).
const trueTrail = [];
const obsTrail = [];
const estTrail = [];

function clearTrails() {
  trueTrail.length = 0;
  obsTrail.length = 0;
  estTrail.length = 0;
}

function pushTrail(trail, x, y) {
  trail.push({ x, y });
  if (trail.length > TRAIL_LEN) trail.shift();
}

/* ---------------- input ----------------
 * Gaussian noise (std sigma_n) is added ONCE, at sample time, and the same
 * corrupted coordinates go to every consumer. The noisy value is what the
 * filters see and what is drawn as the observation marker; nothing
 * downstream has access to the true cursor position. Only the most recent
 * sample per frame is kept; intermediates are discarded.
 */
canvas.addEventListener("pointermove", (e) => {
  pointerOver = true;
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // One draw, shared. Giving the position filter and the velocity
  // estimators independent draws would model two sensors watching one hand,
  // which is not what this demo is about.
  const nx = cx + gaussian() * params.sigmaN;
  const ny = cy + gaussian() * params.sigmaN;
  pendingObs = { x: nx, y: ny };
  // The velocity estimators need a timestamp; they also need the clean
  // coordinates carried along, because a parked cursor is re-observed with
  // fresh noise rather than by repeating this exact reading (velocity.js).
  pendingSample = { x: nx, y: ny, t: performance.now() / 1000, cx, cy };
});

canvas.addEventListener("pointerleave", () => {
  pointerOver = false;
  pendingObs = null;
  // Attention layer: a window the pointer left is not a valid observation.
  pendingSample = null;
  lastSample = null;
  winBroken = true;
  // Drop both velocity estimators so they rebuild from the next sample.
  // Left running, the filter would integrate its last velocity through the
  // whole absence — metres of phantom travel — and the correction on
  // re-entry would produce a wild velocity spike. A Savitzky-Golay window
  // straddling the gap is invalid for the same reason: it would fit a line
  // through two positions minutes apart and call the slope a velocity.
  cursorKFX.initialized = false;
  cursorKFY.initialized = false;
  resetAdaptiveR();
  sgReset();
});
