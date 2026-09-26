"""
System/API tests for POST /upload (both path). Fakes only, at the
model-callable boundary (the same scene_classifier/detector/llm_classifier
Protocols analyse_image()/run_declutter() already accept) — never a real
CLIP/Grounding DINO/Ollama call. Mirrors tests/system/test_upload_declutter.py's
and tests/system/test_upload_reorganise.py's own conventions, kept
independent (no cross-file imports between system test files, matching
this codebase's existing pattern).
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import (
    get_detector_provider,
    get_llm_classifier_provider,
    get_scene_classifier_provider,
)
from app.core.schemas import ItemValidity
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    yield
    app.dependency_overrides.clear()


def _tiny_valid_png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (10, 10), color=(0, 255, 0)).save(buf, format="PNG")
    return buf.getvalue()


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


DEFAULT_SCENE = {"label": "bedroom", "confidence": 0.9, "all_scores": {"bedroom": 0.9, "kitchen": 0.1}}


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


def _override_providers(scene_fn=None, detector_fn=None, llm_fn=None):
    scene_fn = scene_fn or CallRecorder(return_value=DEFAULT_SCENE)
    detector_fn = detector_fn or CallRecorder(return_value=[])
    llm_fn = llm_fn or CallRecorder(return_value=_fake_llm_result([]))
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(lambda: scene_fn)
    app.dependency_overrides[get_detector_provider] = _provider_override(lambda: detector_fn)
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)
    return scene_fn, detector_fn, llm_fn


# ---------------------------------------------------------------------------
# Primary success / composition
# ---------------------------------------------------------------------------


def test_both_upload_returns_declutter_and_hash():
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.9),
        FakeDetection(label="book", box_xyxy=(0.5, 0.5, 0.7, 0.7), confidence=0.6),
    ]
    llm_fn = CallRecorder(
        return_value=_fake_llm_result(
            [
                {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"},
                {"item_number": 2, "label": "book", "decision": "donate", "reason": "already read"},
            ]
        )
    )
    scene_fn, detector_fn, llm_fn = _override_providers(detector_fn=CallRecorder(return_value=detections), llm_fn=llm_fn)

    image_bytes = _tiny_valid_png_bytes()
    response = client.post(
        "/upload", files={"image": ("test.png", image_bytes, "image/png")}, data={"path": "both"}
    )

    assert response.status_code == 200
    body = response.json()

    assert set(body.keys()) == {"run_id", "path", "analysis", "declutter", "input_image_sha256"}
    assert body["path"] == "both"

    run_id = body["run_id"]
    assert body["analysis"]["run_id"] == run_id
    assert body["declutter"]["run_id"] == run_id
    assert body["input_image_sha256"] == hashlib.sha256(image_bytes).hexdigest()

    # full declutter triage ran — decisions present for both items
    decisions_by_id = {d["item_id"]: d["decision"] for d in body["declutter"]["ai_decisions"]}
    assert decisions_by_id == {"item_001": "keep", "item_002": "donate"}
    assert body["declutter"]["expected_item_ids"] == ["item_001", "item_002"]

    # all three model boundaries were used — scene/detector (analyse_image)
    # AND the LLM classifier (run_declutter), unlike reorganise's path
    assert scene_fn.calls
    assert detector_fn.calls
    assert llm_fn.calls


def test_both_upload_duplicate_labels_remain_independent():
    detections = [
        FakeDetection(label="picture frame", box_xyxy=(0.0, 0.0, 0.2, 0.2), confidence=0.5),
        FakeDetection(label="picture frame", box_xyxy=(0.0, 0.3, 0.2, 0.5), confidence=0.5),
    ]
    llm_fn = CallRecorder(
        return_value=_fake_llm_result(
            [
                {"item_number": 1, "label": "picture frame", "decision": "keep", "reason": "sentimental"},
                {"item_number": 2, "label": "picture frame", "decision": "sell", "reason": "duplicate"},
            ]
        )
    )
    _override_providers(detector_fn=CallRecorder(return_value=detections), llm_fn=llm_fn)

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "both"},
    )

    assert response.status_code == 200
    body = response.json()
    items = body["analysis"]["items"]
    item_ids = [item["item_id"] for item in items]
    assert item_ids == ["item_001", "item_002"]
    assert all(item["clean_label"] == "picture frame" for item in items)

    # two identically-labeled items resolve to two INDEPENDENT decisions,
    # joined purely by item_id, never merged/confused by label
    decisions_by_id = {d["item_id"]: d["decision"] for d in body["declutter"]["ai_decisions"]}
    assert decisions_by_id == {"item_001": "keep", "item_002": "sell"}


def test_both_upload_zero_detections_is_a_valid_success():
    _override_providers(detector_fn=CallRecorder(return_value=[]))
    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "both"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["analysis"]["items"] == []
    assert body["declutter"]["expected_item_ids"] == []
    assert body["declutter"]["ai_decisions"] == []


# ---------------------------------------------------------------------------
# Error mapping — same typed mapping declutter/reorganise already use
# ---------------------------------------------------------------------------


def test_both_upload_invalid_image_returns_400():
    scene_fn, detector_fn, llm_fn = _override_providers()
    response = client.post(
        "/upload",
        files={"image": ("bad.png", b"this is not a real image", "image/png")},
        data={"path": "both"},
    )
    assert response.status_code == 400
    assert scene_fn.calls == [] and detector_fn.calls == [] and llm_fn.calls == []


def test_both_upload_scene_classification_failure_returns_503():
    _override_providers(scene_fn=CallRecorder(side_effect=RuntimeError("clip model unavailable")))
    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "both"},
    )
    assert response.status_code == 503
    assert "clip model unavailable" not in response.text


def test_both_upload_detection_failure_returns_503():
    _override_providers(detector_fn=CallRecorder(side_effect=RuntimeError("grounding dino weights missing")))
    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "both"},
    )
    assert response.status_code == 503
    assert "grounding dino weights missing" not in response.text


def test_both_upload_llm_reasoning_failure_returns_503():
    detections = [FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.9)]
    _override_providers(
        detector_fn=CallRecorder(return_value=detections),
        llm_fn=CallRecorder(side_effect=RuntimeError("ollama unavailable")),
    )
    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "both"},
    )
    assert response.status_code == 503
    assert "ollama unavailable" not in response.text
