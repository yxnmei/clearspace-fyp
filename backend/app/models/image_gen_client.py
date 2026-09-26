"""
Typed transport client for the remote Colab image-generation service —
the backend-to-Colab HTTP boundary only.

The version-controlled Colab service implements this contract, and the
backend-to-Colab runtime path has completed a real GPU smoke test. This
module remains transport-only: it validates every byte crossing the
boundary but does not establish output fidelity or item preservation.

`image_gen_base_url` being a reserved/static ngrok domain (config.py) is
intended to avoid needing rediscovery every session — it is a
configuration choice, not proof any service is listening there.

Two things exist here specifically to avoid v1's dead-tunnel failure mode
(a raw connection error surfacing mid-demo, from not designing for an
already-known risk):
  1. check_health() — a fast, separate, strictly-validated call the
     frontend can hit proactively (R4's GET /image-gen/health) rather
     than only discovering the tunnel is dead when a user clicks
     Reorganise.
  2. generate() always calls check_health() first and raises
     ImageGenUnavailableError in milliseconds when it fails, instead of
     hanging until image_gen_request_timeout_s expires or POSTing to a
     service that can't produce a compatible result anyway.

Never logs image bytes, base64, prompts, or secrets — this module has no
logging calls at all, and does not use stage_timer (that would write to
logs/runs.jsonl on every call, which this file's own unit tests, mocked-
HTTP-only, must never do).
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

# Transport contract version — code-level, deliberately NOT configurable
# through .env: this identifies the SHAPE of the request/response this
# client speaks, not an environment-specific setting. Bump only alongside
# an actual contract change, together with whatever Colab implementation
# is meant to satisfy it (R7).
IMAGE_GEN_API_VERSION = "v1"

_SUPPORTED_MEDIA_TYPES: dict[str, str] = {"image/png": "PNG", "image/jpeg": "JPEG"}

# Documented small tolerance for comparing a float we sent against the
# same float echoed back by the remote service — accounts for JSON
# round-tripping (e.g. through a language/framework that reformats
# floats), never intended to mask a genuinely different value.
_FLOAT_COMPARISON_TOLERANCE = 1e-6

_HASH_HEX_RE = re.compile(r"^[0-9a-f]{64}$")

_Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]

_RUN_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(NonEmptyStr)

# The complete, exact set of top-level keys a /generate response may
# contain. Policy (deliberately explicit, not silent): an unexpected
# extra field is REJECTED, not ignored — contract drift between this
# client and whatever Colab implementation R7 builds should be loud, not
# silently tolerated. See _parse_generation_response.
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
    """Base class for every image-generation transport error. Every
    message here is bounded and sanitized — never a raw remote response
    body, base64, prompt text, image bytes, ngrok URL with credentials/
    query data, or a raw traceback. The original exception (when one
    exists) is preserved via `raise ... from exc` for local debugging,
    never included in the message text itself."""


class ImageGenUnavailableError(ImageGenError):
    """The health check failed, or the remote service reported an
    incompatible API version / missing depth-ControlNet capability —
    always raised BEFORE any POST is attempted."""


class ImageGenTimeoutError(ImageGenError):
    """The generation POST itself timed out."""


class ImageGenRequestError(ImageGenError):
    """A POST transport failure other than a timeout (e.g. a connection
    error) — never used for a timeout specifically, see
    ImageGenTimeoutError."""


class ImageGenServiceError(ImageGenError):
    """The remote service responded to the POST with a non-2xx status.
    `status_code` is exposed as a typed attribute for callers that need
    it, while the message itself stays sanitized (never the raw response
    body)."""

    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class ImageGenResponseError(ImageGenError):
    """The remote service returned a 2xx response that is malformed,
    internally inconsistent, contract-incompatible, or not depth-
    conditioned. This is the boundary that validates every field of an
    untrusted remote payload — see _parse_generation_response."""


# --- result -----------------------------------------------------------------


class GenerationResult(BaseModel):
    """A fully validated, trusted /generate response. Bytes stay internal
    and raw — base64 conversion for the browser is R4's API-layer
    concern, not this transport client's.

    Immutable (frozen) and field/cross-field validated so a contradictory
    instance cannot be directly constructed where it's practical to catch
    (bounded numeric ranges, exact hash format, depth_map_used pinned to
    literal True, and a re-check that image_media_type genuinely matches
    the decoded image_bytes)."""

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
    """Strips exactly the trailing slash a configured base URL might
    carry, so a request URL never ends up containing `//health` or
    `//generate`."""
    return settings.image_gen_base_url.rstrip("/")


def _validate_run_id(run_id: Any) -> str:
    try:
        return _RUN_ID_ADAPTER.validate_python(run_id)
    except ValidationError as exc:
        raise ValueError(f"run_id is not a valid non-empty string: {run_id!r}") from exc


def _validate_image(image_bytes: Any, image_media_type: Any) -> None:
    """Delegates to app.core.image_validation.validate_image_bytes — the
    same Pillow decode/verify/format-match logic R4's reorganise pipeline
    uses on the resubmitted original image before planning (see that
    module's own docstring for why it's shared rather than duplicated).
    ImageValidationError is a ValueError subclass, so this function's own
    documented contract ("raises ValueError") is unchanged; every caller
    of generate() that already catches ValueError keeps working exactly
    as before."""
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
    """
    Lightweight GET against the remote service's /health endpoint. Called
    both by R4's GET /image-gen/health (so the UI can show availability
    up front) and internally by generate() before committing to a full
    request. Uses image_gen_health_timeout_s, deliberately short — a slow
    health check defeats the point of having one.

    Returns False (NEVER raises) for: a timeout, any
    requests.RequestException, a non-2xx status, invalid or non-object
    JSON, status != "ok", a wrong api_version, a blank/missing
    service_version, missing capabilities, or capabilities.depth_controlnet
    not exactly True. Returns True only for a fully valid, compatible
    response.

    Status-code check is deliberately `200 <= status_code < 300`, not
    `resp.ok` — `requests.Response.ok` is True for the WHOLE `< 400`
    range, including 3xx redirects (e.g. an ngrok/reverse-proxy redirect),
    which is not a successful health response and must not be treated as
    one.
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
    """Validates a 2xx /generate response against the full contract (see
    module-level docs) and returns a trusted GenerationResult, or raises
    ImageGenResponseError — never a raw exception, never the response
    body in the message."""
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
        # This proves request correlation ONLY — that the response's hash
        # matches the hash of what THIS client sent. It does not, and
        # cannot, prove the remote diffusion pipeline actually used the
        # prompt when generating the image; see module docs / R7.
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
        # Every field above was already individually checked against
        # untrusted response data — a failure here means the checks above
        # missed something about that SAME untrusted data, not an
        # internal caller defect, so it is still an ImageGenResponseError.
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
    """
    Validates every caller input (see the _validate_* helpers) BEFORE any
    health check or HTTP call — a malformed call never reaches the
    network at all. Then calls check_health(); a failed/incompatible
    health check raises ImageGenUnavailableError and no POST is ever
    made. Only then does this POST to `{base_url}/generate` (JSON body,
    not multipart), using settings.image_gen_request_timeout_s, and
    validate the response against the full contract (see
    _parse_generation_response) before returning a trusted
    GenerationResult.

    §7 gotcha this guards against specifically: verify the remote service
    actually reads `prompt` rather than silently falling back to a
    hardcoded default (this was broken and unnoticed for a while in v1).
    This client always sends the CALLER's exact prompt (only outer
    whitespace trimmed) and never substitutes anything — R7's real smoke
    test must separately confirm the remote pipeline's OWN behavior
    (a same-image/different-prompt sensitivity check), since this
    client's own correctness can't prove that on its own.

    Never retries the POST automatically — image generation is expensive,
    and an automatic retry after a client-side timeout could produce
    duplicate GPU work on a request that may still complete remotely.
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

    # Strict 2xx, not resp.ok — see check_health()'s own docstring for why
    # `.ok` (True for the whole < 400 range, including 3xx) is the wrong check.
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
