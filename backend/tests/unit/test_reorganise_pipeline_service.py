"""
Unit tests for app/services/reorganise_pipeline_service.run_reorganise_pipeline()
— fake-backed, no HTTP, no FastAPI, no real Ollama/Colab call anywhere in
this file. Fakes satisfy the ReorganisePlanner/ImageGenerator Protocols
structurally, matching this codebase's existing DI-testing convention
(see tests/unit/test_reorganise_service.py).
"""

from __future__ import annotations

import hashlib
import inspect
import io

import pytest
from PIL import Image

from app.core.schemas import AnalysisResult, BoundingBox, DetectedItem, SceneClassification
from app.models.image_gen_client import (
    IMAGE_GEN_API_VERSION,
    GenerationResult,
    ImageGenRequestError,
    ImageGenResponseError,
    ImageGenServiceError,
    ImageGenTimeoutError,
    ImageGenUnavailableError,
)
from app.services.reorganise_pipeline_service import (
    ReorganisePipelineInputError,
    run_reorganise_pipeline,
)


def _png_bytes(color=(10, 20, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color=color).save(buf, format="PNG")
    return buf.getvalue()


PNG_BYTES = _png_bytes()
OTHER_PNG_BYTES = _png_bytes(color=(200, 100, 50))


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
            dict(
                run_id=run_id,
                selected_items=selected_items,
                scene_label=scene_label,
                user_context=user_context,
                validation_feedback=validation_feedback,
                model_name=model_name,
            )
        )
        if self._result is not None:
            return self._result
        return FakeLLMResult(_valid_plan_json([item.item_id for item in selected_items]))


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
        self.calls.append(
            dict(
                run_id=run_id,
                image_bytes=image_bytes,
                image_media_type=image_media_type,
                prompt=prompt,
                negative_prompt=negative_prompt,
                denoise_strength=denoise_strength,
                controlnet_conditioning_scale=controlnet_conditioning_scale,
                seed=seed,
            )
        )
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
        prompt_sha256=_sha256(prompt.encode("utf-8")),
        input_image_sha256=_sha256(image_bytes),
        generation_ms=1234.5,
    )


def _base_kwargs(**overrides) -> dict:
    run_id = "run1"
    item_ids = ["item_001", "item_002"]
    analysis = _analysis_result(run_id, item_ids)
    kwargs = dict(
        run_id=run_id,
        analysis=analysis,
        selected_item_ids=list(item_ids),
        image_bytes=PNG_BYTES,
        image_media_type="image/png",
        expected_input_image_sha256=_sha256(PNG_BYTES),
        user_context=None,
        llm_planner=FakePlanner(),
        image_generator=FakeGenerator(),
    )
    kwargs.update(overrides)
    return kwargs


# ======================================================= success path ====


def test_successful_generation_calls_generator_exactly_once():
    planner = FakePlanner()
    generator = FakeGenerator()
    result = run_reorganise_pipeline(**_base_kwargs(llm_planner=planner, image_generator=generator))

    assert result.image_status == "generated"
    assert len(generator.calls) == 1
    assert len(planner.calls) == 1


def test_pipeline_signature_has_no_health_checker_parameter():
    params = inspect.signature(run_reorganise_pipeline).parameters
    assert not any("health" in name for name in params), (
        "run_reorganise_pipeline must never accept a separate health-check callable — "
        "image_gen_client.generate() already performs its own internal health check"
    )


def test_original_image_bytes_reach_generator_unchanged():
    generator = FakeGenerator()
    run_reorganise_pipeline(**_base_kwargs(image_generator=generator))
    assert generator.calls[0]["image_bytes"] == PNG_BYTES
    assert generator.calls[0]["image_media_type"] == "image/png"


def test_plan_prompts_reach_generator_unchanged():
    generator = FakeGenerator()
    run_reorganise_pipeline(**_base_kwargs(image_generator=generator))
    assert generator.calls[0]["prompt"] == "a tidy bedroom"
    assert generator.calls[0]["negative_prompt"] is None


def test_configured_defaults_used_no_tuning_params_passed():
    generator = FakeGenerator()
    run_reorganise_pipeline(**_base_kwargs(image_generator=generator))
    call = generator.calls[0]
    assert call["denoise_strength"] is None
    assert call["controlnet_conditioning_scale"] is None
    assert call["seed"] is None


