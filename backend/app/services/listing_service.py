"""Server-derived marketplace eligibility and bounded draft generation.

Eligible items are exactly confirmed, non-excluded Sell item_ids; clients
cannot supply or widen that set. Revalidation proves internal consistency,
not signed provenance, so a fabricated self-consistent bundle remains a
deferred limitation. item_id is the only identity; labels are display text.

Expected per-item failures become sanitised unavailable drafts without
blocking other items. Unexpected programming errors propagate.
"""

from __future__ import annotations

from typing import Protocol

from app.core.listing_schemas import ListingItemDetails

from pydantic import BaseModel, ConfigDict, StrictInt, model_validator

from app.config import get_settings
from app.core.listing_schemas import (
    LISTING_MAX_ATTEMPTS_CEILING,
    ListingDraft,
    ListingDraftContent,
    ListingUnavailableReason,
)
from app.core.schemas import (
    AnalysisResult,
    Decision,
    DecisionOverride,
    DetectedItem,
    ItemId,
    NonEmptyStr,
)
from app.models.listing_llm import (
    LISTING_PROMPT_VERSION,
    ListingModelError,
    ListingModelTimeoutError,
    ListingModelUnavailableError,
)
from app.services.confirmation_service import (
    ConfirmationResult,
    confirm_declutter_result,
)
from app.services.declutter_service import DeclutterResult


class ListingEligibilityInputError(ValueError):
    """A mismatched run or analysis/declutter pair supplied for eligibility.

    Deliberately not a subclass of IncompleteDeclutterError or
    ConfirmationInputError, so neither handler can swallow a mismatch."""


class ListingEligibilityResult(BaseModel):
    """A validated eligible set and its server-derived confirmation."""

    model_config = ConfigDict(frozen=True)

    run_id: NonEmptyStr
    confirmation: ConfirmationResult
    eligible_items: list[DetectedItem]
    eligible_item_ids: list[ItemId]

    @model_validator(mode="after")
    def _check_internal_consistency(self) -> "ListingEligibilityResult":
        if self.run_id != self.confirmation.run_id:
            raise ValueError("run_id must match confirmation.run_id")

        item_ids = [item.item_id for item in self.eligible_items]
        if self.eligible_item_ids != item_ids:
            raise ValueError(
                "eligible_item_ids must exactly equal, in order, the item_ids of eligible_items"
            )

        if len(self.eligible_item_ids) != len(set(self.eligible_item_ids)):
            raise ValueError("eligible_item_ids contains duplicates")

        decisions_by_id = {c.item_id: c for c in self.confirmation.confirmed_decisions}
        for item_id in self.eligible_item_ids:
            confirmed = decisions_by_id.get(item_id)
            if confirmed is None:
                raise ValueError(f"eligible item {item_id!r} is not present in the confirmation")
            if confirmed.confirmed_decision != Decision.SELL:
                raise ValueError(
                    f"eligible item {item_id!r} has confirmed_decision "
                    f"{confirmed.confirmed_decision.value!r}, not Sell"
                )
            if confirmed.excluded:
                raise ValueError(f"eligible item {item_id!r} is excluded and cannot be listing-eligible")

        # Require the complete eligible set in confirmation order, not a subset.
        expected_eligible_ids = [
            c.item_id
            for c in self.confirmation.confirmed_decisions
            if c.confirmed_decision == Decision.SELL and not c.excluded
        ]
        if self.eligible_item_ids != expected_eligible_ids:
            raise ValueError(
                "eligible_item_ids must exactly equal, in confirmation order, every confirmed "
                "non-excluded Sell item_id in confirmation.confirmed_decisions"
            )

        return self


