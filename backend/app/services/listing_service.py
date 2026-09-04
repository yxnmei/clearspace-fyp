"""
Marketplace listing drafts — server-side eligibility (Phase 1) and
bounded, model-backed draft generation (Phase 2).

Given an already-committed AnalysisResult, its matching DeclutterResult,
and zero or more user DecisionOverrides:

  derive_listing_eligibility(...)  -> which detected items may be listed
  generate_listing_drafts(...)     -> a title/description draft per
                                      eligible item, via an injected
                                      listing-LLM callable

Eligibility is exactly:

    confirmed_decision == Decision.SELL  and  excluded is False

and it is derived ENTIRELY server-side. The caller never supplies a Sell
id list, an eligible id list, or a ConfirmationResult — the authoritative
decision state comes only from replaying the deterministic confirmation
over (declutter, overrides) via
app.services.confirmation_service.confirm_declutter_result(). This mirrors
the Both workflow's rule that only server-derived, confirmed,
non-excluded Keep items reach Reorganise (see app/services/both_service.py)
— here the same discipline is applied to confirmed, non-excluded Sell
items instead.

Signed source/confirmation proof is DEFERRED for this FYP phase — no
signatures, no persistence, no database, no authentication. Recomputing
the confirmation here validates that the supplied analysis/declutter/
overrides are internally consistent, but it cannot cryptographically
prevent a client from fabricating an entire self-consistent source
payload (a matching analysis + declutter + overrides that were never
produced by a real run). Detecting that would need signed provenance on
the /upload response, which is out of scope here.

Model boundary: generation takes an INJECTED callable (LLMListingGenerator
Protocol) — real wiring passes app.models.listing_llm.generate_listing_draft_once
(resolved lazily by the POST /listings route), tests pass a fake. This
module imports only the typed error classes and the prompt-version
constant from app.models.listing_llm; that import does not pull in
`ollama` (see that module's docstring), so importing app.services.listing_service
stays free of the model stack.

Identity discipline: item_id is the only identity anywhere here. The
model is asked for `title` and `description` ONLY; application code
attaches the trusted item_id and effective_label from the eligibility
join and never reads an identity field from model output.

Generation failure for one item is contained: it becomes an "unavailable"
draft for that item with a sanitised reason, never blocks the others,
never fabricates a deterministic "successful" fallback, and never
invalidates the confirmation or affects Declutter / Both / Reorganise.
Expected model and validation failures are turned into sanitised
unavailable outcomes; an unexpected programming error is NOT swallowed.
"""

from __future__ import annotations

from typing import Protocol

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
    """Malformed caller input to derive_listing_eligibility() itself — a
    run_id that doesn't match analysis.run_id/declutter.run_id, a
    declutter.expected_item_ids that doesn't exactly equal (in analysis
    order) the actionable analysis item_ids, or a confirmed Sell item
    with no matching analysis item to join it to.

    Deliberately its own type, kept distinct from BOTH
    app.services.confirmation_service.IncompleteDeclutterError (a
    RuntimeError subclass, raised for an unresolved DeclutterResult) and
    app.core.confirmation.ConfirmationInputError (a ValueError subclass,
    raised for malformed override input). It is not a subclass of either,
    so `except IncompleteDeclutterError` and `except ConfirmationInputError`
    can never accidentally swallow an analysis/Declutter/run mismatch, and
    a future route can map this one to its own status code independently.
    It IS a ValueError subclass, matching this codebase's
    BothPipelineInputError / ReorganisePipelineInputError convention, so a
    caller that only wants "some malformed input" can still catch
    ValueError.

    Raised BEFORE any eligible set is derived. Never raised for an
    OUTCOME of otherwise-valid input — zero eligible Sell items is a
    valid, empty result, not an error."""


