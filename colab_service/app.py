"""Thin FastAPI boundary for health and image generation.

Model loading is explicit and never occurs on import. A non-blocking lock makes
concurrent generation fail immediately with a sanitised 503. Plain ``def``
handlers run blocking model work in FastAPI's threadpool. Validation and
unhandled-error responses never expose request data, prompts, secrets, or traces.
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
    """Readiness set only after all models load; independently controllable in tests."""

    def __init__(self) -> None:
        self.ready = False
        self.base_model_id: str | None = None
        self.controlnet_model_id: str | None = None


_state = _ServiceState()

# Non-blocking single-generation lock — see module docstring.
_generation_lock = threading.Lock()

# Indirection lets local tests substitute generation without real inference.
_run_generation = pipeline.run_generation


def load_models() -> None:
    """Load every model explicitly, marking ready only after success."""
    settings = config.get_settings()
    pipeline.load_pipeline(settings)
    depth.load_depth_detector(settings.midas_model_id)
    _state.base_model_id = settings.base_model_id
    _state.controlnet_model_id = settings.controlnet_model_id
    _state.ready = True


# --- sanitized error handling --------------------------------------------


@app.exception_handler(RequestValidationError)
async def _sanitized_validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Report invalid fields without FastAPI's echoed input values."""
    fields = sorted({".".join(str(p) for p in e["loc"] if p != "body") for e in exc.errors()})
    return JSONResponse(status_code=422, content={"error": "invalid request", "fields": fields})


@app.exception_handler(Exception)
async def _sanitized_unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Print diagnostics server-side but return no exception detail."""
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"error": "internal error"})


# --- GET /health -----------------------------------------------------------


@app.get("/health")
def health() -> JSONResponse:
    """Return the compatible success contract only after models are ready."""
    if not _state.ready:
        return JSONResponse(status_code=200, content={"status": "loading"})
    settings = config.get_settings()
    body = schemas.build_health_response(service_version=settings.service_version)
    return JSONResponse(status_code=200, content=body)


# --- POST /generate ---------------------------------------------------------


@app.post("/generate")
def generate(request: schemas.GenerateRequest) -> JSONResponse:
    """Generate once from validated input, or return an immediate busy 503."""
    if not _state.ready:
        return JSONResponse(status_code=503, content={"error": "service not ready"})

    if not _generation_lock.acquire(blocking=False):
        return JSONResponse(status_code=503, content={"error": "busy"})

    try:
        # Syntax already validated by schemas.GenerateRequest.
        image_bytes = base64.b64decode(request.image)
        input_image_sha256 = hashlib.sha256(image_bytes).hexdigest()
        # Hash exactly the normalised prompt passed to the pipeline.
        prompt_sha256 = hashlib.sha256(request.prompt.encode("utf-8")).hexdigest()

        original_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        settings = config.get_settings()
        target = resolution.compute_target_resolution(
            original_image.width, original_image.height, settings.resolution_pixel_budget
        )
        # Use photographic resampling for the small target-size adjustment.
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
            # Do not expose generated content rejected by the safety checker.
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
