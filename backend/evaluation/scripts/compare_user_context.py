"""
§8 follow-up named 2026-08-05: every LLM-reasoning comparison so far ran
with `user_context=None` — an explicitly-flagged zero-context floor, not
a production estimate. This script tests whether real user_context
actually shifts the keep/donate skew found that day, before committing to
building a bigger structured-profiling feature on an untested assumption
(see DEVLOG.md 2026-08-08).

Fixed model (the chosen candidate, phi4-mini by default — override with
--model), varying only `user_context`, against the same hand-typed
ground_truth_items used in compare_llm_reasoning.py (not real noisy
detections) — deliberately, so any shift in the numbers is attributable
to context alone, not conflated with detection noise.

Edit CONTEXT_VARIANTS below to add/change the strings being tested.

Usage:
    python -m evaluation.scripts.compare_user_context
    python -m evaluation.scripts.compare_user_context --model phi4-mini --label context-test
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from app.logging_utils import new_run_id
from app.models.mistral_llm import classify_items
from evaluation.scripts.compare_llm_reasoning import compute_majority_class_baseline
from evaluation.scripts.run_dirs import new_run_dir

# Edit here to add/change what's being tested. `None` reproduces the
# existing 2026-08-05 zero-context baseline exactly, so it's always
# included first as the point of comparison — don't remove it.
#
# 2026-08-08 follow-up (see DEVLOG.md same date): the first pass showed
# aggressive context helped (sell 0.125->0.625, discard 0.375->0.417) but
# conservative didn't (sell fell to 0.0). Two confounds were never
# isolated: (1) direction — sell/discard-leaning vs keep-leaning intent,
# and (2) phrasing structure — aggressive was a direct "lean toward X"
# instruction, conservative was an "only flag as X if Y" hedge/gate. The
# two new variants below hold phrasing structure constant across
# direction, so a shift can be attributed to one confound and not both:
# "conservative-decisive" keeps conservative's keep-leaning intent but
# rephrased as a direct instruction (no "only if" gating), matching
# aggressive's structure; "moderate" is a direction-neutral decisive
# baseline (asks for a confident per-item call, no lean either way) to
# see where a no-direction-but-still-decisive framing lands relative to
# the directional variants and the zero-context baseline.
CONTEXT_VARIANTS: dict[str, str | None] = {
    "none (2026-08-05 baseline)": None,
    "aggressive": (
        "I'm moving in 2 weeks and need to downsize significantly. "
        "Please be ruthless — if something isn't essential or frequently "
        "used, lean toward selling or discarding it rather than keeping it."
    ),
    "conservative": (
        "I'm quite sentimental about my belongings. Please only flag "
        "something as discard if it's clearly broken or worn out, and "
        "only suggest selling or donating items I've genuinely not used "
        "in a long time."
    ),
    "conservative-decisive": (
        "I'm quite sentimental about my belongings and want to hold onto "
        "most of them. Please lean toward keeping items rather than "
        "selling or discarding them — but still make a clear, confident "
        "individual call for each one rather than defaulting to keep out "
        "of caution."
    ),
    "moderate": (
        "I'd like a general decluttering pass on this room. Please make a "
        "clear, confident keep/sell/donate/discard call for each item "
        "based on its own merits, without leaning toward any particular "
        "outcome."
    ),
}


def run_comparison(labels: list[dict], model_name: str, variants: dict[str, str | None]) -> dict:
    results: dict[str, dict] = {}
    majority_class_baseline = compute_majority_class_baseline(labels)

    for variant_name, context_string in variants.items():
        decision_counts: Counter[str] = Counter()
        valid_json_count = 0
        total_calls = 0
        agreement_matches = 0
        agreement_total = 0
        per_class_actual: dict[str, Counter] = defaultdict(Counter)
        latencies_s: list[float] = []

        for entry in labels:
            expected_by_label = {
                item["label"].strip().lower(): item["expected_decision"].strip().lower()
                for item in entry["ground_truth_items"]
            }

            run_id = new_run_id()
            total_calls += 1
            started = time.perf_counter()
            llm_result = classify_items(
                run_id=run_id,
                detected_items=entry["ground_truth_items"],
                scene_label=entry["room_type"],
                user_context=context_string,
                model_name=model_name,
            )
            latencies_s.append(time.perf_counter() - started)

            if not llm_result.is_valid_json:
                continue
            valid_json_count += 1
            items = llm_result.parsed_json
            if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
                continue

            for item in items:
                decision = str(item.get("decision", "unknown")).strip().lower()
                decision_counts[decision] += 1
                returned_label = str(item.get("label", "")).strip().lower()
                expected_decision = expected_by_label.get(returned_label)
                if expected_decision is not None:
                    agreement_total += 1
                    per_class_actual[expected_decision][decision] += 1
                    if decision == expected_decision:
                        agreement_matches += 1

        total_decisions = sum(decision_counts.values())
        distribution = {k: round(v / total_decisions, 3) for k, v in decision_counts.items()} if total_decisions else {}

        class_breakdown = {}
        for expected_class, actual_counter in per_class_actual.items():
            class_total = sum(actual_counter.values())
            class_breakdown[expected_class] = {
                "n": class_total,
                "agreement_rate": round(actual_counter.get(expected_class, 0) / class_total, 3) if class_total else None,
                "actual_decision_distribution": {k: round(v / class_total, 3) for k, v in actual_counter.items()},
            }

        results[variant_name] = {
            "context_string": context_string,
            "json_validity_rate": round(valid_json_count / total_calls, 3) if total_calls else None,
            "decision_distribution": distribution,
            "ground_truth_agreement_rate": round(agreement_matches / agreement_total, 3) if agreement_total else None,
            "per_decision_class_breakdown": class_breakdown,
            "avg_latency_s_per_image": round(sum(latencies_s) / len(latencies_s), 2) if latencies_s else None,
        }

    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "model": model_name,
        "majority_class_baseline": majority_class_baseline,
        "variants": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, default=Path("evaluation/labels/labels.json"))
    parser.add_argument("--model", type=str, default="phi4-mini", help="The §2 chosen model — deliberately not config.llm_model_name's own default, which is \"mistral\" (see that setting's own comment: intended to always be overridden per-run, not relied on bare)")
    parser.add_argument(
        "--label", type=str, default=None,
        help="Short description appended to the run folder name, e.g. --label context-test",
    )
    parser.add_argument(
        "--variants", type=str, default=None,
        help="Comma-separated subset of CONTEXT_VARIANTS keys to run (e.g. "
             "--variants \"conservative-decisive,moderate\"), so a follow-up "
             "run doesn't have to re-run already-known variants. Default: all.",
    )
    args = parser.parse_args()
    model_name = args.model

    with args.labels.open(encoding="utf-8") as f:
        labels = json.load(f)

    if args.variants:
        requested = [name.strip() for name in args.variants.split(",")]
        unknown = [name for name in requested if name not in CONTEXT_VARIANTS]
        if unknown:
            known = ", ".join(repr(k) for k in CONTEXT_VARIANTS)
            raise SystemExit(f"Unknown --variants entries {unknown}. Known: {known}")
        variants = {name: CONTEXT_VARIANTS[name] for name in requested}
    else:
        variants = CONTEXT_VARIANTS

    report = run_comparison(labels, model_name, variants)

    run_dir = new_run_dir(label=args.label)
    out_path = run_dir / "compare_user_context.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report to {out_path}")
    for variant_name, r in report["variants"].items():
        print(f"  {variant_name:30s} agreement={r['ground_truth_agreement_rate']}  "
              f"distribution={r['decision_distribution']}")


if __name__ == "__main__":
    main()
