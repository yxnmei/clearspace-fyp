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
  - Ground-truth agreement (§8): fraction of items where the model's
    decision matches evaluation/labels/labels.json's expected_decision —
    matched by label text, since that's the only shared key between the
    model's output and the ground truth. Note (per labels/README.md):
    expected_decision is one person's judgement call at labelling time,
    not an objective answer key — treat this as "agreement with the
    labeller," not "accuracy" in the strict sense.
  - Majority-class baseline: what a trivial "always guess the most common
    ground-truth decision" model would score on ground_truth_agreement_rate.
    Ground truth here is 78.9% "keep" — a model barely beating this baseline
    isn't demonstrating real per-item reasoning, just leaning on the same
    skew a lazy guess would exploit.
  - Per-decision-class breakdown: ground_truth_agreement_rate collapsed to
    one number can't distinguish "gets everything right" from "always says
    keep, which happens to be right most of the time" — this reports
    agreement and the model's actual decision spread, per expected class.
  - Latency per image (wall-clock around classify_items(), which may issue
    several chunked LLM calls per image — see mistral_llm.classify_items)

Usage:
    python -m evaluation.scripts.compare_llm_reasoning --repeats 3
    python -m evaluation.scripts.compare_llm_reasoning --repeats 1 --label prompt-v2
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from app.logging_utils import new_run_id
from app.models.mistral_llm import COMPARISON_MODELS, classify_items
from evaluation.scripts.run_dirs import new_run_dir


def compute_majority_class_baseline(labels: list[dict]) -> dict:
    """
    The accuracy a trivial "always guess the most common ground-truth
    decision" model would get on ground_truth_agreement_rate — computed once
    from labels.json, not per model, since it's a property of the ground
    truth's class balance, not of any candidate.
    """
    counts: Counter[str] = Counter()
    for entry in labels:
        for item in entry["ground_truth_items"]:
            counts[item["expected_decision"].strip().lower()] += 1

    total = sum(counts.values())
    if not total:
        return {"majority_class": None, "rate": None}

    majority_class, majority_n = counts.most_common(1)[0]
    return {
        "majority_class": majority_class,
        "rate": round(majority_n / total, 3),
        "class_distribution": {k: round(v / total, 3) for k, v in counts.items()},
    }


