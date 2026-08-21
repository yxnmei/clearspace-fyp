"""
Unit tests for evaluation/scripts/reorganise_v2.py — the flat-assignment
planner's batching, row validation, recovery and merge.

Fakes only. Every planner is built over a scripted fake chat function, so
no test can reach a real model, a network socket, or Ollama.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.core.reorganise_schemas import KEEP_IN_PLACE_ZONE_NAME, ReorganisePlan
from app.core.schemas import BoundingBox, DetectedItem
from evaluation.scripts.reorganise_v2 import (
    BATCH_SIZE,
    OPERATIONS,
    AcceptedRow,
    V2Planner,
    build_batch_prompt,
    build_batches,
    issue_counts,
    merge_assignments,
    run_planner_v2,
    validate_batch_rows,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]


# --- fixtures / fakes ----------------------------------------------------


def _item(index: int, label: str = "lamp") -> DetectedItem:
    """Grid-placed box so any item count stays inside normalized [0,1]."""
    row, col = divmod(index, 6)
    x1 = round(0.02 + col * 0.16, 4)
    y1 = round(0.02 + row * 0.19, 4)
    return DetectedItem(
        item_id=f"item_{index + 1:03d}",
        source_detection_index=index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=x1, y1=y1, x2=round(x1 + 0.14, 4), y2=round(y1 + 0.17, 4)),
        confidence=0.5,
        position="upper-left",
        relative_size="small",
    )


def items(n: int, labels: list[str] | None = None) -> list[DetectedItem]:
    return [_item(i, (labels[i] if labels else "lamp")) for i in range(n)]


def ids(n: int) -> list[str]:
    return [f"item_{i:03d}" for i in range(1, n + 1)]


def row(item_id: str, *, operation="straighten", zone="Wall display", instruction="Tidy it", **extra):
    r = {"item_id": item_id, "operation": operation, "zone_name": zone, "instruction": instruction}
    r.update(extra)
    return r


def payload(rows: list[dict]) -> str:
    return json.dumps({"assignments": rows})


class FakeChat:
    """Scripted stand-in for ollama.Client.chat. Each entry is either an
    exception (raised), a str (wrapped as a well-formed response), or any
    other object (returned verbatim, for malformed-shape tests)."""

    def __init__(self, responses: list) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if not self.responses:
            raise AssertionError("FakeChat called more times than it has scripted responses")
        nxt = self.responses.pop(0)
        if isinstance(nxt, BaseException):
            raise nxt
        if isinstance(nxt, str):
            return {"message": {"content": nxt}}
        return nxt


def planner(responses: list, **kwargs) -> V2Planner:
    return V2Planner("phi4-mini", chat_fn=FakeChat(responses), **kwargs)


# --- batching ------------------------------------------------------------


def test_batch_size_is_fixed_at_seven():
    assert BATCH_SIZE == 7


@pytest.mark.parametrize(
    "n,expected",
    [(1, [1]), (6, [6]), (7, [7]), (8, [7, 1]), (14, [7, 7]), (15, [7, 7, 1]), (28, [7, 7, 7, 7])],
)
def test_batch_boundaries(n, expected):
    assert [len(b) for b in build_batches(ids(n))] == expected


def test_batches_preserve_analysis_order():
    batches = build_batches(ids(28))
    assert batches[0][0] == "item_001"
    assert batches[0][-1] == "item_007"
    assert batches[3][-1] == "item_028"
    assert [i for b in batches for i in b] == ids(28)


def test_batching_is_deterministic():
    assert build_batches(ids(28)) == build_batches(ids(28))


def test_batch_size_must_be_positive():
    with pytest.raises(ValueError, match="must be positive"):
        build_batches(ids(4), 0)


# --- prompt --------------------------------------------------------------


def test_no_non_target_item_id_appears_anywhere_in_the_prompt():
    """An id the model can read is an id it can emit. Non-target ids must
    be absent from the ENTIRE prompt, not merely from the assignable
    section — the full-room context previously leaked all 28."""
    labels = [f"object{i}" for i in range(28)]
    prompt = build_batch_prompt(items(28, labels), ids(28)[:7], "bedroom", None, [])

    for item_id in ids(28)[7:]:
        assert item_id not in prompt, f"{item_id} leaked into the prompt"
    for item_id in ids(28)[:7]:
        assert item_id in prompt


def test_full_room_context_carries_labels_sizes_positions_but_no_ids():
    labels = [f"object{i}" for i in range(28)]
    all_items = items(28, labels)
    prompt = build_batch_prompt(all_items, ids(28)[:7], "bedroom", None, [])
    context = prompt.split("ASSIGN ONLY THESE ITEMS")[0]

    # every object is described...
    for item in all_items:
        assert item.effective_label in context
    assert "small" in context and "upper-left" in context
    # ...but not one id appears in the context section
    for item_id in ids(28):
        assert item_id not in context


def test_target_section_exposes_only_target_ids():
    prompt = build_batch_prompt(items(28), ids(28)[:7], "bedroom", None, [])
    assignable = prompt.split("ASSIGN ONLY THESE ITEMS")[1]
    for item_id in ids(28)[:7]:
        assert item_id in assignable
    for item_id in ids(28)[7:]:
        assert item_id not in assignable


def test_duplicate_labels_stay_distinct_in_context_without_exposing_ids():
    """Two cups must read as two separate objects, but neither may be
    given an id the model could assign."""
    labels = ["cup", "cup"] + [f"object{i}" for i in range(26)]
    prompt = build_batch_prompt(items(28, labels), ids(28)[7:14], "bedroom", None, [])
    context = prompt.split("ASSIGN ONLY THESE ITEMS")[0]

    assert "[1 of 2]" in context and "[2 of 2]" in context
    assert context.count("cup") >= 2
    for item_id in ids(28):
        assert item_id not in context


def test_prompt_lists_known_zone_names_as_reuse_suggestions():
    prompt = build_batch_prompt(items(14), ids(14)[7:], "bedroom", None, ["Wall display", "Desk"])
    assert "Wall display" in prompt and "Desk" in prompt
    assert "reuse an existing zone name" in prompt
    assert "Create a new zone only when none of the above genuinely fits." in prompt


def test_prompt_omits_zone_section_when_none_established_yet():
    prompt = build_batch_prompt(items(7), ids(7), "bedroom", None, [])
    assert "reuse an existing zone name" not in prompt


def test_prompt_marks_duplicate_labels_as_distinct_objects():
    # only the two cups share a label; the rest are unique, so exactly
    # two callouts are expected
    labels = ["cup", "cup", "lamp", "chair", "desk", "plant", "mirror"]
    prompt = build_batch_prompt(items(7, labels), ids(7), "bedroom", None, [])
    assert prompt.count("a DISTINCT object") == 2


def test_prompt_includes_operations_and_user_context():
    prompt = build_batch_prompt(items(4), ids(4), "bedroom", "i want a neat room", [])
    for op in OPERATIONS:
        assert op in prompt
    assert "i want a neat room" in prompt


def test_recovery_prompt_says_the_previous_response_was_unusable():
    normal = build_batch_prompt(items(4), ids(4), "bedroom", None, [])
    retry = build_batch_prompt(items(4), ids(4), "bedroom", None, [], unresolved_retry=True)
    assert "did not produce a usable assignment" in retry
    assert "did not produce a usable assignment" not in normal


# --- row validation ------------------------------------------------------


def test_valid_rows_all_resolve():
    parsed = json.loads(payload([row(i) for i in ids(7)]))
    v = validate_batch_rows(parsed, ids(7), set(ids(7)), repaired=False)
    assert sorted(v.resolved) == ids(7)
    assert v.unresolved == []
    assert v.issues == []


@pytest.mark.parametrize("bad_root", [None, [], "text", 42, True])
def test_root_not_object_leaves_everything_unresolved(bad_root):
    v = validate_batch_rows(bad_root, ids(7), set(ids(7)), repaired=False)
    assert v.resolved == {}
    assert v.unresolved == ids(7)
    assert issue_counts(v.issues) == {"root_not_object": 1}


@pytest.mark.parametrize("bad", [{}, {"assignments": "nope"}, {"assignments": {}}, {"other": []}])
def test_assignments_not_a_list_leaves_everything_unresolved(bad):
    v = validate_batch_rows(bad, ids(7), set(ids(7)), repaired=False)
    assert v.resolved == {}
    assert v.unresolved == ids(7)
    assert issue_counts(v.issues) == {"assignments_not_list": 1}


def test_one_malformed_row_never_discards_valid_siblings():
    """The whole point of the flat shape — a nested pydantic model would
    reject the entire response here."""
    rows = [row("item_001"), {"garbage": True}, row("item_003"), "not-a-dict", row("item_004")]
    v = validate_batch_rows(json.loads(payload(rows)), ids(4), set(ids(4)), repaired=False)
    assert sorted(v.resolved) == ["item_001", "item_003", "item_004"]
    assert v.unresolved == ["item_002"]


def test_unexpected_field_makes_only_that_row_malformed():
    rows = [row("item_001", priority="high"), row("item_002")]
    v = validate_batch_rows(json.loads(payload(rows)), ids(2), set(ids(2)), repaired=False)
    assert sorted(v.resolved) == ["item_002"]
    assert v.unresolved == ["item_001"]
    assert issue_counts(v.issues)["unexpected_field"] == 1


@pytest.mark.parametrize("bad_op", ["tidy", "KEEP_IN_PLACE", "", None, 5, "relocate "])
def test_invalid_operation_rejected(bad_op):
    rows = [{"item_id": "item_001", "operation": bad_op, "zone_name": "Z", "instruction": "i"}]
    v = validate_batch_rows(json.loads(json.dumps({"assignments": rows})), ["item_001"], {"item_001"}, repaired=False)
    if bad_op == "relocate ":  # stripped then matched — legitimately valid
        assert sorted(v.resolved) == ["item_001"]
    else:
        assert v.resolved == {}
        assert issue_counts(v.issues)["invalid_operation"] == 1


@pytest.mark.parametrize("field,kind", [("zone_name", "blank_zone_name"), ("instruction", "blank_instruction")])
@pytest.mark.parametrize("blank", ["", "   ", None, 7])
def test_blank_zone_or_instruction_rejected(field, kind, blank):
    r = row("item_001")
    r[field] = blank
    v = validate_batch_rows(json.loads(json.dumps({"assignments": [r]})), ["item_001"], {"item_001"}, repaired=False)
    assert v.resolved == {}
    assert issue_counts(v.issues)[kind] == 1


@pytest.mark.parametrize("bad_id", ["item_1", "lamp", "", None, 1, "item_abc", "ITEM_001"])
def test_malformed_item_id_rejected(bad_id):
    rows = [{"item_id": bad_id, "operation": "group", "zone_name": "Z", "instruction": "i"}]
    v = validate_batch_rows(json.loads(json.dumps({"assignments": rows})), ["item_001"], {"item_001"}, repaired=False)
    assert v.resolved == {}
    assert issue_counts(v.issues)["malformed_item_id"] == 1


def test_unknown_id_is_unexpected_and_out_of_fixture_id_is_distinguished():
    """An id that exists but belongs to another batch is a DIFFERENT
    failure from one that does not exist at all."""
    known = set(ids(28))
    rows = [row("item_001"), row("item_999"), row("item_020")]
    v = validate_batch_rows(json.loads(payload(rows)), ids(7), known, repaired=False)
    counts = issue_counts(v.issues)
    assert counts["unexpected_id"] == 1  # item_999 is not in the fixture
    assert counts["out_of_batch"] == 1  # item_020 exists but is another batch's
    assert sorted(v.resolved) == ["item_001"]


def test_duplicate_rows_trust_neither_occurrence():
    rows = [row("item_001", zone="A"), row("item_001", zone="B"), row("item_002")]
    v = validate_batch_rows(json.loads(payload(rows)), ids(2), set(ids(2)), repaired=False)
    assert sorted(v.resolved) == ["item_002"]
    assert v.unresolved == ["item_001"]
    assert issue_counts(v.issues)["duplicate_row"] == 1


def test_missing_rows_recorded_individually():
    v = validate_batch_rows(json.loads(payload([row("item_001")])), ids(3), set(ids(3)), repaired=False)
    assert v.unresolved == ["item_002", "item_003"]
    assert issue_counts(v.issues)["missing_row"] == 2


def test_repaired_flag_propagates_to_accepted_rows():
    v = validate_batch_rows(json.loads(payload([row("item_001")])), ["item_001"], {"item_001"}, repaired=True)
    assert v.resolved["item_001"].repaired is True


# --- orchestration: calls, recovery, bounds ------------------------------


def test_four_item_fixture_uses_one_call_when_all_resolve():
    chat = FakeChat([payload([row(i) for i in ids(4)])])
    p = V2Planner("phi4-mini", chat_fn=chat)
    result = run_planner_v2(items(4), "bedroom", None, p)

    assert result.llm_call_count == 1
    assert len(chat.calls) == 1
    assert sorted(result.assignments) == ids(4)
    assert all(v == "raw_valid" for v in result.validity.values())


def test_twenty_eight_item_fixture_uses_four_calls_when_all_resolve():
    batches = build_batches(ids(28))
    chat = FakeChat([payload([row(i) for i in b]) for b in batches])
    p = V2Planner("phi4-mini", chat_fn=chat)
    result = run_planner_v2(items(28), "bedroom", None, p)

    assert result.llm_call_count == 4
    assert sorted(result.assignments) == ids(28)
    assert result.validity["item_028"] == "raw_valid"


def test_unresolved_items_get_exactly_one_batched_recovery_call():
    """Two items missing from two different initial batches must be
    recovered in ONE combined call, not one call each."""
    batches = build_batches(ids(28))
    responses = []
    for i, b in enumerate(batches):
        drop = b[:1] if i < 2 else []
        responses.append(payload([row(x) for x in b if x not in drop]))
    responses.append(payload([row("item_001"), row("item_008")]))  # single recovery batch

    chat = FakeChat(responses)
    p = V2Planner("phi4-mini", chat_fn=chat)
    result = run_planner_v2(items(28), "bedroom", None, p)

    assert result.llm_call_count == 5  # 4 initial + 1 recovery
    assert result.validity["item_001"] == "recovery_used"
    assert result.validity["item_008"] == "recovery_used"
    assert sorted(result.assignments) == ids(28)
    phases = [inv["phase"] for inv in result.invocations]
    assert phases == ["initial"] * 4 + ["recovery"]


def test_recovery_is_batched_not_per_item():
    """Eight unresolved items must take two recovery calls (7 + 1), never
    eight."""
    batches = build_batches(ids(28))
    responses = [payload([row(x) for x in b[:-2]]) for b in batches]  # drop 2 per batch = 8 unresolved
    responses.append(payload([]))  # recovery batch 1 (7 items) — returns nothing
    responses.append(payload([]))  # recovery batch 2 (1 item)  — returns nothing

    chat = FakeChat(responses)
    p = V2Planner("phi4-mini", chat_fn=chat)
    result = run_planner_v2(items(28), "bedroom", None, p)

    assert result.llm_call_count == 6  # 4 initial + 2 recovery
    assert sum(1 for v in result.validity.values() if v == "still_invalid") == 8


def test_each_item_gets_at_most_one_recovery_opportunity():
    """Recovery batches PARTITION the unresolved list, so an item cannot
    appear in two recovery calls."""
    batches = build_batches(ids(28))
    responses = [payload([]) for _ in batches] + [payload([]) for _ in batches]
    chat = FakeChat(responses)
    p = V2Planner("phi4-mini", chat_fn=chat)
    run_planner_v2(items(28), "bedroom", None, p)

    recovery_prompts = [
        c["messages"][0]["content"] for c, inv in zip(chat.calls, p.invocations) if inv["phase"] == "recovery"
    ]
    seen: set[str] = set()
    for prompt in recovery_prompts:
        assignable = prompt.split("ASSIGN ONLY THESE ITEMS")[1]
        here = {i for i in ids(28) if i in assignable}
        assert not (here & seen), "an item appeared in two recovery batches"
        seen |= here


@pytest.mark.parametrize("n,max_calls", [(4, 2), (28, 8)])
def test_hard_call_bounds_are_never_exceeded(n, max_calls):
    """Worst case: nothing ever resolves."""
    n_batches = len(build_batches(ids(n)))
    chat = FakeChat([payload([]) for _ in range(n_batches * 2)])
    p = V2Planner("phi4-mini", chat_fn=chat)
    result = run_planner_v2(items(n), "bedroom", None, p)

    assert result.llm_call_count == max_calls
    assert len(chat.calls) == max_calls
    assert all(v == "still_invalid" for v in result.validity.values())


def test_still_invalid_items_are_recorded_not_hidden():
    chat = FakeChat([payload([row("item_001")]), payload([])])
    p = V2Planner("phi4-mini", chat_fn=chat)
    result = run_planner_v2(items(4), "bedroom", None, p)

    assert result.validity["item_001"] == "raw_valid"
    for missing in ["item_002", "item_003", "item_004"]:
        assert result.validity[missing] == "still_invalid"
    assert "item_002" not in result.assignments


def test_a_failed_call_does_not_abort_sibling_batches():
    batches = build_batches(ids(28))
    responses = [ConnectionError("boom")] + [payload([row(x) for x in b]) for b in batches[1:]]
    responses.append(payload([row(x) for x in batches[0]]))  # recovery rescues batch 1
    chat = FakeChat(responses)
    p = V2Planner("phi4-mini", chat_fn=chat)
    result = run_planner_v2(items(28), "bedroom", None, p)

    assert result.call_failed is True
    assert sorted(result.assignments) == ids(28)
    assert issue_counts(result.issues)["call_failed"] == 1


def test_call_error_detail_is_sanitised():
    leaky = "http://secret-host/api/chat token=ghp_FAKE item_001 painting"
    chat = FakeChat([ConnectionError(leaky), payload([])])
    p = V2Planner("phi4-mini", chat_fn=chat)
    result = run_planner_v2(items(4), "bedroom", None, p)

    blob = json.dumps([{"kind": i.kind, "detail": i.detail} for i in result.issues] + result.invocations)
    for fragment in ["secret-host", "ghp_FAKE", "/api/chat", "painting"]:
        assert fragment not in blob


def test_transport_never_sends_schema_mode_and_forwards_bounds():
    chat = FakeChat([payload([row(i) for i in ids(4)])])
    p = V2Planner("phi4-mini", chat_fn=chat, seed=11)
    run_planner_v2(items(4), "bedroom", None, p)

    call = chat.calls[0]
    assert "format" not in call  # plain JSON only
    assert call["options"]["seed"] == 11
    assert call["options"]["num_predict"] == p.num_predict
    assert p.invocations[0]["timeout_s"] == p.timeout_s
    assert p.invocations[0]["format_sent"] is False


# --- merge ---------------------------------------------------------------


def _accepted(item_id: str, zone: str, operation="group", instruction="do it") -> AcceptedRow:
    return AcceptedRow(item_id=item_id, operation=operation, zone_name=zone, instruction=instruction, repaired=False)


def test_merge_groups_zone_names_case_insensitively_keeping_first_casing():
    assignments = {
        "item_001": _accepted("item_001", "Wall Display"),
        "item_002": _accepted("item_002", "wall display"),
        "item_003": _accepted("item_003", "  WALL DISPLAY  "),
    }
    plan = merge_assignments(items(3), assignments, "bedroom", None)

    assert len(plan.zones) == 1
    assert plan.zones[0].zone_name == "Wall Display"  # first occurrence wins
    assert plan.zones[0].item_ids == ["item_001", "item_002", "item_003"]


def test_merge_orders_zones_by_first_appearance_and_items_by_analysis_order():
    assignments = {
        "item_003": _accepted("item_003", "Desk"),
        "item_001": _accepted("item_001", "Wall"),
        "item_004": _accepted("item_004", "Wall"),
        "item_002": _accepted("item_002", "Desk"),
    }
    plan = merge_assignments(items(4), assignments, "bedroom", None)

    assert [z.zone_name for z in plan.zones] == ["Wall", "Desk"]  # item_001 seen first
    assert plan.zones[0].item_ids == ["item_001", "item_004"]
    assert plan.zones[1].item_ids == ["item_002", "item_003"]


def test_merge_places_unassigned_items_in_keep_in_place():
    assignments = {"item_001": _accepted("item_001", "Wall")}
    plan = merge_assignments(items(4), assignments, "bedroom", None)

    keep = [z for z in plan.zones if z.zone_name == KEEP_IN_PLACE_ZONE_NAME]
    assert len(keep) == 1
    assert keep[0].item_ids == ["item_002", "item_003", "item_004"]


def test_merge_folds_unassigned_into_an_existing_keep_in_place_zone():
    assignments = {
        "item_001": _accepted("item_001", "keep in place"),  # different casing
        "item_002": _accepted("item_002", "Wall"),
    }
    plan = merge_assignments(items(4), assignments, "bedroom", None)

    keeps = [z for z in plan.zones if z.zone_name.strip().lower() == KEEP_IN_PLACE_ZONE_NAME.lower()]
    assert len(keeps) == 1  # merged, not duplicated
    assert keeps[0].item_ids == ["item_001", "item_003", "item_004"]


def test_merged_plan_always_satisfies_production_invariants():
    """Coverage is exact and the partition holds BY CONSTRUCTION — the
    production validator should never be the thing that catches a bug."""
    assignments = {i: _accepted(i, f"Zone {n % 3}") for n, i in enumerate(ids(28))}
    plan = merge_assignments(items(28), assignments, "bedroom", "i want a neat room")

    assert isinstance(plan, ReorganisePlan)
    planned = [i for z in plan.zones for i in z.item_ids]
    assert sorted(planned) == ids(28)
    assert len(planned) == len(set(planned))
    names = [z.zone_name.strip().lower() for z in plan.zones]
    assert len(names) == len(set(names))
    assert all(z.item_ids for z in plan.zones)


def test_merge_with_no_assignments_puts_everything_in_keep_in_place():
    plan = merge_assignments(items(4), {}, "bedroom", None)
    assert len(plan.zones) == 1
    assert plan.zones[0].zone_name == KEEP_IN_PLACE_ZONE_NAME
    assert plan.zones[0].item_ids == ids(4)


def test_operation_is_not_written_into_the_production_plan_schema():
    """Storing it would be a production schema change."""
    assignments = {"item_001": _accepted("item_001", "Wall", operation="relocate")}
    plan = merge_assignments(items(1), assignments, "bedroom", None)
    assert "operation" not in plan.model_dump()
    assert all("operation" not in z.model_dump() for z in plan.zones)


def test_image_prompt_is_deterministic_and_excludes_model_instruction_text():
    assignments = {
        "item_001": _accepted("item_001", "Wall", instruction="MODEL_PROSE_SHOULD_NOT_APPEAR"),
    }
    plan = merge_assignments(items(2), assignments, "bedroom", "i want a neat room")

    assert "MODEL_PROSE_SHOULD_NOT_APPEAR" not in plan.image_prompt
    assert "bedroom" in plan.image_prompt
    assert "i want a neat room" in plan.image_prompt
    assert plan.image_prompt == merge_assignments(items(2), assignments, "bedroom", "i want a neat room").image_prompt


def test_duplicate_labels_stay_independent_through_the_whole_flow():
    labels = ["cup", "cup", "lamp", "lamp"]
    assignments = {
        "item_001": _accepted("item_001", "Shelf"),
        "item_002": _accepted("item_002", "Desk"),
        "item_003": _accepted("item_003", "Shelf"),
        "item_004": _accepted("item_004", "Desk"),
    }
    plan = merge_assignments(items(4, labels), assignments, "bedroom", None)

    by_zone = {z.zone_name: z.item_ids for z in plan.zones}
    assert by_zone["Shelf"] == ["item_001", "item_003"]
    assert by_zone["Desk"] == ["item_002", "item_004"]


# --- import boundary -----------------------------------------------------


def test_importing_reorganise_v2_loads_no_model_stack():
    """Fresh interpreter: importing the module must not pull in torch,
    CLIP, Grounding DINO, ollama or the production Reorganise planner."""
    code = (
        "import sys\n"
        "import evaluation.scripts.reorganise_v2\n"
        "heavy = {'torch', 'clip', 'transformers', 'ollama', 'groundingdino',\n"
        "         'app.models.grounding_dino', 'app.models.clip_scene',\n"
        "         'app.models.reorganise_llm', 'app.models.mistral_llm'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR))
    assert result.returncode == 0, result.stdout + result.stderr


# ============ hardening regressions: phases and zone instructions ========


def test_issues_are_tagged_with_their_phase():
    """Without a phase, initial and recovery failures collapse into one
    total and any metric named initial_* silently includes recovery."""
    batches = build_batches(ids(28))
    responses = [payload([row(x) for x in b[:-1]]) for b in batches]  # 1 missing per batch
    responses.append(payload([]))  # recovery resolves nothing
    p = V2Planner("phi4-mini", chat_fn=FakeChat(responses))
    result = run_planner_v2(items(28), "bedroom", None, p)

    phases = {i.phase for i in result.issues}
    assert phases == {"initial", "recovery"}
    assert issue_counts(result.issues, phase="initial")["missing_row"] == 4
    assert issue_counts(result.issues, phase="recovery")["missing_row"] == 4
    # unfiltered is the combined total — which is exactly why the
    # per-phase counts must be reported separately
    assert issue_counts(result.issues)["missing_row"] == 8


def test_phase_filter_excludes_the_other_phase():
    batches = build_batches(ids(28))
    responses = [payload([row(x) for x in b]) for b in batches[:3]]
    responses.append(payload([]))  # batch 4 returns nothing
    responses.append(payload([row(x) for x in batches[3]]))  # recovery fixes it
    p = V2Planner("phi4-mini", chat_fn=FakeChat(responses))
    result = run_planner_v2(items(28), "bedroom", None, p)

    assert issue_counts(result.issues, phase="initial").get("missing_row") == 7
    assert issue_counts(result.issues, phase="recovery") == {}
    assert all(v == "recovery_used" for i, v in result.validity.items() if i in batches[3])


def test_zone_instruction_represents_every_merged_row():
    """Keeping only the first row's instruction discarded most of the
    model's output whenever items merged into one zone."""
    labels = ["lamp", "cup", "chair"]
    assignments = {
        "item_001": _accepted("item_001", "Shelf", instruction="Straighten the lamp"),
        "item_002": _accepted("item_002", "Shelf", instruction="Stack the cup"),
        "item_003": _accepted("item_003", "Shelf", instruction="Tuck the chair in"),
    }
    plan = merge_assignments(items(3, labels), assignments, "bedroom", None)

    assert len(plan.zones) == 1
    text = plan.zones[0].instruction
    for fragment in ["Straighten the lamp", "Stack the cup", "Tuck the chair in"]:
        assert fragment in text
    for label in labels:
        assert f"{label}:" in text


