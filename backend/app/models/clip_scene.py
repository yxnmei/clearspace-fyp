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

import io

from PIL import Image

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

_model_cache = None  # (model, preprocess) tuple, loaded lazily and cached at
# module level — same reasoning as grounding_dino.load_model: reloading the
# checkpoint per call would dominate latency in both the eval harness and
# the live API.


def load_model():
    """
    Loads CLIP (device="cpu" — no local GPU, per §5/DEVLOG environment
    check). The `clip` package has no PyPI release — installed via
    `pip install git+https://github.com/openai/CLIP.git`, see README.
    """
    global _model_cache
    if _model_cache is not None:
        return _model_cache

    import clip  # deferred import — mirrors grounding_dino's pattern so a
    # missing optional dependency only breaks the code path that needs it

    settings = get_settings()
    model, preprocess = clip.load(settings.clip_model_name, device="cpu")
    model.eval()
    _model_cache = (model, preprocess)
    return _model_cache


def classify_scene(image_bytes: bytes, candidates: list[str] = ROOM_TYPE_CANDIDATES) -> dict:
    """
    Returns {"label": str, "confidence": float, "all_scores": dict[str, float]}.
    All scores are returned, not just the top-1 — needed for the §8
    per-stage evaluation (confidence distribution, not just pass/fail).

    Zero-shot: no room-type-specific training, just cosine similarity
    between the image embedding and each candidate's *templated* text
    embedding (§7 — never a bare label, see PROMPT_TEMPLATE above),
    softmax-normalized across candidates into a probability distribution.
    """
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
        # CLIP's own reference scaling (logit_scale, learned at pretraining
        # time) before softmax — matches the official zero-shot recipe
        # rather than an arbitrary temperature.
        logits = (model.logit_scale.exp() * image_features @ text_features.T).squeeze(0)
        probs = logits.softmax(dim=-1)

    all_scores = {candidate: float(prob) for candidate, prob in zip(candidates, probs)}
    top_label = max(all_scores, key=all_scores.get)
    return {"label": top_label, "confidence": all_scores[top_label], "all_scores": all_scores}
