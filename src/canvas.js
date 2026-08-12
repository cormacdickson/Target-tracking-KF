"use strict";
/* ================================================================
 * CANVAS — the tracking canvas and its devicePixelRatio handling
 * ================================================================
 * Needs:    the #canvas element; clearTrails() from tracking.js (called
 *           at runtime only, so load order does not matter for it)
 * Provides: canvas, ctx, W, H, resizeCanvas
 *
 * The canvas backing store is scaled by devicePixelRatio; a matching ctx
 * transform means all drawing logic works in plain CSS pixels.
 */
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
let W = 0, H = 0; // canvas size in CSS pixels

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  W = rect.width;
  H = rect.height;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clearTrails(); // trails are in CSS-px coordinates of the old size
}
window.addEventListener("resize", resizeCanvas);
