"""IdRegistry: the shared id-collision check every export/merge/import path
relies on to keep ESPHome's one flat id() namespace consistent.
"""

from __future__ import annotations

from backend.designer_core.idgen import IdRegistry, slugify


def test_claim_flags_a_collision_between_different_owner_labels() -> None:
    registry = IdRegistry()
    registry.claim("shared", "widget at widgets[0]")
    registry.claim("shared", "widget at widgets[1]")

    assert len(registry.collisions()) == 1
    assert "shared" in registry.collisions()[0]


def test_claim_flags_a_collision_even_when_owner_labels_are_textually_identical() -> None:
    """The regression this file exists for: yamlexport.py/lvgl_merge.py build
    an owner label purely from the id being claimed (e.g. f"image '{i.id}'"),
    so two different images sharing an id produce the *same* label string
    for both claims. A naive "flag it only if the label differs" check (the
    old behaviour) made this invisible - two images (or two of anything
    else) sharing an id passed validation, and ESPHome then rejected the
    resulting config at compile time with "ID ... redefined!"."""
    registry = IdRegistry()
    registry.claim("img_flow_00", "image 'img_flow_00'")
    registry.claim("img_flow_00", "image 'img_flow_00'")

    collisions = registry.collisions()
    assert len(collisions) == 1
    assert "img_flow_00" in collisions[0]


def test_claim_does_not_flag_a_single_claim() -> None:
    registry = IdRegistry()
    registry.claim("only_once", "image 'only_once'")
    assert registry.collisions() == []


def test_claim_ignores_an_empty_id() -> None:
    registry = IdRegistry()
    registry.claim("", "image ''")
    registry.claim("", "font ''")
    assert registry.collisions() == []


def test_unique_id_appends_a_suffix_once_the_base_is_taken() -> None:
    registry = IdRegistry()
    registry.claim("panel", "widget 'panel'")
    assert registry.unique_id("panel") == "panel_2"


def test_slugify_normalises_to_a_valid_esphome_id() -> None:
    assert slugify("My Panel!") == "my_panel"
    assert slugify("123") == "_123"
    assert slugify("") == "id"
