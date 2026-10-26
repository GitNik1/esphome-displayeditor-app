"""Validated request bodies accepted by the HTTP API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, SecretStr


_REVISION = r"^sha256:[0-9a-f]{64}$"


class DraftRequest(BaseModel):
    content: str = Field(max_length=4 * 1024 * 1024)
    #: The draft revision the edit started from - null: "there was no
    #: draft". Left out, the draft is overwritten unchecked (older clients).
    expected_draft_revision: str | None = Field(default=None, pattern=_REVISION)


class PublishRequest(BaseModel):
    expected_revision: str = Field(pattern=_REVISION)
    #: The draft revision that was reviewed; a draft changed since is refused.
    expected_draft_revision: str | None = Field(default=None, pattern=_REVISION)


class DesignerProjectRequest(BaseModel):
    project: dict[str, Any]


class CustomBindingYamlRequest(BaseModel):
    content: str = Field(min_length=1, max_length=128 * 1024)


class ViewerScenariosRequest(BaseModel):
    content: str = Field(max_length=128 * 1024)


class MergeDraftRequest(BaseModel):
    """Designer data to merge into an existing configuration draft."""

    project: dict[str, Any]
    target: str
    #: Like ``DraftRequest.expected_draft_revision``: the draft the merge may
    #: build on; left out, whatever draft is there is used.
    expected_draft_revision: str | None = Field(default=None, pattern=_REVISION)
    #: The user agreed to comment out the target display's own drawing
    #: (lambda:, pages:, ...) so LVGL can take it over.
    confirm_display_takeover: bool = False


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


class AnnotateProjectRevisionRequest(BaseModel):
    """Names a version. Never touches the lock - the two are independent."""

    label: str | None = Field(default=None, max_length=80)


class RestoreProjectRevisionRequest(BaseModel):
    #: ``None`` recreates a project whose file was deleted.
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


class MCPTokenCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scopes: list[str] = Field(min_length=1, max_length=8)
    expires_in_seconds: int = Field(
        default=30 * 24 * 60 * 60,
        ge=3600,
        le=365 * 24 * 60 * 60,
    )


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


class AssistantAskRequest(BaseModel):
    # project_name/configuration_name fix the tool scope for this one
    # request server-side (help_assistant/scope.py); the model is never
    # given a parameter to pick a different project or configuration.
    project_name: str = Field(min_length=1, max_length=255)
    configuration_name: str | None = Field(default=None, max_length=255)
    message: str = Field(min_length=1, max_length=4000)


class ApplyProjectResyncRequest(BaseModel):
    # Which groups of the re-imported config to adopt. Empty is rejected
    # rather than treated as "all": a re-sync that was confirmed with nothing
    # ticked is a mistake, not a request to overwrite everything.
    groups: list[Literal["entities", "resources", "layout"]] = Field(
        min_length=1, max_length=3
    )
    expected_revision: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )
    # Keeps the pre-import version out of the rolling window, for an import
    # whose damage only becomes obvious weeks later.
    lock_previous: bool = False
