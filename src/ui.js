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
const attMismatchEl = document.getElementById("attMismatch");
const introOverlay = document.getElementById("introOverlay");
const calBanner = document.getElementById("calBanner");
const calCountdown = document.getElementById("calCountdown");
const startCalBtn = document.getElementById("startCalBtn");
const restartBtn = document.getElementById("restartBtn");
const csvBtn = document.getElementById("csvBtn");

function renderAttHeader() {
  const score = phase === "MAIN" ? attScore() : null;
  if (score !== null) {
    attScoreEl.textContent = score.toFixed(1);
    attPill.textContent = offTask ? "attention lapse" : "on task";
    attPill.className = "pill " + (offTask ? "off" : "on");
  } else {
    attScoreEl.textContent = "–";
    attPill.textContent = phase === "CAL" ? "calibrating" : "waiting";
    attPill.className = "pill";
  }
  attMismatchEl.textContent = Number.isFinite(curMismatch) ? curMismatch.toFixed(0) : "–";
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
  calObs = [];
  mu0 = 0; sig0 = 1;
  pendingClean = null; lastClean = null; curMismatch = NaN;
  cursorKFX.initialized = false; cursorKFY.initialized = false;
  winMismatch = []; winTime = 0; winBroken = false;
  recentZ = [];
  lastObsClock = null; tickObs = null; tickZ = null;
  offTask = false; belowSince = null;
  scoreBuf = []; calPoints = []; offSpans = []; gapSpans = [];
  logRows = []; logAccum = 0;
  introOverlay.classList.remove("hidden");
  calBanner.classList.add("hidden");
});

csvBtn.addEventListener("click", () => {
  const header = "t,phase,mismatch,obs,z,score,label,pointer_present";
  const blob = new Blob([header + "\n" + logRows.join("\n") + "\n"], { type: "text/csv" });
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
  // Attention layer: drop the clean-sample chain so velocity differencing
  // re-seeds after the pause instead of spanning it.
  pendingClean = null;
  lastClean = null;
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