def test_zone_instruction_is_ordered_by_analysis_order_and_deterministic():
    labels = ["lamp", "cup", "chair"]
    assignments = {
        "item_003": _accepted("item_003", "Shelf", instruction="third"),
        "item_001": _accepted("item_001", "Shelf", instruction="first"),
        "item_002": _accepted("item_002", "Shelf", instruction="second"),
    }
    plan = merge_assignments(items(3, labels), assignments, "bedroom", None)
    text = plan.zones[0].instruction

    assert text.index("first") < text.index("second") < text.index("third")
    assert text == merge_assignments(items(3, labels), assignments, "bedroom", None).zones[0].instruction


def test_zone_instruction_for_a_pure_keep_in_place_zone_is_non_blank():
    plan = merge_assignments(items(3), {}, "bedroom", None)
    assert plan.zones[0].instruction.strip()


def test_fallback_only_keep_zone_attributes_nothing_to_an_individual_item():
    """Regression: pairing the id list with the instruction list by
    position gave the zone's generic sentence to whichever item happened
    to sit first ("lamp: Leave these items where they are.") and left
    every other item in the zone unmentioned. No item authored that
    sentence, so no item's label may front it."""
    labels = ["lamp", "cup", "chair"]
    plan = merge_assignments(items(3, labels), {}, "bedroom", None)

    zone = plan.zones[0]
    assert zone.zone_name == KEEP_IN_PLACE_ZONE_NAME
    assert zone.item_ids == ids(3)
    assert zone.instruction == "Leave these items where they are."
    assert not any(f"{label}:" in zone.instruction for label in labels)


