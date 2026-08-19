"""
Unit tests for colab_service.schemas — pure pydantic + stdlib + Pillow,
no GPU/model/network dependency of any kind.
"""

from __future__ import annotations

import base64
import io

import pytest
from PIL import Image
from pydantic import ValidationError

from colab_service.schemas import (
    RESPONSE_KEYS,
    GenerateRequest,
    GenerateResponse,
    build_generate_response,
    build_health_response,
)


def _png_bytes(color=(10, 20, 30), size=(8, 8)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes(color=(200, 100, 50), size=(8, 8)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="JPEG")
    return buf.getvalue()


PNG_BYTES = _png_bytes()
PNG_B64 = base64.b64encode(PNG_BYTES).decode("ascii")
JPEG_BYTES = _jpeg_bytes()
JPEG_B64 = base64.b64encode(JPEG_BYTES).decode("ascii")


def _valid_request_kwargs(**overrides) -> dict:
    kwargs = dict(
        api_version="v1",
        run_id="run1",
        prompt="a tidy bedroom",
        negative_prompt=None,
        image=PNG_B64,
        image_media_type="image/png",
        denoise_strength=0.35,
        controlnet_conditioning_scale=1.0,
        seed=42,
    )
    kwargs.update(overrides)
    return kwargs


# ---------------------------------------------------------------------------
# GenerateRequest
# ---------------------------------------------------------------------------


def test_valid_request_constructs():
    req = GenerateRequest(**_valid_request_kwargs())
    assert req.api_version == "v1"
    assert req.prompt == "a tidy bedroom"
    assert req.negative_prompt is None


def test_rejects_extra_field():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(), some_unexpected_field="surprise")


def test_rejects_wrong_api_version():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(api_version="v2"))


def test_rejects_blank_run_id():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(run_id="   "))


def test_rejects_blank_prompt():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(prompt="   "))


def test_trims_outer_whitespace_from_prompt():
    req = GenerateRequest(**_valid_request_kwargs(prompt="  a tidy bedroom  "))
    assert req.prompt == "a tidy bedroom"


def test_negative_prompt_none_is_valid():
    req = GenerateRequest(**_valid_request_kwargs(negative_prompt=None))
    assert req.negative_prompt is None


def test_rejects_blank_negative_prompt_when_present():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(negative_prompt="   "))


def test_trims_negative_prompt():
    req = GenerateRequest(**_valid_request_kwargs(negative_prompt="  blurry  "))
    assert req.negative_prompt == "blurry"


@pytest.mark.parametrize("bad_denoise", [-0.1, 1.1, float("nan"), float("inf"), float("-inf")])
def test_rejects_out_of_range_denoise_strength(bad_denoise):
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(denoise_strength=bad_denoise))


def test_accepts_boundary_denoise_strength():
    GenerateRequest(**_valid_request_kwargs(denoise_strength=0.0))
    GenerateRequest(**_valid_request_kwargs(denoise_strength=1.0))


@pytest.mark.parametrize("bad_scale", [0.0, -1.0, 2.1, float("nan"), float("inf")])
def test_rejects_out_of_range_conditioning_scale(bad_scale):
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(controlnet_conditioning_scale=bad_scale))


def test_accepts_boundary_conditioning_scale():
    GenerateRequest(**_valid_request_kwargs(controlnet_conditioning_scale=2.0))


@pytest.mark.parametrize("bad_seed", [True, False, -1, 2**32, 3.5])
def test_rejects_boolean_or_out_of_range_seed(bad_seed):
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(seed=bad_seed))


def test_accepts_boundary_seed():
    GenerateRequest(**_valid_request_kwargs(seed=0))
    GenerateRequest(**_valid_request_kwargs(seed=2**32 - 1))


# ---------------------------------------------------------------------------
# Strict numeric types — rejected BEFORE pydantic's own lenient coercion
# (mirrors app.models.image_gen_client._is_finite_number()/_validate_seed()
# exactly) — a string, a bool, or (for seed) a float must never be
# silently coerced into a valid value.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_value", ["0.35", "1.0", "0", True, False])
def test_rejects_denoise_strength_wrong_type_before_coercion(bad_value):
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(denoise_strength=bad_value))


