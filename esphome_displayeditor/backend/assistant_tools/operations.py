"""Typed semantic operations accepted from machine-driven clients."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

_ID_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"
_OPTIONAL_ID_PATTERN = r"^(?:[A-Za-z_][A-Za-z0-9_]*)?$"
_SURFACE_PATTERN = (
    r"^(?:root|top|bottom|page:[A-Za-z_][A-Za-z0-9_]*|"
    r"msgbox:[A-Za-z_][A-Za-z0-9_]*:(?:buttons|header_buttons))$"
)


class StrictOperationModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class GridCellSpec(StrictOperationModel):
    row_pos: int = Field(default=0, ge=0, le=255)
    column_pos: int = Field(default=0, ge=0, le=255)
    row_span: int = Field(default=1, ge=1, le=256)
    column_span: int = Field(default=1, ge=1, le=256)
    x_align: Literal["START", "CENTER", "END", "STRETCH"] = "START"
    y_align: Literal["START", "CENTER", "END", "STRETCH"] = "START"


class PlacementSpec(StrictOperationModel):
    x: int | None = Field(default=None, ge=-4096, le=4096)
    y: int | None = Field(default=None, ge=-4096, le=4096)
    width: int | None = Field(default=None, ge=1, le=4096)
    height: int | None = Field(default=None, ge=1, le=4096)
    align: str | None = Field(default=None, min_length=1, max_length=32)
    align_to: str | None = Field(default=None, max_length=128)
    grid_cell: GridCellSpec | None = None


class AddWidgetOperation(StrictOperationModel):
    op: Literal["add_widget"]
    widget_id: str = Field(pattern=_ID_PATTERN, max_length=128)
    widget_type: str = Field(pattern=_ID_PATTERN, max_length=64)
    surface: str = Field(default="root", pattern=_SURFACE_PATTERN, max_length=180)
    parent_id: str = Field(default="", pattern=_OPTIONAL_ID_PATTERN, max_length=128)
    index: int | None = Field(default=None, ge=0, le=1000)
    placement: PlacementSpec = Field(default_factory=PlacementSpec)
    properties: dict[str, Any] = Field(default_factory=dict, max_length=64)
    style: dict[str, Any] = Field(default_factory=dict, max_length=64)
    layout: dict[str, Any] = Field(default_factory=dict, max_length=16)


class UpdateWidgetOperation(StrictOperationModel):
    op: Literal["update_widget"]
    widget_id: str = Field(pattern=_ID_PATTERN, max_length=128)
    name: str | None = Field(default=None, max_length=128)
    hidden: bool | None = None
    locked: bool | None = None
    placement: PlacementSpec | None = None
    properties: dict[str, Any] | None = Field(default=None, max_length=64)
    style: dict[str, Any] | None = Field(default=None, max_length=64)
    layout: dict[str, Any] | None = Field(default=None, max_length=16)


class PlaceWidgetOperation(StrictOperationModel):
    op: Literal["place_widget"]
    widget_id: str = Field(pattern=_ID_PATTERN, max_length=128)
    surface: str | None = Field(
        default=None,
        pattern=_SURFACE_PATTERN,
        max_length=180,
    )
    parent_id: str | None = Field(
        default=None,
        pattern=_OPTIONAL_ID_PATTERN,
        max_length=128,
    )
    index: int | None = Field(default=None, ge=0, le=1000)
    placement: PlacementSpec | None = None


PlacementOperation = Annotated[
    AddWidgetOperation | UpdateWidgetOperation | PlaceWidgetOperation,
    Field(discriminator="op"),
]


def operation_payload(operation: PlacementOperation | dict[str, Any]) -> dict[str, Any]:
    if isinstance(operation, BaseModel):
        return operation.model_dump(mode="python", exclude_none=True)
    return dict(operation)
