"""Confirm reviewed Declutter decisions without model calls or side effects.

Only stable item_ids are merged. The result authoritatively derives the
confirmed, non-excluded Keep ids consumed by the Both workflow.
"""

from __future__ import annotations

from pydantic import BaseModel, computed_field, model_validator

from app.core.confirmation import confirm_decisions, confirmed_keep_ids
from app.core.schemas import ConfirmedDecision, Decision, DecisionOverride, ItemId, NonEmptyStr
from app.services.declutter_service import DeclutterResult


class IncompleteDeclutterError(RuntimeError):
    """Confirmation cannot proceed while any expected item is unresolved.

    Rejecting the whole result avoids a partial Keep handoff that silently
    drops an undecided item. This outcome remains distinct from malformed
    override input.
    """


class ConfirmationResult(BaseModel):
    """Authoritative confirmed decisions and their derived Keep-item ids."""

    run_id: NonEmptyStr
    confirmed_decisions: list[ConfirmedDecision]
    confirmed_keep_ids: list[ItemId]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def decision_changed_count(self) -> int:
        return sum(1 for c in self.confirmed_decisions if c.decision_changed)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def excluded_count(self) -> int:
        return sum(1 for c in self.confirmed_decisions if c.excluded)

    @model_validator(mode="after")
    def _check_internal_consistency(self) -> "ConfirmationResult":
        """Prevents contradictory direct construction (e.g. a hand-built
        or API-payload-parsed ConfirmationResult), not just data that
        happens to come from confirm_declutter_result() — same discipline
        as DeclutterResult's own consistency validator
        (app/services/declutter_service.py)."""
        decision_ids = [c.item_id for c in self.confirmed_decisions]
        if len(decision_ids) != len(set(decision_ids)):
            raise ValueError("confirmed_decisions contains duplicate item_ids")

        if len(self.confirmed_keep_ids) != len(set(self.confirmed_keep_ids)):
            raise ValueError("confirmed_keep_ids contains duplicates")

        decision_id_set = set(decision_ids)
        for keep_id in self.confirmed_keep_ids:
            if keep_id not in decision_id_set:
                raise ValueError(f"confirmed_keep_id {keep_id!r} does not belong to confirmed_decisions")

        expected_keep_ids = [
            c.item_id for c in self.confirmed_decisions if c.confirmed_decision == Decision.KEEP and not c.excluded
        ]
        if self.confirmed_keep_ids != expected_keep_ids:
            raise ValueError(
                "confirmed_keep_ids must exactly equal, in order, the confirmed_decisions item_ids "
                "whose confirmed_decision is Keep and excluded is False"
            )

        return self


def confirm_declutter_result(
    declutter: DeclutterResult,
    overrides: list[DecisionOverride] | None = None,
) -> ConfirmationResult:
    """Merge overrides and derive Keep ids from a complete DeclutterResult.

    The run_id comes from the DeclutterResult, and no partial handoff is
    returned when expected items remain unresolved.
    """
    if not declutter.is_complete:
        raise IncompleteDeclutterError(
            "cannot confirm an incomplete DeclutterResult — every expected item must be resolved "
            "(no STILL_INVALID items) before confirmation"
        )

    confirmed = confirm_decisions(declutter.ai_decisions, overrides)
    keep_ids = confirmed_keep_ids(confirmed)

    return ConfirmationResult(run_id=declutter.run_id, confirmed_decisions=confirmed, confirmed_keep_ids=keep_ids)
