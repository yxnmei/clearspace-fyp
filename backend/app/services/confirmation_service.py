"""
Orchestration for the human-confirmation boundary: takes an already-
validated, complete DeclutterResult plus zero or more user
DecisionOverrides, and produces the authoritative ConfirmationResult —
including the confirmed Keep-item IDs the future Both/Reorganise path
consumes (PROJECT_SPEC's Both-workflow requirement: only confirmed,
non-excluded Keep items reach it).

Wraps app.core.confirmation.confirm_decisions()/confirmed_keep_ids()
directly — no merge/filter logic is duplicated here or in the API route
(app/api/routes.py); this module's only real job is the DeclutterResult-
level policy decision below (IncompleteDeclutterError) and packaging the
result into one validated response object.

No model call, no file/logging side effect — this is pure, deterministic
merge logic over data already in hand, exactly like core/confirmation.py
itself. Item IDs only, never labels, anywhere in this module.
"""

from __future__ import annotations

from pydantic import BaseModel, computed_field, model_validator

from app.core.confirmation import confirm_decisions, confirmed_keep_ids
from app.core.schemas import ConfirmedDecision, Decision, DecisionOverride, ItemId, NonEmptyStr
from app.services.declutter_service import DeclutterResult


class IncompleteDeclutterError(RuntimeError):
    """Raised when confirmation is attempted for a DeclutterResult whose
    is_complete is False — i.e. it still has one or more STILL_INVALID
    unresolved items.

    Deliberate current limitation, not an oversight: ConfirmedDecision
    requires a real ai_decision/ai_reason (see app/core/schemas.py's
    ConfirmedDecision — both fields are non-optional). There is no AI
    decision for a STILL_INVALID item, so it cannot be wrapped into a
    ConfirmedDecision without either fabricating one (unacceptable) or
    redesigning ConfirmedDecision to make ai_decision/ai_reason optional
    (out of scope for this task — a deliberate future extension point,
    not casually done here). Rejecting the whole confirmation request
    outright — rather than silently omitting the unresolved item and
    producing a partial Keep handoff — is the safer, honest choice: a
    partial handoff could look complete to Reorganise/Both, silently
    dropping an item the user never actually got to decide about.

    Deliberately NOT a ValueError subclass: core/confirmation.py's own
    confirm_decisions() raises ConfirmationInputError (a ValueError
    subclass) for a different class of problem (malformed *override*
    input — duplicate/unknown item_ids). Keeping these two exception
    hierarchies unrelated means app/api/routes.py's
    except-IncompleteDeclutterError (-> 409) and
    except-ConfirmationInputError (-> 422) branches can never collide
    regardless of clause order, and neither one accidentally swallows an
    unrelated ValueError/ValidationError (e.g. a genuine
    ConfirmationResult construction bug) that must surface as a 500
    instead — matching this codebase's existing typed-error convention
    (see e.g. DeclutterReasoningError in declutter_service.py, also a
    RuntimeError subclass, not a ValueError one)."""


class ConfirmationResult(BaseModel):
    """The output of confirm_declutter_result() — the authoritative
    record of what the user confirmed, plus the confirmed Keep-item IDs
    Reorganise/Both will consume.

    decision_changed_count / excluded_count are always recomputed from
    confirmed_decisions, never accepted as caller input — same principle
    as ConfirmedDecision.decision_changed itself (app/core/schemas.py): a
    summary count must never be able to disagree with the data it
    summarizes."""

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
    """
    Raises IncompleteDeclutterError if declutter.is_complete is False —
    see that exception's own docstring; no partial Keep handoff is ever
    produced. Otherwise a thin, deterministic wrapper: confirm_decisions()
    does the actual override-merge (raising ConfirmationInputError, a
    ValueError subclass, on malformed *caller* input — duplicate/unknown
    override item_ids — which app/api/routes.py maps to a 422, distinct
    from this function's own 409), confirmed_keep_ids() derives the Keep
    set from that same merged
    list, and both are packaged into one validated ConfirmationResult.

    run_id is taken from declutter.run_id, never accepted as a separate
    parameter — a caller cannot construct a result whose run_id disagrees
    with the DeclutterResult it was confirmed from.

    No model call, no file/logging side effect, input decision order
    preserved (confirm_decisions() itself already guarantees this). An
    empty-but-complete DeclutterResult (zero expected items) returns an
    empty, valid ConfirmationResult.
    """
    if not declutter.is_complete:
        raise IncompleteDeclutterError(
            "cannot confirm an incomplete DeclutterResult — every expected item must be resolved "
            "(no STILL_INVALID items) before confirmation"
        )

    confirmed = confirm_decisions(declutter.ai_decisions, overrides)
    keep_ids = confirmed_keep_ids(confirmed)

    return ConfirmationResult(run_id=declutter.run_id, confirmed_decisions=confirmed, confirmed_keep_ids=keep_ids)
