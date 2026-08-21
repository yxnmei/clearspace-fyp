"""
Reorganise Planner V2 — flat per-item assignments. EVALUATION ONLY.

Why V2 exists: the 2026-08-20 screen asked models to partition 28 item
ids directly into nested zones. Both crowded survivors produced
syntactically valid JSON that failed semantic validation, and both
duplicated exactly 5 item_ids across zones — independently. The models
could follow the JSON shape but not hold a 28-element mutual-exclusion
constraint in one pass.

V2 moves that constraint out of the model. The model emits FLAT rows —
one per item, no nesting, no cross-row invariant to maintain — and
deterministic code owns batching, per-row validation, aggregation,
recovery, merging and prompt construction. The partition becomes true by
construction rather than by instruction.

NOTHING HERE TOUCHES PRODUCTION. No app/ module is modified, no
production schema/provenance/config/route changes, and production
Reorganise stays on `deterministic_direct`. This module reuses
app.core's ReorganisePlan/ReorganiseZone as the OUTPUT shape (so a
passing candidate produces a plan production could already consume) and
app.core.json_repair for extraction — both read-only imports.

Transport bounds, error sanitisation and fixture loading are imported
from compare_reorganise_planning (the V1 harness) rather than
duplicated, so both arms provably use identical limits.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from app.core.json_repair import extract_json_detailed
from app.core.reorganise_schemas import KEEP_IN_PLACE_ZONE_NAME, ReorganisePlan, ReorganiseZone
from app.core.schemas import DetectedItem
from evaluation.scripts.compare_reorganise_planning import (
    NUM_PREDICT,
    REQUEST_TIMEOUT_S,
    PlannerCallError,
    _bounded,
    _sanitized_error_detail,
    classify_call_error,
    extract_message_content,
)

# --- fixed experiment constants -----------------------------------------

# Fixed at 7 for this milestone. Deliberately NOT configurable and NOT
# swept over 6/7/8 — a sweep triples the run cost before we know whether
# the flat framing helps at all.
BATCH_SIZE = 7

OPERATIONS: tuple[str, ...] = ("keep_in_place", "straighten", "group", "store", "relocate")
ROW_KEYS: frozenset[str] = frozenset({"item_id", "operation", "zone_name", "instruction"})

_ITEM_ID_RE = re.compile(r"^item_\d{3,}$")

# Zone-instruction text used when no item in a zone owns a validated row.
KEEP_IN_PLACE_INSTRUCTION = "Leave these items where they are."

# Prompt revision, recorded in every evaluation artefact so results from
# different prompts can never be compared as though they shared one. Bump
# it — never edit in place — whenever the semantic guidance changes.
# Distinct from the runner's `planner_version`, which names the harness
# family and does not move when only the prompt does.
PLANNER_V2_PROMPT_VERSION = "v2.1"

# Zone-count target shown to the model. Mirrors the runner's MIN_ZONES /
# MAX_ZONES gate, and a test asserts the two stay equal so the prompt
# cannot ask for output the gate rejects. Stating the target to the model
# is not the same as relaxing the gate.
PROMPT_MIN_ZONES = 2
PROMPT_MAX_ZONES = 8

# Per-item validity — mirrors app.core.schemas.ItemValidity's vocabulary
# exactly, but declared here because this is evaluation-layer state and
# must not imply a production schema change.
ItemValidity = Literal["raw_valid", "mechanically_repaired", "recovery_used", "still_invalid"]

# Every distinguishable way a response or row can fail. Recorded
# separately, never collapsed into one "bad response" count — which
# failure mode dominates is the actual finding.
RowIssueKind = Literal[
    "root_not_object",
    "assignments_not_list",
    "call_failed",
    "row_not_object",
    "malformed_item_id",
    "unexpected_id",
    "out_of_batch",
    "invalid_operation",
    "blank_zone_name",
    "blank_instruction",
    "unexpected_field",
    "duplicate_row",
    "missing_row",
]


# --- validation results --------------------------------------------------


@dataclass(frozen=True)
class AcceptedRow:
    """One row that passed every per-row check. `repaired` records whether
    the JSON it came from needed extract_json_detailed's repair — that
    distinction becomes raw_valid vs mechanically_repaired."""

    item_id: str
    operation: str
    zone_name: str
    instruction: str
    repaired: bool


@dataclass
class RowIssue:
    kind: RowIssueKind
    detail: str
    item_id: str | None = None
    row_index: int | None = None
    # Which pass produced this issue. Set by run_planner_v2 when it
    # collects a batch's issues — without it, initial and recovery
    # failures collapse into one total, and a metric labelled
    # "initial_duplicate_count" would silently include recovery
    # duplicates.
    phase: str = "initial"


@dataclass
class BatchValidation:
    """Outcome of validating ONE batch response against ONE batch's
    expected ids. `resolved` maps item_id -> AcceptedRow; `unresolved` is
    every expected id that did not end with exactly one accepted row."""

    resolved: dict[str, AcceptedRow] = field(default_factory=dict)
    unresolved: list[str] = field(default_factory=list)
    issues: list[RowIssue] = field(default_factory=list)


def issue_counts(issues: list[RowIssue], phase: str | None = None) -> dict[str, int]:
    """Counts by kind. `phase` filters to one pass — initial and recovery
    metrics must never be reported as a single combined total."""
    counts: dict[str, int] = {}
    for issue in issues:
        if phase is not None and issue.phase != phase:
            continue
        counts[issue.kind] = counts.get(issue.kind, 0) + 1
    return counts


def validate_batch_rows(
    parsed: Any,
    expected_ids: list[str],
    known_ids: set[str],
    *,
    repaired: bool,
) -> BatchValidation:
    """Row-wise validation. One malformed row NEVER discards a valid
    sibling — that resilience is the whole reason the flat shape exists,
    and validating the response through a single nested pydantic model
    would destroy it (pydantic rejects the entire object when one element
    fails).

    `expected_ids` are the ids this batch was asked to assign.
    `known_ids` is every id in the fixture, so an id that exists but
    belongs to another batch (`out_of_batch`) stays distinguishable from
    one that does not exist at all (`unexpected_id`).
    """
    result = BatchValidation()
    expected = list(expected_ids)
    expected_set = set(expected)

    if not isinstance(parsed, dict):
        result.issues.append(
            RowIssue(kind="root_not_object", detail=f"root is {type(parsed).__name__}, expected object")
        )
        result.unresolved = list(expected)
        return result

    rows = parsed.get("assignments")
    if not isinstance(rows, list):
        result.issues.append(
            RowIssue(
                kind="assignments_not_list",
                detail=f"assignments is {type(rows).__name__}, expected list",
            )
        )
        result.unresolved = list(expected)
        return result

    # Accepted rows keyed by item_id — a LIST per id, so a duplicate stays
    # visible instead of being silently overwritten by the last occurrence.
    accepted: dict[str, list[AcceptedRow]] = {}

    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            result.issues.append(
                RowIssue(kind="row_not_object", detail=f"row is {type(row).__name__}", row_index=index)
            )
            continue

        extra = set(row.keys()) - ROW_KEYS
        if extra:
            # Strict, matching the codebase's extra="forbid" discipline.
            # Recorded as its own kind so a run can report how often models
            # drift here — cheap to measure now, expensive to discover later.
            result.issues.append(
                RowIssue(
                    kind="unexpected_field",
                    detail=f"unexpected field(s): {sorted(extra)}",
                    row_index=index,
                )
            )
            continue

        item_id = row.get("item_id")
        if not isinstance(item_id, str) or not _ITEM_ID_RE.fullmatch(item_id.strip()):
            result.issues.append(
                RowIssue(kind="malformed_item_id", detail="item_id is not a valid id", row_index=index)
            )
            continue
        item_id = item_id.strip()

        if item_id not in known_ids:
            result.issues.append(
                RowIssue(
                    kind="unexpected_id",
                    detail="item_id is not in this fixture",
                    item_id=item_id,
                    row_index=index,
                )
            )
            continue
        if item_id not in expected_set:
            result.issues.append(
                RowIssue(
                    kind="out_of_batch",
                    detail="item_id belongs to a different batch",
                    item_id=item_id,
                    row_index=index,
                )
            )
            continue

        operation = row.get("operation")
        if not isinstance(operation, str) or operation.strip() not in OPERATIONS:
            result.issues.append(
                RowIssue(
                    kind="invalid_operation",
                    detail="operation not in the allowed set",
                    item_id=item_id,
                    row_index=index,
                )
            )
            continue

        zone_name = row.get("zone_name")
        if not isinstance(zone_name, str) or not zone_name.strip():
            result.issues.append(
                RowIssue(kind="blank_zone_name", detail="zone_name is blank", item_id=item_id, row_index=index)
            )
            continue

        instruction = row.get("instruction")
        if not isinstance(instruction, str) or not instruction.strip():
            result.issues.append(
                RowIssue(
                    kind="blank_instruction",
                    detail="instruction is blank",
                    item_id=item_id,
                    row_index=index,
                )
            )
            continue

        accepted.setdefault(item_id, []).append(
            AcceptedRow(
                item_id=item_id,
                operation=operation.strip(),
                zone_name=zone_name.strip(),
                instruction=instruction.strip(),
                repaired=repaired,
            )
        )

    # Duplicates: neither occurrence is trusted. Matches
    # app.core.id_mapping.map_item_numbers' established rule — picking one
    # would be guessing which the model meant.
    for item_id, rows_for_id in accepted.items():
        if len(rows_for_id) > 1:
            result.issues.append(
                RowIssue(
                    kind="duplicate_row",
                    detail=f"{len(rows_for_id)} rows target this item_id; neither occurrence trusted",
                    item_id=item_id,
                )
            )

    for item_id in expected:
        rows_for_id = accepted.get(item_id, [])
        if len(rows_for_id) == 1:
            result.resolved[item_id] = rows_for_id[0]
        else:
            result.unresolved.append(item_id)
            if not rows_for_id:
                result.issues.append(
                    RowIssue(kind="missing_row", detail="no row returned for this item_id", item_id=item_id)
                )

    return result


# --- batching ------------------------------------------------------------


def build_batches(item_ids: list[str], batch_size: int = BATCH_SIZE) -> list[list[str]]:
    """Deterministic slicing in analysis order — identical input always
    yields identical batches, so a run is reproducible. Mirrors
    mistral_llm.classify_items' own chunking convention."""
    if batch_size <= 0:
        raise ValueError(f"batch_size must be positive, got {batch_size!r}")
    return [item_ids[i : i + batch_size] for i in range(0, len(item_ids), batch_size)]


