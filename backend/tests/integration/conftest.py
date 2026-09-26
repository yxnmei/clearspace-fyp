"""
Opt-in gate for the real-model integration tests in this directory.

`@pytest.mark.integration` alone is NOT a safety mechanism: pytest.ini
registers the marker but does not deselect it, so a plain `pytest -q`
collects and runs everything here. The environment gate below is what
keeps the ordinary suite fast and offline. It is deliberately ordered so
that nothing expensive happens before the cheap checks pass:

  1. CLEARSPACE_REAL_MODELS must be exactly "1"       -> else skip
  2. resolve the integration image path              -> must be a regular file
  3. Grounding DINO config + weights must exist       -> never downloaded
  4. the configured CLIP checkpoint must be cached    -> never downloaded
  5. the configured Ollama host must be local         -> nothing else is contacted
  6. Ollama must answer on that local endpoint        -> one GET /api/tags
  7. the configured model must already be installed  -> never pulled

Only after every step passes does the test module import the model
wrappers and services. This file itself imports nothing heavier than
pytest, the standard library and app.config (pydantic settings), and
app.config is imported only after step 1.

Every prerequisite failure is a pytest SKIP with a precise reason, never
a pass and never a silent substitution (another image, another model,
another host). Skip reasons name the variable or file that is missing
but never echo environment-variable values.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import pytest

OPT_IN_ENV = "CLEARSPACE_REAL_MODELS"
IMAGE_ENV = "CLEARSPACE_INTEGRATION_IMAGE"

# backend/ — this file is backend/tests/integration/conftest.py.
BACKEND_ROOT = Path(__file__).resolve().parents[2]

# The local convention uses the same image for every documented manual
# real-model run. This is only a
# default; CLEARSPACE_INTEGRATION_IMAGE overrides it so the test is not
# tied to one machine.
DEFAULT_IMAGE = BACKEND_ROOT / "data" / "test_images" / "bedroom02.jpg"

_LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}
_OLLAMA_PROBE_TIMEOUT_S = 3.0


@dataclass(frozen=True)
class RealModelPrerequisites:
    """What the gate established, handed to the test so it never re-derives
    (or re-reads from the environment) anything the gate already checked."""

    image_path: Path
    grounding_dino_config_path: Path
    grounding_dino_weights_path: Path
    clip_model_name: str
    clip_checkpoint_path: Path
    ollama_host: str
    llm_model_name: str


def pytest_collection_modifyitems(items):
    """Every test collected from this directory is an integration test by
    definition (tests/integration/README.md), so the marker is enforced
    here rather than trusted to be remembered on each function."""
    here = Path(__file__).resolve().parent
    for item in items:
        if Path(str(item.fspath)).resolve().is_relative_to(here):
            item.add_marker(pytest.mark.integration)


def _resolve_backend_path(configured: str) -> Path:
    """Mirrors app.models.grounding_dino._resolve_backend_path (relative
    configured paths resolve against backend/, absolute ones pass
    through) WITHOUT importing that module, which pulls in torch at module
    scope. The test re-asserts equality with the production resolver after
    the heavy import, so any drift between the two is caught there."""
    path = Path(configured)
    if path.is_absolute():
        return path
    return BACKEND_ROOT / path


def _clip_checkpoint_path(model_name: str) -> Path:
    """Where `clip.load(model_name)` looks before downloading: an existing
    file path is used as-is; otherwise ~/.cache/clip/<basename of the
    upstream URL>, and every official checkpoint's basename is the model
    name with "/" replaced by "-" plus ".pt" (e.g. ViT-B/32 -> ViT-B-32.pt).
    Computed rather than imported so this gate never imports `clip`
    (which imports torch) before the opt-in and cache checks pass."""
    candidate = Path(model_name)
    if candidate.is_file():
        return candidate
    return Path.home() / ".cache" / "clip" / (model_name.replace("/", "-") + ".pt")


def _installed_ollama_models(host: str) -> set[str]:
    """One GET {host}/api/tags. Returns every listed name and model tag.
    Raises on any transport or decoding failure; the caller turns that
    into a skip. This is the ONLY network call the gate makes, and only
    after the host has been verified to be local."""
    url = host.rstrip("/") + "/api/tags"
    with urllib.request.urlopen(url, timeout=_OLLAMA_PROBE_TIMEOUT_S) as response:
        payload = json.load(response)
    names: set[str] = set()
    for entry in payload.get("models", []):
        for key in ("name", "model"):
            value = entry.get(key)
            if isinstance(value, str) and value:
                names.add(value)
    return names


def _model_is_installed(configured: str, installed: set[str]) -> bool:
    """Ollama lists an untagged pull as `<name>:latest`; the configured
    `phi4-mini` therefore matches `phi4-mini:latest` exactly, and nothing
    else (no prefix or family matching, so `phi4-mini` never silently
    resolves to a differently-tagged sibling)."""
    if configured in installed:
        return True
    if ":" not in configured and f"{configured}:latest" in installed:
        return True
    return False


@pytest.fixture(scope="session")
def real_model_prerequisites() -> RealModelPrerequisites:
    # 1. Explicit opt-in, checked before anything else is imported or touched.
    if os.environ.get(OPT_IN_ENV) != "1":
        pytest.skip(
            f"real-model integration tests are opt-in: set {OPT_IN_ENV}=1 "
            "(needs local weights, a cached CLIP checkpoint and a running local Ollama)"
        )

    # 2. The image: env override, else the documented gitignored local default.
    configured_image = os.environ.get(IMAGE_ENV)
    if configured_image is not None and configured_image.strip():
        image_path = Path(configured_image).expanduser()
        image_source = f"{IMAGE_ENV}"
    else:
        image_path = DEFAULT_IMAGE
        image_source = f"the default {DEFAULT_IMAGE.relative_to(BACKEND_ROOT).as_posix()} (set {IMAGE_ENV} to override)"
    if not image_path.is_file():
        pytest.skip(f"integration image from {image_source} is not an existing regular file")

    # app.config is light (pydantic-settings only) — imported only after opt-in.
    from app.config import get_settings

    settings = get_settings()

    # 3. Grounding DINO config + weights — present locally or skip, never downloaded.
    config_path = _resolve_backend_path(settings.grounding_dino_config_path)
    weights_path = _resolve_backend_path(settings.grounding_dino_weights_path)
    if not config_path.is_file():
        pytest.skip("Grounding DINO config file is missing at the configured path (not downloading)")
    if not weights_path.is_file():
        pytest.skip("Grounding DINO weights file is missing at the configured path (not downloading)")

    # 4. CLIP checkpoint — already cached or skip, never downloaded.
    clip_checkpoint = _clip_checkpoint_path(settings.clip_model_name)
    if not clip_checkpoint.is_file():
        pytest.skip(
            f"CLIP checkpoint for the configured model {settings.clip_model_name!r} is not cached "
            "locally (not downloading)"
        )

    # 5. Ollama host must be local before it is contacted at all.
    parsed = urllib.parse.urlsplit(settings.ollama_host)
    if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() not in _LOCAL_HOSTNAMES:
        pytest.skip("configured OLLAMA_HOST is not a local endpoint; refusing to contact it")

    # 6. Ollama must answer on that endpoint.
    try:
        installed = _installed_ollama_models(settings.ollama_host)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        pytest.skip(f"Ollama is not reachable on the configured local endpoint ({type(exc).__name__})")

    # 7. The configured model must already be installed — never pulled, never substituted.
    if not _model_is_installed(settings.llm_model_name, installed):
        pytest.skip(
            f"configured Ollama model {settings.llm_model_name!r} is not installed locally "
            "(not pulling, not substituting another model)"
        )

    return RealModelPrerequisites(
        image_path=image_path,
        grounding_dino_config_path=config_path,
        grounding_dino_weights_path=weights_path,
        clip_model_name=settings.clip_model_name,
        clip_checkpoint_path=clip_checkpoint,
        ollama_host=settings.ollama_host,
        llm_model_name=settings.llm_model_name,
    )
