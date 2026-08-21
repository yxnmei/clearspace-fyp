"""
Planner V2 evaluation runner — staged, bounded, evaluation-only.

Runs the flat-assignment planner (evaluation/scripts/reorganise_v2.py)
against the existing fixtures and scores it against explicit gates.
Production is untouched and stays on `deterministic_direct`; nothing here
imports a production route, service or config value.

THE GATE TRAP THIS RUNNER EXISTS TO AVOID: after merging, unresolved
items are absorbed into the Keep-in-place zone, so the final plan always
has exact coverage even when the model resolved nothing. Gates are
therefore computed from `llm_resolved_count` — the count of items the
MODEL genuinely assigned — before that absorption, and `still_invalid`
is its own hard gate. A deterministic fallback must never make a failed
candidate look like a passing one.

No automatic retune in this milestone: a failed run is recorded as
failed. Any prompt revision is a separately approved experiment.

Usage (no inference happens until one of these is run):
    python -m evaluation.scripts.compare_reorganise_planning_v2 simple  --model phi4-mini --seed 11 --out r.json
    python -m evaluation.scripts.compare_reorganise_planning_v2 crowded --model phi4-mini --seed 11 --out r.json
    python -m evaluation.scripts.compare_reorganise_planning_v2 crowded --model phi4-mini --seed 22 --seed 33 --out r.json
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from evaluation.scripts.compare_reorganise_planning import (
    LATENCY_GATE_S,
    NUM_PREDICT,
    REQUEST_TIMEOUT_S,
    PlannerFixture,
    _writer,
    is_trivial_plan,
    load_fixture,
    make_ollama_chat_fn,
    manual_review_block,
    plan_partition_signature,
)
from evaluation.scripts.reorganise_v2 import (
    BATCH_SIZE,
    OPERATIONS,
    V2Planner,
    build_batches,
    issue_counts,
    run_planner_v2,
)

# Default candidate set for THIS milestone: phi4-mini only. Mistral is
# reachable via --model but is never run by default; schema mode, V1
# reruns and Qwen are deliberately absent (schema mode failed 0/4 on
# 2026-08-20, and Qwen is not downloaded).
DEFAULT_MODEL = "phi4-mini"
ALLOWED_MODELS: tuple[str, ...] = ("phi4-mini", "mistral")

SIMPLE_FIXTURE = "reorganise_simple.json"
CROWDED_FIXTURE = "reorganise_bedroom02_28items.json"

MAX_RECOVERY_RATE = 0.20
MIN_ZONES = 2
MAX_ZONES = 8
MIN_DISTINCT_OPERATIONS = 2


def _expected_max_calls(n_items: int, batch_size: int = BATCH_SIZE) -> int:
    """ceil(n/batch) initial + at most the same again for recovery."""
    per_pass = len(build_batches([str(i) for i in range(n_items)], batch_size))
    return per_pass * 2


def evaluate_case(
    fixture: PlannerFixture,
    model_name: str,
    seed: int,
    planner_factory: Callable[[str, int], V2Planner],
    *,
    crowded: bool,
) -> dict:
    """One fixture x model x seed. Records every metric, then applies the
    gates for this fixture kind."""
    planner = planner_factory(model_name, seed)
    n_items = len(fixture.items)
    item_ids = fixture.item_ids

    result = run_planner_v2(fixture.items, fixture.scene_label, fixture.user_context, planner)

    llm_resolved = sorted(result.assignments)
    still_invalid = sorted(i for i, v in result.validity.items() if v == "still_invalid")
    recovery_used = sorted(i for i, v in result.validity.items() if v == "recovery_used")
    counts = issue_counts(result.issues)
    initial_counts = issue_counts(result.issues, phase="initial")
    recovery_counts = issue_counts(result.issues, phase="recovery")
    plan_dump = result.plan.model_dump()

    plan_ids = [i for zone in result.plan.zones for i in zone.item_ids]
    operations = sorted({row.operation for row in result.assignments.values()})
    op_distribution: dict[str, int] = {}
    for row in result.assignments.values():
        op_distribution[row.operation] = op_distribution.get(row.operation, 0) + 1

    recovery_rate = (len(recovery_used) / n_items) if n_items else 0.0

    case: dict[str, Any] = {
        "fixture": fixture.name,
        "fixture_kind": "crowded" if crowded else "simple",
        "model": model_name,
        "mode": "plain",
        "seed": seed,
        "n_items": n_items,
        "batch_size": BATCH_SIZE,
        "bounds": {
            "timeout_s": REQUEST_TIMEOUT_S,
            "num_predict": NUM_PREDICT,
            "latency_gate_s": LATENCY_GATE_S,
            "max_calls": _expected_max_calls(n_items),
        },
        # --- calls and latency ---
        "llm_call_count": result.llm_call_count,
        "initial_latency_s": result.initial_latency_s,
        "recovery_latency_s": result.recovery_latency_s,
        "total_latency_s": result.total_latency_s,
        "call_failed": result.call_failed,
        # --- identity outcomes, BEFORE keep-in-place absorption ---
        "llm_resolved_count": len(llm_resolved),
        "llm_resolved_ids": llm_resolved,
        "still_invalid_count": len(still_invalid),
        "still_invalid_ids": still_invalid,
        "recovery_count": len(recovery_used),
        "recovery_rate": round(recovery_rate, 4),
        "per_item_validity": dict(sorted(result.validity.items())),
        "issue_counts": counts,
        "initial_issue_counts": initial_counts,
        "recovery_issue_counts": recovery_counts,
        "issues": [
            {
                "kind": i.kind,
                "detail": i.detail,
                "item_id": i.item_id,
                "row_index": i.row_index,
                "phase": i.phase,
            }
            for i in result.issues
        ],
        # Per-phase, never combined — a metric named initial_* that also
        # counted recovery failures would misattribute the model's
        # behaviour on the pass that matters.
        "initial_duplicate_count": initial_counts.get("duplicate_row", 0),
        "initial_missing_count": initial_counts.get("missing_row", 0),
        "initial_unexpected_count": initial_counts.get("unexpected_id", 0)
        + initial_counts.get("out_of_batch", 0),
        "recovery_duplicate_count": recovery_counts.get("duplicate_row", 0),
        "recovery_missing_count": recovery_counts.get("missing_row", 0),
        "recovery_unexpected_count": recovery_counts.get("unexpected_id", 0)
        + recovery_counts.get("out_of_batch", 0),
        # Evidence a human reviewer needs to judge the plan without
        # re-running anything: every validated row, and the merged plan.
        "assignments": [
            {
                "item_id": item_id,
                "operation": r.operation,
                "zone_name": r.zone_name,
                "instruction": r.instruction,
                "validity": result.validity.get(item_id),
            }
            for item_id, r in sorted(result.assignments.items())
        ],
        "merged_plan": plan_dump,
        "partition_signature": plan_partition_signature(plan_dump),
        # --- merged plan (production shape) ---
        "zone_count": len(result.plan.zones),
        "zone_names": [z.zone_name for z in result.plan.zones],
        "final_plan_coverage_exact": sorted(plan_ids) == sorted(item_ids)
        and len(plan_ids) == len(set(plan_ids)),
        "final_plan_item_count": len(plan_ids),
        "operations_used": operations,
        "operation_distribution": op_distribution,
        "image_prompt_chars": len(result.plan.image_prompt),
        "image_prompt_words": len(result.plan.image_prompt.split()),
        "invocations": result.invocations,
        "manual_review": manual_review_block(),
    }

    # --- gates -----------------------------------------------------------
    failures: list[str] = []

    if result.call_failed:
        failures.append("call_failed")
    if result.llm_call_count > case["bounds"]["max_calls"]:
        failures.append("call_budget_exceeded")
    if result.total_latency_s > LATENCY_GATE_S:
        failures.append("latency_gate")
    # Identity gates read llm_resolved_count, never the merged plan — the
    # merged plan is complete by construction and cannot fail these.
    if len(llm_resolved) != n_items:
        failures.append("incomplete_llm_resolution")
    if still_invalid:
        failures.append("still_invalid")
    if not case["final_plan_coverage_exact"]:
        failures.append("final_plan_coverage")
    # Identity output the model invented or misdirected fails outright,
    # in EITHER phase, even when every requested item was also resolved.
    # A run that assigns all 28 correctly and additionally emits
    # item_999 has not demonstrated reliable identity handling.
    if counts.get("unexpected_id", 0) or counts.get("out_of_batch", 0):
        failures.append("unexpected_identity_output")

    if crowded:
        if recovery_rate > MAX_RECOVERY_RATE:
            failures.append("recovery_rate")
        if not (MIN_ZONES <= len(result.plan.zones) <= MAX_ZONES):
            failures.append("zone_count")
        if len(operations) < MIN_DISTINCT_OPERATIONS:
            failures.append("operation_diversity")
    else:
        if recovery_used:
            failures.append("recovery_used_on_simple")
        # Reuses V1's trivial-plan semantics: every selected item in a
        # single zone. The previous `len(zones) < 1` check could never
        # fire, because ReorganisePlan rejects a zero-zone plan outright.
        if is_trivial_plan(plan_dump, item_ids):
            failures.append("trivial_organisation")

    case["gate_failures"] = failures
    case["passed_automatic_gates"] = not failures
    # Manual usefulness is required but never auto-scored; a case is only
    # genuinely accepted once a human fills the rubric in.
    case["manual_review_required"] = True
    return case


def run_stage(
    fixture: PlannerFixture,
    model_name: str,
    seeds: list[int],
    planner_factory: Callable[[str, int], V2Planner],
    *,
    crowded: bool,
    save: Callable[[dict], None] | None = None,
) -> dict:
    """Each seed is scored INDEPENDENTLY — grouping similarity across
    seeds is reported but is not itself a pass/fail gate."""
    report: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "planner_version": "v2",
        "stage": "crowded" if crowded else "simple",
        "status": "incomplete",
        "model": model_name,
        "mode": "plain",
        "seeds": list(seeds),
        "fixture": {"name": fixture.name, "n_items": len(fixture.items)},
        "bounds": {
            "timeout_s": REQUEST_TIMEOUT_S,
            "num_predict": NUM_PREDICT,
            "latency_gate_s": LATENCY_GATE_S,
            "batch_size": BATCH_SIZE,
            "max_calls_per_case": _expected_max_calls(len(fixture.items)),
        },
        "cases": [],
        "summary": {},
    }

    def _refresh() -> None:
        cases = report["cases"]
        report["summary"] = {
            "case_count": len(cases),
            "passed_automatic_gates_count": sum(1 for c in cases if c["passed_automatic_gates"]),
            "all_seeds_passed_automatic_gates": bool(cases) and all(
                c["passed_automatic_gates"] for c in cases
            ),
            # Descriptive only — two runs can share every zone NAME while
            # grouping the items completely differently.
            "zone_name_sets": [sorted(c["zone_names"]) for c in cases],
            "partition_signatures": [c["partition_signature"] for c in cases],
            # The real stability question: identical canonical item
            # GROUPINGS (V1's plan_partition_signature — zone order and
            # zone names ignored, membership compared).
            "grouping_identical_across_seeds": (
                len({json.dumps(c["partition_signature"]) for c in cases}) == 1
                if len(cases) > 1
                else None
            ),
            "zone_names_identical_across_seeds": (
                len({json.dumps(sorted(c["zone_names"])) for c in cases}) == 1
                if len(cases) > 1
                else None
            ),
            "max_total_latency_s": max((c["total_latency_s"] for c in cases), default=None),
            "max_llm_call_count": max((c["llm_call_count"] for c in cases), default=None),
            "_note": (
                "Gates read llm_resolved_count, not the merged plan — the merged plan is complete "
                "by construction because Keep-in-place absorbs unresolved items. "
                "grouping_identical_across_seeds compares canonical item membership, not zone "
                "names, and is reported only — never a gate. "
                "PASSING THE AUTOMATIC GATES IS NOT ACCEPTANCE: the manual usefulness review is "
                "required, is never auto-scored, and no candidate is accepted without it."
            ),
        }

    def _save() -> None:
        _refresh()
        if save is not None:
            save(report)

    _save()
    for seed in seeds:
        report["cases"].append(
            evaluate_case(fixture, model_name, seed, planner_factory, crowded=crowded)
        )
        _save()

    report["status"] = "complete"
    _save()
    return report


def default_planner_factory(host: str) -> Callable[[str, int], V2Planner]:
    """Real Ollama-backed planners. Only main() calls this; every unit
    test supplies its own factory over a fake chat function, so no test
    can reach a model."""

    def _factory(model_name: str, seed: int) -> V2Planner:
        return V2Planner(
            model_name,
            chat_fn=make_ollama_chat_fn(host, REQUEST_TIMEOUT_S),
            seed=seed,
        )

    return _factory


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("stage", choices=("simple", "crowded"))
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        choices=ALLOWED_MODELS,
        help="phi4-mini by default; mistral only for a justified comparison.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        action="append",
        default=[],
        help="Repeatable. Each seed is scored independently. Defaults to 11.",
    )
    parser.add_argument("--fixtures-dir", type=Path, default=Path("evaluation/fixtures"))
    parser.add_argument("--host", default=None, help="Ollama host (defaults to app settings)")
    parser.add_argument("--out", type=Path, required=True, help="Result JSON (written incrementally)")
    args = parser.parse_args(argv)

    seeds = args.seed or [11]
    if len(set(seeds)) != len(seeds):
        raise SystemExit("seeds must be distinct")

    if args.host is None:
        from app.config import get_settings

        host = get_settings().ollama_host
    else:
        host = args.host

    crowded = args.stage == "crowded"
    fixture = load_fixture(args.fixtures_dir / (CROWDED_FIXTURE if crowded else SIMPLE_FIXTURE))

    report = run_stage(
        fixture,
        args.model,
        seeds,
        default_planner_factory(host),
        crowded=crowded,
        save=_writer(args.out),
    )

    print(f"planner-v2 {args.stage} complete -> {args.out}")
    for case in report["cases"]:
        verdict = (
            "AUTO-PASS — MANUAL REVIEW PENDING"
            if case["passed_automatic_gates"]
            else "AUTO-FAIL " + ",".join(case["gate_failures"])
        )
        print(
            f"  seed={case['seed']:<4} calls={case['llm_call_count']:<3} "
            f"resolved={case['llm_resolved_count']}/{case['n_items']:<4} "
            f"zones={case['zone_count']:<3} {case['total_latency_s']:>7.2f}s  {verdict}"
        )
    print("  Automatic gates are NOT acceptance — the manual usefulness review is still required")
    print("  and is never auto-scored. No candidate is accepted until a human completes it.")


if __name__ == "__main__":
    main()
