"""
System/API tests for POST /generate and GET /image-gen/health (R4).
Fakes only — never a real Ollama or Colab/HTTP call. Uses a real
POST /upload (path="reorganise") call first to obtain a genuine
AnalysisResult + input_image_sha256, then builds /generate requests from
that real response, exactly as a real frontend would.
"""

from __future__ import annotations

import base64
import hashlib
import io
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from app.api.routes import (
    GeneratedImagePayload,
    get_detector_provider,
    get_health_checker_provider,
    get_image_generator_provider,
    get_llm_classifier_provider,
    get_scene_classifier_provider,
)
from app.main import app
from app.models.image_gen_client import (
    IMAGE_GEN_API_VERSION,
    GenerationResult,
    ImageGenRequestError,
    ImageGenResponseError,
    ImageGenServiceError,
    ImageGenTimeoutError,
    ImageGenUnavailableError,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]

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


def _do_reorganise_upload(image_bytes: bytes = PNG_BYTES) -> dict:
    detections = [
        FakeDetection(label="lamp", box_xyxy=(0.1, 0.1, 0.3, 0.3), confidence=0.9),
        FakeDetection(label="book", box_xyxy=(0.5, 0.5, 0.7, 0.7), confidence=0.6),
    ]
    app.dependency_overrides[get_scene_classifier_provider] = _provider_override(
        lambda: CallRecorder(return_value=DEFAULT_SCENE)
    )
    app.dependency_overrides[get_detector_provider] = _provider_override(
        lambda: CallRecorder(return_value=detections)
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: CallRecorder())

    response = client.post(
        "/upload", files={"image": ("test.png", image_bytes, "image/png")}, data={"path": "reorganise"}
    )
    assert response.status_code == 200
    body = response.json()
    app.dependency_overrides.clear()
    return body


class FakeLLMResult:
    def __init__(self, parsed_json, is_valid_json=True, was_repaired=False, model_name="phi4-mini", prompt_version="v1"):
        self.raw_text = "fake"
        self.parsed_json = parsed_json
        self.is_valid_json = is_valid_json
        self.was_repaired = was_repaired
        self.model_name = model_name
        self.prompt_version = prompt_version


def _valid_plan_json(item_ids: list[str]) -> dict:
    return {
        "zones": [{"zone_name": "Keep in place", "item_ids": item_ids, "instruction": "keep as is"}],
        "image_prompt": "a tidy bedroom",
        "negative_prompt": None,
    }


class PlanningSpy:
    """Wraps the REAL production planning function
    (plan_reorganisation_direct) and records each call, rather than
    replacing it with a stub.

    Production no longer injects a planner at all — /generate passes
    llm_planner=None — so there is no planner dependency left to override.
    What these tests still need to assert is whether planning was reached
    at all (every validation-rejection test asserts it was not), and that
    is what `.calls` reports. Delegating to the real function means the
    success path still exercises genuine deterministic planning, not a
    fixture-shaped imitation of it."""

    def __init__(self, real):
        self._real = real
        self.calls: list[dict] = []

    def __call__(self, run_id, selected_items, scene_label, user_context):
        self.calls.append(
            dict(run_id=run_id, selected_items=selected_items, scene_label=scene_label, user_context=user_context)
        )
        return self._real(
            run_id=run_id,
            selected_items=selected_items,
            scene_label=scene_label,
            user_context=user_context,
        )


_planning_spy: PlanningSpy | None = None


@pytest.fixture(autouse=True)
def _spy_on_direct_planning(monkeypatch):
    global _planning_spy
    import app.services.reorganise_pipeline_service as pipeline_mod

    spy = PlanningSpy(pipeline_mod.plan_reorganisation_direct)
    monkeypatch.setattr(pipeline_mod, "plan_reorganisation_direct", spy)
    _planning_spy = spy
    yield
    _planning_spy = None


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
        self.calls.append(
            dict(
                run_id=run_id,
                image_bytes=image_bytes,
                image_media_type=image_media_type,
                prompt=prompt,
                negative_prompt=negative_prompt,
                denoise_strength=denoise_strength,
                controlnet_conditioning_scale=controlnet_conditioning_scale,
                seed=seed,
            )
        )
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


def _override_generate_deps(generator=None):
    """Returns (planning_spy, generator). There is no planner override —
    /generate has no planner dependency any more; the spy observes the
    real direct-planning call instead (see PlanningSpy)."""
    generator = generator or FakeGenerator()
    app.dependency_overrides[get_image_generator_provider] = lambda: generator
    return _planning_spy, generator


