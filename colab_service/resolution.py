"""Pure target-resolution policy without cropping or orientation changes.

Multiple-of-eight rounding can introduce a small non-uniform rescale, reported
as ``ratio_deviation`` rather than described as distortion-free.
"""

from __future__ import annotations

import math
from typing import NamedTuple


class TargetResolution(NamedTuple):
    """Target dimensions and fractional aspect-ratio deviation."""

    width: int
    height: int
    ratio_deviation: float


def _floor_to_multiple(value: float, multiple: int) -> int:
    return max(multiple, int(math.floor(value / multiple)) * multiple)


def _ceil_to_multiple(value: float, multiple: int) -> int:
    return max(multiple, int(math.ceil(value / multiple)) * multiple)


def compute_target_resolution(
    orig_w: int, orig_h: int, pixel_budget: int, multiple: int = 8
) -> TargetResolution:
    """Choose nearby aligned dimensions with minimal ratio deviation.

    The pure search considers the four floor/ceiling pairs around the ideal
    pixel-budget scale and rejects non-positive inputs.
    """
    if orig_w <= 0 or orig_h <= 0:
        raise ValueError(f"orig_w and orig_h must be positive: {orig_w!r}, {orig_h!r}")
    if pixel_budget <= 0:
        raise ValueError(f"pixel_budget must be positive: {pixel_budget!r}")
    if multiple <= 0:
        raise ValueError(f"multiple must be positive: {multiple!r}")

    orig_ratio = orig_w / orig_h
    scale = math.sqrt(pixel_budget / (orig_w * orig_h))
    ideal_w = orig_w * scale
    ideal_h = orig_h * scale

    w_candidates = sorted({_floor_to_multiple(ideal_w, multiple), _ceil_to_multiple(ideal_w, multiple)})
    h_candidates = sorted({_floor_to_multiple(ideal_h, multiple), _ceil_to_multiple(ideal_h, multiple)})

    best: tuple[int, int] | None = None
    best_deviation: float | None = None
    for w in w_candidates:
        for h in h_candidates:
            deviation = abs((w / h) - orig_ratio) / orig_ratio
            if best is None or deviation < best_deviation:
                best = (w, h)
                best_deviation = deviation

    assert best is not None and best_deviation is not None  # at least one candidate always exists
    return TargetResolution(width=best[0], height=best[1], ratio_deviation=best_deviation)
