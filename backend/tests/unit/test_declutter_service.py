"""
Unit tests for app/services/declutter_service.run_declutter() and
DeclutterResult. Pure fakes throughout — no real Ollama.

This file itself imports app.models.mistral_llm.LLMResult, for
convenience (the simplest concrete object satisfying LLMClassifier's
LLMResultLike return type) and specifically because doing so doubles as
a structural-satisfaction proof: the real LLMResult really does satisfy
LLMResultLike with zero adapter code. declutter_service.py itself must
NOT import app.models.mistral_llm at runtime — see
test_declutter_service_import_does_not_pull_in_mistral_llm_or_ollama
below, which verifies that boundary in a fresh subprocess (this test
file's own import of LLMResult would otherwise make an in-process check
meaningless).
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.schemas import (
    AiDecision,
    AnalysisResult,
    BoundingBox,
    Decision,
    DetectedItem,
    ItemValidity,
    SceneClassification,
)
from app.models.mistral_llm import LLMResult
from app.services.declutter_service import (
    DeclutterReasoningError,
    DeclutterResult,
    ReclassifyItemResult,
    reclassify_item,
    run_declutter,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]


def _item(n: int, label: str = "picture frame", role: str = "actionable") -> DetectedItem:
    return DetectedItem(
        item_id=f"item_{n:03d}",
        source_detection_index=n - 1,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.3, y2=0.3),
        confidence=0.9,
        position="upper-left",
        relative_size="small",
        item_role=role,
        item_role_source="default",
    )


def _analysis(items: list[DetectedItem], run_id: str = "run1", scene_label: str = "bedroom") -> AnalysisResult:
    scene = SceneClassification(label=scene_label, confidence=0.9, all_scores={scene_label: 0.9})
    return AnalysisResult(run_id=run_id, scene=scene, items=items, warnings=[], stage_timings=[])


def _ai_dict(n: int, decision: str = "keep", reason: str = "still useful", label: str | None = None) -> dict:
    d = {"item_number": n, "decision": decision, "reason": reason}
    if label is not None:
        d["label"] = label
    return d


def _llm_result(
    parsed_json,
    item_provenance: dict[int, ItemValidity] | None = None,
    is_valid_json: bool = True,
    model_name: str = "phi4-mini",
) -> LLMResult:
    return LLMResult(
        raw_text="fake",
        parsed_json=parsed_json,
        is_valid_json=is_valid_json,
        model_name=model_name,
        prompt_version="v2",
        item_provenance=item_provenance or {},
    )


class FakeLLMClassifier:
    """Serves `responses` in call order: the first call is always the main
    bulk call; every subsequent call is a targeted service-level recovery
    call, issued in ascending item_number order (see run_declutter). An
    entry that's an Exception instance is raised instead of returned."""

    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def __call__(self, run_id, detected_items, scene_label, user_context, model_name=None):
        self.calls.append(
            {
                "run_id": run_id,
                "detected_items": detected_items,
                "scene_label": scene_label,
                "user_context": user_context,
                "model_name": model_name,
            }
        )
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


# ---------------------------------------------------------------------------
# Raw-valid / mechanically-repaired / strictly-clean vs complete-only
# ---------------------------------------------------------------------------


def test_perfect_raw_valid_result_is_complete_and_strictly_valid():
    items = [_item(1), _item(2)]
    analysis = _analysis(items)
    main = _llm_result(
        [_ai_dict(1, "keep"), _ai_dict(2, "donate")],
        item_provenance={1: ItemValidity.RAW_VALID, 2: ItemValidity.RAW_VALID},
    )
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.is_complete is True
    assert result.is_strictly_valid is True
    assert result.item_validity == {"item_001": ItemValidity.RAW_VALID, "item_002": ItemValidity.RAW_VALID}
    assert len(classifier.calls) == 1
    assert [ai.decision for ai in result.ai_decisions] == [Decision.KEEP, Decision.DONATE]


def test_mechanically_repaired_provenance_is_trusted_directly():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.MECHANICALLY_REPAIRED})
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity == {"item_001": ItemValidity.MECHANICALLY_REPAIRED}
    assert result.is_complete is True
    assert len(classifier.calls) == 1  # no recovery triggered


