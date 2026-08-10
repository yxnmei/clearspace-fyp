"""
Unit tests for app/core/semantic_conversion.py — pure logic, no model
calls. Covers decision-enum enforcement, missing/blank reason rejection,
and that one bad item doesn't block conversion of the rest.
"""

from app.core.id_mapping import map_item_numbers
from app.core.schemas import Decision, MappedLLMItem
from app.core.semantic_conversion import convert_mapped_items_to_ai_decisions

NUMBER_TO_ID = {1: "item_001", 2: "item_002"}


def test_valid_mapped_items_convert_cleanly():
    mapped = [
        MappedLLMItem(item_number=1, item_id="item_001", label="lamp", decision="keep", reason="in use"),
        MappedLLMItem(item_number=2, item_id="item_002", label="book", decision="donate", reason="unread"),
    ]
    result = convert_mapped_items_to_ai_decisions(mapped)
    assert result.is_complete is True
    assert result.errors == []
    assert [d.decision for d in result.ai_decisions] == [Decision.KEEP, Decision.DONATE]


def test_invalid_decision_value_is_rejected_during_conversion():
    mapped = [MappedLLMItem(item_number=1, item_id="item_001", label="lamp", decision="sort through", reason="x")]
    result = convert_mapped_items_to_ai_decisions(mapped)
    assert result.ai_decisions == []
    assert result.is_complete is False
    assert result.errors[0].item_number == 1
    assert result.errors[0].item_id == "item_001"


def test_missing_decision_is_rejected_during_conversion():
    mapped = [MappedLLMItem(item_number=1, item_id="item_001", label="lamp", decision=None, reason="x")]
    result = convert_mapped_items_to_ai_decisions(mapped)
    assert result.ai_decisions == []
    assert result.is_complete is False


def test_missing_reason_is_rejected_during_conversion():
    mapped = [MappedLLMItem(item_number=1, item_id="item_001", label="lamp", decision="keep", reason=None)]
    result = convert_mapped_items_to_ai_decisions(mapped)
    assert result.ai_decisions == []
    assert result.is_complete is False


def test_blank_reason_is_rejected_during_conversion():
    mapped = [MappedLLMItem(item_number=1, item_id="item_001", label="lamp", decision="keep", reason="   ")]
    result = convert_mapped_items_to_ai_decisions(mapped)
    assert result.ai_decisions == []
    assert result.is_complete is False


def test_conversion_composes_with_a_real_id_mapping_result():
    # End-to-end of the two pure stages together, still with no model calls.
    raw = [
        {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "in use"},
        {"item_number": 2, "label": "book", "decision": "donate", "reason": "unread"},
    ]
    mapping_result = map_item_numbers(raw, NUMBER_TO_ID)
    assert mapping_result.is_complete is True
    conversion_result = convert_mapped_items_to_ai_decisions(mapping_result.mapped)
    assert conversion_result.is_complete is True
    assert len(conversion_result.ai_decisions) == 2


def test_one_bad_item_does_not_block_conversion_of_the_rest():
    mapped = [
        MappedLLMItem(item_number=1, item_id="item_001", label="lamp", decision="keep", reason="in use"),
        MappedLLMItem(item_number=2, item_id="item_002", label="book", decision="not-a-decision", reason="x"),
    ]
    result = convert_mapped_items_to_ai_decisions(mapped)
    assert len(result.ai_decisions) == 1
    assert result.ai_decisions[0].item_id == "item_001"
    assert len(result.errors) == 1
    assert result.errors[0].item_id == "item_002"
    assert result.is_complete is False
