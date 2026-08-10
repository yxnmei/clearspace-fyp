"""
Unit tests for app/core/schemas.py — pure pydantic validation, no model
loading. Covers: Decision enum acceptance/rejection, raw_phrase/clean_label
distinctness, required spatial fields, the shared ItemId/NonEmptyStr types
applied consistently across every schema that uses them, and item_id
uniqueness scoping (within one run vs. across different runs).
"""

import pytest
from pydantic import ValidationError

from app.core.schemas import (
    AiDecision,
    AnalysisResult,
    BoundingBox,
    ConfirmedDecision,
    Decision,
    DecisionOverride,
    DetectedItem,
    MappedLLMItem,
    RunContext,
    SceneClassification,
    validate_unique_item_ids,
)


def _box(**overrides) -> BoundingBox:
    defaults = dict(x1=0.1, y1=0.1, x2=0.5, y2=0.5)
    defaults.update(overrides)
    return BoundingBox(**defaults)


def _item(
    item_id: str = "item_001",
    raw_phrase: str = "stuffed toy plushie",
    clean_label: str = "stuffed toy",
    index: int = 0,
) -> DetectedItem:
    return DetectedItem(
        item_id=item_id,
        source_detection_index=index,
        raw_phrase=raw_phrase,
        clean_label=clean_label,
        box=_box(),
        confidence=0.8,
        position="upper-left",
        relative_size="small",
    )


# --- Decision enum ---


@pytest.mark.parametrize("decision", ["keep", "sell", "donate", "discard"])
def test_all_four_decisions_are_valid(decision):
    ai = AiDecision(item_id="item_001", decision=decision, reason="test")
    assert ai.decision == Decision(decision)


def test_invalid_decision_is_rejected():
    with pytest.raises(ValidationError):
        AiDecision(item_id="item_001", decision="sort through", reason="test")


# --- raw_phrase vs. clean_label ---


def test_raw_phrase_and_clean_label_remain_distinct():
    item = _item(raw_phrase="book notebook magazine document", clean_label="book")
    assert item.raw_phrase == "book notebook magazine document"
    assert item.clean_label == "book"
    assert item.raw_phrase != item.clean_label


# --- required spatial fields ---


def test_missing_position_is_rejected():
    with pytest.raises(ValidationError):
        DetectedItem(
            item_id="item_001",
            source_detection_index=0,
            raw_phrase="x",
            clean_label="x",
            box=_box(),
            confidence=0.5,
            relative_size="small",
        )


def test_missing_relative_size_is_rejected():
    with pytest.raises(ValidationError):
        DetectedItem(
            item_id="item_001",
            source_detection_index=0,
            raw_phrase="x",
            clean_label="x",
            box=_box(),
            confidence=0.5,
            position="center",
        )


def test_blank_position_is_rejected():
    with pytest.raises(ValidationError):
        DetectedItem(
            item_id="item_001",
            source_detection_index=0,
            raw_phrase="x",
            clean_label="x",
            box=_box(),
            confidence=0.5,
            position="   ",
            relative_size="small",
        )


# --- item identity ---


def test_duplicate_labels_receive_different_item_ids():
    first = _item("item_001", clean_label="stuffed toy", index=0)
    second = _item("item_002", clean_label="stuffed toy", index=1)
    assert first.item_id != second.item_id
    assert first.clean_label == second.clean_label  # same label, by design — identity never derives from it
    validate_unique_item_ids([first, second])  # no error


def test_duplicate_item_id_within_one_run_is_rejected():
    items = [_item("item_001", index=0), _item("item_001", index=1)]
    with pytest.raises(ValueError):
        validate_unique_item_ids(items)


def test_same_item_id_valid_in_different_runs():
    run_a_items = [_item("item_001", index=0)]
    run_b_items = [_item("item_001", index=0)]
    # Uniqueness is scoped per call/run, not global — both succeed independently.
    validate_unique_item_ids(run_a_items)
    validate_unique_item_ids(run_b_items)


# --- shared ItemId type, applied consistently ---

_BAD_ITEM_IDS = ["item_1", "item_", "abc", "ITEM_001", "item001", "item_00a", "item_001x"]

_MODELS_WITH_ITEM_ID = [
    pytest.param(
        DetectedItem,
        dict(
            source_detection_index=0,
            raw_phrase="x",
            clean_label="x",
            box=_box(),
            confidence=0.5,
            position="center",
            relative_size="small",
        ),
        id="DetectedItem",
    ),
    pytest.param(AiDecision, dict(decision=Decision.KEEP, reason="x"), id="AiDecision"),
    pytest.param(DecisionOverride, dict(decision=Decision.KEEP), id="DecisionOverride"),
    pytest.param(
        ConfirmedDecision,
        dict(ai_decision=Decision.KEEP, confirmed_decision=Decision.KEEP, ai_reason="x"),
        id="ConfirmedDecision",
    ),
    pytest.param(MappedLLMItem, dict(item_number=1), id="MappedLLMItem"),
]


