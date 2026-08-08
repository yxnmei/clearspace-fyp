"""
§2 / §3 step 4: CLIP zero-shot vs Places365 vs a local vision-language
model — marked "run early this time" in §2 (deferred in v1, never
actually done).

Three genuinely different hypotheses, not just size variants of each
other: CLIP is contrastive zero-shot (image/text embeddings scored
against fixed candidates); Places365 is a supervised closed-set
classifier trained end-to-end on exactly this task; the VLM is
open-ended multimodal generation, asked directly for a room type rather
than scored against anything. Added 2026-08-08 alongside finishing the
CLIP/Places365 pair, not as a separate later task.

Places365 has no PyPI package: this script documents the exact download
step here (not hidden in a README elsewhere) so re-running the comparison
later doesn't require re-deriving where the checkpoint came from.

Reference checkpoint + category file (as used by the original Places365
authors' PyTorch demo):
  wget http://places2.csail.mit.edu/models_places365/resnet18_places365.pth.tar
  wget https://raw.githubusercontent.com/csailvision/places365/master/categories_places365.txt
Save both under backend/weights/places365/ (gitignored, like all weights/).

The VLM candidate needs a vision-capable Ollama model pulled first —
default is `moondream` (~1.8B params), chosen deliberately over larger
options like `llava` for the same CPU-only reason every other model
choice in this project was: no local GPU, and this project already found
out the hard way (§2 LLM comparison) that a 7B+ model's latency can be
disqualifying for anything interactive.
  ollama pull moondream

Usage (once app/models/clip_scene.py is implemented, the Places365
checkpoint downloaded per above, and moondream pulled):
    python -m evaluation.scripts.compare_scene_classifiers
    python -m evaluation.scripts.compare_scene_classifiers --skip-vlm  # CLIP + Places365 only
"""

from __future__ import annotations

import argparse
import io
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

from app.config import get_settings
from app.models.clip_scene import ROOM_TYPE_CANDIDATES, classify_scene
from evaluation.scripts.run_dirs import new_run_dir

# Places365's 365 categories are far finer-grained than our 10
# ROOM_TYPE_CANDIDATES (no "home office desk" or "wardrobe / closet" in its
# native vocabulary) — a raw top-1 category name can't be compared directly
# against labels.json's room_type without translation. This is a best-effort
# mapping from a subset of Places365's category names (as documented in the
# public categories_places365.txt) to our candidate space; category names
# not covered here are reported as unmapped rather than force-matched, since
# a wrong silent mapping would be worse than an honest "doesn't map".
# Verified against the real downloaded categories file 2026-08-08 — all
# keys below confirmed present, no collisions after the parsing fix in
# load_places365_categories().
PLACES365_TO_ROOM_TYPE = {
    "bedroom": "bedroom",
    # Added 2026-08-08, after the 8-image run: both are genuine bedroom
    # subtypes in Places365's own taxonomy, not a different room type —
    # a nursery/dorm room IS a bedroom, just described more specifically
    # than our 10-category list distinguishes. Confirmed against real
    # results: bedroom02 -> "nursery" (18%), bedroom05 -> "dorm_room"
    # (73.6%, high confidence) were both counted as wrong under the old
    # mapping despite being correct in substance.
    "nursery": "bedroom",
    "dorm_room": "bedroom",
    "kitchen": "kitchen",
    "living_room": "living room",
    "home_office": "home office desk",
    "office": "home office desk",
    "closet": "wardrobe / closet",
    "bathroom": "bathroom",
    "storage_room": "storage room",
    "garage_indoor": "garage",
    "dining_room": "dining room",
    "corridor": "hallway",
    # Deliberately NOT mapped: "waiting_room" (bedroom04's real Places365
    # top-1 competitor "dorm_room" already covers that case; livingroom01's
    # actual top-1 was "waiting_room" over "living_room" by a narrow
    # margin — that's a genuine near-miss, not a taxonomy technicality,
    # and mapping it would inflate the score rather than correct a gap).
}


def load_places365_categories(categories_path: Path) -> list[str]:
    """
    Parses e.g. "/b/bathroom 45" -> "bathroom" and "/g/garage/indoor 156"
    -> "garage_indoor". Not just the last path segment (found and fixed:
    75 of 365 categories have a 3rd path segment — "/g/garage/indoor" and
    "/p/parking_garage/indoor" both end in "indoor", so taking only the
    last segment collapses genuinely different categories onto the same
    name; keeping everything after the single-letter alphabetical bucket
    prefix, joined with "_", keeps them distinct).
    """
    if not categories_path.exists():
        raise FileNotFoundError(
            f"{categories_path} not found — download it per this script's module docstring first."
        )
    categories = []
    with categories_path.open(encoding="utf-8") as f:
        for line in f:
            path_parts = line.split(" ")[0].lstrip("/").split("/")
            categories.append("_".join(path_parts[1:]))  # drop the single-letter bucket, e.g. "g", "b"
    return categories


