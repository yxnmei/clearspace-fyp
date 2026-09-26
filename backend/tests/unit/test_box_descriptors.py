"""
Unit (Verification — "are we building it right?"): pure logic, no model
loading, runs in milliseconds.
"""

from app.core.box_descriptors import describe_box, describe_box_parts


def test_small_box_upper_left():
    result = describe_box((0.0, 0.0, 0.1, 0.1))
    assert result == "small, upper-left"


def test_large_box_center():
    result = describe_box((0.1, 0.1, 0.9, 0.9))
    assert result == "large, center"


def test_medium_box_lower_right():
    result = describe_box((0.7, 0.7, 0.95, 0.95))
    assert result == "medium, lower-right"


def test_full_width_middle_band_reports_center():
    # spans the full width and sits in the vertical middle band — both row
    # and column resolve to "center"/"middle", collapsing to just "center".
    # Uses 0.3-0.7 rather than 0.4-0.6 to stay clearly above the "large"
    # area threshold rather than landing on a float-precision boundary
    # (0.6 - 0.4 == 0.19999999999999998, not 0.2, in IEEE 754 floats).
    result = describe_box((0.0, 0.3, 1.0, 0.7))
    assert result == "large, center"


def test_full_width_upper_band_reports_upper_center():
    # center column (spans full width) + upper row — "upper" alone would be
    # ambiguous ("top third, any column" vs "top third, center column"), so
    # this resolves to the explicit "upper-center" (see _position_label).
    result = describe_box((0.0, 0.0, 1.0, 0.3))
    assert result == "large, upper-center"


def test_full_width_lower_band_reports_lower_center():
    result = describe_box((0.0, 0.7, 1.0, 1.0))
    assert result == "large, lower-center"


# --- describe_box_parts: same computation, exposed as separate fields ---
# (added for app.core.schemas.DetectedItem's separate position/relative_size
# fields — see app/services/analysis_service.py)


def test_describe_box_parts_matches_describe_box_components():
    box = (0.7, 0.7, 0.95, 0.95)
    parts = describe_box_parts(box)
    assert parts.relative_size == "medium"
    assert parts.position == "lower-right"
    assert describe_box(box) == f"{parts.relative_size}, {parts.position}"


def test_describe_box_is_a_thin_wrapper_over_describe_box_parts():
    # Same box through both entry points must always agree — describe_box
    # is defined in terms of describe_box_parts, not a parallel implementation.
    for box in [(0.0, 0.0, 0.1, 0.1), (0.1, 0.1, 0.9, 0.9), (0.0, 0.0, 1.0, 0.3)]:
        parts = describe_box_parts(box)
        assert describe_box(box) == f"{parts.relative_size}, {parts.position}"