def _index_listing_details(
    listing_details: list[ListingItemDetails] | None,
    declutter: DeclutterResult,
) -> dict[str, ListingItemDetails]:
    """Validate optional seller details without letting them widen eligibility."""
    if listing_details is None:
        return {}
    if not isinstance(listing_details, list):
        raise ListingEligibilityInputError("listing_details must be a list")
    expected = set(declutter.expected_item_ids)
    indexed: dict[str, ListingItemDetails] = {}
    for index, entry in enumerate(listing_details):
        if not isinstance(entry, ListingItemDetails):
            raise ListingEligibilityInputError(f"listing_details[{index}] must be ListingItemDetails")
        if entry.item_id in indexed:
            raise ListingEligibilityInputError(f"listing_details contains a duplicate item_id: {entry.item_id!r}")
        if entry.item_id not in expected:
            raise ListingEligibilityInputError(
                f"listing_details[{index}].item_id {entry.item_id!r} is not an actionable item of this run"
            )
        indexed[entry.item_id] = entry
    return indexed


def _check_matched_pair(run_id: str, analysis: AnalysisResult, declutter: DeclutterResult) -> None:
    """Require matching run ids and actionable item_ids in analysis order."""
    if run_id != analysis.run_id or run_id != declutter.run_id:
        raise ListingEligibilityInputError(
            "run_id must match both analysis.run_id and declutter.run_id"
        )

    actionable_ids = [item.item_id for item in analysis.items if item.item_role == "actionable"]
    if declutter.expected_item_ids != actionable_ids:
        raise ListingEligibilityInputError(
            "declutter.expected_item_ids must exactly equal the actionable analysis item_ids, in "
            "analysis order — analysis and declutter must be a matched pair from the same run"
        )


def derive_listing_eligibility(
    run_id: str,
    analysis: AnalysisResult,
    declutter: DeclutterResult,
    overrides: list[DecisionOverride] | None = None,
) -> ListingEligibilityResult:
    """Derive every confirmed, non-excluded Sell item on the server.

    The deterministic confirmation is replayed and joined to analysis only by
    item_id. An empty eligible set is valid and makes no model call.
    """
    _check_matched_pair(run_id, analysis, declutter)

    confirmation = confirm_declutter_result(declutter, overrides)

    items_by_id: dict[str, DetectedItem] = {item.item_id: item for item in analysis.items}
    eligible_items: list[DetectedItem] = []
    for confirmed in confirmation.confirmed_decisions:
        if confirmed.confirmed_decision != Decision.SELL or confirmed.excluded:
            continue
        item = items_by_id.get(confirmed.item_id)
        if item is None:
            raise ListingEligibilityInputError(
                f"confirmed Sell item {confirmed.item_id!r} has no matching analysis item — "
                "analysis and declutter are not a consistent pair"
            )
        eligible_items.append(item)

    return ListingEligibilityResult(
        run_id=run_id,
        confirmation=confirmation,
        eligible_items=eligible_items,
        eligible_item_ids=[item.item_id for item in eligible_items],
    )


# ===========================================================================
# Batch generation — bounded, model-backed listing drafts
# ===========================================================================


class LLMListingResultLike(Protocol):
    """A listing result whose content and provenance are validated here."""

    raw_text: str
    parsed_json: object
    is_valid_json: bool
    was_repaired: object
    model_name: object
    prompt_version: object


class LLMListingGenerator(Protocol):
    """Injected one-item listing generator."""

    def __call__(
        self,
        item_label: str,
        model_name: str | None = None,
        listing_name: str | None = None,
        condition: str = "not_specified",
    ) -> LLMListingResultLike: ...