class ListingEligibilityResult(BaseModel):
    """The output of derive_listing_eligibility() — the frozen,
    self-validating record of which items may receive a marketplace
    listing draft, plus the authoritative confirmation it was derived
    from. Same discipline as BothGenerationResult / ReorganisePipelineResult:
    contradictory direct construction (a hand-built or API-parsed object)
    is rejected by the validator below, not merely avoided by the one
    function that builds it.

    run_id: the single run these results belong to.
    confirmation: the authoritative ConfirmationResult recomputed here
      from (declutter, overrides) — never accepted from a caller.
    eligible_items: the existing, already-validated DetectedItem objects
      for every confirmed, non-excluded Sell item, in confirmation order
      (which is analysis order). Not a new listing-specific item schema —
      no label/box/metadata is copied out.
    eligible_item_ids: the item_ids of eligible_items, in the same order.
    """

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

        # The eligible set must be COMPLETE, not merely a valid subset:
        # every confirmed, non-excluded Sell item has to appear, in
        # confirmation order. This closes the gap where a hand-built or
        # API-parsed result could silently omit an eligible Sell item
        # (or reorder them) and still pass every per-item check above.
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


def _check_matched_pair(run_id: str, analysis: AnalysisResult, declutter: DeclutterResult) -> None:
    """The same matched-pair rule app/services/both_service.py enforces
    at its own boundary — re-verified here (not imported), so this
    function stays safe to call directly with no HTTP-layer schema
    validation having run.

    run_id / analysis.run_id / declutter.run_id must all be identical, and
    declutter.expected_item_ids must exactly equal, in analysis order, the
    actionable analysis item_ids. Contextual analysis items are excluded
    from that comparison, so a room with contextual items still validates.
    An out-of-order expected_item_ids fails the ordered list comparison."""
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
    """
    Steps, in order:

      1. Validate run_id/analysis/declutter as a genuine matched pair
         (ListingEligibilityInputError) — see _check_matched_pair.
      2. Replay the deterministic confirmation via
         confirm_declutter_result(declutter, overrides). This raises
         IncompleteDeclutterError for an unresolved DeclutterResult and
         ConfirmationInputError for duplicate/unknown override ids —
         both propagated unchanged; no confirmation-merge logic is
         reimplemented here.
      3. Select every confirmed_decision whose confirmed_decision is
         Decision.SELL and whose excluded is False, and join each to its
         analysis DetectedItem strictly by item_id, in confirmation
         order (which preserves analysis order). A Sell id with no
         matching analysis item raises ListingEligibilityInputError
         rather than being silently dropped.

    Zero eligible Sell items returns a valid ListingEligibilityResult
    with empty eligible_items / eligible_item_ids. No model callable is
    resolved or invoked on any path.
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
# Phase 2 — bounded, model-backed listing-draft generation
# ===========================================================================


class LLMListingResultLike(Protocol):
    """Structural type for one listing-model call's result — real
    app.models.listing_llm.ListingLLMResult already satisfies it, so no
    adapter is needed and tests can pass a plain stand-in.

    model_name / prompt_version / was_repaired are NOT decorative: the
    service validates each successful result's model_name against the
    model it resolved and asked for, its prompt_version against
    LISTING_PROMPT_VERSION, and requires was_repaired to be a genuine
    bool — a result whose provenance disagrees never becomes a generated
    draft with misleading metadata."""

    raw_text: str
    parsed_json: object
    is_valid_json: bool
    was_repaired: object
    model_name: object
    prompt_version: object


class LLMListingGenerator(Protocol):
    """The injected listing-model callable: one eligible item's label in,
    one LLMListingResultLike out (or one of app.models.listing_llm's typed
    errors raised). Matches generate_listing_draft_once's signature
    exactly, so production wiring passes that function in directly. The
    service always passes an explicit, already-resolved `model_name`."""

    def __call__(self, item_label: str, model_name: str | None = None) -> LLMListingResultLike: ...


class ListingGenerationResult(BaseModel):
    """The output of generate_listing_drafts() — frozen and
    self-validating, same discipline as ListingEligibilityResult /
    BothGenerationResult.

    run_id: the single run these drafts belong to.
    confirmation: the authoritative server-derived ConfirmationResult
      (never client-supplied) the eligible set was computed from.
    drafts: exactly one ListingDraft per confirmed non-excluded Sell
      item, in confirmation order — generated or unavailable, never
      omitted.
    model_name / prompt_version: the listing model and prompt version the
      drafts were attempted with, authoritative (every generated draft
      was validated to have reported exactly these). ALL THREE of
      model_name / prompt_version / max_attempts are None exactly when
      drafts is empty (zero eligible items => zero model calls), and all
      three are set otherwise.
    max_attempts: the configured per-item attempt budget this request
      ran under. Every draft's own `attempts` is validated to be <= this.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    run_id: NonEmptyStr
    confirmation: ConfirmationResult
    drafts: list[ListingDraft]
    model_name: str | None
    prompt_version: str | None
    # StrictInt: a bool / float / numeric-string budget is a construction
    # mistake, not something to coerce. The 1..CEILING range is checked
    # in the validator below (only when present).
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
    """Turn one raw model result into a strict ListingDraftContent, or
    None if it is unusable. `None` covers: is_valid_json that is not the
    genuine boolean True (a truthy string or int is NOT accepted), a
    parsed value that is not a single JSON object, missing/blank/
    oversized/wrongly-typed `title`/`description`, or ANY extra field
    (including an identity field the model must never supply). Never
    raises for bad model output."""
    if result.is_valid_json is not True:
        return None
    parsed = result.parsed_json
    if not isinstance(parsed, dict):
        return None
    try:
        return ListingDraftContent.model_validate(parsed)
    except ValueError:
        # pydantic ValidationError is a ValueError subclass; a malformed
        # object is an expected outcome here, not a programming error.
        return None


