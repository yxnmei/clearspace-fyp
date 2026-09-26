"""
Object detection: Grounding DINO (chosen after detecting 21 vs 3 objects
against YOLOv8s on the same test image).

YOLOv8s is NOT reimplemented here — that comparison is already evidenced
and done; don't re-litigate settled comparisons without a specific
reason. If a genuine reason comes up later, put the YOLOv8s path in
evaluation/scripts/, not here, so app/models/ stays "the model actually
used in the shipped pipeline," not a grab-bag of every candidate tried.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from app.config import get_settings

# Domestic-vocabulary prompt for open-set detection — versioned here so
# changes to it are visible in diffs/blame, not buried in a service call.
#
# painting/artwork/jewelry/necklace/guitar/balloon added 2026-08-07 — a
# fixed vocabulary with no entry for a real object forces Grounding DINO to
# label it with the nearest available term instead of abstaining, evidenced
# via evaluation/scripts/visualize_detections.py eyeballing real detections:
# a wall painting labeled "document", a circular wall decoration labeled
# "clock", a hanging necklace labeled "cable", and a guitar-in-gig-bag
# labeled "tool" in the 2026-08-07 run. "balloon" is also a real
# ground-truth item in evaluation/labels/labels.json with no matching term.
#
# Deliberately NOT added: "clothes hanger" for the clothes-on-hangers case
# — the pre-existing "clothes" term below already covers it, and the
# hanger itself isn't what a decluttering decision hinges on. Also
# deliberately NOT added: "musical instrument" alongside "guitar" — tried
# both together first, but Grounding DINO fragmented the phrase to
# "musical" instead of grounding to the already-present "guitar" for that
# same box (see groundingdino.util.utils.get_phrases_from_posmap — phrase
# construction is a per-token threshold, not phrase-level, so a redundant
# multi-word near-duplicate can out-compete a clean single-word term
# rather than reinforce it). "guitar" alone is the only evidenced case;
# not guessing ahead of the data with a broader catch-all term.
# Not yet re-verified against real detections.
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


_model_cache = None  # loaded lazily, cached at module level — the checkpoint
# is large enough that reloading it per call would dominate latency in both
# the eval harness (called once per image) and the live API.

# backend/ (this file's grandparent) — computed from this file's own location,
# not the process working directory. settings.grounding_dino_*_path default to
# relative strings (e.g. "weights/..."); resolving those against os.getcwd()
# meant launching uvicorn/pytest from the repo root instead of backend/ caused
# a real startup 503 (see tests/system/README.md, 2026-08-11).
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent


def _resolve_backend_path(configured: str) -> Path:
    """Resolves a configured model path against `_BACKEND_ROOT`, independent
    of the process working directory. Absolute paths pass through unchanged
    (still usable as-is, per an explicit override)."""
    path = Path(configured)
    if path.is_absolute():
        return path
    return _BACKEND_ROOT / path


def load_model():
    """
    Loads Grounding DINO from weights/ (see config.grounding_dino_*_path).
    CPU-only (device="cpu") because the local environment has no GPU.
    """
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
    """
    Mirrors groundingdino.util.inference.load_image, but from in-memory bytes
    rather than a file path — the API layer receives an UploadFile, not a
    path on disk, and round-tripping through a temp file just to satisfy the
    upstream helper isn't worth the extra I/O.
    """
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

    # Left normalized to [0, 1] (not scaled to pixel coordinates) — this is
    # resolution-independent, which is what core/box_descriptors.py needs to
    # derive a size/position hint, and is what gets stored in eval results.
    boxes_xyxy = box_ops.box_cxcywh_to_xyxy(boxes)

    return [
        RawDetection(label=phrase, box_xyxy=tuple(box.tolist()), confidence=float(logit))
        for box, logit, phrase in zip(boxes_xyxy, logits, phrases)
    ]