def test_classify_items_internal_recovery_provenance_is_trusted_without_a_service_level_call():
    items = [_item(1)]
    analysis = _analysis(items)
    # classify_items() already resolved this internally (its own
    # missing-item recovery) — the item is present in parsed_json and
    # tagged RECOVERY_USED before run_declutter ever sees it.
    main = _llm_result([_ai_dict(1, "discard")], item_provenance={1: ItemValidity.RECOVERY_USED})
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity == {"item_001": ItemValidity.RECOVERY_USED}
    assert len(classifier.calls) == 1  # trusted directly, no service-level recovery


# ---------------------------------------------------------------------------
# Missing / untrusted provenance must never become RAW_VALID
# ---------------------------------------------------------------------------


def test_missing_provenance_is_never_treated_as_raw_valid():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={})  # no hint at all for item_number 1
    recovery = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_001"] != ItemValidity.RAW_VALID
    assert result.item_validity["item_001"] == ItemValidity.RECOVERY_USED
    assert len(result.provenance_warnings) == 1
    assert result.provenance_warnings[0].item_id == "item_001"


def test_missing_provenance_triggers_exactly_one_targeted_recovery_call():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={})
    recovery = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert len(classifier.calls) == 2
    assert len(classifier.calls[1]["detected_items"]) == 1  # single-item targeted call


def test_unrecognised_provenance_value_is_also_untrusted():
    items = [_item(1)]
    analysis = _analysis(items)
    # STILL_INVALID hint on an item that nonetheless mapped/validated —
    # contradictory, defensively treated the same as a missing hint.
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.STILL_INVALID})
    recovery = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_001"] == ItemValidity.RECOVERY_USED
    assert len(result.provenance_warnings) == 1


# ---------------------------------------------------------------------------
# Identity / content failures each trigger the one targeted recovery
# ---------------------------------------------------------------------------


def test_duplicate_item_number_in_main_response_triggers_recovery():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result(
        [_ai_dict(1, "keep"), _ai_dict(1, "donate")],  # item_number 1 twice — neither trusted
        item_provenance={1: ItemValidity.RAW_VALID},
    )
    recovery = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_001"] == ItemValidity.RECOVERY_USED
    assert result.ai_decisions[0].decision == Decision.SELL
    assert any(w.item_number == 1 for w in result.mapping_warnings)
    assert len(classifier.calls) == 2


def test_invalid_decision_enum_triggers_recovery():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "maybe-later")], item_provenance={1: ItemValidity.RAW_VALID})
    recovery = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_001"] == ItemValidity.RECOVERY_USED
    assert len(result.semantic_errors) >= 1
    assert len(classifier.calls) == 2


def test_blank_reason_triggers_recovery():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "keep", reason="   ")], item_provenance={1: ItemValidity.RAW_VALID})
    recovery = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_001"] == ItemValidity.RECOVERY_USED
    assert len(result.semantic_errors) >= 1


# ---------------------------------------------------------------------------
# Recovery outcomes: success, failure, exception, and the one-attempt bound
# ---------------------------------------------------------------------------


def test_targeted_recovery_success_maps_local_item_number_1_back_to_real_item_id():
    items = [_item(1), _item(2)]
    analysis = _analysis(items)
    main = _llm_result(
        [_ai_dict(1, "keep")],  # item 2 never appears at all — MISSING
        item_provenance={1: ItemValidity.RAW_VALID},
    )
    # Recovery response is locally numbered item_number=1 (single-item
    # call) — must be remapped to item_002, not misread as item_001.
    recovery = _llm_result([_ai_dict(1, "discard")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_002"] == ItemValidity.RECOVERY_USED
    decisions_by_id = {ai.item_id: ai for ai in result.ai_decisions}
    assert decisions_by_id["item_002"].decision == Decision.DISCARD


def test_targeted_recovery_failure_leaves_item_still_invalid_and_incomplete():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "not-a-real-decision")], item_provenance={1: ItemValidity.RAW_VALID})
    recovery = _llm_result([_ai_dict(1, "also-not-real")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_001"] == ItemValidity.STILL_INVALID
    assert result.unresolved_item_ids == ["item_001"]
    assert result.is_complete is False
    assert result.ai_decisions == []
    assert len(result.recovery_failures) == 1
    assert result.recovery_failures[0].stage == "semantic"


def test_recovery_exception_is_visible_in_recovery_failures():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "not-a-real-decision")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, ConnectionError("ollama host unreachable")])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_001"] == ItemValidity.STILL_INVALID
    assert len(result.recovery_failures) == 1
    failure = result.recovery_failures[0]
    assert failure.stage == "call"
    assert failure.exception_type == "ConnectionError"
    assert "ollama host unreachable" in failure.detail


