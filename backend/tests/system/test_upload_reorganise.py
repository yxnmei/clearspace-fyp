"""
System/API tests for POST /upload (reorganise path, R4). Fakes only, at
the model-callable boundary (the same scene_classifier/detector
Protocols analyse_image() already accepts) — never a real CLIP/Grounding
DINO call. Mirrors tests/system/test_upload_declutter.py's own
conventions, kept independent (no cross-file imports between system
test files, matching this codebase's existing pattern).
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


def _override_providers(scene_fn=None, detector_fn=None, llm_fn=None):
    scene_fn = scene_fn or CallRecorder(return_value=DEFAULT_SCENE)
    detector_fn = detector_fn or CallRecorder(return_value=[])
    llm_fn = llm_fn or CallRecorder(return_value=None)
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(lambda: scene_fn)
    app.dependency_overrides[get_detector_provider] = _provider_override(lambda: detector_fn)
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)
    return scene_fn, detector_fn, llm_fn


# ---------------------------------------------------------------------------
# Primary success / composition
# ---------------------------------------------------------------------------


def test_reorganise_upload_returns_analysis_and_correct_hash():
    detections = [FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.9)]
    scene_fn, detector_fn, llm_fn = _override_providers(detector_fn=CallRecorder(return_value=detections))

    image_bytes = _tiny_valid_png_bytes()
    response = client.post(
        "/upload",
        files={"image": ("test.png", image_bytes, "image/png")},
        data={"path": "reorganise"},
    )

    assert response.status_code == 200
    body = response.json()

    assert set(body.keys()) == {"run_id", "path", "analysis", "input_image_sha256"}
    assert body["path"] == "reorganise"
    assert "declutter" not in body

    run_id = body["run_id"]
    assert body["analysis"]["run_id"] == run_id

    assert body["input_image_sha256"] == hashlib.sha256(image_bytes).hexdigest()

    # scene/detector were used (real analyse_image() composition)
    assert scene_fn.calls[0]["args"][0] == image_bytes
    assert detector_fn.calls[0]["args"][0] == image_bytes

    # the LLM-classifier loader/callable is never touched for reorganise
    assert llm_fn.calls == []


def test_reorganise_upload_stable_item_ids_reach_response():
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.0, 0.0, 0.2, 0.2), confidence=0.8),
        FakeDetection(label="book", box_xyxy=(0.5, 0.5, 0.7, 0.7), confidence=0.6),
    ]
    _override_providers(detector_fn=CallRecorder(return_value=detections))

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "reorganise"},
    )

    assert response.status_code == 200
    items = response.json()["analysis"]["items"]
    assert [item["item_id"] for item in items] == ["item_001", "item_002"]


def test_reorganise_upload_duplicate_labels_remain_distinct():
    detections = [
        FakeDetection(label="picture frame", box_xyxy=(0.0, 0.0, 0.2, 0.2), confidence=0.5),
        FakeDetection(label="picture frame", box_xyxy=(0.0, 0.3, 0.2, 0.5), confidence=0.5),
    ]
    _override_providers(detector_fn=CallRecorder(return_value=detections))

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "reorganise"},
    )

    assert response.status_code == 200
    items = response.json()["analysis"]["items"]
    item_ids = [item["item_id"] for item in items]
    assert item_ids == ["item_001", "item_002"]
    assert all(item["clean_label"] == "picture frame" for item in items)


def test_reorganise_upload_zero_detections_is_a_valid_success():
    _override_providers(detector_fn=CallRecorder(return_value=[]))
    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "reorganise"},
    )
    assert response.status_code == 200
    assert response.json()["analysis"]["items"] == []


# ---------------------------------------------------------------------------
# Error mapping — same typed mapping declutter already uses
# ---------------------------------------------------------------------------


def test_reorganise_upload_invalid_image_returns_400():
    scene_fn, detector_fn, llm_fn = _override_providers()
    response = client.post(
        "/upload",
        files={"image": ("bad.png", b"this is not a real image", "image/png")},
        data={"path": "reorganise"},
    )
    assert response.status_code == 400
    assert scene_fn.calls == [] and detector_fn.calls == [] and llm_fn.calls == []


def test_reorganise_upload_scene_classification_failure_returns_503():
    _override_providers(scene_fn=CallRecorder(side_effect=RuntimeError("clip model unavailable")))
    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "reorganise"},
    )
    assert response.status_code == 503
    assert "clip model unavailable" not in response.text


def test_reorganise_upload_detection_failure_returns_503():
    _override_providers(detector_fn=CallRecorder(side_effect=RuntimeError("grounding dino weights missing")))
    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "reorganise"},
    )
    assert response.status_code == 503
    assert "grounding dino weights missing" not in response.text


# ---------------------------------------------------------------------------
# Declutter regression + both path
# ---------------------------------------------------------------------------


def test_declutter_path_still_returns_declutter_shape():
    detections = [FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.9)]
    llm_result_module = pytest.importorskip("dataclasses")  # no-op, keeps import local/minimal

    from app.core.schemas import ItemValidity

    @dataclass
    class FakeLLMResult:
        raw_text: str
        parsed_json: object
        is_valid_json: bool
        model_name: str
        prompt_version: str
        item_provenance: dict

    llm_fn = CallRecorder(
        return_value=FakeLLMResult(
            raw_text="fake",
            parsed_json=[{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"}],
            is_valid_json=True,
            model_name="phi4-mini",
            prompt_version="v2",
            item_provenance={1: ItemValidity.RAW_VALID},
        )
    )
    _override_providers(detector_fn=CallRecorder(return_value=detections), llm_fn=llm_fn)

    response = client.post(
        "/upload",
        files={"image": ("test.png", _tiny_valid_png_bytes(), "image/png")},
        data={"path": "declutter"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "declutter"
    assert set(body.keys()) == {"run_id", "path", "analysis", "declutter"}
    assert llm_fn.calls  # declutter DOES call the LLM classifier


def test_both_path_still_returns_501():
    scene_fn, detector_fn, llm_fn = _override_providers()
    response = client.post(
        "/upload",
        files={"image": ("test.png", b"irrelevant", "image/png")},
        data={"path": "both"},
    )
    assert response.status_code == 501
    assert scene_fn.calls == [] and detector_fn.calls == [] and llm_fn.calls == []