@pytest.mark.parametrize("bad_value", ["1.0", "0.5", True, False])
def test_rejects_conditioning_scale_wrong_type_before_coercion(bad_value):
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(controlnet_conditioning_scale=bad_value))


@pytest.mark.parametrize("bad_value", ["42", "0", 42.0, 0.0, True, False])
def test_rejects_seed_wrong_type_before_coercion(bad_value):
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(seed=bad_value))


def test_accepts_genuine_int_for_denoise_strength_and_conditioning_scale():
    # An int IS a legitimate finite value for these fields (matches
    # image_gen_client.py's own _is_finite_number: isinstance(v, (int, float))
    # and not isinstance(v, bool)) — only str/bool are rejected, not int.
    req = GenerateRequest(**_valid_request_kwargs(denoise_strength=1, controlnet_conditioning_scale=2))
    assert req.denoise_strength == 1.0
    assert req.controlnet_conditioning_scale == 2.0


def test_rejects_nan_and_infinity_denoise_strength():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(denoise_strength=float("nan")))
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(denoise_strength=float("inf")))


def test_rejects_nan_and_infinity_conditioning_scale():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(controlnet_conditioning_scale=float("nan")))
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(controlnet_conditioning_scale=float("inf")))


def test_rejects_empty_image():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(image=""))


def test_rejects_malformed_base64_image():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(image="not-valid-base64!!!"))


def test_rejects_valid_base64_that_is_not_an_image():
    bad = base64.b64encode(b"this is not an image at all").decode("ascii")
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(image=bad))


def test_rejects_media_type_mismatch():
    # real PNG bytes, claimed as jpeg
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(image=PNG_B64, image_media_type="image/jpeg"))


def test_accepts_real_jpeg_with_correct_media_type():
    req = GenerateRequest(**_valid_request_kwargs(image=JPEG_B64, image_media_type="image/jpeg"))
    assert req.image_media_type == "image/jpeg"


def test_rejects_unsupported_media_type():
    with pytest.raises(ValidationError):
        GenerateRequest(**_valid_request_kwargs(image_media_type="image/gif"))


def test_rejects_missing_required_field():
    kwargs = _valid_request_kwargs()
    del kwargs["prompt"]
    with pytest.raises(ValidationError):
        GenerateRequest(**kwargs)


# ---------------------------------------------------------------------------
# build_health_response
# ---------------------------------------------------------------------------


def test_health_response_exact_shape():
    body = build_health_response(service_version="colab-dev-0.1")
    assert body == {
        "status": "ok",
        "api_version": "v1",
        "service_version": "colab-dev-0.1",
        "capabilities": {"depth_controlnet": True},
    }


def test_health_response_rejects_blank_service_version():
    with pytest.raises(ValueError):
        build_health_response(service_version="   ")


def test_health_response_rejects_empty_service_version():
    with pytest.raises(ValueError):
        build_health_response(service_version="")


# ---------------------------------------------------------------------------
# GenerateResponse / build_generate_response
# ---------------------------------------------------------------------------


def _valid_response_construction_kwargs(**overrides) -> dict:
    kwargs = dict(
        api_version="v1",
        service_version="colab-dev-0.1",
        run_id="run1",
        image=PNG_B64,
        image_media_type="image/png",
        depth_map_used=True,
        denoise_strength=0.35,
        controlnet_conditioning_scale=1.0,
        seed=42,
        base_model="x",
        controlnet_model="y",
        prompt_sha256="a" * 64,
        input_image_sha256="b" * 64,
        generation_ms=1.0,
    )
    kwargs.update(overrides)
    return kwargs


def _valid_build_kwargs(**overrides) -> dict:
    kwargs = dict(
        run_id="run1",
        image_bytes=PNG_BYTES,
        denoise_strength=0.35,
        controlnet_conditioning_scale=1.0,
        seed=42,
        base_model="stable-diffusion-v1-5/stable-diffusion-v1-5",
        controlnet_model="lllyasviel/sd-controlnet-depth",
        service_version="colab-dev-0.1",
        prompt_sha256="a" * 64,
        input_image_sha256="b" * 64,
        generation_ms=1234.5,
    )
    kwargs.update(overrides)
    return kwargs


