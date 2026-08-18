"""
System/API tests for POST /generate/confirmed (Both, R6). Fakes only,
never a real Ollama or Colab/HTTP call. Uses a real POST /upload
(path="both") call first to obtain a genuine AnalysisResult +
DeclutterResult + input_image_sha256, then builds /generate/confirmed
requests from that real response, exactly as a real frontend would.
Mirrors tests/system/test_generate_reorganise.py's own conventions.
"""

from __future__ import annotations

import base64
import hashlib
import io
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.routes import (
    get_detector_provider,
    get_health_checker_provider,
    get_image_generator_provider,
    get_llm_classifier_provider,
    get_reorganise_planner_provider,
    get_scene_classifier_provider,
)
from app.core.schemas import ItemValidity
from app.main import app
from app.models.image_gen_client import (
    IMAGE_GEN_API_VERSION,
    GenerationResult,
    ImageGenUnavailableError,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    yield
    app.dependency_overrides.clear()


def _png_bytes(color=(0, 255, 0)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (10, 10), color=color).save(buf, format="PNG")
    return buf.getvalue()


PNG_BYTES = _png_bytes()
OTHER_PNG_BYTES = _png_bytes(color=(255, 0, 0))


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


def _do_both_upload(decisions: list[dict], image_bytes: bytes = PNG_BYTES) -> dict:
    """decisions: [{"item_number": int, "label": str, "decision": str, "reason": str}, ...]
    — one detection per decision, in item_number order."""
    detections = [
        FakeDetection(label=d["label"], box_xyxy=(0.1 * i, 0.1, 0.1 * i + 0.2, 0.3), confidence=0.9)
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
        "/upload", files={"image": ("test.png", image_bytes, "image/png")}, data={"path": "both"}
    )
    assert response.status_code == 200
    body = response.json()
    app.dependency_overrides.clear()
    return body


def _valid_plan_json(item_ids: list[str]) -> dict:
    return {
        "zones": [{"zone_name": "Keep in place", "item_ids": item_ids, "instruction": "keep as is"}],
        "image_prompt": "a tidy bedroom",
        "negative_prompt": None,
    }


class FakePlanResult:
    def __init__(self, parsed_json, is_valid_json=True, was_repaired=False, model_name="phi4-mini", prompt_version="v1"):
        self.raw_text = "fake"
        self.parsed_json = parsed_json
        self.is_valid_json = is_valid_json
        self.was_repaired = was_repaired
        self.model_name = model_name
        self.prompt_version = prompt_version


class FakePlanner:
    def __init__(self, result=None):
        self.calls: list[dict] = []
        self._result = result

    def __call__(self, run_id, selected_items, scene_label, user_context, validation_feedback=None, model_name=None):
        self.calls.append(dict(run_id=run_id, selected_items=selected_items))
        if self._result is not None:
            return self._result
        return FakePlanResult(_valid_plan_json([item.item_id for item in selected_items]))


class FakeGenerator:
    def __init__(self, result=None, exception=None):
        self.calls: list[dict] = []
        self._result = result
        self._exception = exception

    def __call__(
        self,
        run_id,
        image_bytes,
        image_media_type,
        prompt,
        negative_prompt=None,
        denoise_strength=None,
        controlnet_conditioning_scale=None,
        seed=None,
    ):
        self.calls.append(dict(run_id=run_id, image_bytes=image_bytes, prompt=prompt))
        if self._exception is not None:
            raise self._exception
        if self._result is not None:
            return self._result
        return _generation_result(run_id, image_bytes, prompt)


def _generation_result(run_id: str, image_bytes: bytes, prompt: str) -> GenerationResult:
    return GenerationResult(
        run_id=run_id,
        image_bytes=image_bytes,
        image_media_type="image/png",
        depth_map_used=True,
        denoise_strength=0.35,
        controlnet_conditioning_scale=1.0,
        seed=42,
        base_model="runwayml/stable-diffusion-v1-5",
        controlnet_model="lllyasviel/sd-controlnet-depth",
        service_version="colab-dev-0.1",
        api_version=IMAGE_GEN_API_VERSION,
        prompt_sha256=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        input_image_sha256=hashlib.sha256(image_bytes).hexdigest(),
        generation_ms=1234.5,
    )


class LoaderRecorder:
    """A zero-arg loader thunk override, matching get_reorganise_planner_provider's
    contract — used here (instead of _provider_override's plain lambda) so
    tests can assert whether the loader itself was ever invoked, separate
    from whether the resulting planner was called."""

    def __init__(self, planner: FakePlanner | None = None):
        self.calls = 0
        self._planner = planner or FakePlanner()

    def __call__(self) -> FakePlanner:
        self.calls += 1
        return self._planner


def _override_generate_deps(planner=None, generator=None):
    loader = LoaderRecorder(planner)
    generator = generator or FakeGenerator()
    app.dependency_overrides[get_reorganise_planner_provider] = lambda: loader
    app.dependency_overrides[get_image_generator_provider] = lambda: generator
    return loader, generator


def _confirmed_generate_body(upload_body: dict, image_bytes: bytes, overrides=None, **field_overrides) -> dict:
    body = {
        "run_id": upload_body["run_id"],
        "analysis": upload_body["analysis"],
        "declutter": upload_body["declutter"],
        "overrides": overrides or [],
        "image": base64.b64encode(image_bytes).decode("ascii"),
        "image_media_type": "image/png",
        "input_image_sha256": upload_body["input_image_sha256"],
        "user_context": None,
    }
    body.update(field_overrides)
    return body


# ---------------------------------------------------------------------------
# Success path — server-derived selection
# ---------------------------------------------------------------------------


def test_generate_confirmed_success_returns_generated_image_and_confirmation():
    upload_body = _do_both_upload(
        [
            {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still useful"},
            {"item_number": 2, "label": "book", "decision": "donate", "reason": "already read"},
        ]
    )
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 200
    result = response.json()

    # server-derived: only item_001 (Keep) reaches the planner, never item_002
    assert result["confirmation"]["confirmed_keep_ids"] == ["item_001"]
    assert [item.item_id for item in loader._planner.calls[0]["selected_items"]] == ["item_001"]

    assert result["image_status"] == "generated"
    assert result["image"]["api_version"] == IMAGE_GEN_API_VERSION
    assert result["planning"]["attempts"] == 1
    assert result["planning"]["provenance"] == "raw_valid"
    assert loader.calls == 1
    assert len(generator.calls) == 1


def test_generate_confirmed_overrides_change_the_server_derived_keep_set():
    upload_body = _do_both_upload(
        [
            {"item_number": 1, "label": "lamp", "decision": "discard", "reason": "broken"},
            {"item_number": 2, "label": "book", "decision": "keep", "reason": "reading it"},
        ]
    )
    loader, generator = _override_generate_deps()
    overrides = [{"item_id": "item_001", "decision": "keep"}]
    body = _confirmed_generate_body(upload_body, PNG_BYTES, overrides=overrides)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 200
    result = response.json()
    assert result["confirmation"]["confirmed_keep_ids"] == ["item_001", "item_002"]
    assert [item.item_id for item in loader._planner.calls[0]["selected_items"]] == ["item_001", "item_002"]


def test_generate_confirmed_duplicate_label_items_resolve_independently():
    upload_body = _do_both_upload(
        [
            {"item_number": 1, "label": "picture frame", "decision": "keep", "reason": "sentimental"},
            {"item_number": 2, "label": "picture frame", "decision": "sell", "reason": "duplicate"},
        ]
    )
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 200
    result = response.json()
    assert result["confirmation"]["confirmed_keep_ids"] == ["item_001"]


def test_generate_confirmed_response_run_ids_all_agree():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 200
    result = response.json()
    assert result["run_id"] == upload_body["run_id"]
    assert result["planning"]["run_id"] == upload_body["run_id"]
    assert result["confirmation"]["run_id"] == upload_body["run_id"]


def test_generate_confirmed_unavailable_generation_preserves_plan_and_confirmation():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    _override_generate_deps(generator=FakeGenerator(exception=ImageGenUnavailableError("down")))
    body = _confirmed_generate_body(upload_body, PNG_BYTES)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 200
    result = response.json()
    assert result["image_status"] == "unavailable"
    assert result["image_unavailable_reason"] == "service_unreachable"
    assert result["image"] is None
    assert result["planning"]["plan"]["zones"]
    assert result["confirmation"]["confirmed_keep_ids"] == ["item_001"]


# ---------------------------------------------------------------------------
# Empty confirmed Keep — 409, zero downstream calls
# ---------------------------------------------------------------------------


def test_generate_confirmed_empty_keep_returns_409_and_calls_nothing():
    upload_body = _do_both_upload(
        [
            {"item_number": 1, "label": "lamp", "decision": "sell", "reason": "not needed"},
            {"item_number": 2, "label": "book", "decision": "donate", "reason": "already read"},
        ]
    )
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 409
    assert loader.calls == 0  # the real ollama import never happens
    assert loader._planner.calls == []
    assert generator.calls == []


def test_generate_confirmed_all_keep_excluded_returns_409():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    overrides = [{"item_id": "item_001", "excluded": True}]
    body = _confirmed_generate_body(upload_body, PNG_BYTES, overrides=overrides)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 409
    assert loader.calls == 0
    assert generator.calls == []


# ---------------------------------------------------------------------------
# Incomplete Declutter -> 409
# ---------------------------------------------------------------------------


def test_generate_confirmed_incomplete_declutter_returns_409():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()

    # Simulate an incomplete DeclutterResult by clearing ai_decisions and
    # marking the one expected item unresolved — declutter.expected_item_ids
    # is left as-is so the schema-level matched-pair check still passes;
    # only completeness (unresolved_item_ids) is violated.
    declutter = dict(upload_body["declutter"])
    declutter["ai_decisions"] = []
    declutter["unresolved_item_ids"] = ["item_001"]
    declutter["item_validity"] = {"item_001": "still_invalid"}
    upload_body = dict(upload_body, declutter=declutter)

    body = _confirmed_generate_body(upload_body, PNG_BYTES)
    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 409
    assert loader.calls == 0
    assert generator.calls == []


# ---------------------------------------------------------------------------
# Invalid overrides -> 422
# ---------------------------------------------------------------------------


def test_generate_confirmed_unknown_override_item_id_returns_422():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    overrides = [{"item_id": "item_999", "decision": "discard"}]
    body = _confirmed_generate_body(upload_body, PNG_BYTES, overrides=overrides)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader.calls == 0
    assert generator.calls == []


def test_generate_confirmed_override_missing_both_fields_returns_422():
    # DecisionOverride requires at least one of decision/excluded — an
    # override setting neither is a 422 at the pydantic layer, before
    # this endpoint's own body ever runs.
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    overrides = [{"item_id": "item_001"}]
    body = _confirmed_generate_body(upload_body, PNG_BYTES, overrides=overrides)

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader.calls == 0
    assert generator.calls == []


# ---------------------------------------------------------------------------
# Mismatched analysis/declutter -> 422
# ---------------------------------------------------------------------------


def test_generate_confirmed_run_id_mismatch_returns_422():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES, run_id="a-different-run-id")

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader.calls == 0
    assert generator.calls == []


def test_generate_confirmed_mismatched_expected_ids_returns_422():
    upload_body = _do_both_upload(
        [
            {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"},
            {"item_number": 2, "label": "book", "decision": "donate", "reason": "read"},
        ]
    )
    loader, generator = _override_generate_deps()
    # Corrupt declutter to only expect one of the two actionable items —
    # analysis/declutter are no longer a genuine matched pair.
    declutter = dict(upload_body["declutter"])
    declutter["expected_item_ids"] = ["item_001"]
    declutter["ai_decisions"] = [d for d in declutter["ai_decisions"] if d["item_id"] == "item_001"]
    declutter["item_validity"] = {"item_001": declutter["item_validity"]["item_001"]}
    upload_body = dict(upload_body, declutter=declutter)

    body = _confirmed_generate_body(upload_body, PNG_BYTES)
    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader.calls == 0
    assert generator.calls == []


# ---------------------------------------------------------------------------
# selected_item_ids rejected as an unrecognised field
# ---------------------------------------------------------------------------


def test_generate_confirmed_rejects_selected_item_ids_field():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES)
    body["selected_item_ids"] = ["item_001"]

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader.calls == 0
    assert generator.calls == []


def test_generate_confirmed_rejects_unrelated_unknown_top_level_field():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES)
    body["some_unrecognised_field"] = "surprise"

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader.calls == 0
    assert generator.calls == []


