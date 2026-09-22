"""
Unit tests for app/core/reorganise_storage.py: deterministic,
evidence-bound, category-narrow storage and organisation ideas. Pure
logic, no model, no network.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.reorganise_storage import (
    CHECKLIST_GROUP_RULES,
    CHECKLIST_GROUP_SIZES,
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


def _fixture_28() -> list[DetectedItem]:
    fixture = Path(__file__).resolve().parents[2] / "evaluation" / "fixtures" / "reorganise_bedroom02_28items.json"
    raw = json.loads(fixture.read_text(encoding="utf-8"))
    return [DetectedItem.model_validate(entry) for entry in raw["items"]]


COMMERCIAL_TERMS = re.compile(
    r"\$|£|€|https?://|www\.|\bbuy\b|\bprice\b|\bin stock\b|\bamazon\b|\bikea\b|\bcarousell\b|\bshopee\b|\bsingapore\b|"
    r"\bbrand\b|\bavailable\b|\border\b|\bshop\b",
    re.I,
)
# Filler a reason must never fall back to, and the checklist's own
# wording, which a storage idea must not merely restate.
FILLER = re.compile(r"keep(?:s)? the room neat|tidy(?:ing)? up|group (?:these|them|the .+?) together|together in one place\.$", re.I)
# The old inventory shapes: "(toy x2)", "x2", "2 toys or games (...)".
INVENTORY = re.compile(r"\(|\)| x\d|\d+ more\b", re.I)


# --- evidence thresholds ------------------------------------------------------


def test_no_evidence_yields_no_suggestion():
    assert derive_storage_suggestions(_items(["lamp", "chair"])) == []


def test_a_single_matching_item_is_not_evidence():
    assert MIN_EVIDENCE_ITEMS == 2
    assert derive_storage_suggestions(_items(["book", "lamp"])) == []
    assert derive_storage_suggestions(_items(["keyboard", "lamp"])) == []
    assert derive_storage_suggestions(_items(["pillow", "lamp"])) == []
    assert derive_storage_suggestions(_items(["picture frame", "lamp"])) == []


def test_two_compatible_items_are_evidence_and_are_named_in_the_reason():
    recs = derive_storage_suggestions(_items(["book", "magazine", "lamp"]))

    assert [rec.name for rec in recs] == ["Bookends or a paper tray"]
    assert recs[0].related_item_ids == ["item_001", "item_002"]
    assert recs[0].reason == "Stand the book and magazine upright in one spot so they stay visible instead of piling up."
    assert "lamp" not in recs[0].reason


@pytest.mark.parametrize(
    "labels,expected_name,expected_reason",
    [
        (["charger", "cable"], "Cable and accessory organiser", "Keep the charger and cable untangled and in one place between uses."),
        (
            ["headphones", "remote", "controller"],
            "Cable and accessory organiser",
            "Keep the headphones, remote and controller untangled and in one place between uses.",
        ),
        (["keyboard", "mouse"], "Desktop accessory organiser", "Keep the keyboard and mouse together between uses so they are always at hand."),
        (["toy", "toy"], "Toy container", "Give both toy items one easy place to return to after use."),
        (["board game", "figurine"], "Toy container", "Give the board game and figurine one easy place to return to after use."),
        (
            ["notebook", "document"],
            "Bookends or a paper tray",
            "Stand the notebook and document upright in one spot so they stay visible instead of piling up.",
        ),
        (
            ["jacket", "backpack"],
            "Hooks or a hanging organiser",
            "Give the jacket and backpack a fixed hanging spot so they stay off the floor and furniture.",
        ),
        (
            ["shoe", "shoe", "hat"],
            "Hooks or a hanging organiser",
            "Give the 2 shoe items and hat a fixed hanging spot so they stay off the floor and furniture.",
        ),
        (
            ["pillow", "blanket"],
            "Soft-furnishing basket or storage bag",
            "Keep the pillow and blanket together in one place when they are not in use.",
        ),
        (
            ["picture frame", "picture frame"],
            "Dedicated display area",
            "Use one deliberate display area for both picture frame items instead of scattering them.",
        ),
        (["necklace", "keys"], "Compartment tray", "Give the necklace and keys a fixed compartment each so they stop going missing."),
        (["watch", "sunglasses"], "Compartment tray", "Give the watch and sunglasses a fixed compartment each so they stop going missing."),
    ],
)
def test_each_narrow_category_fires_on_its_own_compatible_items(labels, expected_name, expected_reason):
    recs = derive_storage_suggestions(_items(labels))
    assert [rec.name for rec in recs] == [expected_name]
    assert recs[0].reason == expected_reason
    assert recs[0].related_item_ids == [f"item_{n + 1:03d}" for n in range(len(labels))]


def test_every_rule_has_a_distinct_name_and_a_grounded_template():
    names = [rule.name for rule in STORAGE_CATEGORY_RULES]
    assert len(names) == len(set(names)) == 8
    for rule in STORAGE_CATEGORY_RULES:
        assert "{items}" in rule.reason_template
        assert rule.sizes and rule.sizes <= {"small", "medium", "large"}
        assert not COMMERCIAL_TERMS.search(rule.name) and not COMMERCIAL_TERMS.search(rule.reason_template)


# --- no cross-category mixing, no positional evidence -------------------------


def test_unrelated_small_items_are_never_combined_into_one_suggestion():
    # One of each category: no rule reaches two items, so nothing fires,
    # even though every item is small and they all share one position.
    recs = derive_storage_suggestions(_items(["cable", "keyboard", "toy", "book", "shoe", "pillow", "poster", "watch"]))
    assert recs == []


def test_tableware_bottles_and_containers_never_get_a_miscellaneous_box():
    recs = derive_storage_suggestions(_items(["cup", "cup", "bottle", "plate", "speaker", "bowl", "mug", "box", "bin"]))
    assert recs == []
    assert not any(re.search(r"\bbox\b|\bbin\b|miscellaneous|catch-all", rule.name, re.I) for rule in STORAGE_CATEGORY_RULES)


def test_a_detected_box_bin_or_shelf_is_never_offered_as_a_destination():
    # the toys are evidence; the detected box, bin and shelf are not named
    # as somewhere to put them, and are not evidence of anything
    recs = derive_storage_suggestions(_items(["toy", "toy", "box", "bin", "shelf"], sizes=["small"] * 4 + ["large"]))
    assert [rec.name for rec in recs] == ["Toy container"]
    assert recs[0].related_item_ids == ["item_001", "item_002"]
    assert not re.search(r"\bbox\b|\bbin\b|\bshelf\b", recs[0].reason)


def test_sharing_an_image_area_is_not_evidence():
    same_spot = _items(["lamp", "plant", "candle", "vase", "clock"], positions=["center"] * 5)
    assert derive_storage_suggestions(same_spot) == []


def test_position_never_affects_the_result():
    spread = _items(["charger", "cable"], positions=["upper-left", "lower-right"])
    together = _items(["charger", "cable"], positions=["center", "center"])
    assert derive_storage_suggestions(spread) == derive_storage_suggestions(together)


def test_each_suggestion_holds_only_its_own_category_items():
    recs = derive_storage_suggestions(_items(["charger", "cable", "book", "notebook", "keyboard", "mouse"]))
    by_name = {rec.name: rec.related_item_ids for rec in recs}
    assert by_name == {
        "Cable and accessory organiser": ["item_001", "item_002"],
        "Desktop accessory organiser": ["item_005", "item_006"],
        "Bookends or a paper tray": ["item_003", "item_004"],
    }
    # a mouse is a desktop accessory, never double-counted as a cable
    assert not any("mouse" in rec.reason for rec in recs if rec.name == "Cable and accessory organiser")


def test_no_item_id_is_shared_between_suggestions():
    labels = ["cable", "charger", "mouse", "keyboard", "toy", "toy", "book", "book", "pillow", "blanket", "poster", "photo"]
    seen: list[str] = []
    for _rule, matched in find_compatible_groups(_items(labels), STORAGE_CATEGORY_RULES):
        seen.extend(item.item_id for item in matched)
    assert len(seen) == len(set(seen))


# --- category-specific size rules ---------------------------------------------


def test_a_compartment_tray_takes_small_items_only():
    assert derive_storage_suggestions(_items(["watch", "keys"], sizes=["medium", "small"])) == []
    assert derive_storage_suggestions(_items(["watch", "keys", "necklace"], sizes=["medium", "small", "small"]))[0].related_item_ids == [
        "item_002",
        "item_003",
    ]


def test_hanging_and_soft_furnishing_ideas_accept_medium_and_large_items():
    coats = _items(["backpack", "coat"], sizes=["large", "large"])
    assert [rec.name for rec in derive_storage_suggestions(coats)] == ["Hooks or a hanging organiser"]
    bedding = _items(["pillow", "blanket", "duvet"], sizes=["medium", "large", "large"])
    recs = derive_storage_suggestions(bedding)
    assert [rec.name for rec in recs] == ["Soft-furnishing basket or storage bag"]
    assert recs[0].related_item_ids == ["item_001", "item_002", "item_003"]
    assert recs[0].reason == "Keep the pillow, blanket and duvet together in one place when they are not in use."


def test_bookends_display_and_desktop_ideas_exclude_large_items():
    items = _items(["book", "book", "book"], sizes=["small", "medium", "large"])
    recs = derive_storage_suggestions(items)
    assert [rec.name for rec in recs] == ["Bookends or a paper tray"]
    assert recs[0].related_item_ids == ["item_001", "item_002"]
    assert recs[0].reason.startswith("Stand both book items upright")
    assert derive_storage_suggestions(_items(["painting", "painting"], sizes=["large", "large"])) == []
    assert derive_storage_suggestions(_items(["keyboard", "mouse"], sizes=["large", "small"])) == []


def test_large_items_never_count_for_a_small_or_medium_only_rule():
    large_tech = _items(["cable", "charger", "toy", "toy"], sizes=["large"] * 4)
    assert derive_storage_suggestions(large_tech) == []


# --- bounds and ordering ------------------------------------------------------


def test_never_more_than_three_even_when_every_rule_fires():
    labels = [
        "cable", "charger", "keyboard", "mouse", "toy", "toy", "book", "book", "shoe", "shoe",
        "pillow", "blanket", "poster", "photo", "keys", "watch",
    ]
    recs = derive_storage_suggestions(_items(labels))

    assert len(recs) == MAX_STORAGE_SUGGESTIONS == 3
    assert len(find_compatible_groups(_items(labels), STORAGE_CATEGORY_RULES)) == 8
    assert len(recs) == len({rec.name for rec in recs})


def test_ordered_by_evidence_count_then_fixed_rule_order():
    labels = ["book", "book", "book", "keyboard", "mouse", "cable", "charger", "toy", "toy"]
    recs = derive_storage_suggestions(_items(labels))
    assert [rec.name for rec in recs] == [
        "Bookends or a paper tray",  # 3 items
        "Cable and accessory organiser",  # 2 items, earliest rule
        "Desktop accessory organiser",  # 2 items, next rule
    ]


def test_ordering_is_by_count_not_by_input_position():
    first = _items(["toy", "toy", "pillow", "blanket", "cushion"])
    second = _items(["pillow", "blanket", "cushion", "toy", "toy"])
    assert [rec.name for rec in derive_storage_suggestions(first)] == [
        "Soft-furnishing basket or storage bag",
        "Toy container",
    ]
    assert [rec.name for rec in derive_storage_suggestions(second)] == [rec.name for rec in derive_storage_suggestions(first)]


def test_output_is_deterministic():
    items = _items(["cable", "charger", "book", "book", "toy", "toy"])
    assert derive_storage_suggestions(items) == derive_storage_suggestions(items)


def test_the_checklist_reads_only_the_original_grouping_categories():
    assert [rule.rule_id for rule in CHECKLIST_GROUP_RULES] == [
        "tech_accessories",
        "toys_and_games",
        "books_and_papers",
        "clothing_bags_shoes",
        "jewellery_keys_glasses",
    ]
    # the default rule set is the checklist's, so a keyboard + mouse room
    # gets a storage idea without gaining a checklist step
    items = _items(["keyboard", "mouse"])
    assert find_compatible_groups(items) == []
    assert [rec.name for rec in derive_storage_suggestions(items)] == ["Desktop accessory organiser"]


def test_checklist_grouping_keeps_small_and_medium_only_while_storage_uses_per_rule_sizes():
    assert CHECKLIST_GROUP_SIZES == frozenset({"small", "medium"})
    large = _items(["backpack", "coat"], sizes=["large", "large"])
    # storage: two large bags/coats are hanging-organiser evidence
    assert [rec.name for rec in derive_storage_suggestions(large)] == ["Hooks or a hanging organiser"]
    # checklist (the defaults): the same items form no compatible group
    assert find_compatible_groups(large) == []
    assert find_compatible_groups(large, CHECKLIST_GROUP_RULES, CHECKLIST_GROUP_SIZES) == []
    # the override applies per item: a large coat drops out of a checklist
    # group that its small and medium companions still form
    mixed = _items(["jacket", "bag", "coat"], sizes=["small", "medium", "large"])
    [(rule, matched)] = find_compatible_groups(mixed)
    assert rule.rule_id == "clothing_bags_shoes"
    assert [item.item_id for item in matched] == ["item_001", "item_002"]
    [storage] = derive_storage_suggestions(mixed)
    assert storage.related_item_ids == ["item_001", "item_002", "item_003"]
    # small/medium checklist groups are exactly as before for every checklist category
    for labels in (["charger", "cable"], ["toy", "toy"], ["book", "notebook"], ["shoe", "hat"], ["keys", "watch"]):
        items = _items(labels, sizes=["small", "medium"])
        groups = find_compatible_groups(items)
        assert len(groups) == 1 and [i.item_id for i in groups[0][1]] == ["item_001", "item_002"], labels
    # the tray's storage rule is stricter than the checklist's eligibility, and that is storage-only
    assert find_compatible_groups(_items(["keys", "watch"], sizes=["small", "medium"]))[0][0].rule_id == "jewellery_keys_glasses"
    assert derive_storage_suggestions(_items(["keys", "watch"], sizes=["small", "medium"])) == []


# --- content discipline -------------------------------------------------------


def _every_scenario():
    yield _fixture_28()
    yield _items(["cable", "charger", "toy", "toy", "book", "book", "shoe", "shoe", "keys", "watch"])
    yield _items(["keyboard", "mouse", "pillow", "blanket", "poster", "photo", "canvas", "print"], sizes=["small", "small", "large", "large", "medium", "small", "small", "small"])
    yield _items(["toy", "toy", "toy", "toy"])
    yield _items(["picture frame"] * 6 + ["painting"], sizes=["small"] * 6 + ["medium"])


def test_suggestions_carry_no_commercial_claims():
    for items in _every_scenario():
        for rec in derive_storage_suggestions(items):
            assert not COMMERCIAL_TERMS.search(rec.name), rec.name
            assert not COMMERCIAL_TERMS.search(rec.reason), rec.reason


def test_reasons_are_one_grounded_sentence_that_adds_to_the_name():
    for items in _every_scenario():
        labels = {item.effective_label for item in items}
        for rec in derive_storage_suggestions(items):
            assert rec.reason.endswith(".") and ". " not in rec.reason, rec.reason
            assert rec.reason.lower().rstrip(".") != rec.name.lower()
            assert rec.name.lower() not in rec.reason.lower()
            assert not FILLER.search(rec.reason), rec.reason
            assert not INVENTORY.search(rec.reason), rec.reason
            assert not re.search(r"item_\d", f"{rec.name} {rec.reason}")
            # every room-content noun in the reason is a selected label
            for label in re.findall(r"(?:both|all \d+|\d+) (.+?) items", rec.reason):
                assert label in labels, label


def test_the_reason_names_at_most_three_labels_then_the_group_noun_without_a_second_count():
    items = _items(["poster", "photo", "canvas", "print", "artwork"])
    recs = derive_storage_suggestions(items)
    assert recs[0].reason == (
        "Use one deliberate display area for the poster, photo, canvas and the other display items instead of scattering them."
    )
    assert "print" not in recs[0].reason and "artwork" not in recs[0].reason
    assert not re.search(r"\d", recs[0].reason)


def test_a_repeated_label_is_counted_once_in_the_reason():
    recs = derive_storage_suggestions(_items(["toy", "toy", "toy"]))
    assert recs[0].reason == "Give all 3 toy items one easy place to return to after use."
    recs = derive_storage_suggestions(_items(["picture frame", "picture frame", "poster"]))
    assert recs[0].reason == "Use one deliberate display area for the 2 picture frame items and poster instead of scattering them."
    assert recs[0].reason.count("picture frame") == 1


def test_suggestion_schema_has_no_room_for_price_brand_or_link():
    assert set(StorageSuggestion.model_fields) == {"name", "reason", "related_item_ids"}
    with pytest.raises(ValidationError):
        StorageSuggestion(name="Tray", reason="because", related_item_ids=["item_001"], price="9.99")
    with pytest.raises(ValidationError):
        StorageSuggestion(name="Tray", reason="because", related_item_ids=["item_001", "item_001"])
    with pytest.raises(ValidationError):
        StorageSuggestion(name="Tray", reason="because", related_item_ids=[])


def test_whole_word_matching_ignores_substrings():
    # "bookshelf" is furniture, not a book; "keyboard" is not keys; "printer" is not a print.
    assert derive_storage_suggestions(_items(["bookshelf", "bookshelf", "printer", "printer"])) == []
    assert [rec.name for rec in derive_storage_suggestions(_items(["keyboard", "keyboard"]))] == ["Desktop accessory organiser"]


def test_corrected_labels_are_what_count():
    items = [
        _item("item_001", "vase", corrected="cable"),
        _item("item_002", "vase", corrected="charger"),
    ]
    recs = derive_storage_suggestions(items)
    assert [rec.name for rec in recs] == ["Cable and accessory organiser"]
    assert "vase" not in recs[0].reason and "cable" in recs[0].reason


# --- the real 28-item fixture ---------------------------------------------------


def test_the_28_item_fixture_gets_three_distinct_grounded_ideas():
    items = _fixture_28()
    by_id = {item.item_id: item for item in items}
    recs = derive_storage_suggestions(items)

    assert [(rec.name, rec.reason, rec.related_item_ids) for rec in recs] == [
        (
            "Dedicated display area",
            "Use one deliberate display area for the painting and 6 picture frame items instead of scattering them.",
            ["item_001", "item_004", "item_006", "item_007", "item_008", "item_009", "item_012"],
        ),
        (
            "Desktop accessory organiser",
            "Keep the keyboard and mouse together between uses so they are always at hand.",
            ["item_021", "item_023"],
        ),
        ("Toy container", "Give both toy items one easy place to return to after use.", ["item_013", "item_015"]),
    ]
    assert len(recs) == MAX_STORAGE_SUGGESTIONS
    assert len({rec.name for rec in recs}) == 3

    # related ids are exactly the evidence for each idea
    assert {by_id[i].effective_label for i in recs[0].related_item_ids} == {"painting", "picture frame"}
    assert {by_id[i].effective_label for i in recs[1].related_item_ids} == {"keyboard", "mouse"}
    assert {by_id[i].effective_label for i in recs[2].related_item_ids} == {"toy"}
    # tableware, bottles, the bin, the box and the shelf motivate nothing
    excluded = {"cup", "bottle", "plate", "bowl", "bin", "box", "shelf", "mirror", "plant", "chair", "desk", "pillow"}
    for rec in recs:
        assert not any(by_id[i].effective_label in excluded for i in rec.related_item_ids)
        assert not re.search(r"\bbox\b|\bbin\b|\bshelf\b|item_\d", f"{rec.name} {rec.reason}")
        assert rec.reason.lower() != rec.name.lower()
        assert not INVENTORY.search(rec.reason)
    # the frames are a display group, never "loose items for a box"; the
    # single pillow is not soft-furnishing evidence
    assert "loose" not in " ".join(rec.reason for rec in recs)
    assert all(rec.name != "Soft-furnishing basket or storage bag" for rec in recs)


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

    assert [rec.name for rec in recs] == ["Bookends or a paper tray"]
    assert recs[0].related_item_ids == [item.item_id for item in items]
    assert len(recs[0].reason) <= 300
    assert recs[0].reason.startswith("Stand the 2 a very long user supplied c... items")
    assert recs[0].reason.endswith("and the other books and papers upright in one spot so they stay visible instead of piling up.")


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
