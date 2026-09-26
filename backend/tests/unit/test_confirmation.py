"""
Unit tests for app/core/confirmation.py — pure logic, no model calls. A
decision override never re-invokes the LLM; confirm_decisions() only
merges data it's already given. Covers the ai_decision/confirmed_decision
split, the exact decision_changed semantics, exclusion tracking kept
separate from decision_changed, and Keep-filtering.
"""

import pytest

from app.core.confirmation import ConfirmationInputError, confirm_decisions, confirmed_keep_ids
from app.core.schemas import AiDecision, ConfirmedDecision, Decision, DecisionOverride


def _ai(item_id, decision, reason=None):
    return AiDecision(item_id=item_id, decision=decision, reason=reason or f"ai reason for {item_id}")


def test_confirmation_without_any_override_preserves_ai_decision():
    ai_decisions = [_ai("item_001", "keep"), _ai("item_002", "donate")]
    confirmed = confirm_decisions(ai_decisions)
    assert [c.confirmed_decision for c in confirmed] == [Decision.KEEP, Decision.DONATE]
    assert [c.ai_decision for c in confirmed] == [Decision.KEEP, Decision.DONATE]
    assert all(not c.decision_changed for c in confirmed)
    assert all(not c.excluded for c in confirmed)
    assert all(c.user_reason is None for c in confirmed)


def test_original_ai_decision_is_retained_after_an_override():
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.DONATE)]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed[0].ai_decision == Decision.KEEP  # never overwritten
    assert confirmed[0].confirmed_decision == Decision.DONATE
    assert confirmed[0].ai_reason == "ai reason for item_001"  # AI's reason preserved, not relabelled


def test_decision_changed_true_only_for_a_real_decision_change():
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.DONATE)]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed[0].decision_changed is True


def test_identical_decision_override_is_not_counted_as_changed():
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.KEEP)]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed[0].decision_changed is False


def test_excluded_false_is_not_counted_as_a_decision_change():
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [DecisionOverride(item_id="item_001", excluded=False)]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed[0].decision_changed is False
    assert confirmed[0].excluded is False


def test_exclusion_override_does_not_change_decision_value():
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [DecisionOverride(item_id="item_001", excluded=True)]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed[0].confirmed_decision == Decision.KEEP
    assert confirmed[0].excluded is True
    assert confirmed[0].decision_changed is False


def test_confirmed_keep_filtering_excludes_non_keep_decisions():
    ai_decisions = [_ai("item_001", "keep"), _ai("item_002", "donate"), _ai("item_003", "keep")]
    confirmed = confirm_decisions(ai_decisions)
    assert confirmed_keep_ids(confirmed) == ["item_001", "item_003"]


def test_excluded_keep_item_does_not_enter_confirmed_keep_filtering():
    ai_decisions = [_ai("item_001", "keep"), _ai("item_002", "keep")]
    overrides = [DecisionOverride(item_id="item_002", excluded=True)]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed_keep_ids(confirmed) == ["item_001"]


def test_duplicate_ai_decision_ids_are_rejected():
    ai_decisions = [_ai("item_001", "keep"), _ai("item_001", "donate")]
    with pytest.raises(ConfirmationInputError):
        confirm_decisions(ai_decisions)


def test_duplicate_override_ids_are_rejected():
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [
        DecisionOverride(item_id="item_001", decision=Decision.DONATE),
        DecisionOverride(item_id="item_001", excluded=True),
    ]
    with pytest.raises(ConfirmationInputError):
        confirm_decisions(ai_decisions, overrides)


def test_override_referencing_unknown_item_id_raises():
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [DecisionOverride(item_id="item_999", decision=Decision.DISCARD)]
    with pytest.raises(ConfirmationInputError):
        confirm_decisions(ai_decisions, overrides)


def test_confirmation_input_error_is_a_value_error_subclass():
    # Backward compatibility: any existing `except ValueError`/
    # `pytest.raises(ValueError)` caller must keep working unchanged.
    assert issubclass(ConfirmationInputError, ValueError)


def test_keep_to_discard_override_removes_item_from_downstream_keep_set():
    # Both-handoff rule: an AI Keep overridden to Discard must not reach
    # Reorganise.
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.DISCARD)]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed_keep_ids(confirmed) == []


def test_non_keep_to_keep_override_adds_item_to_downstream_keep_set():
    ai_decisions = [_ai("item_001", "discard")]
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.KEEP)]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed_keep_ids(confirmed) == ["item_001"]


def test_decision_changed_is_computed_not_caller_supplied():
    # decision_changed must be correct on a *directly constructed*
    # ConfirmedDecision (e.g. parsed straight from an API payload, not
    # produced via confirm_decisions()) — it's derived, not an input.
    keep_to_discard = ConfirmedDecision(
        item_id="item_001",
        ai_decision=Decision.KEEP,
        confirmed_decision=Decision.DISCARD,
        ai_reason="x",
    )
    assert keep_to_discard.decision_changed is True

    unchanged = ConfirmedDecision(
        item_id="item_001",
        ai_decision=Decision.KEEP,
        confirmed_decision=Decision.KEEP,
        ai_reason="x",
    )
    assert unchanged.decision_changed is False


def test_decision_changed_cannot_be_overridden_by_a_caller_supplied_value():
    # Even a deliberate wrong value passed at construction time has no
    # effect — decision_changed is a computed field, not settable.
    confirmed = ConfirmedDecision(
        item_id="item_001",
        ai_decision=Decision.KEEP,
        confirmed_decision=Decision.KEEP,
        ai_reason="x",
        decision_changed=True,  # wrong on purpose
    )
    assert confirmed.decision_changed is False


def test_user_reason_is_optional_and_preserved_when_given():
    ai_decisions = [_ai("item_001", "keep")]
    overrides = [
        DecisionOverride(item_id="item_001", decision=Decision.DONATE, user_reason="don't need it anymore")
    ]
    confirmed = confirm_decisions(ai_decisions, overrides)
    assert confirmed[0].user_reason == "don't need it anymore"
    assert confirmed[0].ai_reason == "ai reason for item_001"
