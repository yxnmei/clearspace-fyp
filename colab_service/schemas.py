"""
Request/response contract for GET /health and POST /generate — mirrors
backend/app/models/image_gen_client.py EXACTLY (that module is the
authoritative source of truth). Deliberately NOT imported from backend/ — colab_service is a separate,
independently-deployed runtime with zero dependency on the backend
package; this file independently re-implements the same bounds so a
contract drift is caught by comparing the two files side by side during
review, never hidden behind an accidental cross-import between two
separately-deployed services.

Pure pydantic + stdlib + Pillow only — no torch/diffusers/controlnet_aux
import anywhere in this file, so importing it (and running this file's
own tests) never loads or downloads a model. See colab_service/__init__.py.
"""

from __future__ import annotations

import base64
import binascii
import io
import math
from typing import Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

# Mirrors app.models.image_gen_client.IMAGE_GEN_API_VERSION exactly — kept
# in sync manually (see module docstring); bump only alongside an actual
# contract change on BOTH sides together.
API_VERSION = "v1"

_SUPPORTED_MEDIA_TYPES: dict[str, str] = {"image/png": "PNG", "image/jpeg": "JPEG"}
_HASH_HEX_PATTERN = r"^[0-9a-f]{64}$"

# The exact 14 keys a /generate success response must contain — mirrors
# app.models.image_gen_client._EXPECTED_RESPONSE_KEYS exactly. Used both
# by build_generate_response()'s own construction and directly by tests
# that assert on the exact key set.
RESPONSE_KEYS: tuple[str, ...] = (
    "api_version",
    "service_version",
    "run_id",
    "image",
    "image_media_type",
    "depth_map_used",
    "denoise_strength",
    "controlnet_conditioning_scale",
    "seed",
    "base_model",
    "controlnet_model",
    "prompt_sha256",
    "input_image_sha256",
    "generation_ms",
)


def _validate_image_bytes(image_bytes: bytes, image_media_type: str) -> None:
    """Mirrors backend/app/core/image_validation.py's validate_image_bytes
    exactly — independently reimplemented, not imported (see module
    docstring). Raises ValueError (never a raw exception) for bytes that
    don't decode as a genuine image, or whose actual decoded format
    doesn't match the claimed image_media_type."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        actual_format = img.format
        img.verify()
    except Exception as exc:
        raise ValueError("image could not be decoded as a valid image") from exc
    if _SUPPORTED_MEDIA_TYPES.get(image_media_type) != actual_format:
        raise ValueError("image_media_type does not match the actual image format")


def _check_strict_finite_number(v: object, field_name: str) -> object:
    """Mirrors app.models.image_gen_client._is_finite_number()'s exact
    strictness — isinstance(v, (int, float)) AND NOT isinstance(v, bool)
    AND math.isfinite(v) — run in a mode="before" validator so it
    intercepts BEFORE pydantic's own lenient coercion ever gets a chance
    to silently turn a string like "0.35"/"nan"/"inf" or a bool into a
    float. Rejects: bool, str, NaN, +-inf. Accepts a genuine int or float
    (an int is a legitimate finite value for a "float" field here,
    matching the client's own _is_finite_number contract exactly)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{field_name} must be a real number, not {type(v).__name__}")
    if not math.isfinite(v):
        raise ValueError(f"{field_name} must be finite")
    return v


def _check_strict_int(v: object, field_name: str) -> object:
    """Mirrors app.models.image_gen_client._validate_seed()'s exact
    strictness — isinstance(v, int) AND NOT isinstance(v, bool) — run in
    a mode="before" validator so it intercepts before pydantic's own
    lenient coercion ever gets a chance to silently turn a string
    ("42"), a float (42.0), or a bool into an int."""
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"{field_name} must be an integer, not {type(v).__name__}")
    return v


def _decode_strict_base64(value: str, field_name: str) -> bytes:
    if not value:
        raise ValueError(f"{field_name} must not be empty")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} is not valid base64") from exc
    if not decoded:
        raise ValueError(f"{field_name} must decode to non-empty bytes")
    return decoded


