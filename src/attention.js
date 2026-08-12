"use strict";
/* ================================================================
 * ATTENTION — state, per-frame pipeline, calibration, score, logging
 * ================================================================
 * Needs:    config.js, util.js (median, mad), target.js (dotVelocity),
 *           canvas.js (W, H), tracking.js (pointerOver, dotT),
 *           cursor.js (cursorVelocity, cursorVelSd)
 * Provides: phase, attClock, the attention state, attentionFrame,
 *           attScore, emitObservation, finishCalibration, logRow
 *
 * The attention layer reads how attentively the user is tracking, from
 * the mismatch between the CLEAN cursor velocity and the target's true
 * velocity. It never sees the injected noise — it reads the human, not
 * the synthetic corruption.
 *
 * The readout is deliberately DETERMINISTIC: no state estimator, no model
 * of how attention evolves. Each observation is compared directly against
 * the user's own calibration baseline, and the score is the median of the
 * few most recent comparisons. There is no ground truth for attention to
 * validate a model against, so the code makes no claim beyond what it
 * literally measures.
 *
 * Phases: INTRO (overlay) → CAL (calibration) → MAIN (live readout). All
 * attention timing runs on attClock, which advances only while unpaused,
 * so pausing freezes the whole layer cleanly: no phantom gaps, no score
 * jumps on resume.
 */

let phase = "INTRO";
let attClock = 0;         // s of unpaused time since load / phase restart
let calTime = 0;          // s of calibration completed (pointer-over only)
let calObs = [];          // calibration observations (after the discard period)
let mu0 = 0, sig0 = 1;    // per-user baseline, set when calibration ends

let pendingClean = null;  // most recent CLEAN cursor sample {x, y, t}
let lastClean = null;     // last sample consumed by the cursor filter
let curMismatch = NaN;    // latest mismatch, for the header readout

let winMismatch = [];     // mismatch samples in the current window
let winTime = 0;          // accumulated pointer-over time in the window
let winBroken = false;    // pointer left the canvas during the window

let recentZ = [];         // the last ZWIN z-scores; the score is their median
let lastObsClock = null;  // attClock of the last accepted observation
let tickObs = null, tickZ = null; // last emitted obs/z, consumed by the log

let offTask = false;      // hysteresis state
let belowSince = null;    // attClock when the score first dipped below OFF_ENTER

let scoreBuf = [];        // chart samples {t, v}
let calPoints = [];       // raw calibration observations {t, v}
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

  // --- mismatch sample ---
  // Hand velocity comes from the cursor Kalman filter (cursor.js), which
  // has already run for this frame. The gate is the part worth noticing:
  // the filter reports how uncertain its own velocity estimate is, so an
  // observation made while that estimate is untrustworthy — mainly the
  // moment after the pointer returns to the canvas — can be dropped
  // instead of quietly polluting the score. A window starved by the gate
  // falls below ATT_MIN_FRAMES below and is discarded whole.
  const v = cursorVelocity();
  if (pointerOver && v !== null && cursorVelSd() <= CURSOR_V_SD_MAX) {
    // Compare against where the target was ATT_LAG (150 ms) ago: normal
    // human reaction delay must not read as inattention.
    const tv = dotVelocity(dotT - ATT_LAG);
    curMismatch = Math.hypot(v.x - tv.dnx * W, v.y - tv.dny * H);
    winMismatch.push(curMismatch);
  }

  // --- 0.5 s observation windows (pointer-over time only) ---
  if (pointerOver) winTime += dt;
  if (winTime >= ATT_WINDOW) {
    winTime = 0;
    if (!winBroken && winMismatch.length >= ATT_MIN_FRAMES) {
      // Median over the window is robust to single-frame glitches. The
      // +10 px/s floor keeps log() away from −inf and compresses the
      // difference between "very good" and "perfect".
      emitObservation(-Math.log(median(winMismatch) + 10));
    }
    winMismatch = [];
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

  // --- score, hysteresis label, chart buffer (MAIN) ---
  const score = phase === "MAIN" ? attScore() : null;
  if (score !== null) {
    // Hysteresis: OFF-TASK only after the score stays below OFF_ENTER for
    // OFF_DWELL seconds; back ON as soon as it climbs above OFF_EXIT.
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

    // Decimate chart sampling to ≤ 60 points/s — some displays run rAF at
    // 120+ Hz, which would double the buffer size for the same 60 s window.
    const last = scoreBuf[scoreBuf.length - 1];
    if (!last || attClock - last.t >= 1 / 65) {
      scoreBuf.push({ t: attClock, v: score });
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
function attScore() {
  return recentZ.length ? median(recentZ) : null;
}

// Route an emitted observation to calibration or to the live readout.
function emitObservation(obs) {
  tickObs = obs;
  if (phase === "CAL") {
    calPoints.push({ t: attClock, v: obs });
    // The first CAL_DISCARD seconds are settling-in time, not baseline.
    if (calTime > CAL_DISCARD) calObs.push(obs);
    return;
  }
  if (phase !== "MAIN") return;

  // The whole readout, in one line: how far is this observation from the
  // user's own calibrated baseline, in units of their own variability?
  const z = (obs - mu0) / sig0;
  tickZ = z;

  recentZ.push(z);
  if (recentZ.length > ZWIN) recentZ.shift();

  lastObsClock = attClock;
  const open = gapSpans[gapSpans.length - 1];
  if (open && open.end === null) open.end = attClock;
}

// The core idea of calibration: the user's own calibrated ceiling is the
// yardstick. Low skill inflates mismatch during calibration and is absorbed
// into mu0, so the score reads deviation from one's own baseline —
// attention, not ability.
function finishCalibration() {
  if (calObs.length >= 5) {
    mu0 = median(calObs);
    sig0 = Math.max(1.4826 * mad(calObs), 0.05);
  } else {
    // Degenerate calibration (user barely tracked): loose fallback prior.
    mu0 = calObs.length ? median(calObs) : -4;
    sig0 = 1;
  }
  phase = "MAIN";
  calBanner.classList.add("hidden");
  // Calibration points are raw (un-z-scored) observations on a different
  // scale from the z-scored line that follows; leaving them on the axis
  // would invite reading them as lapses.
  calPoints = [];
}

function pruneChartBuffers() {
  const cutoff = attClock - CHART_SPAN;
  while (scoreBuf.length && scoreBuf[0].t < cutoff) scoreBuf.shift();
  while (calPoints.length && calPoints[0].t < cutoff) calPoints.shift();
  while (offSpans.length && offSpans[0].end !== null && offSpans[0].end < cutoff) offSpans.shift();
  while (gapSpans.length && gapSpans[0].end !== null && gapSpans[0].end < cutoff) gapSpans.shift();
}

/* ---------------- logging ---------------- */
function logRow() {
  const score = phase === "MAIN" ? attScore() : null;
  logRows.push([
    attClock.toFixed(2),
    phase,
    Number.isFinite(curMismatch) ? curMismatch.toFixed(1) : "",
    tickObs !== null ? tickObs.toFixed(4) : "",
    tickZ !== null ? tickZ.toFixed(3) : "",
    score !== null ? score.toFixed(3) : "",
    phase === "MAIN" ? (offTask ? "off_task" : "on_task") : "",
    pointerOver ? 1 : 0,
  ].join(","));
  tickObs = null;
  tickZ = null;
  // Cap memory: drop the oldest rows in chunks rather than one at a time.
  if (logRows.length > LOG_CAP) logRows.splice(0, 5000);
}
