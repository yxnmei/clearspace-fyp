"""
Tests for evaluation/scripts/compare_reorganise_planning.py.

Fakes only — every planner in this file is constructed with an injected
fake chat function, so no test can reach a real Ollama call, a real
model, or the network. The real transport (make_ollama_chat_fn /
default_planner_factory) is never invoked here.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.core.reorganise_schemas import KEEP_IN_PLACE_ZONE_NAME, ReorganisePlan
from app.core.schemas import DetectedItem
from evaluation.scripts import compare_reorganise_planning as harness

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_FIXTURES_DIR = _BACKEND_DIR / "evaluation" / "fixtures"
_SIMPLE = _FIXTURES_DIR / "reorganise_simple.json"
_CROWDED = _FIXTURES_DIR / "reorganise_bedroom02_28items.json"


# --- fakes ---------------------------------------------------------------


class FakeChat:
    """Stands in for ollama.Client.chat. Records every call's kwargs and
    replays a scripted sequence.

    Each scripted entry may be:
      - an exception  -> raised (transport failure)
      - a str         -> wrapped as a well-formed {"message": {"content": ...}}
      - anything else -> returned verbatim, so a test can script a
                         MALFORMED response shape exactly as the real
                         client would hand it back.
    """

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


class FakeTimeout(TimeoutError):
    """A timeout-shaped exception, for classify_call_error()."""


def _plan_text(item_ids, n_zones=1, image_prompt="a tidy bedroom") -> str:
    ids = list(item_ids)
    if n_zones == 1:
        zones = [{"zone_name": KEEP_IN_PLACE_ZONE_NAME, "item_ids": ids, "instruction": "keep here"}]
    else:
        chunk = max(1, len(ids) // n_zones)
        zones = []
        for i in range(n_zones):
            part = ids[i * chunk :] if i == n_zones - 1 else ids[i * chunk : (i + 1) * chunk]
            if part:
                zones.append({"zone_name": f"Zone {i + 1}", "item_ids": part, "instruction": f"do thing {i + 1}"})
    return json.dumps({"zones": zones, "image_prompt": image_prompt})


def _factory(chat_fn, **planner_kwargs):
    """A planner factory matching the harness's expected signature, always
    fake-backed."""

    def _make(model_name, mode, seed):
        return harness.EvalPlanner(model_name, mode, chat_fn=chat_fn, seed=seed, **planner_kwargs)

    return _make


@pytest.fixture
def simple_fixture():
    return harness.load_fixture(_SIMPLE)


@pytest.fixture
def crowded_fixture():
    return harness.load_fixture(_CROWDED)


# --- fixture loading -----------------------------------------------------


def test_both_shipped_fixtures_load(simple_fixture, crowded_fixture):
    assert len(simple_fixture.items) == 4
    assert len(crowded_fixture.items) == 28
    assert crowded_fixture.scene_label == "bedroom"
    assert crowded_fixture.user_context == "i want a neat room"
    # The simple fixture deliberately exercises the no-context branch.
    assert simple_fixture.user_context is None


def test_crowded_fixture_has_exact_captured_ids_in_order(crowded_fixture):
    assert crowded_fixture.item_ids == [f"item_{n:03d}" for n in range(1, 29)]
    assert [i.source_detection_index for i in crowded_fixture.items] == list(range(28))


def test_crowded_fixture_preserves_duplicate_labels_independently(crowded_fixture):
    by_id = {i.item_id: i.effective_label for i in crowded_fixture.items}
    frames = [k for k, v in by_id.items() if v == "picture frame"]
    assert frames == ["item_004", "item_006", "item_007", "item_008", "item_009", "item_012"]
    assert [k for k, v in by_id.items() if v == "toy"] == ["item_013", "item_015"]
    assert [k for k, v in by_id.items() if v == "cup"] == ["item_026", "item_027"]


def test_crowded_fixture_captured_labels_sizes_positions(crowded_fixture):
    first, last = crowded_fixture.items[0], crowded_fixture.items[-1]
    assert (first.effective_label, first.relative_size, first.position) == ("painting", "medium", "upper-left")
    assert (last.effective_label, last.relative_size, last.position) == ("bin", "small", "lower-left")
    # raw_phrase == clean_label == effective_label for every captured item
    for item in crowded_fixture.items:
        assert item.raw_phrase == item.clean_label == item.effective_label
        assert item.item_role == "actionable"


def test_fixture_documents_reconstructed_fields(crowded_fixture):
    prov = crowded_fixture.provenance
    assert set(prov["reconstructed"]) == {"box", "confidence"}
    for field in ("item_id", "position", "relative_size", "clean_label"):
        assert field in prov["captured_from_real_run"]


def test_load_fixture_rejects_duplicate_item_ids(tmp_path):
    raw = json.loads(_SIMPLE.read_text(encoding="utf-8"))
    raw["items"][1]["item_id"] = raw["items"][0]["item_id"]
    path = tmp_path / "dupe.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate item_id"):
        harness.load_fixture(path)


@pytest.mark.parametrize("missing_key", ["fixture_name", "scene_label", "user_context", "items"])
def test_load_fixture_rejects_missing_required_key(tmp_path, missing_key):
    raw = json.loads(_SIMPLE.read_text(encoding="utf-8"))
    del raw[missing_key]
    path = tmp_path / "missing.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match=f"missing required key '{missing_key}'"):
        harness.load_fixture(path)


def test_load_fixture_rejects_invalid_detected_item(tmp_path):
    raw = json.loads(_SIMPLE.read_text(encoding="utf-8"))
    raw["items"][0]["box"] = {"x1": 0.9, "y1": 0.1, "x2": 0.2, "y2": 0.3}  # inverted
    path = tmp_path / "badbox.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match="not a valid DetectedItem"):
        harness.load_fixture(path)


def test_load_fixture_rejects_blank_scene_label_and_empty_items(tmp_path):
    raw = json.loads(_SIMPLE.read_text(encoding="utf-8"))
    raw["scene_label"] = "   "
    p1 = tmp_path / "blank.json"
    p1.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError, match="scene_label must be a non-blank string"):
        harness.load_fixture(p1)

    raw2 = json.loads(_SIMPLE.read_text(encoding="utf-8"))
    raw2["items"] = []
    p2 = tmp_path / "empty.json"
    p2.write_text(json.dumps(raw2), encoding="utf-8")
    with pytest.raises(ValueError, match="items must be a non-empty list"):
        harness.load_fixture(p2)


# --- reconstructed fields cannot influence the production prompt ----------


def test_reconstructed_box_and_confidence_do_not_change_the_production_prompt(crowded_fixture):
    """The whole justification for synthetic boxes: build_reorganise_plan_prompt()
    reads item_id/effective_label/relative_size/position only, so changing
    the reconstructed fields must leave the prompt byte-identical."""
    from app.models.reorganise_llm import build_reorganise_plan_prompt

    original = build_reorganise_plan_prompt(
        crowded_fixture.items, crowded_fixture.scene_label, crowded_fixture.user_context
    )

    mutated = [
        DetectedItem.model_validate(
            {
                **item.model_dump(exclude={"label_source", "effective_label"}),
                "box": {"x1": 0.11, "y1": 0.12, "x2": 0.33, "y2": 0.34},
                "confidence": 0.99,
            }
        )
        for item in crowded_fixture.items
    ]
    after = build_reorganise_plan_prompt(mutated, crowded_fixture.scene_label, crowded_fixture.user_context)

    assert original == after
    assert "0.99" not in original
    assert "item_001" in original and "painting" in original


# --- transport: plain vs schema, forwarding -------------------------------


def test_plain_mode_omits_format_entirely(simple_fixture):
    chat = FakeChat([_plan_text(simple_fixture.item_ids)])
    planner = harness.EvalPlanner("phi4-mini", "plain", chat_fn=chat)
    planner(
        run_id="r",
        selected_items=simple_fixture.items,
        scene_label=simple_fixture.scene_label,
        user_context=None,
    )
    assert "format" not in chat.calls[0]


def test_schema_mode_passes_the_production_schema_unchanged(simple_fixture):
    chat = FakeChat([_plan_text(simple_fixture.item_ids)])
    planner = harness.EvalPlanner("phi4-mini", "schema", chat_fn=chat)
    planner(
        run_id="r",
        selected_items=simple_fixture.items,
        scene_label=simple_fixture.scene_label,
        user_context=None,
    )
    sent = chat.calls[0]["format"]
    assert sent == ReorganisePlan.model_json_schema()
    # Honest test of the production schema: refs and descriptions are NOT
    # pre-emptively rewritten away.
    assert "$defs" in sent
    assert any("description" in v for v in sent["$defs"].values())


def test_model_options_seed_and_timeout_are_forwarded_and_recorded(simple_fixture):
    chat = FakeChat([_plan_text(simple_fixture.item_ids)])
    planner = harness.EvalPlanner("qwen3:8b", "plain", chat_fn=chat, seed=22)
    planner(
        run_id="r",
        selected_items=simple_fixture.items,
        scene_label=simple_fixture.scene_label,
        user_context=None,
    )
    call = chat.calls[0]
    assert call["model"] == "qwen3:8b"
    assert call["options"]["seed"] == 22
    assert call["options"]["num_predict"] == harness.NUM_PREDICT == 1536
    assert call["options"]["temperature"] == 0.2
    assert planner.invocations[0]["timeout_s"] == harness.REQUEST_TIMEOUT_S == 210.0
    assert planner.invocations[0]["seed"] == 22


def test_seed_is_omitted_from_options_when_not_set(simple_fixture):
    chat = FakeChat([_plan_text(simple_fixture.item_ids)])
    planner = harness.EvalPlanner("mistral", "plain", chat_fn=chat, seed=None)
    planner(
        run_id="r",
        selected_items=simple_fixture.items,
        scene_label=simple_fixture.scene_label,
        user_context=None,
    )
    assert "seed" not in chat.calls[0]["options"]


def test_unknown_mode_is_rejected():
    with pytest.raises(ValueError, match="mode must be one of"):
        harness.EvalPlanner("phi4-mini", "grammar", chat_fn=FakeChat([]))  # type: ignore[arg-type]


# --- timeout classification, no retry -------------------------------------


def test_timeout_is_classified_and_never_retried(simple_fixture):
    chat = FakeChat([FakeTimeout("read timed out")])
    planner = harness.EvalPlanner("phi4-mini", "plain", chat_fn=chat)
    with pytest.raises(harness.PlannerCallError) as exc_info:
        planner(
            run_id="r",
            selected_items=simple_fixture.items,
            scene_label=simple_fixture.scene_label,
            user_context=None,
        )
    assert exc_info.value.kind == "timeout"
    assert len(chat.calls) == 1  # no retry at the harness layer
    assert planner.invocations[0]["error_kind"] == "timeout"


def test_non_timeout_failure_is_classified_as_call_failed(simple_fixture):
    chat = FakeChat([ConnectionError("connection refused")])
    planner = harness.EvalPlanner("phi4-mini", "plain", chat_fn=chat)
    with pytest.raises(harness.PlannerCallError) as exc_info:
        planner(
            run_id="r",
            selected_items=simple_fixture.items,
            scene_label=simple_fixture.scene_label,
            user_context=None,
        )
    assert exc_info.value.kind == "call_failed"


def test_error_detail_is_bounded_and_excludes_the_exception_text(simple_fixture):
    chat = FakeChat([ConnectionError("x" * 5000)])
    planner = harness.EvalPlanner("phi4-mini", "plain", chat_fn=chat)
    with pytest.raises(harness.PlannerCallError) as exc_info:
        planner(
            run_id="r",
            selected_items=simple_fixture.items,
            scene_label=simple_fixture.scene_label,
            user_context=None,
        )
    detail = exc_info.value.detail
    assert len(detail) <= harness._MAX_ERROR_DETAIL_LENGTH
    assert "ConnectionError" in detail  # the type is safe to record
    assert "xxxx" not in detail  # the message is not
    assert "item_001" not in detail  # never echoes the prompt back


@pytest.mark.parametrize(
    "exc,expected",
    [
        (TimeoutError("x"), "timeout"),
        (FakeTimeout("x"), "timeout"),
        (ConnectionError("x"), "call_failed"),
        (ValueError("x"), "call_failed"),
    ],
)
def test_classify_call_error(exc, expected):
    assert harness.classify_call_error(exc) == expected


# --- metrics --------------------------------------------------------------


def test_id_accounting_exact_coverage(crowded_fixture):
    parsed = json.loads(_plan_text(crowded_fixture.item_ids, n_zones=4))
    acc = harness.id_accounting(parsed, crowded_fixture.item_ids)
    assert acc["coverage_exact"] is True
    assert acc["missing_ids"] == [] and acc["unexpected_ids"] == [] and acc["duplicate_ids"] == []


def test_id_accounting_reports_missing_unexpected_and_duplicates(crowded_fixture):
    parsed = {
        "zones": [
            {"zone_name": "A", "item_ids": ["item_001", "item_002"], "instruction": "x"},
            {"zone_name": "B", "item_ids": ["item_002", "item_999"], "instruction": "y"},
        ],
        "image_prompt": "p",
    }
    acc = harness.id_accounting(parsed, crowded_fixture.item_ids)
    assert acc["duplicate_ids"] == ["item_002"]
    assert acc["unexpected_ids"] == ["item_999"]
    assert "item_028" in acc["missing_ids"]
    assert acc["coverage_exact"] is False


def test_id_accounting_survives_unusable_shapes():
    for parsed in (None, [], "nope", {"zones": "not-a-list"}, {}):
        acc = harness.id_accounting(parsed, ["item_001"])
        assert acc["coverage_exact"] is False
        assert acc["missing_ids"] == ["item_001"]


def test_is_trivial_plan_detects_single_zone_holding_everything(crowded_fixture):
    trivial = json.loads(_plan_text(crowded_fixture.item_ids, n_zones=1))
    assert harness.is_trivial_plan(trivial, crowded_fixture.item_ids) is True

    spread = json.loads(_plan_text(crowded_fixture.item_ids, n_zones=4))
    assert harness.is_trivial_plan(spread, crowded_fixture.item_ids) is False


def test_manual_review_fields_are_present_and_unscored():
    block = harness.manual_review_block()
    for key in (
        "meaningful_zones_instructions",
        "actionable_improvement",
        "user_context_adherence",
        "no_invented_items_or_architecture",
        "understandable_non_contradictory",
    ):
        assert key in block and block[key] is None


# --- screening ------------------------------------------------------------


def test_screen_case_uses_exactly_one_invocation(simple_fixture):
    chat = FakeChat([_plan_text(simple_fixture.item_ids)])
    case = harness.evaluate_screen_case(
        simple_fixture, "phi4-mini", "plain", _factory(chat), apply_trivial_gate=False
    )
    assert len(chat.calls) == 1
    assert case["attempts"] == 1
    assert case["passed_gates"] is True
    assert case["semantic_valid"] is True
    assert case["coverage_exact"] is True
    assert case["raw_response"] is not None
    assert case["manual_review"]["actionable_improvement"] is None


def test_screen_case_records_bounds_on_every_result(simple_fixture):
    chat = FakeChat([_plan_text(simple_fixture.item_ids)])
    case = harness.evaluate_screen_case(
        simple_fixture, "phi4-mini", "plain", _factory(chat), apply_trivial_gate=False
    )
    assert case["timeout_s"] == 210.0
    assert case["num_predict"] == 1536
    assert case["options"]["num_predict"] == 1536


def test_screen_case_invalid_json_fails_gates(simple_fixture):
    chat = FakeChat(["this is not json at all"])
    case = harness.evaluate_screen_case(
        simple_fixture, "phi4-mini", "plain", _factory(chat), apply_trivial_gate=False
    )
    assert case["syntactic_valid"] is False
    assert case["semantic_valid"] is False
    assert "syntactic_invalid" in case["gate_failures"]
    assert case["passed_gates"] is False
    assert case["raw_response"] == "this is not json at all"  # raw retained


def test_screen_case_timeout_is_recorded_without_retry(simple_fixture):
    chat = FakeChat([FakeTimeout("too slow")])
    case = harness.evaluate_screen_case(
        simple_fixture, "phi4-mini", "plain", _factory(chat), apply_trivial_gate=False
    )
    assert case["error_kind"] == "timeout"
    assert case["passed_gates"] is False
    assert len(chat.calls) == 1


def test_trivial_gate_applies_to_crowded_but_not_simple(crowded_fixture, simple_fixture):
    crowded_chat = FakeChat([_plan_text(crowded_fixture.item_ids, n_zones=1)])
    crowded_case = harness.evaluate_screen_case(
        crowded_fixture, "phi4-mini", "plain", _factory(crowded_chat), apply_trivial_gate=True
    )
    assert crowded_case["semantic_valid"] is True  # syntactically/semantically fine...
    assert crowded_case["is_trivial_plan"] is True  # ...but useless
    assert "trivial_plan" in crowded_case["gate_failures"]
    assert crowded_case["passed_gates"] is False

    simple_chat = FakeChat([_plan_text(simple_fixture.item_ids, n_zones=1)])
    simple_case = harness.evaluate_screen_case(
        simple_fixture, "phi4-mini", "plain", _factory(simple_chat), apply_trivial_gate=False
    )
    assert simple_case["is_trivial_plan"] is None
    assert simple_case["passed_gates"] is True


def test_latency_gate_failure_is_recorded(simple_fixture, monkeypatch):
    chat = FakeChat([_plan_text(simple_fixture.item_ids)])
    clock = iter([0.0, 500.0, 500.0, 500.0])
    monkeypatch.setattr(harness.time, "perf_counter", lambda: next(clock))
    case = harness.evaluate_screen_case(
        simple_fixture, "phi4-mini", "plain", _factory(chat), apply_trivial_gate=False
    )
    assert case["latency_s"] > harness.LATENCY_GATE_S
    assert "latency_gate" in case["gate_failures"]
    assert case["passed_gates"] is False


def test_run_screen_eliminates_early_and_never_reaches_the_crowded_fixture(simple_fixture, crowded_fixture):
    """Every pair fails the simple fixture, so zero crowded calls happen."""
    chat = FakeChat(["garbage"] * 8)
    report = harness.run_screen(simple_fixture, crowded_fixture, _factory(chat))
    assert len(report["simple_cases"]) == 8
    assert report["crowded_cases"] == []
    assert report["survivors"] == []
    assert len(chat.calls) == 8  # simple only — no crowded invocations


def test_run_screen_advances_only_survivors_to_the_crowded_fixture(simple_fixture, crowded_fixture):
    """First pair passes simple, the other seven fail: exactly one crowded
    call is made, and only for that pair."""
    good_simple = _plan_text(simple_fixture.item_ids)
    good_crowded = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat([good_simple] + ["garbage"] * 7 + [good_crowded])
    report = harness.run_screen(simple_fixture, crowded_fixture, _factory(chat))

    assert len(report["simple_cases"]) == 8
    assert len(report["crowded_cases"]) == 1
    assert report["crowded_cases"][0]["model"] == harness.CANDIDATE_MODELS[0]
    assert report["crowded_cases"][0]["mode"] == "plain"
    assert report["survivors"] == [{"model": harness.CANDIDATE_MODELS[0], "mode": "plain"}]
    assert len(chat.calls) == 9  # 8 simple + 1 crowded


def test_run_screen_covers_all_four_models_and_both_modes(simple_fixture, crowded_fixture):
    chat = FakeChat(["garbage"] * 8)
    report = harness.run_screen(simple_fixture, crowded_fixture, _factory(chat))
    pairs = {(c["model"], c["mode"]) for c in report["simple_cases"]}
    assert pairs == {(m, mo) for m in harness.CANDIDATE_MODELS for mo in harness.MODES}
    assert set(harness.CANDIDATE_MODELS) == {"phi4-mini", "qwen3:8b", "mistral", "gemma2:2b"}


def test_run_screen_writes_incrementally_to_a_temp_path(simple_fixture, crowded_fixture, tmp_path):
    out = tmp_path / "nested" / "screen.json"
    saves: list[int] = []

    def _save(report):
        harness._writer(out)(report)
        saves.append(len(report["simple_cases"]))

    chat = FakeChat(["garbage"] * 8)
    harness.run_screen(simple_fixture, crowded_fixture, _factory(chat), save=_save)

    assert out.exists()
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["status"] == "complete"
    assert len(written["simple_cases"]) == 8
    # saved progressively, not only once at the end
    assert saves[0] == 0 and saves[-1] == 8 and len(saves) > 2


# --- stability ------------------------------------------------------------


def test_stability_rejects_more_than_two_finalists(crowded_fixture):
    chat = FakeChat([])
    finalists = [("phi4-mini", "plain"), ("qwen3:8b", "plain"), ("mistral", "plain")]
    with pytest.raises(ValueError, match="at most 2 finalists"):
        harness.run_stability(crowded_fixture, finalists, _factory(chat))


def test_stability_requires_explicit_finalists(crowded_fixture):
    with pytest.raises(ValueError, match="at least one explicit finalist"):
        harness.run_stability(crowded_fixture, [], _factory(FakeChat([])))


def test_stability_rejects_duplicate_finalists(crowded_fixture):
    finalists = [("phi4-mini", "plain"), ("phi4-mini", "plain")]
    with pytest.raises(ValueError, match="must be distinct"):
        harness.run_stability(crowded_fixture, finalists, _factory(FakeChat([])))


def test_stability_uses_three_distinct_predetermined_seeds(crowded_fixture):
    assert harness.STABILITY_SEEDS == (11, 22, 33)
    assert len(set(harness.STABILITY_SEEDS)) == 3

    good = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat([good, good, good])
    report = harness.run_stability(crowded_fixture, [("phi4-mini", "schema")], _factory(chat))

    assert [c["seed"] for c in report["cases"]] == [11, 22, 33]
    assert [call["options"]["seed"] for call in chat.calls] == [11, 22, 33]


def test_stability_single_attempt_when_the_initial_plan_is_valid(crowded_fixture):
    good = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat([good, good, good])
    report = harness.run_stability(crowded_fixture, [("phi4-mini", "plain")], _factory(chat))

    for case in report["cases"]:
        assert case["attempts"] == 1
        assert case["invocation_count"] == 1
        assert case["provenance"] == "raw_valid"
        assert case["used_recovery"] is False
        assert case["used_deterministic_fallback"] is False
        assert case["coverage_exact"] is True
    assert len(chat.calls) == 3  # one per seed, no recovery


def test_stability_exercises_the_one_bounded_recovery_attempt(crowded_fixture):
    """Initial response invalid, recovery valid -> exactly two invocations
    for that seed, provenance recovery_used, and the second call carries
    the feedback the production orchestrator built."""
    good = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat(["garbage", good])
    report = harness.run_stability(
        crowded_fixture, [("phi4-mini", "plain")], _factory(chat), seeds=(11,)
    )
    case = report["cases"][0]

    assert case["attempts"] == 2
    assert case["invocation_count"] == 2
    assert case["provenance"] == "recovery_used"
    assert case["used_recovery"] is True
    assert [inv["is_recovery"] for inv in case["invocations"]] == [False, True]
    assert len(case["attempt_latencies_s"]) == 2
    assert len(chat.calls) == 2


def test_stability_records_deterministic_fallback_after_two_failures(crowded_fixture):
    chat = FakeChat(["garbage", "still garbage"])
    report = harness.run_stability(
        crowded_fixture, [("phi4-mini", "plain")], _factory(chat), seeds=(11,)
    )
    case = report["cases"][0]

    assert case["attempts"] == 2
    assert case["invocation_count"] == 2
    assert case["provenance"] == "deterministic_fallback"
    assert case["used_deterministic_fallback"] is True
    assert len(case["issues"]) == 2
    # The deterministic fallback still yields a complete plan, so coverage
    # stays exact — but it is trivial (one Keep-in-place zone), which is
    # exactly the outcome the real 1440.81s run produced.
    assert case["coverage_exact"] is True
    assert case["is_trivial_plan"] is True
    assert len(chat.calls) == 2


def test_stability_never_exceeds_two_invocations_per_case(crowded_fixture):
    chat = FakeChat(["garbage", "garbage", "garbage", "garbage"])
    report = harness.run_stability(
        crowded_fixture, [("phi4-mini", "plain")], _factory(chat), seeds=(11, 22)
    )
    assert all(c["invocation_count"] <= 2 for c in report["cases"])
    assert len(chat.calls) == 4  # 2 seeds x at most 2 invocations


def test_stability_writes_incrementally_to_a_temp_path(crowded_fixture, tmp_path):
    out = tmp_path / "stability.json"
    good = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat([good, good, good])
    harness.run_stability(
        crowded_fixture, [("phi4-mini", "plain")], _factory(chat), save=harness._writer(out)
    )
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["status"] == "complete"
    assert len(written["cases"]) == 3
    assert written["bounds"]["timeout_s"] == 210.0
    assert written["bounds"]["num_predict"] == 1536


def test_stability_manual_review_stays_unscored(crowded_fixture):
    good = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat([good])
    report = harness.run_stability(
        crowded_fixture, [("phi4-mini", "plain")], _factory(chat), seeds=(11,)
    )
    assert all(v is None for k, v in report["cases"][0]["manual_review"].items() if not k.startswith("_"))


# --- finalist parsing -----------------------------------------------------


def test_parse_finalist_accepts_simple_model_names():
    assert harness.parse_finalist("phi4-mini:schema") == ("phi4-mini", "schema")
    assert harness.parse_finalist(" mistral : plain ") == ("mistral", "plain")
    assert harness.parse_finalist("gemma2:2b:schema") == ("gemma2:2b", "schema")


@pytest.mark.parametrize("mode", ["plain", "schema"])
def test_parse_finalist_accepts_colon_bearing_ollama_model_tags(mode):
    """qwen3:8b is a real installed candidate — splitting on the FIRST
    colon would read '8b' as the mode and reject the model outright."""
    assert harness.parse_finalist(f"qwen3:8b:{mode}") == ("qwen3:8b", mode)


def test_parse_finalist_accepts_every_candidate_in_every_mode():
    for model_name in harness.CANDIDATE_MODELS:
        for mode in harness.MODES:
            assert harness.parse_finalist(f"{model_name}:{mode}") == (model_name, mode)


@pytest.mark.parametrize(
    "bad",
    [
        "phi4-mini",  # no mode at all
        "phi4-mini:",  # empty mode
        ":plain",  # empty model
        "phi4-mini:grammar",  # unknown mode
        "qwen3:8b",  # model tag alone — '8b' is not a mode
        "qwen3:8b:grammar",  # colon-bearing model, unknown mode
    ],
)
def test_parse_finalist_rejects_malformed_specs(bad):
    with pytest.raises(ValueError):
        harness.parse_finalist(bad)


@pytest.mark.parametrize("unknown", ["llama3:8b:plain", "deepseek-r1:7b:schema", "moondream:plain"])
def test_parse_finalist_rejects_models_outside_the_candidate_set(unknown):
    """Rejected at argument-parsing time, before any client is built or
    any call is issued."""
    with pytest.raises(ValueError, match="unknown model"):
        harness.parse_finalist(unknown)


# --- malformed responses ---------------------------------------------------


@pytest.mark.parametrize(
    "response,expected_reason",
    [
        ({}, "missing_message"),
        ({"not_message": 1}, "missing_message"),
        ("a bare string", "missing_message"),
        (None, "missing_message"),
        ({"message": "not-an-object"}, "message_not_object"),
        ({"message": ["a", "list"]}, "message_not_object"),
        ({"message": {}}, "missing_content"),
        ({"message": {"role": "assistant"}}, "missing_content"),
        ({"message": {"content": None}}, "content_not_string"),
        ({"message": {"content": 42}}, "content_not_string"),
        ({"message": {"content": {"nested": "object"}}}, "content_not_string"),
    ],
)
def test_extract_message_content_rejects_malformed_shapes(response, expected_reason):
    with pytest.raises(harness.MalformedResponseError) as exc_info:
        harness.extract_message_content(response)
    assert exc_info.value.reason == expected_reason


def test_extract_message_content_accepts_the_valid_shape():
    assert harness.extract_message_content({"message": {"content": "hi"}}) == "hi"


def test_malformed_response_becomes_a_bounded_call_failed_invocation(simple_fixture):
    chat = FakeChat([{"message": {"content": 42}}])
    planner = harness.EvalPlanner("phi4-mini", "plain", chat_fn=chat)
    with pytest.raises(harness.PlannerCallError) as exc_info:
        planner(
            run_id="r",
            selected_items=simple_fixture.items,
            scene_label=simple_fixture.scene_label,
            user_context=None,
        )
    assert exc_info.value.kind == "call_failed"
    assert "content_not_string" in exc_info.value.detail
    assert len(chat.calls) == 1  # no retry at this layer
    inv = planner.invocations[0]
    assert inv["call_success"] is False
    assert inv["error_kind"] == "call_failed"
    # The malformed object itself is never retained.
    assert inv["raw_response"] is None


def test_malformed_response_never_exposes_the_offending_object(simple_fixture):
    secret = "SUPER_SECRET_RESPONSE_BODY"
    chat = FakeChat([{"message": {"content": {"leak": secret}}}])
    planner = harness.EvalPlanner("phi4-mini", "plain", chat_fn=chat)
    with pytest.raises(harness.PlannerCallError) as exc_info:
        planner(
            run_id="r",
            selected_items=simple_fixture.items,
            scene_label=simple_fixture.scene_label,
            user_context=None,
        )
    assert secret not in exc_info.value.detail
    assert secret not in json.dumps(planner.invocations)


def test_screen_case_survives_a_malformed_response(simple_fixture):
    chat = FakeChat([{"message": {}}])
    case = harness.evaluate_screen_case(
        simple_fixture, "phi4-mini", "plain", _factory(chat), apply_trivial_gate=False
    )
    assert case["call_success"] is False
    assert case["error_kind"] == "call_failed"
    assert case["passed_gates"] is False
    assert case["raw_response"] is None


def test_run_screen_continues_after_a_malformed_response(simple_fixture, crowded_fixture):
    """A malformed response on the first pair must not abort the run —
    every later case still executes."""
    good_simple = _plan_text(simple_fixture.item_ids)
    good_crowded = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat([{"message": {"content": None}}] + [good_simple] * 7 + [good_crowded] * 7)
    report = harness.run_screen(simple_fixture, crowded_fixture, _factory(chat))

    assert len(report["simple_cases"]) == 8  # all eight ran
    assert report["simple_cases"][0]["error_kind"] == "call_failed"
    assert report["simple_cases"][0]["passed_gates"] is False
    assert all(c["passed_gates"] for c in report["simple_cases"][1:])
    assert len(report["crowded_cases"]) == 7  # the malformed pair was eliminated


# --- error sanitization ----------------------------------------------------


_LEAKY_MESSAGE = (
    "HTTPConnectionPool(host='delusion-uncanny-police.ngrok-free.dev', port=443): "
    "Max retries exceeded with url: /api/chat "
    "(Authorization: Bearer ghp_FAKETOKEN0000000000000000000000000000) "
    "body='You are a room-reorganisation planning assistant. item_001: painting'"
)
_LEAKY_FRAGMENTS = [
    "ngrok-free.dev",
    "ghp_FAKETOKEN",
    "Bearer",
    "/api/chat",
    "room-reorganisation planning assistant",
    "item_001",
    "painting",
]


def test_error_detail_contains_only_the_exception_type_and_classification(simple_fixture):
    chat = FakeChat([ConnectionError(_LEAKY_MESSAGE)])
    planner = harness.EvalPlanner("phi4-mini", "plain", chat_fn=chat)
    with pytest.raises(harness.PlannerCallError) as exc_info:
        planner(
            run_id="r",
            selected_items=simple_fixture.items,
            scene_label=simple_fixture.scene_label,
            user_context=None,
        )
    detail = exc_info.value.detail
    assert detail == "planner call failed (ConnectionError)"
    for fragment in _LEAKY_FRAGMENTS:
        assert fragment not in detail


def test_no_leaky_fragment_reaches_a_written_screen_artefact(simple_fixture, crowded_fixture, tmp_path):
    """End-to-end: the serialized result file must contain none of the
    host/token/prompt data an exception message carried."""
    out = tmp_path / "screen.json"
    chat = FakeChat([ConnectionError(_LEAKY_MESSAGE)] * 8)
    harness.run_screen(simple_fixture, crowded_fixture, _factory(chat), save=harness._writer(out))

    written = out.read_text(encoding="utf-8")
    for fragment in _LEAKY_FRAGMENTS:
        assert fragment not in written, f"{fragment!r} leaked into the result artefact"


def test_timeout_detail_is_also_fixed_text(simple_fixture):
    chat = FakeChat([FakeTimeout(_LEAKY_MESSAGE)])
    planner = harness.EvalPlanner("phi4-mini", "plain", chat_fn=chat)
    with pytest.raises(harness.PlannerCallError) as exc_info:
        planner(
            run_id="r",
            selected_items=simple_fixture.items,
            scene_label=simple_fixture.scene_label,
            user_context=None,
        )
    assert exc_info.value.detail == "planner call timed out (FakeTimeout)"
    for fragment in _LEAKY_FRAGMENTS:
        assert fragment not in exc_info.value.detail


# --- partition signatures --------------------------------------------------


def test_partition_signature_ignores_zone_order_and_names():
    a = {
        "zones": [
            {"zone_name": "Desk workspace", "item_ids": ["item_002", "item_001"], "instruction": "tidy"},
            {"zone_name": "Bedside", "item_ids": ["item_003"], "instruction": "keep"},
        ],
        "image_prompt": "p",
    }
    b = {
        "zones": [
            {"zone_name": "Work area", "item_ids": ["item_003"], "instruction": "totally different wording"},
            {"zone_name": "Sleeping corner", "item_ids": ["item_001", "item_002"], "instruction": "x"},
        ],
        "image_prompt": "p",
    }
    assert harness.plan_partition_signature(a) == harness.plan_partition_signature(b)
    assert harness.plan_partition_signature(a) == [["item_001", "item_002"], ["item_003"]]


def test_partition_signature_distinguishes_genuinely_different_groupings():
    a = {"zones": [{"zone_name": "Z", "item_ids": ["item_001", "item_002"], "instruction": "i"}], "image_prompt": "p"}
    b = {
        "zones": [
            {"zone_name": "Z", "item_ids": ["item_001"], "instruction": "i"},
            {"zone_name": "Y", "item_ids": ["item_002"], "instruction": "i"},
        ],
        "image_prompt": "p",
    }
    assert harness.plan_partition_signature(a) != harness.plan_partition_signature(b)


def test_partition_signature_handles_unusable_shapes():
    for parsed in (None, "x", [], {"zones": "nope"}):
        assert harness.plan_partition_signature(parsed) is None


# --- stability summaries ---------------------------------------------------


def _stability_case(**overrides) -> dict:
    base = {
        "seed": 11,
        "provenance": "raw_valid",
        "attempts": 1,
        "coverage_exact": True,
        "is_trivial_plan": False,
        "total_latency_s": 12.0,
        "timeout_invocations": 0,
        "failed_invocations": 0,
        "partition_signature": [["item_001"], ["item_002"]],
    }
    base.update(overrides)
    return base


def test_summary_aggregate_counts():
    cases = [
        _stability_case(seed=11),
        _stability_case(seed=22, provenance="recovery_used", attempts=2),
        _stability_case(seed=33, provenance="deterministic_fallback", attempts=2, is_trivial_plan=True),
    ]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["case_count"] == 3
    assert s["exact_coverage_count"] == 3
    assert s["recovery_count"] == 1
    assert s["deterministic_fallback_count"] == 1
    assert s["trivial_plan_count"] == 1
    assert s["max_total_latency_s"] == 12.0


def test_summary_counts_timeouts_and_call_failures():
    cases = [
        _stability_case(seed=11, timeout_invocations=1),
        _stability_case(seed=22, failed_invocations=2),
        _stability_case(seed=33),
    ]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["timeout_count"] == 1
    assert s["call_failure_count"] == 1
    assert s["passes_core_gates"] is False
    assert "timeout" in s["core_gate_failures"] and "call_failure" in s["core_gate_failures"]


def test_summary_reports_stable_partitions_across_seeds():
    sig = [["item_001"], ["item_002"]]
    cases = [_stability_case(seed=s, partition_signature=sig) for s in (11, 22, 33)]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["partition_stable_across_seeds"] is True
    assert len(s["partition_signatures"]) == 3


def test_summary_reports_unstable_partitions_across_seeds():
    cases = [
        _stability_case(seed=11, partition_signature=[["item_001"], ["item_002"]]),
        _stability_case(seed=22, partition_signature=[["item_001", "item_002"]]),
        _stability_case(seed=33, partition_signature=[["item_001"], ["item_002"]]),
    ]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["partition_stable_across_seeds"] is False


def test_summary_partition_stability_ignores_deterministic_fallback_plans():
    """The fallback plan is identical by construction — counting it would
    manufacture a 'stable' verdict out of the model failing twice."""
    cases = [
        _stability_case(seed=11, provenance="deterministic_fallback", attempts=2, partition_signature=[["a"]]),
        _stability_case(seed=22, provenance="deterministic_fallback", attempts=2, partition_signature=[["a"]]),
        _stability_case(seed=33, provenance="deterministic_fallback", attempts=2, partition_signature=[["a"]]),
    ]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["partition_stable_across_seeds"] is None  # unknown, not True
    assert s["deterministic_fallback_count"] == 3


def test_summary_partition_stability_is_none_with_fewer_than_two_model_plans():
    cases = [_stability_case(seed=11)]
    assert harness.summarize_finalist("phi4-mini", "plain", cases)["partition_stable_across_seeds"] is None


def test_summary_systematic_recovery_true_when_every_repeat_needed_two_attempts():
    cases = [_stability_case(seed=s, provenance="recovery_used", attempts=2) for s in (11, 22, 33)]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["systematic_recovery"] is True
    assert s["recovery_count"] == 3


def test_summary_systematic_recovery_false_when_any_repeat_succeeded_first_try():
    cases = [
        _stability_case(seed=11, provenance="recovery_used", attempts=2),
        _stability_case(seed=22, attempts=1),
        _stability_case(seed=33, provenance="recovery_used", attempts=2),
    ]
    assert harness.summarize_finalist("phi4-mini", "plain", cases)["systematic_recovery"] is False


def test_summary_core_gates_pass_on_a_clean_finalist():
    cases = [_stability_case(seed=s) for s in (11, 22, 33)]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["passes_core_gates"] is True
    assert s["core_gate_failures"] == []


@pytest.mark.parametrize(
    "override,expected_failure",
    [
        ({"coverage_exact": False}, "coverage_not_exact"),
        ({"provenance": "deterministic_fallback", "attempts": 2}, "deterministic_fallback"),
        ({"is_trivial_plan": True}, "trivial_plan"),
        ({"total_latency_s": 200.0}, "latency_gate"),
        ({"timeout_invocations": 1}, "timeout"),
        ({"failed_invocations": 1}, "call_failure"),
    ],
)
def test_summary_core_gate_failures(override, expected_failure):
    cases = [_stability_case(seed=11), _stability_case(seed=22, **override)]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["passes_core_gates"] is False
    assert expected_failure in s["core_gate_failures"]


def test_summary_keeps_partition_stability_out_of_core_gates():
    """An objectively perfect candidate that groups differently every seed
    still passes the core gates — instability is reported alongside, for a
    human to weigh, never silently folded in."""
    cases = [
        _stability_case(seed=11, partition_signature=[["item_001"], ["item_002"]]),
        _stability_case(seed=22, partition_signature=[["item_001", "item_002"]]),
    ]
    s = harness.summarize_finalist("phi4-mini", "plain", cases)
    assert s["partition_stable_across_seeds"] is False
    assert s["passes_core_gates"] is True


def test_summary_empty_case_list_does_not_pass():
    s = harness.summarize_finalist("phi4-mini", "plain", [])
    assert s["passes_core_gates"] is False
    assert "no_cases" in s["core_gate_failures"]
    assert s["max_total_latency_s"] is None


# --- stability summary integration ----------------------------------------


def test_run_stability_emits_a_summary_per_finalist(crowded_fixture):
    good = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat([good] * 6)
    report = harness.run_stability(
        crowded_fixture, [("phi4-mini", "plain"), ("qwen3:8b", "schema")], _factory(chat)
    )
    assert len(report["summaries"]) == 2
    assert {(s["model"], s["mode"]) for s in report["summaries"]} == {
        ("phi4-mini", "plain"),
        ("qwen3:8b", "schema"),
    }
    for summary in report["summaries"]:
        assert summary["case_count"] == 3
        assert summary["passes_core_gates"] is True
        assert summary["partition_stable_across_seeds"] is True


def test_run_stability_updates_the_summary_incrementally(crowded_fixture, tmp_path):
    out = tmp_path / "stability.json"
    seen_case_counts: list[int] = []

    def _save(report):
        harness._writer(out)(report)
        seen_case_counts.append(report["summaries"][0]["case_count"])

    good = _plan_text(crowded_fixture.item_ids, n_zones=4)
    chat = FakeChat([good] * 3)
    harness.run_stability(crowded_fixture, [("phi4-mini", "plain")], _factory(chat), save=_save)

    # summary present from the first write and growing with each case
    assert seen_case_counts == [0, 1, 2, 3, 3]
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["summaries"][0]["case_count"] == 3
    assert written["summaries"][0]["exact_coverage_count"] == 3


def test_run_stability_summary_flags_a_systematically_failing_finalist(crowded_fixture):
    chat = FakeChat(["garbage"] * 6)
    report = harness.run_stability(
        crowded_fixture, [("phi4-mini", "plain")], _factory(chat), seeds=(11, 22, 33)
    )
    summary = report["summaries"][0]
    assert summary["deterministic_fallback_count"] == 3
    assert summary["trivial_plan_count"] == 3
    assert summary["systematic_recovery"] is True
    assert summary["passes_core_gates"] is False
    assert "deterministic_fallback" in summary["core_gate_failures"]
    assert summary["partition_stable_across_seeds"] is None


# --- import boundary ------------------------------------------------------


def test_importing_the_harness_loads_no_torch_clip_dino_or_colab():
    """Subprocess, not an in-process sys.modules check: other tests in the
    same pytest session may already have imported torch for unrelated
    reasons. A fresh interpreter importing only this module is the real
    question.

    `ollama` is deliberately NOT in this set — the harness's entire
    purpose is Ollama calls. It is still lazy-imported (so plain
    `import` stays cheap), but its presence would not be a defect.
    """
    code = (
        "import sys\n"
        "import evaluation.scripts.compare_reorganise_planning\n"
        "heavy = {'torch', 'clip', 'transformers', 'app.models.grounding_dino', "
        "'app.models.clip_scene', 'colab_service', 'colab_service.pipeline'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_importing_the_harness_does_not_eagerly_import_ollama():
    """The lazy-import boundary itself: ollama is pulled in only when a
    planner actually runs, not at import time."""
    code = (
        "import sys\n"
        "import evaluation.scripts.compare_reorganise_planning\n"
        "assert 'ollama' not in sys.modules, 'ollama imported eagerly'\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr
