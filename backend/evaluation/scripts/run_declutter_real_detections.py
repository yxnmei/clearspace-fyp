"""
Real-detection LLM comparison: runs Grounding DINO once per test image (the
detection choice is already evidenced, §2 — no need to re-run it per model),
then calls each candidate in app.models.mistral_llm.COMPARISON_MODELS against
those real, noisy detected items — not the hand-typed ground_truth_items
compare_llm_reasoning.py uses.

This exists because compare_llm_reasoning.py only tests LLM reasoning on
clean, hand-picked labels, which sidesteps exactly the kind of messy input
(duplicate/compound/oddly-worded labels) the LLM will actually see in the
real pipeline. Scene classification is NOT included here — CLIP hasn't been
compared against Places365 yet (§2), so this deliberately uses the
hand-labelled room_type from labels.json rather than building on an
unevidenced choice.

Logs full per-item output (label, decision, reason) per model per image, not
just aggregate stats — for eyeballing what each model actually produces.

Usage:
    python -m evaluation.scripts.run_declutter_real_detections
    python -m evaluation.scripts.run_declutter_real_detections --models phi4-mini --label json-fix-verify
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from app.core.box_descriptors import describe_box
from app.core.label_cleanup import clean_label
from app.logging_utils import new_run_id
from app.models.grounding_dino import detect
from app.models.mistral_llm import COMPARISON_MODELS, classify_items
from evaluation.scripts.run_dirs import new_run_dir


def run(labels: list[dict], images_dir: Path, models: list[str] | None = None) -> dict:
    per_image_results = []

    for entry in labels:
        image_path = images_dir / entry["filename"]
        if not image_path.exists():
            per_image_results.append({"filename": entry["filename"], "error": "image file not found"})
            continue

        image_bytes = image_path.read_bytes()

        # Detection is independent of which LLM is being compared — run it
        # once per image, not once per (image, model) pair.
        raw_detections = detect(image_bytes)
        detected_items = [
            {
                "label": clean_label(rd.label).primary,
                "confidence": rd.confidence,
                "position_hint": describe_box(rd.box_xyxy),
            }
            for rd in raw_detections
        ]

        model_outputs = {}
        for model_name in (models or COMPARISON_MODELS):
            run_id = new_run_id()
            llm_result = classify_items(
                run_id=run_id,
                detected_items=detected_items,
                scene_label=entry["room_type"],
                user_context=None,
                model_name=model_name,
            )
            model_outputs[model_name] = {
                "is_valid_json": llm_result.is_valid_json,
                "items": llm_result.parsed_json,
                "raw_text": llm_result.raw_text,
            }

        per_image_results.append(
            {
                "filename": entry["filename"],
                "room_type": entry["room_type"],
                "n_raw_detections": len(raw_detections),
                "detected_items": detected_items,
                "model_outputs": model_outputs,
            }
        )

    return {"ts": datetime.now(timezone.utc).isoformat(), "results": per_image_results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=Path("evaluation/labels/labels.json"))
    parser.add_argument("--images-dir", type=Path, default=Path("data/test_images"))
    parser.add_argument(
        "--models",
        type=str,
        default=None,
        help="Comma-separated subset of COMPARISON_MODELS to run (default: all 5). "
        'e.g. --models phi4-mini to test just the chosen model.',
    )
    parser.add_argument(
        "--label", type=str, default=None,
        help="Short description appended to the run folder name, e.g. --label json-fix-verify",
    )
    args = parser.parse_args()

    models = args.models.split(",") if args.models else None
    if models:
        unknown = set(models) - set(COMPARISON_MODELS)
        if unknown:
            raise SystemExit(f"Unknown model(s) in --models: {unknown}. Valid: {COMPARISON_MODELS}")

    with args.labels.open(encoding="utf-8") as f:
        labels = json.load(f)

    report = run(labels, args.images_dir, models=models)

    run_dir = new_run_dir(label=args.label)
    out_path = run_dir / "declutter_real_detections.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report to {out_path}")


if __name__ == "__main__":
    main()
