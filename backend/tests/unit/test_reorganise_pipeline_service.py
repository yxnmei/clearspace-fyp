"""
Unit tests for app/services/reorganise_pipeline_service.run_reorganise_pipeline()
— fake-backed, no HTTP, no FastAPI, no real Ollama/Colab call anywhere in
this file. Fakes satisfy the ReorganiseActionGenerator/ImageGenerator
Protocols structurally, matching this codebase's existing DI-testing
convention.
"""

from __future__ import annotations

import hashlib
import inspect
import io

import pytest
from PIL import Image
from pydantic import ValidationError

from app.core.reorganise_actions import build_deterministic_checklist
from app.core.reorganise_focus_areas import FocusArea
from app.core.reorganise_storage import StorageSuggestion
from app.core.schemas import AnalysisResult, BoundingBox, ConfirmedDecision, Decision, DetectedItem, SceneClassification
from app.models.image_gen_client import (
    IMAGE_GEN_API_VERSION,
    GenerationResult,
    ImageGenRequestError,
    ImageGenResponseError,
    ImageGenServiceError,
    ImageGenTimeoutError,
    ImageGenUnavailableError,
)
from app.services.reorganise_actions_service import ActionPlanProvenance
from app.services.reorganise_pipeline_service import (
    ReorganisePipelineInputError,
    ReorganisePipelineResult,
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


VALID_ACTIONS = {
    "actions": [
        {"priority": 1, "title": "Clear the desk", "instruction": "Group the lamps together and clear around them."},
    ]
}


class FakeLLMResult:
    def __init__(
        self, parsed_json, is_valid_json=True, was_repaired=False, model_name="phi4-mini", prompt_version="reorganise-actions-v1"
    ):
        self.raw_text = "fake"
        self.parsed_json = parsed_json
        self.is_valid_json = is_valid_json
        self.was_repaired = was_repaired
        self.model_name = model_name
        self.prompt_version = prompt_version


class FakeActionGenerator:
    """Matches app.services.reorganise_actions_service.ReorganiseActionGenerator's
    Protocol shape exactly. Records every call for assertion."""

    def __init__(self, result=None, exception=None):
        self.calls: list[dict] = []
        self._result = result
        self._exception = exception

    def __call__(self, run_id, selected_items, scene_label, user_context, model_name=None):
        self.calls.append(
            dict(run_id=run_id, selected_items=selected_items, scene_label=scene_label, user_context=user_context, model_name=model_name)
        )
        if self._exception is not None:
            raise self._exception
        if self._result is not None:
            return self._result
        return FakeLLMResult(VALID_ACTIONS)


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
        action_generator=FakeActionGenerator(),
        image_generator=FakeGenerator(),
    )
    kwargs.update(overrides)
    return kwargs


# ======================================================= success path ====


def test_successful_generation_calls_each_boundary_exactly_once():
    generator = FakeActionGenerator()
    image_generator = FakeGenerator()
    result = run_reorganise_pipeline(**_base_kwargs(action_generator=generator, image_generator=image_generator))

    assert result.image_status == "generated"
    assert len(image_generator.calls) == 1
    assert len(generator.calls) == 1


def _confirmed(item_id: str, decision: Decision) -> ConfirmedDecision:
    return ConfirmedDecision(item_id=item_id, ai_decision=decision, confirmed_decision=decision, ai_reason="reviewed")


def test_tidy_plan_is_present_for_generated_and_unavailable_images():
    generated = run_reorganise_pipeline(**_base_kwargs())
    assert generated.tidy_plan.phases[0].phase_id == "empty_clean"
    assert generated.departing_item_ids == []
    unavailable = run_reorganise_pipeline(**_base_kwargs(image_generator=FakeGenerator(exception=ImageGenUnavailableError("offline"))))
    assert unavailable.tidy_plan == generated.tidy_plan


