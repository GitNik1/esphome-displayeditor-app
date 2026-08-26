"""Strict semantic project-binding operations for machine-driven clients."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..binding_formats import validate_binding_format

_ID = r"^[A-Za-z_][A-Za-z0-9_]*$"
EntityDomain = Literal[
    "sensor",
    "binary_sensor",
    "text_sensor",
    "switch",
    "light",
    "number",
    "select",
    "button",
    "fan",
    "cover",
    "climate",
    "lock",
    "media_player",
    "alarm_control_panel",
    "script",
]


class StrictBindingModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class BindingTransformSpec(StrictBindingModel):
    factor: float | None = Field(default=None, ge=-1_000_000, le=1_000_000)
    offset: float | None = Field(default=None, ge=-1_000_000, le=1_000_000)
    input_min: float | None = Field(default=None, ge=-1_000_000_000, le=1_000_000_000)
    input_max: float | None = Field(default=None, ge=-1_000_000_000, le=1_000_000_000)
    output_min: float | None = Field(default=None, ge=-1_000_000_000, le=1_000_000_000)
    output_max: float | None = Field(default=None, ge=-1_000_000_000, le=1_000_000_000)
    min: float | None = Field(default=None, ge=-1_000_000_000, le=1_000_000_000)
    max: float | None = Field(default=None, ge=-1_000_000_000, le=1_000_000_000)
    clamp: bool | None = None
    round: int | None = Field(default=None, ge=0, le=6)
    format: str | None = Field(default=None, max_length=128)
    off_threshold: float | None = Field(default=None, ge=0, le=1_000_000_000)
    fast_threshold: float | None = Field(default=None, ge=0, le=1_000_000_000)
    normal_duration: int | None = Field(default=None, ge=10, le=600_000)
    fast_duration: int | None = Field(default=None, ge=10, le=600_000)

    @field_validator("format")
    @classmethod
    def validate_text_format(cls, value: str | None) -> str | None:
        return None if value is None else validate_binding_format(value)


class BindingConditionSpec(StrictBindingModel):
    operator: Literal["eq", "ne", "gt", "gte", "lt", "lte"]
    value: bool | int | float | Annotated[str, Field(max_length=256)]


class SetProjectBindingOperation(StrictBindingModel):
    op: Literal["set_project_binding"]
    binding_id: str = Field(pattern=_ID, max_length=128)
    direction: Literal["entity_to_widget", "widget_to_entity", "bidirectional"]
    entity_domain: EntityDomain
    entity_id: str = Field(pattern=_ID, max_length=128)
    widget_id: str = Field(pattern=_ID, max_length=128)
    widget_property: str | None = Field(default=None, pattern=_ID, max_length=64)
    widget_event: str | None = Field(default=None, pattern=_ID, max_length=64)
    entity_command: str | None = Field(default=None, pattern=_ID, max_length=64)
    indicator_id: str | None = Field(default=None, pattern=_ID, max_length=128)
    reverse_widget_id: str | None = Field(default=None, pattern=_ID, max_length=128)
    transform: BindingTransformSpec | None = None
    conditions: list[BindingConditionSpec] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def validate_direction_fields(self) -> "SetProjectBindingOperation":
        incoming = self.direction in {"entity_to_widget", "bidirectional"}
        outgoing = self.direction in {"widget_to_entity", "bidirectional"}
        if incoming and not self.widget_property:
            raise ValueError("widget_property is required for an incoming binding")
        if outgoing and (not self.widget_event or not self.entity_command):
            raise ValueError(
                "widget_event and entity_command are required for an outgoing binding"
            )
        if not incoming and self.widget_property is not None:
            raise ValueError("widget_property is not valid for an outgoing-only binding")
        if not outgoing and (
            self.widget_event is not None or self.entity_command is not None
        ):
            raise ValueError(
                "widget_event and entity_command require an outgoing binding direction"
            )
        if self.indicator_id and not str(self.widget_property).startswith("indicator_"):
            raise ValueError("indicator_id requires an indicator_* widget_property")
        if self.reverse_widget_id and self.widget_property != "flow_direction":
            raise ValueError("reverse_widget_id requires flow_direction")
        return self


class RemoveProjectBindingOperation(StrictBindingModel):
    op: Literal["remove_project_binding"]
    binding_id: str = Field(pattern=_ID, max_length=128)


ProjectBindingOperation = Annotated[
    SetProjectBindingOperation | RemoveProjectBindingOperation,
    Field(discriminator="op"),
]


def binding_operation_payload(operation: Any) -> dict[str, Any]:
    if isinstance(operation, BaseModel):
        return operation.model_dump(mode="python", exclude_none=True)
    return dict(operation)