# --- GET /health -------------------------------------------------------


def build_health_response(*, service_version: str) -> dict:
    """The EXACT compatible /health success body
    app.models.image_gen_client.check_health() requires — see that
    function's own docstring for the full list of ways any deviation
    collapses to `available: False` on the client side. Only ever called
    once the service is genuinely ready (see app.py's health() handler);
    this function itself has no notion of readiness, it only builds the
    shape."""
    if not isinstance(service_version, str) or not service_version.strip():
        raise ValueError("service_version must be a non-blank string")
    return {
        "status": "ok",
        "api_version": API_VERSION,
        "service_version": service_version,
        "capabilities": {"depth_controlnet": True},
    }


# --- POST /generate: request --------------------------------------------


class GenerateRequest(BaseModel):
    """POST /generate's request body — mirrors
    app.models.image_gen_client.generate()'s outbound body exactly: the
    real client always sends exactly these 9 fields (api_version, run_id,
    prompt, negative_prompt, image, image_media_type, denoise_strength,
    controlnet_conditioning_scale, seed). extra="forbid" — a request
    carrying anything else is rejected outright, matching the strict,
    no-silent-extra discipline this whole contract already uses on both
    the client's own request AND response validation."""

    model_config = ConfigDict(extra="forbid")

    api_version: Literal[API_VERSION]
    run_id: str = Field(min_length=1)
    prompt: str
    negative_prompt: str | None = None
    image: str
    image_media_type: Literal["image/png", "image/jpeg"]
    denoise_strength: float = Field(ge=0.0, le=1.0)
    controlnet_conditioning_scale: float = Field(gt=0.0, le=2.0)
    seed: int = Field(ge=0, le=2**32 - 1)

    @field_validator("run_id")
    @classmethod
    def _check_run_id_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("run_id must not be blank")
        return v

    @field_validator("prompt")
    @classmethod
    def _check_prompt(cls, v: str) -> str:
        # Outer-whitespace normalization only, matching
        # image_gen_client.py's own _validate_prompt_field convention —
        # internal content is never touched. The client already trims
        # before sending; trimming again here is idempotent and keeps
        # this schema safe to use standalone, not dependent on the
        # client's own behavior.
        trimmed = v.strip()
        if not trimmed:
            raise ValueError("prompt must not be blank")
        return trimmed

    @field_validator("negative_prompt")
    @classmethod
    def _check_negative_prompt(cls, v: str | None) -> str | None:
        if v is None:
            return None
        trimmed = v.strip()
        if not trimmed:
            raise ValueError("negative_prompt must not be blank")
        return trimmed

    @field_validator("denoise_strength", mode="before")
    @classmethod
    def _check_denoise_strength_strict_type(cls, v: object) -> object:
        return _check_strict_finite_number(v, "denoise_strength")

    @field_validator("controlnet_conditioning_scale", mode="before")
    @classmethod
    def _check_conditioning_scale_strict_type(cls, v: object) -> object:
        return _check_strict_finite_number(v, "controlnet_conditioning_scale")

    @field_validator("seed", mode="before")
    @classmethod
    def _check_seed_strict_type(cls, v: object) -> object:
        # mode="before" is required to actually catch this — Python's
        # bool is an int subclass, and pydantic's own lenient coercion
        # would otherwise silently accept a numeric string ("42") or a
        # whole-number float (42.0) too (same ordering reason as
        # app/api/routes.py's GeneratedImagePayload).
        return _check_strict_int(v, "seed")

    @field_validator("image")
    @classmethod
    def _check_image_base64_syntax(cls, v: str) -> str:
        _decode_strict_base64(v, "image")
        return v

    @model_validator(mode="after")
    def _check_image_matches_media_type(self) -> "GenerateRequest":
        # Genuine content validation (not just base64 syntax) — the
        # decoded bytes must actually be an image in the claimed format.
        # Runs after field-level checks, matching this codebase's
        # existing two-stage (syntax, then content) validation pattern.
        decoded = base64.b64decode(self.image)
        _validate_image_bytes(decoded, self.image_media_type)
        return self


