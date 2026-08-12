"use strict";
/* ================================================================
 * TARGET — where the white dot is, and how fast it is moving
 * ================================================================
 * Needs:    nothing
 * Provides: dotPosition, dotVelocity
 *
 * Lissajous-style sum of sines per axis, computed in normalized
 * [0,1]x[0,1] coordinates so window resizes never change the shape of the
 * trajectory. Amplitude check:
 *   x: 0.5 ± (0.32 + 0.11) → [0.07, 0.93]   (≥ 5% from each edge)
 *   y: 0.5 ± (0.30 + 0.12) → [0.08, 0.92]   (≥ 5% from each edge)
 */
function dotPosition(t) {
  return {
    nx: 0.5 + 0.32 * Math.sin(0.31 * t) + 0.11 * Math.sin(0.83 * t + 1.2),
    ny: 0.5 + 0.30 * Math.sin(0.23 * t + 0.7) + 0.12 * Math.sin(0.67 * t),
  };
}

// Analytic time-derivative of dotPosition, in normalized units/s (callers
// scale by W and H to get CSS px/s). The target's velocity is known in
// closed form, so there is no reason to finite-difference it.
function dotVelocity(t) {
  return {
    dnx: 0.32 * 0.31 * Math.cos(0.31 * t) + 0.11 * 0.83 * Math.cos(0.83 * t + 1.2),
    dny: 0.30 * 0.23 * Math.cos(0.23 * t + 0.7) + 0.12 * 0.67 * Math.cos(0.67 * t),
  };
}
