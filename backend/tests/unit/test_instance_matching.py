"""
Unit tests for evaluation/metrics/instance_matching.py — pure logic, no
model loading, no Ollama calls. Fixture data throughout.
"""

from collections import defaultdict

import pytest

from evaluation.metrics.instance_matching import (
    build_ground_truth_index,
    compute_determinism,
    instance_id,
    match_batch,
    match_prediction,
)


def _ground_truth(*labels_and_decisions: tuple[str, str]):
    return build_ground_truth_index(
        [{"label": label, "expected_decision": decision} for label, decision in labels_and_decisions]
    )


# --- matching: two same-label instances, resolved independently ---


def test_two_same_label_instances_with_different_expected_decisions_match_independently():
    # bedroom02.jpg-shaped case, but with differing decisions to make the
    # fix's effect unambiguous (real labels.json currently has both
    # "stuffed toy" instances as "keep" — this exercises the case where
    # they genuinely differ, which the old label-keyed dict could never
    # represent at all).
    ground_truth = _ground_truth(
        ("stuffed toy", "keep"),
        ("stuffed toy", "donate"),
    )

    first = match_prediction("bedroom02.jpg", ground_truth, {"item_number": 1, "label": "stuffed toy", "decision": "keep"})
    second = match_prediction("bedroom02.jpg", ground_truth, {"item_number": 2, "label": "stuffed toy", "decision": "donate"})

    assert first.status == "matched"
    assert second.status == "matched"
    assert first.instance_id != second.instance_id
    assert first.expected_decision == "keep"
    assert second.expected_decision == "donate"


def test_occurrence_aware_identity_is_positional_not_label_derived():
    assert instance_id("bedroom02.jpg", 29) == "bedroom02.jpg::gt29"
    assert instance_id("bedroom02.jpg", 30) == "bedroom02.jpg::gt30"
    assert instance_id("bedroom02.jpg", 29) != instance_id("bedroom02.jpg", 30)
    # Same index, different filename -> also distinct (identity is per-image too).
    assert instance_id("bedroom02.jpg", 29) != instance_id("bedroom04.jpg", 29)


def test_item_number_matching_ignores_label_text_entirely():
    # Two different labels at known positions — item_number resolves
    # correctly regardless of what the label field even says, proving
    # identity comes from position, not text.
    ground_truth = _ground_truth(("lamp", "keep"), ("book", "discard"))
    result = match_prediction("img.jpg", ground_truth, {"item_number": 2, "label": "anything", "decision": "discard"})
    assert result.status == "matched"
    assert result.expected_decision == "discard"
    assert result.instance_id == instance_id("img.jpg", 1)


def test_out_of_range_item_number_is_unmatched():
    ground_truth = _ground_truth(("lamp", "keep"))
    result = match_prediction("img.jpg", ground_truth, {"item_number": 99, "label": "lamp", "decision": "keep"})
    assert result.status == "unmatched"
    assert result.instance_id is None


# --- label-only fallback (no item_number) ---


def test_unique_label_matches_safely_without_item_number():
    ground_truth = _ground_truth(("lamp", "keep"), ("book", "discard"))
    result = match_prediction("img.jpg", ground_truth, {"label": "book", "decision": "discard"})
    assert result.status == "matched"
    assert result.expected_decision == "discard"


def test_ambiguous_label_only_matching_is_never_guessed():
    # No item_number at all, and the label occurs twice — must not pick
    # either instance arbitrarily.
    ground_truth = _ground_truth(("stuffed toy", "keep"), ("stuffed toy", "donate"))
    result = match_prediction("bedroom02.jpg", ground_truth, {"label": "stuffed toy", "decision": "keep"})
    assert result.status == "ambiguous"
    assert result.instance_id is None
    assert result.expected_decision is None
    assert result.reason is not None and "stuffed toy" in result.reason


def test_label_with_no_match_at_all_is_unmatched():
    ground_truth = _ground_truth(("lamp", "keep"))
    result = match_prediction("img.jpg", ground_truth, {"label": "invented item", "decision": "keep"})
    assert result.status == "unmatched"


# --- label fallback is restricted to a genuinely absent item_number ---


@pytest.mark.parametrize(
    "invalid_item_number",
    [None, "1", True, False, 0, -1, 999],
    ids=["none", "string", "true", "false", "zero", "negative", "out_of_range"],
)
def test_item_number_present_but_invalid_is_never_rescued_by_label(invalid_item_number):
    # The label alone ("lamp") would resolve unambiguously — but a
    # present-and-invalid item_number must never be rescued through it.
    ground_truth = _ground_truth(("lamp", "keep"))
    result = match_prediction(
        "img.jpg", ground_truth, {"item_number": invalid_item_number, "label": "lamp", "decision": "keep"}
    )
    assert result.status == "unmatched"
    assert result.instance_id is None


def test_malformed_item_number_with_correct_unique_label_is_unmatched_not_label_matched():
    ground_truth = _ground_truth(("lamp", "keep"))
    result = match_prediction("img.jpg", ground_truth, {"item_number": "1", "label": "lamp", "decision": "keep"})
    assert result.status == "unmatched"