def test_departing_decisions_must_exist_and_not_overlap_selected():
    analysis = _analysis_result("run1", ["item_001", "item_002"], labels=["lamp", "book"])
    kwargs = _base_kwargs(analysis=analysis, selected_item_ids=["item_001"])
    with pytest.raises(ReorganisePipelineInputError, match="unknown, selected or duplicate"):
        run_reorganise_pipeline(**kwargs, departing_decisions=[_confirmed("item_999", Decision.SELL)])
    with pytest.raises(ReorganisePipelineInputError, match="unknown, selected or duplicate"):
        run_reorganise_pipeline(**kwargs, departing_decisions=[_confirmed("item_001", Decision.SELL)])
    result = run_reorganise_pipeline(**kwargs, departing_decisions=[_confirmed("item_002", Decision.SELL)])
    assert result.departing_item_ids == ["item_002"]
    assert any(step.item_ids == ["item_002"] and "sell" in step.text for phase in result.tidy_plan.phases for step in phase.steps)


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


def test_the_deterministic_image_prompt_reaches_the_generator_and_the_result():
    generator = FakeGenerator()
    result = run_reorganise_pipeline(**_base_kwargs(image_generator=generator, user_context="i want a neat room"))
    prompt = generator.calls[0]["prompt"]
    assert prompt == result.image_prompt
    assert prompt.startswith("A tidy, well-organised bedroom.")
    assert "- lamp (small, upper-left)" in prompt
    assert "i want a neat room" in prompt
    assert generator.calls[0]["negative_prompt"] is None


def test_the_checklist_model_never_writes_the_image_prompt():
    """The generator is given a checklist that mentions a phrase; that
    phrase must never reach the image prompt, which is deterministic."""
    marker = "ZEBRA STRIPED WALLPAPER"
    actions = {"actions": [{"priority": 1, "title": "Paint", "instruction": f"Hang the {marker} behind the lamp."}]}
    image_generator = FakeGenerator()
    result = run_reorganise_pipeline(
        **_base_kwargs(action_generator=FakeActionGenerator(FakeLLMResult(actions)), image_generator=image_generator)
    )
    assert marker in result.action_plan.actions[0].instruction
    assert marker not in image_generator.calls[0]["prompt"]


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


def test_selected_items_reach_the_generator_in_analysis_order_not_request_order():
    run_id = "run1"
    item_ids = ["item_001", "item_002", "item_003"]
    analysis = _analysis_result(run_id, item_ids)
    generator = FakeActionGenerator()
    run_reorganise_pipeline(
        **_base_kwargs(
            run_id=run_id,
            analysis=analysis,
            selected_item_ids=["item_003", "item_001", "item_002"],
            action_generator=generator,
        )
    )
    got_ids = [item.item_id for item in generator.calls[0]["selected_items"]]
    assert got_ids == ["item_001", "item_002", "item_003"]  # analysis.items' own order


def test_effective_label_scene_and_context_reach_the_generator():
    analysis = _analysis_result("run1", ["item_001"], labels=["necklace"])
    generator = FakeActionGenerator()
    run_reorganise_pipeline(
        **_base_kwargs(analysis=analysis, selected_item_ids=["item_001"], action_generator=generator, user_context="calm")
    )
    call = generator.calls[0]
    assert call["selected_items"][0].effective_label == "necklace"
    assert call["scene_label"] == "bedroom"
    assert call["user_context"] == "calm"


def test_complete_action_plan_reaches_the_result_unchanged():
    result = run_reorganise_pipeline(**_base_kwargs())
    plan = result.action_plan
    assert plan.provenance == ActionPlanProvenance.LLM_GENERATED
    assert plan.attempts == 1
    assert plan.issues == []
    assert plan.model_name == "phi4-mini"
    assert plan.prompt_version == "reorganise-actions-v1"
    assert plan.was_repaired is False
    assert plan.duration_ms >= 0
    assert [a.title for a in plan.actions] == ["Clear the desk"]


def test_result_run_id_matches_action_plan_run_id():
    result = run_reorganise_pipeline(**_base_kwargs())
    assert result.run_id == result.action_plan.run_id == "run1"
    assert result.selected_item_ids == ["item_001", "item_002"]


# ================================== checklist fallback inside the pipeline ====


def test_a_failing_checklist_model_falls_back_after_exactly_one_call_and_still_generates_an_image():
    generator = FakeActionGenerator(exception=RuntimeError("ollama unreachable"))
    image_generator = FakeGenerator()
    result = run_reorganise_pipeline(**_base_kwargs(action_generator=generator, image_generator=image_generator))

    assert len(generator.calls) == 1
    assert result.action_plan.provenance == ActionPlanProvenance.DETERMINISTIC_FALLBACK
    assert result.action_plan.attempts == 1
    assert [i.kind for i in result.action_plan.issues] == ["call_failed"]
    assert result.action_plan.model_name is None
    assert result.image_status == "generated"
    assert len(image_generator.calls) == 1


