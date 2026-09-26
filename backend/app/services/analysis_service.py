"""Shared scene classification and object detection for every workflow.

Injected Protocols keep model dependencies outside this service. Stage
failures remain typed; a malformed individual detection becomes a warning
and does not discard valid detections.

No duplicate suppression is applied. A 2026-08-01 run confirmed that six
same-label picture-frame boxes were distinct objects, so every valid
detection remains independently identifiable.
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass
from typing import Protocol

from PIL import Image

from app.core.box_descriptors import describe_box_parts
from app.core.label_cleanup import clean_label
from app.core.schemas import (
    AnalysisResult,
    AnalysisWarning,
    BoundingBox,
    DetectedItem,
    SceneClassification,
    StageTiming,
    validate_unique_item_ids,
)


class InvalidImageError(ValueError):
    """The input cannot be decoded as an image."""


class SceneClassificationError(RuntimeError):
    """Scene classification raised or returned an invalid result."""


class DetectionError(RuntimeError):
    """Object detection failed or violated its result contract."""


class RawDetectionLike(Protocol):
    """Structural detector-output contract used without a model import."""

    label: str
    box_xyxy: tuple[float, float, float, float]
    confidence: float


class SceneClassifier(Protocol):
    def __call__(self, image_bytes: bytes) -> dict: ...


class ObjectDetector(Protocol):
    def __call__(self, image_bytes: bytes) -> list[RawDetectionLike]: ...


_ITEM_ID_WIDTH = 3  # "item_001" — matches app.core.schemas.ItemId's pattern (3+ digits)


@dataclass
class _Candidate:
    """A validated detection awaiting its post-sort item_id."""

    source_detection_index: int
    raw_phrase: str
    clean_label: str
    box: BoundingBox
    confidence: float
    position: str
    relative_size: str


def _validate_image_bytes(image_bytes: bytes) -> None:
    if not image_bytes:
        raise InvalidImageError("image is empty (zero bytes)")
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            img.verify()
    except Exception as exc:
        raise InvalidImageError(f"could not decode image: {exc}") from exc


def _build_candidate(index: int, raw: RawDetectionLike) -> _Candidate:
    """Validate and normalise one raw detection."""
    confidence = raw.confidence
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        raise ValueError(f"confidence is not a number: {confidence!r}")
    if not (0.0 <= confidence <= 1.0):
        raise ValueError(f"confidence out of [0, 1] range: {confidence!r}")

    x1, y1, x2, y2 = raw.box_xyxy  # raises if not a 4-tuple of numbers
    box = BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2)  # raises ValidationError if degenerate/out-of-range

    cleaned = clean_label(raw.label)
    if not cleaned.primary:
        raise ValueError("label_cleanup produced an empty primary label")

    parts = describe_box_parts(raw.box_xyxy)

    return _Candidate(
        source_detection_index=index,
        raw_phrase=raw.label,
        clean_label=cleaned.primary,
        box=box,
        confidence=float(confidence),
        position=parts.position,
        relative_size=parts.relative_size,
    )


def analyse_image(
    image_bytes: bytes,
    run_id: str,
    scene_classifier: SceneClassifier,
    detector: ObjectDetector,
) -> AnalysisResult:
    """Analyse an image and assign stable item_ids after validation and sorting."""
    stage_timings: list[StageTiming] = []

    t0 = time.perf_counter()
    _validate_image_bytes(image_bytes)
    stage_timings.append(StageTiming(stage="validate_image", duration_ms=(time.perf_counter() - t0) * 1000))

    t0 = time.perf_counter()
    try:
        scene_raw = scene_classifier(image_bytes)
        scene = SceneClassification(**scene_raw)
    except Exception as exc:
        raise SceneClassificationError(f"scene classification failed: {exc}") from exc
    stage_timings.append(StageTiming(stage="classify_scene", duration_ms=(time.perf_counter() - t0) * 1000))

    t0 = time.perf_counter()
    try:
        raw_detections = detector(image_bytes)
    except Exception as exc:
        raise DetectionError(f"object detection failed: {exc}") from exc
    # Reject a broken detector contract once; an empty list remains valid.
    if not isinstance(raw_detections, list):
        raise DetectionError(
            f"detector returned {type(raw_detections).__name__}, expected a list of detections"
        )
    stage_timings.append(StageTiming(stage="detect_objects", duration_ms=(time.perf_counter() - t0) * 1000))

    t0 = time.perf_counter()
    warnings: list[AnalysisWarning] = []
    candidates: list[_Candidate] = []
    for index, raw in enumerate(raw_detections):
        try:
            candidates.append(_build_candidate(index, raw))
        except Exception as exc:
            warnings.append(
                AnalysisWarning(
                    kind="malformed_detection",
                    source_detection_index=index,
                    detail=str(exc),
                )
            )

    # Deterministic spatial order: top-to-bottom, then left-to-right,
    # then source_detection_index.
    candidates.sort(key=lambda c: (c.box.y1, c.box.x1, c.source_detection_index))

    items = [
        DetectedItem(
            item_id=f"item_{n:0{_ITEM_ID_WIDTH}d}",
            source_detection_index=c.source_detection_index,
            raw_phrase=c.raw_phrase,
            clean_label=c.clean_label,
            box=c.box,
            confidence=c.confidence,
            position=c.position,
            relative_size=c.relative_size,
        )
        for n, c in enumerate(candidates, start=1)
    ]
    validate_unique_item_ids(items)
    stage_timings.append(StageTiming(stage="postprocess_detections", duration_ms=(time.perf_counter() - t0) * 1000))

    return AnalysisResult(
        run_id=run_id,
        scene=scene,
        items=items,
        warnings=warnings,
        stage_timings=stage_timings,
    )