def test_item_number_none_with_correct_unique_label_is_unmatched():
    ground_truth = _ground_truth(("lamp", "keep"))
    result = match_prediction("img.jpg", ground_truth, {"item_number": None, "label": "lamp", "decision": "keep"})
    assert result.status == "unmatched"


def test_item_number_genuinely_absent_still_allows_label_fallback():
    # Contrast case: no item_number KEY at all (not present-and-invalid)
    # — this is the only situation where label fallback is permitted.
    ground_truth = _ground_truth(("lamp", "keep"))
    result = match_prediction("img.jpg", ground_truth, {"label": "lamp", "decision": "keep"})
    assert result.status == "matched"


# --- batch-level matching: duplicate item_number within one repeat ---


def test_duplicate_item_number_in_one_batch_contributes_zero_observations():
    ground_truth = _ground_truth(("lamp", "keep"))
    batch = match_batch(
        "img.jpg",
        ground_truth,
        [
            {"item_number": 1, "label": "lamp", "decision": "keep"},
            {"item_number": 1, "label": "lamp", "decision": "discard"},
        ],
    )
    assert batch.matches == []  # neither occurrence trusted
    assert batch.duplicate_count == 2


def test_duplicate_in_one_batch_does_not_affect_another_unique_item():
    ground_truth = _ground_truth(("lamp", "keep"), ("book", "discard"))
    batch = match_batch(
        "img.jpg",
        ground_truth,
        [
            {"item_number": 1, "label": "lamp", "decision": "keep"},
            {"item_number": 1, "label": "lamp", "decision": "discard"},  # duplicate of item_number 1
            {"item_number": 2, "label": "book", "decision": "discard"},  # unaffected
        ],
    )
    assert batch.duplicate_count == 2
    assert len(batch.matches) == 1
    predicted_item, match = batch.matches[0]
    assert match.status == "matched"
    assert match.instance_id == instance_id("img.jpg", 1)
    assert match.expected_decision == "discard"


def test_duplicate_predictions_do_not_enter_agreement_totals():
    # Mirrors how compare_llm_reasoning.py accumulates agreement_total:
    # only len(batch.matches) should ever contribute, never raw predictions.
    ground_truth = _ground_truth(("lamp", "keep"))
    batch = match_batch(
        "img.jpg",
        ground_truth,
        [
            {"item_number": 1, "label": "lamp", "decision": "keep"},
            {"item_number": 1, "label": "lamp", "decision": "keep"},
        ],
    )
    agreement_total = len(batch.matches)
    assert agreement_total == 0
    assert batch.duplicate_count == 2


# --- instance-level dedup: the universal invariant, across BOTH match
# paths (item_number and label-only), not just within the item_number path ---


def test_two_label_only_predictions_resolving_to_same_unique_instance_both_produce_zero_matches():
    ground_truth = _ground_truth(("lamp", "keep"))  # "lamp" is a unique label
    batch = match_batch(
        "img.jpg",
        ground_truth,
        [
            {"label": "lamp", "decision": "keep"},
            {"label": "lamp", "decision": "discard"},
        ],
    )
    assert batch.matches == []
    assert batch.duplicate_count == 2


def test_numbered_and_label_only_collision_on_same_instance_both_produce_zero_matches():
    ground_truth = _ground_truth(("lamp", "keep"), ("book", "discard"))
    batch = match_batch(
        "img.jpg",
        ground_truth,
        [
            {"item_number": 1, "label": "lamp", "decision": "keep"},  # resolves to gt0 via item_number
            {"label": "lamp", "decision": "discard"},  # resolves to the same gt0 via unique label
        ],
    )
    assert batch.matches == []
    assert batch.duplicate_count == 2


def test_two_distinct_label_only_predictions_to_distinct_instances_still_match():
    ground_truth = _ground_truth(("lamp", "keep"), ("book", "discard"))
    batch = match_batch(
        "img.jpg",
        ground_truth,
        [
            {"label": "lamp", "decision": "keep"},
            {"label": "book", "decision": "discard"},
        ],
    )
    assert len(batch.matches) == 2
    assert batch.duplicate_count == 0
    matched_instance_ids = {match.instance_id for _, match in batch.matches}
    assert matched_instance_ids == {instance_id("img.jpg", 0), instance_id("img.jpg", 1)}


def test_no_collision_reaches_stability_or_agreement():
    # Integration-style, mirroring compare_llm_reasoning.py's own
    # accumulation exactly: a numbered match and a label-only match
    # collide on the same instance within one repeat.
    ground_truth = _ground_truth(("lamp", "keep"))
    batch = match_batch(
        "img.jpg",
        ground_truth,
        [
            {"item_number": 1, "label": "lamp", "decision": "keep"},
            {"label": "lamp", "decision": "discard"},
        ],
    )

    stability: dict[str, dict[int, str]] = defaultdict(dict)
    agreement_total = 0
    for predicted_item, match in batch.matches:
        stability[match.instance_id][0] = str(predicted_item["decision"]).lower()
        agreement_total += 1

    assert batch.matches == []
    assert agreement_total == 0
    assert stability == {}