@pytest.mark.parametrize(
    "bad,kind",
    [
        (FakeLLMResult(None, is_valid_json=False), "invalid_json"),
        (FakeLLMResult({"zones": [{"zone_name": "x", "item_ids": ["item_001"], "instruction": "y"}]}), "invalid_actions"),
        (FakeLLMResult({"actions": [{"priority": 1, "title": "Shop", "instruction": "Buy a new shelf for the lamps."}]}), "invalid_actions"),
    ],
    ids=["invalid_json", "zone_plan_shape", "forbidden_content"],
)
def test_invalid_checklist_output_reaches_the_fallback_without_a_second_call(bad, kind):
    generator = FakeActionGenerator(bad)
    result = run_reorganise_pipeline(**_base_kwargs(action_generator=generator))

    assert len(generator.calls) == 1
    assert result.action_plan.provenance == ActionPlanProvenance.DETERMINISTIC_FALLBACK
    assert [i.kind for i in result.action_plan.issues] == [kind]
    assert result.action_plan.actions == build_deterministic_checklist(
        [item for item in _base_kwargs()["analysis"].items], "bedroom"
    )


def test_too_few_actions_for_the_selection_falls_back_after_one_call_and_still_generates_an_image():
    item_ids = ["item_001", "item_002", "item_003"]
    analysis = _analysis_result("run1", item_ids)
    generator = FakeActionGenerator(FakeLLMResult(VALID_ACTIONS))  # one action for three items
    image_generator = FakeGenerator()

    result = run_reorganise_pipeline(
        **_base_kwargs(analysis=analysis, selected_item_ids=list(item_ids), action_generator=generator, image_generator=image_generator)
    )

    assert len(generator.calls) == 1
    assert result.action_plan.provenance == ActionPlanProvenance.DETERMINISTIC_FALLBACK
    assert [i.kind for i in result.action_plan.issues] == ["invalid_actions"]
    assert result.image_status == "generated"
    assert len(image_generator.calls) == 1


def test_the_visual_is_generated_regardless_of_checklist_provenance():
    for generator in (FakeActionGenerator(), FakeActionGenerator(exception=RuntimeError("x")), None):
        image_generator = FakeGenerator()
        result = run_reorganise_pipeline(**_base_kwargs(action_generator=generator, image_generator=image_generator))
        assert result.image_status == "generated"
        assert len(image_generator.calls) == 1
        assert image_generator.calls[0]["prompt"] == result.image_prompt


# ============================================ focus areas and suggestions ====


def test_focus_areas_are_derived_from_positions_count_sorted_and_capped():
    item_ids = [f"item_{n:03d}" for n in range(1, 8)]
    positions = ["upper-left", "left", "lower-left", "center", "right", "upper-right", "odd"]
    analysis = _analysis_result("run1", item_ids, positions=positions)
    result = run_reorganise_pipeline(**_base_kwargs(analysis=analysis, selected_item_ids=list(item_ids)))

    assert [(area.area_id, area.item_ids) for area in result.focus_areas] == [
        ("left", ["item_001", "item_002", "item_003"]),
        ("right", ["item_005", "item_006"]),
        ("centre", ["item_004"]),
    ]
    assert len(result.focus_areas) <= 3


def test_focus_areas_and_suggestions_cover_only_the_selected_items():
    item_ids = ["item_001", "item_002", "item_003", "item_004"]
    analysis = _analysis_result("run1", item_ids, labels=["cable", "charger", "cable", "lamp"], positions=["left"] * 4)
    result = run_reorganise_pipeline(**_base_kwargs(analysis=analysis, selected_item_ids=["item_001", "item_002", "item_004"]))

    shown = {item_id for area in result.focus_areas for item_id in area.item_ids}
    assert shown == {"item_001", "item_002", "item_004"}
    assert [s.related_item_ids for s in result.storage_suggestions] == [["item_001", "item_002"]]