def _generate_request_body(upload_body: dict, image_bytes: bytes, selected_item_ids=None, **overrides) -> dict:
    analysis = upload_body["analysis"]
    if selected_item_ids is None:
        selected_item_ids = [item["item_id"] for item in analysis["items"]]
    body = {
        "run_id": upload_body["run_id"],
        "analysis": analysis,
        "selected_item_ids": selected_item_ids,
        "image": base64.b64encode(image_bytes).decode("ascii"),
        "image_media_type": "image/png",
        "input_image_sha256": upload_body["input_image_sha256"],
        "user_context": None,
    }
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# Success path
# ---------------------------------------------------------------------------


def test_generate_success_returns_generated_image_and_full_planning():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES)

    response = client.post("/generate", json=body)

    assert response.status_code == 200
    result = response.json()
    assert result["image_status"] == "generated"
    assert result["image_unavailable_reason"] is None
    assert result["image"]["api_version"] == IMAGE_GEN_API_VERSION
    assert result["image"]["depth_map_used"] is True

    # Complete planning result preserved — and truthful: production makes
    # no LLM call, so zero attempts, no issues, and no model identity.
    planning = result["planning"]
    assert planning["provenance"] == "deterministic_direct"
    assert planning["attempts"] == 0
    assert planning["issues"] == []
    assert planning["model_name"] is None
    assert planning["prompt_version"] is None
    assert len(planning["stage_timings"]) == 1
    assert planning["stage_timings"][0]["stage"] == "reorganise_plan"

    # Every selected item is planned for, exactly once.
    planned = [i for zone in planning["plan"]["zones"] for i in zone["item_ids"]]
    assert sorted(planned) == sorted(body["selected_item_ids"])
    assert len(planned) == len(set(planned))

    assert len(generator.calls) == 1
    assert len(planner.calls) == 1


def test_generate_rejects_client_supplied_tuning_fields():
    # GenerateRequest is extra="forbid" — a client attempting to smuggle
    # denoise_strength/seed must get a loud 422, never a silent 200 that
    # would let them wrongly believe those values affected generation.
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES)
    body["denoise_strength"] = 0.99
    body["seed"] = 7

    response = client.post("/generate", json=body)

    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_rejects_unrelated_unknown_top_level_field():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES)
    body["some_unrecognised_field"] = "surprise"

    response = client.post("/generate", json=body)

    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


# ---------------------------------------------------------------------------
# Image-generation failure states — plan preserved, HTTP 200
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "exception,expected_reason",
    [
        (ImageGenUnavailableError("down"), "service_unreachable"),
        (ImageGenTimeoutError("timed out"), "timeout"),
        (ImageGenRequestError("connection reset"), "request_failed"),
        (ImageGenServiceError("bad status", status_code=500), "service_error"),
        (ImageGenResponseError("malformed"), "invalid_response"),
    ],
)
def test_generate_typed_image_gen_failure_returns_200_plan_preserved(exception, expected_reason):
    upload_body = _do_reorganise_upload()
    _override_generate_deps(generator=FakeGenerator(exception=exception))
    body = _generate_request_body(upload_body, PNG_BYTES)

    response = client.post("/generate", json=body)

    assert response.status_code == 200
    result = response.json()
    assert result["image_status"] == "unavailable"
    assert result["image_unavailable_reason"] == expected_reason
    assert result["image"] is None
    assert result["planning"]["plan"] is not None
    assert result["planning"]["plan"]["zones"]


def test_generate_no_separate_health_call_for_success():
    # get_health_checker_provider is never overridden here at all — /generate
    # has no dependency on it whatsoever (see routes.py), so a successful
    # generation must work with zero health-checker wiring present.
    upload_body = _do_reorganise_upload()
    _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES)
    response = client.post("/generate", json=body)
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Request/selection/image validation — all before planning and generation
# ---------------------------------------------------------------------------


def test_generate_empty_selected_ids_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES, selected_item_ids=[])
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_duplicate_selected_ids_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    ids = [item["item_id"] for item in upload_body["analysis"]["items"]]
    body = _generate_request_body(upload_body, PNG_BYTES, selected_item_ids=[ids[0], ids[0]])
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_unknown_selected_id_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES, selected_item_ids=["item_999"])
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_run_id_mismatch_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES, run_id="a-different-run-id")
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_image_hash_mismatch_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    # Real, valid base64 image — but a hash that doesn't match it.
    body = _generate_request_body(
        upload_body, PNG_BYTES, input_image_sha256=hashlib.sha256(OTHER_PNG_BYTES).hexdigest()
    )
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_malformed_hash_format_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES, input_image_sha256="not-a-real-hash")
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_invalid_base64_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    body = _generate_request_body(upload_body, PNG_BYTES)
    body["image"] = "not-valid-base64!!!"
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_valid_base64_non_image_bytes_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    non_image_bytes = b"this is not an image at all"
    body = _generate_request_body(
        upload_body, PNG_BYTES, image=base64.b64encode(non_image_bytes).decode("ascii")
    )
    # input_image_sha256 must correlate with the ORIGINAL upload's image,
    # so leaving it as-is (hash of PNG_BYTES, not non_image_bytes) means
    # this could fail on hash mismatch OR image validity — both are
    # legitimate 422s; the image-content check runs first inside the
    # pipeline in this design (hash check happens after image validation
    # — see run_reorganise_pipeline's own ordering), so this proves the
    # non-image-bytes case specifically only when the hash also matches.
    body["input_image_sha256"] = hashlib.sha256(non_image_bytes).hexdigest()
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_media_type_mismatch_returns_422():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    # Real PNG bytes, claimed as image/jpeg.
    body = _generate_request_body(upload_body, PNG_BYTES, image_media_type="image/jpeg")
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