# --- determinism: instance_id -> {repeat_index: decision} ---


def test_repeats_one_produces_no_determinism_result():
    stability = {"img.jpg::gt0": {0: "keep"}}
    result = compute_determinism(stability, repeats=1)
    assert result.determinism_rate is None
    assert result.reason is not None


def test_repeats_two_produces_no_determinism_result():
    stability = {"img.jpg::gt0": {0: "keep", 1: "keep"}}
    result = compute_determinism(stability, repeats=2)
    assert result.determinism_rate is None
    assert result.reason is not None


def test_three_distinct_repeat_indices_identical_decisions_produce_full_stability():
    stability = {"img.jpg::gt0": {0: "keep", 1: "keep", 2: "keep"}}
    result = compute_determinism(stability, repeats=3)
    assert result.determinism_rate == 1.0
    assert result.n_eligible_instances == 1
    assert result.reason is None


def test_three_distinct_repeat_indices_differing_decisions_produce_reduced_stability():
    stability = {
        "img.jpg::gt0": {0: "keep", 1: "keep", 2: "keep"},  # stable
        "img.jpg::gt1": {0: "keep", 1: "discard", 2: "keep"},  # unstable
    }
    result = compute_determinism(stability, repeats=3)
    assert result.determinism_rate == 0.5
    assert result.n_eligible_instances == 2


def test_unobserved_expected_instance_counts_in_total_but_not_eligible():
    # Simulates compare_llm_reasoning.py's per-image seeding: every
    # expected ground-truth instance gets an empty repeat-map before any
    # repeat runs, so an instance the model never returned a usable
    # prediction for at all is still visible in n_total_instances — but
    # an empty repeat-map can never be eligible (0 < 3), so it can't be
    # counted as stable either.
    stability = {
        "img.jpg::gt0": {0: "keep", 1: "keep", 2: "keep"},  # genuinely observed, stable
        "img.jpg::gt1": {},  # expected, but never returned a usable prediction
    }
    result = compute_determinism(stability, repeats=3)
    assert result.n_total_instances == 2
    assert result.n_eligible_instances == 1
    assert result.determinism_rate == 1.0  # unaffected by the unobserved instance


def test_missing_repeat_prevents_a_determinism_claim():
    # repeats=3 was requested, but this instance only has decisions from 2
    # distinct repeat indices (e.g. the 3rd call failed validity or came
    # back unmatched/duplicate) — excluded, never padded or guessed.
    stability = {"img.jpg::gt0": {0: "keep", 1: "keep"}}
    result = compute_determinism(stability, repeats=3)
    assert result.determinism_rate is None
    assert result.n_eligible_instances == 0
    assert result.n_total_instances == 1
    assert result.reason is not None


def test_instance_with_missing_repeat_excluded_but_others_still_counted():
    stability = {
        "img.jpg::gt0": {0: "keep", 1: "keep", 2: "keep"},  # 3 distinct repeats, stable
        "img.jpg::gt1": {0: "keep", 1: "keep"},  # only 2 distinct repeats — excluded, not padded
    }
    result = compute_determinism(stability, repeats=3)
    assert result.determinism_rate == 1.0  # only gt0 is eligible, and it's stable
    assert result.n_eligible_instances == 1
    assert result.n_total_instances == 2


def test_two_outputs_in_one_repeat_plus_one_in_another_do_not_satisfy_three_repeats():
    # Integration-style: simulates exactly what compare_llm_reasoning.py's
    # loop does — batch-match each repeat, fold matches into `stability`
    # keyed by repeat_index — to prove a within-repeat duplicate's
    # exclusion composes correctly with the across-repeats determinism
    # check, not just in isolation.
    ground_truth = _ground_truth(("lamp", "keep"))
    stability: dict[str, dict[int, str]] = defaultdict(dict)

    # repeat 0: item_number=1 returned twice (duplicate) -> zero genuine observations
    batch0 = match_batch(
        "img.jpg",
        ground_truth,
        [
            {"item_number": 1, "label": "lamp", "decision": "keep"},
            {"item_number": 1, "label": "lamp", "decision": "discard"},
        ],
    )
    for predicted_item, match in batch0.matches:
        stability[match.instance_id][0] = str(predicted_item["decision"]).lower()

    # repeat 1: item_number=1 returned once -> one genuine observation
    batch1 = match_batch("img.jpg", ground_truth, [{"item_number": 1, "label": "lamp", "decision": "keep"}])
    for predicted_item, match in batch1.matches:
        stability[match.instance_id][1] = str(predicted_item["decision"]).lower()

    assert batch0.duplicate_count == 2
    assert len(batch0.matches) == 0
    assert len(batch1.matches) == 1

    result = compute_determinism(stability, repeats=3)
    # Only 1 distinct repeat index (1) actually observed this instance —
    # far short of the 3 required, regardless of how many raw predictions
    # were returned across both repeats.
    assert result.determinism_rate is None
    assert result.n_eligible_instances == 0
