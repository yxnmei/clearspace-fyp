"""Cached MiDaS depth extraction for the configured ControlNet.

Heavy dependencies load only inside the loader, keeping local imports GPU-free.
The standard preprocessor has run successfully in the verified Colab runtime.
"""

from __future__ import annotations

from typing import Any

_depth_detector: Any = None


def load_depth_detector(model_id: str) -> Any:
    """Load and cache the heavy depth detector on first explicit use."""
    global _depth_detector
    if _depth_detector is None:
        from controlnet_aux import MidasDetector  # heavy import — deferred to call time only

        _depth_detector = MidasDetector.from_pretrained(model_id)
    return _depth_detector


def extract_depth_map(image: Any, *, model_id: str) -> Any:
    """Extract depth and align it to the generation image when necessary.

    A verified 584x440 input produced a 704x512 map, which ControlNet rejected;
    mismatched output is therefore resized once with bilinear resampling.
    """
    detector = load_depth_detector(model_id)
    depth_map = detector(image)

    if depth_map.size != image.size:
        from PIL import Image

        depth_map = depth_map.resize(image.size, Image.Resampling.BILINEAR)

    return depth_map
