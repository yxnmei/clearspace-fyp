"""
Unit tests for app/core/reorganise_semantic_conversion.py —
parse_and_validate_plan() and build_deterministic_fallback_plan(). No
model loading, no I/O; see test_module_has_no_forbidden_imports below for
the enforced import boundary.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core import reorganise_semantic_conversion as rsc
from app.core.reorganise_schemas import KEEP_IN_PLACE_ZONE_NAME, ReorganisePlan
from app.core.reorganise_semantic_conversion import (
    build_deterministic_fallback_plan,
    parse_and_validate_plan,
)
from app.core.schemas import BoundingBox, DetectedItem


def _item(
    item_id="item_001",
    label="picture frame",
    corrected_label=None,
    position="upper-left",
    relative_size="small",
    source_detection_index=0,
) -> DetectedItem:
    return DetectedItem(
        item_id=item_id,
        source_detection_index=source_detection_index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.2, y2=0.2),
        confidence=0.5,
        position=position,
        relative_size=relative_size,
        corrected_label=corrected_label,
    )


def _raw_plan(zones: list[dict], image_prompt: str = "A tidy room.") -> dict:
    return {"zones": zones, "image_prompt": image_prompt}


def _zone_dict(zone_name="Desk area", item_ids=("item_001",), instruction="Group these together."):
    return {"zone_name": zone_name, "item_ids": list(item_ids), "instruction": instruction}


# --- parse_and_validate_plan(): exact accounting ---------------------------


def test_exact_selected_set_match_succeeds():
    raw = _raw_plan([_zone_dict(item_ids=["item_001", "item_002"])])
    result = parse_and_validate_plan(raw, ["item_001", "item_002"])

    assert result.is_valid is True
    assert result.errors == []
    assert isinstance(result.plan, ReorganisePlan)


def test_missing_selected_id_returns_structured_error_and_no_plan():
    raw = _raw_plan([_zone_dict(item_ids=["item_001"])])
    result = parse_and_validate_plan(raw, ["item_001", "item_002"])

    assert result.is_valid is False
    assert result.plan is None
    assert len(result.errors) == 1
    assert result.errors[0].kind == "missing_selected_items"
    assert result.errors[0].item_ids == ["item_002"]


def test_unexpected_id_returns_structured_error_and_no_plan():
    raw = _raw_plan([_zone_dict(item_ids=["item_001", "item_002"])])
    result = parse_and_validate_plan(raw, ["item_001"])

    assert result.is_valid is False
    assert result.plan is None
    assert len(result.errors) == 1
    assert result.errors[0].kind == "unexpected_items"
    assert result.errors[0].item_ids == ["item_002"]


def test_simultaneous_missing_and_unexpected_ids_reports_both():
    raw = _raw_plan([_zone_dict(item_ids=["item_001", "item_003"])])
    result = parse_and_validate_plan(raw, ["item_001", "item_002"])

    assert result.is_valid is False
    assert result.plan is None
    kinds = {e.kind for e in result.errors}
    assert kinds == {"missing_selected_items", "unexpected_items"}
    missing_error = next(e for e in result.errors if e.kind == "missing_selected_items")
    unexpected_error = next(e for e in result.errors if e.kind == "unexpected_items")
    assert missing_error.item_ids == ["item_002"]
    assert unexpected_error.item_ids == ["item_003"]


def test_malformed_raw_object_returns_malformed_plan():
    raw = {"zones": [{"zone_name": "", "item_ids": [], "instruction": "x"}], "image_prompt": "x"}
    result = parse_and_validate_plan(raw, ["item_001"])

    assert result.is_valid is False
    assert result.plan is None
    assert len(result.errors) == 1
    assert result.errors[0].kind == "malformed_plan"
    assert result.errors[0].detail  # non-empty, bounded detail present


@pytest.mark.parametrize("raw", [["not", "a", "dict"], "just a string", 42, None])
def test_raw_list_string_number_none_fail_cleanly_without_raw_exceptions(raw):
    result = parse_and_validate_plan(raw, ["item_001"])

    assert result.is_valid is False
    assert result.plan is None
    assert len(result.errors) == 1
    assert result.errors[0].kind == "malformed_plan"


@pytest.mark.parametrize(
    "bad_selected_item_ids",
    [
        [],
        ["item_001", "item_001"],
        ["not-an-item-id"],
        ["item_1"],  # fewer than 3 digits — doesn't match the ItemId pattern
        [None],
        [[]],  # unhashable element — must not raise a raw TypeError, see below
        [{}],  # unhashable element — must not raise a raw TypeError, see below
        [5],
    ],
)
def test_duplicate_empty_and_malformed_authoritative_selected_ids_raise_value_error(bad_selected_item_ids):
    raw = _raw_plan([_zone_dict(item_ids=["item_001"])])
    with pytest.raises(ValueError):
        parse_and_validate_plan(raw, bad_selected_item_ids)


@pytest.mark.parametrize("non_list_selected_item_ids", ["item_001", {"item_001": True}, None, 5])
def test_non_list_outer_selected_item_ids_raises_value_error(non_list_selected_item_ids):
    raw = _raw_plan([_zone_dict(item_ids=["item_001"])])
    with pytest.raises(ValueError):
        parse_and_validate_plan(raw, non_list_selected_item_ids)


def test_malformed_nested_selected_item_ids_never_raise_raw_type_error():
    # The original bug: set(selected_item_ids) ran before per-element
    # validation, so an unhashable element (a nested list/dict) raised a
    # raw TypeError instead of a clear ValueError identifying
    # selected_item_ids as the problem. Every element is now validated
    # through the shared ItemId type BEFORE any hashing/dedup happens.
    raw = _raw_plan([_zone_dict(item_ids=["item_001"])])
    for bad in ([[]], [{}]):
        try:
            parse_and_validate_plan(raw, bad)
        except ValueError:
            pass
        except TypeError:
            pytest.fail(f"parse_and_validate_plan raised a raw TypeError for {bad!r}")


def test_selected_item_id_whitespace_is_normalized_via_shared_item_id_type():
    # Inherited behaviour from the shared ItemId type
    # (StringConstraints(strip_whitespace=True, ...)) — proven directly
    # here so this local function can't silently drift from that
    # definition by re-implementing its own, possibly-different rule.
    raw = _raw_plan([_zone_dict(item_ids=["item_001"])])
    result = parse_and_validate_plan(raw, [" item_001 "])
    assert result.is_valid is True


def test_input_order_does_not_affect_validity():
    raw = _raw_plan(
        [_zone_dict(zone_name="A", item_ids=["item_002", "item_001"])]
    )
    result_forward = parse_and_validate_plan(raw, ["item_001", "item_002"])
    result_reversed = parse_and_validate_plan(raw, ["item_002", "item_001"])

    assert result_forward.is_valid is True
    assert result_reversed.is_valid is True


def test_duplicate_same_label_objects_remain_independently_accounted_for_by_item_id():
    # Two zones, two distinct item_ids, both conceptually "picture frame" —
    # parse_and_validate_plan never reads label text, so this must account
    # for both ids independently, not collapse them.
    raw = _raw_plan(
        [
            _zone_dict(zone_name="Wall A", item_ids=["item_001"]),
            _zone_dict(zone_name="Wall B", item_ids=["item_002"]),
        ]
    )
    result = parse_and_validate_plan(raw, ["item_001", "item_002"])

    assert result.is_valid is True
    accounted = {iid for zone in result.plan.zones for iid in zone.item_ids}
    assert accounted == {"item_001", "item_002"}


# --- PlanConversionError invariants -----------------------------------------


def test_malformed_plan_error_with_item_ids_rejected():
    with pytest.raises(ValidationError, match="must not carry item_ids"):
        rsc.PlanConversionError(kind="malformed_plan", detail="x", item_ids=["item_001"])


def test_missing_selected_items_error_without_item_ids_rejected():
    with pytest.raises(ValidationError, match="must carry at least one item_id"):
        rsc.PlanConversionError(kind="missing_selected_items", detail="x", item_ids=[])


def test_unexpected_items_error_without_item_ids_rejected():
    with pytest.raises(ValidationError, match="must carry at least one item_id"):
        rsc.PlanConversionError(kind="unexpected_items", detail="x", item_ids=[])


def test_plan_conversion_error_duplicate_item_ids_rejected():
    with pytest.raises(ValidationError, match="duplicates"):
        rsc.PlanConversionError(kind="missing_selected_items", detail="x", item_ids=["item_001", "item_001"])


def test_plan_conversion_error_detail_over_500_chars_rejected():
    with pytest.raises(ValidationError):
        rsc.PlanConversionError(kind="malformed_plan", detail="x" * 501)


def test_plan_conversion_error_detail_exactly_500_chars_accepted():
    error = rsc.PlanConversionError(kind="malformed_plan", detail="x" * 500)
    assert len(error.detail) == 500


def test_plan_conversion_error_blank_detail_rejected():
    with pytest.raises(ValidationError):
        rsc.PlanConversionError(kind="malformed_plan", detail="   ")


def test_plan_conversion_error_item_ids_default_factory_not_shared():
    # Field(default_factory=list) — two independently-constructed errors
    # must never share the same underlying list object.
    error_a = rsc.PlanConversionError(kind="malformed_plan", detail="a")
    error_b = rsc.PlanConversionError(kind="malformed_plan", detail="b")
    assert error_a.item_ids is not error_b.item_ids


def test_bounded_helper_never_exceeds_limit_including_suffix():
    text = "x" * 10000
    result = rsc._bounded(text, limit=500)
    assert len(result) <= 500
    assert result.endswith(rsc._TRUNCATION_SUFFIX)


def test_bounded_helper_returns_short_text_unchanged():
    assert rsc._bounded("short", limit=500) == "short"


# --- PlanConversionResult invariants ----------------------------------------


def test_plan_conversion_result_plan_plus_errors_rejected():
    plan = build_deterministic_fallback_plan([_item()], "bedroom")
    error = rsc.PlanConversionError(kind="malformed_plan", detail="x")
    with pytest.raises(ValidationError, match="cannot have both a plan and errors"):
        rsc.PlanConversionResult(plan=plan, errors=[error])


def test_plan_conversion_result_no_plan_no_errors_rejected():
    with pytest.raises(ValidationError, match="must have at least one error"):
        rsc.PlanConversionResult(plan=None, errors=[])


def test_plan_conversion_result_valid_state_constructs_directly():
    plan = build_deterministic_fallback_plan([_item()], "bedroom")
    result = rsc.PlanConversionResult(plan=plan, errors=[])
    assert result.is_valid is True


def test_plan_conversion_result_invalid_state_constructs_directly():
    error = rsc.PlanConversionError(kind="malformed_plan", detail="x")
    result = rsc.PlanConversionResult(plan=None, errors=[error])
    assert result.is_valid is False


# --- build_deterministic_fallback_plan() ------------------------------------


def test_fallback_output_is_deterministic():
    items = [_item("item_001", label="picture frame"), _item("item_002", label="picture frame")]
    plan1 = build_deterministic_fallback_plan(items, "bedroom", "keep it minimal")
    plan2 = build_deterministic_fallback_plan(items, "bedroom", "keep it minimal")

    assert plan1.model_dump() == plan2.model_dump()


def test_fallback_complete_exact_item_accounting():
    items = [_item("item_001"), _item("item_002"), _item("item_003")]
    plan = build_deterministic_fallback_plan(items, "bedroom")

    assert len(plan.zones) == 1
    assert plan.zones[0].zone_name == KEEP_IN_PLACE_ZONE_NAME
    assert set(plan.zones[0].item_ids) == {"item_001", "item_002", "item_003"}


def test_fallback_input_order_preserved():
    items = [_item("item_003"), _item("item_001"), _item("item_002")]
    plan = build_deterministic_fallback_plan(items, "bedroom")

    assert plan.zones[0].item_ids == ["item_003", "item_001", "item_002"]


def test_fallback_uses_effective_label_for_corrected_items():
    item = _item("item_001", label="jewelry", corrected_label="necklace")
    plan = build_deterministic_fallback_plan([item], "bedroom")

    assert item.effective_label == "necklace"
    assert "necklace" in plan.image_prompt
    assert "jewelry" not in plan.image_prompt


def test_fallback_duplicate_same_label_objects_both_appear():
    items = [_item("item_001", label="picture frame"), _item("item_002", label="picture frame")]
    plan = build_deterministic_fallback_plan(items, "bedroom")

    assert set(plan.zones[0].item_ids) == {"item_001", "item_002"}
    assert plan.image_prompt.count("picture frame") == 2


def test_fallback_spatial_descriptors_reach_the_image_prompt():
    item = _item("item_001", position="lower-right", relative_size="large")
    plan = build_deterministic_fallback_plan([item], "bedroom")

    assert "lower-right" in plan.image_prompt
    assert "large" in plan.image_prompt


def test_fallback_optional_context_reaches_the_prompt():
    plan = build_deterministic_fallback_plan([_item()], "bedroom", user_context="prefers warm lighting")
    assert "prefers warm lighting" in plan.image_prompt


def test_fallback_no_context_still_produces_a_valid_prompt():
    plan = build_deterministic_fallback_plan([_item()], "bedroom", user_context=None)
    assert plan.image_prompt  # non-empty, validates as NonEmptyStr already


def test_fallback_empty_selection_rejected():
    with pytest.raises(ValueError, match="non-empty list"):
        build_deterministic_fallback_plan([], "bedroom")


def test_fallback_duplicate_item_ids_rejected():
    items = [_item("item_001"), _item("item_001")]
    with pytest.raises(ValueError, match="duplicate item_id"):
        build_deterministic_fallback_plan(items, "bedroom")


def test_fallback_blank_scene_label_rejected():
    with pytest.raises(ValueError, match="scene_label"):
        build_deterministic_fallback_plan([_item()], "   ")


def test_fallback_round_trips_through_parse_and_validate_plan():
    items = [_item("item_001"), _item("item_002")]
    plan = build_deterministic_fallback_plan(items, "bedroom")

    result = parse_and_validate_plan(plan.model_dump(), ["item_001", "item_002"])

    assert result.is_valid is True


# --- build_deterministic_fallback_plan(): caller-input hardening ------------


def test_fallback_selected_items_none_rejected():
    with pytest.raises(ValueError, match="non-empty list"):
        build_deterministic_fallback_plan(None, "bedroom")


def test_fallback_non_list_selected_items_rejected():
    with pytest.raises(ValueError, match="non-empty list"):
        build_deterministic_fallback_plan("item_001", "bedroom")


def test_fallback_list_containing_a_non_detected_item_rejected():
    with pytest.raises(ValueError, match="DetectedItem"):
        build_deterministic_fallback_plan([_item(), {"item_id": "item_002"}], "bedroom")


def test_fallback_non_string_scene_label_rejected():
    with pytest.raises(ValueError, match="scene_label"):
        build_deterministic_fallback_plan([_item()], 123)


def test_fallback_non_string_user_context_rejected():
    with pytest.raises(ValueError, match="user_context"):
        build_deterministic_fallback_plan([_item()], "bedroom", user_context=123)


def test_fallback_whitespace_only_user_context_is_treated_as_absent():
    # Deliberate decision (see build_deterministic_fallback_plan's own
    # docstring): a whitespace-only user_context is valid input (it's a
    # string) but produces the exact same output as no context at all —
    # it is never surfaced in the prompt.
    with_whitespace = build_deterministic_fallback_plan([_item()], "bedroom", user_context="   ")
    without_context = build_deterministic_fallback_plan([_item()], "bedroom", user_context=None)
    assert with_whitespace.model_dump() == without_context.model_dump()


# --- import boundary --------------------------------------------------------


def test_module_has_no_forbidden_imports():
    source = Path(rsc.__file__).read_text(encoding="utf-8")
    forbidden = ["import torch", "import ollama", "import groundingdino", "import requests", "from app.models", "import app.models"]
    for token in forbidden:
        assert token not in source, f"forbidden import found in reorganise_semantic_conversion.py: {token!r}"
