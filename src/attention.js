"use strict";
/* ================================================================
 * ATTENTION — state, per-frame pipeline, calibration, score, logging
 * ================================================================
 * Needs:    config.js, util.js (median, mad), target.js (dotVelocity),
 *           canvas.js (W, H), tracking.js (pointerOver, dotT),
 *           cursor.js (cursorVelocity, cursorVelSd),
 *           savgol.js (sgVelocity, sgLagSeconds)
 * Provides: phase, attClock, the attention state, attSources/attPrimary,
 *           attentionFrame, attScore, emitObservation, finishCalibration,
 *           logRow
 *
 * The attention layer reads how attentively the user is tracking, from the
 * mismatch between the estimated cursor velocity and the target's true
 * velocity. Those estimates come from noisy samples, so raising sigma_n
 * lowers the score whether or not attention changed — which is why
 * calibration records the noise level it ran at and ui.js flags the
 * mismatch if the slider moves afterwards.
 *
 * The readout is deliberately DETERMINISTIC: no state estimator, no model
 * of how attention evolves. Each observation is compared directly against
 * the user's own calibration baseline, and the score is the median of the
 * few most recent comparisons. There is no ground truth for attention to
 * validate a model against, so the code makes no claim beyond what it
 * literally measures.
 *
 * TWO SOURCES. The whole readout is computed twice, once per velocity
 * estimator (Savitzky-Golay and Kalman), so the chart can show what the
 * choice of estimator alone does to the answer. They share one input
 * stream (velocity.js), one clock, and one set of window boundaries;
 * everything downstream of the velocity is per-source. The Savitzky-Golay
 * source is authoritative — it alone drives the pill, the hysteresis and
 * the shading — because two competing verdicts would be no verdict at all.
 *
 * Phases: INTRO (overlay) → CAL (calibration) → MAIN (live readout). All
 * attention timing runs on attClock, which advances only while unpaused,
 * so pausing freezes the whole layer cleanly: no phantom gaps, no score
 * jumps on resume.
 */

let phase = "INTRO";
let attClock = 0;         // s of unpaused time since load / phase restart
let calTime = 0;          // s of calibration completed (pointer-over only)

let pendingSample = null; // most recent cursor sample {x, y, t, cx, cy} — the
                          // x/y carry the injected noise; cx/cy are kept only
                          // so a parked cursor can be re-noised (velocity.js)
let lastSample = null;    // last sample consumed by velocity.js
let calSigmaN = null;     // sigma_n at the moment calibration finished, so a
                          // later slider move can be flagged as a stale baseline

/* ---------------- per-source state ----------------
 * Each source owns its mismatch window, its calibration baseline, its
 * z-score history and its chart line. The baselines MUST be separate: the
 * two mismatch distributions sit on different scales, so z-scoring one
 * against the other's baseline would be meaningless arithmetic.
 */
function makeAttSource(name, label, color, velFn, trustFn, lagFn) {
  return {
    name, label, color,
    velFn,                  // () -> {x, y} px/s, or null
    trustFn,                // () -> is this estimate trustworthy right now?
    lagFn,                  // () -> seconds the estimate lags real time
    winMismatch: [],        // mismatch samples in the current window
    curMismatch: NaN,       // latest mismatch, for the header readout
    calObs: [],             // calibration observations (after the discard period)
    mu0: 0, sig0: 1,        // per-user, per-source baseline
    recentZ: [],            // the last ZWIN z-scores; the score is their median
    tickObs: null,          // last emitted obs/z, consumed by the log
    tickZ: null,
    scoreBuf: [],           // chart samples {t, v}
    calPoints: [],          // raw calibration observations {t, v}
  };
}

// The Savitzky-Golay fit reports whether it is valid by returning null, so
// it needs no separate trust test. The Kalman filter instead reports how
// uncertain its own velocity estimate is, which is a stronger thing to have
// and is what CURSOR_V_SD_MAX thresholds.
const attSG = makeAttSource(
  "savgol", "Sav-Gol", COL_SG,
  sgVelocity, () => true, sgLagSeconds
);
const attKF = makeAttSource(
  "kalman", "Kalman", COL_VEL_USER,
  cursorVelocity, () => cursorVelSd() <= cursorVelSdMax(), () => 0
);

const attSources = [attSG, attKF];   // authoritative first
const attPrimary = attSG;            // drives pill, hysteresis, shading, gaps

/* ---------------- shared window / label state ---------------- */
let winTime = 0;          // accumulated pointer-over time in the window
let winBroken = false;    // pointer left the canvas during the window

let lastObsClock = null;  // attClock of the last accepted PRIMARY observation