class ListingGenerationResult(BaseModel):
    """One draft per eligible item with validated model provenance."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    run_id: NonEmptyStr
    confirmation: ConfirmationResult
    drafts: list[ListingDraft]
    model_name: str | None
    prompt_version: str | None
    # Do not coerce booleans, floats, or numeric strings into an attempt budget.
    max_attempts: StrictInt | None

    @model_validator(mode="after")
    def _check_internal_consistency(self) -> "ListingGenerationResult":
        if self.run_id != self.confirmation.run_id:
            raise ValueError("run_id must match confirmation.run_id")

        draft_ids = [d.item_id for d in self.drafts]
        if len(draft_ids) != len(set(draft_ids)):
            raise ValueError("drafts contains duplicate item_ids")

        expected_ids = [
            c.item_id
            for c in self.confirmation.confirmed_decisions
            if c.confirmed_decision == Decision.SELL and not c.excluded
        ]
        if draft_ids != expected_ids:
            raise ValueError(
                "drafts must contain exactly one entry per confirmed non-excluded Sell item, "
                "in confirmation order"
            )

        if self.drafts:
            if not (self.model_name and self.model_name.strip()):
                raise ValueError("non-empty drafts require a non-blank model_name")
            if not (self.prompt_version and self.prompt_version.strip()):
                raise ValueError("non-empty drafts require a non-blank prompt_version")
            if self.max_attempts is None:
                raise ValueError("non-empty drafts require a recorded max_attempts")
            if not (1 <= self.max_attempts <= LISTING_MAX_ATTEMPTS_CEILING):
                raise ValueError(
                    f"max_attempts must be between 1 and {LISTING_MAX_ATTEMPTS_CEILING} inclusive"
                )
            for draft in self.drafts:
                if draft.attempts > self.max_attempts:
                    raise ValueError(
                        f"draft {draft.item_id!r} reports {draft.attempts} attempts, "
                        f"more than the request's max_attempts={self.max_attempts}"
                    )
        else:
            if (
                self.model_name is not None
                or self.prompt_version is not None
                or self.max_attempts is not None
            ):
                raise ValueError(
                    "empty drafts must carry no model provenance and no max_attempts — "
                    "zero eligible items means zero model calls"
                )
        return self


def _validated_draft_content(result: LLMListingResultLike) -> ListingDraftContent | None:
    """Return strict draft content, or None for unusable model output."""
    if result.is_valid_json is not True:
        return None
    parsed = result.parsed_json
    if not isinstance(parsed, dict):
        return None
    try:
        return ListingDraftContent.model_validate(parsed)
    except ValueError:
        # Malformed model output is expected; unrelated programming errors propagate.
        return None


def _provenance_matches(result: LLMListingResultLike, expected_model: str) -> bool:
    """Check model, prompt, and repair provenance without coercion."""
    if not isinstance(result.was_repaired, bool):
        return False
    if not isinstance(result.model_name, str) or result.model_name != expected_model:
        return False
    if not isinstance(result.prompt_version, str) or result.prompt_version != LISTING_PROMPT_VERSION:
        return False
    return True


def _generate_one_draft(
    item: DetectedItem,
    listing_generator: LLMListingGenerator,
    resolved_model: str,
    max_attempts: int,
    details: ListingItemDetails | None = None,
) -> ListingDraft:
    """Generate one bounded draft using trusted item identity and label.

    Known failures are retried then sanitised; unexpected errors propagate.
    """
    last_reason: ListingUnavailableReason = "generation_failed"
    attempts = 0

    for _ in range(max_attempts):
        attempts += 1
        try:
            result = listing_generator(
                item_label=item.effective_label,
                model_name=resolved_model,
                listing_name=details.listing_name if details is not None else None,
                condition=details.condition if details is not None else "not_specified",
            )
        except ListingModelTimeoutError:
            last_reason = "timeout"
            continue
        except ListingModelUnavailableError:
            last_reason = "service_unavailable"
            continue
        except ListingModelError:
            # The typed model-error family is an expected call outcome.
            last_reason = "generation_failed"
            continue

        content = _validated_draft_content(result)
        if content is None:
            last_reason = "invalid_output"
            continue
        if not _provenance_matches(result, resolved_model):
            last_reason = "invalid_output"
            continue

        return ListingDraft(
            item_id=item.item_id,
            effective_label=item.effective_label,
            status="generated",
            title=content.title,
            description=content.description,
            unavailable_reason=None,
            was_repaired=result.was_repaired,
            attempts=attempts,
        )

    return ListingDraft(
        item_id=item.item_id,
        effective_label=item.effective_label,
        status="unavailable",
        title=None,
        description=None,
        unavailable_reason=last_reason,
        was_repaired=None,
        attempts=attempts,
    )


def generate_listing_drafts(
    run_id: str,
    analysis: AnalysisResult,
    declutter: DeclutterResult,
    overrides: list[DecisionOverride] | None,
    listing_generator: LLMListingGenerator,
    model_name: str | None = None,
    listing_details: list[ListingItemDetails] | None = None,
) -> ListingGenerationResult:
    """Generate independent bounded drafts for the server-derived eligible set.

    Empty eligibility makes no model calls. ``model_name`` lets evaluation use
    the production path; normal requests use configured provenance.
    """
    eligibility = derive_listing_eligibility(run_id, analysis, declutter, overrides)
    # Validated before the zero-eligible early return, so malformed details
    # are rejected consistently whether or not anything is for sale.
    details_by_id = _index_listing_details(listing_details, declutter)

    if not eligibility.eligible_items:
        return ListingGenerationResult(
            run_id=run_id,
            confirmation=eligibility.confirmation,
            drafts=[],
            model_name=None,
            prompt_version=None,
            max_attempts=None,
        )

    settings = get_settings()
    max_attempts = settings.listing_llm_max_attempts
    resolved_model = model_name or settings.listing_llm_model_name

    drafts = [
        _generate_one_draft(item, listing_generator, resolved_model, max_attempts, details_by_id.get(item.item_id))
        for item in eligibility.eligible_items
    ]

    return ListingGenerationResult(
        run_id=run_id,
        confirmation=eligibility.confirmation,
        drafts=drafts,
        model_name=resolved_model,
        prompt_version=LISTING_PROMPT_VERSION,
        max_attempts=max_attempts,
    )


# ===========================================================================
# Single-item regeneration
# ===========================================================================


class ListingItemNotEligibleError(ValueError):
    """The requested item is outside the server-derived eligible Sell set."""


class SingleListingDraftResult(BaseModel):
    """One eligible item's draft with authoritative confirmation and provenance."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    run_id: NonEmptyStr
    confirmation: ConfirmationResult
    draft: ListingDraft
    model_name: NonEmptyStr
    prompt_version: NonEmptyStr
    max_attempts: StrictInt

    @model_validator(mode="after")
    def _check_internal_consistency(self) -> "SingleListingDraftResult":
        if self.run_id != self.confirmation.run_id:
            raise ValueError("run_id must match confirmation.run_id")

        eligible_ids = {
            c.item_id
            for c in self.confirmation.confirmed_decisions
            if c.confirmed_decision == Decision.SELL and not c.excluded
        }
        if self.draft.item_id not in eligible_ids:
            raise ValueError(
                "draft.item_id must be a confirmed non-excluded Sell item in this confirmation"
            )

        if not (1 <= self.max_attempts <= LISTING_MAX_ATTEMPTS_CEILING):
            raise ValueError(
                f"max_attempts must be between 1 and {LISTING_MAX_ATTEMPTS_CEILING} inclusive"
            )
        if self.draft.attempts > self.max_attempts:
            raise ValueError(
                f"draft reports {self.draft.attempts} attempts, more than max_attempts={self.max_attempts}"
            )
        return self


