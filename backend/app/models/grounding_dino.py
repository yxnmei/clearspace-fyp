"""Grounding DINO object detection used by the production pipeline.

It was selected after detecting 21 objects versus YOLOv8s's 3 on the same
test image; alternative comparisons belong in evaluation tooling.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from app.config import get_settings

# Version the open-set domestic vocabulary beside the detector.
#
# painting/artwork/jewelry/necklace/guitar/balloon added 2026-08-07 — a
# A missing real object can force the nearest available label rather than
# abstention. The 2026-08-07 run showed:
# a wall painting labeled "document", a circular wall decoration labeled
# "clock", a hanging necklace labeled "cable", and a guitar-in-gig-bag
# labeled "tool" in the 2026-08-07 run. "balloon" is also a real
# ground-truth item in evaluation/labels/labels.json with no matching term.
#
# "clothes" already covers hangers. Adding "musical instrument" fragmented
# the phrase to "musical" because phrase construction thresholds each token;
# only "guitar" is evidenced. These additions remain unverified as a set.
DOMESTIC_VOCABULARY_PROMPT = (
    "chair . table . desk . lamp . laptop . monitor . keyboard . mouse . "
    "cable . charger . book . notebook . magazine . document . bottle . cup . "
    "mug . plate . bowl . utensil . box . basket . bag . backpack . clothes . "
    "jacket . shirt . shoe . shelf . drawer . bin . trash can . plant . "
    "picture frame . mirror . clock . remote control . phone . speaker . "
    "printer . fan . heater . pillow . blanket . towel . toy . tool . cord . "
    "painting . artwork . jewelry . necklace . guitar . balloon"
)


@dataclass
class RawDetection:
    label: str  # raw model output — may be a compound phrase, see core/label_cleanup.py
    box_xyxy: tuple[float, float, float, float]  # normalized to [0, 1] — see core/box_descriptors.py
    confidence: float


_model_cache = None  # Reloading the checkpoint per call would dominate latency.

# Resolve relative weights from backend/, not the process working directory.
# The latter caused a verified startup 503 on 2026-08-11.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent


def _resolve_backend_path(configured: str) -> Path:
    """Resolve relative model paths from backend/; preserve absolute overrides."""
    path = Path(configured)
    if path.is_absolute():
        return path
    return _BACKEND_ROOT / path


def load_model():
    """Load and cache Grounding DINO on CPU."""
    global _model_cache
    if _model_cache is not None:
        return _model_cache

    from groundingdino.util.inference import load_model as _load_model

    settings = get_settings()
    config_path = _resolve_backend_path(settings.grounding_dino_config_path)
    weights_path = _resolve_backend_path(settings.grounding_dino_weights_path)
    if not config_path.exists() or not weights_path.exists():
        raise FileNotFoundError(
            f"Grounding DINO config/weights not found at {config_path} / {weights_path} "
            "— download them into weights/ first (see README)."
        )
    _model_cache = _load_model(str(config_path), str(weights_path), device="cpu")
    return _model_cache


def _load_image_from_bytes(image_bytes: bytes) -> tuple[np.ndarray, torch.Tensor]:
    """Apply the upstream image transform directly to in-memory bytes."""
    import groundingdino.datasets.transforms as T

    transform = T.Compose(
        [
            T.RandomResize([800], max_size=1333),
            T.ToTensor(),
            T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    image_source = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    image_array = np.asarray(image_source)
    image_transformed, _ = transform(image_source, None)
    return image_array, image_transformed


def detect(image_bytes: bytes, prompt: str = DOMESTIC_VOCABULARY_PROMPT) -> list[RawDetection]:
    """Runs detection, returns raw (uncleaned) labels + boxes + confidence."""
    from groundingdino.util import box_ops
    from groundingdino.util.inference import predict

    settings = get_settings()
    model = load_model()
    _, image = _load_image_from_bytes(image_bytes)

    boxes, logits, phrases = predict(
        model=model,
        image=image,
        caption=prompt,
        box_threshold=settings.detection_box_threshold,
        text_threshold=settings.detection_text_threshold,
        device="cpu",
    )

    # Normalised boxes keep spatial hints resolution-independent.
    boxes_xyxy = box_ops.box_cxcywh_to_xyxy(boxes)

    return [
        RawDetection(label=phrase, box_xyxy=tuple(box.tolist()), confidence=float(logit))
        for box, logit, phrase in zip(boxes_xyxy, logits, phrases)
    ]
