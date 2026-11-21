from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
def check_frontend_boundaries() -> list[str]:
    errors: list[str] = []
    pure_roots = ("actions", "builder", "designer", "devices", "project", "properties", "runtime", "state", "system")
    forbidden = ("document.", "window.", "new WebSocket(")
    for root in pure_roots:
        for path in (FRONTEND / root).glob("*.js"):
            if path.name == "view.js":
                continue
            text = path.read_text(encoding="utf-8")
            for marker in forbidden:
                if marker in text:
                    errors.append(f"{path.relative_to(ROOT)} accesses {marker.rstrip('.')}")
    for path in (FRONTEND / "canvas").glob("*.js"):
        if path.name == "view.js":
            continue
        text = path.read_text(encoding="utf-8")
        for marker in forbidden:
            if marker in text:
                errors.append(f"{path.relative_to(ROOT)} accesses {marker.rstrip('.')}")
    for path in (FRONTEND / "controllers").glob("*.js"):
        if len(path.read_text(encoding="utf-8").splitlines()) > 300:
            errors.append(f"{path.relative_to(ROOT)} exceeds 300 lines")
    return errors


def check_strict_frontend_modules() -> list[str]:
    errors: list[str] = []
    for path in sorted(FRONTEND.rglob("*.js")):
        if path.relative_to(FRONTEND).as_posix() == "viewer-wasm/lvgl-wasm.js":
            # Generated and minified by the pinned Emscripten build. Its
            # handwritten adapter is checked; editing this artifact is not.
            continue
        leading_lines = path.read_text(encoding="utf-8-sig").splitlines()[:20]
        if "// @ts-check" not in (line.strip() for line in leading_lines):
            errors.append(
                f"{path.relative_to(ROOT)} is not explicitly type-checked"
            )
    return errors


def check_backend_syntax() -> list[str]:
    for path in (ROOT / "backend").rglob("*.py"):
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return []


MODULE_LINE_LIMIT = 500

#: Modules that were already above the limit when it was extended from
#: backend/assistant_tools and backend/mcp (MCP-UMSETZUNGSPLAN.md §3) to every
#: production module. They may shrink - lower the number when they do - but
#: never grow; the composition root app.js is being split up step by step.
OVERSIZED_BASELINE = {
    "frontend/app.js": 10374,
    "frontend/viewer/viewer.js": 1001,
    "frontend/layout.js": 521,
    "backend/entity_bindings.py": 934,
    "backend/designer.py": 770,
    "backend/lvgl_merge.py": 696,
    "backend/filesystem.py": 625,
}

#: Generated or copied code: the MDI glyph catalog and translation tables,
#: the Emscripten build, and designer_core (a byte copy of the desktop app).
LINE_LIMIT_EXEMPT = (
    "frontend/mdi-glyphs.js",
    "frontend/i18n.js",
    "frontend/viewer-wasm/lvgl-wasm.js",
    "backend/designer_core/",
)


def check_module_line_limits() -> list[str]:
    errors: list[str] = []
    paths = [*sorted((ROOT / "backend").rglob("*.py")), *sorted(FRONTEND.rglob("*.js"))]
    for path in paths:
        relative = path.relative_to(ROOT).as_posix()
        if path.name == "__init__.py" or relative.startswith(LINE_LIMIT_EXEMPT):
            continue
        line_count = len(path.read_text(encoding="utf-8").splitlines())
        limit = OVERSIZED_BASELINE.get(relative, MODULE_LINE_LIMIT)
        if line_count > limit:
            kind = "grew past its baseline" if relative in OVERSIZED_BASELINE else "exceeds"
            errors.append(f"{relative} {kind} {limit} lines ({line_count})")
    return errors


def main() -> int:
    errors = (
        check_frontend_boundaries()
        + check_strict_frontend_modules()
        + check_backend_syntax()
        + check_module_line_limits()
    )
    if errors:
        print("Architecture violations:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Architecture checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
