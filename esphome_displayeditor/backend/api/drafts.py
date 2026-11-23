"""Shared handling of the optional draft revision in API requests."""

from __future__ import annotations

from pydantic import BaseModel

from ..filesystem import DRAFT_UNCHECKED


def expected_draft_revision(body: BaseModel) -> object:
    """The draft revision a request names: None ("there was no draft") only
    when the client sent it. A client that does not send the field - an
    older frontend, a script - is not checked."""
    if "expected_draft_revision" in body.model_fields_set:
        return body.expected_draft_revision  # type: ignore[attr-defined]
    return DRAFT_UNCHECKED
