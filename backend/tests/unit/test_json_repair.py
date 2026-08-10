"""Unit (Verification): app/core/json_repair.py — no model loading."""

from app.core.json_repair import extract_json, extract_json_detailed


def test_clean_json_parses_directly():
    parsed, ok = extract_json('{"decision": "keep"}')
    assert ok is True
    assert parsed == {"decision": "keep"}


def test_json_wrapped_in_prose_is_extracted():
    raw = 'Sure, here is the result:\n{"decision": "sell", "reason": "unused"}\nHope that helps!'
    parsed, ok = extract_json(raw)
    assert ok is True
    assert parsed["decision"] == "sell"


def test_garbage_input_reports_invalid_not_raise():
    parsed, ok = extract_json("I cannot help with that request.")
    assert ok is False
    assert parsed is None


def test_trailing_comma_before_closing_bracket_is_repaired():
    # The exact shape phi4-mini produces for single-item arrays — real
    # example pulled from a live run, see DEVLOG.md 2026-08-07.
    raw = '[{"item_number": 10, "label": "pillow", "decision": "keep", "reason": "still useful"},]'
    parsed, ok = extract_json(raw)
    assert ok is True
    assert parsed == [{"item_number": 10, "label": "pillow", "decision": "keep", "reason": "still useful"}]


def test_trailing_comma_before_closing_brace_is_repaired():
    parsed, ok = extract_json('{"decision": "keep",}')
    assert ok is True
    assert parsed == {"decision": "keep"}


def test_trailing_comma_repaired_inside_extracted_block_too():
    raw = 'Here you go:\n[{"item_number": 1, "label": "lamp"},]\nDone.'
    parsed, ok = extract_json(raw)
    assert ok is True
    assert parsed == [{"item_number": 1, "label": "lamp"}]


def test_detailed_clean_json_reports_not_repaired():
    result = extract_json_detailed('{"decision": "keep"}')
    assert result.is_valid is True
    assert result.was_repaired is False
    assert result.parsed == {"decision": "keep"}


def test_detailed_trailing_comma_reports_repaired():
    result = extract_json_detailed('[{"item_number": 10, "decision": "keep"},]')
    assert result.is_valid is True
    assert result.was_repaired is True


def test_detailed_prose_extraction_reports_repaired_even_without_trailing_comma():
    # The block itself is clean JSON — only the surrounding prose needed
    # stripping. Extraction from prose counts as a repair on its own.
    raw = 'Sure, here you go:\n[{"item_number": 1, "decision": "keep"}]\nDone.'
    result = extract_json_detailed(raw)
    assert result.is_valid is True
    assert result.was_repaired is True


def test_detailed_garbage_reports_not_repaired_and_invalid():
    result = extract_json_detailed("I cannot help with that request.")
    assert result.is_valid is False
    assert result.was_repaired is False
    assert result.parsed is None


def test_extract_json_unchanged_behaviour_for_all_cases_above():
    # extract_json() must remain the same 2-tuple, for every input shape
    # extract_json_detailed() now distinguishes.
    for raw in [
        '{"decision": "keep"}',
        '[{"item_number": 10, "decision": "keep"},]',
        'Sure, here you go:\n[{"item_number": 1, "decision": "keep"}]\nDone.',
        "I cannot help with that request.",
    ]:
        detailed = extract_json_detailed(raw)
        parsed, ok = extract_json(raw)
        assert (parsed, ok) == (detailed.parsed, detailed.is_valid)
