"use strict";
/* ================================================================
 * ATTENTION CHART — the 60 s scrolling strip chart
 * ================================================================
 * Needs:    config.js (chart constants), attention.js (attClock, attSources,
 *           attPrimary, offSpans, gapSpans, phase, attScore)
 * Provides: attCanvas, attCtx, AW, AH, resizeAttCanvas, drawAttChart
 *
 * One line per velocity estimator, each in that estimator's colour — the
 * same colour its arrow uses on the tracking canvas. Both lines are the
 * same readout computed the same way; the only difference upstream is where
 * the velocity came from, so the gap between them IS the estimator's effect.
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

  // Raw (un-z-scored) calibration observations as dots, per source.
  attCtx.globalAlpha = 0.6;
  for (const src of attSources) {
    attCtx.fillStyle = src.color;
    for (const p of src.calPoints) {
      attCtx.beginPath();
      attCtx.arc(chartX(p.t), chartY(p.v), 2.5, 0, 2 * Math.PI);
      attCtx.fill();
    }
  }
  attCtx.globalAlpha = 1;
  if (phase === "CAL") {
    attCtx.fillStyle = "rgba(216, 216, 232, 0.3)";
    attCtx.font = "20px system-ui, sans-serif";
    attCtx.textAlign = "center";
    attCtx.textBaseline = "middle";
    attCtx.fillText("calibrating…", AW / 2, AH / 2);
    attCtx.textAlign = "start";
  }

  // The scores: one solid line per source. No bands — a deterministic
  // readout carries no uncertainty estimate, and drawing one would be a
  // fiction. Drawn in reverse so the authoritative source lands on top.
  for (let i = attSources.length - 1; i >= 0; i--) {
    const src = attSources[i];
    if (src.scoreBuf.length < 2) continue;
    attCtx.strokeStyle = src.color;
    attCtx.lineWidth = src === attPrimary ? 2 : 1.5;
    attCtx.globalAlpha = src === attPrimary ? 1 : 0.75;
    attCtx.beginPath();
    attCtx.moveTo(chartX(src.scoreBuf[0].t), chartY(src.scoreBuf[0].v));
    for (const p of src.scoreBuf) attCtx.lineTo(chartX(p.t), chartY(p.v));
    attCtx.stroke();
  }
  attCtx.globalAlpha = 1;

  drawChartLegend();
}

// Two swatches in the top-right corner naming the lines. Right-aligned so it
// cannot collide with the gridline labels drawn from the left edge.
function drawChartLegend() {
  attCtx.font = "11px system-ui, sans-serif";
  attCtx.textBaseline = "middle";
  attCtx.textAlign = "right";
  let y = 12;
  for (const src of attSources) {
    attCtx.strokeStyle = src.color;
    attCtx.lineWidth = 2;
    attCtx.beginPath();
    attCtx.moveTo(AW - 8, y);
    attCtx.lineTo(AW - 22, y);
    attCtx.stroke();
    attCtx.fillStyle = "rgba(216, 216, 232, 0.7)";
    attCtx.fillText(src.label, AW - 28, y);
    y += 16;
  }
  attCtx.textAlign = "start";
}
