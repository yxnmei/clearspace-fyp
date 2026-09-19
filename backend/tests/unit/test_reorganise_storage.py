"""
Unit tests for app/core/reorganise_storage.py: deterministic,
evidence-bound, category-narrow storage suggestions. Pure logic, no
model, no network.
"""

from __future__ import annotations

import re

import pytest
from pydantic import ValidationError

from app.core.reorganise_storage import (
    MAX_STORAGE_SUGGESTIONS,
    MIN_EVIDENCE_ITEMS,
    STORAGE_CATEGORY_RULES,
    StorageSuggestion,
    derive_storage_suggestions,
    find_compatible_groups,
    format_label_list,
)
from app.core.schemas import BoundingBox, DetectedItem


def _item(item_id: str, label: str, relative_size: str = "small", position: str = "upper-left", corrected=None) -> DetectedItem:
    index = int(item_id.split("_")[1])
    return DetectedItem(
        item_id=item_id,
        source_detection_index=index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.2, y2=0.2),
        confidence=0.5,
        position=position,
        relative_size=relative_size,
        corrected_label=corrected,
    )


def _items(labels: list[str], sizes: list[str] | None = None, positions: list[str] | None = None) -> list[DetectedItem]:
    sizes = sizes or ["small"] * len(labels)
    positions = positions or ["upper-left"] * len(labels)
    return [
        _item(f"item_{n + 1:03d}", label, size, position)
        for n, (label, size, position) in enumerate(zip(labels, sizes, positions))
    ]


COMMERCIAL_TERMS = re.compile(
    r"\$|£|€|https?://|www\.|\bbuy\b|\bprice\b|\bin stock\b|\bamazon\b|\bikea\b|\bcarousell\b|\bshopee\b|\bsingapore\b", re.I
)


# --- evidence thresholds ------------------------------------------------------


def test_no_evidence_yields_no_suggestion():
    assert derive_storage_suggestions(_items(["lamp", "chair"])) == []


def test_a_single_matching_item_is_not_evidence():
    assert MIN_EVIDENCE_ITEMS == 2
    assert derive_storage_suggestions(_items(["book", "lamp"])) == []


def test_two_compatible_items_are_evidence_and_are_named_in_the_reason():
    recs = derive_storage_suggestions(_items(["book", "magazine", "lamp"]))

    assert [rec.name for rec in recs] == ["Bookends or a compact shelf"]
    assert recs[0].related_item_ids == ["item_001", "item_002"]
    assert "book" in recs[0].reason and "magazine" in recs[0].reason
    assert "lamp" not in recs[0].reason


@pytest.mark.parametrize(
    "labels,expected_name",
    [
        (["charger", "cable"], "Cable or technology-accessory organiser"),
        (["headphones", "remote", "mouse"], "Cable or technology-accessory organiser"),
        (["toy", "toy"], "Toy or small-item container"),
        (["board game", "figurine"], "Toy or small-item container"),
        (["notebook", "document"], "Bookends or a compact shelf"),
        (["jacket", "backpack"], "Hooks or a hanging organiser"),
        (["shoe", "shoe", "hat"], "Hooks or a hanging organiser"),
        (["necklace", "keys"], "Compartment tray"),
        (["watch", "sunglasses"], "Compartment tray"),
    ],
)
def test_each_narrow_category_fires_on_its_own_compatible_items(labels, expected_name):
    recs = derive_storage_suggestions(_items(labels))
    assert [rec.name for rec in recs] == [expected_name]
    assert recs[0].related_item_ids == [f"item_{n + 1:03d}" for n in range(len(labels))]


# --- no cross-category mixing, no positional evidence -------------------------


def test_unrelated_small_items_are_never_combined_into_one_suggestion():
    # One of each category: no rule reaches two items, so nothing fires,
    # even though every item is small and they all share one position.
    recs = derive_storage_suggestions(_items(["cable", "toy", "book", "shoe", "watch"]))
    assert recs == []


def test_mixed_cups_bottles_electronics_and_tableware_never_get_a_lidded_box():
    recs = derive_storage_suggestions(_items(["cup", "bottle", "plate", "speaker", "bowl", "mug"]))
    assert recs == []
    assert not any("box" in rule.name.lower() for rule in STORAGE_CATEGORY_RULES)


def test_sharing_an_image_area_is_not_evidence():
    same_spot = _items(["lamp", "plant", "candle", "vase", "clock"], positions=["center"] * 5)
    assert derive_storage_suggestions(same_spot) == []


def test_position_never_affects_the_result():
    spread = _items(["charger", "cable"], positions=["upper-left", "lower-right"])
    together = _items(["charger", "cable"], positions=["center", "center"])
    assert derive_storage_suggestions(spread) == derive_storage_suggestions(together)


def test_each_suggestion_holds_only_its_own_category_items():
    recs = derive_storage_suggestions(_items(["charger", "cable", "book", "notebook"]))
    by_name = {rec.name: rec.related_item_ids for rec in recs}
    assert by_name == {
        "Cable or technology-accessory organiser": ["item_001", "item_002"],
        "Bookends or a compact shelf": ["item_003", "item_004"],
    }


# --- size rule ----------------------------------------------------------------


