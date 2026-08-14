"use strict";
/* ================================================================
 * UI — sliders, buttons, phase transitions, panel header, CSV export
 * ================================================================
 * Needs:    config.js (params), tracking.js, metrics.js, attention.js
 * Provides: the DOM element handles, renderAttHeader, and every event
 *           listener the page uses
 *
 * Note the deliberate split of the two reset buttons: "Reset" reinitializes
 * the tracking filter only, and "Restart phases" wipes the attention layer
 * only. Neither touches the other.
 */

/* ---------------- attention panel + phase elements ---------------- */
const attPill = document.getElementById("attPill");
const attScoreEl = document.getElementById("attScore");
const attScoreKfEl = document.getElementById("attScoreKf");
const attMismatchEl = document.getElementById("attMismatch");
const attMismatchKfEl = document.getElementById("attMismatchKf");
const attSigmaREl = document.getElementById("attSigmaR");
const calDriftEl = document.getElementById("calDrift");
const calDriftValEl = document.getElementById("calDriftVal");
const introOverlay = document.getElementById("introOverlay");
const calBanner = document.getElementById("calBanner");
const calCountdown = document.getElementById("calCountdown");
const startCalBtn = document.getElementById("startCalBtn");
const restartBtn = document.getElementById("restartBtn");
const csvBtn = document.getElementById("csvBtn");

// The pill follows the authoritative source; the numbers show both, so the
// two estimators can be compared without reading the chart.
function renderAttHeader() {
  const primaryScore = phase === "MAIN" ? attScore(attPrimary) : null;
  if (primaryScore !== null) {
    attPill.textContent = offTask ? "attention lapse" : "on task";
    attPill.className = "pill " + (offTask ? "off" : "on");
  } else {
    attPill.textContent = phase === "CAL" ? "calibrating" : "waiting";
    attPill.className = "pill";
  }

  const fmtScore = (src) => {
    const s = phase === "MAIN" ? attScore(src) : null;
    return s === null ? "–" : s.toFixed(1);
  };
  const fmtMis = (src) =>
    Number.isFinite(src.curMismatch) ? src.curMismatch.toFixed(0) : "–";

  attScoreEl.textContent = fmtScore(attSG);
  attScoreKfEl.textContent = fmtScore(attKF);
  attMismatchEl.textContent = fmtMis(attSG);
  attMismatchKfEl.textContent = fmtMis(attKF);
  attSigmaREl.textContent = sigmaRHat.toFixed(1);

  // Say so rather than let the score quietly drop: a noise change alters
  // how accurately ANY estimator can read the hand, so it shifts the score
  // without attention having changed at all.
  const stale = calibrationStale();
  calDriftEl.classList.toggle("hidden", !stale);
  if (stale) calDriftValEl.textContent = calSigmaN.toFixed(0);

  if (phase === "CAL") {
    calCountdown.textContent = Math.max(0, Math.ceil(CAL_TOTAL - calTime));
  }
}

startCalBtn.addEventListener("click", () => {
  phase = "CAL";
  calTime = 0;
  introOverlay.classList.add("hidden");
  calBanner.classList.remove("hidden");
});

// Back to INTRO, wiping all attention state. The tracking demo's own Reset
// button intentionally does NOT touch any of this.
restartBtn.addEventListener("click", () => {
  phase = "INTRO";
  attClock = 0;
  calTime = 0;
  pendingSample = null; lastSample = null; calSigmaN = null;
  // Both velocity estimators, so neither carries state across the restart.
  cursorKFX.initialized = false; cursorKFY.initialized = false;
  resetAdaptiveR();
  sgReset();
  for (const src of attSources) {
    src.winMismatch = []; src.curMismatch = NaN;
    src.calObs = []; src.mu0 = 0; src.sig0 = 1;
    src.recentZ = []; src.tickObs = null; src.tickZ = null;
    src.scoreBuf = []; src.calPoints = [];
  }
  winTime = 0; winBroken = false;
  lastObsClock = null;
  offTask = false; belowSince = null;
  offSpans = []; gapSpans = [];
  logRows = []; logAccum = 0;
  introOverlay.classList.remove("hidden");
  calBanner.classList.add("hidden");
  // Synced here rather than left to the next renderAttHeader, matching the
  // two lines above: a restart should leave no stale badge on screen even
  // for the one frame before the loop comes round again.
  calDriftEl.classList.add("hidden");
});

csvBtn.addEventListener("click", () => {
  const blob = new Blob([LOG_HEADER + "\n" + logRows.join("\n") + "\n"], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "attention-log.csv";
  a.click();
  URL.revokeObjectURL(url);
});

/* ---------------- sliders + tracking buttons ---------------- */
const noiseSlider = document.getElementById("noiseSlider");
const procSlider = document.getElementById("procSlider");
const measSlider = document.getElementById("measSlider");
const noiseValue = document.getElementById("noiseValue");
const procValue = document.getElementById("procValue");
const measValue = document.getElementById("measValue");
const pauseBtn = document.getElementById("pauseBtn");
const resetBtn = document.getElementById("resetBtn");
const positionBtn = document.getElementById("positionBtn");
const velSourceBtn = document.getElementById("velSourceBtn");
const metricsPanel = document.getElementById("metricsPanel");

// Round a log-slider value for display: 1 decimal when small, integer when big.
function fmt(v) {
  return v < 10 ? v.toFixed(1) : Math.round(v).toString();
}

noiseSlider.addEventListener("input", () => {
  params.sigmaN = Number(noiseSlider.value);
  noiseValue.textContent = params.sigmaN + " px";
});
procSlider.addEventListener("input", () => {
  params.sigmaA = Math.pow(10, Number(procSlider.value));
  procValue.innerHTML = fmt(params.sigmaA) + " px/s&sup2;";
});
measSlider.addEventListener("input", () => {
  params.sigmaR = Math.pow(10, Number(measSlider.value));
  measValue.textContent = fmt(params.sigmaR) + " px";
});

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  // Attention layer: drop the sample chain so both velocity estimators
  // re-seed after the pause instead of spanning it. The Savitzky-Golay
  // window especially — a fit across a paused stretch would read the wall
  // clock advancing while the hand did not, and report a phantom slowdown.
  // The adaptive noise estimate goes too: its window would otherwise splice
  // together innovations from either side of the gap.
  pendingSample = null;
  lastSample = null;
  resetAdaptiveR();
  sgReset();
});

// Switch which velocity estimator the arrows draw. Both keep running either
// way; this only changes which one is shown, and the chart shows both.
velSourceBtn.addEventListener("click", () => {
  velSource = velSource === "savgol" ? "kalman" : "savgol";
  velSourceBtn.textContent = "Arrows: " + activeVelSource().label;
});

// Show/hide the position-denoising layer: the orange observations, the cyan
// estimate, their legend rows, and the RMSE panel that describes them. The
// filter keeps running underneath, so switching back on shows live numbers
// rather than a stale panel catching up.
positionBtn.addEventListener("click", () => {
  showPosition = !showPosition;
  positionBtn.textContent = showPosition ? "Hide position filter" : "Show position filter";
  metricsPanel.classList.toggle("hidden", !showPosition);
});

resetBtn.addEventListener("click", () => {
  // Reinitialize filter, trails, and metrics. Sliders keep their values,
  // and the dot keeps moving from where it is (no teleport).
  kfX.initialized = false;
  kfY.initialized = false;
  pendingObs = null;
  pendingObsDrawn = null;
  clearTrails();
  resetMetrics();
});