def _provenance_matches(result: LLMListingResultLike, expected_model: str) -> bool:
    """True only if the result's own provenance is trustworthy: model_name
    exactly the model the service resolved and asked for, prompt_version
    exactly LISTING_PROMPT_VERSION, and was_repaired a genuine bool. A
    mismatched, blank, or wrongly-typed identity fails here so the item
    ends `unavailable` rather than a generated draft carrying provenance
    that never actually applied."""
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
) -> ListingDraft:
    """Generate one eligible item's draft, with up to `max_attempts`
    sequential model calls. Every EXPECTED failure — a typed
    transport/model error, output that fails strict validation, or a
    result whose provenance does not match the resolved model / prompt
    version — is retried until the budget is spent, then becomes an
    "unavailable" draft with the last sanitised reason. item_id and
    effective_label are always the trusted values from `item`, never
    anything the model returned.

    Only the single listing_generator(...) call is inside try/except, and
    only the KNOWN typed model errors are caught — an unexpected
    exception type (a real programming defect) propagates."""
    last_reason: ListingUnavailableReason = "generation_failed"
    attempts = 0

    for _ in range(max_attempts):
        attempts += 1
        try:
            result = listing_generator(item_label=item.effective_label, model_name=resolved_model)
        except ListingModelTimeoutError:
            last_reason = "timeout"
            continue
        except ListingModelUnavailableError:
            last_reason = "service_unavailable"
            continue
        except ListingModelError:
            # Base class — covers ListingModelResponseError and any other
            # subclass. Still an EXPECTED model-call outcome.
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
) -> ListingGenerationResult:
    """
    Full listing-generation stage on top of derive_listing_eligibility().

      1. derive_listing_eligibility(run_id, analysis, declutter, overrides)
         — reused verbatim; every one of its errors propagates unchanged
         (ListingEligibilityInputError for run/pair mismatch,
         IncompleteDeclutterError for an unresolved DeclutterResult,
         ConfirmationInputError for duplicate/unknown overrides). No
         confirmation or eligibility logic is reimplemented here.
      2. Zero eligible items -> return immediately with drafts=[] and no
         model provenance / max_attempts. `listing_generator` is never
         called.
      3. Otherwise resolve the listing model ONCE
         (model_name or settings.listing_llm_model_name), pass that
         explicit name to every generator call, and generate one draft
         per eligible item, IN ORDER, sequentially and independently. A
         failure for one item never blocks another. No deterministic
         "successful" fallback is ever synthesised — a failed item is
         honestly `unavailable`.

    `model_name` is accepted only for evaluation-script parity (sweeping
    candidate models through one code path); the POST /listings route
    never supplies it. `run_id` is the top-level id; it is checked
    against analysis/declutter inside derive_listing_eligibility().
    """
    eligibility = derive_listing_eligibility(run_id, analysis, declutter, overrides)

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
        _generate_one_draft(item, listing_generator, resolved_model, max_attempts)
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
# Phase 3 — true single-item regeneration
# ===========================================================================


