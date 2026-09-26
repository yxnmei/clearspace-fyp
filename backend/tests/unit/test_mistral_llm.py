"""
Unit tests for app/models/mistral_llm.py's additive item_provenance
plumbing. No real Ollama: `ollama.Client` is replaced wholesale with a
fake that serves pre-scripted .chat() responses from an in-memory queue,
so classify_items()'s actual control flow (chunking, retry, missing-item
recovery) runs for real against fake model output — no network, no model
loading.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.core.schemas import ItemValidity
from app.models import mistral_llm
from app.models.mistral_llm import LLMResult, classify_items


def _fake_ollama(responses: list[str]):
    """responses are served in order, one per .chat() call, across every
    call classify_items() makes for this test (main chunk calls AND any
    missing-item recovery calls) — the test controls exactly what each
    call in the sequence returns."""
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, host=None):
            self.host = host

        def chat(self, model, messages, options):
            calls.append({"model": model, "messages": messages, "options": options})
            content = responses.pop(0)
            return {"message": {"content": content}}

    return SimpleNamespace(Client=FakeClient), calls


TWO_ITEMS = [
    {"label": "lamp", "confidence": 0.9},
    {"label": "vase", "confidence": 0.8},
]


def test_raw_valid_response_tags_every_item_number_raw_valid(monkeypatch):
    fake_ollama, calls = _fake_ollama(
        [
            '[{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"}, '
            '{"item_number": 2, "label": "vase", "decision": "donate", "reason": "unused"}]'
        ]
    )
    monkeypatch.setattr(mistral_llm, "ollama", fake_ollama)

    result = classify_items(
        run_id="r1", detected_items=TWO_ITEMS, scene_label="bedroom", user_context=None, model_name="phi4-mini"
    )

    assert result.is_valid_json is True
    assert result.item_provenance == {1: ItemValidity.RAW_VALID, 2: ItemValidity.RAW_VALID}
    assert len(calls) == 1
    assert calls[0]["model"] == "phi4-mini"


def test_mechanically_repaired_response_tags_every_item_number(monkeypatch):
    fake_ollama, _calls = _fake_ollama(
        [
            '[{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"}, '
            '{"item_number": 2, "label": "vase", "decision": "donate", "reason": "unused"},]'  # trailing comma
        ]
    )
    monkeypatch.setattr(mistral_llm, "ollama", fake_ollama)

    result = classify_items(
        run_id="r1", detected_items=TWO_ITEMS, scene_label="bedroom", user_context=None, model_name="phi4-mini"
    )

    assert result.is_valid_json is True
    assert result.item_provenance == {
        1: ItemValidity.MECHANICALLY_REPAIRED,
        2: ItemValidity.MECHANICALLY_REPAIRED,
    }


def test_missing_item_recovered_is_tagged_recovery_used(monkeypatch):
    # Main response only returns item 1 — item 2 silently dropped, the same
    # real-world failure mode observed on 2026-08-07. classify_items
    # issues its own targeted single-item recovery call for item 2.
    fake_ollama, calls = _fake_ollama(
        [
            '[{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"}]',
            '[{"item_number": 2, "label": "vase", "decision": "donate", "reason": "unused"}]',
        ]
    )
    monkeypatch.setattr(mistral_llm, "ollama", fake_ollama)

    result = classify_items(
        run_id="r1", detected_items=TWO_ITEMS, scene_label="bedroom", user_context=None, model_name="phi4-mini"
    )

    assert result.is_valid_json is True  # the main chunk call itself was validly-shaped JSON
    assert result.item_provenance == {1: ItemValidity.RAW_VALID, 2: ItemValidity.RECOVERY_USED}
    assert len(calls) == 2


def test_missing_item_recovery_failure_is_tagged_still_invalid(monkeypatch):
    settings_retries = 0  # keep this test's call count small/predictable

    from app.config import get_settings

    original_settings = get_settings()
    monkeypatch.setattr(
        mistral_llm,
        "get_settings",
        lambda: original_settings.model_copy(update={"llm_max_retries": settings_retries}),
    )

    fake_ollama, calls = _fake_ollama(
        [
            '[{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"}]',
            "not json at all, sorry",  # recovery call for item 2 fails outright
        ]
    )
    monkeypatch.setattr(mistral_llm, "ollama", fake_ollama)

    result = classify_items(
        run_id="r1", detected_items=TWO_ITEMS, scene_label="bedroom", user_context=None, model_name="phi4-mini"
    )

    assert result.is_valid_json is False
    assert result.item_provenance == {1: ItemValidity.RAW_VALID, 2: ItemValidity.STILL_INVALID}
    assert len(calls) == 2


def test_existing_llmresult_construction_without_item_provenance_still_works():
    # Backward compatibility: any caller (fakes, older code) omitting the
    # new field entirely must still construct cleanly, defaulting to {}.
    result = LLMResult(
        raw_text="raw",
        parsed_json=None,
        is_valid_json=False,
        model_name="mistral",
        prompt_version="v2",
    )
    assert result.item_provenance == {}
