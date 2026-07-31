"""Safe configuration, draft, diff and atomic publish operations."""

from __future__ import annotations

import difflib
import hashlib
import os
import tempfile
from pathlib import Path, PurePosixPath

import yaml
from yaml.constructor import ConstructorError

from .errors import ApiError
from .settings import Settings


class _EspHomeLoader(yaml.SafeLoader):
    """Safe loader that tolerates ESPHome tags such as !secret and !include."""


def _construct_unknown_tag(loader: yaml.SafeLoader, _suffix: str, node: yaml.Node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)


_EspHomeLoader.add_multi_constructor("!", _construct_unknown_tag)


def _construct_unique_mapping(loader: yaml.SafeLoader, node: yaml.MappingNode, deep: bool = False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "found an unhashable mapping key",
                key_node.start_mark,
            ) from exc
        if duplicate:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key ({key})",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_EspHomeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


def revision_for(content: bytes | str) -> str:
    raw = content.encode("utf-8") if isinstance(content, str) else content
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


#: PNG magic bytes. Checked on every write and on whatever a write would
#: overwrite - the ``.png`` suffix alone is just a naming convention and
#: proves nothing about what is actually inside the request body.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

#: Content-Type for each asset suffix the browser is allowed to read back -
#: images and fonts an imported config already references by a local path
#: (e.g. ``images/panel_bg.png``, ``fonts/OpenSans-Regular.ttf``), so the
#: designer canvas can show/apply the real asset instead of only ever
#: accepting http(s) URLs.
_ASSET_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".bmp": "image/bmp",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}


