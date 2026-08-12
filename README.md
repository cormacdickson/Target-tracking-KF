# Target-tracking-KF

A single-page demo of a Kalman filter cleaning up noisy cursor input, with a
second panel that reads out how attentively you're tracking.

No dependencies, no build step, no network requests. Open `index.html` in a
browser and it runs. Uses `pointermove`, so it works on touch too.

## Layout

```
index.html   markup only
styles.css
src/
  config.js            every tunable number in one place
  util.js              gaussian(), median(), mad()
  target.js            where the dot is, and its analytic velocity
  kalman.js            the KF1D filter class
  canvas.js            tracking canvas + devicePixelRatio handling
  cursor.js            estimates hand velocity from cursor position
  tracking.js          filter state, trails, pointer input
  metrics.js           RMSE windows and the metrics panel
  tracking-render.js   everything drawn on the main canvas
  attention.js         attention pipeline, calibration, score, logging
  attention-chart.js   the strip chart
  ui.js                sliders, buttons, phases, CSV export
  main.js              the animation loop — start here
```

`main.js` is the best entry point: one `requestAnimationFrame` loop that
advances the dot, steps the filters, updates metrics, runs the attention
pipeline, and draws. Each file's header comment says what it needs and what it
provides.

These are plain `<script>` tags rather than ES modules on purpose — modules are
blocked by CORS when a page is opened straight from disk, and this demo is meant
to run by double-clicking `index.html`. Load order in `index.html` is dependency
order.

## What you're looking at

A white dot drifts around the canvas. You follow it with your cursor. Your
cursor position, plus artificial noise, is fed to the filter.

- **White dot** — the true target.
- **Orange marks** — what the filter actually sees: your cursor with noise added.
- **Cyan dot** — the filter's estimate, reconstructed from the orange marks alone.

The point is that the cyan dot beats the orange scatter. The metrics panel
shows by how much, as RMSE against the true dot over the last ~5 seconds.

## The sliders

Two of these sound alike and aren't:

| Slider | What it does |
|---|---|
| **Injected noise σₙ** | Really corrupts the data. Changes the orange scatter you see. |
| **Measurement noise σᵣ** | Only the filter's *assumption* about how noisy the data is. Changes nothing you see except the cyan dot's behaviour. |
| **Process noise σₐ** | The filter's assumption about how erratically the target moves. |

The filter does best when σᵣ matches σₙ (both default to 25). Breaking that
match on purpose is the interesting part: crank σᵣ to max and the estimate
turns smooth but laggy; drop it to min and it chases every jitter.

**Why inject noise at all?** A mouse is too good a sensor — real cursor jitter
is a pixel or two, which the filter would clean up invisibly. Injecting 25 px
gives it something to actually fix.

## The attention panel

Click **Start calibration** and track the dot for 45 seconds. That measures how
well *you* track when trying, and becomes your personal zero line. Low skill
gets absorbed into the baseline, so the score reads attention, not ability.

After that, twice a second the demo compares your cursor's velocity to the
dot's (offset by 150 ms, so normal reaction lag doesn't count against you) and
scores the gap against your baseline.

**Hide position filter** clears the orange observations, the cyan estimate and
the RMSE panel out of the way, leaving just the target and the velocity arrows.
The filter keeps running underneath, so the numbers are live again the moment
you switch it back on.

Two arrows on the canvas show this happening. Both start at your cursor: the
violet one is your hand's estimated velocity, the white one is the target's.
The amber dashed line joining their tips *is* the mismatch being scored — so
tracking well puts the arrows on top of each other, stopping collapses yours to
a point while the target's keeps swinging, and tracking sloppily makes them
diverge in angle without shrinking.

Your hand's velocity is itself estimated by a second pair of Kalman filters
(`src/cursor.js`). Pointer events only report position, so velocity has to be
inferred — and here every assumption the filter makes is literally true:
position really is the integral of velocity, and the measurement noise really
is pointer coordinate quantisation. As a bonus the filter reports how uncertain
its own velocity estimate is, which is used to throw away readings taken in the
moment after your pointer re-enters the canvas, when that estimate is briefly
worthless. The **score** is in standard deviations
from your own norm: 0 is tracking as well as you calibrated, negative is worse.
Below −2 for two seconds flips the pill to **attention lapse**; above −1 flips
it back.

Deliberately there's no filter or model here — the score is just the median of
the last four readings. When you move the pointer off the canvas the readings
stop, the line holds still, and grey shading marks the stretch where there was
no data rather than guessing what happened during it.

**Download CSV** dumps the whole session: `t, phase, mismatch, obs, z, score,
label, pointer_present`. **Restart phases** wipes it and starts over. (The
tracking demo's own Reset button doesn't touch any of this.)

## Honest limits

- The filter removes measurement noise, not human reaction lag. If your hand
  trails the dot, the estimate trails it too.
- Velocity mismatch is the only attention signal, so "looked away" and "tracked
  badly on purpose" are only partly distinguishable. Try both and see.
- If you calibrate very consistently, the baseline spread comes out small and
  the score gets twitchy — it'll wander ±1–2 during normal tracking. Lapse
  detection is unaffected (a parked cursor lands around −25). Recalibrating
  while tracking naturally, drift and corrections included, gives a calmer scale.
