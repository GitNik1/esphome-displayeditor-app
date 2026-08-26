"""Safe text-template handling for generated ESPHome printf actions."""

from __future__ import annotations

import re
from typing import Any


_VALUE_PLACEHOLDER = re.compile(r"\{(?:value|state)\}")
MAX_BINDING_FORMAT_LENGTH = 128


def validate_binding_format(value: Any) -> str:
    """Require one typed value placeholder and reject unsafe string payloads."""
    if not isinstance(value, str):
        raise ValueError("Binding format must be a string.")
    if not value or len(value) > MAX_BINDING_FORMAT_LENGTH or "\x00" in value:
        raise ValueError(
            f"Binding format must contain 1-{MAX_BINDING_FORMAT_LENGTH} characters."
        )
    if len(_VALUE_PLACEHOLDER.findall(value)) != 1:
        raise ValueError(
            "Binding format must contain exactly one {value} or {state} placeholder."
        )
    return value


def compile_numeric_binding_format(value: Any) -> str:
    """Build a printf format with exactly one application-controlled conversion."""
    template = validate_binding_format(value)
    escaped = template.replace("%", "%%")
    return _VALUE_PLACEHOLDER.sub("%.1f", escaped)
