"""
System/API tests for POST /listings (marketplace listing drafts, V1).
Fakes only — never a real Ollama call. A real POST /upload (path=
"declutter") runs first with faked model providers to obtain a genuine
AnalysisResult + DeclutterResult, then /listings requests are built from
that real response exactly as a frontend would. Mirrors
tests/system/test_generate_confirmed.py's conventions.
"""

from __future__ import annotations

import io
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import (
    get_detector_provider,
    get_listing_generator_provider,
    get_llm_classifier_provider,
    get_scene_classifier_provider,
)
from app.core.schemas import ItemValidity
from app.main import app
from app.models.listing_llm import ListingModelTimeoutError, ListingModelUnavailableError

_BACKEND_DIR = Path(__file__).resolve().parents[2]

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    yield
    app.dependency_overrides.clear()


def _png_bytes(color=(0, 120, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (10, 10), color=color).save(buf, format="PNG")
    return buf.getvalue()


PNG_BYTES = _png_bytes()
DEFAULT_SCENE = {"label": "bedroom", "confidence": 0.9, "all_scores": {"bedroom": 0.9, "kitchen": 0.1}}


@dataclass
class FakeDetection:
    label: str
    box_xyxy: tuple[float, float, float, float]
    confidence: float


class CallRecorder:
    def __init__(self, return_value=None, side_effect: Exception | None = None):
        self.calls: list[dict] = []
        self.return_value = return_value
        self.side_effect = side_effect

    def __call__(self, *args, **kwargs):
        self.calls.append({"args": args, "kwargs": kwargs})
        if self.side_effect is not None:
            raise self.side_effect
        return self.return_value


def _provider_override(loader):
    def _override():
        return loader

    return _override


@dataclass
class FakeLLMResult:
    raw_text: str
    parsed_json: object
    is_valid_json: bool
    model_name: str
    prompt_version: str
    item_provenance: dict


def _fake_llm_result(decisions: list[dict]) -> FakeLLMResult:
    return FakeLLMResult(
        raw_text="fake",
        parsed_json=decisions,
        is_valid_json=True,
        model_name="phi4-mini",
        prompt_version="v2",
        item_provenance={d["item_number"]: ItemValidity.RAW_VALID for d in decisions},
    )


def _do_declutter_upload(decisions: list[dict]) -> dict:
    """decisions: [{"item_number", "label", "decision", "reason"}, ...] —
    one detection per decision, in item_number order."""
    detections = [
        FakeDetection(label=d["label"], box_xyxy=(0.1 * i, 0.1, 0.1 * i + 0.08, 0.3), confidence=0.9)
        for i, d in enumerate(decisions)
    ]
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=DEFAULT_SCENE)
    )
    app.dependency_overrides[get_detector_provider] = _provider_override(
        lambda: CallRecorder(return_value=detections)
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=_fake_llm_result(decisions))
    )
    response = client.post(
        "/upload", files={"image": ("test.png", PNG_BYTES, "image/png")}, data={"path": "declutter"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    app.dependency_overrides.clear()
    return body


def _dec(item_number: int, label: str, decision: str) -> dict:
    return {"item_number": item_number, "label": label, "decision": decision, "reason": "because"}


class FakeListingGenerator:
    """Injected listing model. `by_label` maps an item_label to an
    outcome (a result-like object or an Exception); `default` is used for
    any label not in the map. Records every call."""

    def __init__(self, default=None, by_label=None):
        self.default = default
        self.by_label = by_label or {}
        self.calls: list[dict] = []

    def __call__(self, item_label: str, model_name: str | None = None):
        self.calls.append({"item_label": item_label, "model_name": model_name})
        outcome = self.by_label.get(item_label, self.default)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _ok(title="Used item", description="An ordinary used household item in unspecified condition."):
    return SimpleNamespace(
        raw_text=f'{{"title": "{title}", "description": "{description}"}}',
        parsed_json={"title": title, "description": description},
        is_valid_json=True,
        was_repaired=False,
        model_name="phi4-mini",
        prompt_version="v1",
    )


def _override_listing_generator(generator: FakeListingGenerator) -> None:
    app.dependency_overrides[get_listing_generator_provider] = lambda: (lambda: generator)


def _listings_body(upload_body: dict, overrides=None, **extra) -> dict:
    body = {
        "run_id": upload_body["run_id"],
        "analysis": upload_body["analysis"],
        "declutter": upload_body["declutter"],
        "overrides": overrides or [],
    }
    body.update(extra)
    return body


# ---------------------------------------------------------------------------
# happy paths
# ---------------------------------------------------------------------------


def test_all_eligible_items_generate_200_with_confirmation_and_order():
    upload = _do_declutter_upload(
        [_dec(1, "lamp", "sell"), _dec(2, "chair", "keep"), _dec(3, "book", "sell")]
    )
    gen = FakeListingGenerator(default=_ok())
    _override_listing_generator(gen)

    response = client.post("/listings", json=_listings_body(upload))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["run_id"] == upload["run_id"]
    assert "confirmed_decisions" in body["confirmation"]
    ids = [d["item_id"] for d in body["drafts"]]
    sell_ids = [
        c["item_id"] for c in body["confirmation"]["confirmed_decisions"] if c["confirmed_decision"] == "sell"
    ]
    assert ids == sell_ids
    assert all(d["status"] == "generated" for d in body["drafts"])
    assert body["model_name"] == "phi4-mini"
    assert body["prompt_version"] == "v1"
    assert [c["item_label"] for c in gen.calls] == ["lamp", "book"]


def test_zero_eligible_items_returns_200_empty_and_no_model_call():
    upload = _do_declutter_upload([_dec(1, "lamp", "keep"), _dec(2, "chair", "donate")])
    gen = FakeListingGenerator(default=_ok())
    _override_listing_generator(gen)

    response = client.post("/listings", json=_listings_body(upload))

    assert response.status_code == 200
    body = response.json()
    assert body["drafts"] == []
    assert body["model_name"] is None
    assert body["prompt_version"] is None
    assert gen.calls == []


def test_override_to_sell_makes_an_item_eligible():
    upload = _do_declutter_upload([_dec(1, "lamp", "keep")])
    gen = FakeListingGenerator(default=_ok())
    _override_listing_generator(gen)

    response = client.post(
        "/listings",
        json=_listings_body(upload, overrides=[{"item_id": "item_001", "decision": "sell"}]),
    )

    assert response.status_code == 200
    body = response.json()
    assert [d["item_id"] for d in body["drafts"]] == ["item_001"]
    assert body["drafts"][0]["status"] == "generated"


# ---------------------------------------------------------------------------
# partial success / sanitisation
# ---------------------------------------------------------------------------


def test_partial_success_one_unavailable_others_generated_no_raw_error_leaked():
    upload = _do_declutter_upload(
        [_dec(1, "lamp", "sell"), _dec(2, "desk", "sell"), _dec(3, "book", "sell")]
    )
    gen = FakeListingGenerator(
        default=_ok(),
        by_label={"desk": ListingModelUnavailableError("[Errno 111] Connection refused to http://localhost:11434")},
    )
    _override_listing_generator(gen)

    response = client.post("/listings", json=_listings_body(upload))

    assert response.status_code == 200
    body = response.json()
    by_id = {d["item_id"]: d for d in body["drafts"]}
    assert by_id["item_001"]["status"] == "generated"
    assert by_id["item_002"]["status"] == "unavailable"
    assert by_id["item_002"]["unavailable_reason"] == "service_unavailable"
    assert by_id["item_003"]["status"] == "generated"
    # nothing raw leaks into the response
    assert "Errno" not in response.text
    assert "11434" not in response.text
    assert "Traceback" not in response.text


def test_total_unavailability_is_still_200():
    upload = _do_declutter_upload([_dec(1, "lamp", "sell"), _dec(2, "book", "sell")])
    gen = FakeListingGenerator(default=ListingModelTimeoutError("timed out"))
    _override_listing_generator(gen)

    response = client.post("/listings", json=_listings_body(upload))

    assert response.status_code == 200
    body = response.json()
    assert [d["status"] for d in body["drafts"]] == ["unavailable", "unavailable"]
    assert all(d["unavailable_reason"] == "timeout" for d in body["drafts"])
    assert body["model_name"] == "phi4-mini"


# ---------------------------------------------------------------------------
# request shape — extra="forbid" and consistency
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "extra",
    [
        {"confirmation": {"run_id": "run1", "confirmed_decisions": [], "confirmed_keep_ids": []}},
        {"eligible_item_ids": ["item_001"]},
        {"sell_item_ids": ["item_001"]},
        {"user_context": "make it sound great"},
        {"model_name": "gpt-4"},
        {"drafts": []},
        {"title": "nope"},
    ],
)
def test_forbidden_request_fields_are_rejected(extra):
    upload = _do_declutter_upload([_dec(1, "lamp", "sell")])
    _override_listing_generator(FakeListingGenerator(default=_ok()))

    response = client.post("/listings", json=_listings_body(upload, **extra))

    assert response.status_code == 422


def test_run_id_mismatch_with_analysis_is_rejected():
    upload = _do_declutter_upload([_dec(1, "lamp", "sell")])
    _override_listing_generator(FakeListingGenerator(default=_ok()))

    body = _listings_body(upload)
    body["run_id"] = "some-other-run"
    response = client.post("/listings", json=body)

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# propagated confirmation errors
# ---------------------------------------------------------------------------


def test_incomplete_declutter_returns_409():
    upload = _do_declutter_upload([_dec(1, "lamp", "sell")])
    _override_listing_generator(FakeListingGenerator(default=_ok()))

    body = _listings_body(upload)
    # Force the round-tripped declutter to look unresolved.
    body["declutter"]["unresolved_item_ids"] = ["item_001"]
    body["declutter"]["ai_decisions"] = []
    body["declutter"]["item_validity"] = {"item_001": "still_invalid"}

    response = client.post("/listings", json=body)
    assert response.status_code == 409


def test_unknown_override_id_returns_422():
    upload = _do_declutter_upload([_dec(1, "lamp", "sell")])
    _override_listing_generator(FakeListingGenerator(default=_ok()))

    response = client.post(
        "/listings",
        json=_listings_body(upload, overrides=[{"item_id": "item_999", "decision": "keep"}]),
    )
    assert response.status_code == 422


def test_duplicate_override_ids_return_422():
    upload = _do_declutter_upload([_dec(1, "lamp", "sell")])
    _override_listing_generator(FakeListingGenerator(default=_ok()))

    response = client.post(
        "/listings",
        json=_listings_body(
            upload,
            overrides=[
                {"item_id": "item_001", "decision": "keep"},
                {"item_id": "item_001", "excluded": True},
            ],
        ),
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# import boundary
# ---------------------------------------------------------------------------


def test_importing_routes_and_main_does_not_load_ollama_or_the_listing_model():
    code = (
        "import sys\n"
        "import app.main\n"
        "heavy = {'torch', 'clip', 'ollama', 'app.models.clip_scene', "
        "'app.models.grounding_dino', 'app.models.mistral_llm', 'app.models.reorganise_llm'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr
