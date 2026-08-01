"""Safe, explicit downloads for versioned web-font revisions."""

from __future__ import annotations

import hashlib
import ipaddress
import io
import re
import socket
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import urljoin, urlsplit

import requests
from fontTools.ttLib import TTFont, TTLibError

from .errors import ApiError
from .filesystem import FilesystemBackend


_FONT_MAGICS = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"typ1")
_SAFE_ID = re.compile(r"[^A-Za-z0-9_-]+")


class FontSourceService:
    """Check and download public HTTP(S) font sources on user request.

    Redirect targets and every resolved address are checked before each
    request. Environment proxy settings are intentionally ignored so a
    configured proxy cannot turn this endpoint into an internal-network
    request primitive.
    """

    def __init__(
        self,
        filesystem: FilesystemBackend,
        *,
        max_size: int,
        session: requests.Session | None = None,
    ) -> None:
        self.filesystem = filesystem
        self.max_size = min(max(int(max_size), 64 * 1024), 16 * 1024 * 1024)
        self.session = session or requests.Session()
        self.session.trust_env = False

    @staticmethod
    def _validate_url(url: str) -> str:
        parsed = urlsplit(str(url).strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ApiError("invalid_font_url", "Font URL must use http or https.", 422)
        if parsed.username or parsed.password:
            raise ApiError("invalid_font_url", "Font URL must not contain credentials.", 422)
        try:
            port = parsed.port
            addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        except ValueError as exc:
            raise ApiError("invalid_font_url", "Font URL contains an invalid port.", 422) from exc
        except OSError as exc:
            raise ApiError("font_source_unavailable", "Font host could not be resolved.", 502) from exc
        if not addresses:
            raise ApiError("font_source_unavailable", "Font host could not be resolved.", 502)
        for address in addresses:
            try:
                ip = ipaddress.ip_address(address[4][0].split("%", 1)[0])
            except ValueError as exc:
                raise ApiError("invalid_font_url", "Font host resolved to an invalid address.", 422) from exc
            if not ip.is_global:
                raise ApiError("invalid_font_url", "Private or local font hosts are not allowed.", 422)
        return parsed.geturl()

    def _request(self, method: str, url: str, *, headers: dict[str, str] | None = None, stream: bool = False):
        current = url
        for _ in range(6):
            current = self._validate_url(current)
            try:
                response = self.session.request(
                    method,
                    current,
                    headers=headers or {},
                    allow_redirects=False,
                    stream=stream,
                    timeout=(8, 30),
                )
            except requests.RequestException as exc:
                raise ApiError("font_source_unavailable", "Font source could not be reached.", 502) from exc
            if response.status_code not in {301, 302, 303, 307, 308}:
                return response, current
            location = response.headers.get("Location", "").strip()
            response.close()
            if not location:
                raise ApiError("font_source_unavailable", "Font source returned an invalid redirect.", 502)
            current = urljoin(current, location)
        raise ApiError("font_source_unavailable", "Font source redirected too often.", 502)

    @staticmethod
    def _metadata(response, final_url: str) -> dict:
        size = response.headers.get("Content-Length", "")
        try:
            parsed_size = max(0, int(size))
        except (TypeError, ValueError):
            parsed_size = 0
        return {
            "url": final_url,
            "etag": response.headers.get("ETag", "").strip(),
            "last_modified": response.headers.get("Last-Modified", "").strip(),
            "size": parsed_size,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    def check(
        self,
        url: str,
        *,
        etag: str = "",
        last_modified: str = "",
        sha256: str = "",
    ) -> dict:
        headers: dict[str, str] = {}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        response, final_url = self._request("HEAD", url, headers=headers)
        try:
            if response.status_code == 304:
                return {"changed": False, **self._metadata(response, final_url)}
            if response.status_code in {405, 501} or response.status_code >= 400:
                # Some raw/CDN endpoints do not implement useful HEAD
                # semantics. A bounded GET provides a deterministic fallback.
                response.close()
                downloaded = self._download(url)
                return {
                    "changed": not sha256 or downloaded["sha256"] != sha256,
                    **{key: downloaded[key] for key in ("url", "etag", "last_modified", "size", "checked_at", "sha256")},
                }
            metadata = self._metadata(response, final_url)
            current_etag = metadata["etag"]
            current_modified = metadata["last_modified"]
            if etag and current_etag:
                changed = etag != current_etag
            elif last_modified and current_modified:
                changed = last_modified != current_modified
            else:
                downloaded = self._download(url)
                return {
                    "changed": not sha256 or downloaded["sha256"] != sha256,
                    **{key: downloaded[key] for key in ("url", "etag", "last_modified", "size", "checked_at", "sha256")},
                }
            return {"changed": changed, **metadata, "sha256": sha256}
        finally:
            response.close()

    def _download(self, url: str) -> dict:
        response, final_url = self._request("GET", url, stream=True)
        try:
            if response.status_code >= 400:
                raise ApiError("font_source_unavailable", "Font source returned an error.", 502)
            declared = response.headers.get("Content-Length", "")
            try:
                if declared and int(declared) > self.max_size:
                    raise ApiError("file_too_large", "Font exceeds the configured download limit.", 413)
            except ValueError:
                pass
            chunks: list[bytes] = []
            size = 0
            digest = hashlib.sha256()
            for chunk in response.iter_content(64 * 1024):
                if not chunk:
                    continue
                size += len(chunk)
                if size > self.max_size:
                    raise ApiError("file_too_large", "Font exceeds the configured download limit.", 413)
                digest.update(chunk)
                chunks.append(chunk)
            content = b"".join(chunks)
            if not content.startswith(_FONT_MAGICS):
                raise ApiError("invalid_font", "Downloaded source is not a TrueType/OpenType font.", 422)
            metadata = self._metadata(response, final_url)
            metadata.update(content=content, size=size, sha256=digest.hexdigest())
            return metadata
        finally:
            response.close()

    def update(self, font_id: str, url: str) -> dict:
        downloaded = self._download(url)
        safe_id = _SAFE_ID.sub("_", str(font_id).strip()).strip("_-") or "font"
        source_suffix = PurePosixPath(urlsplit(downloaded["url"]).path).suffix.lower()
        suffix = ".otf" if source_suffix == ".otf" or downloaded["content"].startswith(b"OTTO") else ".ttf"
        name = f"{safe_id[:63]}-{downloaded['sha256'][:12]}{suffix}"
        stored = self.filesystem.write_font_asset(name, downloaded.pop("content"), max_size=self.max_size)
        return {**downloaded, "path": stored["path"]}

    def glyph_coverage(self, path: str, codepoints: list[int]) -> dict:
        """Report whether requested Unicode codepoints exist in a local font."""
        content, content_type = self.filesystem.read_asset(path)
        if content_type not in {"font/ttf", "font/otf"}:
            raise ApiError("invalid_font", "Selected asset is not a font.", 422)
        try:
            font = TTFont(io.BytesIO(content), lazy=True)
            cmap = set((font.getBestCmap() or {}).keys())
        except (TTLibError, OSError, ValueError) as exc:
            raise ApiError("invalid_font", "Font character table could not be read.", 422) from exc
        finally:
            if "font" in locals():
                font.close()
        available = [value for value in codepoints if value in cmap]
        missing = [value for value in codepoints if value not in cmap]
        return {
            "path": path,
            "available": available,
            "missing": missing,
            "available_count": len(available),
            "missing_count": len(missing),
        }
