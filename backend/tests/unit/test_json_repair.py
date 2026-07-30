"""Unit (Verification): app/core/json_repair.py — no model loading."""

from app.core.json_repair import extract_json


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