def test_large_items_never_count_as_evidence():
    large_bags = _items(["bag", "bag", "coat"], sizes=["large", "large", "large"])
    assert derive_storage_suggestions(large_bags) == []


def test_medium_items_count_but_large_ones_are_excluded_from_the_same_group():
    items = _items(["book", "book", "book"], sizes=["small", "medium", "large"])
    recs = derive_storage_suggestions(items)
    assert [rec.name for rec in recs] == ["Bookends or a compact shelf"]
    assert recs[0].related_item_ids == ["item_001", "item_002"]
    assert "2 books" in recs[0].reason


# --- bounds and ordering ------------------------------------------------------


def test_never_more_than_three_even_when_every_rule_fires():
    labels = ["cable", "charger", "toy", "toy", "book", "book", "shoe", "shoe", "keys", "watch", "remote"]
    recs = derive_storage_suggestions(_items(labels))

    assert len(recs) == MAX_STORAGE_SUGGESTIONS == 3
    assert len(find_compatible_groups(_items(labels))) == 5


def test_ordered_by_evidence_count_then_fixed_rule_order():
    labels = ["book", "book", "book", "cable", "charger", "toy", "toy"]
    recs = derive_storage_suggestions(_items(labels))
    assert [rec.name for rec in recs] == [
        "Bookends or a compact shelf",  # 3 items
        "Cable or technology-accessory organiser",  # 2 items, earlier rule
        "Toy or small-item container",  # 2 items, later rule
    ]


def test_output_is_deterministic():
    items = _items(["cable", "charger", "book", "book", "toy", "toy"])
    assert derive_storage_suggestions(items) == derive_storage_suggestions(items)


# --- content discipline -------------------------------------------------------


def test_suggestions_carry_no_commercial_claims():
    labels = ["cable", "charger", "toy", "toy", "book", "book", "shoe", "shoe", "keys", "watch"]
    for rec in derive_storage_suggestions(_items(labels)):
        assert not COMMERCIAL_TERMS.search(rec.name), rec.name
        assert not COMMERCIAL_TERMS.search(rec.reason), rec.reason


def test_suggestion_schema_has_no_room_for_price_brand_or_link():
    assert set(StorageSuggestion.model_fields) == {"name", "reason", "related_item_ids"}
    with pytest.raises(ValidationError):
        StorageSuggestion(name="Tray", reason="because", related_item_ids=["item_001"], price="9.99")
    with pytest.raises(ValidationError):
        StorageSuggestion(name="Tray", reason="because", related_item_ids=["item_001", "item_001"])
    with pytest.raises(ValidationError):
        StorageSuggestion(name="Tray", reason="because", related_item_ids=[])


def test_whole_word_matching_ignores_substrings():
    # "bookshelf" is furniture, not a book; "keyboard" is not keys.
    assert derive_storage_suggestions(_items(["bookshelf", "bookshelf", "keyboard", "keyboard"])) == []


def test_corrected_labels_are_what_count():
    items = [
        _item("item_001", "vase", corrected="cable"),
        _item("item_002", "vase", corrected="charger"),
    ]
    recs = derive_storage_suggestions(items)
    assert [rec.name for rec in recs] == ["Cable or technology-accessory organiser"]
    assert "vase" not in recs[0].reason


# --- long labels can never abort ---------------------------------------------


def test_very_long_corrected_labels_are_bounded_in_the_reason_and_never_raise():
    long_label = ("a very long user supplied corrected label " * 10).strip()
    items = [
        _item("item_001", "thing", corrected=long_label + " book"),
        _item("item_002", "thing", corrected=long_label + " magazine"),
        _item("item_003", "thing", corrected=long_label + " book"),
        _item("item_004", "thing", corrected=long_label + " notebook"),
        _item("item_005", "thing", corrected=long_label + " folder"),
    ]
    recs = derive_storage_suggestions(items)

    assert [rec.name for rec in recs] == ["Bookends or a compact shelf"]
    assert recs[0].related_item_ids == [item.item_id for item in items]
    assert len(recs[0].reason) <= 300
    assert recs[0].reason.startswith("Stands 5 books or papers")
    assert "..." in recs[0].reason  # display truncation, ids and count intact


def test_format_label_list_uses_counts_and_a_natural_conjunction():
    items = _items(["cup", "cup", "bottle", "toy", "pen", "lamp"])
    assert format_label_list(items[:1]) == "cup"
    assert format_label_list(items[:3]) == "cup x2 and bottle"
    assert format_label_list(items) == "cup x2, bottle, toy, pen and 1 more"


# --- caller-input validation --------------------------------------------------


@pytest.mark.parametrize("bad", [[], None, "items"])
def test_rejects_an_empty_or_non_list_selection(bad):
    with pytest.raises(ValueError, match="non-empty list"):
        derive_storage_suggestions(bad)


def test_rejects_a_non_detected_item_entry_and_duplicate_ids():
    with pytest.raises(ValueError, match="DetectedItem"):
        derive_storage_suggestions([_item("item_001", "book"), "book"])
    with pytest.raises(ValueError, match="duplicate"):
        derive_storage_suggestions([_item("item_001", "book"), _item("item_001", "book")])