def test_build_generate_response_exact_14_keys():
    body = build_generate_response(**_valid_build_kwargs())
    assert set(body.keys()) == set(RESPONSE_KEYS)
    assert len(body) == 14


def test_build_generate_response_values():
    body = build_generate_response(**_valid_build_kwargs())
    assert body["api_version"] == "v1"
    assert body["run_id"] == "run1"
    assert body["depth_map_used"] is True
    assert body["base_model"] == "stable-diffusion-v1-5/stable-diffusion-v1-5"
    assert body["controlnet_model"] == "lllyasviel/sd-controlnet-depth"
    decoded = base64.b64decode(body["image"])
    assert decoded == PNG_BYTES


def test_build_generate_response_image_media_type_is_png():
    body = build_generate_response(**_valid_build_kwargs())
    assert body["image_media_type"] == "image/png"


def test_build_generate_response_echoes_exact_parameters():
    body = build_generate_response(**_valid_build_kwargs(denoise_strength=0.6, controlnet_conditioning_scale=1.7, seed=99))
    assert body["denoise_strength"] == 0.6
    assert body["controlnet_conditioning_scale"] == 1.7
    assert body["seed"] == 99


@pytest.mark.parametrize("bad_hash", ["not-hex", "abc123", "F" * 64, "0" * 63, "0" * 65, ""])
def test_generate_response_rejects_malformed_prompt_hash(bad_hash):
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(prompt_sha256=bad_hash))


@pytest.mark.parametrize("bad_hash", ["not-hex", "abc123", "F" * 64, "0" * 63, "0" * 65, ""])
def test_generate_response_rejects_malformed_input_image_hash(bad_hash):
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(input_image_sha256=bad_hash))


def test_generate_response_rejects_seed_boolean():
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(seed=True))


@pytest.mark.parametrize("bad_seed", [-1, 2**32])
def test_generate_response_rejects_out_of_range_seed(bad_seed):
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(seed=bad_seed))


def test_generate_response_rejects_non_finite_generation_ms():
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(generation_ms=float("inf")))


def test_generate_response_rejects_negative_generation_ms():
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(generation_ms=-1.0))


def test_generate_response_rejects_depth_map_used_false():
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(depth_map_used=False))


def test_generate_response_rejects_wrong_api_version():
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(api_version="v2"))


def test_generate_response_rejects_blank_base_model():
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(base_model=""))


# ---------------------------------------------------------------------------
# Non-blank invariants — Field(min_length=1) alone accepts a
# whitespace-only string (e.g. " " has length 1); these fields must
# reject that too, not just a truly empty string. Direct construction,
# as required.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("whitespace_value", [" ", "\t", "\n", "   "])
def test_generate_response_rejects_whitespace_only_run_id(whitespace_value):
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(run_id=whitespace_value))


@pytest.mark.parametrize("whitespace_value", [" ", "\t", "\n", "   "])
def test_generate_response_rejects_whitespace_only_service_version(whitespace_value):
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(service_version=whitespace_value))


@pytest.mark.parametrize("whitespace_value", [" ", "\t", "\n", "   "])
def test_generate_response_rejects_whitespace_only_base_model(whitespace_value):
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(base_model=whitespace_value))


@pytest.mark.parametrize("whitespace_value", [" ", "\t", "\n", "   "])
def test_generate_response_rejects_whitespace_only_controlnet_model(whitespace_value):
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(controlnet_model=whitespace_value))


def test_generate_response_rejects_media_type_mismatch():
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(image=PNG_B64, image_media_type="image/jpeg"))


def test_generate_response_extra_field_rejected():
    with pytest.raises(ValidationError):
        GenerateResponse(**_valid_response_construction_kwargs(), extra="nope")


def test_generate_response_missing_field_rejected():
    kwargs = _valid_response_construction_kwargs()
    del kwargs["seed"]
    with pytest.raises(ValidationError):
        GenerateResponse(**kwargs)
