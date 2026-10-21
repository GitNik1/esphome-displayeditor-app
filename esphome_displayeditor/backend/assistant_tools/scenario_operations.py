"""Typed Viewer-scenario operations accepted from machine-driven clients.

Scenarios are what the Viewer plays for device states the browser cannot
compute (see ``backend/viewer_scenarios.py``). Actions use the same portable
form as widget events: ``{"lvgl.label.update": {"id": "x", "text": "1"}}``;
a lambda argument is ``{"__esphome_lambda__": "return 1;"}``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from .operations import StrictOperationModel

_NAME = Field(min_length=1, max_length=120)


class UpsertScenarioOperation(StrictOperationModel):
    """Create a scenario, or replace the one with this ``name``.

    ``rename_to`` renames it in place; transition tables referring to the
    old name are updated with it.
    """

    op: Literal["upsert_scenario"]
    name: str = _NAME
    rename_to: str | None = Field(default=None, min_length=1, max_length=120)
    actions: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    on: str | dict[str, Any] | None = None
    transitions: dict[str, str] | None = Field(default=None, max_length=100)
    initial: str | None = Field(default=None, min_length=1, max_length=120)


class DeleteScenarioOperation(StrictOperationModel):
    op: Literal["delete_scenario"]
    name: str = _NAME


class AdoptSuggestionsOperation(StrictOperationModel):
    """Copy import suggestions into the scenarios; ``names`` empty = all.
    Suggestions whose name already exists are skipped, not overwritten."""

    op: Literal["adopt_suggestions"]
    names: list[str] = Field(default_factory=list, max_length=100)


class SetScenariosYamlOperation(StrictOperationModel):
    """Replace the whole scenario YAML (the format the Viewer's editor shows)."""

    op: Literal["set_scenarios_yaml"]
    yaml: str = Field(max_length=128 * 1024)


ScenarioOperation = Annotated[
    UpsertScenarioOperation | DeleteScenarioOperation | AdoptSuggestionsOperation
    | SetScenariosYamlOperation,
    Field(discriminator="op"),
]


def scenario_operation_payload(operation: ScenarioOperation | dict[str, Any]) -> dict[str, Any]:
    if isinstance(operation, BaseModel):
        return operation.model_dump(mode="python", exclude_none=True)
    return dict(operation)
