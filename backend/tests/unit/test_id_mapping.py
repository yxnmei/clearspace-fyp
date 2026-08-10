"""
Unit tests for app/core/id_mapping.map_item_numbers — pure logic, no
model loading. Covers missing, duplicate, malformed, and unexpected
item_number handling, the "duplicate is invalid, not first-wins" rule,
the is_complete flag, and the correct-input happy path.
"""

from app.core.id_mapping import map_item_numbers
from app.core.schemas import MappingWarningKind

NUMBER_TO_ID = {1: "item_001", 2: "item_002", 3: "item_003"}


def test_correct_mapping_no_warnings_and_is_complete():
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "in use"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "unread"},
        {"item_number": 3, "label": "cable", "decision": "discard", "reason": "broken"},
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.warnings == []
    assert result.is_complete is True
    assert [m.item_id for m in result.mapped] == ["item_001", "item_002", "item_003"]
    assert result.mapped[0].label == "lamp"
    assert result.mapped[0].decision == "keep"


def test_missing_item_number_is_flagged_and_incomplete():
    raw = [{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "x"}]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    missing = [w for w in result.warnings if w.kind == MappingWarningKind.MISSING]
    assert {w.item_number for w in missing} == {2, 3}
    assert result.is_complete is False


def test_duplicate_item_number_produces_no_mapped_result_for_that_number():
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "first"},
        {"item_number": 1, "label": "lamp", "decision": "discard", "reason": "second"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "x"},
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    mapped_numbers = {m.item_number for m in result.mapped}
    assert 1 not in mapped_numbers  # neither occurrence is exposed, not "first wins"
    assert 2 in mapped_numbers  # unaffected item still maps cleanly

    dupes = [w for w in result.warnings if w.kind == MappingWarningKind.DUPLICATE]
    assert len(dupes) == 1
    assert dupes[0].item_number == 1

    # Not also double-reported as MISSING — DUPLICATE already communicates
    # its unresolved status.
    assert not any(w.kind == MappingWarningKind.MISSING and w.item_number == 1 for w in result.warnings)


def test_mapping_result_marked_incomplete_when_duplicate_present():
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "first"},
        {"item_number": 1, "label": "lamp", "decision": "discard", "reason": "second"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "x"},
        {"item_number": 3, "label": "cable", "decision": "discard", "reason": "x"},
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.is_complete is False


def test_unexpected_item_number_is_flagged_but_does_not_affect_completeness():
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "x"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "x"},
        {"item_number": 3, "label": "cable", "decision": "discard", "reason": "x"},
        {"item_number": 99, "label": "ghost", "decision": "keep", "reason": "x"},
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert 99 not in {m.item_number for m in result.mapped}
    unexpected = [w for w in result.warnings if w.kind == MappingWarningKind.UNEXPECTED]
    assert len(unexpected) == 1
    assert unexpected[0].item_number == 99
    assert result.is_complete is True  # the requested set (1, 2, 3) is still fully resolved


def test_negative_and_zero_item_numbers_are_flagged_as_unexpected():
    raw = [
        {"item_number": 0, "label": "x", "decision": "keep", "reason": "x"},
        {"item_number": -1, "label": "x", "decision": "keep", "reason": "x"},
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.mapped == []
    # NUMBER_TO_ID's expected 1/2/3 are separately, correctly reported
    # MISSING (nothing in `raw` resolves them) — isolate the assertion to
    # the two out-of-range numbers actually under test here.
    relevant = [w for w in result.warnings if w.item_number in (0, -1)]
    assert len(relevant) == 2
    assert all(w.kind == MappingWarningKind.UNEXPECTED for w in relevant)


def test_malformed_item_number_type_is_flagged():
    raw = [{"item_number": "not-a-number", "label": "x", "decision": "keep", "reason": "x"}]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.mapped == []
    assert result.warnings[0].kind == MappingWarningKind.MALFORMED
    assert result.warnings[0].item_number is None


def test_non_dict_response_element_is_flagged_as_malformed():
    raw = ["not even an object"]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.mapped == []
    assert result.warnings[0].kind == MappingWarningKind.MALFORMED


# --- is_complete vs. is_strictly_valid ---
#
# is_complete: every expected item was mapped exactly once — "usable."
# is_strictly_valid: zero warnings of any kind — "the response was
# entirely clean." A response can be complete without being strictly
# valid (stray garbage alongside a full, correct set of expected items);
# it can never be strictly valid without also being complete (any warning
# that isn't MISSING/DUPLICATE still means the response wasn't clean, but
# missing/duplicate warnings themselves fail both).


def test_perfect_response_is_complete_and_strictly_valid():
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "in use"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "unread"},
        {"item_number": 3, "label": "cable", "decision": "discard", "reason": "broken"},
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.is_complete is True
    assert result.is_strictly_valid is True


def test_expected_items_plus_unexpected_item_is_complete_but_not_strictly_valid():
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "x"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "x"},
        {"item_number": 3, "label": "cable", "decision": "discard", "reason": "x"},
        {"item_number": 99, "label": "ghost", "decision": "keep", "reason": "x"},
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.is_complete is True
    assert result.is_strictly_valid is False


def test_expected_items_plus_malformed_garbage_is_complete_but_not_strictly_valid():
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "x"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "x"},
        {"item_number": 3, "label": "cable", "decision": "discard", "reason": "x"},
        "not even an object",
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.is_complete is True
    assert result.is_strictly_valid is False


def test_missing_expected_item_is_neither_complete_nor_strictly_valid():
    raw = [{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "x"}]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.is_complete is False
    assert result.is_strictly_valid is False


def test_duplicate_expected_item_is_neither_complete_nor_strictly_valid():
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "first"},
        {"item_number": 1, "label": "lamp", "decision": "discard", "reason": "second"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "x"},
        {"item_number": 3, "label": "cable", "decision": "discard", "reason": "x"},
    ]
    result = map_item_numbers(raw, NUMBER_TO_ID)
    assert result.is_complete is False
    assert result.is_strictly_valid is False
