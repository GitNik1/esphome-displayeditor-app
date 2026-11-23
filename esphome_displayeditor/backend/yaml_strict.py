"""Duplicate-key-strict loading for YAML this add-on writes.

``designer_core.yamlimport`` loads leniently on purpose: a configuration is
imported as ESPHome would see it, and PyYAML lets a repeated key silently
win. For checking the add-on's *own* output that leniency hides exactly the
failure that matters - a merge that leaves part of an old block behind
produces repeated keys, which the lenient loader folds away and ESPHome
(like ``filesystem._yaml_error`` before publishing) rejects.

Add-on-only: ``designer_core`` is a byte copy of the desktop application's
modules (``tests/test_core_sync.py``) and stays untouched.
"""

from __future__ import annotations

from typing import Any

import yaml

from .designer_core.yamlimport import (
    LvglImportError,
    _check_alias_expansion,
    _ImportLoader,
)

_MERGE_TAG = "tag:yaml.org,2002:merge"


class StrictImportLoader(_ImportLoader):
    """``_ImportLoader`` that refuses a key written twice in one mapping.

    Keys pulled in through ``<<:`` may still be overridden by an explicit
    key - that is what a merge key is for - so only explicit keys count.
    """

    def construct_mapping(self, node, deep=False):
        if isinstance(node, yaml.MappingNode):
            seen: set[Any] = set()
            for key_node, _value_node in node.value:
                if key_node.tag == _MERGE_TAG:
                    continue
                key = self.construct_object(key_node, deep=True)
                try:
                    duplicate = key in seen
                    seen.add(key)
                except TypeError:  # unhashable keys are refused by PyYAML itself
                    continue
                if duplicate:
                    raise yaml.constructor.ConstructorError(
                        "while constructing a mapping", node.start_mark,
                        f"found duplicate key ({key})", key_node.start_mark)
        return super().construct_mapping(node, deep=deep)


def load_yaml_strict(text: str) -> Any:
    """Like ``load_yaml_bounded``, but a repeated key is an error."""
    loader = StrictImportLoader(text)
    try:
        node = loader.get_single_node()
        if node is None:
            return None
        _check_alias_expansion(node)
        return loader.construct_document(node)
    except yaml.YAMLError as exc:
        raise LvglImportError(f"The file is not valid YAML: {exc}") from exc
    except RecursionError as exc:
        raise LvglImportError("The file is nested too deeply to check.") from exc
    finally:
        loader.dispose()
