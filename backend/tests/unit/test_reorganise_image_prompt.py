"""
Unit tests for app/core/reorganise_image_prompt.py: the deterministic
image prompt. Pure logic, no model.
"""

from __future__ import annotations

import pytest

from app.core.reorganise_image_prompt import build_reorganise_image_prompt
from app.core.schemas import BoundingBox, DetectedItem


def _item(item_id: str, label: str, position: str = "upper-left", size: str = "small", corrected=None) -> DetectedItem:
    index = int(item_id.split("_")[1])
    return DetectedItem(
        item_id=item_id,
        source_detection_index=index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.2, y2=0.2),
        confidence=0.5,
        position=position,
        relative_size=size,
        corrected_label=corrected,
    )


def test_prompt_names_the_room_and_every_selected_item_with_size_and_position():
    prompt = build_reorganise_image_prompt([_item("item_001", "lamp"), _item("item_002", "desk", "center", "large")], "bedroom")
    assert prompt.startswith("A tidy, well-organised bedroom.")
    assert "- lamp (small, upper-left)" in prompt
    assert "- desk (large, center)" in prompt
    assert "Preserve the room's structure" in prompt


def test_prompt_uses_the_effective_label_and_never_an_item_id():
    prompt = build_reorganise_image_prompt([_item("item_001", "vase", corrected="table lamp")], "bedroom")
    assert "table lamp" in prompt
    assert "vase" not in prompt
    assert "item_001" not in prompt


def test_user_context_is_appended_when_present_and_omitted_when_blank():
    items = [_item("item_001", "lamp")]
    with_context = build_reorganise_image_prompt(items, "bedroom", "keep the desk clear")
    assert with_context.endswith("Additional context from the user: keep the desk clear")
    assert "Additional context" not in build_reorganise_image_prompt(items, "bedroom", None)
    assert "Additional context" not in build_reorganise_image_prompt(items, "bedroom", "   ")


def test_prompt_is_deterministic_and_preserves_input_order():
    items = [_item("item_003", "rug"), _item("item_001", "lamp"), _item("item_002", "chair")]
    first = build_reorganise_image_prompt(items, "bedroom")
    assert first == build_reorganise_image_prompt(items, "bedroom")
    assert first.index("- rug") < first.index("- lamp") < first.index("- chair")


@pytest.mark.parametrize("bad_items", [[], None, ["lamp"]])
def test_rejects_malformed_selection(bad_items):
    with pytest.raises(ValueError):
        build_reorganise_image_prompt(bad_items, "bedroom")


def test_rejects_duplicate_ids_blank_scene_and_non_string_context():
    with pytest.raises(ValueError, match="duplicate"):
        build_reorganise_image_prompt([_item("item_001", "lamp"), _item("item_001", "lamp")], "bedroom")
    with pytest.raises(ValueError, match="scene_label"):
        build_reorganise_image_prompt([_item("item_001", "lamp")], "  ")
    with pytest.raises(ValueError, match="user_context"):
        build_reorganise_image_prompt([_item("item_001", "lamp")], "bedroom", 42)
