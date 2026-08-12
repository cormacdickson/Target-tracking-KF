"use strict";
/* ================================================================
 * KALMAN FILTER — the centrepiece
 * ================================================================
 * Needs:    config.js (P_INIT, P_CAP)
 * Provides: KF1D
 *
 * One 1-D constant-velocity filter. The demo runs two of them, one per
 * axis; x and y noise are independent, so decoupling them keeps every
 * matrix at most 2x2 and makes the observation update fully scalar — no
 * matrix inversion is needed anywhere below.
 *
 * State per axis:  x = [position, velocity]'
 * Observation:     z = noisy cursor coordinate (scalar)
 *
 * Model matrices for timestep dt:
 *   F = [[1, dt],  transition: position += velocity*dt
 *        [0,  1]]
 *   Q = sigma_a^2 * [[dt^4/4, dt^3/2],   white-noise-acceleration
 *                    [dt^3/2, dt^2  ]]   process noise
 *   H = [1, 0]                            we observe position only
 *   R = sigma_r^2                         scalar measurement variance
 */
class KF1D {
  constructor() {
    this.initialized = false;
    // State [position, velocity] and covariance P (2x2, stored as entries).
    this.pos = 0;
    this.vel = 0;
    this.p00 = 0; this.p01 = 0;
    this.p10 = 0; this.p11 = 0;
  }

  // First sample (or recovery after a numerical fault): position from the
  // sample, zero velocity, and a huge covariance so the first few updates
  // pull the state hard toward the data.
  init(z) {
    this.pos = z;
    this.vel = 0;
    this.p00 = P_INIT; this.p01 = 0;
    this.p10 = 0;      this.p11 = P_INIT;
    this.initialized = true;
  }

  // Predict step: x = F x ; P = F P F' + Q. Runs every animation frame,
  // whether or not a measurement arrived — that is what makes the estimate
  // coast smoothly along its velocity when the cursor stops or leaves.
  predict(dt, sigmaA) {
    // x = F x
    this.pos += this.vel * dt;

    // P = F P F' + Q, expanded for F = [[1,dt],[0,1]]:
    const dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt3 * dt;
    const qs = sigmaA * sigmaA;
    const p00 = this.p00 + dt * (this.p10 + this.p01) + dt2 * this.p11 + qs * dt4 / 4;
    const p01 = this.p01 + dt * this.p11 + qs * dt3 / 2;
    const p10 = this.p10 + dt * this.p11 + qs * dt3 / 2;
    const p11 = this.p11 + qs * dt2;
    this.p00 = p00; this.p01 = p01; this.p10 = p10; this.p11 = p11;

    // Cap the diagonal so covariance cannot blow up during long
    // predict-only coasting (pointer off the canvas). On re-entry the
    // still-large P makes the filter snap to the new data.
    this.p00 = Math.min(this.p00, P_CAP);
    this.p11 = Math.min(this.p11, P_CAP);
  }

  // Update step with a scalar observation z. Returns the innovation
  // (measurement minus prediction); callers may ignore it.
  update(z, sigmaR) {
    const R = sigmaR * sigmaR;

    // Innovation and its (scalar) variance: y = z - Hx ; S = H P H' + R.
    const y = z - this.pos;
    const S = this.p00 + R;

    // Kalman gain K = P H' / S — a 2-vector, no inversion needed.
    const k0 = this.p00 / S;
    const k1 = this.p10 / S;

    // State correction: x = x + K y.
    this.pos += k0 * y;
    this.vel += k1 * y;

    // Covariance update: P = (I - K H) P, expanded for H = [1, 0].
    const p00 = (1 - k0) * this.p00;
    const p01 = (1 - k0) * this.p01;
    const p10 = this.p10 - k1 * this.p00;
    const p11 = this.p11 - k1 * this.p01;

    // Symmetrize: P = (P + P') / 2, killing the asymmetry that floating-
    // point rounding introduces so P stays a valid covariance.
    this.p00 = p00;
    this.p11 = p11;
    this.p01 = this.p10 = (p01 + p10) / 2;

    return y;
  }

  // Numerical health check. If anything went non-finite, flag the filter
  // for reinitialization from the next pointer sample.
  isHealthy() {
    return Number.isFinite(this.pos) && Number.isFinite(this.vel) &&
           Number.isFinite(this.p00) && Number.isFinite(this.p01) &&
           Number.isFinite(this.p10) && Number.isFinite(this.p11);
  }
}
