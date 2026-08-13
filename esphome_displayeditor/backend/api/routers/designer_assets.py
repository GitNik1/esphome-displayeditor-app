from __future__ import annotations

import asyncio
import base64
import binascii
from collections.abc import Callable

from fastapi import APIRouter, Request, Response

from ...audit import AuditStore
from ...errors import ApiError
from ...filesystem import FilesystemBackend
from ...font_sources import FontSourceService, is_mdi_webfont_url
from ...settings import Settings
from ..schemas import (
    AssetFontRequest,
    AssetImageRequest,
    FontGlyphCoverageRequest,
    FontSourceCheckRequest,
    FontSourceUpdateRequest,
)


def create_designer_assets_router(
    *,
    filesystem: FilesystemBackend,
    font_sources: FontSourceService,
    settings: Settings,
    audit: AuditStore,
    ensure_capability_available: Callable[[str], None],
    require_capability: Callable[[Request, str], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/designer", tags=["designer assets"])

    @router.get("/assets/images")
    async def list_images() -> dict:
        ensure_capability_available("designer.asset_read")
        return {"images": filesystem.list_image_assets()}

    async def upload(body, request: Request, writer) -> dict:
        user_id = require_capability(request, "designer.asset_write")
        try:
            content = base64.b64decode(body.content_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ApiError("invalid_request", "content_base64 is not valid base64.", 422) from exc
        try:
            result = writer(body.name, content)
        except ApiError as exc:
            _record(audit, user_id, "designer.asset.write", body.name, None, exc.error)
            raise
        _record(audit, user_id, "designer.asset.write", body.name,
                result["path"], "success")
        return result

    @router.post("/assets/images")
    async def upload_image(body: AssetImageRequest, request: Request) -> dict:
        return await upload(body, request, filesystem.write_image_asset)

    @router.post("/assets/fonts")
    async def upload_font(body: AssetFontRequest, request: Request) -> dict:
        return await upload(body, request, filesystem.write_font_asset)

    @router.post("/font-sources/check")
    async def check_font_source(body: FontSourceCheckRequest, request: Request) -> dict:
        user_id = require_capability(request, "designer.asset_write")
        try:
            result = await asyncio.to_thread(
                font_sources.check, body.url, etag=body.etag,
                last_modified=body.last_modified, sha256=body.sha256,
            )
        except ApiError as exc:
            _record(audit, user_id, "designer.font_source.check", body.url,
                    None, exc.error, old_revision=body.sha256 or None)
            raise
        _record(audit, user_id, "designer.font_source.check", body.url,
                result.get("sha256") or result.get("etag") or None,
                "changed" if result["changed"] else "current",
                old_revision=body.sha256 or None)
        return result

    @router.post("/font-sources/update")
    async def update_font_source(body: FontSourceUpdateRequest, request: Request) -> dict:
        user_id = require_capability(request, "designer.asset_write")
        use_bundled = settings.mdi_local and is_mdi_webfont_url(body.url)
        action = font_sources.pin_bundled_mdi if use_bundled else font_sources.update
        try:
            result = await asyncio.to_thread(action, body.id, body.url)
        except ApiError as exc:
            _record(audit, user_id, "designer.font_source.update", body.url,
                    None, exc.error)
            raise
        _record(audit, user_id, "designer.font_source.update", body.url,
                result["sha256"], "success")
        return result

    @router.post("/fonts/glyph-coverage")
    async def glyph_coverage(body: FontGlyphCoverageRequest) -> dict:
        ensure_capability_available("designer.asset_read")
        invalid = [
            value for value in body.codepoints
            if value < 0 or value > 0x10FFFF or 0xD800 <= value <= 0xDFFF
        ]
        if invalid:
            raise ApiError(
                "invalid_codepoint",
                "Glyph list contains an invalid Unicode codepoint.",
                422,
            )
        return await asyncio.to_thread(
            font_sources.glyph_coverage,
            body.path,
            list(dict.fromkeys(body.codepoints)),
        )

    @router.get("/assets/read/{name:path}")
    async def read_asset(name: str) -> Response:
        ensure_capability_available("designer.asset_read")
        content, content_type = filesystem.read_asset(name)
        return Response(content=content, media_type=content_type,
                        headers={"Cache-Control": "no-store"})

    return router


def _record(
    audit, user_id, action, configuration, new_revision, result,
    *, old_revision=None,
):
    audit.record(user_id=user_id, action=action, configuration=configuration,
                 old_revision=old_revision, new_revision=new_revision, result=result)
