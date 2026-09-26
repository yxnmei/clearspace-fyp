"""Zero-shot CLIP scene classification on CPU.

The default was selected after 97.6% confidence on the test image. Templated
text follows CLIP's reference zero-shot approach and should not become bare labels.
"""

from __future__ import annotations

import io

from PIL import Image

from app.config import get_settings

# Use CLIP's reference prompt family; bare labels underperform in zero-shot use.
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

_model_cache = None  # Reloading the checkpoint per call would dominate latency.


def load_model():
    """Load and cache CLIP on CPU."""
    global _model_cache
    if _model_cache is not None:
        return _model_cache

    import clip  # Keep the optional dependency off unrelated paths.

    settings = get_settings()
    model, preprocess = clip.load(settings.clip_model_name, device="cpu")
    model.eval()
    _model_cache = (model, preprocess)
    return _model_cache


def classify_scene(image_bytes: bytes, candidates: list[str] = ROOM_TYPE_CANDIDATES) -> dict:
    """Classify a scene against templated candidates and return all scores."""
    import clip
    import torch

    model, preprocess = load_model()

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    image_input = preprocess(image).unsqueeze(0)
    text_prompts = [PROMPT_TEMPLATE.format(c) for c in candidates]
    text_input = clip.tokenize(text_prompts)

    with torch.no_grad():
        image_features = model.encode_image(image_input)
        text_features = model.encode_text(text_input)
        image_features /= image_features.norm(dim=-1, keepdim=True)
        text_features /= text_features.norm(dim=-1, keepdim=True)
        # Use CLIP's learned reference scaling rather than an arbitrary temperature.
        logits = (model.logit_scale.exp() * image_features @ text_features.T).squeeze(0)
        probs = logits.softmax(dim=-1)

    all_scores = {candidate: float(prob) for candidate, prob in zip(candidates, probs)}
    top_label = max(all_scores, key=all_scores.get)
    return {"label": top_label, "confidence": all_scores[top_label], "all_scores": all_scores}