class ListingItemNotEligibleError(ValueError):
    """The target item_id handed to regenerate_one_listing_draft() is not
    a member of the complete, server-derived eligible Sell set for this
    (run_id, analysis, declutter, overrides): it is unknown, a
    Keep/Donate/Discard item, an excluded item, malformed, or a stale id
    from a different run.

    Raised BEFORE any model call. A ValueError subclass (this codebase's
    malformed-input convention), deliberately DISTINCT from
    ListingEligibilityInputError — that means the analysis/declutter/run
    bundle itself is inconsistent; this means the bundle is fine but the
    caller asked to regenerate something that is not a listing-eligible
    Sell item. Neither is a subclass of the other, so a route maps them
    to their own responses with no clause-order hazard."""


class SingleListingDraftResult(BaseModel):
    """The output of regenerate_one_listing_draft() — exactly ONE
    ListingDraft for one confirmed non-excluded Sell item, plus the same
    authoritative run / confirmation / model / prompt / attempt
    provenance a full ListingGenerationResult carries. Frozen,
    extra="forbid", self-validating against contradictory direct
    construction.

    There is no empty case: a single-item regeneration always targets one
    eligible item and always makes at least one model call, so
    model_name / prompt_version / max_attempts are always present (a
    fully-unavailable draft still records the model and budget it was
    attempted with)."""

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
) -> SingleListingDraftResult:
    """
    Regenerate the listing draft for EXACTLY ONE eligible Sell item,
    without generating or touching any other item's draft.

      1. derive_listing_eligibility(run_id, analysis, declutter, overrides)
         — reused verbatim; its errors propagate unchanged
         (ListingEligibilityInputError / IncompleteDeclutterError /
         ConfirmationInputError). No eligibility or confirmation logic is
         reimplemented here.
      2. `item_id` must be a member of the complete server-derived
         eligible Sell set, else ListingItemNotEligibleError — raised
         BEFORE the generator is invoked. An unknown, non-Sell, excluded,
         malformed, or stale id never reaches a model call, and no other
         eligible item is ever generated.
      3. Exactly ONE eligible item — the target — is passed to
         _generate_one_draft() with the same bounded retry behaviour the
         batch path uses.

    An expected model failure yields that one draft as `unavailable`; an
    unexpected exception type propagates (through _generate_one_draft).
    The result carries the authoritative confirmation, run id, resolved
    model, prompt version and attempt budget. POST /listings and
    generate_listing_drafts() are untouched.
    """
    eligibility = derive_listing_eligibility(run_id, analysis, declutter, overrides)

    target = next((item for item in eligibility.eligible_items if item.item_id == item_id), None)
    if target is None:
        raise ListingItemNotEligibleError(
            f"item_id {item_id!r} is not in the confirmed non-excluded Sell set for this run"
        )

    settings = get_settings()
    max_attempts = settings.listing_llm_max_attempts
    resolved_model = model_name or settings.listing_llm_model_name

    draft = _generate_one_draft(target, listing_generator, resolved_model, max_attempts)

    return SingleListingDraftResult(
        run_id=run_id,
        confirmation=eligibility.confirmation,
        draft=draft,
        model_name=resolved_model,
        prompt_version=LISTING_PROMPT_VERSION,
        max_attempts=max_attempts,
    )
