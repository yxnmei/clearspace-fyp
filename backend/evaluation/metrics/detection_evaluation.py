"""
Evaluation-only, model-free structures and pure metrics for the Grounding
DINO actionable-clutter pilot (Phase C1 — foundations only; see
`backend/evaluation/labels/README.md` for the full pilot design and
`DEVLOG.md` for how this milestone was scoped).

Deliberately NOT under app/core or app/services — this is evaluation
methodology, not production orchestration. No import here may ever pull in
torch, groundingdino, ollama, or any app.models.* wrapper (see
tests/unit/test_detection_evaluation.py's import-boundary test) — every
class/function in this file must stay computable in milliseconds from
plain Python data.

Why explicit human adjudication, not label+position matching
--------------------------------------------------------------
An earlier version of this plan proposed matching a detector candidate to
a ground-truth instance automatically, using label-text agreement (plus
`position_zone` as a tie-breaker for duplicate labels). That design is
rejected here, on purpose: it cannot validly distinguish "an actionable
object detected with the wrong label" from "an actionable object not
detected at all" — both look identical to a label-matching rule (no label
match). Using the predicted label to decide *whether an object was
detected*, and then separately reporting whether that same label was
*correct*, is circular: it would make actionable recall, correctable
mislabelling, and uncorrectable misses depend on each other in a way that
can silently overstate recall on this project's own most-documented
detector failure (a real object that is not detected at all, e.g. the
`bedroom02.jpg` clothing/bedding gap).

Instead, this module represents identity/correspondence as an explicit,
separately-recorded human judgement (`Adjudication`), and label quality as
a *second*, independent judgement scored only once correspondence is
already settled (see `LabelQuality` below). Recall is therefore computed
from `Adjudication.match_status`/`matched_instance_id` alone, never from
whether `DetectorCandidate.raw_label`/`clean_label` happens to equal the
ground-truth `canonical_label`. `position_zone` is kept on
`GroundTruthInstance` as descriptive/documentary metadata only — it does
not drive matching in this design.

One variant per compute_metrics() call
----------------------------------------
`compute_metrics()` (and `validate_detection_evaluation()`) reject a
non-empty `candidates` collection spanning more than one distinct
`DetectorCandidate.variant`. Mixing variants in one call would let
Variant A and Variant B candidates for the same real object be counted
against each other as duplicate detections, which they are not — they are
two different runs' opinions about the same image. **A comparison between
variants therefore always calls `compute_metrics()` once per variant, on
that variant's own candidates/adjudications, and compares the resulting
`DetectionEvaluationMetrics` objects afterwards** — never one call with
both variants' candidates combined. Zero candidates, and any number of
images sharing one variant, both remain valid.

Candidate identity is variant-agnostic; reuse is not automatic
------------------------------------------------------------------
`candidate_id(filename, index)` does **not** encode the variant — only
`filename` and a position index. This is a naming-convention decision
only: because Phase C2's boundary-aware phrase decoding never changes a
detection's box (only which string labels it), a *future* inference
runner MAY choose to reuse the same `candidate_id` for Variant A and
Variant B's corresponding boxes on the same image, once it has actually
verified — for that specific run — that both variants produced the same
candidate count with matching box coordinates in the same order. This
module does **not** perform or enforce that verification itself, and does
not claim two variants' correspondence is already shared just because
`candidate_id` no longer includes a variant label. If a future runner
finds the boxes actually differ between variants for a given index,
correspondence must be adjudicated again for that image, independently,
not assumed reusable. `DetectorCandidate.variant` remains required
metadata on every candidate regardless of the ID scheme.

Scope (Phase C1)
-----------------
Structures, per-record validation, cross-record validation, and pure
metric calculation only. No inference runner, no phrase-boundary adapter,
and no real 5-image annotation exists yet — see
`backend/evaluation/labels/detection_pilot.example.json` (a fixture, not
real data) and this module's own docstring pointer to Phase C2 below.

Phase C2 (documented, not implemented here)
---------------------------------------------
Grounding DINO's real `remove_combined=True` behaviour must be reproduced
by locating each detection's highest-scoring token, finding the
surrounding caption `.`-separator boundaries, and decoding only
threshold-passing tokens within that single vocabulary segment — not by
inventing an arbitrary string-splitting heuristic on the already-decoded
phrase text. Building the adapter that actually produces Variant B's
candidates is out of scope here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

Actionability = Literal["actionable", "contextual", "uncertain"]
MatchStatus = Literal["matched", "unmatched", "ambiguous"]
LabelQuality = Literal[
    "exact_or_equivalent",
    "usable_but_broad",
    "wrong",
    "fragmented_or_glued",
    "not_assessed",
]

_VALID_ACTIONABILITY: set[str] = {"actionable", "contextual", "uncertain"}
_VALID_MATCH_STATUS: set[str] = {"matched", "unmatched", "ambiguous"}
_VALID_LABEL_QUALITY: set[str] = {
    "exact_or_equivalent",
    "usable_but_broad",
    "wrong",
    "fragmented_or_glued",
    "not_assessed",
}

# Ordering used only to pick the "best" candidate's label_quality when more
# than one candidate is matched to the same ground-truth instance, for the
# INSTANCE-level metrics only (see compute_metrics's docstring — candidate-
# level metrics score every matched candidate individually, never via this
# ranking). Higher is better; wrong/fragmented_or_glued are deliberately
# tied — both are "correction needed" and this module never needs to rank
# one above the other.
_LABEL_QUALITY_RANK: dict[str, int] = {
    "exact_or_equivalent": 3,
    "usable_but_broad": 2,
    "wrong": 1,
    "fragmented_or_glued": 1,
    "not_assessed": 0,
}

DETECTION_PILOT_SCHEMA_VERSION = 1

# The example fixture's deliberate placeholder value for
# source_labels_json_git_blob (see detection_pilot.example.json) — real
# loading rejects it; only load_ground_truth_from_pilot_json's
# allow_placeholder_source_hash=True path (used by the example-fixture
# test) may accept it.
_PLACEHOLDER_SOURCE_HASH = "REPLACE-WITH-REAL-BLOB-HASH-AT-ANNOTATION-TIME"

# A real `git hash-object`/blob SHA: 40 hex chars (SHA-1, current Git
# default) or 64 (SHA-256 repos). Case-insensitive — Git itself always
# prints lowercase, but nothing here should reject a hand-typed uppercase
# hash over that alone.
_GIT_BLOB_HASH_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")


def instance_id(filename: str, index: int) -> str:
    """Stable, occurrence-aware ground-truth identity: filename + position
    in that image's annotated instance list. Mirrors
    evaluation.metrics.instance_matching.instance_id's exact convention
    (same string shape) so the two read consistently side by side, but is
    intentionally NOT imported from there — this module's identity space is
    independent of labels.json's ground_truth_items list positions (see
    module docstring: labels.json is not reused here at all), and
    instance_matching.py stays specific to LLM-decision evaluation."""
    return f"{filename}::gt{index}"


def candidate_id(filename: str, index: int) -> str:
    """Stable identity for one detector candidate within one image's run.
    Deliberately does NOT take a `variant` argument — see the module
    docstring's "Candidate identity is variant-agnostic" section for what
    that does and does not imply about reusing an ID across variants.
    `index` is the candidate's position in that run's raw output list.
    `variant` is still recorded, as metadata, on `DetectorCandidate.variant`
    itself."""
    return f"{filename}::cand{index}"


def _require_non_blank(value: str, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty, non-blank string: {value!r}")


def _validate_box_xyxy(box_xyxy: tuple[float, float, float, float]) -> None:
    if not (isinstance(box_xyxy, tuple) and len(box_xyxy) == 4):
        raise ValueError(f"box_xyxy must be a 4-tuple: {box_xyxy!r}")
    x1, y1, x2, y2 = box_xyxy
    for name, value in (("x1", x1), ("y1", y1), ("x2", x2), ("y2", y2)):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not (0.0 <= value <= 1.0):
            raise ValueError(f"box_xyxy.{name} must be a number in [0, 1]: {value!r}")
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"degenerate or inverted box_xyxy: {box_xyxy!r}")


def _validate_confidence(confidence: float) -> None:
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        raise ValueError(f"confidence must be a number: {confidence!r}")
    if not (0.0 <= confidence <= 1.0):
        raise ValueError(f"confidence out of [0, 1] range: {confidence!r}")


@dataclass
class GroundTruthInstance:
    """One human-annotated, occurrence-aware ground-truth object in one
    image. `position_zone` is descriptive/documentary only in this design
    — it does not drive matching (see module docstring); no fixed
    vocabulary is enforced on it here."""

    instance_id: str
    filename: str
    canonical_label: str
    position_zone: str
    actionability: Actionability
    notes: str | None = None

    def __post_init__(self) -> None:
        _require_non_blank(self.instance_id, "instance_id")
        _require_non_blank(self.filename, "filename")
        _require_non_blank(self.canonical_label, "canonical_label")
        _require_non_blank(self.position_zone, "position_zone")
        if self.actionability not in _VALID_ACTIONABILITY:
            raise ValueError(f"invalid actionability: {self.actionability!r}")


@dataclass
class DetectorCandidate:
    """One raw detector output, from one specific (image, variant) run.
    Identity (`candidate_id`) is independent of both `raw_label`/
    `clean_label` AND `variant` on purpose — nothing about matching may
    depend on what this candidate was labelled, or which variant produced
    it (see module docstring)."""

    candidate_id: str
    filename: str
    raw_label: str
    box_xyxy: tuple[float, float, float, float]
    confidence: float
    variant: str
    clean_label: str | None = None

    def __post_init__(self) -> None:
        _require_non_blank(self.candidate_id, "candidate_id")
        _require_non_blank(self.filename, "filename")
        _require_non_blank(self.raw_label, "raw_label")
        _require_non_blank(self.variant, "variant")
        if self.clean_label is not None:
            _require_non_blank(self.clean_label, "clean_label")
        _validate_box_xyxy(self.box_xyxy)
        _validate_confidence(self.confidence)


@dataclass
class Adjudication:
    """One human judgement about one `DetectorCandidate`: does it
    correspond to a ground-truth instance, and — only when it does — how
    good is its label. `matched_instance_id` is structurally impossible to
    set without `match_status == "matched"`, and `label_quality` is
    structurally impossible to assess without a match, so an adjudication
    can never claim a label judgement for an object it didn't actually
    identify."""

    candidate_id: str
    match_status: MatchStatus
    matched_instance_id: str | None = None
    label_quality: LabelQuality = "not_assessed"
    note: str | None = None

    def __post_init__(self) -> None:
        _require_non_blank(self.candidate_id, "candidate_id")
        if self.match_status not in _VALID_MATCH_STATUS:
            raise ValueError(f"invalid match_status: {self.match_status!r}")
        if self.label_quality not in _VALID_LABEL_QUALITY:
            raise ValueError(f"invalid label_quality: {self.label_quality!r}")

        if self.match_status == "matched":
            if self.matched_instance_id is None or not self.matched_instance_id.strip():
                raise ValueError("match_status is 'matched' but matched_instance_id is not set")
        else:
            if self.matched_instance_id is not None:
                raise ValueError(
                    f"match_status is {self.match_status!r} but matched_instance_id is set "
                    f"({self.matched_instance_id!r}) — only a 'matched' adjudication may carry one"
                )
            if self.label_quality != "not_assessed":
                raise ValueError(
                    f"match_status is {self.match_status!r} but label_quality is "
                    f"{self.label_quality!r} — label quality can only be assessed for a matched candidate"
                )


def validate_detection_evaluation(
    ground_truth: list[GroundTruthInstance],
    candidates: list[DetectorCandidate],
    adjudications: list[Adjudication],
) -> None:
    """
    Raises ValueError on any structural problem that only becomes visible
    once all three collections are assembled together. Each individual
    record already self-validates its own fields at construction (see the
    three dataclasses' __post_init__ above); this function checks:
    duplicate instance/candidate IDs, more than one distinct `variant`
    present in `candidates` (see module docstring — one variant per call),
    adjudications referencing unknown IDs, cross-image matches, and the
    adjudication<->candidate bijection compute_metrics() depends on (every
    candidate adjudicated exactly once, every adjudication referencing a
    real candidate).
    """
    seen_instance_ids: set[str] = set()
    for gt in ground_truth:
        if gt.instance_id in seen_instance_ids:
            raise ValueError(f"duplicate ground-truth instance_id: {gt.instance_id!r}")
        seen_instance_ids.add(gt.instance_id)

    seen_candidate_ids: set[str] = set()
    variants_seen: set[str] = set()
    for c in candidates:
        if c.candidate_id in seen_candidate_ids:
            raise ValueError(f"duplicate candidate_id: {c.candidate_id!r}")
        seen_candidate_ids.add(c.candidate_id)
        variants_seen.add(c.variant)

    if len(variants_seen) > 1:
        raise ValueError(
            f"candidates span more than one variant: {sorted(variants_seen)!r} — "
            "compute_metrics() must be called separately per variant (see module docstring); "
            "combining variants would let their candidates be counted as duplicates of each other"
        )

    gt_by_id = {gt.instance_id: gt for gt in ground_truth}
    candidate_by_id = {c.candidate_id: c for c in candidates}

    adjudicated_candidate_ids: set[str] = set()
    for a in adjudications:
        if a.candidate_id not in candidate_by_id:
            raise ValueError(f"adjudication references unknown candidate_id: {a.candidate_id!r}")
        if a.candidate_id in adjudicated_candidate_ids:
            raise ValueError(f"candidate_id adjudicated more than once: {a.candidate_id!r}")
        adjudicated_candidate_ids.add(a.candidate_id)

        if a.match_status == "matched":
            if a.matched_instance_id not in gt_by_id:
                raise ValueError(
                    f"adjudication for {a.candidate_id!r} references unknown "
                    f"ground-truth instance_id: {a.matched_instance_id!r}"
                )
            candidate = candidate_by_id[a.candidate_id]
            instance = gt_by_id[a.matched_instance_id]
            if candidate.filename != instance.filename:
                raise ValueError(
                    f"cross-image match: candidate {a.candidate_id!r} (filename "
                    f"{candidate.filename!r}) matched to instance {a.matched_instance_id!r} "
                    f"(filename {instance.filename!r})"
                )

    missing = sorted(set(candidate_by_id) - adjudicated_candidate_ids)
    if missing:
        raise ValueError(f"candidate(s) with no adjudication record: {missing!r}")


@dataclass
class DetectionEvaluationMetrics:
    # Ground-truth composition
    actionable_ground_truth_count: int
    contextual_ground_truth_count: int
    uncertain_ground_truth_count: int

    # Recall — computed from explicit adjudication only, never label text
    actionable_detected_count: int
    actionable_missed_count: int
    actionable_recall: float | None
    uncorrectable_miss_rate: float | None

    # Instance-level label quality: one verdict per DETECTED actionable
    # instance, using the BEST quality among its matched candidate(s) —
    # answers "is this object, as a whole, usably identified." See
    # compute_metrics's docstring for the exact aggregation rule.
    actionable_instance_label_quality_assessed_count: int
    strict_label_correct_instance_count: int
    strict_label_correct_instance_rate: float | None
    usable_but_broad_instance_count: int
    actionable_instance_correction_needed_count: int
    actionable_instance_correction_needed_rate: float | None

    # Candidate-level label quality / correction burden: every matched
    # actionable CANDIDATE scored individually — answers "how many boxes
    # does the user actually have to look at and correct or exclude,"
    # which a duplicate with a worse label still adds to even when the
    # instance itself already counts as strictly correct via a sibling.
    actionable_matched_candidate_count: int
    actionable_candidate_label_quality_assessed_count: int
    actionable_candidate_correction_needed_count: int
    actionable_candidate_correction_needed_rate: float | None

    # Assessment completeness — lets a caller tell "score reflects
    # complete adjudication" apart from "some matched actionable
    # candidates just haven't been looked at yet."
    actionable_candidate_label_assessment_coverage: float | None
    is_actionable_label_assessment_complete: bool

    # Candidate-side review burden
    total_candidate_count: int
    unmatched_candidate_count: int
    ambiguous_candidate_count: int
    contextual_candidate_count: int
    uncertain_candidate_count: int
    duplicate_candidate_count: int


def _rate(numerator: int, denominator: int) -> float | None:
    """None on a zero denominator — never a misleading 0.0, never a
    ZeroDivisionError."""
    return None if denominator == 0 else numerator / denominator


def compute_metrics(
    ground_truth: list[GroundTruthInstance],
    candidates: list[DetectorCandidate],
    adjudications: list[Adjudication],
    *,
    require_complete_label_assessment: bool = False,
) -> DetectionEvaluationMetrics:
    """
    Pure metric calculation. Input order never affects the result (every
    lookup below is by ID, never by list position) — see
    test_detection_evaluation.py's input-order-independence test.

    Raises ValueError (via validate_detection_evaluation) if `candidates`
    spans more than one `variant` — see module docstring.

    Instance-level vs. candidate-level label quality — a real
    methodological choice, not an obvious default:
      - INSTANCE level (`*_instance_*` fields) answers "is this
        ground-truth object usably identified at all": when more than one
        candidate is matched to the same actionable instance, that
        instance's quality is the BEST quality among its matched
        candidates (exact_or_equivalent > usable_but_broad > wrong ==
        fragmented_or_glued > not_assessed) — a user only needs one usable
        candidate to complete their decision, so a redundant extra box
        with a worse label must not make an otherwise-correctly-labelled
        instance look wrong at the instance level.
      - CANDIDATE level (`actionable_candidate_*` fields) answers "how
        much correction/exclusion work does the user actually face":
        every individually assessed, matched, actionable candidate whose
        OWN quality is not exact_or_equivalent counts toward
        actionable_candidate_correction_needed_count — a wrong duplicate
        therefore always appears in BOTH duplicate_candidate_count (this
        was a redundant box) AND actionable_candidate_correction_needed_count
        (this specific box still needs correcting or excluding), even
        while the instance it duplicates counts as strictly correct via
        its sibling.
      - "not_assessed" never counts as correct or incorrect at either
        level — an unassessed instance/candidate contributes to neither a
        strict/broad/correction-needed numerator nor to the corresponding
        *_assessed_count denominator, so it cannot silently deflate a rate.

    Assessment completeness (`actionable_candidate_label_assessment_coverage`,
    `is_actionable_label_assessment_complete`) is always computed;
    `require_complete_label_assessment=True` additionally makes an
    incomplete assessment a hard ValueError, naming every still-unassessed
    matched actionable candidate_id, instead of silently returning a
    partial result. Default is non-strict so work-in-progress adjudication
    can still be inspected.
    """
    validate_detection_evaluation(ground_truth, candidates, adjudications)

    adjudication_by_candidate = {a.candidate_id: a for a in adjudications}

    matched_candidates_by_instance: dict[str, list[DetectorCandidate]] = {}
    unmatched_candidate_count = 0
    ambiguous_candidate_count = 0
    for c in candidates:
        a = adjudication_by_candidate[c.candidate_id]
        if a.match_status == "matched":
            matched_candidates_by_instance.setdefault(a.matched_instance_id, []).append(c)
        elif a.match_status == "unmatched":
            unmatched_candidate_count += 1
        else:  # "ambiguous" — never silently counted as a match
            ambiguous_candidate_count += 1

    actionable_ground_truth_count = 0
    contextual_ground_truth_count = 0
    uncertain_ground_truth_count = 0

    actionable_detected_count = 0
    actionable_missed_count = 0
    duplicate_candidate_count = 0
    contextual_candidate_count = 0
    uncertain_candidate_count = 0

    # Instance-level accumulators
    instance_assessed_count = 0
    strict_instance_count = 0
    broad_instance_count = 0
    instance_correction_needed_count = 0

    # Candidate-level accumulators
    actionable_matched_candidate_count = 0
    candidate_assessed_count = 0
    candidate_correction_needed_count = 0
    unassessed_candidate_ids: list[str] = []

    # Every ground-truth instance is visited exactly once here, and every
    # branch below is exhaustive over _VALID_ACTIONABILITY — no instance
    # can be silently dropped from the counts regardless of whether it was
    # ever detected.
    for gt in ground_truth:
        matched = matched_candidates_by_instance.get(gt.instance_id, [])

        if gt.actionability == "actionable":
            actionable_ground_truth_count += 1
            if not matched:
                actionable_missed_count += 1
                continue

            actionable_detected_count += 1
            duplicate_candidate_count += len(matched) - 1

            # --- candidate level: score every matched candidate on its own
            for c in matched:
                actionable_matched_candidate_count += 1
                quality = adjudication_by_candidate[c.candidate_id].label_quality
                if quality == "not_assessed":
                    unassessed_candidate_ids.append(c.candidate_id)
                    continue
                candidate_assessed_count += 1
                if quality != "exact_or_equivalent":
                    candidate_correction_needed_count += 1

            # --- instance level: best-quality-wins across matched candidates
            best_candidate = max(
                matched,
                key=lambda c: _LABEL_QUALITY_RANK[adjudication_by_candidate[c.candidate_id].label_quality],
            )
            best_quality = adjudication_by_candidate[best_candidate.candidate_id].label_quality
            if best_quality != "not_assessed":
                instance_assessed_count += 1
                if best_quality == "exact_or_equivalent":
                    strict_instance_count += 1
                else:
                    instance_correction_needed_count += 1
                    if best_quality == "usable_but_broad":
                        broad_instance_count += 1

        elif gt.actionability == "contextual":
            contextual_ground_truth_count += 1
            contextual_candidate_count += len(matched)

        else:  # "uncertain"
            uncertain_ground_truth_count += 1
            uncertain_candidate_count += len(matched)

    coverage = _rate(candidate_assessed_count, actionable_matched_candidate_count)
    is_complete = actionable_matched_candidate_count == 0 or candidate_assessed_count == actionable_matched_candidate_count

    if require_complete_label_assessment and not is_complete:
        raise ValueError(
            "require_complete_label_assessment=True but the following matched actionable "
            f"candidate(s) are still 'not_assessed': {sorted(unassessed_candidate_ids)!r}"
        )

    return DetectionEvaluationMetrics(
        actionable_ground_truth_count=actionable_ground_truth_count,
        contextual_ground_truth_count=contextual_ground_truth_count,
        uncertain_ground_truth_count=uncertain_ground_truth_count,
        actionable_detected_count=actionable_detected_count,
        actionable_missed_count=actionable_missed_count,
        actionable_recall=_rate(actionable_detected_count, actionable_ground_truth_count),
        uncorrectable_miss_rate=_rate(actionable_missed_count, actionable_ground_truth_count),
        actionable_instance_label_quality_assessed_count=instance_assessed_count,
        strict_label_correct_instance_count=strict_instance_count,
        strict_label_correct_instance_rate=_rate(strict_instance_count, instance_assessed_count),
        usable_but_broad_instance_count=broad_instance_count,
        actionable_instance_correction_needed_count=instance_correction_needed_count,
        actionable_instance_correction_needed_rate=_rate(instance_correction_needed_count, instance_assessed_count),
        actionable_matched_candidate_count=actionable_matched_candidate_count,
        actionable_candidate_label_quality_assessed_count=candidate_assessed_count,
        actionable_candidate_correction_needed_count=candidate_correction_needed_count,
        actionable_candidate_correction_needed_rate=_rate(candidate_correction_needed_count, candidate_assessed_count),
        actionable_candidate_label_assessment_coverage=coverage,
        is_actionable_label_assessment_complete=is_complete,
        total_candidate_count=len(candidates),
        unmatched_candidate_count=unmatched_candidate_count,
        ambiguous_candidate_count=ambiguous_candidate_count,
        contextual_candidate_count=contextual_candidate_count,
        uncertain_candidate_count=uncertain_candidate_count,
        duplicate_candidate_count=duplicate_candidate_count,
    )


@dataclass
class DetectionPilotGroundTruth:
    """Bundle returned by load_ground_truth_from_pilot_json(): the parsed
    ground-truth instances plus the provenance metadata that must travel
    with them. Previously (Phase C1 first pass) the loader discarded
    schema_version/source_labels_json_git_blob after checking them, which
    made it impossible for a caller to later tell which labels.json
    content a given annotation pass was actually pinned to."""

    schema_version: int
    source_labels_json_git_blob: str
    instances: list[GroundTruthInstance]


def _require_key(d: dict, key: str, context: str) -> Any:
    if key not in d:
        raise ValueError(f"{context} is missing required key {key!r}")
    return d[key]


def load_ground_truth_from_pilot_json(
    data: dict, *, allow_placeholder_source_hash: bool = False
) -> DetectionPilotGroundTruth:
    """
    Parses the `backend/evaluation/labels/detection_pilot*.json` contract
    shape (see detection_pilot.example.json) into a validated
    DetectionPilotGroundTruth bundle. Raises ValueError — never a raw
    KeyError/TypeError — on any malformed input: non-object top level,
    unsupported schema_version, a missing/blank/malformed
    source_labels_json_git_blob, non-list images/ground_truth_instances,
    non-object entries, blank or duplicate filenames, or duplicate
    instance_ids anywhere in the file (not just within one image).

    source_labels_json_git_blob must be a real 40- or 64-character
    hexadecimal Git blob hash (`git hash-object backend/evaluation/labels/labels.json`)
    UNLESS `allow_placeholder_source_hash=True` is passed and the value is
    exactly the example fixture's documented placeholder — that escape
    hatch exists only for detection_pilot.example.json's own test, never
    for real annotation loading. This module never invokes Git itself; the
    hash is only shape-validated (hex length), not checked against the
    repository.

    Ground-truth instances only: candidates/adjudications for a real pilot
    run come from an actual detector run + human review, not this file —
    see the module docstring's Phase C2 note.
    """
    if not isinstance(data, dict):
        raise ValueError(f"detection-pilot data must be a JSON object, got {type(data).__name__}")

    schema_version = _require_key(data, "schema_version", "detection-pilot data")
    # isinstance(schema_version, bool) checked separately from the equality
    # test below: bool is a subclass of int in Python, so `True == 1` and
    # `False == 0` — without this, schema_version=True would silently pass
    # as "version 1" instead of being rejected as the wrong type.
    if isinstance(schema_version, bool) or schema_version != DETECTION_PILOT_SCHEMA_VERSION:
        raise ValueError(
            f"unsupported detection-pilot schema_version: {schema_version!r} "
            f"(expected {DETECTION_PILOT_SCHEMA_VERSION!r})"
        )

    source_hash = _require_key(data, "source_labels_json_git_blob", "detection-pilot data")
    if not isinstance(source_hash, str) or not source_hash.strip():
        raise ValueError("source_labels_json_git_blob must be a non-empty, non-blank string")
    if source_hash == _PLACEHOLDER_SOURCE_HASH:
        if not allow_placeholder_source_hash:
            raise ValueError(
                "source_labels_json_git_blob is the example-fixture placeholder "
                f"({_PLACEHOLDER_SOURCE_HASH!r}) — real loading must reject this; pass "
                "allow_placeholder_source_hash=True only for the example fixture itself"
            )
    elif not _GIT_BLOB_HASH_RE.match(source_hash):
        raise ValueError(
            "source_labels_json_git_blob is not a valid Git blob hash "
            f"(40 or 64 hex characters): {source_hash!r}"
        )

    images = _require_key(data, "images", "detection-pilot data")
    if not isinstance(images, list):
        raise ValueError(f"images must be a list, got {type(images).__name__}")

    seen_filenames: set[str] = set()
    seen_instance_ids: set[str] = set()
    instances: list[GroundTruthInstance] = []

    for image in images:
        if not isinstance(image, dict):
            raise ValueError(f"each images[] entry must be a JSON object, got {type(image).__name__}")

        filename = _require_key(image, "filename", "images[] entry")
        if not isinstance(filename, str) or not filename.strip():
            raise ValueError(f"images[] entry filename must be a non-empty, non-blank string: {filename!r}")
        if filename in seen_filenames:
            raise ValueError(f"duplicate filename in images[]: {filename!r}")
        seen_filenames.add(filename)

        raw_instances = _require_key(image, "ground_truth_instances", f"images[] entry {filename!r}")
        if not isinstance(raw_instances, list):
            raise ValueError(
                f"ground_truth_instances for {filename!r} must be a list, got {type(raw_instances).__name__}"
            )

        for raw in raw_instances:
            if not isinstance(raw, dict):
                raise ValueError(
                    f"ground_truth_instances entry for {filename!r} must be a JSON object, "
                    f"got {type(raw).__name__}"
                )
            instance_id_value = _require_key(raw, "instance_id", f"ground_truth_instances entry for {filename!r}")
            # Validated (non-empty, non-blank string) BEFORE any set
            # membership check below: an unhashable instance_id (e.g. a
            # JSON list or object) would otherwise raise a raw TypeError
            # from `in seen_instance_ids`, contradicting this loader's
            # contract of a clear ValueError on any malformed input. The
            # original value is preserved as-is — never trimmed/normalised.
            _require_non_blank(instance_id_value, "instance_id")
            if instance_id_value in seen_instance_ids:
                raise ValueError(f"duplicate instance_id across detection-pilot file: {instance_id_value!r}")
            seen_instance_ids.add(instance_id_value)

            instances.append(
                GroundTruthInstance(
                    instance_id=instance_id_value,
                    filename=filename,
                    canonical_label=_require_key(raw, "canonical_label", f"instance {instance_id_value!r}"),
                    position_zone=_require_key(raw, "position_zone", f"instance {instance_id_value!r}"),
                    actionability=_require_key(raw, "actionability", f"instance {instance_id_value!r}"),
                    notes=raw.get("notes"),
                )
            )

    return DetectionPilotGroundTruth(
        schema_version=schema_version,
        source_labels_json_git_blob=source_hash,
        instances=instances,
    )