def test_successful_result_includes_api_version():
    result = run_reorganise_pipeline(**_base_kwargs())
    assert result.generation.api_version == IMAGE_GEN_API_VERSION


def test_selected_items_reach_planner_in_analysis_order_not_request_order():
    run_id = "run1"
    item_ids = ["item_001", "item_002", "item_003"]
    analysis = _analysis_result(run_id, item_ids)
    planner = FakePlanner()
    # Deliberately reversed/shuffled request order.
    run_reorganise_pipeline(
        **_base_kwargs(
            run_id=run_id,
            analysis=analysis,
            selected_item_ids=["item_003", "item_001", "item_002"],
            llm_planner=planner,
        )
    )
    got_ids = [item.item_id for item in planner.calls[0]["selected_items"]]
    assert got_ids == ["item_001", "item_002", "item_003"]  # analysis.items' own order


def test_effective_label_and_spatial_fields_reach_planner():
    run_id = "run1"
    analysis = _analysis_result(run_id, ["item_001"], labels=["necklace"])
    planner = FakePlanner()
    run_reorganise_pipeline(**_base_kwargs(run_id=run_id, analysis=analysis, selected_item_ids=["item_001"], llm_planner=planner))
    selected = planner.calls[0]["selected_items"][0]
    assert selected.effective_label == "necklace"
    assert selected.position == "upper-left"
    assert selected.relative_size == "small"


def test_complete_planning_result_reaches_response_unchanged():
    result = run_reorganise_pipeline(**_base_kwargs())
    assert result.planning.attempts == 1
    assert result.planning.provenance.value == "raw_valid"
    assert result.planning.issues == []
    assert result.planning.model_name == "phi4-mini"
    assert result.planning.prompt_version == "v1"
    assert len(result.planning.stage_timings) == 1
    assert result.planning.stage_timings[0].stage == "reorganise_plan"


def test_result_run_id_matches_planning_run_id():
    result = run_reorganise_pipeline(**_base_kwargs())
    assert result.run_id == result.planning.run_id == "run1"


# ================================================== image-gen failures ====


@pytest.mark.parametrize(
    "exception,expected_reason",
    [
        (ImageGenUnavailableError("down"), "service_unreachable"),
        (ImageGenTimeoutError("timed out"), "timeout"),
        (ImageGenRequestError("connection reset"), "request_failed"),
        (ImageGenServiceError("bad status", status_code=500), "service_error"),
        (ImageGenResponseError("malformed"), "invalid_response"),
    ],
)
def test_typed_image_gen_failure_preserves_plan_and_maps_reason(exception, expected_reason):
    planner = FakePlanner()
    generator = FakeGenerator(exception=exception)
    result = run_reorganise_pipeline(**_base_kwargs(llm_planner=planner, image_generator=generator))

    assert result.image_status == "unavailable"
    assert result.image_unavailable_reason == expected_reason
    assert result.generation is None
    # The plan itself is real and complete — never discarded on image failure.
    assert result.planning.plan is not None
    assert result.planning.plan.zones
    assert len(generator.calls) == 1
    assert len(planner.calls) == 1


def test_image_gen_unavailable_error_preserves_completed_plan():
    generator = FakeGenerator(exception=ImageGenUnavailableError("service unreachable"))
    result = run_reorganise_pipeline(**_base_kwargs(image_generator=generator))
    assert result.image_status == "unavailable"
    assert result.image_unavailable_reason == "service_unreachable"
    assert result.planning.plan is not None
    ids_in_plan = {iid for zone in result.planning.plan.zones for iid in zone.item_ids}
    assert ids_in_plan == {"item_001", "item_002"}


def test_unknown_generator_exception_propagates_uncaught():
    generator = FakeGenerator(exception=RuntimeError("a genuine unexpected failure"))
    with pytest.raises(RuntimeError, match="a genuine unexpected failure"):
        run_reorganise_pipeline(**_base_kwargs(image_generator=generator))


# ============================================== selection validation ====


def test_empty_selection_rejected_before_planning_and_generation():
    planner = FakePlanner()
    generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=[], llm_planner=planner, image_generator=generator))
    assert planner.calls == []
    assert generator.calls == []


