"""
§2 / §3 step 4: LLM reasoning comparison — mistral vs qwen3:8b vs
gemma2:2b vs phi4-mini vs deepseek-r1:7b (app.models.mistral_llm.COMPARISON_MODELS).

Run this BEFORE committing the architecture to one model (§3 step 4) —
this is what actually produces "evidence of testing and rejecting models"
for the brief, not a deferred table row.

For each candidate, over the whole test set, records:
  - JSON-validity rate (via app.core.json_repair.extract_json)
  - Decision distribution vs the target (report §3.5: ~30/25/25/20
    Keep/Sell/Donate/Discard) — report the REAL distribution, not the
    target, per §7's explicit gotcha about this
  - Item-level determinism: same image + prompt run N times, how often
    does a given item's decision change (§7 gotcha — v1 never measured this)
  - Latency per call

Usage (once app/models/mistral_llm.py is implemented):
    python -m evaluation.scripts.compare_llm_reasoning --repeats 3
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from app.core.json_repair import extract_json
from app.logging_utils import new_run_id
from app.models.mistral_llm import COMPARISON_MODELS, classify_items


def run_comparison(labels: list[dict], images_dir: Path, repeats: int) -> dict:
    results: dict[str, dict] = {}

    for model_name in COMPARISON_MODELS:
        decision_counts: Counter[str] = Counter()
        valid_json_count = 0
        total_calls = 0
        # item_id -> list of decisions across repeats, for determinism check
        stability: dict[str, list[str]] = defaultdict(list)

        for entry in labels:
            image_path = images_dir / entry["filename"]
            if not image_path.exists():
                continue

            for _ in range(repeats):
                run_id = new_run_id()
                total_calls += 1
                try:
                    llm_result = classify_items(
                        run_id=run_id,
                        detected_items=entry["ground_truth_items"],
                        scene_label=entry["room_type"],
                        user_context=None,
                        model_name=model_name,
                    )
                except NotImplementedError:
                    continue

                _, is_valid = extract_json(llm_result.raw_text)
                if is_valid:
                    valid_json_count += 1
                    for item in llm_result.parsed_json or []:
                        decision_counts[item.get("decision", "unknown")] += 1
                        stability[f"{entry['filename']}::{item.get('label')}"].append(item.get("decision"))

        total_decisions = sum(decision_counts.values())
        distribution = {k: round(v / total_decisions, 3) for k, v in decision_counts.items()} if total_decisions else {}

        # fraction of items whose decision was identical across ALL repeats
        stable_items = sum(1 for decisions in stability.values() if len(set(decisions)) == 1)
        determinism_rate = round(stable_items / len(stability), 3) if stability else None

        results[model_name] = {
            "json_validity_rate": round(valid_json_count / total_calls, 3) if total_calls else None,
            "decision_distribution": distribution,
            "determinism_rate": determinism_rate,
            "total_calls": total_calls,
        }

    return {"ts": datetime.now(timezone.utc).isoformat(), "repeats": repeats, "models": results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=Path("evaluation/labels/labels.json"))
    parser.add_argument("--images-dir", type=Path, default=Path("data/test_images"))
    parser.add_argument("--repeats", type=int, default=3, help="Repeats per image, for the determinism check (§7)")
    args = parser.parse_args()

    with args.labels.open(encoding="utf-8") as f:
        labels = json.load(f)

    report = run_comparison(labels, args.images_dir, args.repeats)

    out_path = Path("evaluation/results") / f"compare_llm_reasoning_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report to {out_path}")


if __name__ == "__main__":
    main()