def test_generate_different_image_with_old_hash_rejected_before_planning():
    upload_body = _do_reorganise_upload()
    planner, generator = _override_generate_deps()
    # A genuinely different (but valid) image, still claiming the ORIGINAL
    # upload's hash — must be rejected on correlation, not accepted.
    body = _generate_request_body(upload_body, OTHER_PNG_BYTES)  # input_image_sha256 stays the old one
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert planner.calls == [] and generator.calls == []


# ---------------------------------------------------------------------------
# GET /image-gen/health
# ---------------------------------------------------------------------------


def test_health_available_true():
    app.dependency_overrides[get_health_checker_provider] = lambda: (lambda: True)
    response = client.get("/image-gen/health")
    assert response.status_code == 200
    assert response.json() == {"available": True}


def test_health_available_false():
    app.dependency_overrides[get_health_checker_provider] = lambda: (lambda: False)
    response = client.get("/image-gen/health")
    assert response.status_code == 200
    assert response.json() == {"available": False}


def test_health_no_raw_url_or_exception_leakage():
    app.dependency_overrides[get_health_checker_provider] = lambda: (lambda: False)
    response = client.get("/image-gen/health")
    assert "ngrok" not in response.text
    assert "Traceback" not in response.text


# ---------------------------------------------------------------------------
# Import boundary
# ---------------------------------------------------------------------------


def test_importing_routes_and_main_does_not_load_reorganise_llm_or_ollama():
    import subprocess
    import sys
    from pathlib import Path

    backend_dir = Path(__file__).resolve().parents[2]
    code = (
        "import sys\n"
        "import app.main\n"
        "heavy = {'torch', 'clip', 'ollama', 'app.models.clip_scene', "
        "'app.models.grounding_dino', 'app.models.mistral_llm', 'app.models.reorganise_llm'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(backend_dir))
    assert result.returncode == 0, result.stdout + result.stderr


# ---------------------------------------------------------------------------
# GeneratedImagePayload — direct schema invariants (no HTTP, no models)
# ---------------------------------------------------------------------------


def _valid_payload_kwargs(**overrides) -> dict:
    kwargs = dict(
        image=base64.b64encode(PNG_BYTES).decode("ascii"),
        image_media_type="image/png",
        api_version=IMAGE_GEN_API_VERSION,
        depth_map_used=True,
        denoise_strength=0.35,
        controlnet_conditioning_scale=1.0,
        seed=42,
        base_model="runwayml/stable-diffusion-v1-5",
        controlnet_model="lllyasviel/sd-controlnet-depth",
        service_version="colab-dev-0.1",
        generation_ms=1234.5,
        prompt_sha256=hashlib.sha256(b"a tidy bedroom").hexdigest(),
        input_image_sha256=hashlib.sha256(PNG_BYTES).hexdigest(),
    )
    kwargs.update(overrides)
    return kwargs


def test_generated_image_payload_valid_construction_succeeds():
    payload = GeneratedImagePayload(**_valid_payload_kwargs())
    assert payload.api_version == IMAGE_GEN_API_VERSION
    assert payload.depth_map_used is True


def test_generated_image_payload_rejects_wrong_api_version():
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(api_version="v2"))


@pytest.mark.parametrize("bad_hash", ["not-hex", "abc123", "F" * 64, "0" * 63, "0" * 65, ""])
def test_generated_image_payload_rejects_malformed_prompt_hash(bad_hash):
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(prompt_sha256=bad_hash))


@pytest.mark.parametrize("bad_hash", ["not-hex", "abc123", "F" * 64, "0" * 63, "0" * 65, ""])
def test_generated_image_payload_rejects_malformed_input_image_hash(bad_hash):
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(input_image_sha256=bad_hash))


