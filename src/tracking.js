"use strict";
/* ================================================================
 * TRACKING — filter state, trails, and pointer input
 * ================================================================
 * Needs:    config.js, util.js (gaussian), kalman.js, canvas.js
 * Provides: kfX, kfY, dotT, paused, pointerOver, pendingObs, lastNow,
 *           the three trails, clearTrails, pushTrail
 *
 * The pointer handler is where the demo's central split happens: the
 * CLEAN cursor position goes to the attention layer, the NOISY one goes
 * to the Kalman filters. Neither ever sees the other's copy.
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
 * Gaussian noise (std sigma_n) is added ONCE, at sample time. The noisy
 * value is both what the filter sees and what is drawn as the observation
 * marker — the filter never sees the clean cursor. Only the most recent
 * sample per frame is kept; intermediates are discarded.
 */
canvas.addEventListener("pointermove", (e) => {
  pointerOver = true;
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // Clean sample for the attention layer, stored BEFORE noise is added —
  // the attention layer reads the human, so it must never see the
  // injected noise. The tracking filter sees only the noisy sample below.
  pendingClean = { x: cx, y: cy, t: performance.now() / 1000 };
  pendingObs = {
    x: cx + gaussian() * params.sigmaN,
    y: cy + gaussian() * params.sigmaN,
  };
});

canvas.addEventListener("pointerleave", () => {
  pointerOver = false;
  pendingObs = null;
  // Attention layer: a window the pointer left is not a valid observation.
  pendingClean = null;
  lastClean = null;
  winBroken = true;
  // Drop the cursor velocity filter so it re-initialises from the next
  // sample. Left running it would integrate its last velocity through the
  // whole absence — metres of phantom travel — and the correction on
  // re-entry would produce a wild velocity spike.
  cursorKFX.initialized = false;
  cursorKFY.initialized = false;
});