_places_model_cache = None  # (model, categories) tuple — same lazy-load-once
# pattern as every other model wrapper in this project (grounding_dino,
# clip_scene). Kept in this eval script, not app/models/, since Places365
# is a comparison candidate only — see module docstring.


def _load_places365_model(weights_path: Path, categories: list[str]):
    global _places_model_cache
    if _places_model_cache is not None:
        return _places_model_cache

    import torch
    import torchvision.models as tv_models

    if not weights_path.exists():
        raise FileNotFoundError(f"{weights_path} not found — download it per this script's module docstring first.")

    model = tv_models.resnet18(num_classes=len(categories))
    checkpoint = torch.load(weights_path, map_location="cpu")
    # The reference checkpoint was saved from a DataParallel-wrapped model —
    # state dict keys carry a "module." prefix that a plain (non-parallel)
    # model doesn't expect.
    state_dict = {k.replace("module.", "", 1): v for k, v in checkpoint["state_dict"].items()}
    model.load_state_dict(state_dict)
    model.eval()

    _places_model_cache = model
    return model


def classify_places365(image_bytes: bytes, weights_path: Path, categories: list[str]) -> dict:
    """
    Returns {"label": str, "confidence": float, "top5": [[label, score], ...],
    "mapped_room_type": str | None}. `mapped_room_type` is None when the
    top-1 Places365 category has no entry in PLACES365_TO_ROOM_TYPE — that's
    a real, reportable outcome (category mismatch), not an error.
    """
    import torch
    import torchvision.transforms as T

    model = _load_places365_model(weights_path, categories)

    # Standard Places365 reference preprocessing (the authors' own PyTorch
    # demo) — deliberately not reusing grounding_dino's transform, different
    # model family with its own expected input pipeline.
    transform = T.Compose(
        [
            T.Resize((256, 256)),
            T.CenterCrop(224),
            T.ToTensor(),
            T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ]
    )
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    image_input = transform(image).unsqueeze(0)

    with torch.no_grad():
        logits = model(image_input).squeeze(0)
        probs = logits.softmax(dim=-1)

    top5_probs, top5_idx = probs.topk(5)
    top5 = [[categories[i], float(p)] for p, i in zip(top5_probs, top5_idx)]
    top_label, top_confidence = top5[0]

    return {
        "label": top_label,
        "confidence": top_confidence,
        "top5": top5,
        "mapped_room_type": PLACES365_TO_ROOM_TYPE.get(top_label),
    }


def classify_scene_vlm(image_bytes: bytes, candidates: list[str], model_name: str = "moondream") -> dict:
    """
    A genuinely different hypothesis from CLIP/Places365 (see module
    docstring): open-ended multimodal generation via a local Ollama VLM,
    asked directly for a room type, rather than an image scored against
    fixed candidate embeddings/classes. Deliberately prompted to answer
    with exactly one of our candidate strings — still free-text
    generation underneath, so the response can fail to parse cleanly,
    which is itself a reportable outcome (see "parseable" below), not an
    error to hide.

    Returns {"label": str | None, "raw_text": str, "latency_s": float}.
    No `confidence` field — unlike CLIP/Places365's softmax scores, a VLM's
    free-text answer has no natural calibrated probability to report; not
    inventing one.
    """
    import time

    import ollama

    settings = get_settings()
    client = ollama.Client(host=settings.ollama_host)

    prompt = (
        "What type of room is shown in this image? Respond with exactly "
        "one of the following words/phrases, and nothing else: "
        + ", ".join(candidates)
    )

    started = time.perf_counter()
    response = client.chat(
        model=model_name,
        messages=[{"role": "user", "content": prompt, "images": [image_bytes]}],
        options={"temperature": 0.0},  # classification, not creative generation
    )
    latency_s = time.perf_counter() - started
    raw_text = response["message"]["content"].strip()

    # Case-insensitive substring match against our candidates, in
    # declared order — a VLM asked to "respond with exactly one of..."
    # still tends to wrap the answer in a short sentence sometimes, so an
    # exact-equality check would under-count correct answers that are
    # merely not bare.
    normalized = raw_text.lower()
    matched = next((c for c in candidates if c.lower() in normalized), None)

    return {"label": matched, "raw_text": raw_text, "latency_s": round(latency_s, 2)}