def test_at_most_one_service_level_recovery_call_per_unresolved_item():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "bad-decision")], item_provenance={1: ItemValidity.RAW_VALID})
    recovery = _llm_result([_ai_dict(1, "still-bad")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert len(classifier.calls) == 2  # main + exactly one recovery, never more
    assert result.item_validity["item_001"] == ItemValidity.STILL_INVALID


# ---------------------------------------------------------------------------
# Unexpected extra output
# ---------------------------------------------------------------------------


def test_unexpected_extra_item_number_is_reported_but_creates_no_item():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result(
        [_ai_dict(1, "keep"), _ai_dict(99, "discard")],  # 99 was never requested
        item_provenance={1: ItemValidity.RAW_VALID},
    )
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.expected_item_ids == ["item_001"]
    assert len(result.ai_decisions) == 1
    assert any(w.item_number == 99 for w in result.mapping_warnings)
    assert len(classifier.calls) == 1  # the unexpected entry never triggers recovery


# ---------------------------------------------------------------------------
# Duplicate same-label items map independently
# ---------------------------------------------------------------------------


def test_duplicate_same_label_items_map_independently_by_item_number():
    items = [_item(1, label="stuffed toy"), _item(2, label="stuffed toy")]
    analysis = _analysis(items)
    main = _llm_result(
        [_ai_dict(1, "keep", label="stuffed toy"), _ai_dict(2, "donate", label="stuffed toy")],
        item_provenance={1: ItemValidity.RAW_VALID, 2: ItemValidity.RAW_VALID},
    )
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    decisions_by_id = {ai.item_id: ai.decision for ai in result.ai_decisions}
    assert decisions_by_id == {"item_001": Decision.KEEP, "item_002": Decision.DONATE}


# ---------------------------------------------------------------------------
# Input construction: scene / position / size / user_context / order
# ---------------------------------------------------------------------------


def test_scene_label_reaches_the_classifier():
    items = [_item(1)]
    analysis = _analysis(items, scene_label="kitchen")
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main])

    run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert classifier.calls[0]["scene_label"] == "kitchen"


def test_relative_size_and_position_reach_position_hint():
    item = DetectedItem(
        item_id="item_001",
        source_detection_index=0,
        raw_phrase="lamp",
        clean_label="lamp",
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.3, y2=0.3),
        confidence=0.9,
        position="lower-right",
        relative_size="large",
        item_role="actionable",
        item_role_source="default",
    )
    analysis = _analysis([item])
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main])

    run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert classifier.calls[0]["detected_items"][0]["position_hint"] == "large, lower-right"


def test_user_context_reaches_the_classifier_including_none():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main])

    run_declutter(analysis, user_context=None, llm_classifier=classifier)
    assert classifier.calls[0]["user_context"] is None

    classifier2 = FakeLLMClassifier([main])
    run_declutter(analysis, user_context="downsizing before a move", llm_classifier=classifier2)
    assert classifier2.calls[0]["user_context"] == "downsizing before a move"


