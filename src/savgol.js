"use strict";
/* ================================================================
 * SAVITZKY-GOLAY — the second velocity estimator
 * ================================================================
 * Needs:    config.js (SG_*)
 * Provides: sgFit (pure), sgPush, sgVelocity, sgPosition, sgLagSeconds,
 *           sgSampleCount, sgReset
 *
 * Fit a low-order polynomial to the last SG_WINDOW cursor samples by least
 * squares and read the velocity off as its first derivative. This is the
 * classical answer to the same question cursor.js asks a Kalman filter, and
 * it runs on the identical sample stream (see velocity.js) so that anything
 * the two disagree about is attributable to the estimator alone.
 *
 * CENTRED evaluation: the derivative is taken at the MIDDLE sample of the
 * window, not the newest one. That is the textbook Savitzky-Golay form and
 * it rejects noise best, but it means the estimate describes the hand
 * roughly half a window in the PAST. That lag is real and is not hidden:
 * sgLagSeconds() reports it, measured from the actual timestamps, and
 * attention.js subtracts it when choosing which target velocity to compare
 * against. Skipping that correction would charge the SG for a delay the
 * method is openly built around.
 *
 * IRREGULAR SPACING: pointer events do not arrive on a fixed clock, so the
 * fixed SG coefficient table does not apply — the fit is recomputed from the
 * real timestamps each window. For uniformly spaced samples this reproduces
 * the published SG differentiation coefficients exactly (asserted by test).
 *
 * NO UNCERTAINTY: unlike the Kalman filter, which reports p11 and lets
 * attention.js gate on it, a least-squares slope carries no variance of its
 * own. The validity check below is therefore a heuristic — enough samples,
 * enough time span, a non-singular solve — and not the principled thing the
 * filter gets for free. That asymmetry is one of the differences this
 * comparison exists to show, so it is left visible rather than papered over.
 *
 * AND NO ADAPTATION, deliberately. The samples carry the injected noise, and
 * the Kalman filter re-tunes itself to whatever that noise level turns out
 * to be (cursor.js estimates it from its own innovations). This fit has no
 * comparable mechanism: its only lever is SG_WINDOW, and choosing a window
 * to suit the noise requires knowing the noise, which is precisely what it
 * cannot work out. Reading params.sigmaN here to pick a window would be
 * reaching outside the method to borrow the filter's advantage, and would
 * make the chart a comparison of two things that had both been told the
 * answer. Leaving it fixed IS the finding. SG_WINDOW is in config.js for
 * anyone who wants to level the contest up by hand.
 */

/* ---------------- the fit ---------------- */

// Least-squares polynomial fit over `samples` ({x, y, t}), evaluated at the
// centre sample. Returns {x, y, vx, vy, tEval, lag} or null if not valid.
//
// Time is normalised to u = (t - tEval) / halfSpan so that u lands in about
// [-1, 1]. Without that, the normal equations mix terms of order 1 with terms
// of order span^4 (~1e-4 here) and a "is this singular?" test has no sensible
// scale to work against. With it, every entry is O(n) and the check is simple.
// Fitting  val ~ b0 + b1*u + b2*u^2  then gives position b0 and velocity
// b1 / halfSpan.
function sgFit(samples) {
  const n = samples.length;
  if (n < SG_MIN) return null;

  const mid = (n - 1) >> 1;             // odd SG_WINDOW → the exact centre sample
  const tEval = samples[mid].t;
  const span = samples[n - 1].t - samples[0].t;
  if (!(span > SG_T_SPAN_MIN)) return null;
  const halfSpan = span / 2;

  // Degree cannot exceed what the sample count can support.
  const d = Math.min(SG_DEGREE, n - 1);
  const m = d + 1;

  // Normal equations A b = r, with A[i][j] = sum(u^(i+j)) and
  // r[i] = sum(u^i * value). Both axes share the design matrix — the
  // timestamps are the same — so this is built once and solved for two
  // right-hand sides at once.
  const S = new Array(2 * d + 1).fill(0);
  const rx = new Array(m).fill(0);
  const ry = new Array(m).fill(0);
  for (let k = 0; k < n; k++) {
    const u = (samples[k].t - tEval) / halfSpan;
    let p = 1;
    for (let i = 0; i <= 2 * d; i++) { S[i] += p; p *= u; }
    p = 1;
    for (let i = 0; i < m; i++) {
      rx[i] += p * samples[k].x;
      ry[i] += p * samples[k].y;
      p *= u;
    }
  }

  // Augmented matrix [A | rx ry].
  const M = [];
  for (let i = 0; i < m; i++) {
    const row = new Array(m + 2);
    for (let j = 0; j < m; j++) row[j] = S[i + j];
    row[m] = rx[i];
    row[m + 1] = ry[i];
    M.push(row);
  }

  // Gaussian elimination with partial pivoting. Entries are O(n) thanks to
  // the normalisation above, so a pivot far below that scale means the
  // samples do not actually constrain a polynomial of this degree.
  const tol = 1e-9 * n;
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let i = col + 1; i < m; i++) {
      if (Math.abs(M[i][col]) > Math.abs(M[piv][col])) piv = i;
    }
    if (Math.abs(M[piv][col]) < tol) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    for (let i = col + 1; i < m; i++) {
      const f = M[i][col] / M[col][col];
      if (f === 0) continue;
      for (let j = col; j < m + 2; j++) M[i][j] -= f * M[col][j];
    }
  }
  const bx = new Array(m), by = new Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let sx = M[i][m], sy = M[i][m + 1];
    for (let j = i + 1; j < m; j++) { sx -= M[i][j] * bx[j]; sy -= M[i][j] * by[j]; }
    bx[i] = sx / M[i][i];
    by[i] = sy / M[i][i];
  }

  // d/dt at u = 0 is b1 * du/dt = b1 / halfSpan.
  const vx = bx[1] / halfSpan;
  const vy = by[1] / halfSpan;
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;

  return {
    x: bx[0], y: by[0],          // fitted position at the evaluation point
    vx, vy,                       // velocity there, px/s
    tEval,
    lag: samples[n - 1].t - tEval, // how far in the past that point is
  };
}

/* ---------------- rolling buffer ---------------- */

let sgBuf = [];       // last SG_WINDOW samples, oldest first
let sgCur = null;     // cached sgFit result; only the buffer can invalidate it

// Fed one sample per frame by velocity.js — the same object the cursor
// Kalman filter receives, or null when no sample was available.
function sgPush(obs) {
  if (!obs) return;   // null, or no argument at all: nothing to record
  sgBuf.push(obs);
  if (sgBuf.length > SG_WINDOW) sgBuf.shift();
  sgCur = sgFit(sgBuf);
}

// Hand velocity in px/s at the window centre, or null when the fit is not
// valid. Mirrors cursorVelocity() so the two are interchangeable.
function sgVelocity() {
  return sgCur === null ? null : { x: sgCur.vx, y: sgCur.vy };
}

function sgPosition() {
  return sgCur === null ? null : { x: sgCur.x, y: sgCur.y };
}

// Seconds between the newest sample and the instant the estimate describes.
// Zero when there is no valid fit, so callers can add it unconditionally.
function sgLagSeconds() {
  return sgCur === null ? 0 : sgCur.lag;
}

function sgSampleCount() {
  return sgBuf.length;
}

// Called whenever the sample stream breaks — pointer leaves, pause, restart.
// A window that straddles a gap is not a valid fit, for the same reason the
// cursor filter is dropped rather than left to coast across one.
function sgReset() {
  sgBuf = [];
  sgCur = null;
}
