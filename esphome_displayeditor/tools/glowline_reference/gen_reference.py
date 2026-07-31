"""Reference oracle: render test documents with the original Qt code.

The .glraw that produced dist/ is gone, so the shipped PNGs cannot serve as a
regression baseline. Instead the original renderer itself is the oracle: it
emits both the sampled path geometry and the rendered pixels for a set of
documents, which the JavaScript port is then measured against.
"""
import json
import os
import sys

sys.path.insert(0, r"C:\Users\nriedle\Desktop\clode\glowline-editor")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QGuiApplication  # noqa: E402

app = QGuiApplication([])

from glowline.model import Document, Stroke  # noqa: E402
from glowline.renderer import (  # noqa: E402
    flow_bounds_document,
    flow_layout,
    render_document,
    render_flow_frames,
)

OUT = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(OUT, "reference")
os.makedirs(REF, exist_ok=True)


def stroke(**kw):
    flow = kw.pop("flow", None)
    glow = kw.pop("glow", None)
    s = Stroke(**kw)
    if flow:
        for k, v in flow.items():
            setattr(s.flow, k, v)
        s.flow.enabled = flow.get("enabled", True)
    if glow:
        for k, v in glow.items():
            setattr(s.glow, k, v)
    return s


CASES = {
    # A right angle exercises the fillet maths at its most visible.
    "corner": dict(
        size=(200, 160),
        strokes=[stroke(points=[[30, 30], [170, 30], [170, 130]],
                        color565=0x07FF, width=6, corner_radius=25,
                        glow={"enabled": False})],
    ),
    # Radius larger than half the shortest edge must be clamped, not overlap.
    "tight": dict(
        size=(120, 120),
        strokes=[stroke(points=[[20, 20], [60, 20], [60, 100]],
                        color565=0xF800, width=4, corner_radius=200,
                        glow={"enabled": False})],
    ),
    "smooth": dict(
        size=(220, 140),
        strokes=[stroke(points=[[20, 110], [70, 30], [140, 110], [200, 40]],
                        mode="smooth", color565=0x07E0, width=5,
                        glow={"enabled": False})],
    ),
    "closed_ring": dict(
        size=(160, 160),
        strokes=[stroke(points=[[40, 40], [120, 40], [120, 120], [40, 120]],
                        closed=True, color565=0xFFE0, width=5,
                        corner_radius=20, glow={"enabled": False})],
    ),
    "glow": dict(
        size=(200, 100),
        strokes=[stroke(points=[[20, 50], [180, 50]], color565=0x07FF,
                        width=6, glow={"enabled": True, "radius": 16,
                                       "intensity": 0.85})],
    ),
    "flow_arrows": dict(
        size=(240, 100),
        strokes=[stroke(points=[[20, 50], [220, 50]], color565=0x001F,
                        width=6, glow={"enabled": False},
                        flow={"enabled": True, "mode": "arrows", "spacing": 45,
                              "size": 16, "color565": 0xFFFF})],
    ),
    "flow_dashes": dict(
        size=(240, 100),
        strokes=[stroke(points=[[20, 50], [220, 50]], color565=0x001F,
                        width=8, glow={"enabled": False},
                        flow={"enabled": True, "mode": "dashes", "spacing": 40,
                              "size": 18, "color565": 0xFFFF})],
    ),
    "flow_glow_reversed": dict(
        size=(240, 120),
        strokes=[stroke(points=[[20, 30], [120, 90], [220, 30]],
                        color565=0x780F, width=5, corner_radius=18,
                        glow={"enabled": True, "radius": 10, "intensity": 0.6},
                        flow={"enabled": True, "mode": "arrows", "spacing": 38,
                              "size": 14, "reversed": True, "glow_radius": 7,
                              "glow_intensity": 0.9, "color565": 0x07FF})],
    ),
}


def sample_path(s, n=64):
    """Points and tangent angles at evenly spaced *arc lengths*.

    Sampled the way renderer._arrow_path does it - percentAtLength first, then
    pointAtPercent. Qt documents that pointAtPercent alone is not arc-length
    parametrised once curves are involved, so feeding it a raw fraction would
    compare a different curve parametrisation than the markers actually use.
    """
    path = s.path()
    length = path.length()
    out = []
    for i in range(n + 1):
        t = path.percentAtLength(i / n * length)
        pos = path.pointAtPercent(t)
        out.append([round(pos.x(), 4), round(pos.y(), 4),
                    round(path.angleAtPercent(t), 4)])
    return {"length": round(length, 4), "samples": out}


manifest = {}
for name, case in CASES.items():
    w, h = case["size"]
    doc = Document(width=w, height=h)
    doc.strokes = case["strokes"]

    entry = {
        "size": [w, h],
        "strokes": [s.to_dict() for s in doc.strokes],
        "paths": [sample_path(s) for s in doc.strokes],
    }
    bounds = flow_bounds_document(doc)
    if bounds is not None:
        entry["flow_bounds"] = [round(bounds.left(), 4), round(bounds.top(), 4),
                                round(bounds.right(), 4), round(bounds.bottom(), 4)]
    entry["flow_layout"] = [
        list(flow_layout(s.path(), s.flow.spacing)) if s.flow.enabled else None
        for s in doc.strokes
    ]

    render_document(doc, 1.0).save(os.path.join(REF, f"{name}.png"), "PNG")
    frames = render_flow_frames(doc, 3, 1.0, transparent_bg=True, with_lines=False)
    if any(s.flow.enabled for s in doc.strokes):
        for i, frame in enumerate(frames):
            frame.save(os.path.join(REF, f"{name}_flow_{i}.png"), "PNG")
        entry["frames"] = 3

    manifest[name] = entry

with open(os.path.join(REF, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=1)

print(f"{len(CASES)} Faelle nach {REF}")
for name in CASES:
    print("  ", name)
