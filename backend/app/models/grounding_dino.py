"""
Object detection: Grounding DINO (chosen, §2 — 21 vs 3 objects detected
against YOLOv8s on the same test image).

YOLOv8s is NOT reimplemented here — that comparison is already evidenced
and done; §2 says don't re-litigate settled comparisons without a specific
reason. If a genuine reason comes up later, put the YOLOv8s path in
evaluation/scripts/, not here, so app/models/ stays "the model actually
used in the shipped pipeline," not a grab-bag of every candidate tried.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.config import get_settings

# Domestic-vocabulary prompt for open-set detection — versioned here so
# changes to it are visible in diffs/blame, not buried in a service call.
DOMESTIC_VOCABULARY_PROMPT = (
    "chair . table . desk . lamp . laptop . monitor . keyboard . mouse . "
    "cable . charger . book . notebook . magazine . document . bottle . cup . "
    "mug . plate . bowl . utensil . box . basket . bag . backpack . clothes . "
    "jacket . shirt . shoe . shelf . drawer . bin . trash can . plant . "
    "picture frame . mirror . clock . remote control . phone . speaker . "
    "printer . fan . heater . pillow . blanket . towel . toy . tool . cord"
)


@dataclass
class RawDetection:
    label: str  # raw model output — may be a compound phrase, see core/label_cleanup.py
    box_xyxy: tuple[float, float, float, float]
    confidence: float


def load_model():
    """
    Loads Grounding DINO from weights/ (see config.grounding_dino_*_path).
    Not implemented yet — §3 step 5, after the §2 comparisons that inform
    box/text threshold tuning are run.
    """
    settings = get_settings()
    config_path = Path(settings.grounding_dino_config_path)
    weights_path = Path(settings.grounding_dino_weights_path)
    raise NotImplementedError(f"Load from {config_path} / {weights_path}")


def detect(image_bytes: bytes, prompt: str = DOMESTIC_VOCABULARY_PROMPT) -> list[RawDetection]:
    """Runs detection, returns raw (uncleaned) labels + boxes + confidence."""
    raise NotImplementedError