let offTask = false;      // hysteresis state (primary source only)
let belowSince = null;    // attClock when the score first dipped below OFF_ENTER

let offSpans = [];        // OFF-TASK periods {start, end|null}
let gapSpans = [];        // observation gaps {start, end|null}

let logRows = [];         // CSV rows (strings)
let logAccum = 0;         // 0.5 s ticker for logging

/* ---------------- per-frame pipeline ---------------- */
function attentionFrame(dt) {
  attClock += dt;
  if (phase === "INTRO") return;

  // --- calibration countdown (advances only while actually tracking) ---
  if (phase === "CAL" && pointerOver) {
    calTime += dt;
    if (calTime >= CAL_TOTAL) finishCalibration();
  }

  // --- mismatch sample, once per source ---
  for (const src of attSources) {
    const v = src.velFn();
    if (!pointerOver || v === null || !src.trustFn()) continue;

    // Compare against where the target was ATT_LAG (150 ms) ago, so normal
    // human reaction delay does not read as inattention — PLUS however far
    // in the past this particular estimator's answer refers to. The centred
    // Savitzky-Golay fit describes the hand about half a window ago; billing
    // it for that delay on top of ATT_LAG would double-count and inflate its
    // mismatch for a reason that has nothing to do with the user's
    // attention. The Kalman filter is real-time, so its lag term is zero.
    const tv = dotVelocity(dotT - ATT_LAG - src.lagFn());
    src.curMismatch = Math.hypot(v.x - tv.dnx * W, v.y - tv.dny * H);
    src.winMismatch.push(src.curMismatch);
  }

  // --- 0.5 s observation windows (pointer-over time only) ---
  // The boundaries are shared, so both sources are always summarising the
  // same stretch of time; only the contents of their windows differ.
  if (pointerOver) winTime += dt;
  if (winTime >= ATT_WINDOW) {
    winTime = 0;
    for (const src of attSources) {
      // A window starved by a source's own gate falls below ATT_MIN_FRAMES
      // and is discarded for that source only.
      if (!winBroken && src.winMismatch.length >= ATT_MIN_FRAMES) {
        // Median over the window is robust to single-frame glitches. The
        // +10 px/s floor keeps log() away from −inf and compresses the
        // difference between "very good" and "perfect".
        emitObservation(src, -Math.log(median(src.winMismatch) + 10));
      }
      src.winMismatch = [];
    }
    winBroken = false;
  }

  // --- gaps: mark only, never extrapolate (MAIN) ---
  // With no state model there is nothing to propagate: the score simply
  // holds its last value while the shading tells the reader that the data
  // stopped. That is the honest thing to show for a quantity we cannot
  // observe while the pointer is away.
  if (phase === "MAIN" && lastObsClock !== null &&
      attClock - lastObsClock >= ATT_GAP_S) {
    const open = gapSpans[gapSpans.length - 1];
    if (!open || open.end !== null) gapSpans.push({ start: attClock, end: null });
  }

  // --- chart buffers, one line per source ---
  if (phase === "MAIN") {
    for (const src of attSources) {
      const s = attScore(src);
      if (s === null) continue;
      // Decimate chart sampling to ≤ 60 points/s — some displays run rAF at
      // 120+ Hz, which would double the buffer size for the same 60 s window.
      const last = src.scoreBuf[src.scoreBuf.length - 1];
      if (!last || attClock - last.t >= 1 / 65) {
        src.scoreBuf.push({ t: attClock, v: s });
      }
    }
  }

  // --- hysteresis label: the PRIMARY source alone ---
  const score = phase === "MAIN" ? attScore(attPrimary) : null;
  if (score !== null) {
    // OFF-TASK only after the score stays below OFF_ENTER for OFF_DWELL
    // seconds; back ON as soon as it climbs above OFF_EXIT.
    if (!offTask) {
      if (score < OFF_ENTER) {
        if (belowSince === null) belowSince = attClock;
        if (attClock - belowSince >= OFF_DWELL) {
          offTask = true;
          offSpans.push({ start: attClock, end: null });
        }
      } else {
        belowSince = null;
      }
    } else if (score > OFF_EXIT) {
      offTask = false;
      offSpans[offSpans.length - 1].end = attClock;
      belowSince = null;
    }
  }
  pruneChartBuffers();

  // --- logging: one row per 0.5 s of unpaused time, gaps included ---
  logAccum += dt;
  while (logAccum >= ATT_WINDOW) {
    logAccum -= ATT_WINDOW;
    logRow();
  }
}