# --- prompt --------------------------------------------------------------


def planning_rules(*, has_user_context: bool) -> list[str]:
    """The v2.1 semantic guidance, one numbered rule per line.

    Each rule targets a failure mode the baseline artefacts record — zones
    named after positions, one zone per item, identical labels split apart,
    invented containers, `keep_in_place` as a default, and instructions
    that echo the input annotation instead of proposing an action.

    The preference rule is omitted when the fixture has no user context: an
    instruction to honour a preference that was never given is noise the
    model can only misread.
    """
    rules = [
        "A zone is a broad functional area of the room, such as a workspace or a "
        "storage area. A zone is never an item's current position, and never one "
        "zone per object.",
        f"Keep the plan small and coherent: aim for {PROMPT_MIN_ZONES} to "
        f"{PROMPT_MAX_ZONES} zones for the whole room.",
        "Reuse a zone already established for this room whenever it fits "
        "functionally. Create a new zone only when none of them does.",
        "Objects sharing the same label are separate objects and each still needs "
        "its own row, but they normally belong in the same zone. Put them in "
        "different zones only when there is a clear functional reason.",
        "Never introduce a physical object that is not in the FULL ROOM list. Do "
        "not invent drawers, bins, boxes, shelves, cupboards, wardrobes, doors or "
        "windows. A zone name is a grouping label, not a new object.",
        'Use "store" only when the FULL ROOM list already contains something that '
        "can hold the item. Otherwise choose an operation that is true of what you "
        "are actually proposing.",
        'Use "group" only when several related objects are being placed together.',
        'Use "keep_in_place" only when the item genuinely needs no improvement. It '
        "is not the default answer.",
        "Each instruction states one concrete, useful action. Never copy the size "
        "and position annotation shown above into the instruction text.",
    ]
    if has_user_context:
        rules.append(
            "Use the stated user preference when choosing this batch's operations, "
            "zones and instructions. Do not simply repeat it back."
        )
    return [f"{n}. {rule}" for n, rule in enumerate(rules, start=1)]


