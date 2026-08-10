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
    does a given GROUND-TRUTH INSTANCE's decision change — matched by
    stable instance identity (evaluation.metrics.instance_matching), never
    by label text, since two same-label instances in one image (e.g.
    bedroom02.jpg's two "stuffed toy" entries) must be tracked
    independently, not folded into one bucket. Only reported when
    repeats>=3 AND the instance has decisions from >=3 distinct repeat
    indices (a duplicate item_number within one repeat contributes zero
    of those, never inflating the count) — see
    instance_matching.compute_determinism.
  - Ground-truth agreement (§8): fraction of items where the model's
    decision matches evaluation/labels/labels.json's expected_decision —
    matched via item_number -> ground-truth list position (occurrence-
    aware; see evaluation.metrics.instance_matching), not by label text,
    for the same duplicate-instance reason as above. Note (per
    labels/README.md): expected_decision is one person's judgement call
    at labelling time, not an objective answer key — treat this as
    "agreement with the labeller," not "accuracy" in the strict sense.
  - Majority-class baseline: what a trivial "always guess the most common
    ground-truth decision" model would score on ground_truth_agreement_rate
    — computed dynamically from whatever evaluation/labels/labels.json
    currently contains (compute_majority_class_baseline), not a fixed
    target. A model barely beating this baseline isn't demonstrating real
    per-item reasoning, just leaning on whatever keep/sell/donate/discard
    skew the current ground truth happens to have.
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
from evaluation.metrics.instance_matching import (
    build_ground_truth_index,
    compute_determinism,
    instance_id,
    match_batch,
)
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
        # valid JSON but not the requested "array of {item_number, label,
        # decision, reason}" shape (e.g. a model wraps items in an object
        # instead) — a distinct, worth-reporting failure mode, not
        # something to silently miscount or crash on
        wrong_shape_count = 0
        total_calls = 0
        # stable instance_id (evaluation.metrics.instance_matching) ->
        # {repeat_index: decision}, for the determinism check — never keyed
        # by label (duplicate-label ground-truth instances, e.g.
        # bedroom02.jpg's two "stuffed toy" entries, stay separate), and
        # each repeat_index holds at most one decision per instance (a
        # duplicate item_number within one repeat contributes zero entries
        # for that repeat, via match_batch — never two).
        stability: dict[str, dict[int, str]] = defaultdict(dict)
        agreement_matches = 0
        agreement_total = 0
        unmatched_prediction_count = 0
        # predictions whose label matched >1 ground-truth instance with no
        # item_number to disambiguate — excluded from agreement/stability,
        # counted separately so a clean agreement rate can't hide them
        ambiguous_match_count = 0
        # predictions that shared a valid item_number with another
        # prediction in the same LLM response — neither occurrence is
        # trusted (see match_batch), so both are excluded from agreement
        # and stability and counted here instead
        duplicate_prediction_count = 0
        # expected_decision -> Counter(actual decision given) — the per-class
        # breakdown; e.g. per_class_actual["donate"] shows what the model
        # actually said for every item a human expected to be donated
        per_class_actual: dict[str, Counter] = defaultdict(Counter)
        latencies_s: list[float] = []

        for entry in labels:
            image_path = images_dir / entry["filename"]
            if not image_path.exists():
                continue

            # Ordered, position-indexed ground truth — item_number (1-based,
            # present on every classify_items() response item) maps directly
            # to ground_truth[item_number - 1], regardless of duplicate
            # labels. See evaluation.metrics.instance_matching.
            ground_truth = build_ground_truth_index(entry["ground_truth_items"])

            # Seed every EXPECTED instance with an empty repeat-map before
            # any repeat runs, so determinism_detail.n_total_instances
            # reflects every ground-truth instance that was ever asked
            # about — including one the model never returned a usable
            # prediction for at all, not just ones that happened to get
            # at least one match. An empty repeat-map can never satisfy
            # compute_determinism's >=3-distinct-repeats eligibility check
            # on its own, so this can't make an unobserved instance look
            # stable or eligible — it only makes it visible in the total.
            for gt in ground_truth:
                stability.setdefault(instance_id(entry["filename"], gt.index), {})

            # Indexed, not `for _ in range(repeats)` — repeat_index is the
            # determinism check's unit of genuine observation (see
            # instance_matching.compute_determinism) and must be threaded
            # through to stability, not just used as a loop counter.
            for repeat_index in range(repeats):
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

                    # Raw decision distribution — every returned item counts
                    # here regardless of whether it goes on to match cleanly,
                    # since this reports what the model said, not agreement.
                    for item in items:
                        decision_counts[str(item.get("decision", "unknown")).strip().lower()] += 1

                    # Batch-level matching (one call per repeat, not per
                    # item) — required to detect a duplicate item_number
                    # within this single response; match_prediction() alone,
                    # called per item, can't see a sibling prediction in the
                    # same response. See instance_matching.match_batch.
                    batch = match_batch(entry["filename"], ground_truth, items)
                    duplicate_prediction_count += batch.duplicate_count
                    ambiguous_match_count += batch.ambiguous_count
                    unmatched_prediction_count += batch.unmatched_count

                    for predicted_item, match in batch.matches:
                        decision = str(predicted_item.get("decision", "unknown")).strip().lower()
                        # At most one decision per instance per repeat_index
                        # by construction — match_batch already excluded any
                        # item_number that appeared more than once in this
                        # response, so this can't silently overwrite a
                        # different genuine observation for this repeat.
                        stability[match.instance_id][repeat_index] = decision
                        agreement_total += 1
                        per_class_actual[match.expected_decision][decision] += 1
                        if decision == match.expected_decision:
                            agreement_matches += 1

        total_decisions = sum(decision_counts.values())
        distribution = {k: round(v / total_decisions, 3) for k, v in decision_counts.items()} if total_decisions else {}

        # Only reports a rate when it's backed by genuine repeated inference
        # (repeats>=3 AND >=3 genuine outputs for the specific instance) —
        # never a fabricated 1.0 from too few samples. See
        # evaluation.metrics.instance_matching.compute_determinism.
        determinism = compute_determinism(stability, repeats)

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
            "determinism_rate": determinism.determinism_rate,
            # Transparency for the rate above: how many ground-truth
            # instances actually had >=3 genuine outputs to compute it from
            # (n_eligible_instances) vs. how many were tracked at all
            # (n_total_instances), and why the rate is None when it is.
            "determinism_detail": {
                "n_eligible_instances": determinism.n_eligible_instances,
                "n_total_instances": determinism.n_total_instances,
                "reason": determinism.reason,
            },
            "ground_truth_agreement_rate": round(agreement_matches / agreement_total, 3) if agreement_total else None,
            "per_decision_class_breakdown": class_breakdown,
            # items the model returned with a label/item_number that didn't match
            # any ground-truth item (paraphrased, invented, dropped, or an
            # out-of-range item_number) — excluded from the agreement rate above
            # since there's nothing to compare against; reported separately so a
            # high agreement rate can't hide a model that's quietly not
            # classifying the items it was actually given
            "unmatched_prediction_count": unmatched_prediction_count,
            # items whose label matched more than one ground-truth instance in
            # the same image with no item_number to disambiguate — never
            # guessed at, excluded from agreement/stability, counted here
            # instead so they're visible rather than silently dropped
            "ambiguous_match_count": ambiguous_match_count,
            # items that shared a valid item_number with another item in the
            # same LLM response (one repeat) — neither occurrence trusted,
            # both excluded from agreement/stability, counted here instead
            "duplicate_prediction_count": duplicate_prediction_count,
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