@pytest.mark.parametrize("bad_item_id", _BAD_ITEM_IDS)
@pytest.mark.parametrize("model_cls,base_kwargs", _MODELS_WITH_ITEM_ID)
def test_malformed_item_id_is_rejected_in_every_schema(model_cls, base_kwargs, bad_item_id):
    with pytest.raises(ValidationError):
        model_cls(item_id=bad_item_id, **base_kwargs)


def test_well_formed_item_id_is_accepted_in_every_schema():
    for model_cls, base_kwargs in [p.values for p in _MODELS_WITH_ITEM_ID]:
        model_cls(item_id="item_001", **base_kwargs)  # must not raise


# --- RunContext.run_id ---


def test_empty_run_id_is_rejected():
    with pytest.raises(ValidationError):
        RunContext(run_id="")


def test_whitespace_only_run_id_is_rejected():
    with pytest.raises(ValidationError):
        RunContext(run_id="   ")


def test_valid_run_id_is_trimmed():
    ctx = RunContext(run_id="  abc123  ")
    assert ctx.run_id == "abc123"


# --- BoundingBox ---


def test_degenerate_box_is_rejected():
    with pytest.raises(ValidationError):
        BoundingBox(x1=0.5, y1=0.5, x2=0.5, y2=0.9)  # zero width


def test_inverted_box_is_rejected():
    with pytest.raises(ValidationError):
        BoundingBox(x1=0.6, y1=0.1, x2=0.2, y2=0.5)  # x2 < x1


# --- SceneClassification ---


def _scene(**overrides) -> dict:
    defaults = dict(label="bedroom", confidence=0.9, all_scores={"bedroom": 0.9, "kitchen": 0.1})
    defaults.update(overrides)
    return defaults


def test_scene_classification_valid_rounded_floating_point_values():
    # Classic float-representation quirk: 0.1 + 0.2 style imprecision.
    # confidence and all_scores[label] represent the same underlying score
    # but aren't bit-identical — isclose, not ==, must accept this.
    sc = SceneClassification(label="bedroom", confidence=0.30000000000000004, all_scores={"bedroom": 0.3, "kitchen": 0.7})
    assert sc.label == "bedroom"


def test_scene_classification_empty_all_scores_is_rejected():
    with pytest.raises(ValidationError):
        SceneClassification(**_scene(all_scores={}))


def test_scene_classification_negative_score_is_rejected():
    with pytest.raises(ValidationError):
        SceneClassification(**_scene(all_scores={"bedroom": 0.9, "kitchen": -0.1}))


def test_scene_classification_score_above_one_is_rejected():
    with pytest.raises(ValidationError):
        SceneClassification(**_scene(all_scores={"bedroom": 1.5, "kitchen": 0.1}, confidence=1.5))


def test_scene_classification_non_finite_score_is_rejected():
    with pytest.raises(ValidationError):
        SceneClassification(**_scene(all_scores={"bedroom": 0.9, "kitchen": float("nan")}))


def test_scene_classification_selected_label_absent_from_all_scores_is_rejected():
    with pytest.raises(ValidationError):
        SceneClassification(**_scene(label="bathroom"))  # "bathroom" not a key in all_scores


def test_scene_classification_confidence_inconsistent_with_selected_score_is_rejected():
    with pytest.raises(ValidationError):
        SceneClassification(**_scene(confidence=0.5))  # all_scores["bedroom"] is 0.9, not 0.5


def test_scene_classification_blank_candidate_name_is_rejected():
    with pytest.raises(ValidationError):
        SceneClassification(**_scene(all_scores={"bedroom": 0.9, "   ": 0.1}))


def test_scene_classification_does_not_require_scores_to_sum_to_one():
    # Deliberately not checked — softmax already guarantees this upstream;
    # this model shouldn't reject a hand-built fixture just because its
    # scores don't happen to sum to exactly 1.
    sc = SceneClassification(label="bedroom", confidence=0.9, all_scores={"bedroom": 0.9, "kitchen": 0.3})
    assert sc.label == "bedroom"


# --- AnalysisResult ---


def _scene_classification() -> SceneClassification:
    return SceneClassification(label="bedroom", confidence=0.9, all_scores={"bedroom": 0.9, "kitchen": 0.1})


def test_analysis_result_rejects_duplicate_item_ids_even_when_constructed_directly():
    # Not routed through analyse_image()/validate_unique_item_ids() at
    # all — this simulates AnalysisResult being reconstructed straight
    # from a frontend/API payload, the path this model-level check exists
    # for (see AnalysisResult's docstring).
    duplicate_items = [_item("item_001", index=0), _item("item_001", index=1)]
    with pytest.raises(ValidationError):
        AnalysisResult(
            run_id="run_1",
            scene=_scene_classification(),
            items=duplicate_items,
            warnings=[],
            stage_timings=[],
        )


def test_analysis_result_accepts_unique_item_ids():
    items = [_item("item_001", index=0), _item("item_002", index=1)]
    result = AnalysisResult(
        run_id="run_1",
        scene=_scene_classification(),
        items=items,
        warnings=[],
        stage_timings=[],
    )
    assert len(result.items) == 2
