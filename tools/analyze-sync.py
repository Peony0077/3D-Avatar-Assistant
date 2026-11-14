#!/usr/bin/env python3
"""Quantitative lip-sync check for a capture (tools/capture-video.mjs output folder).

Compares per-frame mouth opening (from the viseme weights that were rendered) with the loudness of
the exported soundtrack: the cross-correlation peak gives the audio/visual offset. Also reports how
many frames had a full lip closure (P/B/M) and the mouth activity during silence.

    python3 tools/analyze-sync.py .work/capture-frames
"""
import json
import sys
import wave

import numpy as np

folder = sys.argv[1] if len(sys.argv) > 1 else ".work/capture-frames"
data = json.load(open(f"{folder}/visemes.json"))
fps = data["fps"]
frames = data["frames"]
OPEN = {"aa": 1.0, "O": 0.8, "E": 0.6, "I": 0.5, "U": 0.5, "CH": 0.4, "TH": 0.3, "DD": 0.3, "SS": 0.25, "kk": 0.3, "nn": 0.25, "RR": 0.3}
mouth = np.array([sum(f.get(k, 0) * w for k, w in OPEN.items()) for f in frames])
pp = np.array([f.get("PP", 0) for f in frames])

with wave.open(f"{folder}/sound.wav") as w:
    sr = w.getframerate()
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
hop = sr // fps
n = min(len(frames), len(audio) // hop - 1)
# frame i is rendered for time i/fps: use an audio window centred on that time
rms = np.array([np.sqrt(np.mean(audio[max(0, i * hop - hop // 2):i * hop + hop // 2] ** 2)) for i in range(n)])
mouth = mouth[:n]
pp = pp[:n]

def z(x):
    return (x - x.mean()) / (x.std() + 1e-9)

lags = np.arange(-8, 9)  # +-267 ms at 30 fps; mouth[t] vs audio[t + lag]
corr = np.array([np.mean(z(mouth)[max(0, -l):n - max(0, l)] * z(rms)[max(0, l):n - max(0, -l)]) for l in lags])
k = int(np.argmax(corr))
frac = 0.0
if 0 < k < len(lags) - 1:  # parabolic sub-frame interpolation
    a, b, c = corr[k - 1], corr[k], corr[k + 1]
    frac = 0.5 * (a - c) / (a - 2 * b + c)
best = lags[k] + frac
voiced = rms > 0.02
print(f"frames analysed: {n} ({n / fps:.1f} s)")
print(f"mouth-vs-audio correlation: peak r={corr.max():.2f} at {best * 1000 / fps:+.0f} ms "
      f"(positive = mouth leads the sound; natural speech: mouth leads by ~0-60 ms)")
print(f"mouth activity during silence (mean opening): {mouth[~voiced].mean():.3f}  vs speech: {mouth[voiced].mean():.3f}")
print(f"frames with lips fully closed for P/B/M (PP>0.85): {(pp > 0.85).sum()}")
