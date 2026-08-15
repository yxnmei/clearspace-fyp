"""
Unit tests for app/models/reorganise_llm.py. Real ollama.Client is
replaced wholesale with a fake serving a pre-scripted .chat() response —
no network, no real model load, no real Ollama server contacted anywhere
in this file.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from app.config import get_settings
from app.core.schemas import BoundingBox, DetectedItem
from app.models import reorganise_llm
from app.models.reorganise_llm import (
    REORGANISE_PROMPT_VERSION,
    build_reorganise_plan_prompt,
    generate_reorganise_plan_once,
)


def _item(
    item_id="item_001",
    label="picture frame",
    corrected_label=None,
    position="upper-left",
    relative_size="small",
) -> DetectedItem:
    return DetectedItem(
        item_id=item_id,
        source_detection_index=0,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.2, y2=0.2),
        confidence=0.5,
        position=position,
        relative_size=relative_size,
        corrected_label=corrected_label,
    )


def _fake_ollama(content: str):
    """Returns (fake_module, calls) — calls records every .chat() call's
    kwargs, in order, across however many times a test invokes the
    wrapper (normally just once)."""
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, host=None):
            self.host = host

        def chat(self, model, messages, options):
            calls.append({"model": model, "messages": messages, "options": options, "host": self.host})
            return {"message": {"content": content}}

    return SimpleNamespace(Client=FakeClient), calls


VALID_PLAN_JSON = (
    '{"zones": [{"zone_name": "Keep in place", "item_ids": ["item_001"], '
    '"instruction": "keep it here"}], "image_prompt": "a tidy bedroom with a picture frame"}'
)


# --- prompt content ----------------------------------------------------


def test_prompt_contains_scene_label():
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None)
    assert "bedroom" in prompt


def test_prompt_contains_every_exact_item_id():
    items = [_item("item_001"), _item("item_002")]
    prompt = build_reorganise_plan_prompt(items, "bedroom", None)
    assert "item_001" in prompt
    assert "item_002" in prompt


def test_prompt_uses_effective_label_for_corrected_items():
    item = _item("item_001", label="jewelry", corrected_label="necklace")
    prompt = build_reorganise_plan_prompt([item], "bedroom", None)
    assert "necklace" in prompt
    assert "jewelry" not in prompt


def test_prompt_contains_position_and_relative_size():
    item = _item("item_001", position="lower-right", relative_size="large")
    prompt = build_reorganise_plan_prompt([item], "bedroom", None)
    assert "lower-right" in prompt
    assert "large" in prompt


def test_prompt_distinguishes_duplicate_same_label_objects():
    items = [_item("item_001", label="picture frame"), _item("item_002", label="picture frame")]
    prompt = build_reorganise_plan_prompt(items, "bedroom", None)
    assert prompt.count("picture frame") >= 2
    assert "DISTINCT" in prompt


def test_prompt_context_reaches_a_clearly_delimited_section():
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", "prefers warm lighting")
    assert "User preference" in prompt
    assert "prefers warm lighting" in prompt


def test_prompt_whitespace_only_context_treated_consistently_as_absent():
    with_whitespace = build_reorganise_plan_prompt([_item()], "bedroom", "   ")
    without_context = build_reorganise_plan_prompt([_item()], "bedroom", None)
    assert with_whitespace == without_context


def test_prompt_describes_exact_output_schema():
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None)
    for token in ("zones", "zone_name", "item_ids", "instruction", "image_prompt", "negative_prompt"):
        assert token in prompt


def test_prompt_forbids_omitted_duplicated_and_invented_ids():
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None)
    assert "invent" in prompt.lower()
    assert "omit" in prompt.lower()
    assert "exactly one" in prompt.lower()


def test_prompt_no_markdown_or_provenance_in_output_instructions():
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None)
    assert "markdown" in prompt.lower()
    assert "provenance" in prompt.lower()
    assert "model name" in prompt.lower()
    assert "prompt version" in prompt.lower()


def test_prompt_image_prompt_instruction_uses_labels_not_bare_ids():
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None)
    assert "item_ids are internal identifiers only" in prompt


def test_recovery_feedback_reaches_the_recovery_prompt():
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None, validation_feedback=["plan omits item_002"])
    assert "plan omits item_002" in prompt
    assert "previous response was invalid" in prompt.lower()


def test_recovery_feedback_is_bounded_per_line():
    long_feedback = ["x" * 5000]
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None, validation_feedback=long_feedback)
    assert "x" * 5000 not in prompt


def test_recovery_feedback_line_count_is_bounded():
    many_lines = [f"problem {i}" for i in range(50)]
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None, validation_feedback=many_lines)
    assert "problem 49" not in prompt  # beyond _MAX_FEEDBACK_LINES, never rendered


def test_no_validation_feedback_section_when_none_given():
    prompt = build_reorganise_plan_prompt([_item()], "bedroom", None)
    assert "previous response was invalid" not in prompt.lower()


# --- caller-input validation --------------------------------------------


def test_build_prompt_rejects_empty_selected_items():
    with pytest.raises(ValueError):
        build_reorganise_plan_prompt([], "bedroom", None)


def test_build_prompt_rejects_blank_scene_label():
    with pytest.raises(ValueError):
        build_reorganise_plan_prompt([_item()], "   ", None)


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(selected_items=[], scene_label="bedroom", user_context=None),
        dict(selected_items="not-a-list", scene_label="bedroom", user_context=None),
        dict(selected_items=[_item(), {"not": "a DetectedItem"}], scene_label="bedroom", user_context=None),
        dict(
            selected_items=[_item("item_001"), _item("item_001")],
            scene_label="bedroom",
            user_context=None,
        ),
        dict(selected_items=[_item()], scene_label="   ", user_context=None),
        dict(selected_items=[_item()], scene_label=123, user_context=None),
        dict(selected_items=[_item()], scene_label="bedroom", user_context=123),
        dict(
            selected_items=[_item()],
            scene_label="bedroom",
            user_context=None,
            validation_feedback="not-a-list",
        ),
        dict(selected_items=[_item()], scene_label="bedroom", user_context=None, validation_feedback=["   "]),
    ],
)
def test_invalid_caller_inputs_fail_before_creating_or_calling_the_client(kwargs, monkeypatch):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("ollama.Client must not be constructed for invalid caller input")

    monkeypatch.setattr(reorganise_llm, "ollama", SimpleNamespace(Client=fail_if_called))

    with pytest.raises(ValueError):
        generate_reorganise_plan_once(run_id="r1", **kwargs)


# --- run_id validation ------------------------------------------------------


@pytest.mark.parametrize("bad_run_id", ["", "   ", None, 5, [], {}])
def test_invalid_run_id_rejected_before_client_construction(bad_run_id, monkeypatch):
    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("ollama.Client must not be constructed for an invalid run_id")

    monkeypatch.setattr(reorganise_llm, "ollama", SimpleNamespace(Client=fail_if_called))

    with pytest.raises(ValueError):
        generate_reorganise_plan_once(
            run_id=bad_run_id, selected_items=[_item()], scene_label="bedroom", user_context=None
        )


def test_run_id_whitespace_normalized_like_shared_non_empty_str(monkeypatch):
    fake_module, _calls = _fake_ollama(VALID_PLAN_JSON)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    # Must not raise — " r1 " is valid input, normalized the same way
    # app.core.schemas.NonEmptyStr normalizes every other identity field
    # in this codebase (strip_whitespace=True).
    generate_reorganise_plan_once(
        run_id=" r1 ", selected_items=[_item()], scene_label="bedroom", user_context=None
    )


# --- model/host/temperature configuration -------------------------------


def test_default_configured_model_used(monkeypatch):
    fake_module, calls = _fake_ollama(VALID_PLAN_JSON)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    result = generate_reorganise_plan_once(
        run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None
    )

    assert calls[0]["model"] == get_settings().llm_model_name
    assert result.model_name == get_settings().llm_model_name


def test_explicit_model_override_used(monkeypatch):
    fake_module, calls = _fake_ollama(VALID_PLAN_JSON)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    result = generate_reorganise_plan_once(
        run_id="r1",
        selected_items=[_item()],
        scene_label="bedroom",
        user_context=None,
        model_name="qwen3:8b",
    )

    assert calls[0]["model"] == "qwen3:8b"
    assert result.model_name == "qwen3:8b"


def test_configured_ollama_host_used(monkeypatch):
    fake_module, calls = _fake_ollama(VALID_PLAN_JSON)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    generate_reorganise_plan_once(run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None)

    assert calls[0]["host"] == get_settings().ollama_host


def test_configured_temperature_used(monkeypatch):
    fake_module, calls = _fake_ollama(VALID_PLAN_JSON)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    generate_reorganise_plan_once(run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None)

    assert calls[0]["options"]["temperature"] == get_settings().llm_temperature


def test_exactly_one_chat_call_per_wrapper_invocation(monkeypatch):
    fake_module, calls = _fake_ollama(VALID_PLAN_JSON)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    generate_reorganise_plan_once(run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None)

    assert len(calls) == 1


# --- extraction semantics ------------------------------------------------


def test_raw_valid_json_result(monkeypatch):
    fake_module, _calls = _fake_ollama(VALID_PLAN_JSON)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    result = generate_reorganise_plan_once(
        run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None
    )

    assert result.is_valid_json is True
    assert result.was_repaired is False
    assert result.parsed_json is not None


def test_prose_wrapped_result_reports_was_repaired_true(monkeypatch):
    prose_wrapped = f"Here is the plan:\n{VALID_PLAN_JSON}\nHope that helps!"
    fake_module, _calls = _fake_ollama(prose_wrapped)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    result = generate_reorganise_plan_once(
        run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None
    )

    assert result.is_valid_json is True
    assert result.was_repaired is True


def test_trailing_comma_result_reports_was_repaired_true(monkeypatch):
    trailing_comma_json = VALID_PLAN_JSON[:-1] + ",}"
    fake_module, _calls = _fake_ollama(trailing_comma_json)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    result = generate_reorganise_plan_once(
        run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None
    )

    assert result.is_valid_json is True
    assert result.was_repaired is True


def test_invalid_json_reports_is_valid_json_false(monkeypatch):
    fake_module, _calls = _fake_ollama("not json at all, sorry")
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    result = generate_reorganise_plan_once(
        run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None
    )

    assert result.is_valid_json is False
    assert result.parsed_json is None


def test_syntactically_valid_but_semantically_wrong_object_remains_syntactically_valid_here(monkeypatch):
    # Missing the required "item_ids" key entirely — still syntactically
    # valid JSON. This wrapper reports ONLY syntactic validity; semantic
    # validation is core.reorganise_semantic_conversion's job, never
    # performed here.
    semantically_wrong = '{"zones": [{"zone_name": "x"}], "image_prompt": "y"}'
    fake_module, _calls = _fake_ollama(semantically_wrong)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    result = generate_reorganise_plan_once(
        run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None
    )

    assert result.is_valid_json is True
    assert result.parsed_json == {"zones": [{"zone_name": "x"}], "image_prompt": "y"}


def test_prompt_version_is_v1(monkeypatch):
    fake_module, _calls = _fake_ollama(VALID_PLAN_JSON)
    monkeypatch.setattr(reorganise_llm, "ollama", fake_module)

    result = generate_reorganise_plan_once(
        run_id="r1", selected_items=[_item()], scene_label="bedroom", user_context=None
    )

    assert result.prompt_version == REORGANISE_PROMPT_VERSION == "v1"


# --- no logging side effect ----------------------------------------------


def test_module_does_not_import_stage_timer_or_logging_utils():
    # The module docstring mentions "stage_timer" in prose (explaining
    # why it's deliberately NOT used) — check for an actual import
    # statement, not a bare substring, so that documentation doesn't
    # trip this check.
    source = Path(reorganise_llm.__file__).read_text(encoding="utf-8")
    assert "import stage_timer" not in source
    assert "from app.logging_utils" not in source
    assert not hasattr(reorganise_llm, "stage_timer")


# --- import boundary -------------------------------------------------------


def test_module_import_boundary():
    source = Path(reorganise_llm.__file__).read_text(encoding="utf-8")
    forbidden = ["import torch", "import groundingdino", "import requests", "image_gen_client"]
    for token in forbidden:
        assert token not in source, f"forbidden import found in reorganise_llm.py: {token!r}"
    assert "import ollama" in source  # ollama IS expected/allowed here
