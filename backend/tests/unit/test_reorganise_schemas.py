"""
Unit tests for app/core/reorganise_schemas.py — pure content schemas for
the Reorganise plan. No model loading, no I/O; see
test_module_has_no_forbidden_imports below for the enforced import
boundary.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core import reorganise_schemas as rs
from app.core.reorganise_schemas import KEEP_IN_PLACE_ZONE_NAME, ReorganisePlan, ReorganiseZone


def _zone(zone_name="Desk area", item_ids=("item_001",), instruction="Group these together."):
    return ReorganiseZone(zone_name=zone_name, item_ids=list(item_ids), instruction=instruction)


def test_valid_zone_and_plan():
    zone = _zone()
    plan = ReorganisePlan(zones=[zone], image_prompt="A tidy room.")
    assert plan.zones == [zone]
    assert plan.negative_prompt is None


def test_empty_zone_list_rejected():
    with pytest.raises(ValidationError, match="at least one zone"):
        ReorganisePlan(zones=[], image_prompt="A tidy room.")


def test_empty_item_list_rejected():
    with pytest.raises(ValidationError, match="at least one item_id"):
        ReorganiseZone(zone_name="Desk area", item_ids=[], instruction="Group these together.")


def test_duplicate_item_within_a_zone_rejected():
    with pytest.raises(ValidationError, match="duplicate item_id"):
        ReorganiseZone(zone_name="Desk area", item_ids=["item_001", "item_001"], instruction="x")


def test_duplicate_item_across_zones_rejected():
    zone_a = _zone(zone_name="Desk area", item_ids=["item_001"])
    zone_b = _zone(zone_name="Shelf area", item_ids=["item_001"])
    with pytest.raises(ValidationError, match="more than one zone"):
        ReorganisePlan(zones=[zone_a, zone_b], image_prompt="A tidy room.")


def test_duplicate_zone_names_rejected():
    zone_a = _zone(zone_name="Desk area", item_ids=["item_001"])
    zone_b = _zone(zone_name="Desk area", item_ids=["item_002"])
    with pytest.raises(ValidationError, match="duplicate zone_name"):
        ReorganisePlan(zones=[zone_a, zone_b], image_prompt="A tidy room.")


def test_case_insensitive_duplicate_zone_names_rejected():
    zone_a = _zone(zone_name="Desk Area", item_ids=["item_001"])
    zone_b = _zone(zone_name="desk area", item_ids=["item_002"])
    with pytest.raises(ValidationError, match="duplicate zone_name"):
        ReorganisePlan(zones=[zone_a, zone_b], image_prompt="A tidy room.")


def test_blank_instruction_rejected():
    with pytest.raises(ValidationError):
        ReorganiseZone(zone_name="Desk area", item_ids=["item_001"], instruction="   ")


def test_blank_image_prompt_rejected():
    with pytest.raises(ValidationError):
        ReorganisePlan(zones=[_zone()], image_prompt="   ")


def test_blank_non_null_negative_prompt_rejected():
    with pytest.raises(ValidationError):
        ReorganisePlan(zones=[_zone()], image_prompt="A tidy room.", negative_prompt="   ")


def test_negative_prompt_none_is_valid():
    plan = ReorganisePlan(zones=[_zone()], image_prompt="A tidy room.", negative_prompt=None)
    assert plan.negative_prompt is None


def test_same_label_on_two_distinct_item_ids_remains_valid():
    # ReorganiseZone/ReorganisePlan never read label text at all — this
    # guards against a future accidental label-based dedup regression.
    # item_001 and item_002 here conceptually represent two real objects
    # that happen to share a label (e.g. two "picture frame"s) — schema
    # validation is entirely item_id-based and must not care.
    zone_a = _zone(zone_name="Desk area", item_ids=["item_001"])
    zone_b = _zone(zone_name="Shelf area", item_ids=["item_002"])
    plan = ReorganisePlan(zones=[zone_a, zone_b], image_prompt="A tidy room.")
    assert plan.zones[0].item_ids == ["item_001"]
    assert plan.zones[1].item_ids == ["item_002"]


def test_keep_in_place_zone_name_constant():
    assert KEEP_IN_PLACE_ZONE_NAME == "Keep in place"


# --- extra="forbid": raw LLM output can't smuggle in unrecognised fields --


def test_extra_top_level_plan_field_rejected():
    with pytest.raises(ValidationError):
        ReorganisePlan.model_validate(
            {"zones": [_zone().model_dump()], "image_prompt": "A tidy room.", "extra_field": "surprise"}
        )


def test_extra_zone_field_rejected():
    with pytest.raises(ValidationError):
        ReorganiseZone.model_validate(
            {"zone_name": "Desk area", "item_ids": ["item_001"], "instruction": "x", "extra_field": "surprise"}
        )


@pytest.mark.parametrize("sneaky_field", ["provenance", "model_name", "prompt_version"])
def test_raw_provenance_or_model_metadata_cannot_be_silently_accepted(sneaky_field):
    # These are exactly the fields PlanProvenance/service identity must
    # come from the SERVICE (R2), never from raw LLM content — see
    # reorganise_schemas.py's module docstring.
    raw = {"zones": [_zone().model_dump()], "image_prompt": "A tidy room.", sneaky_field: "raw_valid"}
    with pytest.raises(ValidationError):
        ReorganisePlan.model_validate(raw)


def test_module_has_no_forbidden_imports():
    source = Path(rs.__file__).read_text(encoding="utf-8")
    forbidden = ["import torch", "import ollama", "import groundingdino", "import requests", "from app.models", "import app.models"]
    for token in forbidden:
        assert token not in source, f"forbidden import found in reorganise_schemas.py: {token!r}"