@pytest.mark.parametrize("bad_value", [-0.1, 1.1, float("nan"), float("inf"), float("-inf")])
def test_generated_image_payload_rejects_out_of_range_denoise_strength(bad_value):
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(denoise_strength=bad_value))


@pytest.mark.parametrize("bad_value", [0.0, -1.0, 2.1, float("nan"), float("inf")])
def test_generated_image_payload_rejects_out_of_range_conditioning_scale(bad_value):
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(controlnet_conditioning_scale=bad_value))


@pytest.mark.parametrize("bad_value", [True, False, -1, 2**32, 3.5])
def test_generated_image_payload_rejects_boolean_or_out_of_range_seed(bad_value):
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(seed=bad_value))


@pytest.mark.parametrize("bad_value", [-1.0, float("nan"), float("inf"), float("-inf")])
def test_generated_image_payload_rejects_invalid_generation_ms(bad_value):
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(generation_ms=bad_value))


def test_generated_image_payload_rejects_empty_image():
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(image=""))


def test_generated_image_payload_rejects_malformed_base64_image():
    with pytest.raises(ValidationError):
        GeneratedImagePayload(**_valid_payload_kwargs(image="not-valid-base64!!!"))


# ===================== zero-Ollama proof (production request path) =======


def test_driving_generate_never_imports_ollama_or_the_reorganise_planner():
    """The strongest available proof that production planning makes no
    Ollama call: drive a real /generate request in a FRESH interpreter
    and assert the ollama module and app.models.reorganise_llm are never
    imported at all.

    A subprocess, not an in-process sys.modules check: other tests in
    this session import ollama for unrelated reasons (Declutter's own
    wrapper, the evaluation harness), which would make an in-process
    assertion meaningless.
    """
    code = r"""
import base64, hashlib, io, sys
from PIL import Image
from fastapi.testclient import TestClient

from app.main import app
from app.api.routes import (
    get_detector_provider, get_image_generator_provider,
    get_llm_classifier_provider, get_scene_classifier_provider,
)
from app.models.image_gen_client import GenerationResult, IMAGE_GEN_API_VERSION

buf = io.BytesIO(); Image.new("RGB", (10, 10), color=(0, 255, 0)).save(buf, format="PNG")
png = buf.getvalue()

class Rec:
    def __init__(self, rv): self.rv = rv
    def __call__(self, *a, **k): return self.rv

class Det:
    def __init__(self, label, box, confidence):
        self.label, self.box_xyxy, self.confidence = label, box, confidence

class FakeLLM:
    raw_text = "fake"; is_valid_json = True
    model_name = "phi4-mini"; prompt_version = "v2"
    parsed_json = [{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"}]
    item_provenance = {}

def provider(x):
    return lambda: (lambda: x)

app.dependency_overrides[get_scene_classifier_provider] = provider(
    Rec({"label": "bedroom", "confidence": 0.9, "all_scores": {"bedroom": 0.9}}))
app.dependency_overrides[get_detector_provider] = provider(
    Rec([Det("lamp", (0.1, 0.1, 0.3, 0.3), 0.9)]))
app.dependency_overrides[get_llm_classifier_provider] = provider(Rec(FakeLLM()))

client = TestClient(app)
up = client.post("/upload", files={"image": ("t.png", png, "image/png")}, data={"path": "reorganise"})
assert up.status_code == 200, up.text
body = up.json()

def gen(run_id, image_bytes, image_media_type, prompt, negative_prompt=None,
        denoise_strength=None, controlnet_conditioning_scale=None, seed=None):
    return GenerationResult(
        run_id=run_id, image_bytes=image_bytes, image_media_type="image/png",
        depth_map_used=True, denoise_strength=0.35, controlnet_conditioning_scale=1.0,
        seed=42, base_model="b", controlnet_model="c", service_version="v",
        api_version=IMAGE_GEN_API_VERSION,
        prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
        input_image_sha256=hashlib.sha256(image_bytes).hexdigest(), generation_ms=1.0)

app.dependency_overrides[get_image_generator_provider] = lambda: gen

res = client.post("/generate", json={
    "run_id": body["run_id"], "analysis": body["analysis"],
    "selected_item_ids": [i["item_id"] for i in body["analysis"]["items"]],
    "image": base64.b64encode(png).decode("ascii"), "image_media_type": "image/png",
    "input_image_sha256": body["input_image_sha256"], "user_context": None})
assert res.status_code == 200, res.text
assert res.json()["planning"]["provenance"] == "deterministic_direct"
assert res.json()["planning"]["attempts"] == 0

leaked = {"ollama", "app.models.reorganise_llm"} & set(sys.modules)
assert not leaked, sorted(leaked)
"""
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr
