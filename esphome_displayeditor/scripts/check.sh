#!/bin/sh
set -eu

app_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$app_root"

python -m uv pip compile --python-version 3.13 --universal \
    --no-emit-index-url --output-file constraints.txt requirements-dev.txt
git diff --exit-code -- constraints.txt
python -m pip check
python -m ruff check backend tests tools
python -m compileall -q backend tests tools
node --test tests/frontend/*.test.mjs
python -m pytest -q --cov=backend --cov-report=term --cov-fail-under=83
