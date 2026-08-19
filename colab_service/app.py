"""
FastAPI service — GET /health, POST /generate. Thin handlers only; the
real logic lives in pipeline.py/depth.py/resolution.py/schemas.py,
mirroring backend/app/api/routes.py's own "HTTP layer only" convention
exactly (see that module's own docstring).

Importing this module NEVER triggers model loading — load_models() below
is the one real GPU/model-loading entry point, called explicitly by the
notebook launcher (ClearSpace_Image_Gen.ipynb) after confirming CUDA is
available, never at import time. This is what makes
`from colab_service import app` (and colab_service/tests/test_app.py,
which does exactly that) safe on a plain machine with no GPU and no
Colab runtime at all.

Concurrency: a single, module-level, NON-BLOCKING threading.Lock guards
/generate — a second concurrent request while one is already in flight
gets an immediate, sanitized 503, never queued behind a generation that
could itself consume most of the client's own 180s timeout budget (see
backend/app/config.py's image_gen_request_timeout_s). This needs no
backend change at all: app.models.image_gen_client.generate() already
maps any non-2xx status to ImageGenServiceError, which
reorganise_pipeline_service.py already maps to a plan-preserving
image_status="unavailable" — confirmed by inspection during this
project's R7 audit, not assumed.

Sanitized failures: two exception handlers below replace FastAPI's
default behavior specifically because it is NOT safe here by default —
see each handler's own docstring. Never a raw traceback, request-body
value, image, base64 payload, prompt, secret, or credential-bearing URL
in any HTTP response — the real detail (when there is any worth having)
is only ever printed to the notebook's own cell output, never sent over
HTTP.

Route handlers are plain `def`, not `async def` — deliberately, mirroring
backend's own convention: FastAPI/Starlette runs a plain `def` path
operation in its threadpool automatically, which is what keeps the
blocking depth-extraction/diffusion call off the event loop without any
manual thread management here.
"""

from __future__ import annotations

import base64
import hashlib
import io
import threading
import traceback

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from PIL import Image

from colab_service import config, depth, pipeline, resolution, schemas

app = FastAPI()


class _ServiceState:
    """Mutable readiness state — deliberately NOT computed lazily from
    whether pipeline._pipeline is None, so tests can set/unset readiness
    directly without needing a real (or even fake) pipeline object at
    all. Set to ready only by load_models() below, after every model has
    genuinely finished loading."""

    def __init__(self) -> None:
        self.ready = False
        self.base_model_id: str | None = None
        self.controlnet_model_id: str | None = None


_state = _ServiceState()

# Non-blocking single-generation lock — see module docstring.
_generation_lock = threading.Lock()

# Swappable reference to the real generation function — module-level, not
# a hardcoded call to pipeline.run_generation() inline in generate()
# below, specifically so colab_service/tests/test_app.py can monkeypatch
# THIS attribute with a fake and never execute real inference. Never
# reassigned anywhere in this file outside this one default.
_run_generation = pipeline.run_generation


def load_models() -> None:
    """The one real GPU/model-loading entry point in this service.
    Called explicitly by the notebook launcher, after it has already
    confirmed CUDA is available — never at import time, never during
    colab_service/tests/. Sets _state.ready = True only after every
    model has genuinely finished loading; a failure here (e.g. an
    incompatible dependency version, a Hub identifier that doesn't
    resolve — see colab_service/README.md's "Provisional items") raises
    and leaves _state.ready False, so the notebook cell fails loudly
    rather than starting a server that would silently never become
    healthy."""
    settings = config.get_settings()
    pipeline.load_pipeline(settings)
    depth.load_depth_detector(settings.midas_model_id)
    _state.base_model_id = settings.base_model_id
    _state.controlnet_model_id = settings.controlnet_model_id
    _state.ready = True


# --- sanitized error handling --------------------------------------------


