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

// Measurement noise is ESTIMATED at runtime rather than fixed (see cursor.js),
// because the samples now carry the injected noise as well as the pointer's
// own quantisation, and sigma_n is on a slider. A filter told 3 px while
// receiving 25 px is mistuned by 8x and chases the noise: measured velocity
// error 176.6 px/s against 36.6 px/s for a correctly tuned filter.
const CURSOR_SIGMA_R_MIN = 3;  // px — pointer quantisation: the floor, and the
                               // value the estimate starts from on a cold start
const ADAPT_WIN = 120;         // innovations kept, pooled across both axes —
                               // the injected noise is isotropic, so x and y
                               // are draws from one process and pooling halves
                               // the time to a stable estimate
const ADAPT_SLEW = 0.02;       // per-update EMA on sigma_r. R and P feed each
                               // other, so a one-step update makes the loop ring.
                               // Measured: converges in ~2.2 s after a slider
                               // step, settling with ~4.8 px of ripple
// Ceiling on the estimate. Innovation-based adaptation cannot tell "my
// measurements got noisier" from "my process model is wrong", and a hand
// accelerating past CURSOR_SIGMA_A produces large innovations either way —
// measured, a sweep at 4.8x the assumed acceleration drives the estimate to
// ~360 px. This never binds in normal use (the real target peaks at 136 px/s²,
// 15x under the model, and the sigma_n slider tops out at 60 px), but it stops
// a violent flick leaving the filter ignoring its data for the next few seconds.
const ADAPT_SIGMA_R_MAX = 150; // px

// Observations computed from a velocity estimate less certain than this are
// discarded; sqrt(p11) is large for a moment after the pointer returns to the
// canvas. The bound has to scale with the noise or it stops meaning anything:
// settled sqrt(p11) measured 56 → 79 → 100 → 126 px/s as sigma_n went
// 0 → 10 → 25 → 60, so a fixed 120 rejects EVERY observation at the top of the
// slider and the attention readout goes blank. Fitting those points gives the
// usual alpha-beta result, sqrt(p11) ∝ sigma_r^0.27, which keeps the gate at a
// constant ~2.1x of the filter's own settled uncertainty at every noise level.
const CURSOR_V_SD_MAX = 120;   // px/s, at CURSOR_SIGMA_R_MIN
const CURSOR_V_SD_EXP = 0.27;  // measured exponent for the scaling above

/* ---------------- Savitzky-Golay velocity ---------------- */
// The second velocity estimator, run in parallel with the cursor Kalman
// filter on exactly the same samples so the attention chart can compare them.
//
// Note the unit: the window is counted in SAMPLES, not seconds, so on a
// 120 Hz display it spans half the wall-clock time it does at 60 Hz — less
// smoothing, less lag, and a measurably different estimator. That is
// inherent to a fixed-length filter and is the flip side of the Kalman
// filter's parameters being physical (px/s², px), which do not shift
// meaning when the refresh rate does. Nothing downstream assumes a rate:
// the lag is measured from real timestamps every frame.
const SG_WINDOW = 9;        // samples in the fit window; odd, so the centre IS a sample
const SG_DEGREE = 2;        // polynomial degree (see savgol.js on why this is nearly a no-op)
const SG_MIN = 5;           // fewest samples before a slope is reported
const SG_T_SPAN_MIN = 0.02; // s — below this the fit is singular in all but name

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
const COL_VEL_USER = "#a78bfa";  // violet — the KALMAN velocity estimate
const COL_SG = "#f472b6";        // pink — the SAVITZKY-GOLAY velocity estimate
const COL_MISMATCH = "#fbbf24";  // amber — the same colour "attention lapse"
                                 // uses, so a widening gap reads as one

// Each velocity estimator has one colour used EVERYWHERE it appears: as an
// arrow on the tracking canvas and as a line on the attention chart. That is
// why the attention score line is violet/pink rather than cyan — cyan stays
// reserved for the position estimate on the main canvas.
