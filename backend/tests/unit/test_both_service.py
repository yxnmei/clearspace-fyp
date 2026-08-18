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
from app.services.reorganise_pipeline_service import ReorganisePipelineInputError


def _png_bytes(color=(10, 20, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color=color).save(buf, format="PNG")
    return buf.getvalue()


PNG_BYTES = _png_bytes()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _detected_item(item_id: str, index: int, label: str = "lamp") -> DetectedItem:
    return DetectedItem(
        item_id=item_id,
        source_detection_index=index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.05 * index, y1=0.1, x2=0.05 * index + 0.04, y2=0.2),
        confidence=0.9,
        position="upper-left",
        relative_size="small",
    )


def _analysis_result(run_id: str, item_ids: list[str], labels: list[str] | None = None) -> AnalysisResult:
    labels = labels or ["lamp"] * len(item_ids)
    items = [_detected_item(item_id, i, label) for i, (item_id, label) in enumerate(zip(item_ids, labels))]
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


def _valid_plan_json(item_ids: list[str]) -> dict:
    return {
        "zones": [{"zone_name": "Keep in place", "item_ids": item_ids, "instruction": "keep as is"}],
        "image_prompt": "a tidy bedroom",
        "negative_prompt": None,
    }


class FakeLLMResult:
    def __init__(self, parsed_json, is_valid_json=True, was_repaired=False, model_name="phi4-mini", prompt_version="v1"):
        self.raw_text = "fake"
        self.parsed_json = parsed_json
        self.is_valid_json = is_valid_json
        self.was_repaired = was_repaired
        self.model_name = model_name
        self.prompt_version = prompt_version


class FakePlanner:
    """Matches app.services.reorganise_service.ReorganisePlanner's
    Protocol shape exactly. Records every call for assertion."""

    def __init__(self, result=None):
        self.calls: list[dict] = []
        self._result = result

    def __call__(self, run_id, selected_items, scene_label, user_context, validation_feedback=None, model_name=None):
        self.calls.append(
            dict(run_id=run_id, selected_items=selected_items, scene_label=scene_label, user_context=user_context)
        )
        if self._result is not None:
            return self._result
        return FakeLLMResult(_valid_plan_json([item.item_id for item in selected_items]))


class LoaderRecorder:
    """A zero-arg loader thunk — matches both_service's
    ReorganisePlannerLoader shape exactly (Callable[[], ReorganisePlanner]).
    Records every call so tests can assert whether/when the real ollama
    import would have happened."""

    def __init__(self, planner: FakePlanner | None = None):
        self.calls = 0
        self._planner = planner or FakePlanner()

    def __call__(self) -> FakePlanner:
        self.calls += 1
        return self._planner


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
    llm_planner_provider=None,
    image_generator=None,
):
    if analysis is None:
        analysis = _analysis_result(run_id, ["item_001"])
    if declutter is None:
        declutter = _complete_declutter([("item_001", "keep")], run_id=run_id)
    if expected_input_image_sha256 is None:
        expected_input_image_sha256 = _sha256(image_bytes)
    if llm_planner_provider is None:
        llm_planner_provider = LoaderRecorder()
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
        llm_planner_provider=llm_planner_provider,
        image_generator=image_generator,
    )


# ---------------------------------------------------------------------------
# Success path — server-derived selection
# ---------------------------------------------------------------------------


def test_success_derives_selection_from_confirmed_keep_ids_only():
    analysis = _analysis_result("run1", ["item_001", "item_002", "item_003"])
    declutter = _complete_declutter([("item_001", "keep"), ("item_002", "donate"), ("item_003", "keep")])
    loader = LoaderRecorder()
    generator = FakeGenerator()

    result = _run(analysis=analysis, declutter=declutter, llm_planner_provider=loader, image_generator=generator)

    assert isinstance(result, BothGenerationResult)
    assert result.confirmation.confirmed_keep_ids == ["item_001", "item_003"]
    # the planner only ever saw the confirmed Keep items, never item_002
    planner = loader._planner
    assert [item.item_id for item in planner.calls[0]["selected_items"]] == ["item_001", "item_003"]
    assert result.pipeline.image_status == "generated"
    assert loader.calls == 1
    assert len(generator.calls) == 1


def test_overrides_change_the_derived_keep_set_reaching_the_pipeline():
    analysis = _analysis_result("run1", ["item_001", "item_002"])
    declutter = _complete_declutter([("item_001", "discard"), ("item_002", "keep")])
    overrides = [DecisionOverride(item_id="item_001", decision=Decision.KEEP)]
    loader = LoaderRecorder()

    result = _run(analysis=analysis, declutter=declutter, overrides=overrides, llm_planner_provider=loader)

    assert result.confirmation.confirmed_keep_ids == ["item_001", "item_002"]
    assert [item.item_id for item in loader._planner.calls[0]["selected_items"]] == ["item_001", "item_002"]


def test_exclusion_override_removes_item_from_pipeline_selection():
    analysis = _analysis_result("run1", ["item_001", "item_002"])
    declutter = _complete_declutter([("item_001", "keep"), ("item_002", "keep")])
    overrides = [DecisionOverride(item_id="item_002", excluded=True)]
    loader = LoaderRecorder()

    result = _run(analysis=analysis, declutter=declutter, overrides=overrides, llm_planner_provider=loader)

    assert result.confirmation.confirmed_keep_ids == ["item_001"]
    assert [item.item_id for item in loader._planner.calls[0]["selected_items"]] == ["item_001"]


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
    loader = LoaderRecorder()
    generator = FakeGenerator()

    with pytest.raises(EmptyConfirmedKeepError):
        _run(declutter=declutter, llm_planner_provider=loader, image_generator=generator)

    assert loader.calls == 0  # the real ollama import never happens
    assert loader._planner.calls == []
    assert generator.calls == []


def test_all_keep_but_all_excluded_is_also_empty_keep():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [DecisionOverride(item_id="item_001", excluded=True)]
    loader = LoaderRecorder()

    with pytest.raises(EmptyConfirmedKeepError):
        _run(declutter=declutter, overrides=overrides, llm_planner_provider=loader)

    assert loader.calls == 0


# ---------------------------------------------------------------------------
# Confirmation-layer errors propagate unchanged, before any planner/generator call
# ---------------------------------------------------------------------------


def test_incomplete_declutter_propagates_and_blocks_downstream_calls():
    declutter = _incomplete_declutter()
    loader = LoaderRecorder()
    generator = FakeGenerator()

    with pytest.raises(IncompleteDeclutterError):
        _run(
            analysis=_analysis_result("run1", ["item_001"]),
            declutter=declutter,
            llm_planner_provider=loader,
            image_generator=generator,
        )

    assert loader.calls == 0
    assert generator.calls == []


def test_malformed_overrides_propagate_confirmation_input_error():
    declutter = _complete_declutter([("item_001", "keep")])
    overrides = [DecisionOverride(item_id="item_999", decision=Decision.DISCARD)]
    loader = LoaderRecorder()

    with pytest.raises(ConfirmationInputError):
        _run(declutter=declutter, overrides=overrides, llm_planner_provider=loader)

    assert loader.calls == 0


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
    loader = LoaderRecorder()

    with pytest.raises(BothPipelineInputError):
        _run(run_id="run-b", analysis=analysis, declutter=declutter, llm_planner_provider=loader)

    assert loader.calls == 0


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
    loader = LoaderRecorder()

    with pytest.raises(BothPipelineInputError):
        _run(analysis=analysis, declutter=declutter, llm_planner_provider=loader)

    assert loader.calls == 0


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
