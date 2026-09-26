"""
Shared image-analysis foundation for Declutter, Reorganise, and Both —
`analyse_image()`. Following the "one implementation, not two that drift"
principle, every path that needs scene classification and
object detection calls this, none reimplements it.

Dependency injection, not direct imports: `scene_classifier`/`detector`
are typed as Protocols (RawDetectionLike/SceneClassifier/ObjectDetector
below), not concrete imports of app.models.clip_scene/grounding_dino.
Two reasons, both deliberate:
  1. This module never needs to import either model module at all — real
     `clip_scene.classify_scene`/`grounding_dino.detect` already satisfy
     these Protocols structurally (same call signature, same return
     shape), so callers pass them in directly with zero adapter code.
  2. Tests can supply fakes that share no import with the real modules —
     app.models.grounding_dino imports torch/numpy at module top level,
     so avoiding that import
     entirely, not just avoiding calling load_model(), is what actually
     keeps unit tests fast and independent of the ML stack.

Failure policy:
  - Invalid image (can't decode at all) -> InvalidImageError, fatal.
  - Scene classifier raises, or returns something SceneClassification
    can't validate -> SceneClassificationError (cause preserved).
  - Detector raises -> DetectionError (cause preserved). Distinguishable
    from SceneClassificationError by type, not just message text.
  - One malformed detection (bad box, out-of-range confidence, or a label
    that cleans to an empty string) inside an otherwise-successful
    detector response -> recorded as an AnalysisWarning, that detection
    skipped, the rest of the analysis proceeds. The only soft-failure path.

Duplicate/NMS policy: none applied here, deliberately. There is no NMS or
box-merging anywhere in this codebase today; a 2026-08-01 real-detection
run confirmed
that apparent duplicate detections (six "picture frame" boxes in one
image) were genuinely six distinct real objects, not detector artifacts
— which is why core/box_descriptors.py exists (to help distinguish real
duplicates via position, not suppress them). Not inventing a new
suppression policy here; every valid detection becomes a candidate item.
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
    """image_bytes could not be decoded as an image at all — fatal, no
    partial AnalysisResult is meaningful."""


class SceneClassificationError(RuntimeError):
    """The injected scene_classifier raised, or returned a response
    SceneClassification could not validate. Distinguishable by type from
    DetectionError — see this module's docstring."""


class DetectionError(RuntimeError):
    """The injected detector raised. Distinguishable by type from
    SceneClassificationError — see this module's docstring."""


class RawDetectionLike(Protocol):
    """Structural shape a detector's output items must have — matches
    app.models.grounding_dino.RawDetection's fields exactly, without
    importing that module (see module docstring)."""

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
    """One detection that has already passed box/confidence/label
    validation — everything a DetectedItem needs except item_id, which is
    assigned only after final sorting (see analyse_image)."""

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
    """Raises on any validation failure — caller (analyse_image) catches
    broadly and converts to an AnalysisWarning. Deliberately one broad
    try/except at the call site rather than several narrow ones here:
    a malformed detection can fail for many reasons (bad box shape, bad
    confidence type, empty label after cleaning), and all of them mean
    the same thing to the caller — skip this one, keep going."""
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
    """
    Processing order (every step remains present
    and in this order, even where a step is currently a documented no-op):

      1. validate input image
      2. classify scene
      3. detect objects
      4. validate and normalise boxes            \\_ done together, per
      5. clean raw phrases                        /  detection, in _build_candidate
      6. preserve raw_phrase and clean_label       -- see _Candidate
      7. apply only the existing justified duplicate policy (none — see
         module docstring; this is a documented no-op, not an omission)
      8. derive separate position and relative_size values
      9. sort deterministically using the documented spatial ordering
     10. assign item_001, item_002, ... after final filtering
     11. validate unique IDs
     12. return AnalysisResult
    """
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
    # The detector's *top-level* return shape is checked explicitly, before
    # iterating — without this, None/a dict/a string/bytes would either
    # crash with a confusing low-level error (iterating a dict yields its
    # keys, not detections) or, worse, silently produce a stream of
    # unrelated "malformed_detection" warnings from _build_candidate
    # instead of one clear signal that the detector's contract itself was
    # violated. A valid empty list is a legitimate, successful result
    # (zero items) and is not affected by this check.
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

    # No duplicate/NMS suppression applied — see module docstring. Every
    # candidate that survived validation becomes an item.

    # Deterministic spatial order: top-to-bottom, then left-to-right,
    # ties broken by source_detection_index — matches
    # app.core.schemas.DetectedItem's own documented assignment order.
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
