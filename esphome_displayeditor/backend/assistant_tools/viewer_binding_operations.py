"""Strict operations for add-on-only Viewer binding sidecars."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

_WIDGET_ID = r"^[A-Za-z_][A-Za-z0-9_]*$"
_DEVICE_ID = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
_ENTITY_ID = r"^[a-z0-9_]+:[A-Za-z0-9_.:-]+$"


class StrictViewerBindingModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SetViewerBindingOperation(StrictViewerBindingModel):
    op: Literal["set_viewer_binding"]
    widget_id: str = Field(pattern=_WIDGET_ID, max_length=128)
    target: Literal["text", "value", "state_checked"]
    device_id: str = Field(pattern=_DEVICE_ID, max_length=63)
    entity_id: str = Field(pattern=_ENTITY_ID, max_length=193)
    value_format: str = Field(default="{state}", max_length=128)
    fallback: str = Field(default="", max_length=128)
    stale_after: int = Field(default=0, ge=0, le=86400)


class RemoveViewerBindingOperation(StrictViewerBindingModel):
    op: Literal["remove_viewer_binding"]
    widget_id: str = Field(pattern=_WIDGET_ID, max_length=128)
    target: Literal["text", "value", "state_checked"]


ViewerBindingOperation = Annotated[
    SetViewerBindingOperation | RemoveViewerBindingOperation,
    Field(discriminator="op"),
]


def viewer_binding_operation_payload(operation: Any) -> dict[str, Any]:
    if isinstance(operation, BaseModel):
        return operation.model_dump(mode="python", exclude_none=True)
    return dict(operation)
