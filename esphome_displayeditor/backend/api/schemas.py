"""Validated request bodies accepted by the HTTP API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, SecretStr


class DraftRequest(BaseModel):
    content: str = Field(max_length=4 * 1024 * 1024)


class PublishRequest(BaseModel):
    expected_revision: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class DesignerProjectRequest(BaseModel):
    project: dict[str, Any]


class CustomBindingYamlRequest(BaseModel):
    content: str = Field(min_length=1, max_length=128 * 1024)


class MergeDraftRequest(BaseModel):
    """Designer data to merge into an existing configuration draft."""

    project: dict[str, Any]
    target: str


class CanvasSize(BaseModel):
    width: int = Field(ge=1, le=4096)
    height: int = Field(ge=1, le=4096)


class ImportRequest(BaseModel):
    """An existing configuration or pasted/uploaded YAML content."""

    configuration: str | None = None
    content: str | None = Field(default=None, max_length=4 * 1024 * 1024)
    canvas: CanvasSize | None = None


class AssetImageRequest(BaseModel):
    """A base64-encoded PNG image to place in the project image store."""

    name: str = Field(min_length=1, max_length=128)
    content_base64: str = Field(min_length=1, max_length=8 * 1024 * 1024)


class AssetFontRequest(BaseModel):
    """A base64-encoded TrueType/OpenType file for the font library."""

    name: str = Field(min_length=1, max_length=128)
    content_base64: str = Field(min_length=1, max_length=24 * 1024 * 1024)


class FontSourceCheckRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    etag: str = Field(default="", max_length=512)
    last_modified: str = Field(default="", max_length=256)
    sha256: str = Field(default="", pattern=r"^$|^[0-9a-f]{64}$")


class FontSourceUpdateRequest(BaseModel):
    id: str = Field(min_length=1, max_length=63, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    url: str = Field(min_length=8, max_length=2048)


class FontGlyphCoverageRequest(BaseModel):
    path: str = Field(min_length=5, max_length=512)
    codepoints: list[int] = Field(min_length=1, max_length=512)


class SaveDesignerProjectRequest(DesignerProjectRequest):
    expected_revision: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )


class DeviceRequest(BaseModel):
    id: str = Field(min_length=1, max_length=63)
    name: str = Field(min_length=1, max_length=80)
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(default=6053, ge=1, le=65535)
    encryption_key_ref: str = Field(min_length=1, max_length=63)


class DeviceSecretRequest(BaseModel):
    encryption_key: SecretStr


class ViewerBindingsRequest(BaseModel):
    bindings: list[dict[str, Any]] = Field(default_factory=list, max_length=256)
    expected_revision: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )


class InstallRequest(BaseModel):
    # The active YAML resolves the target. Arbitrary hosts, serial devices and
    # generic command arguments are deliberately not exposed by this API.
    port: str = Field(default="OTA", pattern="^OTA$")
    confirmed: bool = False