def test_mixed_keep_zone_states_its_fallback_items_instead_of_dropping_them():
    """Regression: with one validated Keep row and two absorbed items,
    the id list outgrew the instruction list, so the two fallback items
    vanished from the instruction while still appearing in item_ids — a
    reviewer would see three ids and prose covering one."""
    labels = ["lamp", "cup", "chair"]
    assignments = {
        "item_001": _accepted("item_001", KEEP_IN_PLACE_ZONE_NAME, instruction="Straighten the lamp"),
    }
    plan = merge_assignments(items(3, labels), assignments, "bedroom", None)

    zone = plan.zones[0]
    assert zone.item_ids == ids(3)
    text = zone.instruction
    assert "lamp: Straighten the lamp." in text
    # The absorbed items are named, and named as unstated — neither one
    # is handed the lamp's sentence.
    assert "Leave the remaining items where they are: cup, chair." in text
    assert "cup: Straighten the lamp" not in text
    assert "chair: Straighten the lamp" not in text
    assert text.count("Straighten the lamp") == 1


def test_mixed_keep_zone_keeps_every_assigned_instruction_with_its_own_item():
    """The absorbed item sits BETWEEN two validated rows in analysis
    order, which is exactly where positional pairing shifts a sentence
    onto the wrong object."""
    labels = ["lamp", "cup", "chair"]
    assignments = {
        "item_001": _accepted("item_001", KEEP_IN_PLACE_ZONE_NAME, instruction="Straighten the lamp"),
        "item_003": _accepted("item_003", KEEP_IN_PLACE_ZONE_NAME, instruction="Tuck the chair in"),
    }
    plan = merge_assignments(items(3, labels), assignments, "bedroom", None)

    text = plan.zones[0].instruction
    assert "lamp: Straighten the lamp." in text
    assert "chair: Tuck the chair in." in text
    assert "cup:" not in text  # owns no row, so authors no sentence
    assert "Leave the remaining items where they are: cup." in text