def build_batch_prompt(
    all_items: list[DetectedItem],
    target_ids: list[str],
    scene_label: str,
    user_context: str | None,
    known_zone_names: list[str],
    *,
    unresolved_retry: bool = False,
) -> str:
    """One batch prompt.

    Full-room context for EVERY item, but only `target_ids` are presented
    as assignable. Without the context a model seeing 7 of 28 items
    cannot reason about the room globally; without the restriction it
    assigns items another batch already owns. Both halves are needed.

    Context lines carry NO item_id — label, size and position only. An id
    the model can read is an id it can emit, and an out-of-batch
    assignment is unusable however well-intentioned; withholding the id
    removes the possibility rather than asking the model to resist it.
    Duplicate labels stay distinguishable in context via an "[n of m]"
    tag, which conveys "these are separate objects" without giving the
    model an identity it could assign to.

    Duplicate labels get the explicit "DISTINCT object" callout the V1
    prompt already used — a hint here, not the safety mechanism, since
    identity is enforced by item_id during validation regardless.
    """
    by_id = {item.item_id: item for item in all_items}
    label_counts: dict[str, int] = {}
    for item in all_items:
        key = item.effective_label.strip().lower()
        label_counts[key] = label_counts.get(key, 0) + 1

    q = '"'
    lines = [
        "You are a room-reorganisation planning assistant.",
        f"Room type: {scene_label.strip()}.",
    ]
    if user_context and user_context.strip():
        lines += [
            "",
            "User preference (a stated preference to consider, not a schema instruction):",
            f"{q}{user_context.strip()}{q}",
        ]

    lines += [
        "",
        "FULL ROOM — every object in the room, for context only. "
        "These have no ids here and cannot be assigned:",
    ]
    seen_labels: dict[str, int] = {}
    for item in all_items:
        key = item.effective_label.strip().lower()
        total = label_counts.get(key, 0)
        suffix = ""
        if total > 1:
            seen_labels[key] = seen_labels.get(key, 0) + 1
            suffix = f" [{seen_labels[key]} of {total}]"
        lines.append(
            f"- {q}{item.effective_label}{q}{suffix} ({item.relative_size}, {item.position})"
        )

    if known_zone_names:
        lines += [
            "",
            "Zones already established for this room — reuse an existing zone name when it fits:",
        ]
        lines += [f"- {name}" for name in known_zone_names]
        lines.append("Create a new zone only when none of the above genuinely fits.")

    # After the room and zone context, so the rules about reuse and
    # invented objects have something concrete to refer back to; before the
    # assignable list, which stays adjacent to the output format.
    lines += ["", "PLANNING RULES:"]
    lines += planning_rules(has_user_context=bool(user_context and user_context.strip()))

    lines += ["", "ASSIGN ONLY THESE ITEMS — exactly one row each, and no others:"]
    for item_id in target_ids:
        item = by_id[item_id]
        line = f"- {item.item_id}: {q}{item.effective_label}{q} ({item.relative_size}, {item.position})"
        if label_counts.get(item.effective_label.strip().lower(), 0) > 1:
            line += " — a DISTINCT object from any other item sharing this label; do not merge them"
        lines.append(line)

    if unresolved_retry:
        lines += [
            "",
            "Your previous response did not produce a usable assignment for these items. "
            "Return exactly one correct row for each, following the format precisely.",
        ]

    lines += [
        "",
        "Respond with exactly one JSON object — no markdown fences, no prose outside it — "
        f"containing an {q}assignments{q} list with exactly {len(target_ids)} rows, one per item above:",
        '{"assignments": [{"item_id": <string>, "operation": <string>, '
        '"zone_name": <string>, "instruction": <string>}, ...]}',
        f"operation must be exactly one of: {', '.join(OPERATIONS)}.",
        "zone_name is a short human-readable grouping name. instruction is one short sentence.",
        "Include no fields other than those four. Do not assign any item_id not listed above.",
    ]
    return "\n".join(lines)


