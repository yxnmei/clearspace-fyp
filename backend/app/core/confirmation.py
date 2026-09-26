"""
Pure logic: apply zero or more user decision-overrides to the AI's
per-item decisions and produce final ConfirmedDecision objects, plus the
confirmed Keep-item filter Reorganise/Both consume. No model calls — a
decision override (Keep -> Donate) never re-invokes the LLM; that's a
deliberate, explicit project decision, distinct from the existing
/override route's label-correction/reclassification job (see
DecisionOverride's docstring in app/core/schemas.py).
"""

from __future__ import annotations

from app.core.schemas import AiDecision, ConfirmedDecision, Decision, DecisionOverride


class ConfirmationInputError(ValueError):
    """Malformed confirmation inputs — a duplicate item_id in
    ai_decisions, a duplicate override for the same item_id, or an
    override referencing an item_id that isn't in ai_decisions. A
    ValueError subclass (not an unrelated exception type) so existing
    `except ValueError`/`pytest.raises(ValueError)` callers keep working
    unchanged; callers that need to distinguish "malformed caller input"
    from any other ValueError (e.g. a pydantic ValidationError, which is
    also a ValueError subclass) should catch this type specifically —
    see app/api/routes.py's /confirm handler."""


def confirm_decisions(
    ai_decisions: list[AiDecision],
    overrides: list[DecisionOverride] | None = None,
) -> list[ConfirmedDecision]:
    """
    Deterministic merge: every ai_decisions item becomes exactly one
    ConfirmedDecision, in the same order, with any matching override
    applied. ai_decision/ai_reason are always the AI's original values,
    preserved verbatim; confirmed_decision reflects the override (if any).
    decision_changed is not set here at all — it's a computed field on
    ConfirmedDecision itself (confirmed_decision != ai_decision), so it
    can never drift from that invariant regardless of how a
    ConfirmedDecision is constructed.

    Raises ConfirmationInputError (not a warning) on malformed *caller*
    input — a duplicate item_id in ai_decisions, a duplicate override for
    the same item_id, or an override referencing an item_id that isn't in
    ai_decisions — since these are client/programming errors, not LLM
    output ambiguity (which id_mapping.py handles separately, by warning).
    """
    overrides = overrides or []

    seen_ai_ids: set[str] = set()
    for ai in ai_decisions:
        if ai.item_id in seen_ai_ids:
            raise ConfirmationInputError(f"duplicate item_id in ai_decisions: {ai.item_id!r}")
        seen_ai_ids.add(ai.item_id)

    overrides_by_id: dict[str, DecisionOverride] = {}
    for override in overrides:
        if override.item_id in overrides_by_id:
            raise ConfirmationInputError(f"duplicate override for item_id: {override.item_id!r}")
        if override.item_id not in seen_ai_ids:
            raise ConfirmationInputError(f"override references unknown item_id: {override.item_id!r}")
        overrides_by_id[override.item_id] = override

    confirmed: list[ConfirmedDecision] = []
    for ai in ai_decisions:
        override = overrides_by_id.get(ai.item_id)
        confirmed_decision = ai.decision
        excluded = False
        user_reason = None
        if override is not None:
            if override.decision is not None:
                confirmed_decision = override.decision
            if override.excluded is not None:
                excluded = override.excluded
            user_reason = override.user_reason

        confirmed.append(
            ConfirmedDecision(
                item_id=ai.item_id,
                ai_decision=ai.decision,
                confirmed_decision=confirmed_decision,
                ai_reason=ai.reason,
                user_reason=user_reason,
                excluded=excluded,
            )
        )
    return confirmed


def confirmed_keep_ids(confirmed: list[ConfirmedDecision]) -> list[str]:
    """The item_ids Reorganise/Both should receive: confirmed Keep,
    excluding anything the user excluded during review, so overrides
    demonstrably change what reaches Reorganise.

    Returns item_id strings ONLY — never a label, never a DetectedItem.
    ConfirmedDecision (what this function reads) carries no label field
    at all, by design (see core/schemas.py). A future Reorganise/Both
    consumer that needs display text or anything else about a returned
    Keep item must explicitly re-join these ids back to the LATEST
    AnalysisResult.items by item_id (never assume any round-tripped
    DeclutterResult/ConfirmationResult carries current label text) and
    read DetectedItem.effective_label — never clean_label directly — so a
    user's label correction (DetectedItem.corrected_label, applied via
    app.services.declutter_service.reclassify_item) is honored rather
    than silently dropped. This function does not perform that join
    itself, and as of this docstring neither Reorganise nor Both exists
    yet to need it — documented here so the requirement is visible before
    that code is written, not discovered after."""
    return [c.item_id for c in confirmed if c.confirmed_decision == Decision.KEEP and not c.excluded]