# --- POST /generate: response -------------------------------------------


class GenerateResponse(BaseModel):
    """The exact 14-field /generate success response — mirrors
    app.models.image_gen_client._EXPECTED_RESPONSE_KEYS /
    GenerationResult exactly, field for field. extra="forbid" here is a
    self-check on THIS service's own code (this class is only ever
    constructed by build_generate_response() below from already-computed,
    trusted values, never parsed from untrusted external input) — it
    exists to catch this service accidentally adding, dropping, or
    renaming a field, not to validate an adversarial caller."""

    model_config = ConfigDict(extra="forbid")

    api_version: Literal[API_VERSION]
    service_version: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    image: str
    image_media_type: Literal["image/png", "image/jpeg"]
    depth_map_used: Literal[True]
    denoise_strength: float = Field(ge=0.0, le=1.0)
    controlnet_conditioning_scale: float = Field(gt=0.0, le=2.0)
    seed: int = Field(ge=0, le=2**32 - 1)
    base_model: str = Field(min_length=1)
    controlnet_model: str = Field(min_length=1)
    prompt_sha256: str = Field(pattern=_HASH_HEX_PATTERN)
    input_image_sha256: str = Field(pattern=_HASH_HEX_PATTERN)
    generation_ms: float = Field(ge=0.0)

    @field_validator("seed", mode="before")
    @classmethod
    def _check_seed_not_bool(cls, v: object) -> object:
        if isinstance(v, bool):
            raise ValueError("seed must not be a boolean")
        return v

    @field_validator("run_id", "service_version", "base_model", "controlnet_model")
    @classmethod
    def _check_not_blank(cls, v: str, info: ValidationInfo) -> str:
        # Field(min_length=1) alone accepts a whitespace-only string
        # (e.g. " " has length 1) — this closes that gap explicitly,
        # matching GenerateRequest's own run_id/prompt blank-checks.
        if not v.strip():
            raise ValueError(f"{info.field_name} must not be blank")
        return v

    @field_validator("generation_ms")
    @classmethod
    def _check_generation_ms_finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("generation_ms must be finite")
        return v

    @field_validator("image")
    @classmethod
    def _check_image_base64_syntax(cls, v: str) -> str:
        _decode_strict_base64(v, "image")
        return v

    @model_validator(mode="after")
    def _check_image_matches_media_type(self) -> "GenerateResponse":
        decoded = base64.b64decode(self.image)
        _validate_image_bytes(decoded, self.image_media_type)
        return self


def build_generate_response(
    *,
    run_id: str,
    image_bytes: bytes,
    denoise_strength: float,
    controlnet_conditioning_scale: float,
    seed: int,
    base_model: str,
    controlnet_model: str,
    service_version: str,
    prompt_sha256: str,
    input_image_sha256: str,
    generation_ms: float,
) -> dict:
    """Builds and validates the exact 14-field success response as a
    plain dict, ready for JSONResponse. image_media_type is always
    "image/png" here — see pipeline.py's own docstring for why PNG is
    this service's fixed output format (lossless, trivially guarantees
    the format-match check below always passes for genuine output)."""
    response = GenerateResponse(
        api_version=API_VERSION,
        service_version=service_version,
        run_id=run_id,
        image=base64.b64encode(image_bytes).decode("ascii"),
        image_media_type="image/png",
        depth_map_used=True,
        denoise_strength=denoise_strength,
        controlnet_conditioning_scale=controlnet_conditioning_scale,
        seed=seed,
        base_model=base_model,
        controlnet_model=controlnet_model,
        prompt_sha256=prompt_sha256,
        input_image_sha256=input_image_sha256,
        generation_ms=generation_ms,
    )
    return response.model_dump()