def test_storage_suggestions_are_derived_and_bounded():
    labels = ["cable", "charger", "book", "magazine", "lamp", "toy", "toy"]
    item_ids = [f"item_{n:03d}" for n in range(1, len(labels) + 1)]
    analysis = _analysis_result("run1", item_ids, labels=labels)
    result = run_reorganise_pipeline(**_base_kwargs(analysis=analysis, selected_item_ids=list(item_ids)))

    names = [s.name for s in result.storage_suggestions]
    assert names == [
        "Cable and accessory organiser",
        "Toy container",
        "Bookends or a paper tray",
    ]
    assert len(names) == len(set(names)) <= 3


def test_storage_suggestions_are_empty_without_evidence():
    result = run_reorganise_pipeline(**_base_kwargs())  # two lamps
    assert result.storage_suggestions == []


def test_pipeline_result_rejects_focus_areas_or_suggestions_naming_unselected_items():
    base = run_reorganise_pipeline(**_base_kwargs())
    fields = base.model_dump()
    fields["generation"] = base.generation

    bad_plan = base.tidy_plan.model_dump()
    bad_plan["phases"][0]["steps"][0]["item_ids"] = ["item_999"]
    with pytest.raises(ValidationError, match="tidy step references"):
        ReorganisePipelineResult(**{**fields, "tidy_plan": bad_plan})

    with pytest.raises(ValidationError, match="unselected"):
        ReorganisePipelineResult(**{**fields, "focus_areas": [FocusArea(area_id="left", label="Left side", item_ids=["item_999"])]})
    with pytest.raises(ValidationError, match="unselected"):
        ReorganisePipelineResult(
            **{**fields, "storage_suggestions": [StorageSuggestion(name="Tray", reason="because", related_item_ids=["item_999"])]}
        )
    with pytest.raises(ValidationError, match="more than one focus area"):
        ReorganisePipelineResult(
            **{
                **fields,
                "focus_areas": [
                    FocusArea(area_id="left", label="Left side", item_ids=["item_001"]),
                    FocusArea(area_id="right", label="Right side", item_ids=["item_001"]),
                ],
            }
        )
    with pytest.raises(ValidationError, match="highest first"):
        ReorganisePipelineResult(
            **{
                **fields,
                "focus_areas": [
                    FocusArea(area_id="right", label="Right side", item_ids=["item_002"]),
                    FocusArea(area_id="left", label="Left side", item_ids=["item_001", "item_003"]),
                ],
                "selected_item_ids": ["item_001", "item_002", "item_003"],
            }
        )
    with pytest.raises(ValidationError, match="unique"):
        ReorganisePipelineResult(
            **{
                **fields,
                "storage_suggestions": [
                    StorageSuggestion(name="Tray", reason="a", related_item_ids=["item_001"]),
                    StorageSuggestion(name="tray", reason="b", related_item_ids=["item_002"]),
                ],
            }
        )


def test_pipeline_survives_very_long_corrected_labels_and_still_generates_an_image():
    """Two long corrected labels ending in a matching keyword must never
    push a suggestion reason or a fallback instruction past its schema
    limit and abort the pipeline before image generation."""
    long_label = ("a very long user supplied corrected label " * 10).strip()
    item_ids = ["item_001", "item_002", "item_003"]
    analysis = _analysis_result("run1", item_ids)
    analysis = analysis.model_copy(
        update={
            "items": [
                analysis.items[0].model_copy(update={"corrected_label": long_label + " book"}),
                analysis.items[1].model_copy(update={"corrected_label": long_label + " magazine"}),
                analysis.items[2].model_copy(update={"corrected_label": long_label + " book"}),
            ]
        }
    )
    generator = FakeGenerator()

    result = run_reorganise_pipeline(
        **_base_kwargs(
            analysis=analysis,
            selected_item_ids=list(item_ids),
            action_generator=FakeActionGenerator(exception=RuntimeError("x")),  # force the fallback checklist too
            image_generator=generator,
        )
    )

    assert result.image_status == "generated"
    assert len(generator.calls) == 1
    assert [s.name for s in result.storage_suggestions] == ["Bookends or a paper tray"]
    assert all(len(s.reason) <= 300 for s in result.storage_suggestions)
    assert all(len(a.instruction) <= 300 and len(a.title) <= 80 for a in result.action_plan.actions)


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
def test_typed_image_gen_failure_preserves_checklist_areas_and_suggestions(exception, expected_reason):
    generator = FakeActionGenerator()
    labels = ["cable", "charger"]
    analysis = _analysis_result("run1", ["item_001", "item_002"], labels=labels)
    image_generator = FakeGenerator(exception=exception)
    result = run_reorganise_pipeline(
        **_base_kwargs(analysis=analysis, action_generator=generator, image_generator=image_generator)
    )

    assert result.image_status == "unavailable"
    assert result.image_unavailable_reason == expected_reason
    assert result.generation is None
    # Everything else is real and complete, never discarded on image failure.
    assert result.action_plan.actions
    assert result.focus_areas
    assert [s.name for s in result.storage_suggestions] == ["Cable and accessory organiser"]
    assert result.image_prompt
    assert len(image_generator.calls) == 1
    assert len(generator.calls) == 1