def test_recovered_decisions_retain_original_expected_item_order():
    items = [_item(1), _item(2), _item(3)]
    analysis = _analysis(items)
    # item 2 needs recovery (duplicate item_number); items 1 and 3 resolve directly.
    main = _llm_result(
        [_ai_dict(1, "keep"), _ai_dict(2, "donate"), _ai_dict(2, "discard"), _ai_dict(3, "sell")],
        item_provenance={1: ItemValidity.RAW_VALID, 2: ItemValidity.RAW_VALID, 3: ItemValidity.RAW_VALID},
    )
    recovery = _llm_result([_ai_dict(1, "donate")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert [ai.item_id for ai in result.ai_decisions] == ["item_001", "item_002", "item_003"]


def test_no_duplicate_final_item_ids():
    items = [_item(1), _item(2)]
    analysis = _analysis(items)
    main = _llm_result(
        [_ai_dict(1, "keep"), _ai_dict(2, "donate")],
        item_provenance={1: ItemValidity.RAW_VALID, 2: ItemValidity.MECHANICALLY_REPAIRED},
    )
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    ids = [ai.item_id for ai in result.ai_decisions]
    assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# Contextual-item policy
# ---------------------------------------------------------------------------


def test_contextual_items_are_excluded_entirely():
    actionable = _item(1, role="actionable")
    contextual = _item(2, role="contextual")
    analysis = _analysis([actionable, contextual])
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.expected_item_ids == ["item_001"]
    assert "item_002" not in result.item_validity
    assert len(classifier.calls[0]["detected_items"]) == 1  # contextual item never sent to the LLM


# ---------------------------------------------------------------------------
# Empty actionable set
# ---------------------------------------------------------------------------


def test_empty_actionable_set_never_calls_the_classifier():
    analysis = _analysis([_item(1, role="contextual")])
    classifier = FakeLLMClassifier([])  # any call would IndexError — proves zero calls

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.expected_item_ids == []
    assert result.ai_decisions == []
    assert result.unresolved_item_ids == []
    assert result.item_validity == {}
    assert result.is_complete is True
    assert result.is_strictly_valid is True
    assert result.model_name is None
    assert result.prompt_version is None
    assert len(result.stage_timings) == 1
    assert len(classifier.calls) == 0


# ---------------------------------------------------------------------------
# Complete-after-recovery vs strictly-clean
# ---------------------------------------------------------------------------


def test_complete_after_recovery_is_complete_but_not_strictly_valid():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={})  # untrusted provenance
    recovery = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.is_complete is True
    assert result.is_strictly_valid is False


# ---------------------------------------------------------------------------
# Total classifier failure
# ---------------------------------------------------------------------------


def test_total_classifier_exception_on_main_call_raises_declutter_reasoning_error():
    items = [_item(1)]
    analysis = _analysis(items)
    classifier = FakeLLMClassifier([RuntimeError("ollama connection refused")])

    with pytest.raises(DeclutterReasoningError):
        run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert len(classifier.calls) == 1  # never attempts a recovery call after a total failure


# ---------------------------------------------------------------------------
# model_name passthrough
# ---------------------------------------------------------------------------


def test_model_name_passes_through_to_every_classifier_call():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "bad-decision")], item_provenance={1: ItemValidity.RAW_VALID}, model_name="qwen3:8b")
    recovery = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID}, model_name="qwen3:8b")
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier, model_name="qwen3:8b")

    assert classifier.calls[0]["model_name"] == "qwen3:8b"
    assert classifier.calls[1]["model_name"] == "qwen3:8b"
    assert result.model_name == "qwen3:8b"


# ---------------------------------------------------------------------------
# is_strictly_valid: RAW_VALID-only, not just warning/error-free
# ---------------------------------------------------------------------------


def test_all_raw_valid_items_are_complete_and_strictly_valid():
    items = [_item(1), _item(2)]
    analysis = _analysis(items)
    main = _llm_result(
        [_ai_dict(1, "keep"), _ai_dict(2, "donate")],
        item_provenance={1: ItemValidity.RAW_VALID, 2: ItemValidity.RAW_VALID},
    )
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.is_complete is True
    assert result.is_strictly_valid is True


def test_mechanically_repaired_item_is_complete_but_not_strictly_valid():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.MECHANICALLY_REPAIRED})
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.is_complete is True
    assert result.is_strictly_valid is False


def test_internally_recovered_item_is_complete_but_not_strictly_valid():
    items = [_item(1)]
    analysis = _analysis(items)
    # classify_items()'s OWN internal recovery resolved this — zero
    # service-level warnings/errors/failures generated — yet the item
    # still needed help, so it must not count as strictly valid.
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RECOVERY_USED})
    classifier = FakeLLMClassifier([main])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity == {"item_001": ItemValidity.RECOVERY_USED}
    assert len(classifier.calls) == 1  # confirms this is classify_items'-internal recovery, not service-level
    assert result.mapping_warnings == []
    assert result.semantic_errors == []
    assert result.recovery_failures == []
    assert result.provenance_warnings == []
    assert result.is_complete is True
    assert result.is_strictly_valid is False


