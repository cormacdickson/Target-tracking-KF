"use strict";
/* ================================================================
 * ATTENTION CHART — the 60 s scrolling strip chart
 * ================================================================
 * Needs:    config.js (chart constants, COL_EST), attention.js (attClock,
 *           scoreBuf, calPoints, offSpans, gapSpans, phase)
 * Provides: attCanvas, attCtx, AW, AH, resizeAttCanvas, drawAttChart
 */
const attCanvas = document.getElementById("attCanvas");
const attCtx = attCanvas.getContext("2d");
let AW = 0, AH = 0; // chart canvas size in CSS pixels

function resizeAttCanvas() {
  const rect = attCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  AW = rect.width;
  AH = rect.height;
  attCanvas.width = Math.round(AW * dpr);
  attCanvas.height = Math.round(AH * dpr);
  attCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeAttCanvas);

// Chart coordinate mapping: 60 s scrolling window ending "now" (attClock),
// fixed y-range so the baseline and threshold stay put.
const chartX = (t) => ((t - (attClock - CHART_SPAN)) / CHART_SPAN) * AW;
// Values outside the fixed y-range are pinned to the edge, so a deep lapse
// reads as "pegged at the bottom" rather than vanishing off the plot.
const chartY = (v) => {
  const y = ((CHART_Y_MAX - v) / (CHART_Y_MAX - CHART_Y_MIN)) * AH;
  return Math.max(0, Math.min(AH, y));
};

function drawChartSpans(spans, color) {
  attCtx.fillStyle = color;
  for (const s of spans) {
    const x0 = Math.max(0, chartX(s.start));
    const x1 = Math.min(AW, chartX(s.end === null ? attClock : s.end));
    if (x1 > x0) attCtx.fillRect(x0, 0, x1 - x0, AH);
  }
}

function drawAttChart() {
  attCtx.clearRect(0, 0, AW, AH);

  // Shaded spans go first so the line draws on top.
  drawChartSpans(gapSpans, "rgba(150, 150, 170, 0.12)");
  drawChartSpans(offSpans, "rgba(251, 191, 36, 0.14)");

  // Gridlines: calibrated baseline (0) and lapse threshold (OFF_ENTER).
  attCtx.font = "11px system-ui, sans-serif";
  attCtx.textBaseline = "bottom";
  for (const [v, label] of [[0, "calibrated baseline"], [OFF_ENTER, "lapse threshold"]]) {
    const y = chartY(v);
    attCtx.strokeStyle = "rgba(216, 216, 232, 0.25)";
    attCtx.lineWidth = 1;
    attCtx.setLineDash(v === 0 ? [] : [3, 3]);
    attCtx.beginPath();
    attCtx.moveTo(0, y);
    attCtx.lineTo(AW, y);
    attCtx.stroke();
    attCtx.setLineDash([]);
    attCtx.fillStyle = "rgba(216, 216, 232, 0.45)";
    attCtx.fillText(label, 6, y - 2);
  }

  // Raw (un-z-scored) calibration observations as dots.
  attCtx.fillStyle = "rgba(34, 211, 238, 0.6)";
  for (const p of calPoints) {
    attCtx.beginPath();
    attCtx.arc(chartX(p.t), chartY(p.v), 2.5, 0, 2 * Math.PI);
    attCtx.fill();
  }
  if (phase === "CAL") {
    attCtx.fillStyle = "rgba(216, 216, 232, 0.3)";
    attCtx.font = "20px system-ui, sans-serif";
    attCtx.textAlign = "center";
    attCtx.textBaseline = "middle";
    attCtx.fillText("calibrating…", AW / 2, AH / 2);
    attCtx.textAlign = "start";
  }

  // The score: a single solid line. No band — a deterministic readout
  // carries no uncertainty estimate, and drawing one would be a fiction.
  if (scoreBuf.length >= 2) {
    attCtx.strokeStyle = COL_EST;
    attCtx.lineWidth = 2;
    attCtx.beginPath();
    attCtx.moveTo(chartX(scoreBuf[0].t), chartY(scoreBuf[0].v));
    for (const p of scoreBuf) attCtx.lineTo(chartX(p.t), chartY(p.v));
    attCtx.stroke();
  }
}
