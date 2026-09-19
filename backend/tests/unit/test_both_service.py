"""
Unit tests for app/services/both_service.run_both_generation() — fakes
only, no HTTP, no FastAPI, no real Ollama/Colab call anywhere in this
file. Mirrors tests/unit/test_reorganise_pipeline_service.py's and
tests/unit/test_confirmation_service.py's own fixture/fake conventions
(this module composes both underlying services, so its fixtures compose
both files' patterns).
"""

from __future__ import annotations

import hashlib
import io

import pytest
from PIL import Image
from pydantic import ValidationError

from app.core.confirmation import ConfirmationInputError
from app.core.schemas import (
    AiDecision,
    AnalysisResult,
    BoundingBox,
    Decision,
    DecisionOverride,
    DetectedItem,
    ItemValidity,
    SceneClassification,
)
from app.models.image_gen_client import (
    IMAGE_GEN_API_VERSION,
    GenerationResult,
)
from app.services.both_service import (
    BothGenerationResult,
    BothPipelineInputError,
    EmptyConfirmedKeepError,
    run_both_generation,
)
from app.services.confirmation_service import IncompleteDeclutterError
from app.services.declutter_service import DeclutterResult
from app.services.reorganise_actions_service import ActionPlanProvenance
from app.services.reorganise_pipeline_service import ReorganisePipelineInputError


def _png_bytes(color=(10, 20, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color=color).save(buf, format="PNG")
    return buf.getvalue()


PNG_BYTES = _png_bytes()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _detected_item(item_id: str, index: int, label: str = "lamp", position: str = "upper-left") -> DetectedItem:
    return DetectedItem(
        item_id=item_id,
        source_detection_index=index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.05 * index, y1=0.1, x2=0.05 * index + 0.04, y2=0.2),
        confidence=0.9,
        position=position,
        relative_size="small",
    )


def _analysis_result(
    run_id: str, item_ids: list[str], labels: list[str] | None = None, positions: list[str] | None = None
) -> AnalysisResult:
    labels = labels or ["lamp"] * len(item_ids)
    positions = positions or ["upper-left"] * len(item_ids)
    items = [
        _detected_item(item_id, i, label, position)
        for i, (item_id, label, position) in enumerate(zip(item_ids, labels, positions))
    ]
    return AnalysisResult(
        run_id=run_id,
        scene=SceneClassification(label="bedroom", confidence=0.9, all_scores={"bedroom": 0.9}),
        items=items,
        warnings=[],
        stage_timings=[],
    )


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


class ChecklistSpy:
    """Wraps the REAL plan_reorganise_actions and records each call,
    rather than replacing it with a stub.

    Production injects no checklist model at all: run_both_generation() passes
    action_generator=None, so there is no generator dependency to
    override. What these tests still need to assert is whether the
    checklist stage was reached at all (every validation-rejection test
    asserts it was not), with which selection, and that the generator it
    was given is None. Delegating to the real function means the success
    path exercises the genuine deterministic checklist."""

    def __init__(self, real):
        self._real = real
        self.calls: list[dict] = []

    def __call__(self, run_id, selected_items, scene_label, user_context, generator):
        self.calls.append(
            dict(run_id=run_id, selected_items=selected_items, scene_label=scene_label, user_context=user_context, generator=generator)
        )
        return self._real(
            run_id=run_id, selected_items=selected_items, scene_label=scene_label, user_context=user_context, generator=generator
        )


_planning_spy: ChecklistSpy | None = None


@pytest.fixture(autouse=True)
def _spy_on_checklist(monkeypatch):
    global _planning_spy
    import app.services.reorganise_pipeline_service as pipeline_mod

    spy = ChecklistSpy(pipeline_mod.plan_reorganise_actions)
    monkeypatch.setattr(pipeline_mod, "plan_reorganise_actions", spy)
    _planning_spy = spy
    yield
    _planning_spy = None


class FakeGenerator:
    """Matches ImageGenerator's Protocol shape exactly. Records every
    call for assertion."""

    def __init__(self, result=None, exception=None):
        self.calls: list[dict] = []
        self._result = result
        self._exception = exception

    def __call__(
        self,
        run_id,
        image_bytes,
        image_media_type,
        prompt,
        negative_prompt=None,
        denoise_strength=None,
        controlnet_conditioning_scale=None,
        seed=None,
    ):
        self.calls.append(dict(run_id=run_id, image_bytes=image_bytes, prompt=prompt))
        if self._exception is not None:
            raise self._exception
        if self._result is not None:
            return self._result
        return _generation_result(run_id, image_bytes, prompt)