def test_still_invalid_item_is_neither_complete_nor_strictly_valid():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([_ai_dict(1, "bad-decision")], item_provenance={1: ItemValidity.RAW_VALID})
    recovery = _llm_result([_ai_dict(1, "still-bad")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.is_complete is False
    assert result.is_strictly_valid is False


def test_empty_actionable_set_is_complete_and_strictly_valid():
    analysis = _analysis([_item(1, role="contextual")])
    classifier = FakeLLMClassifier([])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.is_complete is True
    assert result.is_strictly_valid is True


# ---------------------------------------------------------------------------
# reclassify_item() — POST /override's service-level implementation
# ---------------------------------------------------------------------------


def _base_run(item_count: int = 1, decisions: list[str] | None = None) -> tuple[AnalysisResult, DeclutterResult]:
    """A genuine, validator-passing (analysis, declutter) pair, produced
    by run_declutter() itself (not hand-assembled) — exactly the shape
    reclassify_item() actually receives in production."""
    decisions = decisions or ["keep"] * item_count
    items = [_item(n) for n in range(1, item_count + 1)]
    analysis = _analysis(items)
    main = _llm_result(
        [_ai_dict(n, d) for n, d in enumerate(decisions, start=1)],
        item_provenance={n: ItemValidity.RAW_VALID for n in range(1, item_count + 1)},
    )
    declutter = run_declutter(analysis, user_context=None, llm_classifier=FakeLLMClassifier([main]))
    return analysis, declutter


def test_reclassify_item_success_reports_truthful_raw_valid_not_hardcoded_recovery_used():
    analysis, declutter = _base_run()
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert isinstance(result, ReclassifyItemResult)
    assert result.declutter.item_validity["item_001"] == ItemValidity.RAW_VALID  # NOT RECOVERY_USED
    assert result.declutter.is_complete is True


def test_reclassify_item_success_reports_truthful_mechanically_repaired():
    # This is the specific case that would have been mislabeled by
    # blindly reusing _targeted_recovery's hardcoded-RECOVERY_USED
    # convention — the fresh call's own provenance hint must survive
    # into the result unchanged.
    analysis, declutter = _base_run()
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.MECHANICALLY_REPAIRED})
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.item_validity["item_001"] == ItemValidity.MECHANICALLY_REPAIRED


def test_reclassify_item_success_reports_truthful_recovery_used():
    analysis, declutter = _base_run()
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RECOVERY_USED})
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.item_validity["item_001"] == ItemValidity.RECOVERY_USED


def test_reclassify_item_untrusted_provenance_is_not_trusted_as_a_decision():
    analysis, declutter = _base_run()
    # Mapped and semantically valid, but the wrapper never vouched for it
    # (no provenance hint at all) — same conservative rule as
    # run_declutter()'s main pass.
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={})
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.item_validity["item_001"] == ItemValidity.STILL_INVALID
    assert "item_001" not in {ai.item_id for ai in result.declutter.ai_decisions}
    assert "item_001" in result.declutter.unresolved_item_ids
    assert any(w.item_id == "item_001" for w in result.declutter.provenance_warnings)


def test_reclassify_item_mapping_failure_produces_item_id_keyed_recovery_failure():
    analysis, declutter = _base_run()
    reclass_response = _llm_result([], item_provenance={})  # item_number 1 entirely absent
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.item_validity["item_001"] == ItemValidity.STILL_INVALID
    assert "item_001" in result.declutter.unresolved_item_ids
    failures = [f for f in result.declutter.recovery_failures if f.item_id == "item_001"]
    assert len(failures) == 1
    assert failures[0].stage == "mapping"


def test_reclassify_item_semantic_failure_produces_item_id_keyed_recovery_failure():
    analysis, declutter = _base_run()
    reclass_response = _llm_result(
        [_ai_dict(1, "bad-decision")], item_provenance={1: ItemValidity.RAW_VALID}
    )
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.item_validity["item_001"] == ItemValidity.STILL_INVALID
    failures = [f for f in result.declutter.recovery_failures if f.item_id == "item_001"]
    assert len(failures) == 1
    assert failures[0].stage == "semantic"


def test_reclassify_item_classifier_exception_produces_item_id_keyed_recovery_failure():
    analysis, declutter = _base_run()
    classifier = FakeLLMClassifier([RuntimeError("ollama unreachable")])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.item_validity["item_001"] == ItemValidity.STILL_INVALID
    failures = [f for f in result.declutter.recovery_failures if f.item_id == "item_001"]
    assert len(failures) == 1
    assert failures[0].stage == "call"
    assert failures[0].exception_type == "RuntimeError"


def test_reclassify_item_never_appends_locally_renumbered_warnings_to_run_wide_lists():
    # The correction call always numbers its one item "1" locally,
    # regardless of the item's real position — mapping_warnings/
    # semantic_errors (item_number-keyed, no item_id) must stay exactly
    # as they were, never gain a misleading "item_number: 1" entry from
    # this call.
    analysis, declutter = _base_run()
    reclass_response = _llm_result([], item_provenance={})  # triggers a mapping failure
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.mapping_warnings == declutter.mapping_warnings
    assert result.declutter.semantic_errors == declutter.semantic_errors


