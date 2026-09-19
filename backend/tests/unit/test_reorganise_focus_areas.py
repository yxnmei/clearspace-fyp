"""
Unit tests for app/core/reorganise_focus_areas.py: deterministic
"Areas to focus on" derived only from detected positions. Pure logic, no
model, no network.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.reorganise_focus_areas import (
    FOCUS_AREA_LABELS,
    MAX_FOCUS_AREAS,
    FocusArea,
    area_id_for_position,
    derive_focus_areas,
    group_items_by_area,
)
from app.core.schemas import BoundingBox, DetectedItem


def _item(item_id: str, position: str, label: str = "lamp", size: str = "small") -> DetectedItem:
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
    )


def _items(positions: list[str]) -> list[DetectedItem]:
    return [_item(f"item_{n + 1:03d}", position) for n, position in enumerate(positions)]


# --- position mapping ---------------------------------------------------------


@pytest.mark.parametrize(
    "position,expected",
    [
        ("upper-left", "left"),
        ("left", "left"),
        ("lower-left", "left"),
        ("upper-right", "right"),
        ("right", "right"),
        ("lower-right", "right"),
        ("upper-center", "centre"),
        ("center", "centre"),
        ("lower-center", "centre"),
        ("Centre", "centre"),
        ("UPPER_LEFT", "left"),
        ("somewhere odd", "other"),
        ("", "other"),
    ],
)
def test_every_detector_position_maps_to_a_coarse_area(position, expected):
    assert area_id_for_position(position) == expected


# --- derivation ---------------------------------------------------------------


def test_areas_are_sorted_by_selected_item_count_highest_first():
    items = _items(["center", "upper-left", "lower-left", "right", "left", "upper-right"])
    areas = derive_focus_areas(items)

    assert [area.area_id for area in areas] == ["left", "right", "centre"]
    assert [len(area.item_ids) for area in areas] == [3, 2, 1]
    assert areas[0].item_ids == ["item_002", "item_003", "item_005"]  # input order kept within an area


def test_ties_break_in_the_fixed_left_centre_right_order_not_input_order():
    items = _items(["right", "center", "left"])
    assert [area.area_id for area in derive_focus_areas(items)] == ["left", "centre", "right"]


def test_never_more_than_three_areas_even_with_an_unrecognised_position():
    items = _items(["left", "left", "center", "center", "right", "right", "mystery"])
    areas = derive_focus_areas(items)

    assert len(areas) == MAX_FOCUS_AREAS == 3
    assert [area.area_id for area in areas] == ["left", "centre", "right"]
    # the "other" item is not dropped from the uncapped grouping, only from the capped summary
    assert [area_id for area_id, _ in group_items_by_area(items)][-1] == "other"


def test_the_busiest_other_area_is_shown_rather_than_hidden():
    items = _items(["mystery", "mystery", "left"])
    areas = derive_focus_areas(items)
    assert [area.area_id for area in areas] == ["other", "left"]
    assert areas[0].label == FOCUS_AREA_LABELS["other"]


def test_a_single_area_selection_yields_one_area():
    areas = derive_focus_areas(_items(["upper-left", "lower-left"]))
    assert len(areas) == 1
    assert areas[0].area_id == "left"
    assert areas[0].label == "Left side"
    assert areas[0].item_ids == ["item_001", "item_002"]


def test_every_item_id_appears_in_at_most_one_area_and_none_is_invented():
    positions = ["upper-left", "upper-center", "upper-right", "left", "center", "right", "lower-left", "lower-center", "lower-right"]
    items = _items(positions * 2)
    areas = derive_focus_areas(items)

    shown = [item_id for area in areas for item_id in area.item_ids]
    assert len(shown) == len(set(shown))
    assert set(shown) <= {item.item_id for item in items}


def test_output_is_deterministic():
    items = _items(["left", "center", "right", "left", "mystery"])
    assert derive_focus_areas(items) == derive_focus_areas(items)


def test_labels_never_influence_grouping():
    items = [_item("item_001", "left", "book"), _item("item_002", "right", "book"), _item("item_003", "left", "lamp")]
    areas = derive_focus_areas(items)
    assert [area.item_ids for area in areas] == [["item_001", "item_003"], ["item_002"]]


def test_focus_area_carries_no_coordinates_or_generated_text():
    fields = set(FocusArea.model_fields)
    assert fields == {"area_id", "label", "item_ids"}
    with pytest.raises(ValidationError):
        FocusArea(area_id="left", label="Left side", item_ids=["item_001"], x=0.1)


def test_focus_area_rejects_duplicate_or_empty_item_ids():
    with pytest.raises(ValidationError):
        FocusArea(area_id="left", label="Left side", item_ids=["item_001", "item_001"])
    with pytest.raises(ValidationError):
        FocusArea(area_id="left", label="Left side", item_ids=[])


# --- caller-input validation --------------------------------------------------


@pytest.mark.parametrize("bad", [[], None, "items", {"a": 1}])
def test_rejects_an_empty_or_non_list_selection(bad):
    with pytest.raises(ValueError, match="non-empty list"):
        derive_focus_areas(bad)


def test_rejects_a_non_detected_item_entry():
    with pytest.raises(ValueError, match="DetectedItem"):
        derive_focus_areas([_item("item_001", "left"), {"item_id": "item_002"}])


def test_rejects_a_duplicate_item_id():
    with pytest.raises(ValueError, match="duplicate"):
        derive_focus_areas([_item("item_001", "left"), _item("item_001", "right")])