def test_duplicate_selected_ids_rejected_before_planning_and_generation():
    planner = FakePlanner()
    generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(selected_item_ids=["item_001", "item_001"], llm_planner=planner, image_generator=generator)
        )
    assert planner.calls == []
    assert generator.calls == []


def test_unknown_selected_id_rejected_before_planning_and_generation():
    planner = FakePlanner()
    generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(selected_item_ids=["item_999"], llm_planner=planner, image_generator=generator)
        )
    assert planner.calls == []
    assert generator.calls == []


def test_selection_never_silently_deduplicated():
    # A duplicate must raise, never silently collapse to one item.
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=["item_001", "item_002", "item_001"]))


def test_run_id_mismatch_against_analysis_rejected():
    run_id = "run1"
    analysis = _analysis_result("a-different-run", ["item_001"])
    planner = FakePlanner()
    generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(
                run_id=run_id,
                analysis=analysis,
                selected_item_ids=["item_001"],
                llm_planner=planner,
                image_generator=generator,
            )
        )
    assert planner.calls == []
    assert generator.calls == []


# ================================================== image validation ====


def test_non_image_bytes_rejected_before_planning_and_generation():
    planner = FakePlanner()
    generator = FakeGenerator()
    bad_bytes = b"this is not an image at all"
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(
                image_bytes=bad_bytes,
                expected_input_image_sha256=_sha256(bad_bytes),
                llm_planner=planner,
                image_generator=generator,
            )
        )
    assert planner.calls == []
    assert generator.calls == []


def test_media_type_mismatch_rejected_before_planning_and_generation():
    planner = FakePlanner()
    generator = FakeGenerator()
    # Real PNG bytes, claimed as JPEG.
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(
                image_bytes=PNG_BYTES,
                image_media_type="image/jpeg",
                expected_input_image_sha256=_sha256(PNG_BYTES),
                llm_planner=planner,
                image_generator=generator,
            )
        )
    assert planner.calls == []
    assert generator.calls == []


def test_truncated_image_rejected_before_planning_and_generation():
    planner = FakePlanner()
    generator = FakeGenerator()
    truncated = PNG_BYTES[: len(PNG_BYTES) // 2]
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(
                image_bytes=truncated,
                expected_input_image_sha256=_sha256(truncated),
                llm_planner=planner,
                image_generator=generator,
            )
        )
    assert planner.calls == []
    assert generator.calls == []


# =============================================== hash correlation ====


def test_same_image_passes_generation_validation():
    result = run_reorganise_pipeline(**_base_kwargs(image_bytes=PNG_BYTES, expected_input_image_sha256=_sha256(PNG_BYTES)))
    assert result.image_status == "generated"


def test_different_image_with_old_hash_rejected_before_planning():
    planner = FakePlanner()
    generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(
                image_bytes=OTHER_PNG_BYTES,
                expected_input_image_sha256=_sha256(PNG_BYTES),  # hash of a DIFFERENT image
                llm_planner=planner,
                image_generator=generator,
            )
        )
    assert planner.calls == []
    assert generator.calls == []


def test_malformed_hash_format_rejected_before_planning():
    planner = FakePlanner()
    generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(expected_input_image_sha256="not-a-real-hash", llm_planner=planner, image_generator=generator)
        )
    assert planner.calls == []
    assert generator.calls == []


@pytest.mark.parametrize("bad_hash", ["", "F" * 64, "0" * 63, "0" * 65, "not-hex-at-all"])
def test_various_malformed_hash_formats_rejected(bad_hash):
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(expected_input_image_sha256=bad_hash))


def test_hash_mismatch_never_invokes_planner_or_generator():
    planner = FakePlanner()
    generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(
            **_base_kwargs(
                expected_input_image_sha256=_sha256(OTHER_PNG_BYTES),
                llm_planner=planner,
                image_generator=generator,
            )
        )
    assert planner.calls == []
    assert generator.calls == []


# ============================================ standalone / no-FastAPI ====


def test_service_level_validation_works_independently_of_fastapi():
    # No TestClient, no app, no HTTP anywhere in this test — proves the
    # pipeline rejects bad input on its own, not only via a route schema.
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=[]))
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=["item_001", "item_001"]))
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=["item_999"]))
