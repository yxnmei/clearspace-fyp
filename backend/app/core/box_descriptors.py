"""
Pure logic: derive a coarse human-readable size/position hint from a
normalized bounding box. No model loading — unit-testable in milliseconds.

Exists because same-labelled detections (e.g. six "picture frame" boxes in
one image) otherwise look identical to the LLM reasoning stage, which then
has no basis to treat them as distinct items — some models responded by
inventing non-schema decisions like "keep one, donate others" instead of
judging each independently (see DEVLOG.md, 2026-08-01 real-detection run).
This doesn't identify *what* makes two same-label items different, only
roughly *where* and *how big* each one is — enough for a prompt to stop
presenting duplicates as interchangeable text.
"""

from __future__ import annotations

_SMALL_LARGE_THRESHOLDS = (0.05, 0.20)  # area fraction: < small, < large, >= large


def _size_label(area_fraction: float) -> str:
    small, large = _SMALL_LARGE_THRESHOLDS
    if area_fraction < small:
        return "small"
    if area_fraction < large:
        return "medium"
    return "large"


def _position_label(cx: float, cy: float) -> str:
    col = "left" if cx < 1 / 3 else "right" if cx > 2 / 3 else "center"
    row = "upper" if cy < 1 / 3 else "lower" if cy > 2 / 3 else "middle"
    if row == "middle" and col == "center":
        return "center"
    if row == "middle":
        return col
    if col == "center":
        return row
    return f"{row}-{col}"


def describe_box(box_xyxy: tuple[float, float, float, float]) -> str:
    """
    box_xyxy must be normalized to [0, 1] (see grounding_dino.RawDetection).
    Returns something like "large, upper-left" — coarse and cheap on
    purpose; this exists to make same-labelled items distinguishable in an
    LLM prompt, not to be a precise spatial description.
    """
    x1, y1, x2, y2 = box_xyxy
    area_fraction = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    return f"{_size_label(area_fraction)}, {_position_label(cx, cy)}"