def test_fallback_items_never_borrow_an_instruction_from_another_zone():
    """A validated row in some other zone must not leak into the
    Keep-in-place zone the absorbed items land in."""
    labels = ["lamp", "cup", "chair"]
    assignments = {"item_002": _accepted("item_002", "Shelf", instruction="Stack the cup")}
    plan = merge_assignments(items(3, labels), assignments, "bedroom", None)

    by_name = {z.zone_name: z for z in plan.zones}
    assert by_name["Shelf"].item_ids == ["item_002"]
    assert by_name["Shelf"].instruction == "cup: Stack the cup."
    keep = by_name[KEEP_IN_PLACE_ZONE_NAME]
    assert keep.item_ids == ["item_001", "item_003"]
    assert keep.instruction == "Leave these items where they are."
    assert "Stack the cup" not in keep.instruction


def test_every_item_in_a_zone_is_represented_in_its_instruction():
    """Whole-plan invariant behind the two regressions: an id in a zone
    is either the subject of its own sentence or named as left in place.
    Silence about an id is the failure mode. The one exception is a zone
    where NO item owns a row — there the single generic sentence covers
    the whole zone and singling out one label would be the bug."""
    # Equal-length labels: no label is a substring of another, so an
    # "is it mentioned" check cannot pass by accident.
    labels = [f"object{i:02d}" for i in range(28)]
    assignments = {
        i: _accepted(i, "Shelf" if n % 2 else KEEP_IN_PLACE_ZONE_NAME, instruction=f"do {i}")
        for n, i in enumerate(ids(28)[:20])
    }
    plan = merge_assignments(items(28, labels), assignments, "bedroom", None)

    by_id = {item.item_id: item for item in items(28, labels)}
    covered_by_a_generic_zone = 0
    for zone in plan.zones:
        if not any(i in assignments for i in zone.item_ids):
            assert zone.instruction == "Leave these items where they are."
            covered_by_a_generic_zone += len(zone.item_ids)
            continue
        for item_id in zone.item_ids:
            assert by_id[item_id].effective_label in zone.instruction
            if item_id in assignments:
                assert f"{by_id[item_id].effective_label}: do {item_id}." in zone.instruction
    # The 8 unassigned items land in the Keep zone that already holds
    # validated rows, so this run exercises the MIXED shape throughout —
    # the generic-zone branch above is asserted for real by
    # test_fallback_only_keep_zone_attributes_nothing_to_an_individual_item.
    assert covered_by_a_generic_zone == 0


def test_zone_instruction_still_satisfies_the_production_schema():
    """ReorganiseZone.instruction is NonEmptyStr — a merged instruction
    must never come out blank."""
    assignments = {i: _accepted(i, "Shelf", instruction="do a thing") for i in ids(28)}
    plan = merge_assignments(items(28), assignments, "bedroom", None)
    assert all(z.instruction.strip() for z in plan.zones)
