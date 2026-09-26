"""
Unit (Verification — "are we building it right?"): pure logic, no model
loading, runs in milliseconds.
"""

from app.core.label_cleanup import clean_label


def test_simple_label_passes_through():
    result = clean_label("chair")
    assert result.primary == "chair"
    assert result.discarded_tokens == []
    assert result.was_compound is False


def test_known_multiword_label_not_split():
    result = clean_label("remote control")
    assert result.primary == "remote control"
    assert result.was_compound is False


def test_unknown_compound_falls_back_to_first_token_and_keeps_rest():
    # v1's bug: "book notebook magazine document" silently lost everything
    # but "book". This asserts the discarded info is still recoverable.
    result = clean_label("book notebook magazine document")
    assert result.primary == "book"
    assert result.discarded_tokens == ["notebook", "magazine", "document"]
    assert result.was_compound is True


def test_normalizes_case_and_whitespace():
    result = clean_label("  Desk Fan  ")
    assert result.primary == "desk fan"
    assert result.was_compound is False
