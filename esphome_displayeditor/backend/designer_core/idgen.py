"""ID slug generation and project-wide uniqueness checking.

ESPHome's ``id()`` code generation uses one flat namespace across the whole
YAML document, regardless of which section (widgets, style_definitions,
font, image, color) an id came from - so uniqueness has to be checked across
all of them together, not per-section.
"""

from __future__ import annotations

import re

_SLUG_RE = re.compile(r"[^0-9a-zA-Z_]+")


def slugify(name: str) -> str:
    slug = _SLUG_RE.sub("_", name).strip("_").lower()
    if not slug:
        return "id"
    if slug[0].isdigit():
        slug = f"_{slug}"
    return slug


class IdRegistry:
    """Tracks which id was claimed by which owner, to spot collisions.

    ESPHome's id() codegen knows only one global namespace: a widget id and
    a style id that happen to collide are just as invalid as two widgets
    with the same id.
    """

    def __init__(self) -> None:
        self._owners: dict[str, str] = {}
        self._collisions: list[str] = []

    def claim(self, widget_id: str, owner: str) -> None:
        if not widget_id:
            return
        existing = self._owners.get(widget_id)
        if existing is not None:
            # Any second claim is a collision, even if `owner` happens to be
            # spelled identically to `existing` (e.g. two different images
            # both labelled "image '<their-shared-id>'", since that label is
            # built from the id itself) - two distinct entries sharing an id
            # is exactly as invalid as it is between two different kinds of
            # entity. A prior version compared the label strings here, which
            # made two same-kind duplicates invisible to this check whenever
            # their owner label happened to be generated purely from the id
            # being claimed.
            self._collisions.append(
                f"Duplicate id '{widget_id}': used by {existing} and {owner}.")
            return
        self._owners[widget_id] = owner

    def collisions(self) -> list[str]:
        return list(self._collisions)

    def unique_id(self, base: str) -> str:
        """A free id derived from ``base`` - appends _2, _3, ... if taken."""
        slug = slugify(base)
        candidate = slug
        n = 2
        while candidate in self._owners:
            candidate = f"{slug}_{n}"
            n += 1
        return candidate
