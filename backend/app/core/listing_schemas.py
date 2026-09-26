"""
Content schemas for marketplace listing drafts.

The model returns only a title and a description. The item_id and
effective_label are attached by application code from the confirmed
eligibility join, never taken from model output. item_id is the only
identity; label text is never used to match, select or deduplicate.

Seller-supplied details (ListingItemDetails) are request-side data sent
to the model, never produced by it, and never change the label, decision
or confirmation.

Deliberately excluded: price, category, brand, model number, dimensions,
location, contact details, any model-inferred condition, and any
marketplace-publishing field. Signed source/confirmation proof is
deferred (see the listing service).

app/core never imports app/services, so the result wrapper that holds a
ConfirmationResult lives in the listing service, not here.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StringConstraints, model_validator

from app.core.schemas import ItemId, NonEmptyStr

# Structural ceiling, independent of config, so a hand-built ListingDraft
# can never claim an implausible attempt count.
LISTING_MAX_ATTEMPTS_CEILING = 5

# StrictInt: True, 1.0 or "1" is a construction mistake, not something to
# coerce (bool is an int subclass).
_StrictAttempts = Annotated[StrictInt, Field(ge=1, le=LISTING_MAX_ATTEMPTS_CEILING)]

# Presentation bounds rejecting blank and runaway output, not claims about
# content quality.
ListingTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=120)]
ListingDescription = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=1200)]

# Sanitised reasons: raw model output and transport error text never
# reach a response; every failure collapses to one of these.
ListingUnavailableReason = Literal[
    "timeout",
    "service_unavailable",
    "invalid_output",
    "generation_failed",
]

# Seller-declared only, never inferred. With "not_specified" the model is
# told nothing about condition and must not imply one.
ListingCondition = Literal["not_specified", "new", "like_new", "good", "fair", "well_used"]

LISTING_CONDITION_PHRASES: dict[str, str] = {
    "not_specified": "not specified",
    "new": "new",
    "like_new": "like new",
    "good": "good",
    "fair": "fair",
    "well_used": "well used",
}

ListingName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class ListingItemDetails(BaseModel):
    """Seller-supplied details for one item's listing, keyed by item_id.

    listing_name None means "use the detected label". Details never
    affect eligibility: the service derives the Sell set server-side and
    ignores details for items outside it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    item_id: ItemId
    listing_name: ListingName | None = None
    condition: ListingCondition = "not_specified"


class ListingDraftContent(BaseModel):
    """Exactly what the listing model may return: a title and a description.

    extra="forbid" is load-bearing: any identity field (`item_id`,
    `label`, ...) or speculative field (`price`, `condition`, ...) makes
    the whole object invalid, so that item becomes unavailable rather than
    trusting a model-supplied value."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    title: ListingTitle
    description: ListingDescription


class ListingDraft(BaseModel):
    """One eligible item's listing draft. item_id / effective_label are
    trusted values from the eligibility join, never from model output.

    was_repaired: whether the model's raw JSON needed mechanical repair
    before parsing; None when unavailable (no content was produced).
    attempts: model calls spent on this item; the service result also
    pins it against the configured max_attempts."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    item_id: ItemId
    effective_label: NonEmptyStr
    status: Literal["generated", "unavailable"]
    title: ListingTitle | None = None
    description: ListingDescription | None = None
    unavailable_reason: ListingUnavailableReason | None = None
    # StrictBool: 1/0 or "true" must not be coerced into the repair flag.
    was_repaired: StrictBool | None = None
    attempts: _StrictAttempts

    @model_validator(mode="after")
    def _check_status_consistency(self) -> "ListingDraft":
        if self.status == "generated":
            if self.title is None or self.description is None:
                raise ValueError("a generated listing draft must carry both a title and a description")
            if self.unavailable_reason is not None:
                raise ValueError("a generated listing draft must not carry an unavailable_reason")
            if not isinstance(self.was_repaired, bool):
                raise ValueError("a generated listing draft must carry a genuine boolean was_repaired")
        else:  # "unavailable"
            if self.title is not None or self.description is not None:
                raise ValueError("an unavailable listing draft must not carry a title or description")
            if self.unavailable_reason is None:
                raise ValueError("an unavailable listing draft must name an unavailable_reason")
            if self.was_repaired is not None:
                raise ValueError("an unavailable listing draft must not carry was_repaired")
        return self
