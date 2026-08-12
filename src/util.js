"use strict";
/* ================================================================
 * UTIL — pure helpers, no DOM, no shared state
 * ================================================================
 * Needs:    nothing
 * Provides: gaussian, median, mad
 */

// Box-Muller transform: Gaussian sample from two uniforms.
function gaussian() {
  let u = 0;
  while (u === 0) u = Math.random(); // avoid log(0)
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Median absolute deviation — a robust spread estimate. The 1.4826 factor
// (applied by the caller) makes it comparable to a standard deviation for
// Gaussian data.
function mad(arr) {
  const m = median(arr);
  return median(arr.map((v) => Math.abs(v - m)));
}
