"use strict";
/* ================================================================
 * METRICS — how much better the estimate is than the raw observation
 * ================================================================
 * Needs:    config.js (RMSE_WINDOW); the #obsRmse/#estRmse/#improvement
 *           elements
 * Provides: obsSqErr, estSqErr, pushWindow, rmse, resetMetrics,
 *           renderMetrics
 *
 * Rolling windows of squared radial error (obs vs true, est vs true) over
 * the last RMSE_WINDOW frames. Metrics accumulate only while the pointer
 * is over the canvas and the demo is unpaused (see main.js).
 */
const obsSqErr = [];
const estSqErr = [];

function pushWindow(arr, value, cap) {
  arr.push(value);
  if (arr.length > cap) arr.shift();
}

function rmse(arr) {
  if (arr.length === 0) return NaN;
  let sum = 0;
  for (const v of arr) sum += v;
  return Math.sqrt(sum / arr.length);
}

function resetMetrics() {
  obsSqErr.length = 0;
  estSqErr.length = 0;
}

const obsRmseEl = document.getElementById("obsRmse");
const estRmseEl = document.getElementById("estRmse");
const improvementEl = document.getElementById("improvement");

function renderMetrics() {
  const o = rmse(obsSqErr);
  const s = rmse(estSqErr);
  obsRmseEl.textContent = Number.isFinite(o) ? o.toFixed(1) : "–";
  estRmseEl.textContent = Number.isFinite(s) ? s.toFixed(1) : "–";
  if (Number.isFinite(o) && Number.isFinite(s) && o > 0) {
    const imp = (1 - s / o) * 100;
    improvementEl.textContent = imp.toFixed(0) + "%";
    improvementEl.style.color = imp > 0 ? "var(--good)" : "var(--bad)";
  } else {
    improvementEl.textContent = "–";
    improvementEl.style.color = "";
  }
}
