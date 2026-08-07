"""
Batch evaluation harness (§3 step 3): runs the declutter pipeline over
every image in data/test_images/, using evaluation/labels/labels.json as
ground truth, and reports per-stage latency, detection counts, and
classification distribution.

This is infrastructure, built before there's a UI to distract from it —
it exists so §3 step 4 (running every §2 model comparison) has something
to run comparisons *through*, rather than each comparison script
reinventing image-loading and result-aggregation from scratch.

Calls app.services.declutter_service.run_declutter directly — the same
function app/api/routes.py calls — so this harness and the live API can
never silently drift apart (§4 principle).

Usage (once app/models/* are implemented):
    python -m evaluation.scripts.batch_eval --labels evaluation/labels/labels.json

Not runnable yet: declutter_service.run_declutter raises NotImplementedError
until §3 step 5 lands. The structure below is deliberately final — filling
in the model calls should not require reshaping this script.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from app.logging_utils import new_run_id
from app.services.declutter_service import run_declutter
from evaluation.scripts.run_dirs import new_run_dir


def load_labels(labels_path: Path) -> list[dict]:
    with labels_path.open(encoding="utf-8") as f:
        return json.load(f)


def run_batch(labels: list[dict], images_dir: Path) -> dict:
    decision_counts: Counter[str] = Counter()
    per_image_results = []

    for entry in labels:
        image_path = images_dir / entry["filename"]
        if not image_path.exists():
            per_image_results.append({"filename": entry["filename"], "error": "image file not found (gitignored — see §3 step 2)"})
            continue

        run_id = new_run_id()
        image_bytes = image_path.read_bytes()

        try:
            result = run_declutter(run_id=run_id, image_bytes=image_bytes, user_context=None)
        except NotImplementedError as exc:
            per_image_results.append({"filename": entry["filename"], "run_id": run_id, "error": str(exc)})
            continue

        for item in result.get("items", []):
            decision_counts[item["decision"]] += 1

        per_image_results.append({"filename": entry["filename"], "run_id": run_id, "result": result})

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
        "--label", type=str, default=None,
        help="Short description appended to the run folder name, e.g. --label baseline",
    )
    parser.add_argument("--out-dir", type=Path, default=None, help="Override the run output directory")
    args = parser.parse_args()

    labels = load_labels(args.labels)
    report = run_batch(labels, args.images_dir)

    run_dir = args.out_dir or new_run_dir(label=args.label)
    out_path = run_dir / "batch_eval.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report to {out_path}")


if __name__ == "__main__":
    main()
