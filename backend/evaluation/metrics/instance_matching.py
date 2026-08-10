"""
Evaluation-only logic: give every ground-truth item a stable, occurrence-
aware identity that never derives from label text alone, and match LLM
predictions to that identity without silently guessing when duplicate
labels make a label-only match ambiguous.

Deliberately NOT under app/core — this is evaluation-specific matching
logic (ground truth vs. a model's prediction), not production
orchestration. Production code (app/core, app/services, app/models) must
never import from here; this module may import from app/core or
app/models if it ever genuinely needs to (it currently doesn't — no
imports from either), but the dependency only ever runs one direction.

Why this exists (see DEVLOG.md): compare_llm_reasoning.py's original
ground-truth lookup (`expected_by_label`, a dict keyed by label text) and
its stability tracking (`stability`, keyed by "filename::label") both
silently collapse duplicate-label ground-truth instances — e.g.
bedroom02.jpg's two "stuffed toy" entries (list positions 29 and 30 in
evaluation/labels/labels.json) share one dict key, so only the second
one's expected_decision survives dict construction, and both instances'
returned decisions land in one shared stability bucket even within a
single repeat, corrupting the determinism calculation before repeats even
come into it.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Literal


def instance_id(filename: str, index: int) -> str:
    """The stable, occurrence-aware evaluation identity for one
    ground-truth item: filename + its position in ground_truth_items —
    never label text, so two same-label items always get two different
    IDs. `index` is 0-based, matching Python list indexing and
    (item_number - 1) for a 1-based item_number from the LLM."""
    return f"{filename}::gt{index}"


@dataclass
class GroundTruthItem:
    index: int
    label: str
    expected_decision: str


def build_ground_truth_index(ground_truth_items: list[dict]) -> list[GroundTruthItem]:
    """Ordered, position-indexed view of one image's ground_truth_items —
    the exact list classify_items() is called with, in the same order, so
    a returned item_number (1-based) maps directly to
    ground_truth[item_number - 1]. label/expected_decision are normalized
    (stripped, lowercased) the same way the rest of this evaluation
    pipeline already normalizes them."""
    return [
        GroundTruthItem(
            index=i,
            label=str(item["label"]).strip().lower(),
            expected_decision=str(item["expected_decision"]).strip().lower(),
        )
        for i, item in enumerate(ground_truth_items)
    ]


MatchStatus = Literal["matched", "ambiguous", "unmatched"]


@dataclass
class MatchResult:
    status: MatchStatus
    instance_id: str | None
    expected_decision: str | None
    reason: str | None


def match_prediction(
    filename: str,
    ground_truth: list[GroundTruthItem],
    predicted_item: dict,
) -> MatchResult:
    """
    Resolves one LLM-returned item to a specific ground-truth instance.

    Preferred path — item_number: every current classify_items() response
    item carries a 1-based item_number (see
    mistral_llm.build_classification_prompt/classify_items), which maps
    directly and unambiguously to ground_truth[item_number - 1],
    regardless of duplicate labels. This is the normal, expected path for
    any current or future compare_llm_reasoning.py run — matching is not
    ambiguous in practice today, because the identity information already
    exists in the response.

    Fallback path — label-only matching, permitted ONLY when item_number
    is genuinely absent from predicted_item (the key itself missing) —
    e.g. a hypothetically reconstructed historical dump; today's actual
    historical result files don't contain raw per-item predictions to
    reconstruct from, only aggregates (see DEVLOG.md). If item_number IS
    present but None, a string, a boolean, zero/negative, or out of
    range, the prediction is reported unmatched directly and is NEVER
    rescued through its label, even if the label alone would otherwise
    resolve unambiguously — a present-but-invalid item_number is a
    malformed response from a model that's expected to supply one, not
    equivalent to a genuinely item-number-less historical record. This
    keeps the fallback limited to input that never had the field at all.

    When the fallback does apply: safe only when the label occurs exactly
    once in this image's ground truth. If it occurs more than once, there
    is no way to know which instance the prediction was actually judging
    — the match is reported "ambiguous", never guessed at (e.g. by
    picking the first or last occurrence), with a reason recorded, and
    the caller must exclude it from instance-level agreement/stability
    claims.
    """
    if "item_number" in predicted_item:
        raw_number = predicted_item["item_number"]
        if isinstance(raw_number, int) and not isinstance(raw_number, bool):
            idx = raw_number - 1
            if 0 <= idx < len(ground_truth):
                gt = ground_truth[idx]
                return MatchResult("matched", instance_id(filename, gt.index), gt.expected_decision, None)
            return MatchResult(
                "unmatched",
                None,
                None,
                f"item_number {raw_number} is out of range for {filename} "
                f"({len(ground_truth)} ground-truth items)",
            )
        return MatchResult(
            "unmatched",
            None,
            None,
            f"item_number present but not a valid positive integer: {raw_number!r} — "
            "not rescued via label fallback (item_number must be genuinely absent for that)",
        )

    label = str(predicted_item.get("label", "")).strip().lower()
    candidates = [gt for gt in ground_truth if gt.label == label]
    if len(candidates) == 1:
        gt = candidates[0]
        return MatchResult("matched", instance_id(filename, gt.index), gt.expected_decision, None)
    if len(candidates) == 0:
        return MatchResult(
            "unmatched",
            None,
            None,
            f"label {label!r} does not match any ground-truth item in {filename}",
        )
    return MatchResult(
        "ambiguous",
        None,
        None,
        f"label {label!r} matches {len(candidates)} distinct ground-truth instances "
        f"in {filename} and no item_number was available to disambiguate — excluded "
        "from instance-level agreement/stability claims",
    )


@dataclass
class BatchMatchResult:
    # (raw predicted item, its resolved match) for every prediction that
    # matched cleanly — decision text stays with the caller, since this
    # module resolves identity, not content (see match_prediction).
    matches: list[tuple[dict, MatchResult]]
    ambiguous_count: int
    unmatched_count: int
    duplicate_count: int


def match_batch(
    filename: str,
    ground_truth: list[GroundTruthItem],
    predicted_items: list[dict],
) -> BatchMatchResult:
    """
    Matches every prediction in ONE LLM response (one repeat) together —
    necessary because a duplicate item_number can only be detected by
    looking at the whole response at once; match_prediction() alone,
    called once per item, has no way to know a sibling prediction in the
    same response also claimed the same item_number.

    Two dedup passes, not one:

    1. item_number-level (pre-match): if a valid, in-range item_number
       appears more than once in this batch, NEITHER occurrence is even
       individually matched — both are excluded up front (contributing
       zero observations, not one) and counted in `duplicate_count`.
       There's no way to know which duplicate occurrence is the model's
       real answer for that item — mirrors app.core.id_mapping's
       "duplicate item_number is invalid, not first-wins" rule (Task 1).

    2. instance-level (post-match) — the UNIVERSAL invariant this
       function enforces regardless of *how* two predictions each
       resolved to a match: one ground-truth instance may contribute at
       most one prediction per repeat. Pass 1 alone can't catch every
       way two predictions collide on the same instance_id — two
       distinct label-only predictions can both resolve to the same
       unique-label instance, or one item-number match can collide with
       one label-only match on the same instance. Every individually
       "matched" result (from either path) is grouped by instance_id
       after matching; any instance_id claimed more than once has NONE
       of its claims trusted, all excluded from `matches`, and all
       counted in `duplicate_count`.

    Predictions with no item_number (or a present-but-invalid one) go
    through match_prediction()'s own label-only handling unchanged —
    item_number-level duplicate detection (pass 1) only applies to
    genuinely valid, in-range item_number values.
    """
    by_number: dict[int, list[dict]] = defaultdict(list)
    other_items: list[dict] = []

    for item in predicted_items:
        raw_number = item.get("item_number")
        if (
            isinstance(raw_number, int)
            and not isinstance(raw_number, bool)
            and 1 <= raw_number <= len(ground_truth)
        ):
            by_number[raw_number].append(item)
        else:
            other_items.append(item)

    ambiguous_count = 0
    unmatched_count = 0
    duplicate_count = 0
    candidate_matches: list[tuple[dict, MatchResult]] = []

    for occurrences in by_number.values():
        if len(occurrences) > 1:
            duplicate_count += len(occurrences)
            continue
        item = occurrences[0]
        # Guaranteed "matched" — item_number already validated in-range
        # and unique within this batch.
        candidate_matches.append((item, match_prediction(filename, ground_truth, item)))

    for item in other_items:
        result = match_prediction(filename, ground_truth, item)
        if result.status == "matched":
            candidate_matches.append((item, result))
        elif result.status == "ambiguous":
            ambiguous_count += 1
        else:
            unmatched_count += 1

    # Pass 2: instance-level dedup across BOTH match paths together.
    by_instance: dict[str, list[tuple[dict, MatchResult]]] = defaultdict(list)
    for item, result in candidate_matches:
        by_instance[result.instance_id].append((item, result))

    matches: list[tuple[dict, MatchResult]] = []
    for instance_matches in by_instance.values():
        if len(instance_matches) > 1:
            duplicate_count += len(instance_matches)
            continue
        matches.append(instance_matches[0])

    return BatchMatchResult(matches, ambiguous_count, unmatched_count, duplicate_count)


@dataclass
class DeterminismResult:
    determinism_rate: float | None
    n_eligible_instances: int
    n_total_instances: int
    reason: str | None


def compute_determinism(stability: dict[str, dict[int, str]], repeats: int) -> DeterminismResult:
    """
    Only reports determinism when it's backed by genuine repeated
    inference: repeats>=3 must actually have been requested, AND the
    specific instance in question must have decisions from at least 3
    DISTINCT repeat indices — a failed/invalid call, or a prediction that
    came back unmatched/ambiguous/duplicate for that instance in one
    repeat, does not count as an observation and is simply absent, not
    padded or guessed. Returns None (never a fabricated 1.0) whenever
    either condition isn't met for enough instances to report anything —
    including the case where repeats>=3 was requested but no instance
    ended up with 3 distinct-repeat outputs (e.g. most calls failed
    validity, or kept colliding on duplicate item_numbers).

    `stability` maps instance_id -> {repeat_index: decision} — each
    repeat_index key can hold at most one decision per instance by
    construction (see match_batch: a duplicate item_number within one
    repeat contributes zero entries for that repeat, never two). This is
    the structural fix over a flat per-instance list: a list's length
    alone can't distinguish "3 genuine repeats" from "1 repeat that
    returned the same item twice plus 1 real repeat" (2 raw entries, only
    1 distinct repeat) — eligibility here is decided by
    len(repeat_map) (the number of distinct keys), never len of a flat
    list of raw observations.

    Instances with fewer than 3 distinct-repeat outputs are excluded from
    the aggregate rate entirely (not counted as "unstable", not counted
    at all) — n_eligible_instances / n_total_instances make that
    exclusion visible rather than silently shrinking the denominator.
    """
    n_total = len(stability)
    if repeats < 3:
        return DeterminismResult(
            None, 0, n_total, f"repeats={repeats} < 3 — determinism requires genuine repeated inference"
        )

    eligible = {iid: repeat_map for iid, repeat_map in stability.items() if len(repeat_map) >= 3}
    if not eligible:
        return DeterminismResult(
            None,
            0,
            n_total,
            "no ground-truth instance had decisions from >=3 distinct repeat indices "
            "(e.g. calls failed, or predictions came back unmatched/ambiguous/duplicate)",
        )

    stable = sum(1 for repeat_map in eligible.values() if len(set(repeat_map.values())) == 1)
    return DeterminismResult(round(stable / len(eligible), 3), len(eligible), n_total, None)