# ---------------------------------------------------------------------------
# Image/hash validation
# ---------------------------------------------------------------------------


def test_generate_confirmed_image_hash_mismatch_returns_422():
    # Image/hash validation happens INSIDE run_reorganise_pipeline(),
    # after the planner loader is already resolved (mirroring /generate's
    # own existing behavior — see generate_reorganisation() in routes.py,
    # which resolves its loader unconditionally too) — so the loader
    # itself is resolved here, but the real planner/ollama call (and the
    # image generator) is never reached.
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(
        upload_body, PNG_BYTES, input_image_sha256=hashlib.sha256(OTHER_PNG_BYTES).hexdigest()
    )

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader._planner.calls == []
    assert generator.calls == []


def test_generate_confirmed_invalid_base64_returns_422():
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES)
    body["image"] = "not-valid-base64!!!"

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader.calls == 0
    assert generator.calls == []


def test_generate_confirmed_media_type_mismatch_returns_422():
    # Same reasoning as the hash-mismatch test above: the loader is
    # resolved, but the real planner/ollama call and the image generator
    # are never reached.
    upload_body = _do_both_upload([{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}])
    loader, generator = _override_generate_deps()
    body = _confirmed_generate_body(upload_body, PNG_BYTES, image_media_type="image/jpeg")

    response = client.post("/generate/confirmed", json=body)

    assert response.status_code == 422
    assert loader._planner.calls == []
    assert generator.calls == []


# ---------------------------------------------------------------------------
# Existing endpoints unaffected
# ---------------------------------------------------------------------------


def test_health_endpoint_still_works_and_is_unrelated():
    app.dependency_overrides[get_health_checker_provider] = lambda: (lambda: True)
    response = client.get("/image-gen/health")
    assert response.status_code == 200
    assert response.json() == {"available": True}
