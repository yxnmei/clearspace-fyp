"""
Unit tests for app/core/listing_schemas.py — pure, model-free schema
validation. No model calls, no network, no imports of the model stack.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.listing_schemas import ListingDraft, ListingDraftContent


# ---------------------------------------------------------------------------
# ListingDraftContent — exactly {title, description}
# ---------------------------------------------------------------------------


def test_valid_content_is_accepted_and_trimmed():
    content = ListingDraftContent(title="  Wooden chair  ", description="  A sturdy wooden chair for everyday use.  ")
    assert content.title == "Wooden chair"
    assert content.description == "A sturdy wooden chair for everyday use."


@pytest.mark.parametrize(
    "kwargs",
    [
        {"title": "", "description": "A perfectly usable description here."},
        {"title": "   ", "description": "A perfectly usable description here."},
        {"title": "ok", "description": "   "},
        {"title": "ok", "description": ""},
    ],
)
def test_blank_or_too_short_fields_are_rejected(kwargs):
    with pytest.raises(ValidationError):
        ListingDraftContent(**kwargs)


def test_oversized_fields_are_rejected():
    with pytest.raises(ValidationError):
        ListingDraftContent(title="t" * 121, description="a valid description of the item")
    with pytest.raises(ValidationError):
        ListingDraftContent(title="a fine title", description="d" * 1201)


def test_missing_field_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraftContent(title="a fine title")
    with pytest.raises(ValidationError):
        ListingDraftContent(description="a fine description of the item")


def test_wrongly_typed_field_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraftContent(title=123, description="a fine description of the item")
    with pytest.raises(ValidationError):
        ListingDraftContent(title="a fine title", description=["not", "a", "string"])


@pytest.mark.parametrize("extra", [{"item_id": "item_001"}, {"id": 1}, {"price": 10}, {"condition": "good"}])
def test_any_extra_field_is_rejected(extra):
    with pytest.raises(ValidationError):
        ListingDraftContent(title="a fine title", description="a fine description of the item", **extra)


def test_content_is_frozen():
    content = ListingDraftContent(title="a fine title", description="a fine description of the item")
    with pytest.raises(ValidationError):
        content.title = "changed"


# ---------------------------------------------------------------------------
# ListingDraft — status/field consistency
# ---------------------------------------------------------------------------


def _generated(**overrides):
    base = dict(
        item_id="item_001",
        effective_label="chair",
        status="generated",
        title="Wooden chair",
        description="A sturdy wooden chair for everyday use.",
        unavailable_reason=None,
        was_repaired=False,
        attempts=1,
    )
    base.update(overrides)
    return base


def _unavailable(**overrides):
    base = dict(
        item_id="item_001",
        effective_label="chair",
        status="unavailable",
        title=None,
        description=None,
        unavailable_reason="generation_failed",
        was_repaired=None,
        attempts=3,
    )
    base.update(overrides)
    return base


def test_generated_draft_valid():
    draft = ListingDraft(**_generated())
    assert draft.status == "generated"
    assert draft.title == "Wooden chair"
    assert draft.attempts == 1
    assert draft.was_repaired is False


def test_generated_draft_records_was_repaired_true():
    draft = ListingDraft(**_generated(was_repaired=True))
    assert draft.was_repaired is True


def test_generated_without_genuine_bool_was_repaired_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(was_repaired=None))
    for bad in (1, 0, "true", "yes"):
        with pytest.raises(ValidationError):
            ListingDraft(**_generated(was_repaired=bad))


def test_unavailable_with_was_repaired_set_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_unavailable(was_repaired=False))
    with pytest.raises(ValidationError):
        ListingDraft(**_unavailable(was_repaired=True))


def test_attempts_above_ceiling_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(attempts=6))
    with pytest.raises(ValidationError):
        ListingDraft(**_unavailable(attempts=99))


def test_extra_field_on_draft_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(price=10))


def test_unavailable_draft_valid():
    draft = ListingDraft(**_unavailable())
    assert draft.status == "unavailable"
    assert draft.unavailable_reason == "generation_failed"
    assert draft.title is None


def test_generated_without_title_or_description_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(title=None))
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(description=None))


def test_generated_with_unavailable_reason_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(unavailable_reason="timeout"))


def test_unavailable_with_title_or_description_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_unavailable(title="Wooden chair"))
    with pytest.raises(ValidationError):
        ListingDraft(**_unavailable(description="A chair."))


def test_unavailable_without_reason_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_unavailable(unavailable_reason=None))


def test_unknown_unavailable_reason_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_unavailable(unavailable_reason="disk_full"))


def test_attempts_must_be_at_least_one():
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(attempts=0))


@pytest.mark.parametrize("bad", [True, False, 1.0, 3.0, "1", "3", None])
def test_attempts_must_be_a_genuine_strict_integer(bad):
    """A bool, float, or numeric string is a construction mistake, not
    something to coerce into an attempt count."""
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(attempts=bad))


def test_bad_item_id_shape_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(item_id="chair"))


def test_blank_effective_label_is_rejected():
    with pytest.raises(ValidationError):
        ListingDraft(**_generated(effective_label="   "))


def test_draft_is_frozen():
    draft = ListingDraft(**_generated())
    with pytest.raises(ValidationError):
        draft.status = "unavailable"


# ---------------------------------------------------------------------------
# ListingItemDetails: seller-supplied listing name and condition
# ---------------------------------------------------------------------------

from app.core.listing_schemas import LISTING_CONDITION_PHRASES, ListingItemDetails  # noqa: E402


def test_listing_item_details_defaults_to_no_name_and_not_specified():
    details = ListingItemDetails(item_id="item_001")
    assert details.listing_name is None
    assert details.condition == "not_specified"


@pytest.mark.parametrize("condition", sorted(LISTING_CONDITION_PHRASES))
def test_listing_item_details_accepts_every_declared_condition(condition):
    assert ListingItemDetails(item_id="item_001", condition=condition).condition == condition


@pytest.mark.parametrize("bad", ["mint", "NEW", "", None, 1, "like new"])
def test_listing_item_details_rejects_unknown_condition(bad):
    with pytest.raises(ValidationError):
        ListingItemDetails(item_id="item_001", condition=bad)


def test_listing_item_details_trims_and_bounds_the_listing_name():
    assert ListingItemDetails(item_id="item_001", listing_name="  Oak desk lamp  ").listing_name == "Oak desk lamp"
    with pytest.raises(ValidationError):
        ListingItemDetails(item_id="item_001", listing_name="   ")
    with pytest.raises(ValidationError):
        ListingItemDetails(item_id="item_001", listing_name="x" * 81)
    assert len(ListingItemDetails(item_id="item_001", listing_name="x" * 80).listing_name) == 80


@pytest.mark.parametrize("extra", [{"price": 10}, {"brand": "IKEA"}, {"title": "x"}, {"decision": "sell"}])
def test_listing_item_details_forbids_any_other_field(extra):
    with pytest.raises(ValidationError):
        ListingItemDetails(item_id="item_001", **extra)


def test_listing_item_details_is_frozen_and_requires_a_valid_item_id():
    details = ListingItemDetails(item_id="item_001", condition="good")
    with pytest.raises(ValidationError):
        details.condition = "new"
    with pytest.raises(ValidationError):
        ListingItemDetails(item_id="")


def test_listing_draft_content_still_refuses_a_condition_field_from_the_model():
    with pytest.raises(ValidationError):
        ListingDraftContent(title="Used lamp", description="A used lamp for everyday use.", condition="good")