def test_unknown_generator_exception_propagates_uncaught():
    generator = FakeGenerator(exception=RuntimeError("a genuine unexpected failure"))
    with pytest.raises(RuntimeError, match="a genuine unexpected failure"):
        run_reorganise_pipeline(**_base_kwargs(image_generator=generator))


# ============================================== selection validation ====


def _assert_rejected_before_any_call(**overrides):
    generator = FakeActionGenerator()
    image_generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(action_generator=generator, image_generator=image_generator, **overrides))
    assert generator.calls == []
    assert image_generator.calls == []


def test_empty_selection_rejected_before_planning_and_generation():
    _assert_rejected_before_any_call(selected_item_ids=[])


def test_duplicate_selected_ids_rejected_before_planning_and_generation():
    _assert_rejected_before_any_call(selected_item_ids=["item_001", "item_001"])


def test_unknown_selected_id_rejected_before_planning_and_generation():
    _assert_rejected_before_any_call(selected_item_ids=["item_999"])


def test_selection_never_silently_deduplicated():
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=["item_001", "item_002", "item_001"]))


def test_run_id_mismatch_against_analysis_rejected():
    _assert_rejected_before_any_call(run_id="run1", analysis=_analysis_result("a-different-run", ["item_001"]), selected_item_ids=["item_001"])


# ================================================== image validation ====


def test_non_image_bytes_rejected_before_planning_and_generation():
    bad_bytes = b"this is not an image at all"
    _assert_rejected_before_any_call(image_bytes=bad_bytes, expected_input_image_sha256=_sha256(bad_bytes))


def test_media_type_mismatch_rejected_before_planning_and_generation():
    _assert_rejected_before_any_call(image_bytes=PNG_BYTES, image_media_type="image/jpeg", expected_input_image_sha256=_sha256(PNG_BYTES))


def test_truncated_image_rejected_before_planning_and_generation():
    truncated = PNG_BYTES[: len(PNG_BYTES) // 2]
    _assert_rejected_before_any_call(image_bytes=truncated, expected_input_image_sha256=_sha256(truncated))


# =============================================== hash correlation ====


def test_same_image_passes_generation_validation():
    result = run_reorganise_pipeline(**_base_kwargs(image_bytes=PNG_BYTES, expected_input_image_sha256=_sha256(PNG_BYTES)))
    assert result.image_status == "generated"


def test_different_image_with_old_hash_rejected_before_planning():
    _assert_rejected_before_any_call(image_bytes=OTHER_PNG_BYTES, expected_input_image_sha256=_sha256(PNG_BYTES))


def test_malformed_hash_format_rejected_before_planning():
    _assert_rejected_before_any_call(expected_input_image_sha256="not-a-real-hash")


@pytest.mark.parametrize("bad_hash", ["", "F" * 64, "0" * 63, "0" * 65, "not-hex-at-all"])
def test_various_malformed_hash_formats_rejected(bad_hash):
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(expected_input_image_sha256=bad_hash))


def test_hash_mismatch_never_invokes_generator_or_image_generator():
    _assert_rejected_before_any_call(expected_input_image_sha256=_sha256(OTHER_PNG_BYTES))


# ============================================ standalone / no-FastAPI ====


def test_service_level_validation_works_independently_of_fastapi():
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=[]))
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=["item_001", "item_001"]))
    with pytest.raises(ReorganisePipelineInputError):
        run_reorganise_pipeline(**_base_kwargs(selected_item_ids=["item_999"]))


# ============================ the no-model path: action_generator=None ====


