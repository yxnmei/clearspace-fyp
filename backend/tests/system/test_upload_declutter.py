"""
System/API tests for POST /upload (declutter path) — the first real HTTP
vertical slice. Fakes only, at the model-callable boundary (the same
scene_classifier/detector/llm_classifier Protocols analyse_image()/
run_declutter() already accept) — never a real CLIP/Grounding DINO/Ollama
call, and never a monkeypatch of analyse_image()/run_declutter()
themselves in the primary success test: that test exercises the real
production services end to end, with fakes only at the three
model-loader dependencies FastAPI injects.

Replaces the skipped tests/system/test_placeholder.py::
test_upload_declutter_returns_classified_items placeholder.
"""

from __future__ import annotations

import io
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.schemas import ItemValidity
from app.main import app
from app.api.routes import (
    get_detector_provider,
    get_llm_classifier_provider,
    get_scene_classifier_provider,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    yield
    app.dependency_overrides.clear()


def _tiny_valid_png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (10, 10), color=(255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


@dataclass
class FakeDetection:
    """Matches app.services.analysis_service.RawDetectionLike's shape."""

    label: str
    box_xyxy: tuple[float, float, float, float]
    confidence: float


@dataclass
class FakeLLMResult:
    """Matches app.services.declutter_service.LLMResultLike's shape."""

    raw_text: str
    parsed_json: object
    is_valid_json: bool
    model_name: str
    prompt_version: str
    item_provenance: dict


class CallRecorder:
    """A fake model callable that records every call (args/kwargs) and,
    if `sequence` is given, appends `name` to it — used to prove real
    call ORDER across analyse_image()/run_declutter(), not just that
    each fake was called at all."""

    def __init__(self, name=None, sequence=None, return_value=None, side_effect: Exception | None = None):
        self.name = name
        self.sequence = sequence
        self.calls: list[dict] = []
        self.return_value = return_value
        self.side_effect = side_effect

    def __call__(self, *args, **kwargs):
        self.calls.append({"args": args, "kwargs": kwargs})
        if self.sequence is not None:
            self.sequence.append(self.name)
        if self.side_effect is not None:
            raise self.side_effect
        return self.return_value


def _provider_override(loader):
    """Matches routes.py's two-level provider contract exactly: FastAPI
    resolves a cheap zero-arg override function, whose return value must
    itself be a zero-arg loader that returns the fake model callable. A
    production loader (_load_scene_classifier etc.) has this same shape,
    so overriding this way exercises the identical code path the
    handler uses in production, just with a fake at the end."""

    def _override():
        return loader

    return _override


DEFAULT_SCENE = {"label": "bedroom", "confidence": 0.9, "all_scores": {"bedroom": 0.9, "kitchen": 0.1}}


# ---------------------------------------------------------------------------
# Primary success/composition test — real analyse_image() + real
# run_declutter(), fakes only at the scene_classifier/detector/
# llm_classifier boundary.
# ---------------------------------------------------------------------------


def test_declutter_upload_success_composes_real_services_end_to_end():
    sequence: list[str] = []
    scene_fn = CallRecorder("scene", sequence, return_value=DEFAULT_SCENE)
    detector_fn = CallRecorder(
        "detector", sequence, return_value=[FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.9)]
    )
    llm_fn = CallRecorder(
        "llm",
        sequence,
        return_value=FakeLLMResult(
            raw_text="fake",
            parsed_json=[{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"}],
            is_valid_json=True,
            model_name="phi4-mini",
            prompt_version="v2",
            item_provenance={1: ItemValidity.RAW_VALID},
        ),
    )
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(lambda: scene_fn)
    app.dependency_overrides[get_detector_provider] = _provider_override(lambda: detector_fn)
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    image_bytes = _tiny_valid_png_bytes()
    response = client.post(
        "/upload",
        files={"image": ("test.png", image_bytes, "image/png")},
        data={"path": "declutter", "context": "downsizing before a move"},
    )

    assert response.status_code == 200
    body = response.json()

    # -- explicit response schema (not a flattened/reshaped item list) --
    assert set(body.keys()) == {"run_id", "path", "analysis", "declutter"}
    assert body["path"] == "declutter"
    assert "items" not in body  # no flattened top-level item list was invented

    # -- run_id consistent at every level --
    run_id = body["run_id"]
    assert body["analysis"]["run_id"] == run_id
    assert body["declutter"]["run_id"] == run_id

    # -- uploaded bytes reached analyse_image (via the real scene_classifier/detector calls) --
    assert scene_fn.calls[0]["args"][0] == image_bytes
    assert detector_fn.calls[0]["args"][0] == image_bytes

    # -- real call sequence through the real services: scene -> detector -> llm --
    assert sequence == ["scene", "detector", "llm"]

    # -- real analyse_image() output reached the response, unreshaped --
    assert len(body["analysis"]["items"]) == 1
    item = body["analysis"]["items"][0]
    assert item["item_id"] == "item_001"
    assert item["clean_label"] == "lamp"
    assert "position" in item and "relative_size" in item

    # -- scene label produced by the real analyse_image() reached run_declutter -> llm_classifier --
    assert llm_fn.calls[0]["kwargs"]["scene_label"] == "bedroom"

    # -- user_context (typed, from the Form field) reached run_declutter -> llm_classifier unchanged --
    assert llm_fn.calls[0]["kwargs"]["user_context"] == "downsizing before a move"

    # -- real run_declutter() output reached the response, unreshaped --
    assert body["declutter"]["ai_decisions"] == [
        {"item_id": "item_001", "decision": "keep", "reason": "still useful"}
    ]
    assert body["declutter"]["item_validity"] == {"item_001": "raw_valid"}
    assert body["declutter"]["is_complete"] is True
    assert body["declutter"]["is_strictly_valid"] is True


def test_duplicate_same_label_items_remain_distinct_in_response():
    detections = [
        FakeDetection(label="picture frame", box_xyxy=(0.0, 0.0, 0.2, 0.2), confidence=0.5),
        FakeDetection(label="picture frame", box_xyxy=(0.0, 0.3, 0.2, 0.5), confidence=0.5),
    ]
    llm_response = FakeLLMResult(
        raw_text="fake",
        parsed_json=[
            {"item_number": 1, "label": "picture frame", "decision": "discard", "reason": "duplicate, low value"},
            {"item_number": 2, "label": "picture frame", "decision": "donate", "reason": "still in good shape"},
        ],
        is_valid_json=True,
        model_name="phi4-mini",
        prompt_version="v2",
        item_provenance={1: ItemValidity.RAW_VALID, 2: ItemValidity.RAW_VALID},
    )
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=DEFAULT_SCENE)
    )
    app.dependency_overrides[get_detector_provider] = _provider_override(
        lambda: CallRecorder(return_value=detections)
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=llm_response)
    )

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "declutter"},
    )

    assert response.status_code == 200
    body = response.json()

    item_ids = [item["item_id"] for item in body["analysis"]["items"]]
    assert item_ids == ["item_001", "item_002"]
    assert all(item["clean_label"] == "picture frame" for item in body["analysis"]["items"])

    decisions_by_id = {d["item_id"]: d["decision"] for d in body["declutter"]["ai_decisions"]}
    assert decisions_by_id == {"item_001": "discard", "item_002": "donate"}


