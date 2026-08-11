"""
Unit tests for app/services/confirmation_service.py — pure logic, no
model calls, no file/logging side effects. Fixtures build real
DeclutterResult/ConfirmedDecision objects that satisfy their own existing
validators (never weakened for test convenience).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.confirmation import ConfirmationInputError
from app.core.schemas import AiDecision, ConfirmedDecision, Decision, DecisionOverride, ItemValidity
from app.services.confirmation_service import (
    ConfirmationResult,
    IncompleteDeclutterError,
    confirm_declutter_result,
)
from app.services.declutter_service import DeclutterResult


def _declutter_result(**overrides) -> DeclutterResult:
    base = dict(
        run_id="run1",
        expected_item_ids=[],
        ai_decisions=[],
        unresolved_item_ids=[],
        item_validity={},
        mapping_warnings=[],
        semantic_errors=[],
        recovery_failures=[],
        provenance_warnings=[],
        model_name="phi4-mini",
        prompt_version="v2",
        stage_timings=[],
    )
    base.update(overrides)
    return DeclutterResult(**base)


def _complete_declutter(items: list[tuple[str, str]], run_id: str = "run1") -> DeclutterResult:
    """items: [(item_id, decision), ...] — all resolved, RAW_VALID."""
    ai_decisions = [AiDecision(item_id=iid, decision=dec, reason=f"reason for {iid}") for iid, dec in items]
    expected_ids = [iid for iid, _ in items]
    return _declutter_result(
        run_id=run_id,
        expected_item_ids=expected_ids,
        ai_decisions=ai_decisions,
        unresolved_item_ids=[],
        item_validity={iid: ItemValidity.RAW_VALID for iid, _ in items},
    )


def _incomplete_declutter(run_id: str = "run1") -> DeclutterResult:
    return _declutter_result(
        run_id=run_id,
        expected_item_ids=["item_001"],
        ai_decisions=[],
        unresolved_item_ids=["item_001"],
        item_validity={"item_001": ItemValidity.STILL_INVALID},
    )


def _confirmed(item_id, ai_decision, confirmed_decision, user_reason=None, excluded=False) -> ConfirmedDecision:
    return ConfirmedDecision(
        item_id=item_id,
        ai_decision=ai_decision,
        confirmed_decision=confirmed_decision,
        ai_reason=f"ai reason for {item_id}",
        user_reason=user_reason,
        excluded=excluded,
    )


# ---------------------------------------------------------------------------
# confirm_declutter_result()
# ---------------------------------------------------------------------------


def test_confirmation_without_overrides_preserves_all_ai_decisions():
    declutter = _complete_declutter([("item_001", "keep"), ("item_002", "donate")])
    result = confirm_declutter_result(declutter)
    assert [c.confirmed_decision for c in result.confirmed_decisions] == [Decision.KEEP, Decision.DONATE]
    assert [c.ai_decision for c in result.confirmed_decisions] == [Decision.KEEP, Decision.DONATE]
    assert result.run_id == "run1"


def test_keep_to_donate_override_removes_item_from_keep_ids():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.DONATE)]
    result = confirm_declutter_result(declutter, overrides)
    assert result.confirmed_decisions[0].confirmed_decision == Decision.DONATE
    assert result.confirmed_keep_ids == []


def test_discard_to_keep_override_adds_item_to_keep_ids():
    declutter = _complete_declutter([("item_001", "discard")])
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.KEEP)]
    result = confirm_declutter_result(declutter, overrides)
    assert result.confirmed_keep_ids == ["item_001"]


def test_excluded_keep_is_absent_from_confirmed_keep_ids():
    declutter = _complete_declutter([("item_001", "keep"), ("item_002", "keep")])
    overrides = [DecisionOverride(item_id="item_002", excluded=True)]
    result = confirm_declutter_result(declutter, overrides)
    assert result.confirmed_keep_ids == ["item_001"]


def test_exclusion_alone_does_not_count_as_decision_changed():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [DecisionOverride(item_id="item_001", excluded=True)]
    result = confirm_declutter_result(declutter, overrides)
    assert result.confirmed_decisions[0].decision_changed is False
    assert result.confirmed_decisions[0].excluded is True
    assert result.excluded_count == 1
    assert result.decision_changed_count == 0


def test_user_reason_and_ai_reason_are_both_preserved_separately():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.SELL, user_reason="don't need it")]
    result = confirm_declutter_result(declutter, overrides)
    confirmed = result.confirmed_decisions[0]
    assert confirmed.ai_reason == "reason for item_001"
    assert confirmed.user_reason == "don't need it"


def test_distinct_item_ids_resolve_independently_regardless_of_shared_label_context():
    # Confirmation operates purely on item_id — there is no label field
    # at this layer at all (AiDecision/ConfirmedDecision never carry
    # one) — two distinct expected items with independent overrides must
    # never interfere with each other.
    declutter = _complete_declutter([("item_004", "keep"), ("item_006", "keep")])
    overrides = [DecisionOverride(item_id="item_004", decision=Decision.DISCARD)]
    result = confirm_declutter_result(declutter, overrides)
    by_id = {c.item_id: c for c in result.confirmed_decisions}
    assert by_id["item_004"].confirmed_decision == Decision.DISCARD
    assert by_id["item_006"].confirmed_decision == Decision.KEEP
    assert result.confirmed_keep_ids == ["item_006"]


def test_input_decision_order_is_preserved():
    declutter = _complete_declutter([("item_003", "keep"), ("item_001", "donate"), ("item_002", "discard")])
    result = confirm_declutter_result(declutter)
    assert [c.item_id for c in result.confirmed_decisions] == ["item_003", "item_001", "item_002"]


def test_empty_complete_declutter_result_returns_an_empty_valid_result():
    declutter = _complete_declutter([])
    result = confirm_declutter_result(declutter)
    assert result.confirmed_decisions == []
    assert result.confirmed_keep_ids == []
    assert result.decision_changed_count == 0
    assert result.excluded_count == 0


def test_incomplete_declutter_result_raises_incomplete_declutter_error():
    declutter = _incomplete_declutter()
    with pytest.raises(IncompleteDeclutterError):
        confirm_declutter_result(declutter)


def test_duplicate_overrides_are_rejected():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [
        DecisionOverride(item_id="item_001", decision=Decision.DONATE),
        DecisionOverride(item_id="item_001", excluded=True),
    ]
    with pytest.raises(ConfirmationInputError):
        confirm_declutter_result(declutter, overrides)


def test_unknown_override_item_id_is_rejected():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [DecisionOverride(item_id="item_999", decision=Decision.DISCARD)]
    with pytest.raises(ConfirmationInputError):
        confirm_declutter_result(declutter, overrides)


# ---------------------------------------------------------------------------
# ConfirmationResult's own internal-consistency validator
# ---------------------------------------------------------------------------


def test_confirmation_result_rejects_duplicate_confirmed_decision_ids():
    with pytest.raises(ValidationError):
        ConfirmationResult(
            run_id="run1",
            confirmed_decisions=[
                _confirmed("item_001", Decision.KEEP, Decision.KEEP),
                _confirmed("item_001", Decision.DONATE, Decision.DONATE),
            ],
            confirmed_keep_ids=["item_001"],
        )


def test_confirmation_result_rejects_duplicate_keep_ids():
    with pytest.raises(ValidationError):
        ConfirmationResult(
            run_id="run1",
            confirmed_decisions=[_confirmed("item_001", Decision.KEEP, Decision.KEEP)],
            confirmed_keep_ids=["item_001", "item_001"],
        )


def test_confirmation_result_rejects_a_keep_set_that_differs_from_confirmed_decisions():
    with pytest.raises(ValidationError):
        ConfirmationResult(
            run_id="run1",
            confirmed_decisions=[_confirmed("item_001", Decision.KEEP, Decision.DONATE)],  # not Keep
            confirmed_keep_ids=["item_001"],  # falsely claims item_001 is a confirmed Keep
        )


def test_decision_changed_count_is_computed_correctly():
    result = ConfirmationResult(
        run_id="run1",
        confirmed_decisions=[
            _confirmed("item_001", Decision.KEEP, Decision.DONATE),  # changed
            _confirmed("item_002", Decision.KEEP, Decision.KEEP),  # unchanged
            _confirmed("item_003", Decision.DISCARD, Decision.KEEP),  # changed
        ],
        confirmed_keep_ids=["item_002", "item_003"],
    )
    assert result.decision_changed_count == 2


def test_excluded_count_is_computed_correctly():
    result = ConfirmationResult(
        run_id="run1",
        confirmed_decisions=[
            _confirmed("item_001", Decision.KEEP, Decision.KEEP, excluded=True),
            _confirmed("item_002", Decision.KEEP, Decision.KEEP, excluded=False),
            _confirmed("item_003", Decision.DONATE, Decision.DONATE, excluded=True),
        ],
        confirmed_keep_ids=["item_002"],
    )
    assert result.excluded_count == 2


def test_caller_supplied_computed_counts_cannot_override_the_real_values():
    result = ConfirmationResult(
        run_id="run1",
        confirmed_decisions=[_confirmed("item_001", Decision.KEEP, Decision.DONATE)],  # a real change
        confirmed_keep_ids=[],
        decision_changed_count=999,  # wrong on purpose — must be ignored, it's a computed field
        excluded_count=999,
    )
    assert result.decision_changed_count == 1
    assert result.excluded_count == 0