def _generation_result(run_id: str, image_bytes: bytes, prompt: str) -> GenerationResult:
    return GenerationResult(
        run_id=run_id,
        image_bytes=image_bytes,
        image_media_type="image/png",
        depth_map_used=True,
        denoise_strength=0.35,
        controlnet_conditioning_scale=1.0,
        seed=42,
        base_model="runwayml/stable-diffusion-v1-5",
        controlnet_model="lllyasviel/sd-controlnet-depth",
        service_version="colab-dev-0.1",
        api_version=IMAGE_GEN_API_VERSION,
        prompt_sha256=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        input_image_sha256=hashlib.sha256(image_bytes).hexdigest(),
        generation_ms=1234.5,
    )


def _run(
    run_id="run1",
    analysis=None,
    declutter=None,
    overrides=None,
    image_bytes=PNG_BYTES,
    image_media_type="image/png",
    expected_input_image_sha256=None,
    user_context=None,
    image_generator=None,
):
    if analysis is None:
        analysis = _analysis_result(run_id, ["item_001"])
    if declutter is None:
        declutter = _complete_declutter([("item_001", "keep")], run_id=run_id)
    if expected_input_image_sha256 is None:
        expected_input_image_sha256 = _sha256(image_bytes)
    if image_generator is None:
        image_generator = FakeGenerator()

    return run_both_generation(
        run_id=run_id,
        analysis=analysis,
        declutter=declutter,
        overrides=overrides or [],
        image_bytes=image_bytes,
        image_media_type=image_media_type,
        expected_input_image_sha256=expected_input_image_sha256,
        user_context=user_context,
        image_generator=image_generator,
    )


# ---------------------------------------------------------------------------
# Success path — server-derived selection
# ---------------------------------------------------------------------------


def test_success_derives_selection_from_confirmed_keep_ids_only():
    analysis = _analysis_result("run1", ["item_001", "item_002", "item_003"])
    declutter = _complete_declutter([("item_001", "keep"), ("item_002", "donate"), ("item_003", "keep")])
    loader = _planning_spy
    generator = FakeGenerator()

    result = _run(analysis=analysis, declutter=declutter, image_generator=generator)

    assert isinstance(result, BothGenerationResult)
    assert result.confirmation.confirmed_keep_ids == ["item_001", "item_003"]
    # planning only ever saw the confirmed Keep items, never item_002
    assert [item.item_id for item in loader.calls[0]["selected_items"]] == ["item_001", "item_003"]
    assert result.pipeline.image_status == "generated"
    # truthful provenance: Both makes no checklist-model call at all
    assert loader.calls[0]["generator"] is None
    assert result.pipeline.action_plan.provenance == ActionPlanProvenance.DETERMINISTIC_DIRECT
    assert result.pipeline.action_plan.attempts == 0
    assert result.pipeline.action_plan.issues == []
    assert result.pipeline.action_plan.model_name is None
    assert result.pipeline.action_plan.prompt_version is None
    assert result.pipeline.action_plan.was_repaired is None
    assert result.pipeline.selected_item_ids == ["item_001", "item_003"]
    assert result.pipeline.storage_suggestions == []  # lamps: no evidence, nothing invented
    assert len(loader.calls) == 1
    assert len(generator.calls) == 1


def test_run_both_generation_accepts_no_checklist_model_or_loader():
    import inspect

    parameters = inspect.signature(run_both_generation).parameters
    assert "action_generator_provider" not in parameters
    assert not any("generator" in name and name != "image_generator" for name in parameters)


def test_both_checklist_is_the_same_deterministic_one_direct_reorganise_builds():
    from app.core.reorganise_actions import build_deterministic_checklist

    analysis = _analysis_result("run1", ["item_001", "item_002", "item_003"], labels=["lamp", "cup", "cup"])
    declutter = _complete_declutter([("item_001", "keep"), ("item_002", "keep"), ("item_003", "sell")])
    generator = FakeGenerator()

    result = _run(analysis=analysis, declutter=declutter, image_generator=generator)

    kept = [item for item in analysis.items if item.item_id in ("item_001", "item_002")]
    assert result.pipeline.action_plan.actions == build_deterministic_checklist(kept, "bedroom")
    assert result.pipeline.action_plan.provenance == ActionPlanProvenance.DETERMINISTIC_DIRECT
    assert len(generator.calls) == 1  # the single image call still happens


