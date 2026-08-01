from __future__ import annotations

from pathlib import Path

import pytest

from backend.errors import ApiError
from backend.workflow import WorkflowStore


def test_validation_proof_is_revision_bound_and_expires(tmp_path: Path) -> None:
    store = WorkflowStore(tmp_path)
    store.record_validation("display.yaml", "sha256:old", "2026.7.2", now=100.0)
    assert store.require_validation(
        "display.yaml", "sha256:old", 60, now=159.0
    )["age_seconds"] == 59
    with pytest.raises(ApiError, match="changed") as mismatch:
        store.require_validation("display.yaml", "sha256:new", 60, now=159.0)
    assert mismatch.value.error == "validation_revision_mismatch"
    with pytest.raises(ApiError, match="too old") as expired:
        store.require_validation("display.yaml", "sha256:old", 60, now=161.0)
    assert expired.value.error == "validation_expired"


def test_corrupt_workflow_database_is_archived_and_fails_closed(tmp_path: Path) -> None:
    database_dir = tmp_path / "database"
    database_dir.mkdir(parents=True)
    (database_dir / "workflow.sqlite3").write_bytes(b"not a sqlite database")

    recovered = WorkflowStore(tmp_path)

    assert list(database_dir.glob("workflow.corrupt-*.sqlite3"))
    with pytest.raises(ApiError) as missing:
        recovered.require_validation("display.yaml", "sha256:any", 900)
    assert missing.value.error == "validation_required"
