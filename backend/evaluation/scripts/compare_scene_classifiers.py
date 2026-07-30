"""
§2 / §3 step 4: CLIP zero-shot vs Places365 — marked "run early this time"
in §2 (deferred in v1, never actually done).

Places365 has no PyPI package: this script documents the exact download
step here (not hidden in a README elsewhere) so re-running the comparison
later doesn't require re-deriving where the checkpoint came from.

Reference checkpoint + category file (as used by the original Places365
authors' PyTorch demo):
  wget http://places2.csail.mit.edu/models_places365/resnet18_places365.pth.tar
  wget https://raw.githubusercontent.com/csailvision/places365/master/categories_places365.txt
Save both under backend/weights/places365/ (gitignored, like all weights/).

Usage (once app/models/clip_scene.py is implemented and the Places365
checkpoint has been downloaded per above):
    python -m evaluation.scripts.compare_scene_classifiers
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from app.models.clip_scene import classify_scene


def load_places365_categories(categories_path: Path) -> list[str]:
    if not categories_path.exists():
        raise FileNotFoundError(
            f"{categories_path} not found — download it per this script's module docstring first."
        )
    with categories_path.open(encoding="utf-8") as f:
        return [line.split(" ")[0].lstrip("/").split("/")[-1] for line in f]


def classify_places365(image_bytes: bytes, weights_path: Path, categories: list[str]) -> dict:
    """Not implemented yet — needs the downloaded checkpoint (see module docstring)."""
    raise NotImplementedError(f"Load Places365 ResNet18 from {weights_path}")


def run_comparison(labels: list[dict], images_dir: Path, places_weights: Path, places_categories: Path) -> dict:
    categories = load_places365_categories(places_categories)
    rows = []

    for entry in labels:
        image_path = images_dir / entry["filename"]
        if not image_path.exists():
            continue
        image_bytes = image_path.read_bytes()

        clip_result = classify_scene(image_bytes)
        places_result = classify_places365(image_bytes, places_weights, categories)

        rows.append(
            {
                "filename": entry["filename"],
                "expected_room_type": entry["room_type"],
                "clip": clip_result,
                "places365": places_result,
            }
        )

    return {"ts": datetime.now(timezone.utc).isoformat(), "rows": rows}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=Path("evaluation/labels/labels.json"))
    parser.add_argument("--images-dir", type=Path, default=Path("data/test_images"))
    parser.add_argument("--places-weights", type=Path, default=Path("weights/places365/resnet18_places365.pth.tar"))
    parser.add_argument("--places-categories", type=Path, default=Path("weights/places365/categories_places365.txt"))
    args = parser.parse_args()

    with args.labels.open(encoding="utf-8") as f:
        labels = json.load(f)

    report = run_comparison(labels, args.images_dir, args.places_weights, args.places_categories)

    out_path = Path("evaluation/results") / f"compare_scene_classifiers_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report to {out_path}")


if __name__ == "__main__":
    main()
