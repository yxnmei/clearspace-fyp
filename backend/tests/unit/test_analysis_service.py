"""
Unit tests for app/services/analysis_service.analyse_image() — pure logic
plus PIL (a lightweight, always-installed dependency, not a "model") for
the input-image validity check. No import of app.models.clip_scene or
app.models.grounding_dino anywhere in this file, on purpose: those modules
import torch/numpy/clip at module scope, and the whole point of
analyse_image()'s Protocol-based dependency injection is that tests never
need to pay that cost. Fakes below satisfy the Protocols structurally.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import pytest
from PIL import Image

from app.services.analysis_service import (
    DetectionError,
    InvalidImageError,
    SceneClassificationError,
    analyse_image,
)


def _tiny_valid_image_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (10, 10), color=(255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


@dataclass
class FakeDetection:
    """Matches app.services.analysis_service.RawDetectionLike's shape —
    mirrors app.models.grounding_dino.RawDetection's fields exactly,
    without importing that module."""

    label: str
    box_xyxy: tuple[float, float, float, float]
    confidence: float


VALID_IMAGE = _tiny_valid_image_bytes()
DEFAULT_SCENE = {"label": "bedroom", "confidence": 0.9, "all_scores": {"bedroom": 0.9, "kitchen": 0.1}}


def _classifier(scene: dict = DEFAULT_SCENE):
    def _call(image_bytes: bytes) -> dict:
        return scene

    return _call


def _detector(detections: list):
    def _call(image_bytes: bytes) -> list:
        return detections

    return _call


def _raising_classifier(exc: Exception = RuntimeError("clip is down")):
    def _call(image_bytes: bytes) -> dict:
        raise exc

    return _call


def _raising_detector(exc: Exception = RuntimeError("grounding dino is down")):
    def _call(image_bytes: bytes) -> list:
        raise exc

    return _call


# --- successful runs ---


def test_successful_scene_plus_detections():
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.8),
        FakeDetection(label="book", box_xyxy=(0.5, 0.5, 0.7, 0.7), confidence=0.6),
    ]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))

    assert result.run_id == "run_1"
    assert result.scene.label == "bedroom"
    assert result.scene.confidence == 0.9
    assert len(result.items) == 2
    assert result.warnings == []
    stage_names = [t.stage for t in result.stage_timings]
    assert stage_names == ["validate_image", "classify_scene", "detect_objects", "postprocess_detections"]
    assert all(t.duration_ms >= 0 for t in result.stage_timings)


def test_empty_detection_result():
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector([]))
    assert result.items == []
    assert result.warnings == []
    assert result.scene.label == "bedroom"  # scene still populated even with zero detections


# --- item identity ---


def test_two_same_label_detections_receive_different_ids():
    # "lamp" is a single-token label — clean_label() is a no-op on it, so
    # this test stays focused on identity, not label-cleanup behaviour
    # (a compound like "stuffed toy" isn't in KNOWN_MULTIWORD_LABELS and
    # would fall to clean_label's existing fallback behaviour ("stuffed",
    # first-token) — pre-existing and not what this test is about, but not
    # a claim that the fallback's output is semantically correct either).
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.0, 0.0, 0.2, 0.2), confidence=0.7),
        FakeDetection(label="lamp", box_xyxy=(0.6, 0.6, 0.8, 0.8), confidence=0.7),
    ]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    assert len(result.items) == 2
    assert result.items[0].item_id != result.items[1].item_id
    assert result.items[0].clean_label == result.items[1].clean_label == "lamp"


def test_stable_ids_within_one_returned_analysis():
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.0, 0.0, 0.1, 0.1), confidence=0.7),
        FakeDetection(label="book", box_xyxy=(0.2, 0.2, 0.3, 0.3), confidence=0.7),
        FakeDetection(label="cable", box_xyxy=(0.4, 0.4, 0.5, 0.5), confidence=0.7),
    ]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    ids = [item.item_id for item in result.items]
    assert len(ids) == len(set(ids))  # all unique
    assert ids == ["item_001", "item_002", "item_003"]


# --- deterministic spatial ordering ---


def test_deterministic_spatial_ordering():
    # Deliberately submitted out of visual order — top-to-bottom then
    # left-to-right is expected regardless of detector output order.
    detections = [
        FakeDetection(label="bottom_right", box_xyxy=(0.7, 0.7, 0.9, 0.9), confidence=0.7),
        FakeDetection(label="top_left", box_xyxy=(0.0, 0.0, 0.2, 0.2), confidence=0.7),
        FakeDetection(label="top_right", box_xyxy=(0.7, 0.0, 0.9, 0.2), confidence=0.7),
    ]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    assert [item.clean_label for item in result.items] == ["top_left", "top_right", "bottom_right"]


# --- raw_phrase / clean_label preservation ---


def test_raw_phrase_and_clean_label_preservation():
    detections = [FakeDetection(label="book notebook magazine document", box_xyxy=(0.1, 0.1, 0.2, 0.2), confidence=0.7)]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    assert result.items[0].raw_phrase == "book notebook magazine document"
    assert result.items[0].clean_label == "book"


# --- position / relative_size ---


def test_position_and_relative_size_derivation():
    detections = [FakeDetection(label="lamp", box_xyxy=(0.7, 0.7, 0.95, 0.95), confidence=0.7)]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    item = result.items[0]
    assert item.relative_size == "medium"
    assert item.position == "lower-right"


# --- malformed detection handling ---


def test_malformed_box_is_skipped_with_warning_others_still_processed():
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.5, 0.5, 0.1, 0.1), confidence=0.7),  # inverted box
        FakeDetection(label="book", box_xyxy=(0.1, 0.1, 0.2, 0.2), confidence=0.7),  # fine
    ]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    assert len(result.items) == 1
    assert result.items[0].clean_label == "book"
    assert len(result.warnings) == 1
    assert result.warnings[0].kind == "malformed_detection"
    assert result.warnings[0].source_detection_index == 0


def test_confidence_out_of_range_is_skipped_with_warning():
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.2, 0.2), confidence=1.5),
        FakeDetection(label="book", box_xyxy=(0.3, 0.3, 0.4, 0.4), confidence=-0.1),
        FakeDetection(label="cable", box_xyxy=(0.5, 0.5, 0.6, 0.6), confidence=0.5),
    ]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    assert len(result.items) == 1
    assert result.items[0].clean_label == "cable"
    assert len(result.warnings) == 2
    assert all(w.kind == "malformed_detection" for w in result.warnings)


def test_source_detection_index_is_preserved_for_traceability():
    detections = [
        FakeDetection(label="a", box_xyxy=(0.7, 0.7, 0.8, 0.8), confidence=0.7),  # index 0, sorts last
        FakeDetection(label="b", box_xyxy=(0.0, 0.0, 0.1, 0.1), confidence=0.7),  # index 1, sorts first
    ]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    # Sorted order differs from detector order, but source_detection_index
    # still traces each item back to its original detector output position.
    assert result.items[0].clean_label == "b"
    assert result.items[0].source_detection_index == 1
    assert result.items[1].clean_label == "a"
    assert result.items[1].source_detection_index == 0


# --- detector top-level response shape ---
# Distinct from "malformed entry inside a valid list" above: these are
# cases where the detector didn't return a list at all — must raise
# DetectionError directly, not silently iterate wrong (e.g. iterating a
# dict yields its keys; iterating a string/bytes yields characters/ints)
# and produce a confusing pile of unrelated per-item warnings instead.


@pytest.mark.parametrize(
    "bad_return_value",
    [None, {"label": "lamp"}, "not a list", b"not a list"],
    ids=["none", "dict", "string", "bytes"],
)
def test_non_list_detector_response_raises_detection_error(bad_return_value):
    with pytest.raises(DetectionError):
        analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(bad_return_value))


def test_valid_empty_list_detector_response_is_a_successful_analysis():
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector([]))
    assert result.items == []
    assert result.warnings == []


def test_malformed_entries_inside_a_valid_list_remain_individual_warnings():
    # Contrast case: the top-level shape (a list) is correct, so this must
    # NOT raise DetectionError — only the one bad entry becomes a warning,
    # exactly like test_malformed_box_is_skipped_with_warning above.
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.5, 0.5, 0.1, 0.1), confidence=0.7),  # inverted box
        FakeDetection(label="book", box_xyxy=(0.1, 0.1, 0.2, 0.2), confidence=0.7),  # fine
    ]
    result = analyse_image(VALID_IMAGE, "run_1", _classifier(), _detector(detections))
    assert len(result.items) == 1
    assert len(result.warnings) == 1
    assert result.warnings[0].kind == "malformed_detection"


# --- stage failures: distinguishable by type ---


def test_invalid_image_raises_before_any_model_call():
    calls = []
    classifier = _classifier()
    detector = _detector([])

    def _tracking_classifier(image_bytes):
        calls.append("classify")
        return classifier(image_bytes)

    def _tracking_detector(image_bytes):
        calls.append("detect")
        return detector(image_bytes)

    with pytest.raises(InvalidImageError):
        analyse_image(b"not an image", "run_1", _tracking_classifier, _tracking_detector)
    assert calls == []  # neither stage was ever reached


def test_clip_failure_raises_scene_classification_error():
    with pytest.raises(SceneClassificationError):
        analyse_image(VALID_IMAGE, "run_1", _raising_classifier(), _detector([]))


def test_detector_failure_raises_detection_error():
    with pytest.raises(DetectionError):
        analyse_image(VALID_IMAGE, "run_1", _classifier(), _raising_detector())


def test_clip_and_detector_failures_are_distinguishable_types():
    assert not issubclass(SceneClassificationError, DetectionError)
    assert not issubclass(DetectionError, SceneClassificationError)

    with pytest.raises(SceneClassificationError):
        try:
            analyse_image(VALID_IMAGE, "run_1", _raising_classifier(), _detector([]))
        except DetectionError:
            pytest.fail("scene classifier failure must not raise DetectionError")


def test_malformed_scene_response_raises_scene_classification_error():
    # classify_scene's contract requires label/confidence/all_scores —
    # a response missing a required field must fail loudly, not silently
    # produce a broken AnalysisResult.
    bad_classifier = _classifier({"label": "bedroom"})  # missing confidence, all_scores
    with pytest.raises(SceneClassificationError):
        analyse_image(VALID_IMAGE, "run_1", bad_classifier, _detector([]))