def test_complete_after_repair_serialises_is_complete_true_is_strictly_valid_false():
    llm_response = FakeLLMResult(
        raw_text="fake",
        parsed_json=[{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"}],
        is_valid_json=True,
        model_name="phi4-mini",
        prompt_version="v2",
        item_provenance={1: ItemValidity.MECHANICALLY_REPAIRED},
    )
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=DEFAULT_SCENE)
    )
    app.dependency_overrides[get_detector_provider] = _provider_override(
        lambda: CallRecorder(return_value=[FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.9)])
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=llm_response)
    )

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "declutter"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["declutter"]["is_complete"] is True
    assert body["declutter"]["is_strictly_valid"] is False
    assert body["declutter"]["item_validity"] == {"item_001": "mechanically_repaired"}


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------


def test_invalid_image_returns_400_without_invoking_real_model_loaders():
    # All three providers overridden with fake loaders that would prove
    # themselves invoked via CallRecorder — asserting zero calls after
    # the request is what proves image validation happens strictly
    # before any model callable is ever invoked, per this task's
    # explicit requirement (the provider *loaders* are still resolved —
    # that's cheap and expected — but the classify/detect functions
    # themselves must never run).
    scene_fn = CallRecorder(return_value=DEFAULT_SCENE)
    detector_fn = CallRecorder(return_value=[])
    llm_fn = CallRecorder(return_value=None)
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(lambda: scene_fn)
    app.dependency_overrides[get_detector_provider] = _provider_override(lambda: detector_fn)
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post(
        "/upload",
        files={"image": ("bad.png", b"this is not a real image", "image/png")},
        data={"path": "declutter"},
    )

    assert response.status_code == 400
    assert "traceback" not in response.text.lower()
    assert scene_fn.calls == []
    assert detector_fn.calls == []
    assert llm_fn.calls == []