// The score: the median of the last ZWIN z-scores. A median rather than a
// mean so one bad window (a stray flick of the hand) cannot drag the
// reading on its own, and only a few samples deep so it responds within a
// couple of seconds. Null until the first observation arrives.
function attScore(src) {
  return src.recentZ.length ? median(src.recentZ) : null;
}

// Route an emitted observation to calibration or to the live readout.
function emitObservation(src, obs) {
  src.tickObs = obs;
  if (phase === "CAL") {
    src.calPoints.push({ t: attClock, v: obs });
    // The first CAL_DISCARD seconds are settling-in time, not baseline.
    if (calTime > CAL_DISCARD) src.calObs.push(obs);
    return;
  }
  if (phase !== "MAIN") return;

  // The whole readout, in one line: how far is this observation from the
  // user's own calibrated baseline, in units of their own variability?
  const z = (obs - src.mu0) / src.sig0;
  src.tickZ = z;

  src.recentZ.push(z);
  if (src.recentZ.length > ZWIN) src.recentZ.shift();

  // Gap bookkeeping follows the authoritative source only.
  if (src === attPrimary) {
    lastObsClock = attClock;
    const open = gapSpans[gapSpans.length - 1];
    if (open && open.end === null) open.end = attClock;
  }
}

// The core idea of calibration: the user's own calibrated ceiling is the
// yardstick. Low skill inflates mismatch during calibration and is absorbed
// into mu0, so the score reads deviation from one's own baseline —
// attention, not ability. Each source calibrates separately, against its own
// mismatch distribution.
function finishCalibration() {
  for (const src of attSources) {
    if (src.calObs.length >= 5) {
      src.mu0 = median(src.calObs);
      src.sig0 = Math.max(1.4826 * mad(src.calObs), 0.05);
    } else {
      // Degenerate calibration (user barely tracked): loose fallback prior.
      src.mu0 = src.calObs.length ? median(src.calObs) : -4;
      src.sig0 = 1;
    }
    // Calibration points are raw (un-z-scored) observations on a different
    // scale from the z-scored lines that follow; leaving them on the axis
    // would invite reading them as lapses.
    src.calPoints = [];
  }
  // The baseline is only valid at the noise level it was measured at: more
  // noise means more velocity error even for a perfectly tuned filter, so
  // the score would drop for reasons unrelated to attention.
  calSigmaN = params.sigmaN;
  phase = "MAIN";
  calBanner.classList.add("hidden");
}

// True when sigma_n has moved far enough since calibration that the baseline
// no longer describes the current conditions.
function calibrationStale() {
  if (calSigmaN === null || phase !== "MAIN") return false;
  const d = Math.abs(params.sigmaN - calSigmaN);
  return d > 3 && d > 0.2 * Math.max(calSigmaN, 1);
}

function pruneChartBuffers() {
  const cutoff = attClock - CHART_SPAN;
  for (const src of attSources) {
    while (src.scoreBuf.length && src.scoreBuf[0].t < cutoff) src.scoreBuf.shift();
    while (src.calPoints.length && src.calPoints[0].t < cutoff) src.calPoints.shift();
  }
  while (offSpans.length && offSpans[0].end !== null && offSpans[0].end < cutoff) offSpans.shift();
  while (gapSpans.length && gapSpans[0].end !== null && gapSpans[0].end < cutoff) gapSpans.shift();
}

/* ---------------- logging ---------------- */
const LOG_HEADER =
  "t,phase,sigma_n,sigma_r_hat,mismatch_sg,mismatch_kf,obs_sg,obs_kf,z_sg,z_kf," +
  "score_sg,score_kf,label,pointer_present";

function logRow() {
  const num = (v, dp) => (v !== null && Number.isFinite(v) ? v.toFixed(dp) : "");
  const cols = [attClock.toFixed(2), phase,
                params.sigmaN.toFixed(1), sigmaRHat.toFixed(2)];
  for (const src of attSources) cols.push(num(src.curMismatch, 1));
  for (const src of attSources) cols.push(num(src.tickObs, 4));
  for (const src of attSources) cols.push(num(src.tickZ, 3));
  for (const src of attSources) {
    cols.push(phase === "MAIN" ? num(attScore(src), 3) : "");
  }
  // The label describes the authoritative source, matching the pill.
  cols.push(phase === "MAIN" ? (offTask ? "off_task" : "on_task") : "");
  cols.push(pointerOver ? 1 : 0);
  logRows.push(cols.join(","));

  for (const src of attSources) { src.tickObs = null; src.tickZ = null; }
  // Cap memory: drop the oldest rows in chunks rather than one at a time.
  if (logRows.length > LOG_CAP) logRows.splice(0, 5000);
}
