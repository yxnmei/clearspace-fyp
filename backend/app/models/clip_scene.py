"""
Scene classification: CLIP zero-shot (chosen, §2 — 97.6% confidence on the
test image; Places365 comparison marked "run early this time" in §2, not
yet done — see evaluation/scripts/compare_scene_classifiers.py).

§7 gotcha, fixed from day one here rather than discovered later: CLIP
zero-shot accuracy improves with templated prompts. Feed the template
below, never a bare label — this was identified but never implemented
in the v1 build.
"""

from __future__ import annotations

from app.config import get_settings

# §7: template, not bare labels — "a photo of a {}" is CLIP's own reference
# template family from Radford et al. (2021); a bare label measurably
# underperforms it in zero-shot settings.
PROMPT_TEMPLATE = "a photo of a {}"

ROOM_TYPE_CANDIDATES = [
    "bedroom",
    "kitchen",
    "living room",
    "home office desk",
    "wardrobe / closet",
    "bathroom",
    "storage room",
    "garage",
    "dining room",
    "hallway",
]


def load_model():
    settings = get_settings()
    raise NotImplementedError(f"Load CLIP {settings.clip_model_name} — see requirements.txt for install note")


def classify_scene(image_bytes: bytes, candidates: list[str] = ROOM_TYPE_CANDIDATES) -> dict:
    """
    Returns {"label": str, "confidence": float, "all_scores": dict[str, float]}.
    All scores are returned, not just the top-1 — needed for the §8
    per-stage evaluation (confidence distribution, not just pass/fail).
    """
    raise NotImplementedError
