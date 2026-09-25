"""
Unit tests for app/core/reorganise_label_corrections.py and for
run_reorganise_pipeline()'s label_corrections parameter. Pure and
fake-backed: the deterministic derivations run for real, the image
generator is a recording fake, no model is called.
"""

from __future__ import annotations

import hashlib
import io

import pytest
from PIL import Image
from pydantic import ValidationError

from app.core.reorganise_label_corrections import (
    MAX_CORRECTED_LABEL_LENGTH,
    LabelCorrectionError,
    ReorganiseLabelCorrection,
    apply_label_corrections,
)
from app.core.schemas import AnalysisResult, BoundingBox, DetectedItem, SceneClassification
from app.models.image_gen_client import IMAGE_GEN_API_VERSION, GenerationResult
from app.services.reorganise_pipeline_service import ReorganisePipelineInputError, run_reorganise_pipeline


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color=(10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


PNG_BYTES = _png_bytes()


def _item(item_id: str, index: int, label: str, position: str = "upper-left") -> DetectedItem:
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


def _analysis(labels: list[str], positions: list[str] | None = None) -> AnalysisResult:
    positions = positions or ["upper-left"] * len(labels)
    return AnalysisResult(
        run_id="run1",
        scene=SceneClassification(label="bedroom", confidence=0.9, all_scores={"bedroom": 0.9}),
        items=[_item(f"item_{i + 1:03d}", i, label, pos) for i, (label, pos) in enumerate(zip(labels, positions))],
        warnings=[],
        stage_timings=[],
    )


def _correction(item_id: str, label: str) -> ReorganiseLabelCorrection:
    return ReorganiseLabelCorrection(item_id=item_id, corrected_label=label)


class FakeGenerator:
    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, run_id, image_bytes, image_media_type, prompt, negative_prompt=None, **_kwargs):
        self.calls.append(dict(run_id=run_id, prompt=prompt))
        return GenerationResult(
            run_id=run_id,
            image_bytes=image_bytes,
            image_media_type="image/png",
            depth_map_used=True,
            denoise_strength=0.35,
            controlnet_conditioning_scale=1.0,
            seed=42,
            base_model="base",
            controlnet_model="controlnet",
            service_version="test",
            api_version=IMAGE_GEN_API_VERSION,
            prompt_sha256=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            input_image_sha256=hashlib.sha256(image_bytes).hexdigest(),
            generation_ms=1.0,
        )


def _run(analysis: AnalysisResult, selected: list[str], corrections, generator: FakeGenerator | None = None):
    return run_reorganise_pipeline(
        run_id="run1",
        analysis=analysis,
        selected_item_ids=selected,
        image_bytes=PNG_BYTES,
        image_media_type="image/png",
        expected_input_image_sha256=hashlib.sha256(PNG_BYTES).hexdigest(),
        user_context=None,
        action_generator=None,
        image_generator=generator or FakeGenerator(),
        label_corrections=corrections,
    )


def _step_texts(result) -> list[str]:
    return [step.text for phase in result.tidy_plan.phases for step in phase.steps]


# ============================================================ schema ====


def test_correction_label_is_trimmed():
    assert _correction("item_001", "  charger  ").corrected_label == "charger"


@pytest.mark.parametrize("label", ["", "   ", "\t"])
def test_blank_correction_label_is_rejected(label):
    with pytest.raises(ValidationError):
        _correction("item_001", label)


def test_correction_label_longer_than_the_limit_is_rejected():
    _correction("item_001", "x" * MAX_CORRECTED_LABEL_LENGTH)  # at the limit: accepted
    with pytest.raises(ValidationError):
        _correction("item_001", "x" * (MAX_CORRECTED_LABEL_LENGTH + 1))


@pytest.mark.parametrize("label", ["phone\ncharger", "phone\rcharger", "phone\x00charger"])
def test_correction_label_with_control_characters_is_rejected(label):
    with pytest.raises(ValidationError):
        _correction("item_001", label)


@pytest.mark.parametrize("item_id", ["", "item_1", "lamp", "item_abc"])
def test_correction_with_a_malformed_item_id_is_rejected(item_id):
    with pytest.raises(ValidationError):
        _correction(item_id, "charger")


def test_correction_rejects_extra_fields():
    with pytest.raises(ValidationError):
        ReorganiseLabelCorrection.model_validate(
            {"item_id": "item_001", "corrected_label": "charger", "label_source": "user"}
        )


# ============================================================= apply ====


def test_apply_sets_corrected_label_and_keeps_the_detector_label_for_provenance():
    analysis = _analysis(["rope", "cable"])

    corrected = apply_label_corrections(analysis, [_correction("item_001", "charger")])

    item = corrected.items[0]
    assert item.corrected_label == "charger"
    assert item.effective_label == "charger"
    assert item.label_source == "user"
    assert item.clean_label == "rope"
    assert item.raw_phrase == "rope"
    assert corrected.items[1] == analysis.items[1]
    assert [i.item_id for i in corrected.items] == ["item_001", "item_002"]


