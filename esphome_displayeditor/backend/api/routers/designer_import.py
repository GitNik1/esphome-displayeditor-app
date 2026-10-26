from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter

from ...designer import DesignerService
from ...errors import ApiError
from ...filesystem import FilesystemBackend
from ..schemas import ImportRequest


def create_designer_import_router(
    *,
    designer: DesignerService,
    filesystem: FilesystemBackend,
    ensure_capability_available: Callable[[str], None],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/designer/import", tags=["designer import"])

    def source(body: ImportRequest) -> tuple[str, str, str]:
        if body.configuration:
            ensure_capability_available("configuration.read")
            configuration = filesystem.read_config(body.configuration)
            return configuration["content"], configuration["name"], configuration["revision"]
        if body.content is None:
            raise ApiError(
                "invalid_request",
                "Provide either a configuration name or file content.",
                422,
            )
        return body.content, "", ""

    @router.post("/probe")
    def probe(body: ImportRequest) -> dict:
        text, _name, _revision = source(body)
        return designer.probe_yaml(text)

    @router.post("")
    def import_configuration(body: ImportRequest) -> dict:
        text, name, revision = source(body)
        canvas = (body.canvas.width, body.canvas.height) if body.canvas else None
        result = designer.import_yaml(text, canvas=canvas, source_name=name)
        if revision:
            # The baseline a later re-sync compares against: without it, the
            # source-change dialog can still diff, but cannot tell an untouched
            # config from one that changed and changed back.
            result["project"].setdefault("import_source", {})["revision"] = revision
        return result

    return router
