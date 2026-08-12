"use strict";
/* ================================================================
 * CONFIG — every tunable number in one place
 * ================================================================
 * Needs:    nothing (loaded first)
 * Provides: params, tracking constants, attention constants, colours
 *
 * All positions and noise values are in CSS pixels. `params` holds the
 * live slider values; everything reads them fresh each frame so slider
 * changes take effect immediately.
 *
 * Note on defaults: the filter performs best when the measurement noise
 * it assumes (sigma_r) matches the noise actually injected into the
 * samples (sigma_n). The defaults match on purpose (25 px each), and the
 * sliders let the user break that match to explore the failure modes.
 */

const params = {
  sigmaN: 25,   // injected Gaussian noise std, px (what we corrupt samples with)
  sigmaA: 300,  // process noise std, px/s^2 (white-noise acceleration)
  sigmaR: 25,   // measurement noise std the FILTER assumes, px
};

/* ---------------- tracking ---------------- */
const TRAIL_LEN = 90;        // points kept per trail
const RMSE_WINDOW = 300;     // frames in the rolling RMSE window
const DT_MIN = 0.001;        // s — guard against zero/negative deltas
const DT_MAX = 0.05;         // s — larger raw gaps (tab switch) clamp here and clear trails
const P_INIT = 500 * 500;    // initial variance for both state entries
const P_CAP = 1e6;           // cap on P's diagonal while coasting so it can't blow up

/* ---------------- cursor velocity filter ---------------- */
// Position is observed, velocity is latent. sigma_a is the knob: too low
// and the velocity estimate lags real hand movements, damping the mismatch
// signal; too high and it tracks the quantisation jitter instead. A hand
// can cross a 900 px canvas in about half a second, so it accelerates hard.
const CURSOR_SIGMA_A = 2000;   // px/s² — process noise (hand acceleration)
const CURSOR_SIGMA_R = 3;      // px — measurement noise (pointer quantisation)
// Observations computed from a velocity estimate less certain than this are
// discarded; sqrt(p11) is large for a moment after the pointer returns to
// the canvas. Set from measurement — see README.
const CURSOR_V_SD_MAX = 120;   // px/s

/* ---------------- attention readout ---------------- */
const ATT_WINDOW = 0.5;   // s of pointer-over time per observation (~2 Hz)
const ZWIN = 4;           // observations in the rolling-median score window
                          // (4 x 0.5 s = 2 s of history)
const ATT_MIN_FRAMES = 10;// windows with fewer mismatch samples are skipped
const ATT_LAG = 0.150;    // s: compare against where the target was 150 ms
                          // ago, so normal human reaction delay does not
                          // read as inattention.
const ATT_STILL_S = 0.1;  // s of pointer silence before we call it "at rest"
const CAL_TOTAL = 10;     // s of calibration
const CAL_DISCARD = -3;   // s discarded at the start (settling in)
const ATT_GAP_S = 2.0;    // s without observations that counts as a gap
const OFF_ENTER = -2.0;   // hysteresis: OFF-TASK below this for OFF_DWELL s…
const OFF_EXIT = -1.0;    // …and back ON above this
const OFF_DWELL = 2.0;    // s the score must stay below OFF_ENTER to trigger
const CHART_SPAN = 60;    // s of history shown in the strip chart
const CHART_Y_MAX = 3, CHART_Y_MIN = -6; // fixed chart y-range
const LOG_CAP = 50000;    // max in-memory log rows

/* ---------------- velocity arrows ---------------- */
// Both velocity vectors are drawn from the same origin, so the gap between
// their tips is exactly the mismatch the attention score is computed from.
// Typical speeds here run 20–200 px/s, so 0.6 keeps the slow cases legible
// (20 px/s still draws 12 px) without the fast ones leaving the canvas.
// Deliberately uncapped: clamping the length would break the property that
// the gap between the arrowheads equals the mismatch.
const VEL_ARROW_SCALE = 0.6;   // px drawn per px/s of velocity
const VEL_ARROW_MIN = 4;       // px — shorter than this, draw no arrowhead

/* ---------------- palette (shared by both canvases) ---------------- */
const COL_TRUE = "#ffffff";
const COL_OBS = "#ff9f43";
const COL_EST = "#22d3ee";
const COL_VEL_USER = "#a78bfa";  // violet — distinct from white/orange/cyan
const COL_MISMATCH = "#fbbf24";  // amber — the same colour "attention lapse"
                                 // uses, so a widening gap reads as one
