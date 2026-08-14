"""
Unit tests for evaluation/metrics/detection_evaluation.py — pure,
model-free structures and metrics for the Grounding DINO actionable-
clutter pilot (Phase C1: foundations only, no real detector run involved
anywhere in this file).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evaluation.metrics import detection_evaluation as de
from evaluation.metrics.detection_evaluation import (
    Adjudication,
    DetectorCandidate,
    GroundTruthInstance,
    candidate_id,
    compute_metrics,
    load_ground_truth_from_pilot_json,
    validate_detection_evaluation,
)

_DETECTION_PILOT_EXAMPLE_PATH = (
    Path(__file__).resolve().parents[2] / "evaluation" / "labels" / "detection_pilot.example.json"
)


def _gt(
    instance_id: str,
    filename: str = "bedroom02.jpg",
    label: str = "necklace",
    zone: str = "upper-left",
    actionability: str = "actionable",
    notes: str | None = None,
) -> GroundTruthInstance:
    return GroundTruthInstance(
        instance_id=instance_id,
        filename=filename,
        canonical_label=label,
        position_zone=zone,
        actionability=actionability,
        notes=notes,
    )


def _cand(
    candidate_id: str,
    filename: str = "bedroom02.jpg",
    label: str = "necklace",
    box: tuple[float, float, float, float] = (0.1, 0.1, 0.2, 0.2),
    confidence: float = 0.5,
    variant: str = "A",
    clean_label: str | None = None,
) -> DetectorCandidate:
    return DetectorCandidate(
        candidate_id=candidate_id,
        filename=filename,
        raw_label=label,
        box_xyxy=box,
        confidence=confidence,
        variant=variant,
        clean_label=clean_label,
    )


def _matched(candidate_id: str, instance_id: str, quality: str = "exact_or_equivalent") -> Adjudication:
    return Adjudication(
        candidate_id=candidate_id, match_status="matched", matched_instance_id=instance_id, label_quality=quality
    )


def _unmatched(candidate_id: str) -> Adjudication:
    return Adjudication(candidate_id=candidate_id, match_status="unmatched")


def _ambiguous(candidate_id: str) -> Adjudication:
    return Adjudication(candidate_id=candidate_id, match_status="ambiguous")


# --- 1. complete, correct evaluation -------------------------------------


def test_complete_correct_evaluation():
    gt = [_gt("bedroom02.jpg::gt0")]
    cands = [_cand("bedroom02.jpg::cand0")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0", "exact_or_equivalent")]

    m = compute_metrics(gt, cands, adjs)

    assert m.actionable_ground_truth_count == 1
    assert m.actionable_detected_count == 1
    assert m.actionable_missed_count == 0
    assert m.actionable_recall == 1.0
    assert m.uncorrectable_miss_rate == 0.0
    assert m.strict_label_correct_instance_count == 1
    assert m.strict_label_correct_instance_rate == 1.0
    assert m.actionable_instance_correction_needed_count == 0
    assert m.actionable_matched_candidate_count == 1
    assert m.actionable_candidate_correction_needed_count == 0
    assert m.actionable_candidate_label_assessment_coverage == 1.0
    assert m.is_actionable_label_assessment_complete is True
    assert m.total_candidate_count == 1
    assert m.duplicate_candidate_count == 0
    assert m.unmatched_candidate_count == 0
    assert m.ambiguous_candidate_count == 0


# --- 2. wrong label, correct-object match ---------------------------------


def test_wrong_label_but_correct_object_match():
    gt = [_gt("bedroom04.jpg::gt0", filename="bedroom04.jpg", label="clothes on hangers")]
    cands = [_cand("bedroom04.jpg::cand0", filename="bedroom04.jpg", label="cable")]
    adjs = [_matched("bedroom04.jpg::cand0", "bedroom04.jpg::gt0", "wrong")]

    m = compute_metrics(gt, cands, adjs)

    assert m.actionable_detected_count == 1  # detected for recall...
    assert m.actionable_recall == 1.0
    assert m.strict_label_correct_instance_count == 0  # ...but not strictly label-correct...
    assert m.actionable_instance_correction_needed_count == 1  # ...and counts as correction-needed
    assert m.actionable_instance_correction_needed_rate == 1.0
    assert m.actionable_candidate_correction_needed_count == 1
    assert m.actionable_candidate_correction_needed_rate == 1.0


# --- 3. actionable object with no candidate -------------------------------


def test_actionable_object_with_no_candidate_is_uncorrectable_miss():
    gt = [_gt("bedroom02.jpg::gt0")]

    m = compute_metrics(gt, [], [])

    assert m.actionable_detected_count == 0
    assert m.actionable_missed_count == 1
    assert m.actionable_recall == 0.0
    assert m.uncorrectable_miss_rate == 1.0


# --- 4. jewelry for necklace: usable_but_broad, not exact -----------------


def test_jewelry_for_necklace_is_usable_but_broad_not_exact():
    gt = [_gt("bedroom02.jpg::gt0", label="necklace")]
    cands = [_cand("bedroom02.jpg::cand0", label="jewelry")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0", "usable_but_broad")]

    m = compute_metrics(gt, cands, adjs)

    assert m.strict_label_correct_instance_count == 0
    assert m.usable_but_broad_instance_count == 1
    assert m.actionable_instance_correction_needed_count == 1  # usable_but_broad still burdens correction
    assert m.actionable_candidate_correction_needed_count == 1


# --- 5. two identical-label ground-truth instances stay independent ------


def test_two_identical_label_ground_truth_instances_remain_independent():
    gt = [
        _gt("bedroom02.jpg::gt0", label="stuffed toy", zone="right"),
        _gt("bedroom02.jpg::gt1", label="stuffed toy", zone="right"),
    ]
    cands = [_cand("bedroom02.jpg::cand0", label="stuffed toy")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0")]

    m = compute_metrics(gt, cands, adjs)

    assert m.actionable_ground_truth_count == 2
    assert m.actionable_detected_count == 1
    assert m.actionable_missed_count == 1  # gt1 is NOT silently credited via gt0's match


# --- 6. multiple candidates matched to one instance -----------------------


def test_multiple_candidates_matched_to_one_instance_count_as_one_detection_plus_duplicates():
    gt = [_gt("bedroom02.jpg::gt0", label="picture frame")]
    cands = [
        _cand("bedroom02.jpg::cand0", label="picture frame"),
        _cand("bedroom02.jpg::cand1", label="picture frame", box=(0.3, 0.3, 0.4, 0.4)),
    ]
    adjs = [
        _matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0"),
        _matched("bedroom02.jpg::cand1", "bedroom02.jpg::gt0"),
    ]

    m = compute_metrics(gt, cands, adjs)

    assert m.actionable_detected_count == 1
    assert m.duplicate_candidate_count == 1
    assert m.total_candidate_count == 2
    assert m.actionable_matched_candidate_count == 2


# --- 7. ambiguous candidate excluded from recall --------------------------


def test_ambiguous_candidate_is_excluded_from_recall():
    gt = [_gt("bedroom02.jpg::gt0")]
    cands = [_cand("bedroom02.jpg::cand0")]
    adjs = [_ambiguous("bedroom02.jpg::cand0")]

    m = compute_metrics(gt, cands, adjs)

    assert m.ambiguous_candidate_count == 1
    assert m.actionable_detected_count == 0
    assert m.actionable_missed_count == 1  # never silently counted as a match


# --- 8. contextual detections add review burden, not actionable recall ---


def test_contextual_detection_adds_review_burden_not_actionable_recall():
    gt = [_gt("bedroom02.jpg::gt0", label="desk", actionability="contextual")]
    cands = [_cand("bedroom02.jpg::cand0", label="desk")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0")]

    m = compute_metrics(gt, cands, adjs)

    assert m.contextual_candidate_count == 1
    assert m.actionable_ground_truth_count == 0
    assert m.actionable_recall is None


# --- 9. uncertain ground truth reported, excluded from primary denominator


def test_uncertain_ground_truth_reported_but_excluded_from_primary_denominator():
    gt = [
        _gt("bedroom02.jpg::gt0", actionability="uncertain"),
        _gt("bedroom02.jpg::gt1", label="mirror"),
    ]
    cands = [_cand("bedroom02.jpg::cand0", label="mirror")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt1")]

    m = compute_metrics(gt, cands, adjs)

    assert m.uncertain_ground_truth_count == 1
    assert m.actionable_ground_truth_count == 1  # uncertain instance excluded from this denominator
    assert m.actionable_recall == 1.0


# --- 10. duplicate IDs rejected -------------------------------------------


def test_duplicate_ground_truth_instance_id_rejected():
    gt = [_gt("bedroom02.jpg::gt0"), _gt("bedroom02.jpg::gt0", label="mirror")]
    with pytest.raises(ValueError, match="duplicate ground-truth instance_id"):
        validate_detection_evaluation(gt, [], [])


def test_duplicate_candidate_id_rejected():
    cands = [_cand("bedroom02.jpg::cand0"), _cand("bedroom02.jpg::cand0", label="mirror")]
    with pytest.raises(ValueError, match="duplicate candidate_id"):
        validate_detection_evaluation([], cands, [])


# --- 11. unknown and cross-image references rejected ----------------------


def test_adjudication_referencing_unknown_candidate_rejected():
    with pytest.raises(ValueError, match="unknown candidate_id"):
        validate_detection_evaluation([], [], [_unmatched("does-not-exist")])


def test_adjudication_referencing_unknown_instance_rejected():
    cands = [_cand("bedroom02.jpg::cand0")]
    adjs = [_matched("bedroom02.jpg::cand0", "does-not-exist")]
    with pytest.raises(ValueError, match="unknown ground-truth instance_id"):
        validate_detection_evaluation([], cands, adjs)


def test_cross_image_match_rejected():
    gt = [_gt("bedroom04.jpg::gt0", filename="bedroom04.jpg")]
    cands = [_cand("bedroom02.jpg::cand0", filename="bedroom02.jpg")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom04.jpg::gt0")]
    with pytest.raises(ValueError, match="cross-image"):
        validate_detection_evaluation(gt, cands, adjs)


# --- 12. invalid box/confidence/enums rejected -----------------------------


def test_invalid_confidence_rejected():
    with pytest.raises(ValueError):
        _cand("c0", confidence=1.5)


def test_invalid_box_rejected():
    with pytest.raises(ValueError):
        _cand("c0", box=(0.5, 0.5, 0.2, 0.2))  # inverted x/y


def test_invalid_actionability_rejected():
    with pytest.raises(ValueError):
        _gt("gt0", actionability="maybe")


def test_invalid_match_status_rejected():
    with pytest.raises(ValueError):
        Adjudication(candidate_id="c0", match_status="sort-of")


def test_invalid_label_quality_rejected():
    with pytest.raises(ValueError):
        Adjudication(candidate_id="c0", match_status="matched", matched_instance_id="gt0", label_quality="pretty-good")


def test_blank_identifiers_rejected():
    with pytest.raises(ValueError):
        _gt("   ")
    with pytest.raises(ValueError):
        _cand("")


def test_matched_status_without_instance_rejected():
    with pytest.raises(ValueError, match="matched_instance_id is not set"):
        Adjudication(candidate_id="c0", match_status="matched")


def test_unmatched_status_carrying_instance_rejected():
    with pytest.raises(ValueError, match="matched_instance_id is set"):
        Adjudication(candidate_id="c0", match_status="unmatched", matched_instance_id="gt0")


def test_ambiguous_with_label_quality_assessed_rejected():
    with pytest.raises(ValueError, match="label quality can only be assessed"):
        Adjudication(candidate_id="c0", match_status="ambiguous", label_quality="wrong")


# --- 13. zero-denominator behaviour ----------------------------------------


def test_zero_actionable_ground_truth_yields_none_not_zero():
    gt = [_gt("bedroom02.jpg::gt0", actionability="contextual")]

    m = compute_metrics(gt, [], [])

    assert m.actionable_ground_truth_count == 0
    assert m.actionable_recall is None
    assert m.uncorrectable_miss_rate is None
    assert m.strict_label_correct_instance_rate is None
    assert m.actionable_instance_correction_needed_rate is None
    assert m.actionable_candidate_correction_needed_rate is None
    assert m.actionable_candidate_label_assessment_coverage is None
    assert m.is_actionable_label_assessment_complete is True  # nothing required assessment


# --- 14. input-order independence ------------------------------------------


def test_input_order_independence():
    gt = [_gt("bedroom02.jpg::gt0", label="mirror"), _gt("bedroom02.jpg::gt1", label="clock")]
    cands = [_cand("bedroom02.jpg::cand0", label="mirror"), _cand("bedroom02.jpg::cand1", label="clock")]
    adjs = [
        _matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0"),
        _matched("bedroom02.jpg::cand1", "bedroom02.jpg::gt1"),
    ]

    forward = compute_metrics(gt, cands, adjs)
    reversed_result = compute_metrics(list(reversed(gt)), list(reversed(cands)), list(reversed(adjs)))

    assert forward == reversed_result


# --- 15. no forbidden imports ----------------------------------------------


def test_module_has_no_forbidden_imports():
    source = Path(de.__file__).read_text(encoding="utf-8")
    forbidden = ["import torch", "import groundingdino", "import ollama", "from app.models", "import cv2", "import clip"]
    for token in forbidden:
        assert token not in source, f"forbidden import found in detection_evaluation.py: {token!r}"


# --- extra: actionable instances are never silently excluded --------------


def test_every_actionable_instance_is_either_detected_or_missed_never_dropped():
    gt = [_gt(f"bedroom02.jpg::gt{i}", label=f"item{i}") for i in range(4)]
    cands = [
        _cand("bedroom02.jpg::cand0", label="item0"),
        _cand("bedroom02.jpg::cand1", label="item2"),
    ]
    adjs = [
        _matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0"),
        _matched("bedroom02.jpg::cand1", "bedroom02.jpg::gt2"),
    ]

    m = compute_metrics(gt, cands, adjs)

    assert m.actionable_detected_count + m.actionable_missed_count == m.actionable_ground_truth_count == 4


# --- extra: candidate<->adjudication bijection is enforced ----------------


def test_candidate_with_no_adjudication_rejected():
    cands = [_cand("bedroom02.jpg::cand0")]
    with pytest.raises(ValueError, match="no adjudication record"):
        validate_detection_evaluation([], cands, [])


def test_candidate_adjudicated_more_than_once_rejected():
    cands = [_cand("bedroom02.jpg::cand0")]
    adjs = [_unmatched("bedroom02.jpg::cand0"), _unmatched("bedroom02.jpg::cand0")]
    with pytest.raises(ValueError, match="adjudicated more than once"):
        validate_detection_evaluation([], cands, adjs)


# --- Correction 1: one variant per compute_metrics() call -----------------


def test_zero_candidates_is_valid_regardless_of_variant():
    gt = [_gt("bedroom02.jpg::gt0", actionability="contextual")]
    m = compute_metrics(gt, [], [])  # no ValueError
    assert m.total_candidate_count == 0


def test_one_variant_across_multiple_images_is_valid():
    gt = [
        _gt("bedroom02.jpg::gt0", filename="bedroom02.jpg", actionability="contextual"),
        _gt("bedroom04.jpg::gt0", filename="bedroom04.jpg", actionability="contextual"),
    ]
    cands = [
        _cand("bedroom02.jpg::cand0", filename="bedroom02.jpg", variant="A"),
        _cand("bedroom04.jpg::cand0", filename="bedroom04.jpg", variant="A"),
    ]
    adjs = [
        _matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0"),
        _matched("bedroom04.jpg::cand0", "bedroom04.jpg::gt0"),
    ]

    m = compute_metrics(gt, cands, adjs)  # no ValueError

    assert m.total_candidate_count == 2


def test_two_variants_in_one_call_rejected():
    cands = [
        _cand("bedroom02.jpg::cand0", variant="A"),
        _cand("bedroom02.jpg::cand1", variant="B", box=(0.3, 0.3, 0.4, 0.4)),
    ]
    with pytest.raises(ValueError, match="more than one variant"):
        validate_detection_evaluation([], cands, [])


# --- Correction 2: candidate_id() is variant-agnostic ----------------------


def test_candidate_id_does_not_encode_variant():
    assert candidate_id("bedroom02.jpg", 0) == "bedroom02.jpg::cand0"
    # Same call shape regardless of which variant a future runner used to
    # produce this candidate — variant is metadata on DetectorCandidate
    # only, never part of the identity string.


# --- Correction 3: instance-level vs. candidate-level burden --------------


def test_duplicate_quality_proves_both_instance_and_candidate_views_simultaneously():
    """One correct candidate + one wrong duplicate for the same instance:
    the instance counts as strictly identified (a user only needed the
    good candidate), but the wrong duplicate still shows up as its own
    unit of candidate-level correction burden — the exact scenario
    Correction 3 was written to distinguish."""
    gt = [_gt("bedroom02.jpg::gt0", label="picture frame")]
    cands = [
        _cand("bedroom02.jpg::cand0", label="picture frame"),
        _cand("bedroom02.jpg::cand1", label="wrongish", box=(0.3, 0.3, 0.4, 0.4)),
    ]
    adjs = [
        _matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0", "exact_or_equivalent"),
        _matched("bedroom02.jpg::cand1", "bedroom02.jpg::gt0", "wrong"),
    ]

    m = compute_metrics(gt, cands, adjs)

    # Instance level: the object is usably identified via its good candidate.
    assert m.strict_label_correct_instance_count == 1
    assert m.actionable_instance_correction_needed_count == 0

    # Candidate level: the wrong duplicate is still real burden.
    assert m.actionable_matched_candidate_count == 2
    assert m.actionable_candidate_correction_needed_count == 1
    assert m.actionable_candidate_correction_needed_rate == 0.5

    # And it is visible as a duplicate too — both views agree it exists.
    assert m.duplicate_candidate_count == 1


# --- Correction 4: assessment completeness ---------------------------------


def test_incomplete_assessment_reported_honestly_non_strict():
    gt = [_gt("bedroom02.jpg::gt0", label="picture frame")]
    cands = [_cand("bedroom02.jpg::cand0", label="picture frame")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0", "not_assessed")]

    m = compute_metrics(gt, cands, adjs)  # non-strict: no error

    assert m.actionable_matched_candidate_count == 1
    assert m.actionable_candidate_label_quality_assessed_count == 0
    assert m.actionable_candidate_label_assessment_coverage == 0.0
    assert m.is_actionable_label_assessment_complete is False
    # not_assessed must not count as correct or incorrect at either level
    assert m.strict_label_correct_instance_count == 0
    assert m.actionable_instance_correction_needed_count == 0
    assert m.actionable_candidate_correction_needed_count == 0


def test_strict_mode_rejects_incomplete_assessment():
    gt = [_gt("bedroom02.jpg::gt0", label="picture frame")]
    cands = [_cand("bedroom02.jpg::cand0", label="picture frame")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0", "not_assessed")]

    with pytest.raises(ValueError, match="not_assessed"):
        compute_metrics(gt, cands, adjs, require_complete_label_assessment=True)


def test_strict_mode_passes_when_assessment_complete():
    gt = [_gt("bedroom02.jpg::gt0", label="picture frame")]
    cands = [_cand("bedroom02.jpg::cand0", label="picture frame")]
    adjs = [_matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0", "exact_or_equivalent")]

    m = compute_metrics(gt, cands, adjs, require_complete_label_assessment=True)  # no error

    assert m.is_actionable_label_assessment_complete is True
    assert m.actionable_candidate_label_assessment_coverage == 1.0


def test_selectively_assessed_candidates_cannot_silently_produce_a_complete_result():
    """Two matched actionable candidates on two different instances — one
    assessed, one not. Coverage must reflect the partial state and strict
    mode must still reject it, even though *some* real assessment exists."""
    gt = [
        _gt("bedroom02.jpg::gt0", label="mirror"),
        _gt("bedroom02.jpg::gt1", label="clock"),
    ]
    cands = [
        _cand("bedroom02.jpg::cand0", label="mirror"),
        _cand("bedroom02.jpg::cand1", label="clock"),
    ]
    adjs = [
        _matched("bedroom02.jpg::cand0", "bedroom02.jpg::gt0", "exact_or_equivalent"),
        _matched("bedroom02.jpg::cand1", "bedroom02.jpg::gt1", "not_assessed"),
    ]

    m = compute_metrics(gt, cands, adjs)

    assert m.actionable_candidate_label_assessment_coverage == 0.5
    assert m.is_actionable_label_assessment_complete is False

    with pytest.raises(ValueError, match="bedroom02.jpg::cand1"):
        compute_metrics(gt, cands, adjs, require_complete_label_assessment=True)


# --- Correction 5: hardened pilot-JSON loader + retained metadata ---------


def test_example_fixture_parses_retains_metadata_and_requires_placeholder_opt_in():
    data = json.loads(_DETECTION_PILOT_EXAMPLE_PATH.read_text(encoding="utf-8"))

    # Without the explicit opt-in, the fixture's placeholder hash is rejected.
    with pytest.raises(ValueError, match="placeholder"):
        load_ground_truth_from_pilot_json(data)

    bundle = load_ground_truth_from_pilot_json(data, allow_placeholder_source_hash=True)

    assert bundle.schema_version == 1
    assert bundle.source_labels_json_git_blob == "REPLACE-WITH-REAL-BLOB-HASH-AT-ANNOTATION-TIME"
    assert len(bundle.instances) == 3
    assert {i.actionability for i in bundle.instances} == {"actionable", "contextual", "uncertain"}

    # No candidates/adjudications exist yet for this fixture — a bare
    # ground-truth-only evaluation must still validate cleanly.
    m = compute_metrics(bundle.instances, [], [])
    assert m.actionable_ground_truth_count == 1
    assert m.actionable_missed_count == 1
    assert m.contextual_ground_truth_count == 1
    assert m.uncertain_ground_truth_count == 1


def test_pilot_json_loader_rejects_unknown_schema_version():
    with pytest.raises(ValueError, match="schema_version"):
        load_ground_truth_from_pilot_json(
            {"schema_version": 999, "source_labels_json_git_blob": "a" * 40, "images": []}
        )


def test_pilot_json_loader_rejects_non_object_top_level():
    with pytest.raises(ValueError, match="JSON object"):
        load_ground_truth_from_pilot_json(["not", "an", "object"])  # type: ignore[arg-type]


def test_pilot_json_loader_rejects_real_hash_shaped_wrong():
    with pytest.raises(ValueError, match="Git blob hash"):
        load_ground_truth_from_pilot_json(
            {"schema_version": 1, "source_labels_json_git_blob": "not-hex", "images": []}
        )


def test_pilot_json_loader_accepts_valid_real_hash_lengths():
    for real_hash in ("a" * 40, "b" * 64):
        bundle = load_ground_truth_from_pilot_json(
            {"schema_version": 1, "source_labels_json_git_blob": real_hash, "images": []}
        )
        assert bundle.source_labels_json_git_blob == real_hash
        assert bundle.instances == []


def test_pilot_json_loader_rejects_duplicate_filenames():
    data = {
        "schema_version": 1,
        "source_labels_json_git_blob": "a" * 40,
        "images": [
            {"filename": "bedroom02.jpg", "ground_truth_instances": []},
            {"filename": "bedroom02.jpg", "ground_truth_instances": []},
        ],
    }
    with pytest.raises(ValueError, match="duplicate filename"):
        load_ground_truth_from_pilot_json(data)


def test_pilot_json_loader_rejects_duplicate_instance_ids_across_images():
    data = {
        "schema_version": 1,
        "source_labels_json_git_blob": "a" * 40,
        "images": [
            {
                "filename": "bedroom02.jpg",
                "ground_truth_instances": [
                    {
                        "instance_id": "dup",
                        "canonical_label": "mirror",
                        "position_zone": "left",
                        "actionability": "actionable",
                    }
                ],
            },
            {
                "filename": "bedroom04.jpg",
                "ground_truth_instances": [
                    {
                        "instance_id": "dup",
                        "canonical_label": "clock",
                        "position_zone": "right",
                        "actionability": "actionable",
                    }
                ],
            },
        ],
    }
    with pytest.raises(ValueError, match="duplicate instance_id"):
        load_ground_truth_from_pilot_json(data)


def test_pilot_json_loader_rejects_malformed_instance_missing_required_key():
    data = {
        "schema_version": 1,
        "source_labels_json_git_blob": "a" * 40,
        "images": [
            {
                "filename": "bedroom02.jpg",
                "ground_truth_instances": [{"instance_id": "gt0", "canonical_label": "mirror"}],
            }
        ],
    }
    with pytest.raises(ValueError, match="position_zone"):
        load_ground_truth_from_pilot_json(data)


def test_pilot_json_loader_rejects_non_list_images():
    data = {"schema_version": 1, "source_labels_json_git_blob": "a" * 40, "images": "not-a-list"}
    with pytest.raises(ValueError, match="images must be a list"):
        load_ground_truth_from_pilot_json(data)


def test_pilot_json_loader_rejects_non_object_image_entry():
    data = {"schema_version": 1, "source_labels_json_git_blob": "a" * 40, "images": ["not-an-object"]}
    with pytest.raises(ValueError, match="JSON object"):
        load_ground_truth_from_pilot_json(data)


def test_pilot_json_loader_rejects_missing_top_level_keys():
    with pytest.raises(ValueError, match="schema_version"):
        load_ground_truth_from_pilot_json({})
    with pytest.raises(ValueError, match="source_labels_json_git_blob"):
        load_ground_truth_from_pilot_json({"schema_version": 1})
    with pytest.raises(ValueError, match="images"):
        load_ground_truth_from_pilot_json({"schema_version": 1, "source_labels_json_git_blob": "a" * 40})


# --- Hardening: malformed instance_id must raise ValueError, never TypeError


def _pilot_data_with_instance_id(instance_id_value: object) -> dict:
    return {
        "schema_version": 1,
        "source_labels_json_git_blob": "a" * 40,
        "images": [
            {
                "filename": "bedroom02.jpg",
                "ground_truth_instances": [
                    {
                        "instance_id": instance_id_value,
                        "canonical_label": "mirror",
                        "position_zone": "left",
                        "actionability": "actionable",
                    }
                ],
            }
        ],
    }


@pytest.mark.parametrize(
    "malformed_instance_id",
    [
        pytest.param([], id="empty-list"),
        pytest.param({}, id="empty-dict"),
        pytest.param(None, id="none"),
        pytest.param(5, id="integer"),
        pytest.param("   ", id="blank-string"),
    ],
)
def test_pilot_json_loader_rejects_malformed_instance_id_with_value_error_not_type_error(malformed_instance_id):
    data = _pilot_data_with_instance_id(malformed_instance_id)

    with pytest.raises(ValueError, match="instance_id") as exc_info:
        load_ground_truth_from_pilot_json(data)

    assert not isinstance(exc_info.value, TypeError)


def test_pilot_json_loader_rejects_schema_version_true_as_not_equal_to_one():
    # bool is a subclass of int in Python (True == 1) — schema_version=True
    # must NOT be silently accepted as version 1.
    data = {"schema_version": True, "source_labels_json_git_blob": "a" * 40, "images": []}
    with pytest.raises(ValueError, match="schema_version"):
        load_ground_truth_from_pilot_json(data)