# --- transport -----------------------------------------------------------


@dataclass
class BatchCallResult:
    parsed: Any
    repaired: bool
    raw_text: str
    latency_s: float


class V2Planner:
    """One bounded Ollama call per batch, plain JSON only (never format=).

    Reuses the V1 harness's error classification and sanitisation so both
    arms fail identically and neither leaks a prompt, host or response
    body into a result artefact. `chat_fn` is injected, which is what
    makes every unit test structurally incapable of reaching a real model.
    """

    def __init__(
        self,
        model_name: str,
        *,
        chat_fn: Callable[..., Any],
        seed: int | None = None,
        temperature: float = 0.2,
        num_predict: int = NUM_PREDICT,
        timeout_s: float = REQUEST_TIMEOUT_S,
    ) -> None:
        self.model_name = model_name
        self.chat_fn = chat_fn
        self.seed = seed
        self.temperature = temperature
        self.num_predict = num_predict
        self.timeout_s = timeout_s
        self.invocations: list[dict] = []

    def build_options(self) -> dict:
        options: dict[str, Any] = {"temperature": self.temperature, "num_predict": self.num_predict}
        if self.seed is not None:
            options["seed"] = self.seed
        return options

    def __call__(self, prompt: str, *, phase: str) -> BatchCallResult:
        kwargs: dict[str, Any] = {
            "model": self.model_name,
            "messages": [{"role": "user", "content": prompt}],
            "options": self.build_options(),
        }
        record: dict[str, Any] = {
            "index": len(self.invocations),
            "phase": phase,
            "model": self.model_name,
            "seed": self.seed,
            "options": dict(kwargs["options"]),
            "timeout_s": self.timeout_s,
            "format_sent": False,
            "prompt_chars": len(prompt),
            "prompt_words": len(prompt.split()),
        }
        started = time.perf_counter()
        try:
            response = self.chat_fn(**kwargs)
            raw_text = extract_message_content(response)
        except Exception as exc:  # noqa: BLE001 — classified, sanitised, re-raised
            kind = classify_call_error(exc)
            record.update(
                {
                    "latency_s": round(time.perf_counter() - started, 3),
                    "call_success": False,
                    "error_kind": kind,
                    "error_detail": _sanitized_error_detail(kind, exc),
                    "raw_response": None,
                }
            )
            self.invocations.append(record)
            raise PlannerCallError(kind, record["error_detail"]) from exc

        latency_s = round(time.perf_counter() - started, 3)
        extraction = extract_json_detailed(raw_text)
        record.update(
            {
                "latency_s": latency_s,
                "call_success": True,
                "error_kind": None,
                "error_detail": None,
                "raw_response": raw_text,
                "syntactic_valid": extraction.is_valid,
                "mechanically_repaired": extraction.was_repaired,
            }
        )
        self.invocations.append(record)
        return BatchCallResult(
            parsed=extraction.parsed,
            repaired=extraction.was_repaired,
            raw_text=raw_text,
            latency_s=latency_s,
        )


