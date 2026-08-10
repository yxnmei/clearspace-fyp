"""
Batch evaluation harness (§3 step 3): runs the declutter pipeline over
every image in data/test_images/, using evaluation/labels/labels.json as
ground truth, and reports per-stage latency, detection counts, and
classification distribution.

This is infrastructure, built before there's a UI to distract from it —
it exists so §3 step 4 (running every §2 model comparison) has something
to run comparisons *through*, rather than each comparison script
reinventing image-loading and result-aggregation from scratch.

Composes app.services.analysis_service.analyse_image() and
app.services.declutter_service.run_declutter() directly — the same two
functions app/api/routes.py will call once its handlers are implemented
— rather than reimplementing prompt-building, item-number mapping,
decision validation, or recovery here. This script's only job is
image-loading, wiring the real model functions in as the injected
dependencies both services expect, and result-aggregation (§4 principle:
"evaluation scripts call the same services/ functions the API routes
call — one implementation, not two that drift").

Import weight: analyse_image/run_declutter are lightweight, real imports
at module scope (neither imports torch/clip/grounding_dino/ollama at
their own module level — see analysis_service.py/declutter_service.py's
own docstrings). The three actual model callables (CLIP, Grounding DINO,
Ollama) are NOT imported at module scope here — `run_batch()` accepts
them as optional injected parameters and only lazy-imports the real ones
(`_default_scene_classifier`/`_default_detector`/`_default_llm_classifier`
below) if a caller omits them, i.e. only when this script is actually run
for real. `import evaluation.scripts.batch_eval` alone never pulls in
torch/CLIP/Grounding DINO/ollama; unit tests inject fakes and never touch
the lazy-loading branch at all.

Usage:
    python -m evaluation.scripts.batch_eval --labels evaluation/labels/labels.json
    python -m evaluation.scripts.batch_eval --model phi4-mini --label baseline
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from app.logging_utils import new_run_id
from app.services.analysis_service import analyse_image
from app.services.declutter_service import run_declutter
from evaluation.scripts.run_dirs import new_run_dir


def _default_scene_classifier() -> Callable:
    from app.models.clip_scene import classify_scene

    return classify_scene


def _default_detector() -> Callable:
    from app.models.grounding_dino import detect

    return detect


def _default_llm_classifier() -> Callable:
    from app.models.mistral_llm import classify_items

    return classify_items


def load_labels(labels_path: Path) -> list[dict]:
    with labels_path.open(encoding="utf-8") as f:
        return json.load(f)


def run_batch(
    labels: list[dict],
    images_dir: Path,
    model_name: str | None = None,
    scene_classifier: Callable | None = None,
    detector: Callable | None = None,
    llm_classifier: Callable | None = None,
) -> dict:
    """
    scene_classifier/detector/llm_classifier are optional injection
    points — omitted (None), each lazily resolves to the real model
    callable (CLIP / Grounding DINO / classify_items) at this point, not
    at module import time. Unit tests always pass fakes explicitly here;
    only the real CLI path (main(), below) leaves them as None.

    Resolution only happens `if labels` — an empty batch (or a caller
    that already injected every dependency) never imports a real model
    module at all, not even lazily; "genuinely need resolving" is
    literal, not just "later than module import time."
    """
    if labels:
        scene_classifier = scene_classifier or _default_scene_classifier()
        detector = detector or _default_detector()
        llm_classifier = llm_classifier or _default_llm_classifier()

    decision_counts: Counter[str] = Counter()
    per_image_results = []

    for entry in labels:
        image_path = images_dir / entry["filename"]
        if not image_path.exists():
            per_image_results.append(
                {"filename": entry["filename"], "error": "image file not found (gitignored — see §3 step 2)"}
            )
            continue

        run_id = new_run_id()
        image_bytes = image_path.read_bytes()

        # A broad catch here is deliberate, matching this harness's
        # original resilience contract: one image's failure (invalid
        # image, scene/detection error, or a total LLM outage — see
        # analysis_service/declutter_service's own typed exceptions) is
        # recorded and the batch continues, rather than one bad image
        # aborting every image after it.
        try:
            analysis = analyse_image(image_bytes, run_id, scene_classifier, detector)
            result = run_declutter(
                analysis, user_context=None, llm_classifier=llm_classifier, model_name=model_name
            )
        except Exception as exc:
            per_image_results.append(
                {
                    "filename": entry["filename"],
                    "run_id": run_id,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
            continue

        for decision in result.ai_decisions:
            decision_counts[decision.decision.value] += 1

        per_image_results.append(
            {
                "filename": entry["filename"],
                "run_id": run_id,
                "result": result.model_dump(mode="json"),
            }
        )

    total = sum(decision_counts.values())
    distribution = {k: round(v / total, 3) for k, v in decision_counts.items()} if total else {}

    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "n_images": len(labels),
        "decision_distribution": distribution,
        "per_image_results": per_image_results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=Path("evaluation/labels/labels.json"))
    parser.add_argument("--images-dir", type=Path, default=Path("data/test_images"))
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Override the LLM model passed to run_declutter/classify_items "
        "(default: None, which resolves to config.llm_model_name / phi4-mini).",
    )
    parser.add_argument(
        "--label", type=str, default=None,
        help="Short description appended to the run folder name, e.g. --label baseline",
    )
    parser.add_argument("--out-dir", type=Path, default=None, help="Override the run output directory")
    args = parser.parse_args()

    labels = load_labels(args.labels)
    report = run_batch(labels, args.images_dir, model_name=args.model)

    run_dir = args.out_dir or new_run_dir(label=args.label)
    out_path = run_dir / "batch_eval.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report to {out_path}")


if __name__ == "__main__":
    main()