@app.exception_handler(RequestValidationError)
async def _sanitized_validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's DEFAULT RequestValidationError handler echoes the
    actual invalid VALUE back in each error's "input" field — for a
    malformed `image`/`prompt` field, that would leak exactly the data
    this service must never expose in an HTTP response (see module
    docstring). This handler replaces that default entirely: it reports
    which FIELDS were invalid, never their values."""
    fields = sorted({".".join(str(p) for p in e["loc"] if p != "body") for e in exc.errors()})
    return JSONResponse(status_code=422, content={"error": "invalid request", "fields": fields})


@app.exception_handler(Exception)
async def _sanitized_unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Never a raw traceback or exception message in the HTTP response —
    printed to the notebook's own cell output (server-side, for the
    operator) via traceback.print_exc(), never returned over HTTP."""
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"error": "internal error"})


# --- GET /health -----------------------------------------------------------


@app.get("/health")
def health() -> JSONResponse:
    """Returns the exact compatible success body ONLY once _state.ready
    is True — see load_models(). Before that, returns a 200 with a
    distinct, non-"ok" status so an operator manually curling /health
    gets useful information; app.models.image_gen_client.check_health()
    already treats anything other than the literal body
    schemas.build_health_response() produces as unavailable regardless
    of the exact shape used here, so no client-side change is implied
    either way."""
    if not _state.ready:
        return JSONResponse(status_code=200, content={"status": "loading"})
    settings = config.get_settings()
    body = schemas.build_health_response(service_version=settings.service_version)
    return JSONResponse(status_code=200, content=body)


# --- POST /generate ---------------------------------------------------------


@app.post("/generate")
def generate(request: schemas.GenerateRequest) -> JSONResponse:
    """request has already been fully validated (shape, bounds, base64
    syntax, genuine image-content/media-type match) by
    schemas.GenerateRequest before this body ever runs — malformed input
    never reaches here at all (see the sanitized 422 handler above for
    what a caller sees instead).

    Order: not-ready check -> non-blocking lock acquire (503 immediately
    if busy, never queued) -> decode/hash/resize/RGB-convert -> the one
    real generation call -> build the exact 14-field response -> release
    the lock in `finally`, on both success and failure.
    """
    if not _state.ready:
        return JSONResponse(status_code=503, content={"error": "service not ready"})

    if not _generation_lock.acquire(blocking=False):
        return JSONResponse(status_code=503, content={"error": "busy"})

    try:
        # Syntax already validated by schemas.GenerateRequest.
        image_bytes = base64.b64decode(request.image)
        input_image_sha256 = hashlib.sha256(image_bytes).hexdigest()
        # request.prompt is already the normalized (outer-whitespace-
        # trimmed) value — schemas.GenerateRequest's own validator did
        # that; this hashes exactly what will be passed to the pipeline.
        prompt_sha256 = hashlib.sha256(request.prompt.encode("utf-8")).hexdigest()

        original_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        settings = config.get_settings()
        target = resolution.compute_target_resolution(
            original_image.width, original_image.height, settings.resolution_pixel_budget
        )
        # LANCZOS, not Pillow's nearest-neighbour default — a real,
        # meaningfully-lower-quality resample for the small photographic
        # rescale resolution.compute_target_resolution() computes (see
        # that module's own corrected docstring: Option A introduces a
        # real, small geometric rescale, not literally zero stretching).
        resized_image = original_image.resize((target.width, target.height), Image.Resampling.LANCZOS)

        try:
            result = _run_generation(
                image=resized_image,
                prompt=request.prompt,
                negative_prompt=request.negative_prompt,
                denoise_strength=request.denoise_strength,
                controlnet_conditioning_scale=request.controlnet_conditioning_scale,
                seed=request.seed,
                settings=settings,
            )
        except pipeline.UnsafeOutputError:
            # No image, no prompt, no generated content in the response
            # — see pipeline.UnsafeOutputError's own docstring.
            return JSONResponse(status_code=422, content={"error": "generated output failed safety check"})

        body = schemas.build_generate_response(
            run_id=request.run_id,
            image_bytes=result.image_bytes,
            denoise_strength=request.denoise_strength,
            controlnet_conditioning_scale=request.controlnet_conditioning_scale,
            seed=request.seed,
            base_model=result.base_model,
            controlnet_model=result.controlnet_model,
            service_version=settings.service_version,
            prompt_sha256=prompt_sha256,
            input_image_sha256=input_image_sha256,
            generation_ms=result.generation_ms,
        )
        return JSONResponse(status_code=200, content=body)
    finally:
        _generation_lock.release()
