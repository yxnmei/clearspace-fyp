"""
Unit tests for app/services/reorganise_service.py — plan_reorganisation()'s
orchestration policy (initial attempt, bounded recovery, deterministic
fallback) against an injected fake planner. No real Ollama, no
app.models.reorganise_llm import anywhere in this file, no filesystem/log
side effects.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.reorganise_schemas import (
    KEEP_IN_PLACE_ZONE_NAME,
    PlanProvenance,
    ReorganisePlan,
    ReorganiseZone,
)
from app.core.reorganise_semantic_conversion import PlanConversionError
from app.core.schemas import BoundingBox, DetectedItem, StageTiming
from app.services import reorganise_service
from app.services.reorganise_service import (
    PlanningIssue,
    ReorganisePlanningResult,
    plan_reorganisation,
)


def _item(
    item_id="item_001",
    label="picture frame",
    corrected_label=None,
    position="upper-left",
    relative_size="small",
) -> DetectedItem:
    return DetectedItem(
        item_id=item_id,
        source_detection_index=0,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.2, y2=0.2),
        confidence=0.5,
        position=position,
        relative_size=relative_size,
        corrected_label=corrected_label,
    )


def _valid_raw_plan(item_ids: list[str]) -> dict:
    return {
        "zones": [{"zone_name": KEEP_IN_PLACE_ZONE_NAME, "item_ids": list(item_ids), "instruction": "keep here"}],
        "image_prompt": "a tidy room",
    }


def _dummy_plan(item_ids=("item_001",)) -> ReorganisePlan:
    zone = ReorganiseZone(zone_name=KEEP_IN_PLACE_ZONE_NAME, item_ids=list(item_ids), instruction="keep")
    return ReorganisePlan(zones=[zone], image_prompt="a tidy room")


def _valid_timings() -> list[StageTiming]:
    """The one shape ReorganisePlanningResult.stage_timings now accepts —
    exactly one entry, stage == "reorganise_plan". Used by every direct-
    construction test below that isn't itself testing the timing
    invariant, so those tests fail for the invariant they're actually
    checking, not this one."""
    return [StageTiming(stage="reorganise_plan", duration_ms=1.0)]


class _FakeLLMResult:
    def __init__(
        self,
        parsed_json,
        is_valid_json=True,
        was_repaired=False,
        model_name="fake-model",
        prompt_version="fake-v1",
        raw_text="{}",
    ):
        self.parsed_json = parsed_json
        self.is_valid_json = is_valid_json
        self.was_repaired = was_repaired
        self.model_name = model_name
        self.prompt_version = prompt_version
        self.raw_text = raw_text


def _scripted_planner(results: list):
    """results: a list of either an _FakeLLMResult to return, or an
    Exception instance to raise, one per successive call. Returns
    (planner_callable, calls) — calls records every invocation's kwargs,
    in order."""
    queue = list(results)
    calls: list[dict] = []

    def planner(run_id, selected_items, scene_label, user_context, validation_feedback=None, model_name=None):
        calls.append(
            {
                "run_id": run_id,
                "selected_items": selected_items,
                "scene_label": scene_label,
                "user_context": user_context,
                "validation_feedback": validation_feedback,
                "model_name": model_name,
            }
        )
        result = queue.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    return planner, calls


# --- initial attempt outcomes --------------------------------------------


def test_initial_raw_valid_plan_yields_raw_valid_one_call():
    items = [_item("item_001")]
    planner, calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001"]), was_repaired=False)])

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.provenance == PlanProvenance.RAW_VALID
    assert result.attempts == 1
    assert result.issues == []
    assert len(calls) == 1
    assert result.is_strictly_valid is True


def test_initial_mechanically_repaired_semantically_valid_yields_mechanically_repaired():
    items = [_item("item_001")]
    planner, calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001"]), was_repaired=True)])

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.provenance == PlanProvenance.MECHANICALLY_REPAIRED
    assert result.attempts == 1
    assert len(calls) == 1
    assert result.is_strictly_valid is False


def test_initial_invalid_json_triggers_one_recovery_call():
    items = [_item("item_001")]
    planner, calls = _scripted_planner(
        [_FakeLLMResult(None, is_valid_json=False), _FakeLLMResult(_valid_raw_plan(["item_001"]))]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert len(calls) == 2
    assert calls[1]["validation_feedback"] is not None
    assert result.provenance == PlanProvenance.RECOVERY_USED


def test_initial_semantic_missing_item_recovery_feedback_names_missing_id():
    items = [_item("item_001"), _item("item_002")]
    planner, calls = _scripted_planner(
        [
            _FakeLLMResult(_valid_raw_plan(["item_001"])),  # omits item_002
            _FakeLLMResult(_valid_raw_plan(["item_001", "item_002"])),
        ]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    feedback = calls[1]["validation_feedback"]
    assert any("item_002" in line for line in feedback)
    assert result.provenance == PlanProvenance.RECOVERY_USED


def test_initial_semantic_unexpected_item_recovery_feedback_names_unexpected_id():
    items = [_item("item_001")]
    planner, calls = _scripted_planner(
        [
            _FakeLLMResult(_valid_raw_plan(["item_001", "item_999"])),  # unexpected item_999
            _FakeLLMResult(_valid_raw_plan(["item_001"])),
        ]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    feedback = calls[1]["validation_feedback"]
    assert any("item_999" in line for line in feedback)


def test_initial_call_exception_triggers_recovery():
    items = [_item("item_001")]
    planner, calls = _scripted_planner(
        [RuntimeError("ollama unreachable"), _FakeLLMResult(_valid_raw_plan(["item_001"]))]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert len(calls) == 2
    assert result.provenance == PlanProvenance.RECOVERY_USED
    assert result.issues[0].kind == "call_failed"
    assert result.issues[0].attempt == "initial"


# --- recovery attempt outcomes -------------------------------------------


def test_recovery_mechanically_repaired_success_still_recovery_used():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner(
        [
            _FakeLLMResult(None, is_valid_json=False),
            _FakeLLMResult(_valid_raw_plan(["item_001"]), was_repaired=True),
        ]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.provenance == PlanProvenance.RECOVERY_USED
    assert result.attempts == 2


def test_recovery_call_exception_yields_deterministic_fallback():
    items = [_item("item_001")]
    planner, calls = _scripted_planner(
        [_FakeLLMResult(None, is_valid_json=False), RuntimeError("ollama unreachable again")]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.provenance == PlanProvenance.DETERMINISTIC_FALLBACK
    assert result.attempts == 2
    assert len(calls) == 2


def test_recovery_invalid_json_yields_deterministic_fallback():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner(
        [_FakeLLMResult(None, is_valid_json=False), _FakeLLMResult(None, is_valid_json=False)]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.provenance == PlanProvenance.DETERMINISTIC_FALLBACK


def test_recovery_semantic_invalidity_yields_deterministic_fallback():
    items = [_item("item_001"), _item("item_002")]
    planner, _calls = _scripted_planner(
        [
            _FakeLLMResult(_valid_raw_plan(["item_001"])),  # missing item_002
            _FakeLLMResult(_valid_raw_plan(["item_001"])),  # still missing item_002
        ]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.provenance == PlanProvenance.DETERMINISTIC_FALLBACK
    assert len(result.issues) == 2


def test_never_more_than_two_planner_calls_even_on_repeated_failure():
    items = [_item("item_001")]
    planner, calls = _scripted_planner([RuntimeError("fail 1"), RuntimeError("fail 2")])

    plan_reorganisation("r1", items, "bedroom", None, planner)

    assert len(calls) == 2


# --- fallback content ------------------------------------------------------


def test_fallback_accounts_for_every_selected_item_exactly_once():
    items = [_item("item_001"), _item("item_002"), _item("item_003")]
    planner, _calls = _scripted_planner([RuntimeError("x"), RuntimeError("y")])

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    accounted = {iid for zone in result.plan.zones for iid in zone.item_ids}
    assert accounted == {"item_001", "item_002", "item_003"}


def test_fallback_corrected_label_reaches_image_prompt():
    item = _item("item_001", label="jewelry", corrected_label="necklace")
    planner, _calls = _scripted_planner([RuntimeError("x"), RuntimeError("y")])

    result = plan_reorganisation("r1", [item], "bedroom", None, planner)

    assert "necklace" in result.plan.image_prompt
    assert "jewelry" not in result.plan.image_prompt


def test_duplicate_same_label_instances_remain_separate():
    items = [_item("item_001", label="picture frame"), _item("item_002", label="picture frame")]
    planner, _calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001", "item_002"]))])

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    accounted = {iid for zone in result.plan.zones for iid in zone.item_ids}
    assert accounted == {"item_001", "item_002"}


# --- issue visibility -------------------------------------------------------


def test_initial_and_recovery_issues_remain_visible_and_bounded():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner(
        [_FakeLLMResult(None, is_valid_json=False), _FakeLLMResult(None, is_valid_json=False)]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert len(result.issues) == 2
    assert result.issues[0].attempt == "initial"
    assert result.issues[1].attempt == "recovery"
    for issue in result.issues:
        assert len(issue.detail) <= 500


# --- metadata precedence ----------------------------------------------------


def test_metadata_uses_successful_attempt_when_one_exists():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner(
        [
            _FakeLLMResult(None, is_valid_json=False, model_name="model-a", prompt_version="pv-a"),
            _FakeLLMResult(_valid_raw_plan(["item_001"]), model_name="model-b", prompt_version="pv-b"),
        ]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.model_name == "model-b"
    assert result.prompt_version == "pv-b"


def test_metadata_uses_most_recent_wrapper_result_when_falling_back():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner(
        [
            _FakeLLMResult(None, is_valid_json=False, model_name="model-a", prompt_version="pv-a"),
            _FakeLLMResult(None, is_valid_json=False, model_name="model-b", prompt_version="pv-b"),
        ]
    )

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.provenance == PlanProvenance.DETERMINISTIC_FALLBACK
    assert result.model_name == "model-b"
    assert result.prompt_version == "pv-b"


def test_both_calls_raising_allows_metadata_none():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner([RuntimeError("x"), RuntimeError("y")])

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert result.provenance == PlanProvenance.DETERMINISTIC_FALLBACK
    assert result.model_name is None
    assert result.prompt_version is None


# --- computed strict validity ------------------------------------------------


def test_is_strictly_valid_true_only_for_raw_valid_no_issues():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001"]), was_repaired=False)])
    result = plan_reorganisation("r1", items, "bedroom", None, planner)
    assert result.is_strictly_valid is True


def test_is_strictly_valid_false_for_mechanically_repaired():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001"]), was_repaired=True)])
    result = plan_reorganisation("r1", items, "bedroom", None, planner)
    assert result.is_strictly_valid is False


def test_is_strictly_valid_false_for_deterministic_fallback():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner([RuntimeError("x"), RuntimeError("y")])
    result = plan_reorganisation("r1", items, "bedroom", None, planner)
    assert result.is_strictly_valid is False


# --- PlanningIssue direct-construction invariants ----------------------------


def test_semantic_invalid_issue_without_conversion_errors_rejected():
    with pytest.raises(ValidationError, match="must carry at least one conversion error"):
        PlanningIssue(attempt="initial", kind="semantic_invalid", detail="x")


def test_call_failed_issue_with_conversion_errors_rejected():
    err = PlanConversionError(kind="missing_selected_items", detail="x", item_ids=["item_001"])
    with pytest.raises(ValidationError, match="must not carry conversion_errors"):
        PlanningIssue(attempt="initial", kind="call_failed", detail="x", conversion_errors=[err])


def test_issue_detail_over_500_chars_rejected():
    with pytest.raises(ValidationError):
        PlanningIssue(attempt="initial", kind="call_failed", detail="x" * 501)


# --- ReorganisePlanningResult direct-construction invariants ----------------
#
# Every real output of plan_reorganisation() (see the orchestration tests
# above — one per provenance: RAW_VALID, MECHANICALLY_REPAIRED,
# RECOVERY_USED, DETERMINISTIC_FALLBACK) is itself constructed through
# this exact same validator, unmodified — those tests passing IS the
# proof that every real state-machine output still satisfies the
# strengthened model below; nothing here is a parallel implementation.


def _initial_issue(kind="invalid_json") -> PlanningIssue:
    if kind == "semantic_invalid":
        err = PlanConversionError(kind="missing_selected_items", detail="x", item_ids=["item_001"])
        return PlanningIssue(attempt="initial", kind=kind, detail="x", conversion_errors=[err])
    return PlanningIssue(attempt="initial", kind=kind, detail="x")


def _recovery_issue(kind="invalid_json") -> PlanningIssue:
    if kind == "semantic_invalid":
        err = PlanConversionError(kind="missing_selected_items", detail="x", item_ids=["item_001"])
        return PlanningIssue(attempt="recovery", kind=kind, detail="x", conversion_errors=[err])
    return PlanningIssue(attempt="recovery", kind=kind, detail="x")


def test_raw_valid_with_two_attempts_rejected_directly():
    with pytest.raises(ValidationError, match="raw_valid requires exactly one attempt"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RAW_VALID,
            issues=[],
            attempts=2,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_raw_valid_with_issues_rejected_directly():
    with pytest.raises(ValidationError, match="raw_valid must have zero issues"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RAW_VALID,
            issues=[_initial_issue()],
            attempts=1,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_mechanically_repaired_with_any_issue_rejected_directly():
    with pytest.raises(ValidationError, match="mechanically_repaired must have zero issues"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.MECHANICALLY_REPAIRED,
            issues=[_initial_issue()],
            attempts=1,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


@pytest.mark.parametrize("provenance", [PlanProvenance.RAW_VALID, PlanProvenance.MECHANICALLY_REPAIRED])
def test_raw_or_mechanically_repaired_with_missing_metadata_rejected_directly(provenance):
    with pytest.raises(ValidationError, match="requires non-empty model_name and prompt_version"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=provenance,
            issues=[],
            attempts=1,
            model_name=None,
            prompt_version=None,
            stage_timings=_valid_timings(),
        )


def test_raw_valid_with_blank_model_name_rejected_directly():
    with pytest.raises(ValidationError):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RAW_VALID,
            issues=[],
            attempts=1,
            model_name="   ",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_recovery_used_with_one_attempt_rejected_directly():
    with pytest.raises(ValidationError, match="RECOVERY_USED requires exactly two attempts"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RECOVERY_USED,
            issues=[_initial_issue()],
            attempts=1,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_recovery_used_without_initial_issue_rejected_directly():
    with pytest.raises(ValidationError, match="RECOVERY_USED requires exactly one issue"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RECOVERY_USED,
            issues=[],
            attempts=2,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_recovery_used_with_a_recovery_issue_rejected_directly():
    with pytest.raises(ValidationError, match="RECOVERY_USED requires exactly one issue"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RECOVERY_USED,
            issues=[_initial_issue(), _recovery_issue()],
            attempts=2,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_recovery_used_with_two_initial_issues_rejected_directly():
    with pytest.raises(ValidationError, match="RECOVERY_USED requires exactly one issue"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RECOVERY_USED,
            issues=[_initial_issue("invalid_json"), _initial_issue("call_failed")],
            attempts=2,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_recovery_used_with_missing_metadata_rejected_directly():
    with pytest.raises(ValidationError, match="RECOVERY_USED requires non-empty model_name and prompt_version"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RECOVERY_USED,
            issues=[_initial_issue()],
            attempts=2,
            model_name=None,
            prompt_version=None,
            stage_timings=_valid_timings(),
        )


def test_deterministic_fallback_missing_recovery_issue_rejected_directly():
    with pytest.raises(ValidationError, match="DETERMINISTIC_FALLBACK requires exactly two issues"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.DETERMINISTIC_FALLBACK,
            issues=[_initial_issue()],
            attempts=2,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_deterministic_fallback_with_duplicate_initial_issues_rejected_directly():
    with pytest.raises(ValidationError, match=r"ordered \[initial, recovery\]"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.DETERMINISTIC_FALLBACK,
            issues=[_initial_issue("invalid_json"), _initial_issue("call_failed")],
            attempts=2,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_deterministic_fallback_with_duplicate_recovery_issues_rejected_directly():
    with pytest.raises(ValidationError, match=r"ordered \[initial, recovery\]"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.DETERMINISTIC_FALLBACK,
            issues=[_recovery_issue("invalid_json"), _recovery_issue("call_failed")],
            attempts=2,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_deterministic_fallback_with_reversed_issue_order_rejected_directly():
    with pytest.raises(ValidationError, match=r"ordered \[initial, recovery\]"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.DETERMINISTIC_FALLBACK,
            issues=[_recovery_issue(), _initial_issue()],
            attempts=2,
            model_name="m",
            prompt_version="v1",
            stage_timings=_valid_timings(),
        )


def test_deterministic_fallback_metadata_missing_after_invalid_json_attempt_rejected_directly():
    with pytest.raises(ValidationError, match="metadata may be None only when both attempts were call_failed"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.DETERMINISTIC_FALLBACK,
            issues=[_initial_issue("invalid_json"), _recovery_issue("call_failed")],
            attempts=2,
            model_name=None,
            prompt_version=None,
            stage_timings=_valid_timings(),
        )


def test_deterministic_fallback_both_metadata_none_after_two_call_failures_accepted_directly():
    result = ReorganisePlanningResult(
        run_id="r1",
        plan=_dummy_plan(),
        provenance=PlanProvenance.DETERMINISTIC_FALLBACK,
        issues=[_initial_issue("call_failed"), _recovery_issue("call_failed")],
        attempts=2,
        model_name=None,
        prompt_version=None,
        stage_timings=_valid_timings(),
    )
    assert result.model_name is None
    assert result.prompt_version is None


def test_one_metadata_field_present_without_the_other_rejected_directly():
    with pytest.raises(ValidationError, match="must either both be present or both be None"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RAW_VALID,
            issues=[],
            attempts=1,
            model_name="m",
            prompt_version=None,
            stage_timings=_valid_timings(),
        )


def test_valid_raw_valid_result_constructs_directly():
    result = ReorganisePlanningResult(
        run_id="r1",
        plan=_dummy_plan(),
        provenance=PlanProvenance.RAW_VALID,
        issues=[],
        attempts=1,
        model_name="m",
        prompt_version="v1",
        stage_timings=_valid_timings(),
    )
    assert result.is_strictly_valid is True


# --- stage timing invariant --------------------------------------------------


def test_empty_stage_timings_rejected_directly():
    with pytest.raises(ValidationError, match="exactly one timing"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RAW_VALID,
            issues=[],
            attempts=1,
            model_name="m",
            prompt_version="v1",
            stage_timings=[],
        )


def test_wrong_stage_timing_rejected_directly():
    with pytest.raises(ValidationError, match="exactly one timing"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RAW_VALID,
            issues=[],
            attempts=1,
            model_name="m",
            prompt_version="v1",
            stage_timings=[StageTiming(stage="some_other_stage", duration_ms=1.0)],
        )


def test_duplicate_reorganise_plan_timings_rejected_directly():
    with pytest.raises(ValidationError, match="exactly one timing"):
        ReorganisePlanningResult(
            run_id="r1",
            plan=_dummy_plan(),
            provenance=PlanProvenance.RAW_VALID,
            issues=[],
            attempts=1,
            model_name="m",
            prompt_version="v1",
            stage_timings=[
                StageTiming(stage="reorganise_plan", duration_ms=1.0),
                StageTiming(stage="reorganise_plan", duration_ms=2.0),
            ],
        )


# --- caller-input hardening --------------------------------------------------


@pytest.mark.parametrize(
    "bad_kwargs",
    [
        dict(selected_items=[], scene_label="bedroom", user_context=None),
        dict(
            selected_items=[_item("item_001"), _item("item_001")],
            scene_label="bedroom",
            user_context=None,
        ),
        dict(selected_items=[_item(), {"not": "a DetectedItem"}], scene_label="bedroom", user_context=None),
        dict(selected_items=[_item()], scene_label="   ", user_context=None),
        dict(selected_items="not-a-list", scene_label="bedroom", user_context=None),
        dict(selected_items=[_item()], scene_label="bedroom", user_context=123),
    ],
)
def test_invalid_caller_input_rejected_before_any_planner_call(bad_kwargs):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("planner must not be called for invalid caller input")

    with pytest.raises(ValueError):
        plan_reorganisation(run_id="r1", llm_planner=fail_if_called, **bad_kwargs)


# --- run_id validation ------------------------------------------------------


@pytest.mark.parametrize("bad_run_id", ["", "   ", None, 5, [], {}])
def test_invalid_run_id_rejected_before_any_planner_call(bad_run_id):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("planner must not be called for an invalid run_id")

    with pytest.raises(ValueError):
        plan_reorganisation(bad_run_id, [_item("item_001")], "bedroom", None, fail_if_called)


def test_run_id_whitespace_normalized_consistently_for_planner_calls_and_result():
    items = [_item("item_001")]
    planner, calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001"]))])

    result = plan_reorganisation(" r1 ", items, "bedroom", None, planner)

    assert calls[0]["run_id"] == "r1"
    assert result.run_id == "r1"


# --- stage timing / no side effects ------------------------------------------


def test_stage_timing_returned_in_memory():
    items = [_item("item_001")]
    planner, _calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001"]))])

    result = plan_reorganisation("r1", items, "bedroom", None, planner)

    assert len(result.stage_timings) == 1
    assert result.stage_timings[0].stage == "reorganise_plan"
    assert result.stage_timings[0].duration_ms >= 0.0


def test_no_filesystem_log_side_effect(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    items = [_item("item_001")]
    planner, _calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001"]))])

    plan_reorganisation("r1", items, "bedroom", None, planner)

    assert not (tmp_path / "logs").exists()


def test_unexpected_internal_error_during_validation_is_not_swallowed(monkeypatch):
    items = [_item("item_001")]
    planner, _calls = _scripted_planner([_FakeLLMResult(_valid_raw_plan(["item_001"]))])

    def broken_parse_and_validate_plan(raw, selected_item_ids):
        raise RuntimeError("simulated internal defect")

    monkeypatch.setattr(reorganise_service, "parse_and_validate_plan", broken_parse_and_validate_plan)

    with pytest.raises(RuntimeError, match="simulated internal defect"):
        plan_reorganisation("r1", items, "bedroom", None, planner)


# --- import boundary -------------------------------------------------------


def test_module_import_boundary():
    source = Path(reorganise_service.__file__).read_text(encoding="utf-8")
    forbidden = [
        "import ollama",
        "import torch",
        "import groundingdino",
        "import requests",
        "from app.models",
        "import app.models",
    ]
    for token in forbidden:
        assert token not in source, f"forbidden import found in reorganise_service.py: {token!r}"
