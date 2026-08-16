"""
Unit tests for app/models/image_gen_client.py — the typed Colab transport
contract. Every network call in this file is a monkeypatched fake; no
test performs real HTTP, and no real Colab/Ollama/CLIP/Grounding DINO
service is contacted anywhere here.
"""

from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path

import pytest
import requests
from PIL import Image

from app.config import get_settings
from app.models import image_gen_client
from app.models.image_gen_client import (
    IMAGE_GEN_API_VERSION,
    GenerationResult,
    ImageGenRequestError,
    ImageGenResponseError,
    ImageGenServiceError,
    ImageGenTimeoutError,
    ImageGenUnavailableError,
    check_health,
    generate,
)


def _tiny_image_bytes(fmt: str = "PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), color=(120, 60, 200)).save(buf, format=fmt)
    return buf.getvalue()


PNG_BYTES = _tiny_image_bytes("PNG")
JPEG_BYTES = _tiny_image_bytes("JPEG")


class _FakeResponse:
    def __init__(self, status_code: int = 200, json_data=None, raise_on_json: bool = False):
        self.status_code = status_code
        # Mirrors REAL requests.Response.ok semantics exactly (True for
        # the whole < 400 range, including 3xx) — not strict 2xx. This is
        # deliberate: production code must never rely on `.ok` for a
        # strict-2xx check (see check_health()'s own docstring), and a
        # fake that only ever modeled strict 2xx could never have caught
        # that defect. Production must instead check status_code directly.
        self.ok = status_code < 400
        self._json_data = json_data
        self._raise_on_json = raise_on_json

    def json(self):
        if self._raise_on_json:
            raise ValueError("invalid json")
        return self._json_data


def _fake_get(response=None, exception=None):
    calls: list[dict] = []

    def fake(url, timeout=None):
        calls.append({"url": url, "timeout": timeout})
        if exception is not None:
            raise exception
        return response

    return fake, calls


def _fake_post(response=None, exception=None):
    calls: list[dict] = []

    def fake(url, json=None, timeout=None):
        calls.append({"url": url, "json": json, "timeout": timeout})
        if exception is not None:
            raise exception
        return response

    return fake, calls


def _fail_if_called(*_args, **_kwargs):
    raise AssertionError("requests.get/post must not be called for invalid caller input")


def _valid_health_json(**overrides) -> dict:
    data = {
        "status": "ok",
        "api_version": IMAGE_GEN_API_VERSION,
        "service_version": "colab-dev-0.1",
        "capabilities": {"depth_controlnet": True},
    }
    data.update(overrides)
    return data


def _valid_generation_json(
    *,
    run_id: str = "r1",
    prompt: str = "a tidy room",
    image_bytes: bytes = PNG_BYTES,
    image_media_type: str = "image/png",
    generated_image_bytes: bytes | None = None,
    denoise_strength: float = 0.35,
    controlnet_conditioning_scale: float = 1.0,
    seed: int = 42,
    **overrides,
) -> dict:
    if generated_image_bytes is None:
        generated_image_bytes = PNG_BYTES if image_media_type == "image/png" else JPEG_BYTES
    data = {
        "api_version": IMAGE_GEN_API_VERSION,
        "service_version": "colab-dev-0.1",
        "run_id": run_id,
        "image": base64.b64encode(generated_image_bytes).decode("ascii"),
        "image_media_type": image_media_type,
        "depth_map_used": True,
        "denoise_strength": denoise_strength,
        "controlnet_conditioning_scale": controlnet_conditioning_scale,
        "seed": seed,
        "base_model": "runwayml/stable-diffusion-v1-5",
        "controlnet_model": "lllyasviel/sd-controlnet-depth",
        "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "input_image_sha256": hashlib.sha256(image_bytes).hexdigest(),
        "generation_ms": 1234.5,
    }
    data.update(overrides)
    return data


def _base_generate_kwargs() -> dict:
    return dict(run_id="r1", image_bytes=PNG_BYTES, image_media_type="image/png", prompt="a tidy room")


def _good_response_json() -> dict:
    settings = get_settings()
    return _valid_generation_json(
        run_id="r1",
        prompt="a tidy room",
        image_bytes=PNG_BYTES,
        image_media_type="image/png",
        denoise_strength=settings.image_gen_denoise_strength,
        controlnet_conditioning_scale=settings.image_gen_controlnet_conditioning_scale,
        seed=settings.image_gen_seed,
    )


def _setup_successful_generate(monkeypatch, **generate_kwargs):
    kwargs = _base_generate_kwargs()
    kwargs.update(generate_kwargs)
    settings = get_settings()

    get_fake, get_calls = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)

    response_json = _valid_generation_json(
        run_id=kwargs["run_id"].strip() if isinstance(kwargs["run_id"], str) else kwargs["run_id"],
        prompt=kwargs["prompt"].strip(),
        image_bytes=kwargs["image_bytes"],
        image_media_type=kwargs["image_media_type"],
        denoise_strength=kwargs.get("denoise_strength")
        if kwargs.get("denoise_strength") is not None
        else settings.image_gen_denoise_strength,
        controlnet_conditioning_scale=kwargs.get("controlnet_conditioning_scale")
        if kwargs.get("controlnet_conditioning_scale") is not None
        else settings.image_gen_controlnet_conditioning_scale,
        seed=kwargs.get("seed") if kwargs.get("seed") is not None else settings.image_gen_seed,
    )
    post_fake, post_calls = _fake_post(response=_FakeResponse(200, response_json))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    result = generate(**kwargs)
    return result, get_calls, post_calls