def run_comparison(
    labels: list[dict],
    images_dir: Path,
    places_weights: Path,
    places_categories: Path,
    vlm_model: str | None = "moondream",
) -> dict:
    categories = load_places365_categories(places_categories)
    rows = []
    vlm_error: str | None = None

    for entry in labels:
        image_path = images_dir / entry["filename"]
        if not image_path.exists():
            continue
        image_bytes = image_path.read_bytes()

        clip_result = classify_scene(image_bytes)
        places_result = classify_places365(image_bytes, places_weights, categories)

        row = {
            "filename": entry["filename"],
            "expected_room_type": entry["room_type"],
            "clip": clip_result,
            "clip_correct": clip_result["label"] == entry["room_type"],
            "places365": places_result,
            "places365_correct": places_result["mapped_room_type"] == entry["room_type"],
        }

        if vlm_model and vlm_error is None:
            try:
                vlm_result = classify_scene_vlm(image_bytes, ROOM_TYPE_CANDIDATES, model_name=vlm_model)
            except Exception as exc:  # noqa: BLE001 — a missing/unpulled model shouldn't crash CLIP/Places365's results
                vlm_error = f"{type(exc).__name__}: {exc}"
                vlm_result = None
            if vlm_result is not None:
                row["vlm"] = vlm_result
                row["vlm_correct"] = vlm_result["label"] == entry["room_type"]

        rows.append(row)

    n = len(rows)
    clip_accuracy = round(sum(r["clip_correct"] for r in rows) / n, 3) if n else None
    places_accuracy = round(sum(r["places365_correct"] for r in rows) / n, 3) if n else None
    places_unmapped = sum(1 for r in rows if r["places365"]["mapped_room_type"] is None)

    vlm_rows = [r for r in rows if "vlm" in r]
    vlm_accuracy = round(sum(r["vlm_correct"] for r in vlm_rows) / len(vlm_rows), 3) if vlm_rows else None
    vlm_unparseable = sum(1 for r in vlm_rows if r["vlm"]["label"] is None)
    vlm_avg_latency_s = round(sum(r["vlm"]["latency_s"] for r in vlm_rows) / len(vlm_rows), 2) if vlm_rows else None

    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "n_images": n,
        "clip_accuracy": clip_accuracy,
        "places365_accuracy": places_accuracy,
        # A high places365_accuracy alongside a high unmapped count would be
        # misleading (accuracy computed only over the subset that mapped at
        # all) — surfaced explicitly rather than left to be discovered later.
        "places365_unmapped_count": places_unmapped,
        "vlm_model": vlm_model if vlm_rows else None,
        "vlm_accuracy": vlm_accuracy,
        "vlm_unparseable_count": vlm_unparseable,
        "vlm_avg_latency_s": vlm_avg_latency_s,
        "vlm_error": vlm_error,  # non-null means the VLM was skipped after this error (e.g. model not pulled)
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=Path("evaluation/labels/labels.json"))
    parser.add_argument("--images-dir", type=Path, default=Path("data/test_images"))
    parser.add_argument("--places-weights", type=Path, default=Path("weights/places365/resnet18_places365.pth.tar"))
    parser.add_argument("--places-categories", type=Path, default=Path("weights/places365/categories_places365.txt"))
    parser.add_argument("--vlm-model", type=str, default="moondream", help="Ollama vision model to compare, e.g. moondream, llava")
    parser.add_argument("--skip-vlm", action="store_true", help="Run CLIP + Places365 only")
    parser.add_argument(
        "--label", type=str, default=None,
        help="Short description appended to the run folder name, e.g. --label baseline",
    )
    args = parser.parse_args()

    with args.labels.open(encoding="utf-8") as f:
        labels = json.load(f)

    vlm_model = None if args.skip_vlm else args.vlm_model
    report = run_comparison(labels, args.images_dir, args.places_weights, args.places_categories, vlm_model=vlm_model)

    run_dir = new_run_dir(label=args.label)
    out_path = run_dir / "compare_scene_classifiers.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report to {out_path}")
    print(f"CLIP accuracy: {report['clip_accuracy']}  |  Places365 accuracy: {report['places365_accuracy']}"
          f"  ({report['places365_unmapped_count']}/{report['n_images']} unmapped)")
    if report["vlm_error"]:
        print(f"VLM ({vlm_model}) skipped after an error: {report['vlm_error']}")
    elif report["vlm_accuracy"] is not None:
        print(f"VLM ({vlm_model}) accuracy: {report['vlm_accuracy']}"
              f"  ({report['vlm_unparseable_count']} unparseable, avg {report['vlm_avg_latency_s']}s/image)")


if __name__ == "__main__":
    main()