def test_both_generator_focus_areas_and_suggestions_see_only_confirmed_keep_items():
    analysis = _analysis_result(
        "run1",
        ["item_001", "item_002", "item_003", "item_004"],
        labels=["cable", "charger", "cable", "lamp"],
        positions=["left", "left", "right", "center"],
    )
    declutter = _complete_declutter(
        [("item_001", "keep"), ("item_002", "keep"), ("item_003", "donate"), ("item_004", "keep")]
    )

    result = _run(analysis=analysis, declutter=declutter)

    assert [item.item_id for item in _planning_spy.calls[0]["selected_items"]] == ["item_001", "item_002", "item_004"]
    shown = {item_id for area in result.pipeline.focus_areas for item_id in area.item_ids}
    assert shown == {"item_001", "item_002", "item_004"}
    assert [(area.area_id, area.item_ids) for area in result.pipeline.focus_areas] == [
        ("left", ["item_001", "item_002"]),
        ("centre", ["item_004"]),
    ]
    # evidence comes only from confirmed Keep items; the donated cable never counts
    assert [s.related_item_ids for s in result.pipeline.storage_suggestions] == [["item_001", "item_002"]]
    # the image prompt lists the kept cable once; the donated cable never reaches it
    assert result.pipeline.image_prompt.count("- cable") == 1


def test_overrides_change_the_derived_keep_set_reaching_the_pipeline():
    analysis = _analysis_result("run1", ["item_001", "item_002"])
    declutter = _complete_declutter([("item_001", "discard"), ("item_002", "keep")])
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.KEEP)]
    loader = _planning_spy

    result = _run(analysis=analysis, declutter=declutter, overrides=overrides)

    assert result.confirmation.confirmed_keep_ids == ["item_001", "item_002"]
    assert [item.item_id for item in loader.calls[0]["selected_items"]] == ["item_001", "item_002"]


def test_exclusion_override_removes_item_from_pipeline_selection():
    analysis = _analysis_result("run1", ["item_001", "item_002"])
    declutter = _complete_declutter([("item_001", "keep"), ("item_002", "keep")])
    overrides = [DecisionOverride(item_id="item_002", excluded=True)]
    loader = _planning_spy

    result = _run(analysis=analysis, declutter=declutter, overrides=overrides)

    assert result.confirmation.confirmed_keep_ids == ["item_001"]
    assert [item.item_id for item in loader.calls[0]["selected_items"]] == ["item_001"]


def test_run_id_consistency_across_confirmation_and_pipeline():
    result = _run(run_id="run-xyz", analysis=_analysis_result("run-xyz", ["item_001"]))
    assert result.run_id == "run-xyz"
    assert result.confirmation.run_id == "run-xyz"
    assert result.pipeline.run_id == "run-xyz"


# ---------------------------------------------------------------------------
# Empty confirmed Keep — typed error, zero downstream calls
# ---------------------------------------------------------------------------


def test_empty_confirmed_keep_raises_typed_error():
    declutter = _complete_declutter([("item_001", "sell")])
    with pytest.raises(EmptyConfirmedKeepError):
        _run(declutter=declutter)


def test_empty_confirmed_keep_never_calls_planner_loader_or_generator():
    declutter = _complete_declutter([("item_001", "discard")])
    loader = _planning_spy
    generator = FakeGenerator()

    with pytest.raises(EmptyConfirmedKeepError):
        _run(declutter=declutter, image_generator=generator)

    assert loader.calls == []  # the checklist call is never reached
    assert generator.calls == []


def test_all_keep_but_all_excluded_is_also_empty_keep():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [DecisionOverride(item_id="item_001", excluded=True)]
    loader = _planning_spy

    with pytest.raises(EmptyConfirmedKeepError):
        _run(declutter=declutter, overrides=overrides)

    assert loader.calls == []


# ---------------------------------------------------------------------------
# Confirmation-layer errors propagate unchanged, before any planner/generator call
# ---------------------------------------------------------------------------


def test_incomplete_declutter_propagates_and_blocks_downstream_calls():
    declutter = _incomplete_declutter()
    loader = _planning_spy
    generator = FakeGenerator()

    with pytest.raises(IncompleteDeclutterError):
        _run(
            analysis=_analysis_result("run1", ["item_001"]),
            declutter=declutter,
            image_generator=generator,
        )

    assert loader.calls == []
    assert generator.calls == []


