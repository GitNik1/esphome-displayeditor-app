$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

$appRoot = Split-Path -Parent $PSScriptRoot
Push-Location $appRoot
try {
    python -m uv pip compile --python-version 3.13 --universal `
        --no-emit-index-url --output-file constraints.txt requirements-dev.txt
    git diff --exit-code -- constraints.txt
    python -m pip check
    python -m ruff check backend tests tools
    python -m compileall -q backend tests tools
    python tools/check_architecture.py
    node --test tests/frontend/*.test.mjs
    python -m pytest -q --cov=backend --cov-report=term `
        --cov-fail-under=83
}
finally {
    Pop-Location
}
