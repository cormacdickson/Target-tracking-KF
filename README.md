# Target-tracking-KF

Kalman filter estimate of mouse velocity, with 
second panel that reads out how 'attentively' you're tracking.

Open `index.html` in a
browser and it runs.

## Two estimators, side by side

Your velocity is worked out twice from the same cursor samples: once by a
Kalman filter, once by a Savitzky-Golay slope fit. The attention panel plots
both — same readout, same calibration, only the velocity differs — so the gap
between the lines is the estimator's doing and nothing else. Pink is
Savitzky-Golay, violet is Kalman. Pink drives the on-task/lapse verdict.

"Arrows: …" switches which one the canvas draws. Both keep running either way.

Two things worth knowing:

- The Savitzky-Golay fit is **centred**, so it describes your hand about half a
  window ago (~67 ms at 60 Hz). That lag is measured from the real timestamps
  and subtracted before comparing against the target, otherwise it would look
  like inattention when it is just how the method works.
- The window is counted in **samples**, so on a 120 Hz display it covers half
  the time it does at 60 Hz. The Kalman filter's settings are physical
  (px/s², px) and do not shift meaning like that — but it is the only one of
  the two that reports how uncertain it is.

