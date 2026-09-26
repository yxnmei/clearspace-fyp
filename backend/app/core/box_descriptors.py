"""
Derive a coarse size/position hint from a normalized bounding box.

Same-labelled detections (e.g. six "picture frame" boxes) otherwise look
identical to the LLM, and some models then invented non-schema decisions
like "keep one, donate others" instead of judging each item (observed in
a 2026-08-01 real-detection run). Rough where/how-big is enough to stop
duplicates reading as interchangeable.
"""

from __future__ import annotations

from dataclasses import dataclass

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
        # Bare "upper"/"lower" reads as "top third, any column" (found in
        # the 2026-08-09 manual position annotation); "left"/"right" alone
        # have no such ambiguity, so only this branch gets "-center".
        return f"{row}-center"
    return f"{row}-{col}"


@dataclass
class BoxDescriptor:
    relative_size: str
    position: str


def describe_box_parts(box_xyxy: tuple[float, float, float, float]) -> BoxDescriptor:
    """box_xyxy normalized to [0, 1]. Returns size and position as the
    two separate fields DetectedItem carries."""
    x1, y1, x2, y2 = box_xyxy
    area_fraction = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    return BoxDescriptor(relative_size=_size_label(area_fraction), position=_position_label(cx, cy))


def describe_box(box_xyxy: tuple[float, float, float, float]) -> str:
    """E.g. "large, upper-left". Deliberately coarse: enough to tell
    same-labelled items apart in a prompt, not a precise description."""
    parts = describe_box_parts(box_xyxy)
    return f"{parts.relative_size}, {parts.position}"