@pytest.mark.parametrize(
    "response_or_exc",
    [
        _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID}),  # success
        _llm_result([], item_provenance={}),  # failure
    ],
    ids=["success", "failure"],
)
def test_reclassify_item_preserves_identity_and_box_either_way(response_or_exc):
    analysis, declutter = _base_run()
    original = analysis.items[0]
    classifier = FakeLLMClassifier([response_or_exc])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    corrected = result.analysis.items[0]
    assert corrected.item_id == original.item_id
    assert corrected.box == original.box
    assert corrected.raw_phrase == original.raw_phrase
    assert corrected.clean_label == original.clean_label  # never overwritten
    assert corrected.confidence == original.confidence
    assert corrected.position == original.position
    assert corrected.relative_size == original.relative_size
    assert corrected.source_detection_index == original.source_detection_index
    assert corrected.item_role == original.item_role
    assert corrected.item_role_source == original.item_role_source


def test_reclassify_item_failure_still_preserves_the_users_correction_attempt():
    analysis, declutter = _base_run()
    classifier = FakeLLMClassifier([RuntimeError("boom")])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    corrected = result.analysis.items[0]
    assert corrected.corrected_label == "hoodie"
    assert corrected.label_source == "user"
    assert corrected.effective_label == "hoodie"
    # ...even though the reclassification itself failed:
    assert result.declutter.item_validity["item_001"] == ItemValidity.STILL_INVALID
    assert "item_001" not in {ai.item_id for ai in result.declutter.ai_decisions}


def test_reclassify_item_leaves_other_items_completely_untouched():
    analysis, declutter = _base_run(item_count=2, decisions=["keep", "donate"])
    original_item_002 = analysis.items[1]
    original_ai_002 = next(ai for ai in declutter.ai_decisions if ai.item_id == "item_002")
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.analysis.items[1] == original_item_002
    assert result.declutter.item_validity["item_002"] == ItemValidity.RAW_VALID
    new_ai_002 = next(ai for ai in result.declutter.ai_decisions if ai.item_id == "item_002")
    assert new_ai_002 == original_ai_002


def test_reclassify_item_scene_and_user_context_pass_through_unchanged():
    items = [_item(1)]
    analysis = _analysis(items, scene_label="kitchen")
    main = _llm_result([_ai_dict(1, "keep")], item_provenance={1: ItemValidity.RAW_VALID})
    declutter = run_declutter(analysis, user_context="downsizing", llm_classifier=FakeLLMClassifier([main]))

    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([reclass_response])

    reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context="downsizing", llm_classifier=classifier
    )

    assert len(classifier.calls) == 1
    call = classifier.calls[0]
    assert call["scene_label"] == "kitchen"
    assert call["user_context"] == "downsizing"


def test_reclassify_item_sends_effective_label_not_clean_label_to_the_llm():
    analysis, declutter = _base_run()
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([reclass_response])

    reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert classifier.calls[0]["detected_items"] == [
        {"label": "hoodie", "confidence": 0.9, "position_hint": "small, upper-left"}
    ]


def test_reclassify_item_only_calls_the_classifier_once():
    analysis, declutter = _base_run(item_count=2, decisions=["keep", "donate"])
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([reclass_response])

    reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert len(classifier.calls) == 1  # only the target item, never a cascade over the rest


def test_reclassify_item_supersedes_a_prior_recovery_failure_for_the_same_item():
    items = [_item(1)]
    analysis = _analysis(items)
    # Original run: item_001 never resolves at all (both main and its own
    # service-level recovery fail) -- ends up STILL_INVALID with a
    # RecoveryFailure already recorded against it.
    main = _llm_result([], item_provenance={})
    recovery = _llm_result([], item_provenance={})
    declutter = run_declutter(analysis, user_context=None, llm_classifier=FakeLLMClassifier([main, recovery]))
    assert declutter.item_validity["item_001"] == ItemValidity.STILL_INVALID
    assert any(f.item_id == "item_001" for f in declutter.recovery_failures)

    # Now a label correction succeeds cleanly.
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.item_validity["item_001"] == ItemValidity.RAW_VALID
    assert not any(f.item_id == "item_001" for f in result.declutter.recovery_failures)  # stale entry gone


