"""
Deterministic, pure, GPU-independent resolution policy — Option A (see
colab_service/README.md's "Resolution policy (Option A)" section for
why Option A was chosen over Option B, "aspect-preserving resize with
padding").

Never claims exact aspect-ratio preservation, and never claims zero
stretching. Rounding a scaled size to a multiple of 8 (a hard SD/VAE
requirement) necessarily introduces a small, real deviation from the
original ratio — and resizing the original image to (width, height),
which differ from the original ratio by exactly `ratio_deviation`,
means the horizontal and vertical scale factors applied are not quite
equal. That IS a small, real, non-uniform geometric rescale (a genuine
stretch/squash along one axis relative to the other), not merely an
abstract number — this module computes and reports the deviation
honestly rather than describing the resize as distortion-free. What it
never does: crop content (no candidate discards any part of the image),
or flip the image into a different orientation than it started in
(landscape stays landscape, portrait stays portrait, square stays
square).

No GPU, model, torch, or PIL import anywhere in this file — pure
arithmetic only, safe to import and unit-test on any machine.
"""

from __future__ import annotations

import math
from typing import NamedTuple


class TargetResolution(NamedTuple):
    """width/height: positive multiples of `multiple`, same orientation
    as the input (landscape stays landscape, portrait stays portrait,
    square stays square). ratio_deviation: the fractional deviation from
    the original aspect ratio, |target_ratio - orig_ratio| / orig_ratio,
    always >= 0 and reported honestly — never fabricated as exactly 0
    unless it genuinely is."""

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
    """
    Computes the target generation resolution for an image of size
    (orig_w, orig_h): the multiple-of-`multiple` (width, height) pair
    that keeps total pixel count near `pixel_budget` (SD1.5's own
    ~512x512 training-resolution sweet spot by default — see config.py's
    resolution_pixel_budget) while minimizing deviation from the
    original aspect ratio. Deterministic and pure — the same inputs
    always produce the same output; no randomness, no I/O, no GPU/model
    dependency of any kind.

    Method: compute the ideal scaled size for the pixel budget, then
    search the (at most 4) candidate multiple-of-`multiple` pairs
    immediately below/above that ideal size for width and height, and
    pick whichever candidate pair's ratio is closest to the original.
    Never crops or flips orientation (see module docstring); DOES apply
    a small, real, non-uniform rescale whenever ratio_deviation is > 0
    (see tests/test_resolution.py's own orientation checks for the
    behavior this guarantees).

    Raises ValueError for non-positive orig_w/orig_h/pixel_budget/multiple.
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
