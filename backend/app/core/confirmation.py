"""
Apply user decision overrides to the AI's per-item decisions, and derive
the confirmed Keep ids Reorganise/Both consume. A decision override never
re-invokes the LLM; only a label correction (/override) does.
"""

from __future__ import annotations

from app.core.schemas import AiDecision, ConfirmedDecision, Decision, DecisionOverride


class ConfirmationInputError(ValueError):
    """Malformed confirmation input: duplicate ai_decisions ids, duplicate
    overrides, or an override for an unknown item_id. A ValueError
    subclass; catch this type specifically to tell caller error apart
    from a pydantic ValidationError."""


def confirm_decisions(
    ai_decisions: list[AiDecision],
    overrides: list[DecisionOverride] | None = None,
) -> list[ConfirmedDecision]:
    """
    One ConfirmedDecision per AI decision, in order, with any matching
    override applied; the AI's original decision and reason are kept
    verbatim. Malformed input raises ConfirmationInputError rather than
    warning, because it is a caller error, not LLM output ambiguity.
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
    """Confirmed, non-excluded Keep item_ids. Derived server-side from
    the confirmed decisions, never accepted from the client.

    Returns ids only. A consumer needing display text must re-join to the
    latest AnalysisResult.items by item_id and read effective_label, so a
    user's label correction is honoured."""
    return [c.item_id for c in confirmed if c.confirmed_decision == Decision.KEEP and not c.excluded]
