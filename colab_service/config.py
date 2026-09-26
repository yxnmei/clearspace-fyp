"""Environment-only configuration for the Colab service.

The notebook maps Colab Secrets to environment variables, keeping this module
independent of Colab APIs and locally testable.
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

    # Implementation version, distinct from the HTTP contract version.
    service_version: str = "colab-dev-0.1"

    # --- resolution policy (see resolution.py) ---
    resolution_pixel_budget: int = 512 * 512

    # --- internal generation settings (see pipeline.py) ---
    # Verified runtime defaults, not established as quality-optimal.
    num_inference_steps: int = Field(default=30, ge=1, le=150)
    guidance_scale: float = Field(default=7.5, gt=0.0, le=30.0)

    # --- notebook tunnel settings, populated from environment variables ---
    ngrok_authtoken: str | None = None
    ngrok_domain: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
