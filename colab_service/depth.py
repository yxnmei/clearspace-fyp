"""
MiDaS depth extraction — via controlnet_aux.MidasDetector, the standard
preprocessor the sd-controlnet-depth checkpoint (config.controlnet_model_id)
was documented/trained against and has run successfully in the verified
Colab environment. If controlnet_aux becomes incompatible with a future
diffusers/torch combination, the documented fallback is
transformers.DPTForDepthEstimation + Intel/dpt-hybrid-midas (more manual
normalization, more room for a depth-format mismatch bug — not
implemented because the current integration does not need it).

Every heavy import (controlnet_aux, and transitively torch) is deferred
to inside load_depth_detector() — NEVER at module import time. This is
what makes `import colab_service.depth` safe during local, GPU-free
tests (see colab_service/tests/test_app.py's own subprocess-based import
check) — it never loads or downloads anything just by being imported.

Module-level cache (load once, reuse for every request) — mirrors
backend/app/models/grounding_dino.py's own established caching
convention in this project.
"""

from __future__ import annotations

from typing import Any

_depth_detector: Any = None


def load_depth_detector(model_id: str) -> Any:
    """Loads (once) and returns the MiDaS depth detector. Real, heavy,
    network-fetching model load — never called by importing this module,
    never called during colab_service/tests/ (those substitute a fake
    generation function at the colab_service.app level entirely, never
    reaching this function — see app.py's own docstring)."""
    global _depth_detector
    if _depth_detector is None:
        from controlnet_aux import MidasDetector  # heavy import — deferred to call time only

        _depth_detector = MidasDetector.from_pretrained(model_id)
    return _depth_detector


def extract_depth_map(image: Any, *, model_id: str) -> Any:
    """Runs MiDaS on `image` (a PIL.Image.Image) and returns the depth
    map as a PIL.Image.Image, in the format controlnet_aux's own
    MidasDetector already produces (a 3-channel grayscale-visualized
    depth image accepted directly by the configured ControlNet pipeline;
    no extra normalization is applied).

    `image` must already be RGB and already resized to the target
    generation resolution (resolution.compute_target_resolution()).
    MidasDetector's own output resolution does not always match its
    input resolution (confirmed on a real Colab GPU run — see
    colab_service/README.md: a 584x440 input produced a 704x512 depth
    map, which the ControlNet checkpoint then rejected as a
    tensor-dimension mismatch) — so if depth_map.size differs from
    image.size, this function resizes the depth map to image.size
    (Image.Resampling.BILINEAR) exactly once before returning it,
    keeping it pixel-aligned with what the SD pipeline itself sees.
    Returns the detector's own output object unchanged, by identity,
    when the sizes already match."""
    detector = load_depth_detector(model_id)
    depth_map = detector(image)

    if depth_map.size != image.size:
        from PIL import Image

        depth_map = depth_map.resize(image.size, Image.Resampling.BILINEAR)

    return depth_map