# --- orchestration -------------------------------------------------------


@dataclass
class PlanningV2Result:
    """Everything one V2 planning run produced. Evaluation-layer only —
    deliberately NOT a ReorganisePlanningResult, so production's
    `attempts` field and provenance vocabulary stay untouched."""

    plan: ReorganisePlan
    assignments: dict[str, AcceptedRow]
    validity: dict[str, ItemValidity]
    issues: list[RowIssue]
    llm_call_count: int
    initial_latency_s: float
    recovery_latency_s: float
    total_latency_s: float
    invocations: list[dict]
    call_failed: bool


def run_planner_v2(
    items: list[DetectedItem],
    scene_label: str,
    user_context: str | None,
    planner: V2Planner,
    *,
    batch_size: int = BATCH_SIZE,
) -> PlanningV2Result:
    """Batch -> validate -> one batched recovery pass -> merge.

    Hard call bound: ceil(N/batch) initial + ceil(unresolved/batch)
    recovery. For 28 items at size 7 that is at most 4 + 4 = 8. The
    recovery list is PARTITIONED, so "at most one recovery opportunity
    per item" holds by construction rather than by a counter that could
    drift.
    """
    item_ids = [item.item_id for item in items]
    known_ids = set(item_ids)
    order = {item_id: i for i, item_id in enumerate(item_ids)}

    assignments: dict[str, AcceptedRow] = {}
    validity: dict[str, ItemValidity] = {}
    issues: list[RowIssue] = []
    zone_names: list[str] = []
    call_failed = False

    def _remember_zone(name: str) -> None:
        if name.strip().lower() not in {z.strip().lower() for z in zone_names}:
            zone_names.append(name.strip())

    started_all = time.perf_counter()

    # --- initial batches -------------------------------------------------
    started_initial = time.perf_counter()
    unresolved: list[str] = []
    for batch in build_batches(item_ids, batch_size):
        prompt = build_batch_prompt(items, batch, scene_label, user_context, list(zone_names))
        try:
            call = planner(prompt, phase="initial")
        except PlannerCallError as exc:
            call_failed = True
            issues.append(RowIssue(kind="call_failed", detail=_bounded(exc.detail), phase="initial"))
            unresolved.extend(batch)
            continue

        validated = validate_batch_rows(call.parsed, batch, known_ids, repaired=call.repaired)
        for issue in validated.issues:
            issue.phase = "initial"
        issues.extend(validated.issues)
        for item_id, row in validated.resolved.items():
            assignments[item_id] = row
            validity[item_id] = "mechanically_repaired" if row.repaired else "raw_valid"
            _remember_zone(row.zone_name)
        unresolved.extend(validated.unresolved)
    initial_latency_s = round(time.perf_counter() - started_initial, 3)

    # --- exactly one batched recovery pass -------------------------------
    started_recovery = time.perf_counter()
    still_invalid: list[str] = []
    if unresolved:
        unresolved = sorted(set(unresolved), key=lambda i: order[i])
        for batch in build_batches(unresolved, batch_size):
            prompt = build_batch_prompt(
                items, batch, scene_label, user_context, list(zone_names), unresolved_retry=True
            )
            try:
                call = planner(prompt, phase="recovery")
            except PlannerCallError as exc:
                call_failed = True
                issues.append(RowIssue(kind="call_failed", detail=_bounded(exc.detail), phase="recovery"))
                still_invalid.extend(batch)
                continue

            validated = validate_batch_rows(call.parsed, batch, known_ids, repaired=call.repaired)
            for issue in validated.issues:
                issue.phase = "recovery"
            issues.extend(validated.issues)
            for item_id, row in validated.resolved.items():
                assignments[item_id] = row
                validity[item_id] = "recovery_used"
                _remember_zone(row.zone_name)
            still_invalid.extend(validated.unresolved)
    recovery_latency_s = round(time.perf_counter() - started_recovery, 3)

    for item_id in still_invalid:
        validity[item_id] = "still_invalid"

    plan = merge_assignments(items, assignments, scene_label, user_context)

    return PlanningV2Result(
        plan=plan,
        assignments=assignments,
        validity=validity,
        issues=issues,
        llm_call_count=len(planner.invocations),
        initial_latency_s=initial_latency_s,
        recovery_latency_s=recovery_latency_s,
        total_latency_s=round(time.perf_counter() - started_all, 3),
        invocations=planner.invocations,
        call_failed=call_failed,
    )


