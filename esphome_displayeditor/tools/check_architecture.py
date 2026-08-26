from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
def check_frontend_boundaries() -> list[str]:
    errors: list[str] = []
    pure_roots = ("actions", "builder", "devices", "project", "properties", "runtime", "state")
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


def check_mcp_module_line_limit() -> list[str]:
    """MCP-UMSETZUNGSPLAN.md §3 caps production modules at 500 lines.

    Scoped to backend/assistant_tools and backend/mcp - the modules that
    commitment actually covers - rather than the whole backend tree, which
    has long-standing files (e.g. designer_core/*) predating that rule.
    """
    errors: list[str] = []
    for directory in ("assistant_tools", "mcp"):
        for path in sorted((ROOT / "backend" / directory).glob("*.py")):
            if path.name == "__init__.py":
                continue
            line_count = len(path.read_text(encoding="utf-8").splitlines())
            if line_count > 500:
                errors.append(
                    f"{path.relative_to(ROOT)} exceeds 500 lines ({line_count})"
                )
    return errors


def main() -> int:
    errors = (
        check_frontend_boundaries()
        + check_strict_frontend_modules()
        + check_backend_syntax()
        + check_mcp_module_line_limit()
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