def test_malformed_overrides_propagate_confirmation_input_error():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [DecisionOverride(item_id="item_999", decision=Decision.DISCARD)]
    loader = _planning_spy

    with pytest.raises(ConfirmationInputError):
        _run(declutter=declutter, overrides=overrides)

    assert loader.calls == []


def test_duplicate_overrides_propagate_confirmation_input_error():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [
        DecisionOverride(item_id="item_001", decision=Decision.DONATE),
        DecisionOverride(item_id="item_001", excluded=True),
    ]
    with pytest.raises(ConfirmationInputError):
        _run(declutter=declutter, overrides=overrides)


# ---------------------------------------------------------------------------
# Independent input validation — BothPipelineInputError, before confirmation
# ---------------------------------------------------------------------------


def test_run_id_mismatch_with_analysis_raises_pipeline_input_error():
    analysis = _analysis_result("run-a", ["item_001"])
    declutter = _complete_declutter([("item_001", "keep")], run_id="run-a")
    loader = _planning_spy

    with pytest.raises(BothPipelineInputError):
        _run(run_id="run-b", analysis=analysis, declutter=declutter)

    assert loader.calls == []


def test_run_id_mismatch_with_declutter_raises_pipeline_input_error():
    analysis = _analysis_result("run-a", ["item_001"])
    declutter = _complete_declutter([("item_001", "keep")], run_id="run-b")

    with pytest.raises(BothPipelineInputError):
        _run(run_id="run-a", analysis=analysis, declutter=declutter)


def test_mismatched_expected_ids_raises_pipeline_input_error():
    # analysis has two actionable items; declutter only expects one —
    # not a genuine matched pair from the same run.
    analysis = _analysis_result("run1", ["item_001", "item_002"])
    declutter = _complete_declutter([("item_001", "keep")], run_id="run1")
    loader = _planning_spy

    with pytest.raises(BothPipelineInputError):
        _run(analysis=analysis, declutter=declutter)

    assert loader.calls == []


def test_mismatched_expected_ids_wrong_order_raises_pipeline_input_error():
    analysis = _analysis_result("run1", ["item_001", "item_002"])
    declutter = _complete_declutter([("item_002", "keep"), ("item_001", "keep")], run_id="run1")

    with pytest.raises(BothPipelineInputError):
        _run(analysis=analysis, declutter=declutter)


def test_contextual_items_excluded_from_expected_id_match():
    contextual = _detected_item("item_002", 1, "shelf").model_copy(update={"item_role": "contextual"})
    actionable = _detected_item("item_001", 0, "lamp")
    analysis = AnalysisResult(
        run_id="run1",
        scene=SceneClassification(label="bedroom", confidence=0.9, all_scores={"bedroom": 0.9}),
        items=[actionable, contextual],
        warnings=[],
        stage_timings=[],
    )
    # declutter only expects the actionable item — a genuine matched pair,
    # since expected_item_ids should never include a contextual detection.
    declutter = _complete_declutter([("item_001", "keep")], run_id="run1")

    result = _run(analysis=analysis, declutter=declutter)
    assert result.confirmation.confirmed_keep_ids == ["item_001"]


# ---------------------------------------------------------------------------
# Pipeline-layer errors (image/hash validation) propagate unchanged
# ---------------------------------------------------------------------------


def test_image_hash_mismatch_propagates_reorganise_pipeline_input_error():
    with pytest.raises(ReorganisePipelineInputError):
        _run(expected_input_image_sha256=_sha256(b"some other bytes"))


def test_invalid_image_bytes_propagates_reorganise_pipeline_input_error():
    bad_bytes = b"not a real image"
    with pytest.raises(ReorganisePipelineInputError):
        _run(image_bytes=bad_bytes, expected_input_image_sha256=_sha256(bad_bytes))


# ---------------------------------------------------------------------------
# BothGenerationResult — direct construction invariants
# ---------------------------------------------------------------------------


def test_both_generation_result_rejects_run_id_mismatch_with_confirmation():
    result = _run(run_id="run1")
    with pytest.raises(ValidationError):
        BothGenerationResult(
            run_id="different-run-id",
            confirmation=result.confirmation,
            pipeline=result.pipeline,
        )