def _assert_response_rejected(monkeypatch, data, **generate_kwargs):
    kwargs = _base_generate_kwargs()
    kwargs.update(generate_kwargs)
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, _ = _fake_post(response=_FakeResponse(200, data))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)
    with pytest.raises(ImageGenResponseError):
        generate(**kwargs)


# ============================================================ health ====


def test_health_correct_url(monkeypatch):
    fake, calls = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)

    check_health()

    assert calls[0]["url"] == f"{get_settings().image_gen_base_url}/health"


def test_health_uses_configured_timeout(monkeypatch):
    fake, calls = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)

    check_health()

    assert calls[0]["timeout"] == get_settings().image_gen_health_timeout_s


def test_health_trailing_slash_base_url_normalized(monkeypatch):
    fake, calls = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)

    settings = get_settings()
    trailing = settings.model_copy(update={"image_gen_base_url": settings.image_gen_base_url + "/"})
    monkeypatch.setattr(image_gen_client, "get_settings", lambda: trailing)

    check_health()

    assert calls[0]["url"] == f"{settings.image_gen_base_url}/health"
    assert "//health" not in calls[0]["url"]


def test_health_valid_compatible_returns_true(monkeypatch):
    fake, _calls = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is True


def test_health_timeout_returns_false(monkeypatch):
    fake, _calls = _fake_get(exception=requests.Timeout("timed out"))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_request_exception_returns_false(monkeypatch):
    fake, _calls = _fake_get(exception=requests.ConnectionError("down"))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_non_2xx_returns_false(monkeypatch):
    fake, _calls = _fake_get(response=_FakeResponse(503, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_invalid_json_returns_false(monkeypatch):
    fake, _calls = _fake_get(response=_FakeResponse(200, None, raise_on_json=True))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_non_object_json_returns_false(monkeypatch):
    fake, _calls = _fake_get(response=_FakeResponse(200, ["not", "an", "object"]))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_wrong_api_version_returns_false(monkeypatch):
    fake, _calls = _fake_get(response=_FakeResponse(200, _valid_health_json(api_version="v2")))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_blank_service_version_returns_false(monkeypatch):
    fake, _calls = _fake_get(response=_FakeResponse(200, _valid_health_json(service_version="   ")))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_missing_capabilities_returns_false(monkeypatch):
    data = _valid_health_json()
    del data["capabilities"]
    fake, _calls = _fake_get(response=_FakeResponse(200, data))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


@pytest.mark.parametrize("depth_value", [False, "true", 1, None])
def test_health_depth_capability_not_exactly_true_returns_false(monkeypatch, depth_value):
    fake, _calls = _fake_get(
        response=_FakeResponse(200, _valid_health_json(capabilities={"depth_controlnet": depth_value}))
    )
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_missing_depth_capability_key_returns_false(monkeypatch):
    fake, _calls = _fake_get(response=_FakeResponse(200, _valid_health_json(capabilities={})))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_missing_status_key_returns_false(monkeypatch):
    data = _valid_health_json()
    del data["status"]
    fake, _calls = _fake_get(response=_FakeResponse(200, data))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


@pytest.mark.parametrize("bad_status", ["degraded", "starting", "", None, True])
def test_health_status_not_ok_returns_false(monkeypatch, bad_status):
    fake, _calls = _fake_get(response=_FakeResponse(200, _valid_health_json(status=bad_status)))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


def test_health_3xx_status_code_returns_false(monkeypatch):
    # requests.Response.ok is True for the WHOLE < 400 range, including
    # 3xx redirects — a fake modeling that real semantics would have let
    # a bug that trusted `.ok` instead of the actual status code slip a
    # 3xx through as "healthy". Production must reject it.
    fake, _calls = _fake_get(response=_FakeResponse(304, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", fake)
    assert check_health() is False


# ============================================== caller-validation ====


@pytest.mark.parametrize("bad_run_id", ["", "   ", None, 5, [], {}])
def test_invalid_run_id_rejected_before_http(monkeypatch, bad_run_id):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["run_id"] = bad_run_id
    with pytest.raises(ValueError):
        generate(**kwargs)


@pytest.mark.parametrize("bad_image", [b"", "not-bytes", None, 123])
def test_invalid_image_bytes_rejected_before_http(monkeypatch, bad_image):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["image_bytes"] = bad_image
    with pytest.raises(ValueError):
        generate(**kwargs)


@pytest.mark.parametrize("bad_media_type", ["image/gif", "png", "", None, 5])
def test_invalid_claimed_media_type_rejected_before_http(monkeypatch, bad_media_type):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["image_media_type"] = bad_media_type
    with pytest.raises(ValueError):
        generate(**kwargs)


def test_malformed_image_bytes_rejected_before_http(monkeypatch):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["image_bytes"] = b"not a real image"
    with pytest.raises(ValueError):
        generate(**kwargs)


def test_media_type_actual_image_mismatch_rejected_before_http(monkeypatch):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["image_bytes"] = JPEG_BYTES
    kwargs["image_media_type"] = "image/png"  # claims png, bytes are actually jpeg
    with pytest.raises(ValueError):
        generate(**kwargs)


@pytest.mark.parametrize("bad_prompt", ["", "   ", None, 5])
def test_invalid_prompt_rejected_before_http(monkeypatch, bad_prompt):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["prompt"] = bad_prompt
    with pytest.raises(ValueError):
        generate(**kwargs)


@pytest.mark.parametrize("bad_negative_prompt", ["", "   ", 5])
def test_invalid_negative_prompt_rejected_before_http(monkeypatch, bad_negative_prompt):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["negative_prompt"] = bad_negative_prompt
    with pytest.raises(ValueError):
        generate(**kwargs)


@pytest.mark.parametrize("bad_denoise", [float("nan"), float("inf"), float("-inf"), -0.1, 1.1])
def test_invalid_denoise_strength_rejected_before_http(monkeypatch, bad_denoise):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["denoise_strength"] = bad_denoise
    with pytest.raises(ValueError):
        generate(**kwargs)


@pytest.mark.parametrize("bad_scale", [float("nan"), float("inf"), 0.0, -1.0, 2.1])
def test_invalid_conditioning_scale_rejected_before_http(monkeypatch, bad_scale):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["controlnet_conditioning_scale"] = bad_scale
    with pytest.raises(ValueError):
        generate(**kwargs)


@pytest.mark.parametrize("bad_seed", [True, False, -1, 2**32, 3.5, "42"])
def test_invalid_seed_rejected_before_http(monkeypatch, bad_seed):
    monkeypatch.setattr(image_gen_client.requests, "get", _fail_if_called)
    monkeypatch.setattr(image_gen_client.requests, "post", _fail_if_called)
    kwargs = _base_generate_kwargs()
    kwargs["seed"] = bad_seed
    with pytest.raises(ValueError):
        generate(**kwargs)


# ================================================= request shape ====


def test_health_called_before_post(monkeypatch):
    _result, get_calls, post_calls = _setup_successful_generate(monkeypatch)
    assert len(get_calls) == 1
    assert len(post_calls) == 1


def test_no_post_when_unhealthy(monkeypatch):
    get_fake, _get_calls = _fake_get(response=_FakeResponse(503, {}))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, post_calls = _fake_post(response=_FakeResponse(200, {}))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    with pytest.raises(ImageGenUnavailableError):
        generate(**_base_generate_kwargs())

    assert len(post_calls) == 0


def test_no_post_when_health_returns_302(monkeypatch):
    # Distinct from the 503 case above: a 3xx health response is the
    # exact case the resp.ok defect concealed (Response.ok is True for
    # 3xx) — must still block the POST entirely, not just eventually
    # reject the generation response.
    get_fake, _get_calls = _fake_get(response=_FakeResponse(302, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, post_calls = _fake_post(response=_FakeResponse(200, _good_response_json()))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    with pytest.raises(ImageGenUnavailableError):
        generate(**_base_generate_kwargs())

    assert len(post_calls) == 0


def test_exact_generate_url(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch)
    assert post_calls[0]["url"] == f"{get_settings().image_gen_base_url}/generate"


def test_configured_request_timeout_used(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch)
    assert post_calls[0]["timeout"] == get_settings().image_gen_request_timeout_s


def test_exact_normalized_run_id_sent(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch, run_id=" r1 ")
    assert post_calls[0]["json"]["run_id"] == "r1"


def test_prompt_passed_unchanged_apart_from_outer_trimming(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch, prompt="  a  tidy   room  ")
    assert post_calls[0]["json"]["prompt"] == "a  tidy   room"


def test_negative_prompt_passed_correctly(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch, negative_prompt="  blurry  ")
    assert post_calls[0]["json"]["negative_prompt"] == "blurry"


def test_negative_prompt_none_when_omitted(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch)
    assert post_calls[0]["json"]["negative_prompt"] is None


def test_image_base64_decodes_to_byte_identical_original(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch)
    sent_b64 = post_calls[0]["json"]["image"]
    assert base64.b64decode(sent_b64) == PNG_BYTES


def test_no_data_url_prefix(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch)
    assert not post_calls[0]["json"]["image"].startswith("data:")


def test_configured_defaults_used_when_omitted(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch)
    settings = get_settings()
    body = post_calls[0]["json"]
    assert body["denoise_strength"] == settings.image_gen_denoise_strength
    assert body["controlnet_conditioning_scale"] == settings.image_gen_controlnet_conditioning_scale
    assert body["seed"] == settings.image_gen_seed


def test_explicit_overrides_used(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(
        monkeypatch, denoise_strength=0.5, controlnet_conditioning_scale=1.5, seed=7
    )
    body = post_calls[0]["json"]
    assert body["denoise_strength"] == 0.5
    assert body["controlnet_conditioning_scale"] == 1.5
    assert body["seed"] == 7


def test_api_version_included_in_request(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch)
    assert post_calls[0]["json"]["api_version"] == IMAGE_GEN_API_VERSION


def test_seed_and_conditioning_scale_included_in_request(monkeypatch):
    _result, _get, post_calls = _setup_successful_generate(monkeypatch)
    body = post_calls[0]["json"]
    assert "seed" in body
    assert "controlnet_conditioning_scale" in body


def test_exactly_one_get_and_one_post_on_success(monkeypatch):
    _result, get_calls, post_calls = _setup_successful_generate(monkeypatch)
    assert len(get_calls) == 1
    assert len(post_calls) == 1


# ===================================================== response ====


def test_complete_valid_png_response(monkeypatch):
    result, _get, _post = _setup_successful_generate(monkeypatch)
    assert isinstance(result, GenerationResult)
    assert result.image_media_type == "image/png"
    assert result.depth_map_used is True


def test_complete_valid_jpeg_response(monkeypatch):
    result, _get, _post = _setup_successful_generate(
        monkeypatch, image_bytes=JPEG_BYTES, image_media_type="image/jpeg"
    )
    assert result.image_media_type == "image/jpeg"


def test_invalid_json_response_rejected(monkeypatch):
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, _ = _fake_post(response=_FakeResponse(200, None, raise_on_json=True))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)
    with pytest.raises(ImageGenResponseError):
        generate(**_base_generate_kwargs())


def test_non_object_json_response_rejected(monkeypatch):
    _assert_response_rejected(monkeypatch, ["not", "an", "object"])


@pytest.mark.parametrize("missing_key", sorted(image_gen_client._EXPECTED_RESPONSE_KEYS))
def test_missing_required_field_rejected(monkeypatch, missing_key):
    data = _good_response_json()
    del data[missing_key]
    _assert_response_rejected(monkeypatch, data)


def test_wrong_api_version_response_rejected(monkeypatch):
    data = _good_response_json()
    data["api_version"] = "v2"
    _assert_response_rejected(monkeypatch, data)


def test_mismatched_run_id_response_rejected(monkeypatch):
    data = _good_response_json()
    data["run_id"] = "different-run-id"
    _assert_response_rejected(monkeypatch, data)


@pytest.mark.parametrize("field", ["service_version", "base_model", "controlnet_model"])
def test_blank_identifier_fields_rejected(monkeypatch, field):
    data = _good_response_json()
    data[field] = "   "
    _assert_response_rejected(monkeypatch, data)


@pytest.mark.parametrize("bad_value", [False, None, 1, "true"])
def test_depth_map_used_not_exactly_true_rejected(monkeypatch, bad_value):
    data = _good_response_json()
    data["depth_map_used"] = bad_value
    _assert_response_rejected(monkeypatch, data)


def test_invalid_base64_image_rejected(monkeypatch):
    data = _good_response_json()
    data["image"] = "not-valid-base64!!!"
    _assert_response_rejected(monkeypatch, data)


def test_empty_decoded_image_rejected(monkeypatch):
    data = _good_response_json()
    data["image"] = ""
    _assert_response_rejected(monkeypatch, data)


def test_decoded_data_not_an_image_rejected(monkeypatch):
    data = _good_response_json()
    data["image"] = base64.b64encode(b"not a real image, just bytes").decode("ascii")
    _assert_response_rejected(monkeypatch, data)


def test_response_media_type_mismatch_rejected(monkeypatch):
    data = _good_response_json()
    data["image"] = base64.b64encode(JPEG_BYTES).decode("ascii")  # claims png, sends jpeg bytes
    _assert_response_rejected(monkeypatch, data)


def test_denoise_mismatch_rejected(monkeypatch):
    data = _good_response_json()
    data["denoise_strength"] = 0.99
    _assert_response_rejected(monkeypatch, data)


def test_conditioning_scale_mismatch_rejected(monkeypatch):
    data = _good_response_json()
    data["controlnet_conditioning_scale"] = 1.9
    _assert_response_rejected(monkeypatch, data)


def test_seed_mismatch_rejected(monkeypatch):
    data = _good_response_json()
    data["seed"] = 999
    _assert_response_rejected(monkeypatch, data)


def test_prompt_hash_mismatch_rejected(monkeypatch):
    data = _good_response_json()
    data["prompt_sha256"] = hashlib.sha256(b"a different prompt entirely").hexdigest()
    _assert_response_rejected(monkeypatch, data)


def test_input_image_hash_mismatch_rejected(monkeypatch):
    data = _good_response_json()
    data["input_image_sha256"] = hashlib.sha256(b"a different image entirely").hexdigest()
    _assert_response_rejected(monkeypatch, data)


@pytest.mark.parametrize("bad_hash", ["not-hex", "abc123", "F" * 64, "0" * 63, "0" * 65])
def test_invalid_hash_format_rejected(monkeypatch, bad_hash):
    data = _good_response_json()
    data["prompt_sha256"] = bad_hash
    _assert_response_rejected(monkeypatch, data)


@pytest.mark.parametrize("bad_ms", [-1.0, float("nan"), float("inf"), float("-inf")])
def test_invalid_generation_ms_rejected(monkeypatch, bad_ms):
    data = _good_response_json()
    data["generation_ms"] = bad_ms
    _assert_response_rejected(monkeypatch, data)


def test_unexpected_extra_response_field_rejected(monkeypatch):
    # Documented policy: unexpected fields are REJECTED, not silently
    # ignored — contract drift must be visible, not tolerated.
    data = _good_response_json()
    data["unexpected_field"] = "surprise"
    _assert_response_rejected(monkeypatch, data)


# ================================================= error mapping ====


def test_post_timeout_maps_to_timeout_error(monkeypatch):
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, _post_calls = _fake_post(exception=requests.Timeout("timed out"))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    with pytest.raises(ImageGenTimeoutError):
        generate(**_base_generate_kwargs())


def test_other_post_request_exception_maps_to_request_error(monkeypatch):
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, _post_calls = _fake_post(exception=requests.ConnectionError("connection reset"))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    with pytest.raises(ImageGenRequestError):
        generate(**_base_generate_kwargs())


def test_non_2xx_post_maps_to_service_error_with_status(monkeypatch):
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, _ = _fake_post(response=_FakeResponse(500, {"error": "internal"}))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    with pytest.raises(ImageGenServiceError) as exc_info:
        generate(**_base_generate_kwargs())

    assert exc_info.value.status_code == 500


def test_post_3xx_status_code_maps_to_service_error(monkeypatch):
    # Same resp.ok defect as check_health(): a 3xx POST response must be
    # treated as a service error, not silently accepted because
    # requests.Response.ok is True for it. The body here is a fully
    # VALID, otherwise-successful generation payload (_good_response_json)
    # — proving the 302 status alone triggers rejection, and that a 3xx
    # response body is never handed to _parse_generation_response() at
    # all (which would have returned a GenerationResult instead of
    # raising, had the status check been skipped or wrong).
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, _ = _fake_post(response=_FakeResponse(302, _good_response_json()))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    with pytest.raises(ImageGenServiceError) as exc_info:
        generate(**_base_generate_kwargs())

    assert exc_info.value.status_code == 302


def test_sanitized_messages_contain_no_remote_body_base64_or_prompt(monkeypatch):
    secret_body = {
        "secret_field": "TOP_SECRET_LEAKED_DATA",
        "error": "server exploded while processing prompt: a tidy room",
    }
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, _ = _fake_post(response=_FakeResponse(500, secret_body))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    with pytest.raises(ImageGenServiceError) as exc_info:
        generate(**_base_generate_kwargs())

    message = str(exc_info.value)
    assert "TOP_SECRET_LEAKED_DATA" not in message
    assert "a tidy room" not in message
    assert base64.b64encode(PNG_BYTES).decode("ascii") not in message


def test_no_automatic_post_retry_on_timeout(monkeypatch):
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)
    post_fake, post_calls = _fake_post(exception=requests.Timeout("timed out"))
    monkeypatch.setattr(image_gen_client.requests, "post", post_fake)

    with pytest.raises(ImageGenTimeoutError):
        generate(**_base_generate_kwargs())

    assert len(post_calls) == 1


def test_valid_result_exposes_all_expected_metadata(monkeypatch):
    result, _get, _post = _setup_successful_generate(monkeypatch)
    assert result.run_id == "r1"
    assert result.image_media_type == "image/png"
    assert result.depth_map_used is True
    assert result.base_model
    assert result.controlnet_model
    assert result.service_version
    assert result.api_version == IMAGE_GEN_API_VERSION
    assert result.prompt_sha256
    assert result.input_image_sha256
    assert result.generation_ms >= 0.0


# ============================================ side effects / import ====


def test_no_filesystem_log_side_effect(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    get_fake, _ = _fake_get(response=_FakeResponse(200, _valid_health_json()))
    monkeypatch.setattr(image_gen_client.requests, "get", get_fake)

    check_health()

    assert not (tmp_path / "logs").exists()


def test_module_does_not_import_model_libraries():
    source = Path(image_gen_client.__file__).read_text(encoding="utf-8")
    forbidden = ["import torch", "import groundingdino", "import ollama", "import diffusers", "from app.models"]
    for token in forbidden:
        assert token not in source, f"forbidden import found in image_gen_client.py: {token!r}"