def test_direct_path_produces_deterministic_direct_provenance():
    result = run_reorganise_pipeline(**_base_kwargs(action_generator=None))
    plan = result.action_plan
    assert plan.provenance == ActionPlanProvenance.DETERMINISTIC_DIRECT
    assert plan.attempts == 0
    assert plan.issues == []
    assert plan.model_name is None and plan.prompt_version is None and plan.was_repaired is None


def test_direct_path_never_touches_a_generator():
    generator = FakeActionGenerator()
    run_reorganise_pipeline(**_base_kwargs(action_generator=generator))
    assert len(generator.calls) == 1
    run_reorganise_pipeline(**_base_kwargs(action_generator=None))
    assert len(generator.calls) == 1  # unchanged


def test_direct_path_still_generates_an_image():
    generator = FakeGenerator()
    result = run_reorganise_pipeline(**_base_kwargs(action_generator=None, image_generator=generator))
    assert result.image_status == "generated"
    assert len(generator.calls) == 1


def test_action_generator_argument_is_required_with_no_default():
    signature = inspect.signature(run_reorganise_pipeline)
    assert signature.parameters["action_generator"].default is inspect.Parameter.empty


def _grid_item(item_id: str, index: int, label: str = "lamp") -> DetectedItem:
    row, col = divmod(index, 6)
    x1 = round(0.02 + col * 0.16, 4)
    y1 = round(0.02 + row * 0.19, 4)
    positions = ["upper-left", "upper-center", "upper-right", "left", "center", "right"]
    return DetectedItem(
        item_id=item_id,
        source_detection_index=index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=x1, y1=y1, x2=round(x1 + 0.14, 4), y2=round(y1 + 0.17, 4)),
        confidence=0.5,
        position=positions[col],
        relative_size="small",
    )


def test_a_real_28_item_room_with_duplicate_labels_is_handled_without_a_model():
    """The crowded case: 28 real DetectedItems, including duplicate
    labels, through the no-model path. Built locally, not read from
    evaluation/fixtures/, so the production path's correctness never
    depends on an evaluation artefact."""
    labels = (
        ["painting", "jewelry", "mirror"]
        + ["picture frame"] * 6
        + ["plant", "shelf", "toy", "bottle", "toy", "monitor", "chair", "bowl", "plate"]
        + ["speaker", "keyboard", "desk", "mouse", "box", "pillow", "cup", "cup", "bin", "rug"]
    )
    item_ids = [f"item_{n:03d}" for n in range(1, 29)]
    items = [_grid_item(item_id, i, labels[i]) for i, item_id in enumerate(item_ids)]
    analysis = AnalysisResult(
        run_id="run1",
        scene=SceneClassification(label="bedroom", confidence=0.9, all_scores={"bedroom": 0.9}),
        items=items,
        warnings=[],
        stage_timings=[],
    )

    result = run_reorganise_pipeline(
        **_base_kwargs(analysis=analysis, selected_item_ids=list(item_ids), action_generator=None, user_context="i want a neat room")
    )

    assert result.action_plan.provenance == ActionPlanProvenance.DETERMINISTIC_DIRECT
    assert 1 <= len(result.action_plan.actions) <= 5
    # meaningful groups lead (six picture frames, two toys, two cups), then one
    # cleanup for the busiest uncovered area, then the closing check
    titles = [a.title for a in result.action_plan.actions]
    assert titles[:3] == ["Group the picture frame items", "Group the toy items", "Group the cup items"]
    assert titles[-1] == "Do a final space check"
    assert not any(t.startswith(("Start with the", "Tidy the ")) for t in titles), titles
    assert len(titles) == 5
    shown = [item_id for area in result.focus_areas for item_id in area.item_ids]
    assert len(shown) == len(set(shown)) and set(shown) <= set(item_ids)
    assert len(result.focus_areas) == 3
    # three distinct, evidence-backed ideas: the frames + painting as a display
    # group, keyboard + mouse, and the two toys; tableware and the bin/box/shelf
    # motivate nothing and are never offered as a destination
    assert [s.name for s in result.storage_suggestions] == [
        "Dedicated display area",
        "Desktop accessory organiser",
        "Toy container",
    ]
    for suggestion in result.storage_suggestions:
        assert set(suggestion.related_item_ids) <= set(item_ids)
        assert "item_" not in suggestion.reason and "(" not in suggestion.reason
    assert result.image_status == "generated"