# --- deterministic merge -------------------------------------------------


def merge_assignments(
    items: list[DetectedItem],
    assignments: dict[str, AcceptedRow],
    scene_label: str,
    user_context: str | None,
) -> ReorganisePlan:
    """Validated rows -> ReorganisePlan, in the CURRENT production shape.

    Because each item contributes at most one row, and every unassigned
    item goes to exactly one Keep-in-place zone, ReorganisePlan's three
    invariants (no empty zone, no duplicate zone name, no cross-zone
    duplicate) hold by construction. The production validator stays as an
    assertion that should never fire — if it does, that is a defect here,
    not model output.

    `operation` is deliberately NOT stored on the plan: adding a field
    would be a production schema change. It survives in evaluation
    metadata and informs instruction/prompt text only.
    """
    order = {item.item_id: i for i, item in enumerate(items)}
    by_id = {item.item_id: item for item in items}

    grouped: dict[str, dict] = {}
    for item_id in sorted(assignments, key=lambda i: order[i]):
        row = assignments[item_id]
        key = row.zone_name.strip().lower()
        bucket = grouped.setdefault(
            key, {"display": row.zone_name.strip(), "instructions": {}, "unassigned_ids": []}
        )
        # Keyed by item_id, never a list positionally paired with the
        # ids: the two fall out of step the moment unassigned items join
        # a bucket, and pairing by position then attributes one item's
        # sentence to a different object.
        bucket["instructions"][item_id] = row.instruction

    unassigned = sorted((i for i in order if i not in assignments), key=lambda i: order[i])
    if unassigned:
        keep_key = KEEP_IN_PLACE_ZONE_NAME.strip().lower()
        bucket = grouped.setdefault(
            keep_key, {"display": KEEP_IN_PLACE_ZONE_NAME, "instructions": {}, "unassigned_ids": []}
        )
        # No instruction is invented for these: an item with no validated
        # row owns none, and build_zone_instruction says so plainly rather
        # than letting one borrow a neighbour's sentence.
        bucket["unassigned_ids"].extend(unassigned)

    zones = []
    for bucket in grouped.values():
        ordered = sorted(
            [*bucket["instructions"], *bucket["unassigned_ids"]], key=lambda i: order[i]
        )
        zones.append(
            ReorganiseZone(
                zone_name=bucket["display"],
                item_ids=ordered,
                instruction=build_zone_instruction(ordered, bucket, by_id),
            )
        )

    return ReorganisePlan(
        zones=zones,
        image_prompt=build_image_prompt(zones, by_id, scene_label, user_context),
        negative_prompt=None,
    )