def regenerate_one_listing_draft(
    run_id: str,
    analysis: AnalysisResult,
    declutter: DeclutterResult,
    overrides: list[DecisionOverride] | None,
    item_id: str,
    listing_generator: LLMListingGenerator,
    model_name: str | None = None,
    listing_details: list[ListingItemDetails] | None = None,
) -> SingleListingDraftResult:
    """Regenerate only one server-eligible Sell item's bounded draft.

    Eligibility is re-derived before any model call. Known failures return an
    unavailable draft; unexpected errors propagate.
    """
    eligibility = derive_listing_eligibility(run_id, analysis, declutter, overrides)
    details_by_id = _index_listing_details(listing_details, declutter)

    target = next((item for item in eligibility.eligible_items if item.item_id == item_id), None)
    if target is None:
        raise ListingItemNotEligibleError(
            f"item_id {item_id!r} is not in the confirmed non-excluded Sell set for this run"
        )

    settings = get_settings()
    max_attempts = settings.listing_llm_max_attempts
    resolved_model = model_name or settings.listing_llm_model_name

    # Only the target's own details are read; details for any other item
    # are validated above but never used here.
    draft = _generate_one_draft(target, listing_generator, resolved_model, max_attempts, details_by_id.get(item_id))

    return SingleListingDraftResult(
        run_id=run_id,
        confirmation=eligibility.confirmation,
        draft=draft,
        model_name=resolved_model,
        prompt_version=LISTING_PROMPT_VERSION,
        max_attempts=max_attempts,
    )
