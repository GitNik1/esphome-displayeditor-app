# GlowLine reference check

The glow-line rendering in `frontend/glowline/` is a port of the desktop
[GlowLine Editor](../../../../glowline-editor)'s Qt renderer. These tools measure
the port against the original rather than against a screenshot, because the
`.glraw` that produced the shipped `dist/` images no longer exists — the PNGs
show what the output should look like, but cannot serve as a regression
baseline.

Instead the original renderer *is* the oracle: it runs headless via
`QT_QPA_PLATFORM=offscreen` and emits both sampled path geometry and rendered
pixels, which the JavaScript port is then compared against.

Not part of the add-on image — the Dockerfile only copies `backend/` and
`frontend/`.

## 1. Generate the reference

Needs PySide6 and a checkout of `glowline-editor` beside this repository.

```bash
python tools/glowline_reference/gen_reference.py
```

Writes `reference/` next to the script: one PNG per case, flow frames where a
case has markers, and `manifest.json` with the stroke definitions, sampled path
points and the expected marker layout.

## 2. Geometry

```bash
node tools/glowline_reference/compare_geometry.mjs
```

Compares path length, point positions and tangent angles against the manifest.

Last measured: length within 0.03 %, points within 0.033 px, angles within
0.6°. The residual angle error comes from flattening curves into 0.4 px
pieces, which is far below what marker placement can show.

> A trap worth remembering: `QPainterPath.pointAtPercent(t)` is **not**
> arc-length parametrised once curves are present — Qt maps `t` onto the Bezier
> parameter. The renderer calls `percentAtLength()` first, so the reference has
> to sample the same way. Comparing against a raw fraction makes a correct port
> look 6 px wrong on a spline.

## 3. Pixels

The harness has to be served over HTTP (ES modules do not load from `file:`).
Copy it somewhere that is already served — e.g. into a running container:

```bash
docker cp tools/glowline_reference/harness/. <container>:/app/frontend/check/
```

It also needs `glowline/` (the modules under test) and `ref/` (the generated
reference) beside `index.html`. Then open `/check/index.html`; the page renders
every case, compares it pixel by pixel against the Qt render and leaves the
summary in `window.__result`.

Reported per case: mean absolute channel error, worst single-pixel error, and
the share of channel values off by more than 24. Both renders are composited
over black first, so premultiplied-alpha differences do not dominate.

Last measured: worst mean 1.43/255, worst share above threshold 0.39 %, and
marker count, marker spacing and flow bounds identical to Qt. Antialiasing and
alpha accumulation differ slightly between Qt and Canvas, so an exact match is
not attainable — structure and geometry are what these numbers assert.
