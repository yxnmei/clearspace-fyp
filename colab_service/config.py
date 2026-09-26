"""
Environment-only configuration for the Colab image-generation service.

Deliberately never imports google.colab anywhere in this file — reading
Colab Secrets stays confined to the notebook's own cells (see
ClearSpace_Image_Gen.ipynb), which translate them into plain environment
variables before this module ever runs. That is what keeps this module
(and everything that imports it) importable and unit-testable on a plain
machine with no Colab runtime, no GPU, and no `google.colab` package
installed at all — required for colab_service/tests/ to run locally.

Single source of truth for anything that varies between a real Colab
session and a local test run — mirrors backend/app/config.py's own
"nothing reads os.environ directly, import Settings from here instead"
convention, applied to this separate service.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # --- local server bind address (the notebook maps the ngrok tunnel to this port) ---
    host: str = "0.0.0.0"
    port: int = 8001

    # --- model identifiers ---
    # These configured identifiers loaded successfully in the verified Colab
    # environment. pipeline.py still reports the identifiers it actually loads
    # rather than assuming configuration and runtime agree.
    base_model_id: str = "stable-diffusion-v1-5/stable-diffusion-v1-5"
    controlnet_model_id: str = "lllyasviel/sd-controlnet-depth"
    # controlnet_aux.MidasDetector's weights repo — the standard preprocessor
    # documented for sd-controlnet-depth and used by the verified runtime.
    midas_model_id: str = "lllyasviel/Annotators"

    # Identifies THIS implementation (distinct from api_version, which is
    # the contract/shape version) — echoed in every /health and /generate
    # response. The development label remains separate from the verified
    # runtime status and does not claim acceptable output fidelity.
    service_version: str = "colab-dev-0.1"

    # --- resolution policy (see resolution.py) ---
    resolution_pixel_budget: int = 512 * 512

    # --- internal, provisional generation settings (see pipeline.py) ---
    # Deliberately NOT part of the R3 HTTP contract — never a
    # schemas.GenerateRequest/GenerateResponse field, never accepted from
    # or echoed to a caller. Standard SD1.5 starting points, not yet
    # evidence-backed for THIS pipeline/checkpoint combination — Phase 2
    # must revise these based on measured output quality and real
    # generation runtime (see README.md's "Provisional items").
    num_inference_steps: int = Field(default=30, ge=1, le=150)
    guidance_scale: float = Field(default=7.5, gt=0.0, le=30.0)

    # --- read by the notebook's own ngrok-launch cell, not by app.py's
    # core request-handling logic. Kept here anyway so every piece of
    # this service's configuration has exactly one source of truth,
    # matching backend/app/config.py's own convention of centralizing
    # ALL settings in one Settings class regardless of which module
    # consumes which field. Populated from Colab Secrets, via plain
    # environment variables — see module docstring. ---
    ngrok_authtoken: str | None = None
    ngrok_domain: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