def run_comparison(labels: list[dict], images_dir: Path, repeats: int, out_path: Path | None = None) -> dict:
    """
    out_path, if given, gets the report written to it after EVERY model
    finishes, not just once at the end — this run can take hours; without
    incremental saves, a crash on e.g. the 4th of 5 models would lose
    everything, including the 3 models that already finished cleanly.
    """
    results: dict[str, dict] = {}
    majority_class_baseline = compute_majority_class_baseline(labels)

    def _save(status: str) -> None:
        if out_path is None:
            return
        report = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "repeats": repeats,
            "majority_class_baseline": majority_class_baseline,
            "models": results,
        }
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    for model_name in COMPARISON_MODELS:
        decision_counts: Counter[str] = Counter()
        valid_json_count = 0
        # valid JSON but not the requested "array of {label, decision, reason}"
        # shape (e.g. a model wraps items in an object instead) — a distinct,
        # worth-reporting failure mode, not something to silently miscount or crash on
        wrong_shape_count = 0
        total_calls = 0
        # item_id -> list of decisions across repeats, for determinism check
        stability: dict[str, list[str]] = defaultdict(list)
        agreement_matches = 0
        agreement_total = 0
        unmatched_label_count = 0
        # expected_decision -> Counter(actual decision given) — the per-class
        # breakdown; e.g. per_class_actual["donate"] shows what the model
        # actually said for every item a human expected to be donated
        per_class_actual: dict[str, Counter] = defaultdict(Counter)
        latencies_s: list[float] = []

        for entry in labels:
            image_path = images_dir / entry["filename"]
            if not image_path.exists():
                continue

            # label -> expected_decision, for the ground-truth agreement check below
            expected_by_label = {
                item["label"].strip().lower(): item["expected_decision"].strip().lower()
                for item in entry["ground_truth_items"]
            }

            for _ in range(repeats):
                run_id = new_run_id()
                total_calls += 1
                started = time.perf_counter()
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
                latencies_s.append(time.perf_counter() - started)

                # Uses classify_items()'s own validity/shape verdict directly,
                # rather than re-parsing raw_text — raw_text can now be a
                # multi-chunk join (see mistral_llm.classify_items), which a
                # naive re-parse would misread as invalid even when every
                # chunk actually succeeded.
                if llm_result.is_valid_json:
                    valid_json_count += 1
                    items = llm_result.parsed_json
                    if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
                        wrong_shape_count += 1
                        continue
                    for item in items:
                        decision = str(item.get("decision", "unknown")).strip().lower()
                        decision_counts[decision] += 1
                        stability[f"{entry['filename']}::{item.get('label')}"].append(decision)

                        returned_label = str(item.get("label", "")).strip().lower()
                        expected_decision = expected_by_label.get(returned_label)
                        if expected_decision is None:
                            unmatched_label_count += 1
                        else:
                            agreement_total += 1
                            per_class_actual[expected_decision][decision] += 1
                            if decision == expected_decision:
                                agreement_matches += 1

        total_decisions = sum(decision_counts.values())
        distribution = {k: round(v / total_decisions, 3) for k, v in decision_counts.items()} if total_decisions else {}

        # fraction of items whose decision was identical across ALL repeats
        stable_items = sum(1 for decisions in stability.values() if len(set(decisions)) == 1)
        determinism_rate = round(stable_items / len(stability), 3) if stability else None

        class_breakdown = {}
        for expected_class, actual_counter in per_class_actual.items():
            class_total = sum(actual_counter.values())
            class_breakdown[expected_class] = {
                "n": class_total,
                "agreement_rate": round(actual_counter.get(expected_class, 0) / class_total, 3) if class_total else None,
                "actual_decision_distribution": {k: round(v / class_total, 3) for k, v in actual_counter.items()},
            }

        results[model_name] = {
            "json_validity_rate": round(valid_json_count / total_calls, 3) if total_calls else None,
            "wrong_shape_rate": round(wrong_shape_count / total_calls, 3) if total_calls else None,
            "decision_distribution": distribution,
            "determinism_rate": determinism_rate,
            "ground_truth_agreement_rate": round(agreement_matches / agreement_total, 3) if agreement_total else None,
            "per_decision_class_breakdown": class_breakdown,
            # items the model returned with a label that didn't match any ground-truth
            # label (paraphrased, invented, or dropped) — excluded from the agreement
            # rate above since there's nothing to compare against; reported separately
            # so a high agreement rate can't hide a model that's quietly not
            # classifying the items it was actually given
            "unmatched_label_count": unmatched_label_count,
            "avg_latency_s_per_image": round(sum(latencies_s) / len(latencies_s), 2) if latencies_s else None,
            "total_calls": total_calls,
        }

        # Saved after every model, not just at the end — see _save()'s docstring note above.
        is_last_model = model_name == COMPARISON_MODELS[-1]
        _save(status="complete" if is_last_model else f"in_progress (completed through {model_name})")

    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "status": "complete",
        "repeats": repeats,
        "majority_class_baseline": majority_class_baseline,
        "models": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=Path("evaluation/labels/labels.json"))
    parser.add_argument("--images-dir", type=Path, default=Path("data/test_images"))
    parser.add_argument("--repeats", type=int, default=3, help="Repeats per image, for the determinism check (§7)")
    parser.add_argument(
        "--label", type=str, default=None,
        help="Short description appended to the run folder name, e.g. --label prompt-v2",
    )
    args = parser.parse_args()

    with args.labels.open(encoding="utf-8") as f:
        labels = json.load(f)

    run_dir = new_run_dir(label=args.label)
    out_path = run_dir / "compare_llm_reasoning.json"
    print(f"Writing incrementally to {out_path} after each model completes...")

    run_comparison(labels, args.images_dir, args.repeats, out_path=out_path)

    print(f"Done. Final report at {out_path}")


if __name__ == "__main__":
    main()
