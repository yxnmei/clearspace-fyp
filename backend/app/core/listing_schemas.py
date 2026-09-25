"""
Pure core domain schemas for marketplace listing drafts — V1, content
only.

Scope is deliberately narrow. A V1 listing draft carries exactly:
  - a trusted item_id and effective_label, attached by application code
    from the confirmed eligibility join (NEVER taken from model output);
  - a model-generated title and description, and nothing else the model
    produced;
  - a generated / unavailable status with a sanitised unavailable reason;
  - a bounded per-item attempt count.

Seller-supplied listing details (ListingItemDetails, below) are a
separate, request-side concept: a listing name and a declared condition
the person types or picks, sent to the model as data and never produced
by it. They are listing metadata only; they never change the detected
label, the decision or the confirmation. The model still returns exactly
a title and a description.

Deliberately excluded, and not to be added: price, category, brand,
model number, age, dimensions, accessories, ownership, location, contact
details, any model-inferred condition, and any marketplace-publishing or
Carousell-integration field. Signed source/confirmation proof is also
explicitly deferred — see app/services/listing_service.py's module
docstring for the honest limit that recomputation validates internal
consistency but cannot cryptographically stop a client fabricating a
whole consistent source payload.

Dependency direction: app/core must never import app/services, so the
listing-generation RESULT that wraps a ConfirmationResult lives in
app/services/listing_service.py, not here. This module holds only the
pure, model-free content schemas. ItemId / NonEmptyStr are reused from
app.core.schemas — one shared identity vocabulary, never a second one.

item_id is the only identity a listing draft carries; label text is
display data and is never used to match, select, or deduplicate.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StringConstraints, model_validator

from app.core.schemas import ItemId, NonEmptyStr

# The hard ceiling on per-item model attempts, independent of config.
# settings.listing_llm_max_attempts is validated to 1..5; this is the
# structural upper bound the result schemas enforce so a hand-built
# ListingDraft can never claim an implausible attempt count.
LISTING_MAX_ATTEMPTS_CEILING = 5

# A genuine integer in 1..LISTING_MAX_ATTEMPTS_CEILING. StrictInt rejects
# bool, float, and numeric strings — an attempt count of `True`, `1.0` or
# "1" is a construction mistake, not something to coerce.
_StrictAttempts = Annotated[StrictInt, Field(ge=1, le=LISTING_MAX_ATTEMPTS_CEILING)]

# Trimmed, non-empty, length-bounded generated text. The model is asked
# for a short title and a two/three-sentence description; these bounds
# reject blank, whitespace-only, and runaway output alike. They are
# presentation bounds, not correctness claims about the content.
ListingTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=120)]
ListingDescription = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=1200)]

# Sanitised, closed vocabulary for why one item's draft could not be
# produced. Raw model output and transport error text never appear
# anywhere near a response — every failure collapses to one of these.
ListingUnavailableReason = Literal[
    "timeout",
    "service_unavailable",
    "invalid_output",
    "generation_failed",
]

# The seller's declared condition. "not_specified" is the default and
# means exactly that: the model is told nothing about condition and must
# not state or imply one. Never inferred from the image or the label.
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
    """Seller-supplied details for ONE item's listing, keyed by item_id.

    listing_name: the person's own name for the item as it should appear
    in the listing (defaults client-side to the reviewed label; None here
    means "use the detected label"). condition: the declared condition,
    "not_specified" by default.

    These are listing metadata only. They never change the detected
    label, the decision, the confirmation or eligibility: the service
    derives the eligible Sell set server-side and simply ignores details
    for any item that is not in it. extra="forbid" so a price, brand or
    any other speculative field is a validation error, not a passenger."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    item_id: ItemId
    listing_name: ListingName | None = None
    condition: ListingCondition = "not_specified"


class ListingDraftContent(BaseModel):
    """EXACTLY what the listing model is allowed to return: one JSON
    object with a `title` and a `description`, and no other field.

    extra="forbid" is load-bearing, not decorative — it is what makes the
    model structurally unable to return an identity field (`item_id`,
    `id`, `label`, ...) or any speculative listing field (`price`,
    `condition`, `brand`, ...). Any such key makes the whole object
    invalid, so application code falls back to an unavailable outcome for
    that item rather than trusting a single model-supplied value.
    Identity is attached by application code afterwards, from the trusted
    eligibility join — never read from here."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    title: ListingTitle
    description: ListingDescription


class ListingDraft(BaseModel):
    """One eligible item's V1 listing draft.

    item_id / effective_label are trusted values attached by
    app/services/listing_service.py from the confirmed eligibility join
    (DetectedItem.item_id / DetectedItem.effective_label). They are never
    taken from model output.

    status == "generated": title and description are present and valid,
    unavailable_reason is None, was_repaired is a genuine bool.
    status == "unavailable": title and description are both None,
    unavailable_reason names a sanitised cause, was_repaired is None.

    was_repaired: for a generated draft, whether the model's raw JSON
    needed mechanical repair (a trailing-comma fix or extraction from
    surrounding prose/fences) before it parsed — carried straight from
    the listing model result, not inferred. None for an unavailable
    draft (no content was produced, so the question does not apply).

    attempts: how many model calls were spent on this one item — at
    least 1, never more than LISTING_MAX_ATTEMPTS_CEILING. The
    result-level ListingGenerationResult additionally pins this against
    the request's configured max_attempts.

    extra="forbid": this is a fresh listing-domain schema, so an unknown
    field is a construction mistake, not something to ignore."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    item_id: ItemId
    effective_label: NonEmptyStr
    status: Literal["generated", "unavailable"]
    title: ListingTitle | None = None
    description: ListingDescription | None = None
    unavailable_reason: ListingUnavailableReason | None = None
    # StrictBool: an int 1/0 or the string "true" must NOT be silently
    # coerced — a generated draft's repair flag has to be a real bool.
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
