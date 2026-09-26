"""Strict transport client for the remote Colab generation service.

A static ngrok domain avoids rediscovery but does not prove a service is
listening. Health is checked before generation; inputs and responses are
validated, and errors are sanitised without logging images, prompts, or secrets.
Runtime integration is verified, but fidelity and item preservation are not.
Echoed hashes establish request correlation only, not authentication.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import math
import re
from typing import Annotated, Any, Literal

import requests
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, ValidationError, field_validator, model_validator

from app.config import get_settings
from app.core.image_validation import validate_image_bytes
from app.core.schemas import NonEmptyStr

# This identifies the contract shape, not environment configuration.
IMAGE_GEN_API_VERSION = "v1"

_SUPPORTED_MEDIA_TYPES: dict[str, str] = {"image/png": "PNG", "image/jpeg": "JPEG"}

# Allow only JSON round-trip differences in echoed floats.
_FLOAT_COMPARISON_TOLERANCE = 1e-6

_HASH_HEX_RE = re.compile(r"^[0-9a-f]{64}$")

_Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]

_RUN_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(NonEmptyStr)

# Reject extra fields so backend/Colab contract drift is visible.
_EXPECTED_RESPONSE_KEYS: frozenset[str] = frozenset(
    {
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
    }
)


# --- typed error hierarchy --------------------------------------------------


class ImageGenError(RuntimeError):
    """Base error with bounded messages that never expose remote bodies or inputs."""


class ImageGenUnavailableError(ImageGenError):
    """Health or compatibility failed before generation was submitted."""


class ImageGenTimeoutError(ImageGenError):
    """The generation POST itself timed out."""


class ImageGenRequestError(ImageGenError):
    """A generation transport failure other than timeout."""


class ImageGenServiceError(ImageGenError):
    """A non-2xx generation response with status but no raw body."""

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class ImageGenResponseError(ImageGenError):
    """A malformed, inconsistent, or incompatible successful response."""


# --- result -----------------------------------------------------------------


class GenerationResult(BaseModel):
    """A validated generation response; base64 conversion stays at the API layer."""

    model_config = ConfigDict(frozen=True)

    run_id: NonEmptyStr
    image_bytes: bytes
    image_media_type: Literal["image/png", "image/jpeg"]
    depth_map_used: Literal[True]
    denoise_strength: float = Field(ge=0.0, le=1.0)
    controlnet_conditioning_scale: float = Field(gt=0.0, le=2.0)
    seed: int = Field(ge=0, le=2**32 - 1)
    base_model: NonEmptyStr
    controlnet_model: NonEmptyStr
    service_version: NonEmptyStr
    api_version: Literal[IMAGE_GEN_API_VERSION]
    prompt_sha256: _Sha256Hex
    input_image_sha256: _Sha256Hex
    generation_ms: float = Field(ge=0.0)

    @field_validator("seed")
    @classmethod
    def _check_seed_not_bool(cls, v: int) -> int:
        if isinstance(v, bool):
            raise ValueError("seed must not be a boolean")
        return v

    @field_validator("image_bytes")
    @classmethod
    def _check_image_bytes_non_empty(cls, v: bytes) -> bytes:
        if not v:
            raise ValueError("image_bytes must not be empty")
        return v

    @field_validator("generation_ms")
    @classmethod
    def _check_generation_ms_finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("generation_ms must be finite")
        return v

    @model_validator(mode="after")
    def _check_media_type_matches_actual_image(self) -> "GenerationResult":
        try:
            img = Image.open(io.BytesIO(self.image_bytes))
            actual_format = img.format
        except Exception as exc:
            raise ValueError(f"image_bytes is not a decodable image: {type(exc).__name__}") from exc
        if _SUPPORTED_MEDIA_TYPES.get(self.image_media_type) != actual_format:
            raise ValueError("image_media_type does not match the actual decoded image format")
        return self


# --- pure helpers -------------------------------------------------------


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _normalized_base_url(settings: Any) -> str:
    """Remove a trailing slash before appending endpoint paths."""
    return settings.image_gen_base_url.rstrip("/")


def _validate_run_id(run_id: Any) -> str:
    try:
        return _RUN_ID_ADAPTER.validate_python(run_id)
    except ValidationError as exc:
        raise ValueError(f"run_id is not a valid non-empty string: {run_id!r}") from exc


def _validate_image(image_bytes: Any, image_media_type: Any) -> None:
    """Apply the shared decode, verification, and media-type checks."""
    validate_image_bytes(image_bytes, image_media_type)


def _validate_prompt_field(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-blank string")
    return value.strip()  # outer-whitespace normalization only — internal content untouched


def _validate_denoise_strength(value: Any) -> None:
    if not _is_finite_number(value) or not (0.0 <= value <= 1.0):
        raise ValueError(f"denoise_strength must be a finite number in [0.0, 1.0]: {value!r}")


def _validate_conditioning_scale(value: Any) -> None:
    if not _is_finite_number(value) or not (0.0 < value <= 2.0):
        raise ValueError(f"controlnet_conditioning_scale must be a finite number in (0.0, 2.0]: {value!r}")


def _validate_seed(value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not (0 <= value <= 2**32 - 1):
        raise ValueError(f"seed must be an integer in [0, 2**32 - 1]: {value!r}")


# --- health -------------------------------------------------------------


def check_health() -> bool:
    """Return whether the short health check proves contract compatibility.

    Use strict 2xx status because the library's convenience property also
    treats redirects as successful.
    """
    settings = get_settings()
    base_url = _normalized_base_url(settings)
    try:
        resp = requests.get(f"{base_url}/health", timeout=settings.image_gen_health_timeout_s)
    except requests.RequestException:
        return False

    if not (200 <= resp.status_code < 300):
        return False

    try:
        data = resp.json()
    except ValueError:
        return False

    if not isinstance(data, dict):
        return False
    if data.get("status") != "ok":
        return False
    if data.get("api_version") != IMAGE_GEN_API_VERSION:
        return False
    service_version = data.get("service_version")
    if not isinstance(service_version, str) or not service_version.strip():
        return False
    capabilities = data.get("capabilities")
    if not isinstance(capabilities, dict):
        return False
    if capabilities.get("depth_controlnet") is not True:
        return False

    return True


# --- response parsing -----------------------------------------------------


def _parse_generation_response(
    resp: requests.Response,
    *,
    expected_run_id: str,
    expected_prompt_sha256: str,
    expected_input_image_sha256: str,
    expected_denoise_strength: float,
    expected_conditioning_scale: float,
    expected_seed: int,
) -> GenerationResult:
    """Validate a successful response without exposing its raw body."""
    try:
        data = resp.json()
    except ValueError as exc:
        raise ImageGenResponseError("Image generation service returned invalid JSON.") from exc

    if not isinstance(data, dict):
        raise ImageGenResponseError("Image generation service response was not a JSON object.")

    extra_keys = set(data.keys()) - _EXPECTED_RESPONSE_KEYS
    if extra_keys:
        raise ImageGenResponseError(
            f"Image generation service response contained {len(extra_keys)} unexpected field(s)."
        )
    missing_keys = _EXPECTED_RESPONSE_KEYS - set(data.keys())
    if missing_keys:
        raise ImageGenResponseError(
            f"Image generation service response is missing {len(missing_keys)} required field(s)."
        )

    if data["api_version"] != IMAGE_GEN_API_VERSION:
        raise ImageGenResponseError("Image generation service reported an incompatible API version.")

    if data["run_id"] != expected_run_id:
        raise ImageGenResponseError("Image generation service echoed a mismatched run_id.")

    service_version = data["service_version"]
    if not isinstance(service_version, str) or not service_version.strip():
        raise ImageGenResponseError("Image generation service reported a blank service_version.")

    base_model = data["base_model"]
    if not isinstance(base_model, str) or not base_model.strip():
        raise ImageGenResponseError("Image generation service reported a blank base_model identifier.")

    controlnet_model = data["controlnet_model"]
    if not isinstance(controlnet_model, str) or not controlnet_model.strip():
        raise ImageGenResponseError("Image generation service reported a blank controlnet_model identifier.")

    # Full ClearSpace generation requires depth conditioning — a response
    # without it is rejected outright, not accepted as a lesser success.
    if data["depth_map_used"] is not True:
        raise ImageGenResponseError(
            "Image generation service did not report depth-ControlNet conditioning."
        )

    image_media_type = data["image_media_type"]
    if image_media_type not in _SUPPORTED_MEDIA_TYPES:
        raise ImageGenResponseError("Image generation service reported an unsupported image_media_type.")

    raw_image_b64 = data["image"]
    if not isinstance(raw_image_b64, str) or not raw_image_b64:
        raise ImageGenResponseError("Image generation service returned no image data.")
    try:
        image_bytes = base64.b64decode(raw_image_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageGenResponseError("Image generation service returned invalid base64 image data.") from exc
    if not image_bytes:
        raise ImageGenResponseError("Image generation service returned an empty image.")

    try:
        img = Image.open(io.BytesIO(image_bytes))
        actual_format = img.format
        img.verify()
    except Exception as exc:
        raise ImageGenResponseError(
            f"Image generation service returned data that is not a valid image: {type(exc).__name__}"
        ) from exc
    if _SUPPORTED_MEDIA_TYPES.get(image_media_type) != actual_format:
        raise ImageGenResponseError(
            "Image generation service's image_media_type does not match the actual image data."
        )

    denoise_strength = data["denoise_strength"]
    if not _is_finite_number(denoise_strength) or not math.isclose(
        denoise_strength, expected_denoise_strength, abs_tol=_FLOAT_COMPARISON_TOLERANCE
    ):
        raise ImageGenResponseError(
            "Image generation service reported a denoise_strength that does not match the request."
        )

    conditioning_scale = data["controlnet_conditioning_scale"]
    if not _is_finite_number(conditioning_scale) or not math.isclose(
        conditioning_scale, expected_conditioning_scale, abs_tol=_FLOAT_COMPARISON_TOLERANCE
    ):
        raise ImageGenResponseError(
            "Image generation service reported a controlnet_conditioning_scale that does not match the request."
        )

    seed = data["seed"]
    if isinstance(seed, bool) or not isinstance(seed, int) or seed != expected_seed:
        raise ImageGenResponseError("Image generation service reported a seed that does not match the request.")

    prompt_sha256 = data["prompt_sha256"]
    if not isinstance(prompt_sha256, str) or not _HASH_HEX_RE.fullmatch(prompt_sha256):
        raise ImageGenResponseError("Image generation service reported a malformed prompt_sha256.")
    if prompt_sha256 != expected_prompt_sha256:
        # A matching hash proves correlation, not that generation used the prompt.
        raise ImageGenResponseError("Image generation service's prompt_sha256 does not match the request.")

    input_image_sha256 = data["input_image_sha256"]
    if not isinstance(input_image_sha256, str) or not _HASH_HEX_RE.fullmatch(input_image_sha256):
        raise ImageGenResponseError("Image generation service reported a malformed input_image_sha256.")
    if input_image_sha256 != expected_input_image_sha256:
        raise ImageGenResponseError("Image generation service's input_image_sha256 does not match the request.")

    generation_ms = data["generation_ms"]
    if not _is_finite_number(generation_ms) or generation_ms < 0:
        raise ImageGenResponseError("Image generation service reported an invalid generation_ms.")

    try:
        return GenerationResult(
            run_id=expected_run_id,
            image_bytes=image_bytes,
            image_media_type=image_media_type,
            depth_map_used=True,
            denoise_strength=float(denoise_strength),
            controlnet_conditioning_scale=float(conditioning_scale),
            seed=seed,
            base_model=base_model,
            controlnet_model=controlnet_model,
            service_version=service_version,
            api_version=data["api_version"],
            prompt_sha256=prompt_sha256,
            input_image_sha256=input_image_sha256,
            generation_ms=float(generation_ms),
        )
    except ValidationError as exc:
        # Final validation failures still describe the untrusted response.
        raise ImageGenResponseError("Image generation service response failed final validation.") from exc


# --- generate -------------------------------------------------------------


def generate(
    run_id: str,
    image_bytes: bytes,
    image_media_type: str,
    prompt: str,
    negative_prompt: str | None = None,
    denoise_strength: float | None = None,
    controlnet_conditioning_scale: float | None = None,
    seed: int | None = None,
) -> GenerationResult:
    """Validate inputs, require health, submit once, and validate the result.

    The exact caller prompt is sent. Same-image/different-prompt sensitivity
    remains untested and cannot be proved by echoed hashes. The POST is not
    retried because a timed-out request may still be consuming GPU work.
    """
    settings = get_settings()

    normalized_run_id = _validate_run_id(run_id)
    _validate_image(image_bytes, image_media_type)
    normalized_prompt = _validate_prompt_field(prompt, "prompt")
    normalized_negative_prompt = (
        None if negative_prompt is None else _validate_prompt_field(negative_prompt, "negative_prompt")
    )

    resolved_denoise = denoise_strength if denoise_strength is not None else settings.image_gen_denoise_strength
    _validate_denoise_strength(resolved_denoise)

    resolved_scale = (
        controlnet_conditioning_scale
        if controlnet_conditioning_scale is not None
        else settings.image_gen_controlnet_conditioning_scale
    )
    _validate_conditioning_scale(resolved_scale)

    resolved_seed = seed if seed is not None else settings.image_gen_seed
    _validate_seed(resolved_seed)

    if not check_health():
        raise ImageGenUnavailableError(
            "Cannot reach a compatible image-generation service. Make sure the Colab "
            "notebook is running, the ngrok tunnel is up, and it reports a compatible "
            "API version and depth-ControlNet capability."
        )

    base_url = _normalized_base_url(settings)
    prompt_sha256 = hashlib.sha256(normalized_prompt.encode("utf-8")).hexdigest()
    input_image_sha256 = hashlib.sha256(image_bytes).hexdigest()

    body = {
        "api_version": IMAGE_GEN_API_VERSION,
        "run_id": normalized_run_id,
        "prompt": normalized_prompt,
        "negative_prompt": normalized_negative_prompt,
        "image": base64.b64encode(image_bytes).decode("ascii"),
        "image_media_type": image_media_type,
        "denoise_strength": resolved_denoise,
        "controlnet_conditioning_scale": resolved_scale,
        "seed": resolved_seed,
    }

    try:
        resp = requests.post(f"{base_url}/generate", json=body, timeout=settings.image_gen_request_timeout_s)
    except requests.Timeout as exc:
        raise ImageGenTimeoutError("Image generation request timed out.") from exc
    except requests.RequestException as exc:
        raise ImageGenRequestError("Image generation request failed.") from exc

    # Reject redirects as well as error statuses.
    if not (200 <= resp.status_code < 300):
        raise ImageGenServiceError(
            "Image generation service returned an error status.", status_code=resp.status_code
        )

    return _parse_generation_response(
        resp,
        expected_run_id=normalized_run_id,
        expected_prompt_sha256=prompt_sha256,
        expected_input_image_sha256=input_image_sha256,
        expected_denoise_strength=resolved_denoise,
        expected_conditioning_scale=resolved_scale,
        expected_seed=resolved_seed,
    )