def test_scene_classification_failure_returns_503():
    scene_fn = CallRecorder(side_effect=RuntimeError("clip model unavailable"))
    detector_fn = CallRecorder(return_value=[])
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(lambda: scene_fn)
    app.dependency_overrides[get_detector_provider] = _provider_override(lambda: detector_fn)
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: CallRecorder())

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "declutter"},
    )

    assert response.status_code == 503
    assert "clip model unavailable" not in response.text  # sanitized detail, not str(exc)
    assert detector_fn.calls == []  # scene classification failed before detection ever ran


def test_detection_failure_returns_503():
    detector_fn = CallRecorder(side_effect=RuntimeError("grounding dino weights missing"))
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=DEFAULT_SCENE)
    )
    app.dependency_overrides[get_detector_provider] = _provider_override(lambda: detector_fn)
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: CallRecorder())

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "declutter"},
    )

    assert response.status_code == 503
    assert "grounding dino weights missing" not in response.text


def test_declutter_reasoning_error_returns_503():
    llm_fn = CallRecorder(side_effect=ConnectionError("ollama host unreachable"))
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=DEFAULT_SCENE)
    )
    app.dependency_overrides[get_detector_provider] = _provider_override(
        lambda: CallRecorder(return_value=[FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.9)])
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "declutter"},
    )

    assert response.status_code == 503
    assert "ollama host unreachable" not in response.text


# ---------------------------------------------------------------------------
# Path handling
# ---------------------------------------------------------------------------


# NOTE: the "reorganise path returns 501" placeholder that used to live
# here was removed once /upload's reorganise path was implemented (R4) —
# see tests/system/test_upload_reorganise.py for the real, fake-backed
# replacement (analysis-only, no LLM-classifier call, real 200 response).
# The "both path returns 501" placeholder that used to live here was
# removed the same way once /upload's both path was implemented (R6) —
# see tests/system/test_upload_both.py for the real, fake-backed
# replacement (full declutter-triage response + input_image_sha256).


def test_unknown_path_is_rejected_not_treated_as_declutter():
    scene_fn = CallRecorder(return_value=DEFAULT_SCENE)
    detector_fn = CallRecorder(return_value=[])
    llm_fn = CallRecorder(return_value=None)
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(lambda: scene_fn)
    app.dependency_overrides[get_detector_provider] = _provider_override(lambda: detector_fn)
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post(
        "/upload",
        files={"image": ("test.png", b"irrelevant", "image/png")},
        data={"path": "not-a-real-path"},
    )

    assert response.status_code == 422
    assert scene_fn.calls == [] and detector_fn.calls == [] and llm_fn.calls == []


# ---------------------------------------------------------------------------
# Import boundary + existing /health regression
# ---------------------------------------------------------------------------


def test_importing_routes_and_main_does_not_load_heavy_model_stacks():
    code = (
        "import sys\n"
        "import app.main\n"
        "heavy = {'torch', 'clip', 'ollama', 'app.models.clip_scene', "
        "'app.models.grounding_dino', 'app.models.mistral_llm'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_health_endpoint_still_works():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
