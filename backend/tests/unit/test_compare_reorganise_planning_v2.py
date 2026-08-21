"""
Unit tests for evaluation/scripts/compare_reorganise_planning_v2.py — the
V2 runner's gate arithmetic, staged CLI and artefact writing.

Fakes only; no model, network or Ollama call is reachable. Result
artefacts are written to pytest tmp_path, never to
evaluation/results/.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from evaluation.scripts.compare_reorganise_planning import load_fixture
from evaluation.scripts import reorganise_v2
from evaluation.scripts.reorganise_v2 import V2Planner, build_batches
from evaluation.scripts import compare_reorganise_planning_v2 as runner
from tests.unit.test_reorganise_v2 import FakeChat, ids, payload, row

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_FIXTURES = _BACKEND_DIR / "evaluation" / "fixtures"


@pytest.fixture
def simple_fixture():
    return load_fixture(_FIXTURES / runner.SIMPLE_FIXTURE)


@pytest.fixture
def crowded_fixture():
    return load_fixture(_FIXTURES / runner.CROWDED_FIXTURE)


def factory(responses: list):
    """A planner factory over one scripted FakeChat, so a whole stage can
    be driven from a single response script."""
    chat = FakeChat(responses)

    def _make(model_name: str, seed: int) -> V2Planner:
        return V2Planner(model_name, chat_fn=chat, seed=seed)

    _make.chat = chat  # type: ignore[attr-defined]
    return _make


def good_rows(item_ids, zone="Wall display", operation="straighten"):
    return [row(i, zone=zone, operation=operation) for i in item_ids]


def perfect_crowded(seeds: int = 1) -> list[str]:
    """Responses for a fully-passing crowded run: 4 batches, varied zones
    and >=2 operations, repeated per seed."""
    zones = ["Wall display", "Desk area", "Storage", "Floor"]
    ops = ["straighten", "group", "store", "keep_in_place"]
    out: list[str] = []
    for _ in range(seeds):
        for n, batch in enumerate(build_batches(ids(28))):
            out.append(payload(good_rows(batch, zone=zones[n], operation=ops[n])))
    return out


# --- shipped fixtures load -----------------------------------------------


def test_v2_uses_the_existing_fixtures_unchanged(simple_fixture, crowded_fixture):
    assert len(simple_fixture.items) == 4
    assert len(crowded_fixture.items) == 28
    assert crowded_fixture.user_context == "i want a neat room"


# --- max-call arithmetic --------------------------------------------------


@pytest.mark.parametrize("n,expected", [(4, 2), (7, 2), (8, 4), (28, 8)])
def test_expected_max_calls(n, expected):
    assert runner._expected_max_calls(n) == expected


def test_simple_case_never_exceeds_two_calls(simple_fixture):
    f = factory([payload([]), payload([])])
    case = runner.evaluate_case(simple_fixture, "phi4-mini", 11, f, crowded=False)
    assert case["llm_call_count"] <= 2 == case["bounds"]["max_calls"]


def test_crowded_case_never_exceeds_eight_calls(crowded_fixture):
    f = factory([payload([]) for _ in range(8)])
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, f, crowded=True)
    assert case["llm_call_count"] == 8
    assert case["bounds"]["max_calls"] == 8


# --- gates read LLM resolution, not the merged plan -----------------------


def test_gates_are_not_fooled_by_keep_in_place_absorption(crowded_fixture):
    """The trap: nothing resolves, yet the merged plan still covers all 28
    items because Keep-in-place absorbs them. Coverage must NOT read as a
    pass."""
    f = factory([payload([]) for _ in range(8)])
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, f, crowded=True)

    assert case["final_plan_coverage_exact"] is True  # merged plan is complete...
    assert case["llm_resolved_count"] == 0  # ...but the model resolved nothing
    assert case["still_invalid_count"] == 28
    assert case["passed_automatic_gates"] is False
    assert "still_invalid" in case["gate_failures"]
    assert "incomplete_llm_resolution" in case["gate_failures"]


def test_partial_resolution_still_fails(crowded_fixture):
    batches = build_batches(ids(28))
    responses = [payload(good_rows(batches[0]))] + [payload([]) for _ in range(3)]
    responses += [payload([]) for _ in range(4)]
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)

    assert case["llm_resolved_count"] == 7
    assert case["still_invalid_count"] == 21
    assert case["passed_automatic_gates"] is False


# --- crowded gates --------------------------------------------------------


def test_fully_passing_crowded_case(crowded_fixture):
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(perfect_crowded()), crowded=True)

    assert case["passed_automatic_gates"] is True, case["gate_failures"]
    assert case["llm_resolved_count"] == 28
    assert case["still_invalid_count"] == 0
    assert case["recovery_count"] == 0
    assert 2 <= case["zone_count"] <= 8
    assert len(case["operations_used"]) >= 2
    assert case["llm_call_count"] == 4


def test_zone_count_gate_rejects_a_single_zone(crowded_fixture):
    responses = [payload(good_rows(b, zone="Everything")) for b in build_batches(ids(28))]
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)
    assert case["zone_count"] == 1
    assert "zone_count" in case["gate_failures"]


def test_zone_count_gate_rejects_proliferation(crowded_fixture):
    responses = [
        payload([row(i, zone=f"Zone {i}") for i in b]) for b in build_batches(ids(28))
    ]
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)
    assert case["zone_count"] == 28
    assert "zone_count" in case["gate_failures"]


def test_operation_diversity_gate(crowded_fixture):
    zones = ["Wall display", "Desk area", "Storage", "Floor"]
    responses = [
        payload(good_rows(b, zone=zones[n], operation="keep_in_place"))
        for n, b in enumerate(build_batches(ids(28)))
    ]
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)
    assert case["operations_used"] == ["keep_in_place"]
    assert "operation_diversity" in case["gate_failures"]


def test_recovery_rate_gate(crowded_fixture):
    """6 of 28 recovered = 21.4% > 20% -> fail, even though all resolve."""
    batches = build_batches(ids(28))
    zones = ["Wall display", "Desk area", "Storage", "Floor"]
    ops = ["straighten", "group", "store", "keep_in_place"]
    dropped: list[str] = []
    responses = []
    for n, b in enumerate(batches):
        drop = b[:2] if n < 3 else []
        dropped += drop
        responses.append(payload(good_rows([x for x in b if x not in drop], zone=zones[n], operation=ops[n])))
    responses.append(payload(good_rows(dropped, zone="Storage", operation="store")))

    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)
    assert case["recovery_count"] == 6
    assert case["recovery_rate"] > runner.MAX_RECOVERY_RATE
    assert "recovery_rate" in case["gate_failures"]
    assert case["llm_resolved_count"] == 28  # resolution succeeded; the RATE is the failure


def test_recovery_within_budget_passes(crowded_fixture):
    """4 of 28 = 14.3% <= 20%."""
    batches = build_batches(ids(28))
    zones = ["Wall display", "Desk area", "Storage", "Floor"]
    ops = ["straighten", "group", "store", "keep_in_place"]
    dropped: list[str] = []
    responses = []
    for n, b in enumerate(batches):
        drop = b[:1] if n < 4 else []
        dropped += drop
        responses.append(payload(good_rows([x for x in b if x not in drop], zone=zones[n], operation=ops[n])))
    responses.append(payload(good_rows(dropped, zone="Storage", operation="store")))

    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)
    assert case["recovery_count"] == 4
    assert case["passed_automatic_gates"] is True, case["gate_failures"]


def test_latency_gate(crowded_fixture, monkeypatch):
    clock = iter([0.0] + [500.0] * 40)
    monkeypatch.setattr(runner_time := __import__("time"), "perf_counter", lambda: next(clock))
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(perfect_crowded()), crowded=True)
    assert "latency_gate" in case["gate_failures"]


def test_call_failure_fails_the_gate(crowded_fixture):
    responses = [ConnectionError("boom")] + perfect_crowded()[1:] + [payload([])]
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)
    assert case["call_failed"] is True
    assert "call_failed" in case["gate_failures"]


# --- simple gates ---------------------------------------------------------


def test_simple_case_passes_when_all_four_resolve_first_call(simple_fixture):
    responses = [payload([row(i, zone=("Desk" if n % 2 else "Wall")) for n, i in enumerate(ids(4))])]
    case = runner.evaluate_case(simple_fixture, "phi4-mini", 11, factory(responses), crowded=False)

    assert case["passed_automatic_gates"] is True, case["gate_failures"]
    assert case["llm_call_count"] == 1
    assert case["recovery_count"] == 0


def test_simple_case_fails_if_recovery_was_needed(simple_fixture):
    responses = [payload([row(i) for i in ids(3)]), payload([row("item_004")])]
    case = runner.evaluate_case(simple_fixture, "phi4-mini", 11, factory(responses), crowded=False)

    assert case["recovery_count"] == 1
    assert "recovery_used_on_simple" in case["gate_failures"]


def test_simple_case_does_not_apply_crowded_only_gates(simple_fixture):
    """Two zones with a single operation is fine on the simple fixture —
    the zone-count and operation-diversity gates are crowded-only."""
    rows = [row(i, zone=("Desk" if n else "Wall"), operation="straighten") for n, i in enumerate(ids(4))]
    case = runner.evaluate_case(simple_fixture, "phi4-mini", 11, factory([payload(rows)]), crowded=False)
    assert case["passed_automatic_gates"] is True, case["gate_failures"]
    assert case["operations_used"] == ["straighten"]
    assert "zone_count" not in case["gate_failures"]
    assert "operation_diversity" not in case["gate_failures"]


# --- recorded metadata ----------------------------------------------------


def test_case_records_every_required_metric(crowded_fixture):
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(perfect_crowded()), crowded=True)
    for key in (
        "llm_call_count",
        "initial_latency_s",
        "recovery_latency_s",
        "total_latency_s",
        "per_item_validity",
        "issue_counts",
        "initial_duplicate_count",
        "initial_unexpected_count",
        "initial_missing_count",
        "llm_resolved_count",
        "recovery_count",
        "recovery_rate",
        "still_invalid_count",
        "operation_distribution",
        "zone_count",
        "final_plan_coverage_exact",
        "image_prompt_chars",
        "image_prompt_words",
    ):
        assert key in case, key
    assert case["bounds"]["num_predict"] == 1536
    assert case["bounds"]["timeout_s"] == 210.0
    assert case["mode"] == "plain"


def test_manual_review_is_required_and_unscored(crowded_fixture):
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(perfect_crowded()), crowded=True)
    assert case["manual_review_required"] is True
    scored = {k: v for k, v in case["manual_review"].items() if not k.startswith("_")}
    assert all(v is None for v in scored.values())


def test_issue_details_are_bounded_and_sanitised(crowded_fixture):
    leaky = "http://secret-host/api/chat ghp_FAKETOKEN painting"
    responses = [ConnectionError(leaky)] + perfect_crowded()[1:] + [payload([])]
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)

    blob = json.dumps(case)
    for fragment in ("secret-host", "ghp_FAKETOKEN", "/api/chat"):
        assert fragment not in blob


# --- staged runs and artefacts -------------------------------------------


def test_each_seed_is_scored_independently(crowded_fixture):
    report = runner.run_stage(
        crowded_fixture, "phi4-mini", [11, 22, 33], factory(perfect_crowded(seeds=3)), crowded=True
    )
    assert [c["seed"] for c in report["cases"]] == [11, 22, 33]
    assert all(c["passed_automatic_gates"] for c in report["cases"])
    assert report["summary"]["all_seeds_passed_automatic_gates"] is True


def test_one_failing_seed_fails_the_stage(crowded_fixture):
    responses = perfect_crowded(seeds=2) + [payload([]) for _ in range(8)]
    report = runner.run_stage(crowded_fixture, "phi4-mini", [11, 22, 33], factory(responses), crowded=True)

    assert report["summary"]["passed_automatic_gates_count"] == 2
    assert report["summary"]["all_seeds_passed_automatic_gates"] is False


def test_grouping_similarity_is_reported_but_not_a_gate(crowded_fixture):
    report = runner.run_stage(
        crowded_fixture, "phi4-mini", [11, 22], factory(perfect_crowded(seeds=2)), crowded=True
    )
    assert report["summary"]["grouping_identical_across_seeds"] is True
    # and it is absent from every case's gate list
    for case in report["cases"]:
        assert "grouping" not in " ".join(case["gate_failures"])


def test_artefact_is_written_incrementally_with_honest_status(crowded_fixture, tmp_path):
    out = tmp_path / "nested" / "v2.json"
    statuses: list[str] = []

    def _save(report):
        runner._writer(out)(report)
        statuses.append(report["status"])

    runner.run_stage(
        crowded_fixture, "phi4-mini", [11, 22], factory(perfect_crowded(seeds=2)), crowded=True, save=_save
    )

    assert statuses[0] == "incomplete"  # honest before finishing
    assert statuses[-1] == "complete"
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["status"] == "complete"
    assert written["planner_version"] == "v2"
    assert len(written["cases"]) == 2
    assert written["summary"]["case_count"] == 2


def test_interrupted_run_leaves_incomplete_status(crowded_fixture, tmp_path):
    """A crash mid-stage must leave a file that says so."""
    out = tmp_path / "v2.json"
    save = runner._writer(out)
    calls = {"n": 0}

    def _save(report):
        calls["n"] += 1
        save(report)
        if calls["n"] == 2:
            raise RuntimeError("simulated crash")

    with pytest.raises(RuntimeError):
        runner.run_stage(
            crowded_fixture, "phi4-mini", [11, 22], factory(perfect_crowded(seeds=2)), crowded=True, save=_save
        )

    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["status"] == "incomplete"
    assert len(written["cases"]) == 1


# --- CLI surface ----------------------------------------------------------


def test_default_candidate_set_excludes_schema_v1_and_qwen():
    assert runner.DEFAULT_MODEL == "phi4-mini"
    assert runner.ALLOWED_MODELS == ("phi4-mini", "mistral")
    assert not any("qwen" in m for m in runner.ALLOWED_MODELS)


def test_cli_rejects_an_unknown_model():
    result = subprocess.run(
        [sys.executable, "-m", "evaluation.scripts.compare_reorganise_planning_v2",
         "crowded", "--model", "qwen3:8b", "--out", "x.json"],
        capture_output=True, text=True, cwd=str(_BACKEND_DIR),
    )
    assert result.returncode != 0
    assert "invalid choice" in result.stderr


def test_cli_rejects_duplicate_seeds():
    result = subprocess.run(
        [sys.executable, "-m", "evaluation.scripts.compare_reorganise_planning_v2",
         "crowded", "--seed", "11", "--seed", "11", "--out", "x.json"],
        capture_output=True, text=True, cwd=str(_BACKEND_DIR),
    )
    assert result.returncode != 0
    assert "distinct" in (result.stderr + result.stdout)


def test_cli_requires_a_stage_and_an_out_path():
    result = subprocess.run(
        [sys.executable, "-m", "evaluation.scripts.compare_reorganise_planning_v2", "crowded"],
        capture_output=True, text=True, cwd=str(_BACKEND_DIR),
    )
    assert result.returncode != 0
    assert "--out" in result.stderr


def test_cli_help_lists_both_stages():
    result = subprocess.run(
        [sys.executable, "-m", "evaluation.scripts.compare_reorganise_planning_v2", "--help"],
        capture_output=True, text=True, cwd=str(_BACKEND_DIR),
    )
    assert result.returncode == 0
    assert "simple" in result.stdout and "crowded" in result.stdout


# --- import boundary ------------------------------------------------------


def test_importing_the_runner_loads_no_model_stack():
    code = (
        "import sys\n"
        "import evaluation.scripts.compare_reorganise_planning_v2\n"
        "heavy = {'torch', 'clip', 'transformers', 'ollama', 'groundingdino',\n"
        "         'app.models.grounding_dino', 'app.models.clip_scene',\n"
        "         'app.models.reorganise_llm', 'app.models.mistral_llm'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR))
    assert result.returncode == 0, result.stdout + result.stderr


# ============ hardening regressions ======================================


def test_simple_one_zone_all_items_fails_as_trivial(simple_fixture):
    """A plan putting every selected item into one zone is trivial. The
    previous `len(zones) < 1` check could never fire, because
    ReorganisePlan rejects a zero-zone plan outright."""
    responses = [payload(good_rows(ids(4), zone="Everything", operation="keep_in_place"))]
    case = runner.evaluate_case(simple_fixture, "phi4-mini", 11, factory(responses), crowded=False)

    assert case["zone_count"] == 1
    assert case["llm_resolved_count"] == 4  # resolution succeeded; the ORGANISATION is trivial
    assert "trivial_organisation" in case["gate_failures"]
    assert case["passed_automatic_gates"] is False


def test_simple_two_zones_is_not_trivial(simple_fixture):
    rows = [row(i, zone=("Desk" if n < 2 else "Wall")) for n, i in enumerate(ids(4))]
    case = runner.evaluate_case(simple_fixture, "phi4-mini", 11, factory([payload(rows)]), crowded=False)
    assert "trivial_organisation" not in case["gate_failures"]
    assert case["passed_automatic_gates"] is True, case["gate_failures"]


def test_unexpected_identity_output_fails_even_when_all_items_resolve(crowded_fixture):
    """Every requested item is assigned AND the model invents item_999.
    Resolution is complete, but identity handling is not reliable."""
    batches = build_batches(ids(28))
    zones = ["Wall display", "Desk area", "Storage", "Floor"]
    ops = ["straighten", "group", "store", "keep_in_place"]
    responses = []
    for n, b in enumerate(batches):
        rows = good_rows(b, zone=zones[n], operation=ops[n])
        if n == 0:
            rows.append(row("item_999", zone=zones[n]))  # invented id
        responses.append(payload(rows))

    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)

    assert case["llm_resolved_count"] == 28  # everything requested was assigned
    assert case["still_invalid_count"] == 0
    assert case["initial_unexpected_count"] == 1
    assert "unexpected_identity_output" in case["gate_failures"]
    assert case["passed_automatic_gates"] is False


def test_out_of_batch_id_also_fails_the_identity_gate(crowded_fixture):
    batches = build_batches(ids(28))
    zones = ["Wall display", "Desk area", "Storage", "Floor"]
    ops = ["straighten", "group", "store", "keep_in_place"]
    responses = []
    for n, b in enumerate(batches):
        rows = good_rows(b, zone=zones[n], operation=ops[n])
        if n == 0:
            rows.append(row("item_020", zone=zones[n]))  # real id, wrong batch
        responses.append(payload(rows))

    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)
    assert case["initial_unexpected_count"] == 1
    assert "unexpected_identity_output" in case["gate_failures"]


def test_missing_rows_recovered_cleanly_still_pass(crowded_fixture):
    """Missing target rows are forgivable when recovery resolves them and
    every other gate holds — unlike invented identities."""
    batches = build_batches(ids(28))
    zones = ["Wall display", "Desk area", "Storage", "Floor"]
    ops = ["straighten", "group", "store", "keep_in_place"]
    dropped = []
    responses = []
    for n, b in enumerate(batches):
        drop = b[:1]
        dropped += drop
        responses.append(payload(good_rows([x for x in b if x not in drop], zone=zones[n], operation=ops[n])))
    responses.append(payload(good_rows(dropped, zone="Storage", operation="store")))

    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)
    assert case["initial_missing_count"] == 4
    assert case["recovery_count"] == 4
    assert "unexpected_identity_output" not in case["gate_failures"]
    assert case["passed_automatic_gates"] is True, case["gate_failures"]


def test_initial_and_recovery_issue_metrics_never_mix(crowded_fixture):
    batches = build_batches(ids(28))
    responses = [payload(good_rows(b[:-1])) for b in batches]  # 4 missing initially
    responses.append(payload([]))  # recovery resolves none -> 4 more missing
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(responses), crowded=True)

    assert case["initial_missing_count"] == 4
    assert case["recovery_missing_count"] == 4
    assert case["initial_issue_counts"]["missing_row"] == 4
    assert case["recovery_issue_counts"]["missing_row"] == 4
    # the combined total exists but is never presented as initial_*
    assert case["issue_counts"]["missing_row"] == 8
    assert all(i["phase"] in ("initial", "recovery") for i in case["issues"])


def test_case_artefact_preserves_assignments_and_the_full_plan(crowded_fixture):
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(perfect_crowded()), crowded=True)

    assignments = case["assignments"]
    assert len(assignments) == 28
    for a in assignments:
        assert set(a) == {"item_id", "operation", "zone_name", "instruction", "validity"}
        assert a["validity"] in ("raw_valid", "mechanically_repaired", "recovery_used")
    # the merged plan is reconstructable from the artefact alone
    plan = case["merged_plan"]
    assert sorted(i for z in plan["zones"] for i in z["item_ids"]) == ids(28)
    assert plan["image_prompt"]
    assert case["partition_signature"] is not None
    # automatic outcome and untouched manual block both present
    assert case["passed_automatic_gates"] is True
    assert all(v is None for k, v in case["manual_review"].items() if not k.startswith("_"))


def test_artefact_zone_instructions_cover_every_merged_row(crowded_fixture):
    """Each zone's instruction must represent all seven items merged into
    it, not just the first."""
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(perfect_crowded()), crowded=True)
    labels = {a["item_id"]: a for a in case["assignments"]}

    for zone in case["merged_plan"]["zones"]:
        assert len(zone["item_ids"]) == 7
        # one labelled clause per merged item
        assert zone["instruction"].count(":") >= len(zone["item_ids"])
        for item_id in zone["item_ids"]:
            assert labels[item_id]["instruction"].rstrip(".") in zone["instruction"]


def test_operation_is_absent_from_the_merged_plan_but_kept_in_metadata(crowded_fixture):
    case = runner.evaluate_case(crowded_fixture, "phi4-mini", 11, factory(perfect_crowded()), crowded=True)
    plan_blob = json.dumps(case["merged_plan"])
    assert "operation" not in plan_blob
    assert all("operation" in a for a in case["assignments"])
    assert case["operation_distribution"]


def test_grouping_stability_compares_membership_not_zone_names(crowded_fixture):
    """Same zone NAMES, different item membership -> not stable."""
    batches = build_batches(ids(28))
    zones = ["Wall display", "Desk area", "Storage", "Floor"]
    ops = ["straighten", "group", "store", "keep_in_place"]

    seed_a = [payload(good_rows(b, zone=zones[n], operation=ops[n])) for n, b in enumerate(batches)]
    # Same four zone names, but one item moves from zone 0 to zone 1, so
    # the MEMBERSHIP differs (6/8/7/7 instead of 7/7/7/7). Merely
    # permuting zone names would leave the partition identical and is
    # correctly *not* instability.
    seed_b = []
    for n, b in enumerate(batches):
        rows = good_rows(b, zone=zones[n], operation=ops[n])
        if n == 0:
            rows[0] = row(b[0], zone=zones[1], operation=ops[0])
        seed_b.append(payload(rows))

    report = runner.run_stage(
        crowded_fixture, "phi4-mini", [11, 22], factory(seed_a + seed_b), crowded=True
    )

    assert report["summary"]["zone_names_identical_across_seeds"] is True
    assert report["summary"]["grouping_identical_across_seeds"] is False
    assert len(report["summary"]["partition_signatures"]) == 2


def test_identical_grouping_across_seeds_is_reported_stable(crowded_fixture):
    report = runner.run_stage(
        crowded_fixture, "phi4-mini", [11, 22], factory(perfect_crowded(seeds=2)), crowded=True
    )
    assert report["summary"]["grouping_identical_across_seeds"] is True


# --- terminology: automatic gates are not acceptance ---------------------


def test_report_uses_automatic_gate_terminology(crowded_fixture):
    report = runner.run_stage(crowded_fixture, "phi4-mini", [11], factory(perfect_crowded()), crowded=True)

    assert "all_seeds_passed_automatic_gates" in report["summary"]
    assert "passed_automatic_gates_count" in report["summary"]
    assert "all_seeds_passed" not in report["summary"]
    assert "passed_automatic_gates" in report["cases"][0]
    assert "passed_gates" not in report["cases"][0]
    assert "NOT ACCEPTANCE" in report["summary"]["_note"].upper()


def test_console_never_prints_an_unqualified_pass(crowded_fixture, tmp_path, capsys, monkeypatch):
    """An unqualified 'PASS' before manual review would imply the
    candidate is accepted."""
    monkeypatch.setattr(runner, "load_fixture", lambda *_a, **_k: crowded_fixture)
    monkeypatch.setattr(runner, "default_planner_factory", lambda host: factory(perfect_crowded()))
    runner.main(["crowded", "--seed", "11", "--host", "http://unused", "--out", str(tmp_path / "o.json")])

    out = capsys.readouterr().out
    assert "AUTO-PASS" in out
    assert "MANUAL REVIEW PENDING" in out
    assert "Automatic gates are NOT acceptance" in out
    # every PASS token is qualified as AUTO-PASS, never bare
    assert out.count("PASS") == out.count("AUTO-PASS")


# ============ v2.1 prompt provenance =====================================


def test_report_and_every_case_record_the_prompt_version(crowded_fixture, tmp_path):
    """A result that cannot say which prompt produced it is not evidence.
    `planner_version` names the harness family; the prompt revision is
    recorded separately and moves independently."""
    out = tmp_path / "v21.json"
    runner.run_stage(
        crowded_fixture,
        "phi4-mini",
        [11, 22],
        factory(perfect_crowded(seeds=2)),
        crowded=True,
        save=runner._writer(out),
    )

    written = json.loads(out.read_text(encoding="utf-8"))
    assert written["planner_version"] == "v2"
    assert written["prompt_version"] == "v2.1"
    assert [c["prompt_version"] for c in written["cases"]] == ["v2.1", "v2.1"]


def test_prompt_version_comes_from_the_planner_not_a_literal(crowded_fixture, monkeypatch):
    """Recorded from the planner's own constant, so bumping the prompt can
    never leave the artefact claiming the previous revision."""
    monkeypatch.setattr(runner, "PLANNER_V2_PROMPT_VERSION", "v9.9-test")
    report = runner.run_stage(
        crowded_fixture, "phi4-mini", [11], factory(perfect_crowded()), crowded=True
    )
    assert report["prompt_version"] == "v9.9-test"
    assert report["cases"][0]["prompt_version"] == "v9.9-test"


def test_prompt_zone_target_matches_the_zone_count_gate():
    """The prompt tells the model to aim for 2-8 zones; the gate enforces
    2-8. If either moves without the other, the prompt is either asking
    for output the gate rejects or quietly relaxing the gate."""
    assert reorganise_v2.PROMPT_MIN_ZONES == runner.MIN_ZONES
    assert reorganise_v2.PROMPT_MAX_ZONES == runner.MAX_ZONES


def test_zone_count_gate_thresholds_are_unchanged_by_the_v2_1_revision():
    """Explicit guard: a prompt revision must never quietly widen the
    thresholds its own output is scored against."""
    assert (runner.MIN_ZONES, runner.MAX_ZONES) == (2, 8)
    assert runner.MAX_RECOVERY_RATE == 0.20
    assert runner.MIN_DISTINCT_OPERATIONS == 2