def build_zone_instruction(
    ordered_item_ids: list[str],
    bucket: dict,
    by_id: dict[str, DetectedItem],
) -> str:
    """One zone instruction representing EVERY validated row merged into
    that zone, in analysis order.

    Keeping only the first row's instruction (the earlier behaviour)
    silently discarded the model's reasoning for every other item in the
    zone — with a 28-item room merging into ~4 zones, that is most of the
    output thrown away, and a manual reviewer would be judging one
    sentence while believing they were judging the plan.

    Each part is prefixed with the item's label so a reader can tell
    which instruction belongs to which object. `operation` is
    deliberately absent: it stays evaluation metadata and never enters
    the production plan, in a field or in prose.

    Ownership is read from `bucket["instructions"]`, keyed by item_id.
    Items in the zone that own no validated row — unassigned items
    absorbed into Keep-in-place — are named together in one closing
    clause, so every id in the zone is accounted for and none is handed
    a sentence written about a different object.
    """
    per_item: dict[str, str] = bucket["instructions"]
    parts: list[str] = []
    unstated: list[str] = []
    for item_id in ordered_item_ids:
        item = by_id.get(item_id)
        label = item.effective_label if item is not None else item_id
        text = (per_item.get(item_id) or "").strip().rstrip(".")
        if text:
            parts.append(f"{label}: {text}.")
        else:
            unstated.append(label)
    if parts and unstated:
        parts.append(f"Leave the remaining items where they are: {', '.join(unstated)}.")
    if parts:
        return " ".join(parts)
    # Reachable when no item in the zone owns a row — a Keep-in-place
    # zone built purely from unassigned items.
    return KEEP_IN_PLACE_INSTRUCTION


def build_image_prompt(
    zones: list[ReorganiseZone],
    by_id: dict[str, DetectedItem],
    scene_label: str,
    user_context: str | None,
) -> str:
    """Deterministic, from validated data only — model `instruction` text
    is never spliced in, so unvetted model prose cannot reach the image
    model.

    This does NOT address the CLIP 77-token limit: a 28-item room still
    produces a prompt well past it. That remains the separate Phase 3
    contract issue recorded in backend/evaluation/README.md, untouched by
    this experiment.
    """
    lines = [
        f"A tidy, well-organised {scene_label.strip()}.",
        "Preserve the room's structure, walls, windows, and furniture layout exactly.",
    ]
    for zone in zones:
        lines.append(f"{zone.zone_name}:")
        for item_id in zone.item_ids:
            item = by_id.get(item_id)
            if item is None:
                continue
            bits = [b for b in (item.relative_size, item.position) if b]
            suffix = f" ({', '.join(bits)})" if bits else ""
            lines.append(f"- {item.effective_label}{suffix}")
    if user_context and user_context.strip():
        lines.append(f"Additional context from the user: {user_context.strip()}")
    return "\n".join(lines)
