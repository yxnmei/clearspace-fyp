"""
Unit tests for colab_service.resolution.compute_target_resolution() —
pure arithmetic, no GPU/model/network dependency of any kind.
"""

from __future__ import annotations

import math

import pytest

from colab_service.resolution import compute_target_resolution

BUDGET = 512 * 512


def test_deterministic_same_inputs_same_outputs():
    a = compute_target_resolution(1280, 960, BUDGET)
    b = compute_target_resolution(1280, 960, BUDGET)
    assert a == b


@pytest.mark.parametrize(
    "orig_w,orig_h",
    [
        (1280, 960),  # landscape (bedroom02.jpg's own dimensions)
        (960, 1280),  # portrait
        (500, 500),  # square
        (2000, 100),  # extreme landscape
        (100, 2000),  # extreme portrait
        (1920, 1080),  # 16:9
        (4000, 3000),  # large 4:3
    ],
)
def test_dimensions_are_positive_multiples_of_8(orig_w, orig_h):
    result = compute_target_resolution(orig_w, orig_h, BUDGET)
    assert result.width % 8 == 0
    assert result.height % 8 == 0
    assert result.width > 0
    assert result.height > 0


def test_landscape_input_stays_landscape():
    result = compute_target_resolution(1280, 960, BUDGET)
    assert result.width > result.height


def test_portrait_input_stays_portrait():
    result = compute_target_resolution(960, 1280, BUDGET)
    assert result.height > result.width


def test_square_input_stays_square():
    result = compute_target_resolution(1000, 1000, BUDGET)
    assert result.width == result.height


def test_extreme_landscape_does_not_crop_toward_square_or_invert_orientation():
    result = compute_target_resolution(2000, 100, BUDGET)
    assert result.width > result.height


def test_extreme_portrait_does_not_crop_toward_square_or_invert_orientation():
    result = compute_target_resolution(100, 2000, BUDGET)
    assert result.height > result.width


def test_never_flips_orientation_relative_to_original():
    orig_w, orig_h = 1280, 960
    result = compute_target_resolution(orig_w, orig_h, BUDGET)
    orig_ratio = orig_w / orig_h
    actual_ratio = result.width / result.height
    assert (actual_ratio > 1) == (orig_ratio > 1)


def test_pixel_count_stays_reasonably_close_to_the_budget():
    result = compute_target_resolution(1280, 960, BUDGET)
    area = result.width * result.height
    assert 0.5 * BUDGET <= area <= 2.0 * BUDGET


def test_different_pixel_budgets_produce_proportionally_different_sizes():
    small = compute_target_resolution(1280, 960, 256 * 256)
    large = compute_target_resolution(1280, 960, 768 * 768)
    assert small.width < large.width
    assert small.height < large.height


def test_ratio_deviation_is_reported_honestly_not_fabricated_as_zero():
    # 1280x960 (4:3) does not land exactly on a multiple-of-8 pair at
    # this budget -- the deviation must be > 0, small, and match what the
    # returned dimensions actually produce (never silently rounded to 0).
    result = compute_target_resolution(1280, 960, BUDGET)
    orig_ratio = 1280 / 960
    actual_ratio = result.width / result.height
    expected_deviation = abs(actual_ratio - orig_ratio) / orig_ratio
    assert result.ratio_deviation > 0.0
    assert math.isclose(result.ratio_deviation, expected_deviation, rel_tol=1e-9)


def test_ratio_deviation_stays_small():
    # Generously bounded -- this is not a tight tolerance, just proof the
    # policy never produces a wildly distorted result.
    for orig_w, orig_h in [(1280, 960), (960, 1280), (1920, 1080), (4000, 3000)]:
        result = compute_target_resolution(orig_w, orig_h, BUDGET)
        assert result.ratio_deviation < 0.05


def test_square_input_has_zero_deviation():
    result = compute_target_resolution(1000, 1000, BUDGET)
    assert result.ratio_deviation == 0.0


@pytest.mark.parametrize("orig_w,orig_h", [(0, 960), (1280, 0), (-1, 960), (1280, -1)])
def test_rejects_non_positive_dimensions(orig_w, orig_h):
    with pytest.raises(ValueError):
        compute_target_resolution(orig_w, orig_h, BUDGET)


def test_rejects_non_positive_pixel_budget():
    with pytest.raises(ValueError):
        compute_target_resolution(1280, 960, 0)
    with pytest.raises(ValueError):
        compute_target_resolution(1280, 960, -100)


def test_rejects_non_positive_multiple():
    with pytest.raises(ValueError):
        compute_target_resolution(1280, 960, BUDGET, multiple=0)


def test_upscales_a_small_image_toward_the_budget_not_just_downscales():
    result = compute_target_resolution(10, 10, BUDGET)
    assert result.width * result.height > 100  # meaningfully larger than the 10x10 original
