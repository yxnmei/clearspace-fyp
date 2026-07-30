"""
Client for the remote Colab/ngrok image-generation service (§5) —
MiDaS depth + ControlNet-depth + SD v1.5 img2img, running on a notebook
this codebase does not control the lifecycle of.

§5 is explicit that the v1 failure mode (dead tunnel -> raw connection
error surfaced mid-demo) came from *not designing for* an already-known
risk, not from a novel bug. Three things exist here specifically to
prevent a repeat:

  1. check_health() — a fast, separate call the frontend can hit proactively
     (GET /image-gen/health in routes.py) rather than only discovering the
     tunnel is dead when a user clicks Reorganise.
  2. generate() always calls check_health() first and fails in
     milliseconds with a clear message, instead of hanging until
     image_gen_request_timeout_s expires.
  3. image_gen_base_url is a *reserved* ngrok domain (config.py), so it
     doesn't need rediscovering/reconfiguring every session the way the
     free rotating kind does.
"""

from __future__ import annotations

from dataclasses import dataclass

import requests

from app.config import get_settings


class ImageGenUnavailableError(RuntimeError):
    """Raised when the Colab/ngrok service is unreachable — always carries a
    user-facing message, per §5, not a raw requests exception."""


@dataclass
class GenerationResult:
    image_bytes: bytes
    denoise_strength: float
    depth_map_used: bool


def check_health() -> bool:
    """
    Lightweight GET against the notebook's /health endpoint. Called both
    by routes.py's /image-gen/health (so the UI can show availability
    up front) and internally by generate() before committing to a full
    request. Must use image_gen_health_timeout_s, deliberately short —
    a slow health check defeats the point of having one.
    """
    settings = get_settings()
    try:
        resp = requests.get(
            f"{settings.image_gen_base_url}/health",
            timeout=settings.image_gen_health_timeout_s,
        )
        return resp.ok
    except requests.RequestException:
        return False


def generate(
    run_id: str,
    image_bytes: bytes,
    prompt: str,
    denoise_strength: float | None = None,
) -> GenerationResult:
    """
    §7 gotcha to guard against here specifically: verify the notebook
    actually reads `prompt` rather than silently falling back to a
    hardcoded default (this was broken and unnoticed for a while in v1).
    The eval harness should assert generated images differ meaningfully
    across different prompts on the same input image — see
    evaluation/scripts/ once this is implemented.
    """
    settings = get_settings()
    if not check_health():
        raise ImageGenUnavailableError(
            "Cannot reach the Colab image-generation server. "
            "Make sure the notebook is running and the ngrok tunnel is up."
        )
    resolved_strength = denoise_strength if denoise_strength is not None else settings.image_gen_denoise_strength
    raise NotImplementedError(
        f"POST to {settings.image_gen_base_url}/generate, denoise_strength={resolved_strength}"
    )