def test_apply_never_mutates_the_input_analysis():
    analysis = _analysis(["rope", "cable"])
    before = analysis.model_dump()

    apply_label_corrections(analysis, [_correction("item_001", "charger")])

    assert analysis.model_dump() == before
    assert analysis.items[0].corrected_label is None


def test_apply_with_no_corrections_changes_nothing():
    analysis = _analysis(["rope", "cable"])
    assert apply_label_corrections(analysis, []).model_dump() == analysis.model_dump()


def test_duplicate_labels_are_corrected_independently_by_item_id():
    analysis = _analysis(["lamp", "lamp", "lamp"])

    corrected = apply_label_corrections(analysis, [_correction("item_002", "desk fan")])

    assert [i.effective_label for i in corrected.items] == ["lamp", "desk fan", "lamp"]
    assert [i.label_source for i in corrected.items] == ["detector", "user", "detector"]


def test_duplicate_correction_item_ids_are_rejected():
    analysis = _analysis(["rope", "cable"])
    with pytest.raises(LabelCorrectionError, match="duplicate"):
        apply_label_corrections(analysis, [_correction("item_001", "charger"), _correction("item_001", "cord")])


def test_unknown_correction_item_id_is_rejected():
    analysis = _analysis(["rope", "cable"])
    with pytest.raises(LabelCorrectionError, match="unknown"):
        apply_label_corrections(analysis, [_correction("item_099", "charger")])


@pytest.mark.parametrize("corrections", [None, {"item_001": "charger"}, [{"item_id": "item_001", "corrected_label": "x"}]])
def test_non_list_or_unvalidated_corrections_are_rejected(corrections):
    with pytest.raises(LabelCorrectionError):
        apply_label_corrections(_analysis(["rope"]), corrections)


# ========================================================== pipeline ====


def test_corrected_label_reaches_tidy_plan_storage_image_prompt_and_checklist():
    analysis = _analysis(["rope", "cable"], ["upper-left", "lower-right"])
    selected = ["item_001", "item_002"]

    baseline = _run(analysis, selected, [])
    generator = FakeGenerator()
    corrected = _run(analysis, selected, [_correction("item_001", "charger")], generator)

    # Baseline: "rope" matches no storage rule and is named as itself.
    assert baseline.storage_suggestions == []
    assert "- rope (small, upper-left)" in baseline.image_prompt

    # Tidy plan: the corrected label is used and the detector label is gone.
    texts = _step_texts(corrected)
    assert any("charger" in text for text in texts)
    assert not any("rope" in text for text in texts)
    # Storage: the corrected label now forms real evidence with the cable.
    assert [(s.name, s.related_item_ids) for s in corrected.storage_suggestions] == [
        ("Cable and accessory organiser", ["item_001", "item_002"])
    ]
    # Image prompt: built from the corrected label, and that prompt is the
    # one actually sent to the image generator.
    assert "- charger (small, upper-left)" in corrected.image_prompt
    assert "rope" not in corrected.image_prompt
    assert generator.calls[0]["prompt"] == corrected.image_prompt
    # Legacy checklist also reads the corrected label.
    assert not any("rope" in action.title or "rope" in action.instruction for action in corrected.action_plan.actions)


def test_correction_does_not_change_the_selection():
    analysis = _analysis(["rope", "cable", "lamp"])

    result = _run(analysis, ["item_001", "item_003"], [_correction("item_001", "charger"), _correction("item_002", "cord")])

    assert result.selected_item_ids == ["item_001", "item_003"]
    # item_002 was corrected but not selected: it never reaches the output.
    assert "cord" not in result.image_prompt
    assert all("item_002" not in s.related_item_ids for s in result.storage_suggestions)
    assert "- charger" in result.image_prompt


def test_duplicate_labels_with_distinct_ids_reach_the_prompt_independently():
    analysis = _analysis(["lamp", "lamp", "lamp"])

    result = _run(analysis, ["item_001", "item_002", "item_003"], [_correction("item_002", "desk fan")])

    listed = [line for line in result.image_prompt.splitlines() if line.startswith("- ")]
    assert listed == ["- lamp (small, upper-left)", "- desk fan (small, upper-left)", "- lamp (small, upper-left)"]


@pytest.mark.parametrize(
    "corrections",
    [
        [_correction("item_001", "charger"), _correction("item_001", "cord")],
        [_correction("item_099", "charger")],
        "charger",
    ],
)
def test_invalid_corrections_are_rejected_before_any_generation(corrections):
    generator = FakeGenerator()
    with pytest.raises(ReorganisePipelineInputError, match="label corrections"):
        _run(_analysis(["rope", "cable"]), ["item_001", "item_002"], corrections, generator)
    assert generator.calls == []


def test_pipeline_does_not_mutate_the_callers_analysis():
    analysis = _analysis(["rope", "cable"])
    before = analysis.model_dump()

    _run(analysis, ["item_001", "item_002"], [_correction("item_001", "charger")])

    assert analysis.model_dump() == before


def test_both_generation_does_not_accept_label_corrections():
    """Both's Keep set and labels come from server-side confirmation; its
    service exposes no correction channel into the shared pipeline."""
    import inspect

    from app.services.both_service import run_both_generation

    assert "label_corrections" not in inspect.signature(run_both_generation).parameters