class FilesystemBackend:
    _allowed_suffixes = {".yaml", ".yml"}
    _protected_roots = {"packages", "external_components"}
    #: Image assets are confined to one dedicated subfolder rather than
    #: anywhere under the config root - the same containment principle as
    #: drafts living under their own directory, so a coding mistake here has a
    #: single, small, and predictable blast radius instead of "anywhere in the
    #: user's ESPHome tree".
    _assets_subdir = "images"
    _allowed_asset_suffixes = {".png"}

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = settings.config_root
        self.drafts = settings.data_root / "drafts"
        self.drafts.mkdir(parents=True, exist_ok=True)
        self.assets = self.root / self._assets_subdir

    def _relative(self, name: str, *, suffixes: set[str] | None = None) -> PurePosixPath:
        if not name or "\\" in name or "\x00" in name:
            raise ApiError("invalid_path", "Configuration path is invalid.")
        relative = PurePosixPath(name)
        if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
            raise ApiError("invalid_path", "Only normalized relative paths are allowed.")
        if any(part.startswith(".") for part in relative.parts):
            raise ApiError("invalid_path", "Hidden paths are not allowed.")
        allowed = suffixes if suffixes is not None else self._allowed_suffixes
        if relative.suffix.lower() not in allowed:
            raise ApiError("invalid_path", f"Only {', '.join(sorted(allowed))} files are allowed.")
        return relative

    def _resolve(self, base: Path, relative: PurePosixPath) -> Path:
        base_resolved = base.resolve(strict=False)
        target = base.joinpath(*relative.parts)
        resolved = target.resolve(strict=False)
        try:
            resolved.relative_to(base_resolved)
        except ValueError as exc:
            raise ApiError("invalid_path", "Resolved path leaves the allowed directory.") from exc

        current = base
        for part in relative.parts:
            current = current / part
            if current.exists() and current.is_symlink():
                raise ApiError("invalid_path", "Symbolic links are not allowed.")
        return target

    def _paths(self, name: str) -> tuple[PurePosixPath, Path, Path]:
        relative = self._relative(name)
        return (
            relative,
            self._resolve(self.root, relative),
            self._resolve(self.drafts, relative),
        )

    def _assert_access(self, relative: PurePosixPath, *, write: bool) -> None:
        if not self.settings.protect_sensitive_paths:
            return
        parts = {part.lower() for part in relative.parts}
        if "secrets.yaml" in parts or "secrets.yml" in parts:
            raise ApiError("permission_denied", "secrets.yaml is protected.", 403)
        if write and relative.parts[0].lower() in self._protected_roots:
            raise ApiError("permission_denied", "This configuration area is write-protected.", 403)

    def _read(self, path: Path, *, missing_error: str) -> str:
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except FileNotFoundError as exc:
            raise ApiError(missing_error, "Configuration file was not found.", 404) from exc
        except OSError as exc:
            raise ApiError("invalid_path", "Configuration could not be opened safely.") from exc
        try:
            stat = os.fstat(descriptor)
            if not path.is_file() or path.is_symlink():
                raise ApiError("invalid_path", "Path is not a regular file.")
            if stat.st_size > self.settings.max_file_size:
                raise ApiError("file_too_large", "Configuration exceeds the configured size limit.", 413)
            with os.fdopen(descriptor, "rb", closefd=True) as handle:
                descriptor = -1
                raw = handle.read(self.settings.max_file_size + 1)
            if len(raw) > self.settings.max_file_size:
                raise ApiError("file_too_large", "Configuration exceeds the configured size limit.", 413)
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ApiError("invalid_encoding", "Configuration must be valid UTF-8.") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    def list_configs(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        result: list[dict] = []
        for directory, dirnames, filenames in os.walk(self.root, followlinks=False):
            directory_path = Path(directory)
            dirnames[:] = [
                name
                for name in dirnames
                if not name.startswith(".") and not (directory_path / name).is_symlink()
            ]
            for filename in filenames:
                path = directory_path / filename
                if filename.startswith(".") or path.is_symlink():
                    continue
                if path.suffix.lower() not in self._allowed_suffixes:
                    continue
                relative = path.relative_to(self.root).as_posix()
                if filename.lower() in {"secrets.yaml", "secrets.yml"}:
                    continue
                try:
                    stat = path.stat()
                    if stat.st_size > self.settings.max_file_size:
                        continue
                    content = self._read(path, missing_error="configuration_not_found")
                except (OSError, ApiError):
                    continue
                draft_path = self._resolve(self.drafts, self._relative(relative))
                result.append(
                    {
                        "name": relative,
                        "size": stat.st_size,
                        "revision": revision_for(content),
                        "has_draft": draft_path.is_file() and not draft_path.is_symlink(),
                    }
                )
        return sorted(result, key=lambda item: item["name"].casefold())

    def read_config(self, name: str) -> dict:
        relative, active, _ = self._paths(name)
        self._assert_access(relative, write=False)
        content = self._read(active, missing_error="configuration_not_found")
        return {"name": relative.as_posix(), "content": content, "revision": revision_for(content)}

    def read_draft(self, name: str) -> dict:
        relative, _, draft = self._paths(name)
        self._assert_access(relative, write=False)
        content = self._read(draft, missing_error="draft_not_found")
        return {"name": relative.as_posix(), "content": content, "revision": revision_for(content)}

    def read_asset(self, name: str) -> tuple[bytes, str]:
        """Read an image or font an imported config references by a local
        path, e.g. ``images/panel_bg.png`` or ``fonts/OpenSans-Regular.ttf``.

        Unlike ``write_image_asset``, this isn't confined to a single flat
        folder: an imported config can put its assets anywhere under the
        config root, and this only ever reads what's already there (the same
        trust boundary ``read_config``/``list_configs`` already use), so the
        broader path is safe - traversal, symlinks and hidden segments are
        still rejected by ``_relative``/``_resolve``, same as everywhere else.
        """
        relative = self._relative(name, suffixes=set(_ASSET_CONTENT_TYPES))
        self._assert_access(relative, write=False)
        target = self._resolve(self.root, relative)
        try:
            descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except FileNotFoundError as exc:
            raise ApiError("asset_not_found", "Asset was not found.", 404) from exc
        except OSError as exc:
            raise ApiError("invalid_path", "Asset could not be opened safely.") from exc
        try:
            stat = os.fstat(descriptor)
            if not target.is_file() or target.is_symlink():
                raise ApiError("invalid_path", "Path is not a regular file.")
            if stat.st_size > self.settings.max_file_size:
                raise ApiError("file_too_large", "Asset exceeds the configured size limit.", 413)
            with os.fdopen(descriptor, "rb", closefd=True) as handle:
                descriptor = -1
                content = handle.read(self.settings.max_file_size + 1)
            if len(content) > self.settings.max_file_size:
                raise ApiError("file_too_large", "Asset exceeds the configured size limit.", 413)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        return content, _ASSET_CONTENT_TYPES[relative.suffix.lower()]

    def save_draft(self, name: str, content: str) -> dict:
        relative, _, draft = self._paths(name)
        self._assert_access(relative, write=True)
        self._validate_content_size(content)
        draft.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_write(draft, content)
        return {"name": relative.as_posix(), "revision": revision_for(content)}

    def delete_draft(self, name: str) -> None:
        relative, _, draft = self._paths(name)
        self._assert_access(relative, write=True)
        if not draft.exists():
            raise ApiError("draft_not_found", "Draft was not found.", 404)
        if draft.is_symlink() or not draft.is_file():
            raise ApiError("invalid_path", "Draft path is invalid.")
        draft.unlink()

    def diff(self, name: str) -> dict:
        active = self.read_config(name)
        draft = self.read_draft(name)
        lines = difflib.unified_diff(
            active["content"].splitlines(keepends=True),
            draft["content"].splitlines(keepends=True),
            fromfile=f"active/{name}",
            tofile=f"draft/{name}",
        )
        return {
            "name": name,
            "active_revision": active["revision"],
            "draft_revision": draft["revision"],
            "diff": "".join(lines),
        }

    def check_yaml(self, name: str, *, source: str = "draft") -> dict:
        document = self.read_draft(name) if source == "draft" else self.read_config(name)
        error = self._yaml_error(document["content"])
        if error is not None:
            exc, line, column = error
            return {
                "valid": False,
                "revision": document["revision"],
                "error": str(exc),
                "line": line,
                "column": column,
            }
        return {"valid": True, "revision": document["revision"], "error": None}

    def publish(self, name: str, expected_revision: str) -> dict:
        relative, active, draft = self._paths(name)
        self._assert_access(relative, write=True)
        current = self._read(active, missing_error="configuration_not_found")
        current_revision = revision_for(current)
        if current_revision != expected_revision:
            raise ApiError(
                "revision_conflict",
                "The active configuration changed after it was loaded.",
                409,
                {"expected_revision": expected_revision, "actual_revision": current_revision},
            )
        content = self._read(draft, missing_error="draft_not_found")
        yaml_error = self._yaml_error(content)
        if yaml_error is not None:
            exc, line, column = yaml_error
            raise ApiError(
                "invalid_yaml",
                "The draft contains invalid YAML and cannot be published.",
                422,
                {"error": str(exc), "line": line, "column": column},
            )
        self._atomic_write(active, content)
        verified = self._read(active, missing_error="configuration_not_found")
        new_revision = revision_for(verified)
        if new_revision != revision_for(content):
            raise ApiError("publish_verification_failed", "Published content could not be verified.", 500)
        draft.unlink()
        return {
            "name": relative.as_posix(),
            "old_revision": current_revision,
            "revision": new_revision,
        }

    def _relative_asset(self, name: str) -> PurePosixPath:
        relative = self._relative(name, suffixes=self._allowed_asset_suffixes)
        # A single flat folder rather than an arbitrary sub-path: nothing in
        # the caller (a browser-rendered filename) needs a directory
        # component, and refusing one removes an entire class of traversal
        # attempt before the generic checks even run.
        if len(relative.parts) != 1:
            raise ApiError("invalid_path", "Image names may not contain a directory.")
        return relative

    def write_image_asset(self, name: str, content: bytes) -> dict:
        """Write a PNG into the dedicated images/ folder.

        Unlike every other write in this class, this one is not a draft: it
        lands directly on the host, because a baked animation frame is a
        finished asset, not a config change awaiting review. The safety
        margin comes from what it is confined to instead: one flat folder,
        one file type, verified by content rather than by name, and refusing
        to clobber a file that was not already a PNG itself.
        """
        relative = self._relative_asset(name)
        if len(content) > self.settings.max_file_size:
            raise ApiError("file_too_large", "Image exceeds the configured size limit.", 413)
        if not content.startswith(_PNG_MAGIC):
            raise ApiError("invalid_image", "Only PNG image data is accepted.")

        self.assets.mkdir(parents=True, exist_ok=True)
        target = self._resolve(self.assets, relative)
        if target.exists():
            if target.is_symlink() or not target.is_file():
                raise ApiError("invalid_path", "Target path is not a regular file.")
            with open(target, "rb") as handle:
                existing_head = handle.read(len(_PNG_MAGIC))
            if existing_head != _PNG_MAGIC:
                raise ApiError(
                    "invalid_path",
                    "Refusing to overwrite a file that is not itself a PNG.",
                    409,
                )

        self._atomic_write_bytes(target, content)
        return {
            "path": f"{self._assets_subdir}/{relative.as_posix()}",
            "size": len(content),
        }

    def _validate_content_size(self, content: str) -> None:
        try:
            encoded = content.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ApiError("invalid_encoding", "Configuration must be valid UTF-8.") from exc
        if len(encoded) > self.settings.max_file_size:
            raise ApiError("file_too_large", "Configuration exceeds the configured size limit.", 413)

    @staticmethod
    def _yaml_error(content: str) -> tuple[yaml.YAMLError, int | None, int | None] | None:
        try:
            yaml.load(content, Loader=_EspHomeLoader)
            return None
        except yaml.YAMLError as exc:
            mark = getattr(exc, "problem_mark", None)
            return (
                exc,
                mark.line + 1 if mark is not None else None,
                mark.column + 1 if mark is not None else None,
            )

    @staticmethod
    def _atomic_write_bytes(path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_name = handle.name
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, path)
            temporary_name = None
        finally:
            if temporary_name:
                try:
                    Path(temporary_name).unlink()
                except FileNotFoundError:
                    pass

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="",
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_name = handle.name
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, path)
            temporary_name = None
            try:
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            if temporary_name:
                try:
                    Path(temporary_name).unlink()
                except FileNotFoundError:
                    pass