def test_reclassify_item_resolves_a_previously_unresolved_item():
    items = [_item(1)]
    analysis = _analysis(items)
    main = _llm_result([], item_provenance={})
    recovery = _llm_result([], item_provenance={})
    declutter = run_declutter(analysis, user_context=None, llm_classifier=FakeLLMClassifier([main, recovery]))
    assert declutter.is_complete is False
    assert declutter.unresolved_item_ids == ["item_001"]

    reclass_response = _llm_result([_ai_dict(1, "donate")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "storage box", user_context=None, llm_classifier=classifier
    )

    assert result.declutter.is_complete is True
    assert result.declutter.unresolved_item_ids == []
    assert result.declutter.ai_decisions[0].decision == Decision.DONATE


def test_reclassify_item_output_satisfies_declutterresult_and_analysisresult_validators():
    # Reaching these assertions at all is the proof — both are re-
    # constructed via their normal (validating) constructors, not
    # model_copy, inside reclassify_item().
    analysis, declutter = _base_run(item_count=2, decisions=["keep", "donate"])
    reclass_response = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([reclass_response])

    result = reclassify_item(
        analysis, declutter, "item_001", "hoodie", user_context=None, llm_classifier=classifier
    )

    assert isinstance(result.analysis, AnalysisResult)
    assert isinstance(result.declutter, DeclutterResult)
    assert [ai.item_id for ai in result.declutter.ai_decisions] == ["item_001", "item_002"]


# ---------------------------------------------------------------------------
# Dependency-injection boundary: declutter_service must not import
# app.models.mistral_llm (or ollama) at runtime
# ---------------------------------------------------------------------------


def test_declutter_service_import_does_not_pull_in_mistral_llm_or_ollama():
    code = (
        "import sys\n"
        "import app.services.declutter_service\n"
        "heavy = {'app.models.mistral_llm', 'ollama'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr


# ---------------------------------------------------------------------------
# DeclutterResult internal-consistency validator — positive + negative
# ---------------------------------------------------------------------------


def _valid_result_kwargs(**overrides) -> dict:
    base = dict(
        run_id="run1",
        expected_item_ids=["item_001", "item_002"],
        ai_decisions=[AiDecision(item_id="item_001", decision=Decision.KEEP, reason="ok")],
        unresolved_item_ids=["item_002"],
        item_validity={"item_001": ItemValidity.RAW_VALID, "item_002": ItemValidity.STILL_INVALID},
        mapping_warnings=[],
        semantic_errors=[],
        recovery_failures=[],
        provenance_warnings=[],
        model_name="phi4-mini",
        prompt_version="v2",
        stage_timings=[],
    )
    base.update(overrides)
    return base


def test_valid_declutter_result_constructs_cleanly():
    result = DeclutterResult(**_valid_result_kwargs())
    assert result.is_complete is False
    assert result.unresolved_item_ids == ["item_002"]


def test_duplicate_expected_item_ids_rejected():
    with pytest.raises(ValidationError):
        DeclutterResult(**_valid_result_kwargs(expected_item_ids=["item_001", "item_001"]))


def test_item_validity_keys_not_matching_expected_ids_rejected():
    with pytest.raises(ValidationError):
        DeclutterResult(
            **_valid_result_kwargs(item_validity={"item_001": ItemValidity.RAW_VALID})  # item_002 missing
        )


def test_duplicate_ai_decision_item_ids_rejected():
    with pytest.raises(ValidationError):
        DeclutterResult(
            **_valid_result_kwargs(
                expected_item_ids=["item_001"],
                ai_decisions=[
                    AiDecision(item_id="item_001", decision=Decision.KEEP, reason="a"),
                    AiDecision(item_id="item_001", decision=Decision.DONATE, reason="b"),
                ],
                unresolved_item_ids=[],
                item_validity={"item_001": ItemValidity.RAW_VALID},
            )
        )


def test_ai_decision_outside_expected_item_ids_rejected():
    with pytest.raises(ValidationError):
        DeclutterResult(
            **_valid_result_kwargs(
                expected_item_ids=["item_001"],
                ai_decisions=[AiDecision(item_id="item_099", decision=Decision.KEEP, reason="a")],
                unresolved_item_ids=[],
                item_validity={"item_001": ItemValidity.RAW_VALID},
            )
        )


def test_duplicate_unresolved_item_ids_rejected():
    with pytest.raises(ValidationError):
        DeclutterResult(**_valid_result_kwargs(unresolved_item_ids=["item_002", "item_002"]))


def test_unresolved_item_ids_not_matching_still_invalid_set_rejected():
    # item_002 is STILL_INVALID but omitted from unresolved_item_ids.
    with pytest.raises(ValidationError):
        DeclutterResult(**_valid_result_kwargs(unresolved_item_ids=[]))


def test_still_invalid_item_with_an_ai_decision_rejected():
    with pytest.raises(ValidationError):
        DeclutterResult(
            **_valid_result_kwargs(
                ai_decisions=[
                    AiDecision(item_id="item_001", decision=Decision.KEEP, reason="ok"),
                    AiDecision(item_id="item_002", decision=Decision.DISCARD, reason="also has one"),
                ]
            )
        )


def test_non_still_invalid_item_missing_an_ai_decision_rejected():
    with pytest.raises(ValidationError):
        DeclutterResult(
            **_valid_result_kwargs(
                item_validity={"item_001": ItemValidity.RAW_VALID, "item_002": ItemValidity.RAW_VALID},
                unresolved_item_ids=[],
                ai_decisions=[],  # item_001 and item_002 both need one — neither present
            )
        )


def test_ai_decisions_out_of_expected_order_rejected():
    with pytest.raises(ValidationError):
        DeclutterResult(
            **_valid_result_kwargs(
                expected_item_ids=["item_001", "item_002", "item_003"],
                item_validity={
                    "item_001": ItemValidity.RAW_VALID,
                    "item_002": ItemValidity.RAW_VALID,
                    "item_003": ItemValidity.RAW_VALID,
                },
                unresolved_item_ids=[],
                ai_decisions=[
                    # item_003 before item_001 — violates expected_item_ids order
                    AiDecision(item_id="item_003", decision=Decision.KEEP, reason="a"),
                    AiDecision(item_id="item_001", decision=Decision.DONATE, reason="b"),
                    AiDecision(item_id="item_002", decision=Decision.SELL, reason="c"),
                ],
            )
        )


def test_empty_declutter_result_is_valid():
    result = DeclutterResult(
        run_id="run1",
        expected_item_ids=[],
        ai_decisions=[],
        unresolved_item_ids=[],
        item_validity={},
        mapping_warnings=[],
        semantic_errors=[],
        recovery_failures=[],
        provenance_warnings=[],
        model_name=None,
        prompt_version=None,
        stage_timings=[],
    )
    assert result.is_complete is True
    assert result.is_strictly_valid is True


def test_run_declutter_output_always_satisfies_the_validator_end_to_end():
    # Service-level test (as opposed to the direct-construction schema
    # tests above): a realistic mixed run — one raw-valid item, one
    # recovered-after-a-duplicate-item_number item, one still-invalid
    # item — round-tripped through run_declutter(). If any invariant
    # above were violated, DeclutterResult's own validator would have
    # raised inside run_declutter() already; reaching this assertion at
    # all is the proof.
    items = [_item(1), _item(2), _item(3)]
    analysis = _analysis(items)
    main = _llm_result(
        [
            _ai_dict(1, "keep"),
            _ai_dict(2, "donate"),
            _ai_dict(2, "discard"),  # duplicate item_number 2
            _ai_dict(3, "bad-decision"),
        ],
        item_provenance={1: ItemValidity.RAW_VALID, 2: ItemValidity.RAW_VALID, 3: ItemValidity.RAW_VALID},
    )
    recovery_for_2 = _llm_result([_ai_dict(1, "sell")], item_provenance={1: ItemValidity.RAW_VALID})
    recovery_for_3 = _llm_result([_ai_dict(1, "still-bad")], item_provenance={1: ItemValidity.RAW_VALID})
    classifier = FakeLLMClassifier([main, recovery_for_2, recovery_for_3])

    result = run_declutter(analysis, user_context=None, llm_classifier=classifier)

    assert result.item_validity["item_001"] == ItemValidity.RAW_VALID
    assert result.item_validity["item_002"] == ItemValidity.RECOVERY_USED
    assert result.item_validity["item_003"] == ItemValidity.STILL_INVALID
    assert [ai.item_id for ai in result.ai_decisions] == ["item_001", "item_002"]
    assert result.unresolved_item_ids == ["item_003"]
