"""
Unit tests for evaluation/scripts/compare_listing_drafts.py — the
marketplace-listing evaluation harness's fixture/candidate contracts,
planning arithmetic, execution protocol, heuristic screening, blinded
human-review queue, and CLI safety gates.

No Ollama is reachable anywhere in this file. Every model interaction
is a fake, injected exactly the way run_evaluation() requires; NO test
in this file passes or invokes the literal --execute-real-models flag,
including the one test proving `run` refuses to proceed without it (it
asserts on the refusal message's text, never supplies the flag itself).
Sanitised model-preflight-failure behaviour is covered at the
run_evaluation() level directly, and the CLI's own exit-1 messaging is
covered by calling _report_exit() directly against a hand-built
incomplete report — neither needs a real or even a fake Ollama module.
Artefacts are written to pytest tmp_path, never to evaluation/results/.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import get_settings
from app.core.listing_schemas import LISTING_MAX_ATTEMPTS_CEILING, ListingDraftContent
from app.models.listing_llm import build_listing_prompt
from evaluation.scripts import compare_listing_drafts as runner
from evaluation.scripts.compare_listing_drafts import (
    ALLOWED_CLAIM_CATEGORIES,
    DEFAULT_SEED,
    EVAL_PROMPT_VERSION,
    HUMAN_REVIEW_REQUIRED_FIELDS,
    MAX_TOTAL_CALLS_CEILING,
    PRODUCTION_PROMPT_VERSION,
    REVIEWER_PACKET_FORBIDDEN_SUBSTRINGS,
    CandidateConfig,
    CandidateContractError,
    CallBudgetExceededError,
    FixtureCase,
    FixtureContractError,
    FixtureSet,
    ModelAvailability,
    ModelCallError,
    ModelPreflightError,
    ResolvedModel,
    blinded_pair_order,
    build_human_review_queue,
    build_reviewer_packet,
    call_bounds,
    compute_heuristic_flags,
    fixture_content_sha256,
    human_review_entry_is_complete,
    load_candidate_set,
    load_fixture_set,
    parse_candidate_set,
    parse_fixture_set,
    resolve_prompt_builder,
    run_evaluation,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]
COMMITTED_FIXTURES = _BACKEND_DIR / "evaluation" / "fixtures" / "listing_draft_eval.json"
COMMITTED_CANDIDATES_EXAMPLE = _BACKEND_DIR / "evaluation" / "fixtures" / "listing_candidates.example.json"


# --- builders ----------------------------------------------------------


def make_case(index: int = 1, **overrides) -> dict:
    entry = {
        "case_id": f"case_{index:03d}",
        "item_label": "table lamp",
        "tags": ["clear_household"],
        "expected_label_facts": ["it is a lamp"],
        "forbidden_claim_categories": ["price", "brand_or_model"],
        "review_guidance": "no brand or price",
    }
    entry.update(overrides)
    return entry


_UNSET = object()


def fixture_file(cases=_UNSET, **overrides) -> dict:
    payload = {"schema_version": 1, "cases": [make_case(1)] if cases is _UNSET else cases}
    payload.update(overrides)
    return payload


def make_candidate(candidate_id: str = "prod", **overrides) -> dict:
    entry = {
        "candidate_id": candidate_id,
        "model_name": "phi4-mini",
        "prompt_version": "v1",
        "temperature": 0.2,
        "num_predict": 512,
        "max_attempts": 3,
    }
    entry.update(overrides)
    return entry


def candidate_file(candidates=_UNSET, **overrides) -> dict:
    payload = {"schema_version": 1, "candidates": [make_candidate()] if candidates is _UNSET else candidates}
    payload.update(overrides)
    return payload


def write_json(path: Path, payload: dict) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def valid_json_text(title: str = "A nice item", description: str | None = None) -> str:
    description = description or "A plain description of the item that is long enough to pass the bound."
    return json.dumps({"title": title, "description": description})


class ScriptedCaller:
    """A fake caller_fn: pops the next scripted outcome for a candidate,
    or raises AssertionError if it runs out — proving no extra calls
    happen beyond what a test scripted."""

    def __init__(self, script: list):
        self.script = list(script)
        self.calls: list[tuple[str, str]] = []

    def __call__(self, candidate: CandidateConfig, prompt: str) -> str:
        self.calls.append((candidate.candidate_id, prompt))
        if not self.script:
            raise AssertionError("ScriptedCaller ran out of scripted outcomes")
        outcome = self.script.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def fake_available(required: frozenset[str]) -> ModelAvailability:
    return ModelAvailability(
        available=required,
        resolved=tuple(
            ResolvedModel(requested_name=name, installed_name=name, digest=None) for name in sorted(required)
        ),
    )


def fake_clock():
    """A simple deterministic fake clock: each call advances by 1."""
    fake_clock.t += 1
    return fake_clock.t


fake_clock.t = 0.0


class ScriptedClock:
    """A fake clock returning a fixed sequence of values, for tests that
    need to control exactly how much elapsed time each attempt reports
    (to prove latency is summed across attempts, not just the last)."""

    def __init__(self, values: list[float]):
        self.values = list(values)

    def __call__(self) -> float:
        if not self.values:
            raise AssertionError("ScriptedClock ran out of scripted values")
        return self.values.pop(0)


# --- fixture contract --------------------------------------------------


def test_a_valid_fixture_parses():
    fs = parse_fixture_set(fixture_file())
    assert isinstance(fs, FixtureSet)
    assert fs.cases[0].item_label == "table lamp"


@pytest.mark.parametrize("raw", [None, "x", 1, [], True])
def test_a_non_object_fixture_is_rejected(raw):
    with pytest.raises(FixtureContractError):
        parse_fixture_set(raw)


@pytest.mark.parametrize("field", ["schema_version", "cases"])
def test_a_missing_top_level_field_is_rejected(field):
    payload = fixture_file()
    del payload[field]
    with pytest.raises(FixtureContractError):
        parse_fixture_set(payload)


def test_an_unexpected_top_level_field_is_rejected():
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file(extra_field=True))


def test_an_unsupported_schema_version_is_rejected():
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file(schema_version=2))


def test_cases_must_be_a_non_empty_array():
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file(cases=[]))


def test_more_than_max_cases_is_rejected():
    too_many = [make_case(i) for i in range(runner.MAX_CASES + 1)]
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file(too_many))


@pytest.mark.parametrize("field", sorted(runner.REQUIRED_CASE_FIELDS))
def test_a_missing_case_field_is_rejected(field):
    case = make_case()
    del case[field]
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file([case]))


def test_an_unexpected_case_field_is_rejected():
    case = make_case(unexpected="x")
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file([case]))


def test_a_duplicate_case_id_is_rejected():
    cases = [make_case(1, case_id="dup"), make_case(2, case_id="dup")]
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file(cases))


def test_forbidden_claim_categories_must_come_from_the_allowed_vocabulary():
    case = make_case(forbidden_claim_categories=["not_a_real_category"])
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file([case]))


def test_every_allowed_claim_category_is_individually_accepted():
    for category in sorted(ALLOWED_CLAIM_CATEGORIES):
        case = make_case(forbidden_claim_categories=[category])
        fs = parse_fixture_set(fixture_file([case]))
        assert fs.cases[0].forbidden_claim_categories == (category,)


def test_a_blank_item_label_is_rejected():
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file([make_case(item_label="   ")]))


def test_load_fixture_set_reports_a_missing_file_and_bad_json_as_contract_errors(tmp_path):
    with pytest.raises(FixtureContractError):
        load_fixture_set(tmp_path / "nope.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(FixtureContractError):
        load_fixture_set(bad)


def test_the_committed_fixture_file_satisfies_the_schema_and_covers_required_ground():
    fs = load_fixture_set(COMMITTED_FIXTURES)
    assert len(fs.cases) >= 10
    all_tags = {tag for case in fs.cases for tag in case.tags}
    assert "clear_household" in all_tags
    assert "ambiguous" in all_tags
    assert "prompt_injection" in all_tags
    assert "fabrication_tempting" in all_tags
    multiword_labels = [c for c in fs.cases if len(c.item_label.split()) > 1]
    assert len(multiword_labels) >= 3
    injection_cases = [c for c in fs.cases if "prompt_injection" in c.tags]
    assert len(injection_cases) >= 3


# --- reproducibility: deterministic fixture-content hashing ----------------


def test_fixture_content_sha256_is_deterministic_for_identical_content():
    fs_a = parse_fixture_set(fixture_file([make_case(1), make_case(2)]))
    fs_b = parse_fixture_set(fixture_file([make_case(1), make_case(2)]))
    assert fixture_content_sha256(fs_a) == fixture_content_sha256(fs_b)


def test_fixture_content_sha256_is_stable_across_source_whitespace_and_key_order():
    payload = fixture_file([make_case(1)])
    compact = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    spaced = json.dumps(payload, sort_keys=False, indent=4)
    fs_compact = parse_fixture_set(json.loads(compact))
    fs_spaced = parse_fixture_set(json.loads(spaced))
    assert fixture_content_sha256(fs_compact) == fixture_content_sha256(fs_spaced)


def test_fixture_content_sha256_changes_when_content_changes():
    fs_a = parse_fixture_set(fixture_file([make_case(1, item_label="table lamp")]))
    fs_b = parse_fixture_set(fixture_file([make_case(1, item_label="floor lamp")]))
    assert fixture_content_sha256(fs_a) != fixture_content_sha256(fs_b)


def test_report_records_the_fixture_content_sha256():
    report, _ = _run_single([make_case(1)], [make_candidate()], script=[valid_json_text()])
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    assert report["fixture"]["content_sha256"] == fixture_content_sha256(fs)


# --- candidate contract --------------------------------------------------


def test_a_valid_candidate_set_parses():
    candidates = parse_candidate_set(candidate_file())
    assert candidates[0].candidate_id == "prod"
    assert candidates[0].prompt_version == PRODUCTION_PROMPT_VERSION


@pytest.mark.parametrize("field", sorted(runner.REQUIRED_CANDIDATE_FIELDS))
def test_a_missing_candidate_field_is_rejected(field):
    candidate = make_candidate()
    del candidate[field]
    with pytest.raises(CandidateContractError):
        parse_candidate_set(candidate_file([candidate]))


def test_an_unexpected_candidate_field_is_rejected():
    candidate = make_candidate(unexpected="x")
    with pytest.raises(CandidateContractError):
        parse_candidate_set(candidate_file([candidate]))


def test_prompt_version_must_be_v1_or_the_registered_eval_version():
    ok = parse_candidate_set(
        candidate_file([make_candidate("prod"), make_candidate("evalc", prompt_version=EVAL_PROMPT_VERSION)])
    )
    assert {c.prompt_version for c in ok} == {PRODUCTION_PROMPT_VERSION, EVAL_PROMPT_VERSION}
    with pytest.raises(CandidateContractError):
        parse_candidate_set(
            candidate_file([make_candidate("prod"), make_candidate("bad", prompt_version="v2-imaginary")])
        )


@pytest.mark.parametrize("temperature", [-0.1, 2.1, float("nan"), float("inf")])
def test_temperature_out_of_bounds_or_non_finite_is_rejected(temperature):
    with pytest.raises(CandidateContractError):
        parse_candidate_set(candidate_file([make_candidate(temperature=temperature)]))


def test_temperature_boolean_is_rejected():
    with pytest.raises(CandidateContractError):
        parse_candidate_set(candidate_file([make_candidate(temperature=True)]))


@pytest.mark.parametrize("temperature", [0.0, 2.0, 0.2, 1.5])
def test_temperature_at_or_inside_bounds_is_accepted(temperature):
    candidates = parse_candidate_set(candidate_file([make_candidate(temperature=temperature)]))
    assert candidates[0].temperature == temperature


@pytest.mark.parametrize("num_predict", [0, -1, 1.5, True])
def test_num_predict_must_be_a_positive_genuine_integer(num_predict):
    with pytest.raises(CandidateContractError):
        parse_candidate_set(candidate_file([make_candidate(num_predict=num_predict)]))


@pytest.mark.parametrize("max_attempts", [0, LISTING_MAX_ATTEMPTS_CEILING + 1, 1.0, True])
def test_max_attempts_must_be_a_genuine_integer_in_bounds(max_attempts):
    with pytest.raises(CandidateContractError):
        parse_candidate_set(candidate_file([make_candidate(max_attempts=max_attempts)]))


def test_max_attempts_at_the_ceiling_is_accepted():
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=LISTING_MAX_ATTEMPTS_CEILING)]))
    assert candidates[0].max_attempts == LISTING_MAX_ATTEMPTS_CEILING


def test_a_duplicate_candidate_id_is_rejected():
    candidates = [make_candidate("a"), make_candidate("a", model_name="mistral")]
    with pytest.raises(CandidateContractError):
        parse_candidate_set(candidate_file(candidates))


def test_a_candidate_set_without_a_production_v1_candidate_is_rejected():
    with pytest.raises(CandidateContractError):
        parse_candidate_set(candidate_file([make_candidate(prompt_version=EVAL_PROMPT_VERSION)]))


def test_more_than_one_distinct_non_production_prompt_version_is_rejected():
    """parse_candidate_set() would already reject an unregistered prompt
    version, so this isolates validate_candidates()'s OWN cross-candidate
    rule using hand-built configs, bypassing the registration check."""
    candidates = (
        CandidateConfig("prod", "phi4-mini", "v1", 0.2, 512, 3),
        CandidateConfig("eval1", "phi4-mini", "eval-a1", 0.2, 512, 3),
        CandidateConfig("eval2", "phi4-mini", "eval-b2-hypothetical", 0.2, 512, 3),
    )
    with pytest.raises(CandidateContractError):
        runner.validate_candidates(candidates)


def test_reusing_the_same_eval_prompt_version_across_candidates_is_allowed():
    candidates = [
        make_candidate("prod", prompt_version="v1"),
        make_candidate("eval_a", prompt_version=EVAL_PROMPT_VERSION, temperature=0.2),
        make_candidate("eval_b", prompt_version=EVAL_PROMPT_VERSION, temperature=0.8),
    ]
    parsed = parse_candidate_set(candidate_file(candidates))
    assert len(parsed) == 3


def test_load_candidate_set_reports_a_missing_file_and_bad_json_as_contract_errors(tmp_path):
    with pytest.raises(CandidateContractError):
        load_candidate_set(tmp_path / "nope.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(CandidateContractError):
        load_candidate_set(bad)


def test_the_committed_example_candidate_file_satisfies_the_schema():
    candidates = load_candidate_set(COMMITTED_CANDIDATES_EXAMPLE)
    assert any(c.prompt_version == PRODUCTION_PROMPT_VERSION for c in candidates)
    assert any(c.prompt_version == EVAL_PROMPT_VERSION for c in candidates)


# --- prompt builders -----------------------------------------------------


def test_v1_resolves_to_the_exact_production_prompt_function():
    assert resolve_prompt_builder(PRODUCTION_PROMPT_VERSION) is build_listing_prompt


def test_eval_a1_resolves_to_a_distinct_callable_producing_valid_non_blank_text():
    builder = resolve_prompt_builder(EVAL_PROMPT_VERSION)
    assert builder is not build_listing_prompt
    text = builder("table lamp")
    assert isinstance(text, str) and text.strip()
    assert text != build_listing_prompt("table lamp")


def test_an_unregistered_prompt_version_is_rejected():
    with pytest.raises(CandidateContractError):
        resolve_prompt_builder("nonexistent-version")


def test_v1_candidate_sends_the_byte_identical_production_prompt(tmp_path):
    fs = parse_fixture_set(fixture_file([make_case(item_label="wooden chair")]))
    candidates = parse_candidate_set(candidate_file([make_candidate("prod")]))
    caller = ScriptedCaller([valid_json_text()])

    run_evaluation(
        fs, candidates, caller_fn=caller, models_available_fn=fake_available, clock_fn=fake_clock, save=None
    )

    assert len(caller.calls) == 1
    _, sent_prompt = caller.calls[0]
    assert sent_prompt == build_listing_prompt("wooden chair")


# --- heuristic flags -------------------------------------------------------


def test_a_clean_description_flags_nothing():
    flags = compute_heuristic_flags("A sturdy wooden chair suitable for a dining table.")
    assert flags.any_flag() is False


def test_price_flag():
    assert compute_heuristic_flags("Selling for $50 today").price is True
    assert compute_heuristic_flags("A plain chair").price is False


def test_contact_details_flag_email_phone_and_words():
    assert compute_heuristic_flags("email me at buyer@example.test").contact_details is True
    assert compute_heuristic_flags("call 555-123-4567 now").contact_details is True
    assert compute_heuristic_flags("please contact me for details").contact_details is True
    assert compute_heuristic_flags("a plain chair").contact_details is False


def test_links_flag():
    assert compute_heuristic_flags("visit http://example.test for more").links is True
    assert compute_heuristic_flags("see www.example.test").links is True
    assert compute_heuristic_flags("a plain chair").links is False


def test_hashtags_flag():
    assert compute_heuristic_flags("great chair #furniture #sale").hashtags is True
    assert compute_heuristic_flags("a plain chair").hashtags is False


def test_emoji_flag():
    assert compute_heuristic_flags("great chair \U0001F600").emoji is True
    assert compute_heuristic_flags("a plain chair").emoji is False


def test_condition_claims_flag():
    assert compute_heuristic_flags("this is brand new and unused").condition_claims is True
    assert compute_heuristic_flags("a plain chair").condition_claims is False


def test_functionality_claims_flag():
    assert compute_heuristic_flags("fully tested and working").functionality_claims is True
    assert compute_heuristic_flags("a plain chair").functionality_claims is False


def test_dimensions_flag():
    assert compute_heuristic_flags("measures 30 cm across").dimensions is True
    assert compute_heuristic_flags("a plain chair").dimensions is False


def test_brand_or_model_claims_flag_named_brand_and_model_number():
    assert compute_heuristic_flags("a genuine Apple product").brand_or_model_claims is True
    assert compute_heuristic_flags("model AB-1234").brand_or_model_claims is True
    assert compute_heuristic_flags("a plain chair").brand_or_model_claims is False


def test_as_dict_reports_every_field():
    flags = compute_heuristic_flags("a plain chair")
    assert set(flags.as_dict()) == {f.name for f in __import__("dataclasses").fields(runner.HeuristicFlags)}


# --- planning: call_bounds and blinding ------------------------------------


def test_call_bounds_exact_arithmetic():
    bounds = call_bounds(case_count=3, candidate_max_attempts=[3, 2], reps=2)
    assert bounds["planned_calls_minimum"] == 3 * 2 * 2
    assert bounds["planned_calls_upper_bound"] == (3 * 2 * 3) + (3 * 2 * 2)
    assert bounds["max_total_calls_ceiling"] == MAX_TOTAL_CALLS_CEILING


def test_call_bounds_rejects_negative_case_count():
    with pytest.raises(ValueError):
        call_bounds(case_count=-1, candidate_max_attempts=[3], reps=1)


def test_call_bounds_rejects_reps_below_one():
    with pytest.raises(ValueError):
        call_bounds(case_count=1, candidate_max_attempts=[3], reps=0)


def test_call_bounds_makes_no_wall_clock_claim():
    bounds = call_bounds(case_count=1, candidate_max_attempts=[1], reps=1)
    serialised = json.dumps(bounds)
    assert "second" not in serialised.lower() or "wall-clock" in bounds["_note"]
    assert "ms" not in serialised


def test_blinded_pair_order_is_deterministic_for_the_same_seed():
    order_a = blinded_pair_order(42, ["c1", "c2"], ["k1", "k2"])
    order_b = blinded_pair_order(42, ["c1", "c2"], ["k1", "k2"])
    assert order_a == order_b


def test_blinded_pair_order_contains_every_pair_exactly_once():
    order = blinded_pair_order(1, ["c1", "c2", "c3"], ["k1", "k2"])
    expected = {(c, k) for c in ["c1", "c2", "c3"] for k in ["k1", "k2"]}
    assert set(order) == expected
    assert len(order) == len(expected)


def test_different_seeds_can_produce_different_orders():
    orders = {tuple(blinded_pair_order(seed, ["c1", "c2", "c3", "c4"], ["k1", "k2"])) for seed in range(10)}
    assert len(orders) > 1


def test_blinded_pair_order_is_content_independent_and_usable_before_any_call():
    # No results, no candidates beyond ids, purely structural — this is
    # exactly what `plan` computes before touching a model.
    order = blinded_pair_order(DEFAULT_SEED, ["only_case"], ["only_candidate"])
    assert order == [("only_case", "only_candidate")]


# --- execution protocol: fixture validation before any model call ---------


def test_parsing_a_malformed_fixture_never_constructs_a_caller_or_touches_models():
    with pytest.raises(FixtureContractError):
        parse_fixture_set(fixture_file(cases=[]))
    # No caller_fn/models_available_fn is even accepted by this call —
    # structurally impossible for a model to be touched here.


# --- execution protocol: retries, outcomes, attempt accounting ------------


def _run_single(fixture_cases, candidates_raw, script, *, reps=1, seed=DEFAULT_SEED, max_total_calls=None):
    fs = parse_fixture_set(fixture_file(fixture_cases))
    candidates = parse_candidate_set(candidate_file(candidates_raw))
    caller = ScriptedCaller(script)
    kwargs = {}
    if max_total_calls is not None:
        kwargs["max_total_calls"] = max_total_calls
    report = run_evaluation(
        fs,
        candidates,
        reps=reps,
        seed=seed,
        caller_fn=caller,
        models_available_fn=fake_available,
        clock_fn=fake_clock,
        save=None,
        **kwargs,
    )
    return report, caller


def test_one_fake_call_per_planned_attempt_when_every_attempt_fails():
    report, caller = _run_single(
        [make_case(1)],
        [make_candidate(max_attempts=3)],
        script=["not json"] * 3,
    )
    assert len(caller.calls) == 3
    row = report["results"][0]
    assert row["attempts"] == 3
    assert row["final_status"] == "unavailable"
    assert row["unavailable_reason"] == "invalid_json"


def test_success_on_a_later_attempt_stops_retrying():
    report, caller = _run_single(
        [make_case(1)],
        [make_candidate(max_attempts=3)],
        script=["not json", valid_json_text()],
    )
    assert len(caller.calls) == 2
    row = report["results"][0]
    assert row["attempts"] == 2
    assert row["final_status"] == "generated"


def test_transport_failure_is_retried_then_recorded_as_unavailable():
    report, caller = _run_single(
        [make_case(1)],
        [make_candidate(max_attempts=2)],
        script=[ModelCallError("boom"), ModelCallError("boom")],
    )
    assert len(caller.calls) == 2
    row = report["results"][0]
    assert row["final_status"] == "unavailable"
    assert row["unavailable_reason"] == "transport_or_model_error"
    assert row["raw_text"] is None


def test_a_non_model_call_error_propagates_unchanged():
    with pytest.raises(RuntimeError, match="not a ModelCallError"):
        _run_single(
            [make_case(1)],
            [make_candidate(max_attempts=3)],
            script=[RuntimeError("not a ModelCallError")],
        )


def test_valid_json_with_an_extra_field_is_schema_invalid():
    raw = json.dumps({"title": "T", "description": "A description long enough to pass the bound.", "price": "5"})
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[raw])
    row = report["results"][0]
    assert row["json_extraction"]["is_valid_json"] is True
    assert row["schema_valid"] is False
    assert row["unavailable_reason"] == "schema_invalid"
    assert row["schema_errors"]
    assert row["field_diagnostics"]["extra_fields"] == ["price"]


def test_valid_json_missing_the_description_field_reports_it():
    raw = json.dumps({"title": "T"})
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[raw])
    row = report["results"][0]
    assert row["field_diagnostics"]["missing_fields"] == ["description"]


def test_json_needing_trailing_comma_repair_is_flagged_was_repaired():
    raw = '{"title": "A valid title", "description": "A description long enough to pass the bound.",}'
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[raw])
    row = report["results"][0]
    assert row["json_extraction"]["was_repaired"] is True
    assert row["schema_valid"] is True


def test_a_clean_first_try_is_not_marked_repaired():
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[valid_json_text()])
    row = report["results"][0]
    assert row["json_extraction"]["was_repaired"] is False
    assert row["attempts"] == 1


def test_title_too_short_fails_the_real_listing_draft_content_bound():
    raw = json.dumps({"title": "T", "description": "A description long enough to pass the bound."})
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[raw])
    row = report["results"][0]
    assert row["schema_valid"] is False
    with pytest.raises(ValidationError):
        ListingDraftContent(title="T", description="A description long enough to pass the bound.")


def test_description_too_short_fails_the_real_listing_draft_content_bound():
    raw = json.dumps({"title": "A valid title", "description": "short"})
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[raw])
    assert report["results"][0]["schema_valid"] is False


def test_unavailable_rows_have_no_heuristic_flags():
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=["not json"])
    assert report["results"][0]["heuristic_flags"] is None


def test_generated_rows_carry_heuristic_flags_over_title_and_description():
    raw = json.dumps({"title": "Selling for $50", "description": "A description long enough to pass the bound."})
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[raw])
    row = report["results"][0]
    assert row["heuristic_flags"]["price"] is True


def test_raw_text_is_retained_only_in_the_results_list_not_in_summary_or_review_queue():
    raw = json.dumps({"title": "Selling for $50", "description": "A description long enough to pass the bound."})
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[raw])
    assert report["results"][0]["raw_text"] == raw
    assert raw not in json.dumps(report["summary"])
    assert raw not in json.dumps(report["human_review_queue"])


# --- attempt-correct diagnostics and end-to-end unit timing ----------------


def test_attempts_detail_has_one_ordered_entry_per_attempt_with_its_own_diagnostics():
    raw_bad = "not json"
    raw_good = valid_json_text()
    report, caller = _run_single(
        [make_case(1)], [make_candidate(max_attempts=3)], script=[raw_bad, ModelCallError("boom"), raw_good]
    )
    assert len(caller.calls) == 3
    detail = report["results"][0]["attempts_detail"]
    assert [d["attempt"] for d in detail] == [1, 2, 3]
    assert [d["outcome"] for d in detail] == ["invalid_json", "transport_or_model_error", "generated"]
    # Attempt 1's own diagnostics: it DID get text, it just wasn't JSON.
    assert detail[0]["raw_text"] == raw_bad
    assert detail[0]["json_extraction"] == {"is_valid_json": False, "was_repaired": False}
    # Attempt 2 is a transport failure: no text, no JSON diagnostics at all.
    assert detail[1]["raw_text"] is None
    assert detail[1]["json_extraction"] is None
    assert detail[1]["field_diagnostics"] is None
    # Attempt 3 succeeded.
    assert detail[2]["raw_text"] == raw_good
    assert detail[2]["json_extraction"]["is_valid_json"] is True


def test_a_transport_failure_after_a_schema_failure_does_not_retain_stale_diagnostics_or_raw_text():
    """Regression: attempt 1 gets syntactically valid JSON with an extra
    field (schema_invalid, real diagnostics, real raw text); attempt 2 is
    a pure transport failure with no text at all. The FINAL unit result
    must reflect attempt 2 only — no extra_fields, no schema_errors, and
    no raw_text leaking over from attempt 1."""
    raw_schema_invalid = json.dumps(
        {"title": "A valid title", "description": "A description long enough to pass the bound.", "price": "5"}
    )
    report, caller = _run_single(
        [make_case(1)],
        [make_candidate(max_attempts=2)],
        script=[raw_schema_invalid, ModelCallError("boom")],
    )
    assert len(caller.calls) == 2
    row = report["results"][0]
    assert row["unavailable_reason"] == "transport_or_model_error"
    assert row["raw_text"] is None, "the LAST attempt returned no text; it must not inherit attempt 1's text"
    assert row["field_diagnostics"] is None, "the LAST attempt never parsed JSON; it must not inherit attempt 1's"
    assert row["schema_errors"] is None, "the LAST attempt never reached schema validation"
    assert row["json_extraction"] == {"is_valid_json": False, "was_repaired": False}


def test_unit_latency_sums_every_attempt_including_failed_ones_not_just_the_final_call():
    # Attempt 1 (fails): clock ticks 0 -> 0.1 = 100ms. Attempt 2
    # (succeeds): clock ticks 0.1 -> 0.35 = 250ms. Total must be 350ms,
    # not just the successful attempt's 250ms.
    clock = ScriptedClock([0.0, 0.1, 0.1, 0.35])
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=2)]))
    caller = ScriptedCaller(["not json", valid_json_text()])

    report = run_evaluation(
        fs, candidates, reps=1, caller_fn=caller, models_available_fn=fake_available, clock_fn=clock
    )

    row = report["results"][0]
    assert row["final_status"] == "generated"
    assert row["latency_ms"] == pytest.approx(350.0)
    assert row["attempts_detail"][0]["elapsed_ms"] == pytest.approx(100.0)
    assert row["attempts_detail"][1]["elapsed_ms"] == pytest.approx(250.0)


def test_unit_latency_is_recorded_for_unavailable_units_not_just_generated_ones():
    clock = ScriptedClock([0.0, 0.05, 0.05, 0.2])  # 50ms + 150ms = 200ms, both attempts fail
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=2)]))
    caller = ScriptedCaller(["not json", "still not json"])

    report = run_evaluation(
        fs, candidates, reps=1, caller_fn=caller, models_available_fn=fake_available, clock_fn=clock
    )

    row = report["results"][0]
    assert row["final_status"] == "unavailable"
    assert row["latency_ms"] == pytest.approx(200.0)


def test_candidate_latency_summary_includes_unavailable_units_end_to_end():
    """Regression: the candidate-level latency stats must be computed
    over EVERY unit's end-to-end latency, including unavailable units —
    not silently restricted to generated ones (which would previously
    have excluded every unavailable row, since its latency_ms was None)."""
    clock = ScriptedClock([0.0, 0.2, 0.2, 0.4])  # case 1: 200ms generated; case 2: 200ms unavailable
    fs = parse_fixture_set(fixture_file([make_case(1), make_case(2)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))
    caller = ScriptedCaller([valid_json_text(), "not json"])

    report = run_evaluation(
        fs, candidates, reps=1, caller_fn=caller, models_available_fn=fake_available, clock_fn=clock
    )

    latency_stats = report["summary"]["by_candidate"]["prod"]["all_repetitions"]["latency_ms"]
    assert latency_stats["count"] == 2  # both units counted, not just the generated one
    assert latency_stats["max_ms"] == pytest.approx(200.0)


# --- reps and determinism ---------------------------------------------------


def test_deterministic_repetitions_are_reported_all_deterministic():
    report, caller = _run_single(
        [make_case(1)],
        [make_candidate(max_attempts=1)],
        script=[valid_json_text(), valid_json_text()],
        reps=2,
    )
    assert len(caller.calls) == 2
    det = report["summary"]["by_candidate"]["prod"]["determinism"]
    assert det["all_deterministic"] is True
    assert det["non_deterministic_case_ids"] == []


def test_a_divergence_across_repetitions_is_recorded_not_averaged_away():
    report, _ = _run_single(
        [make_case(1)],
        [make_candidate(max_attempts=1)],
        script=[valid_json_text("Title A"), valid_json_text("Title B")],
        reps=2,
    )
    det = report["summary"]["by_candidate"]["prod"]["determinism"]
    assert det["all_deterministic"] is False
    assert "case_001" in det["non_deterministic_case_ids"]


def test_determinism_is_none_when_reps_is_one():
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[valid_json_text()], reps=1)
    assert report["summary"]["by_candidate"]["prod"]["determinism"] is None


def test_determinism_is_unassessable_not_false_when_rep_0_succeeds_and_rep_1_fails():
    """Required regression: an unavailable repetition must make that
    case's determinism UNASSESSABLE, never silently "non-deterministic"
    (which claims two different usable outputs were observed — that
    never happened here) and never counted toward all_deterministic."""
    report, caller = _run_single(
        [make_case(1)],
        [make_candidate(max_attempts=1)],
        script=[valid_json_text(), "not json"],  # rep 0 succeeds, rep 1 fails
        reps=2,
    )
    assert len(caller.calls) == 2
    det = report["summary"]["by_candidate"]["prod"]["determinism"]
    assert det["deterministic_case_ids"] == []
    assert det["non_deterministic_case_ids"] == []
    assert det["unassessable_case_ids"] == ["case_001"]
    assert "unavailable" in det["unassessable_reasons"]["case_001"]
    assert det["all_deterministic"] is False


def test_determinism_is_unassessable_when_a_repetition_is_missing_entirely():
    """Defensive: build_human_review_queue / _determinism_for_candidate
    must not crash or claim determinism if a case somehow has fewer
    result rows than `reps` — it must be unassessable, with a stated
    reason, exactly like an unavailable repetition."""
    cases = (FixtureCase("c1", "lamp", ("t",), ("f",), ("price",), "g"),)
    candidates = (CandidateConfig("k1", "phi4-mini", "v1", 0.2, 512, 3),)
    results = [
        {
            "case_id": "c1",
            "candidate_id": "k1",
            "rep": 0,
            "final_status": "generated",
            "title": "T",
            "description": "D",
        }
    ]  # only 1 of 2 "reps" recorded
    det = runner._determinism_for_candidate(results, "k1", reps=2)
    assert det["unassessable_case_ids"] == ["c1"]
    assert "1 of 2" in det["unassessable_reasons"]["c1"]
    assert det["all_deterministic"] is False


def test_rep0_and_all_repetitions_summaries_are_separate_and_can_differ():
    """Required: automated summaries must either cover all repetitions or
    expose clearly separated rep0 / all_repetitions blocks — never
    silently present a rep-0-only figure as a whole-run rate. Here rep 0
    is generated for both cases but rep 1 fails for one of them, so the
    two summaries genuinely diverge."""
    report, caller = _run_single(
        [make_case(1), make_case(2)],
        [make_candidate(max_attempts=1)],
        script=[valid_json_text(), valid_json_text(), valid_json_text(), "not json"],
        reps=2,
    )
    assert len(caller.calls) == 4
    stats = report["summary"]["by_candidate"]["prod"]
    assert stats["rep0"]["unit_count"] == 2
    assert stats["rep0"]["generated_count"] == 2  # both cases' rep 0 succeeded
    assert stats["all_repetitions"]["unit_count"] == 4
    assert stats["all_repetitions"]["generated_count"] == 3  # one rep 1 failed
    assert stats["rep0"]["schema_valid_rate"] != stats["all_repetitions"]["schema_valid_rate"]


def test_the_human_review_queue_note_documents_the_rep0_only_boundary():
    report, _ = _run_single(
        [make_case(1)], [make_candidate(max_attempts=1)], script=[valid_json_text(), valid_json_text()], reps=2
    )
    assert "rep 0" in report["human_review_queue_note"]


def test_bounds_state_determinism_is_not_assessed_with_one_repetition():
    bounds = call_bounds(case_count=1, candidate_max_attempts=[1], reps=1)
    assert bounds["determinism_assessable_with_these_reps"] is False
    assert "not assessed" in bounds["_note"].lower() or "reps=1" in bounds["_note"]

    bounds_two_reps = call_bounds(case_count=1, candidate_max_attempts=[1], reps=2)
    assert bounds_two_reps["determinism_assessable_with_these_reps"] is True


def test_plan_prints_an_explicit_reps_one_determinism_note(tmp_path, capsys):
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1)]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate()]))

    rc = runner.main(["plan", "--fixtures", str(fixtures_path), "--candidates", str(candidates_path), "--reps", "1"])

    assert rc == 0
    out = capsys.readouterr().out
    assert "determinism" in out.lower()
    assert "not assessed" in out.lower() or "reps=1" in out.lower()


# --- planned-call arithmetic and the hard ceiling --------------------------


def test_the_reports_bounds_match_call_bounds_exactly():
    report, _ = _run_single(
        [make_case(1), make_case(2)],
        [make_candidate("a", max_attempts=2), make_candidate("b", max_attempts=1)],
        script=[valid_json_text()] * 5,  # more than enough; only some will be consumed
    )
    expected = call_bounds(2, [2, 1], 1)
    assert report["bounds"] == expected


def test_exceeding_the_ceiling_raises_before_any_call():
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=5)]))
    caller = ScriptedCaller([])  # would raise AssertionError if ever called
    with pytest.raises(CallBudgetExceededError):
        run_evaluation(
            fs,
            candidates,
            reps=1,
            caller_fn=caller,
            models_available_fn=fake_available,
            clock_fn=fake_clock,
            max_total_calls=1,
        )
    assert caller.calls == []


def test_a_generous_ceiling_permits_the_run():
    report, _ = _run_single(
        [make_case(1)], [make_candidate(max_attempts=1)], script=[valid_json_text()], max_total_calls=1000
    )
    assert report["status"] == "complete"


# --- model preflight: availability, never a download -----------------------


def test_a_missing_local_model_aborts_before_the_first_call():
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(model_name="phi4-mini")]))
    caller = ScriptedCaller([])

    def missing(required):
        return ModelAvailability(
            available=frozenset(),
            resolved=tuple(ResolvedModel(requested_name=n, installed_name=None, digest=None) for n in required),
        )

    report = run_evaluation(
        fs, candidates, reps=1, caller_fn=caller, models_available_fn=missing, clock_fn=fake_clock
    )
    assert report["status"] == "incomplete"
    assert "phi4-mini" in report["incomplete_reason"]
    assert caller.calls == []


def test_when_every_model_is_available_the_preflight_records_it_and_proceeds():
    report, _ = _run_single([make_case(1)], [make_candidate()], script=[valid_json_text()])
    assert report["model_preflight"]["checked"] is True
    assert report["model_preflight"]["missing"] == []
    assert len(report["model_preflight"]["resolved_models"]) == 1


def test_a_model_preflight_error_becomes_a_sanitised_incomplete_result_with_no_raw_detail():
    """Required: an expected Ollama/HTTP/transport failure while checking
    availability must become a FIXED, sanitised incomplete result, not
    propagate as a raw exception. No host, URL, token or exception text
    reaches the artefact."""
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate()]))
    caller = ScriptedCaller([])  # would raise AssertionError if ever called

    def failing_availability(required):
        raise ModelPreflightError("model availability check failed: local model service unreachable")

    report = run_evaluation(
        fs, candidates, reps=1, caller_fn=caller, models_available_fn=failing_availability, clock_fn=fake_clock
    )

    assert report["status"] == "incomplete"
    assert caller.calls == []
    assert "transport or service error" in report["incomplete_reason"]
    assert "unreachable" not in report["incomplete_reason"]  # the raw message text never leaks through
    assert report["model_preflight"]["checked"] is True
    serialised = json.dumps(report)
    assert "unreachable" not in serialised


def test_run_evaluation_propagates_an_unexpected_exception_from_models_available_fn():
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate()]))

    def buggy_availability(required):
        raise AssertionError("a genuine programming defect in the injected fake")

    with pytest.raises(AssertionError):
        run_evaluation(
            fs,
            candidates,
            reps=1,
            caller_fn=ScriptedCaller([]),
            models_available_fn=buggy_availability,
            clock_fn=fake_clock,
        )


def test_report_exit_returns_1_and_claims_neither_artifact_when_the_report_is_incomplete(capsys, tmp_path):
    """Fake-backed, no CLI subcommand and no --execute-real-models flag
    anywhere: proves _report_exit's exit-1 + "claim nothing succeeded"
    contract directly against a hand-built incomplete report, which is
    exactly what run_evaluation() returns on a sanitised preflight
    failure (see test_a_model_preflight_error_becomes_a_sanitised_
    incomplete_result_with_no_raw_detail above)."""
    report = {
        "status": "incomplete",
        "incomplete_reason": "model availability check failed (transport or service error)",
    }
    out_path = tmp_path / "report.json"

    rc = runner._report_exit(report, out_path)

    assert rc == 1
    printed = capsys.readouterr()
    assert printed.out == ""
    assert "Wrote researcher report" not in printed.out
    assert "Wrote blinded reviewer packet" not in printed.out
    assert str(out_path) in printed.err
    assert report["incomplete_reason"] in printed.err


def test_report_exit_returns_0_and_reports_both_artifacts_when_the_report_is_complete(capsys, tmp_path):
    report = {"status": "complete"}
    out_path = tmp_path / "report.json"

    rc = runner._report_exit(report, out_path)

    assert rc == 0
    printed = capsys.readouterr()
    assert f"Wrote researcher report to {out_path}" in printed.out
    assert f"Wrote blinded reviewer packet to {runner._reviewer_packet_path(out_path)}" in printed.out


def test_real_models_available_never_calls_pull_and_reports_only_present_models_dict_shaped(monkeypatch):
    class FakeClient:
        def __init__(self, present):
            self._present = present

        def list(self):
            return {"models": [{"name": n, "digest": f"sha256:{n}"} for n in self._present]}

    class FakeOllamaModule:
        def __init__(self, present):
            self._present = present

        def Client(self, *args, **kwargs):
            return FakeClient(self._present)

    fake_module = FakeOllamaModule({"phi4-mini", "mistral:latest"})
    monkeypatch.setattr(runner, "_default_ollama_module", lambda: fake_module)

    availability = runner.real_models_available(frozenset({"phi4-mini", "mistral", "not-there"}))
    assert availability.available == frozenset({"phi4-mini", "mistral"})
    # FakeClient exposes no pull-like method at all; if the implementation
    # ever tried to call one, this test would already have raised.

    by_name = {r.requested_name: r for r in availability.resolved}
    assert by_name["phi4-mini"] == ResolvedModel("phi4-mini", "phi4-mini", "sha256:phi4-mini")
    assert by_name["mistral"] == ResolvedModel("mistral", "mistral:latest", "sha256:mistral:latest")
    assert by_name["not-there"] == ResolvedModel("not-there", None, None)  # explicit null, never fabricated


def test_real_models_available_supports_object_shaped_responses_with_digest(monkeypatch):
    class FakeModelEntry:
        def __init__(self, model, digest=None):
            self.model = model
            self.digest = digest

    class FakeListResponse:
        def __init__(self, models):
            self.models = models

    class FakeClient:
        def list(self):
            return FakeListResponse([FakeModelEntry("phi4-mini", digest="sha256:abc123")])

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    availability = runner.real_models_available(frozenset({"phi4-mini"}))
    assert availability.available == frozenset({"phi4-mini"})
    assert availability.resolved == (ResolvedModel("phi4-mini", "phi4-mini", "sha256:abc123"),)


def test_real_models_available_leaves_digest_null_when_not_supplied(monkeypatch):
    class FakeClient:
        def list(self):
            return {"models": [{"name": "phi4-mini"}]}  # no digest key at all

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    availability = runner.real_models_available(frozenset({"phi4-mini"}))
    assert availability.resolved == (ResolvedModel("phi4-mini", "phi4-mini", None),)


def test_real_models_available_wraps_operational_errors_as_model_preflight_error_with_no_raw_detail(monkeypatch):
    class FakeClient:
        def list(self):
            raise ConnectionError("connection refused to 10.0.0.9:11434 with token abc123")

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    with pytest.raises(ModelPreflightError) as exc_info:
        runner.real_models_available(frozenset({"phi4-mini"}))
    assert "10.0.0.9" not in str(exc_info.value)
    assert "abc123" not in str(exc_info.value)
    assert "token" not in str(exc_info.value)


def test_real_models_available_propagates_unexpected_exceptions(monkeypatch):
    class FakeClient:
        def list(self):
            raise AssertionError("a genuine programming defect")

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    with pytest.raises(AssertionError):
        runner.real_models_available(frozenset({"phi4-mini"}))


def test_real_models_available_sanitises_a_malformed_response_shape(monkeypatch):
    class FakeClient:
        def list(self):
            return object()  # neither dict-shaped nor has a .models attribute

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    with pytest.raises(ModelPreflightError):
        runner.real_models_available(frozenset({"phi4-mini"}))


# --- exact model/tag resolution -----------------------------------------


def _fake_ollama_listing(monkeypatch, models: list[dict]):
    class FakeClient:
        def list(self):
            return {"models": models}

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())


def test_an_arbitrary_installed_tag_does_not_satisfy_an_untagged_request(monkeypatch):
    """Requested 'mistral' (untagged) must match only an exact 'mistral'
    entry or its explicit 'mistral:latest' form, never an arbitrary
    other tag such as 'mistral:q4_K_M' — a different quantisation/build
    that `ollama.chat(model='mistral')` would never actually select."""
    _fake_ollama_listing(monkeypatch, [{"name": "mistral:q4_K_M", "digest": "sha256:q4"}])

    availability = runner.real_models_available(frozenset({"mistral"}))

    assert availability.available == frozenset()
    assert availability.resolved == (ResolvedModel("mistral", None, None),)


def test_an_exact_tagged_request_matches_only_that_exact_tag(monkeypatch):
    _fake_ollama_listing(
        monkeypatch,
        [
            {"name": "mistral:q4_K_M", "digest": "sha256:q4"},
            {"name": "mistral:latest", "digest": "sha256:latest"},
        ],
    )

    availability = runner.real_models_available(frozenset({"mistral:q4_K_M"}))

    assert availability.available == frozenset({"mistral:q4_K_M"})
    assert availability.resolved == (ResolvedModel("mistral:q4_K_M", "mistral:q4_K_M", "sha256:q4"),)


def test_an_untagged_installed_entry_satisfies_an_untagged_request_exactly(monkeypatch):
    _fake_ollama_listing(monkeypatch, [{"name": "phi4-mini", "digest": "sha256:x"}])

    availability = runner.real_models_available(frozenset({"phi4-mini"}))

    assert availability.resolved == (ResolvedModel("phi4-mini", "phi4-mini", "sha256:x"),)


def test_an_explicit_latest_tag_satisfies_an_untagged_request(monkeypatch):
    _fake_ollama_listing(monkeypatch, [{"name": "phi4-mini:latest", "digest": "sha256:y"}])

    availability = runner.real_models_available(frozenset({"phi4-mini"}))

    assert availability.available == frozenset({"phi4-mini"})
    assert availability.resolved == (ResolvedModel("phi4-mini", "phi4-mini:latest", "sha256:y"),)


def test_multiple_installed_tags_only_the_exact_or_latest_form_resolves(monkeypatch):
    _fake_ollama_listing(
        monkeypatch,
        [
            {"name": "mistral:7b", "digest": "sha256:7b"},
            {"name": "mistral:q4_K_M", "digest": "sha256:q4"},
        ],
    )

    # Neither installed tag is bare "mistral" nor "mistral:latest", so an
    # untagged request matches nothing.
    availability = runner.real_models_available(frozenset({"mistral"}))
    assert availability.available == frozenset()
    assert availability.resolved == (ResolvedModel("mistral", None, None),)

    # But each exact tagged request resolves to its own exact entry.
    availability2 = runner.real_models_available(frozenset({"mistral:7b", "mistral:q4_K_M"}))
    assert availability2.available == frozenset({"mistral:7b", "mistral:q4_K_M"})
    by_name = {r.requested_name: r for r in availability2.resolved}
    assert by_name["mistral:7b"] == ResolvedModel("mistral:7b", "mistral:7b", "sha256:7b")
    assert by_name["mistral:q4_K_M"] == ResolvedModel("mistral:q4_K_M", "mistral:q4_K_M", "sha256:q4")


def test_object_shaped_response_exact_tag_resolution(monkeypatch):
    class FakeModelEntry:
        def __init__(self, model, digest=None):
            self.model = model
            self.digest = digest

    class FakeListResponse:
        def __init__(self, models):
            self.models = models

    class FakeClient:
        def list(self):
            return FakeListResponse([FakeModelEntry("mistral:q4_K_M", digest="sha256:q4")])

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    availability = runner.real_models_available(frozenset({"mistral"}))
    assert availability.available == frozenset()
    assert availability.resolved == (ResolvedModel("mistral", None, None),)


@pytest.mark.parametrize("bad_models_value", [None, "not-a-list", 5, {"unexpected": "dict"}, b"bytes"])
def test_a_missing_or_non_collection_models_value_is_a_preflight_error_not_all_missing(monkeypatch, bad_models_value):
    """A malformed `models` value must never be silently treated as
    'zero models installed' (which would report every requested model as
    missing rather than surfacing that the response itself is broken)."""

    class FakeClient:
        def list(self):
            return {"models": bad_models_value} if bad_models_value is not None else {}

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    with pytest.raises(ModelPreflightError):
        runner.real_models_available(frozenset({"phi4-mini"}))


def test_an_object_shaped_response_with_a_non_collection_models_attribute_is_a_preflight_error(monkeypatch):
    class FakeListResponse:
        def __init__(self):
            self.models = "not-a-list"

    class FakeClient:
        def list(self):
            return FakeListResponse()

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    with pytest.raises(ModelPreflightError):
        runner.real_models_available(frozenset({"phi4-mini"}))


def test_wholly_malformed_model_entries_is_a_preflight_error_not_all_missing(monkeypatch):
    _fake_ollama_listing(monkeypatch, [1, 2, object()])  # none carry a usable name/model attribute

    with pytest.raises(ModelPreflightError):
        runner.real_models_available(frozenset({"phi4-mini"}))


def test_partially_malformed_model_entries_are_skipped_and_the_rest_still_resolve(monkeypatch):
    class FakeClient:
        def list(self):
            return {"models": [123, {"name": "phi4-mini", "digest": "sha256:x"}]}

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    availability = runner.real_models_available(frozenset({"phi4-mini"}))
    assert availability.available == frozenset({"phi4-mini"})


def test_an_empty_models_list_means_nothing_is_installed_not_malformed(monkeypatch):
    _fake_ollama_listing(monkeypatch, [])

    availability = runner.real_models_available(frozenset({"phi4-mini"}))

    assert availability.available == frozenset()
    assert availability.resolved == (ResolvedModel("phi4-mini", None, None),)


def test_real_model_caller_never_calls_pull_and_returns_raw_text(monkeypatch):
    calls = []

    class FakeClient:
        def chat(self, **kwargs):
            calls.append(kwargs)
            return {"message": {"content": '{"title": "T", "description": "D is long enough for the bound."}'}}

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())

    candidate = CandidateConfig("c", "phi4-mini", "v1", 0.2, 512, 3)
    caller = runner.real_model_caller_factory(host=None, timeout_s=60.0)
    text = caller(candidate, "a prompt")

    assert json.loads(text)["title"] == "T"
    assert calls[0]["model"] == "phi4-mini"
    assert calls[0]["options"]["temperature"] == 0.2
    assert calls[0]["options"]["num_predict"] == 512


def test_real_model_caller_wraps_any_exception_as_model_call_error_with_no_raw_detail(monkeypatch):
    class FakeClient:
        def chat(self, **kwargs):
            raise ConnectionError("connection refused to 10.0.0.5:11434 with secret token abc123")

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())
    candidate = CandidateConfig("c", "phi4-mini", "v1", 0.2, 512, 3)
    caller = runner.real_model_caller_factory(host=None, timeout_s=60.0)

    with pytest.raises(ModelCallError) as exc_info:
        caller(candidate, "a prompt")
    assert "secret token" not in str(exc_info.value)
    assert "10.0.0.5" not in str(exc_info.value)
    assert "ConnectionError" in str(exc_info.value)


def test_real_model_caller_propagates_unexpected_exceptions_from_the_client_call(monkeypatch):
    """Required split: only KNOWN operational failures become
    ModelCallError. AssertionError / an unrelated RuntimeError / any
    other programming defect must propagate unchanged, exactly like
    app.models.listing_llm's own boundary."""

    class FakeClient:
        def chat(self, **kwargs):
            raise AssertionError("a genuine programming defect, not a transport failure")

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())
    candidate = CandidateConfig("c", "phi4-mini", "v1", 0.2, 512, 3)
    caller = runner.real_model_caller_factory(host=None, timeout_s=60.0)

    with pytest.raises(AssertionError):
        caller(candidate, "a prompt")


@pytest.mark.parametrize("exc_type", [AssertionError, TypeError])
def test_real_model_caller_propagates_various_programming_defects(monkeypatch, exc_type):
    class FakeClient:
        def chat(self, **kwargs):
            raise exc_type("not an operational failure")

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())
    candidate = CandidateConfig("c", "phi4-mini", "v1", 0.2, 512, 3)
    caller = runner.real_model_caller_factory(host=None, timeout_s=60.0)

    with pytest.raises(exc_type):
        caller(candidate, "a prompt")


def test_real_model_caller_sanitises_a_malformed_response_shape(monkeypatch):
    class FakeClient:
        def chat(self, **kwargs):
            return {"unexpected": "shape, no message key at all"}

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())
    candidate = CandidateConfig("c", "phi4-mini", "v1", 0.2, 512, 3)
    caller = runner.real_model_caller_factory(host=None, timeout_s=60.0)

    with pytest.raises(ModelCallError):
        caller(candidate, "a prompt")


def test_real_model_caller_rejects_a_non_text_content_field(monkeypatch):
    class FakeClient:
        def chat(self, **kwargs):
            return {"message": {"content": 12345}}  # not a string

    class FakeOllamaModule:
        def Client(self, *args, **kwargs):
            return FakeClient()

    monkeypatch.setattr(runner, "_default_ollama_module", lambda: FakeOllamaModule())
    candidate = CandidateConfig("c", "phi4-mini", "v1", 0.2, 512, 3)
    caller = runner.real_model_caller_factory(host=None, timeout_s=60.0)

    with pytest.raises(ModelCallError):
        caller(candidate, "a prompt")


# --- human review queue ------------------------------------------------


def test_human_review_queue_length_equals_cases_times_candidates():
    report, _ = _run_single(
        [make_case(1), make_case(2)],
        [make_candidate("a", max_attempts=1), make_candidate("b", max_attempts=1)],
        script=[valid_json_text()] * 4,
    )
    assert len(report["human_review_queue"]) == 4
    assert len(report["human_review_answer_key"]) == 4


def test_every_human_review_entry_is_complete():
    report, _ = _run_single([make_case(1)], [make_candidate()], script=[valid_json_text()])
    for entry in report["human_review_queue"]:
        assert human_review_entry_is_complete(entry)


def test_a_hand_built_incomplete_entry_is_detected():
    entry = {name: None for name in HUMAN_REVIEW_REQUIRED_FIELDS}
    del entry["notes"]
    assert human_review_entry_is_complete(entry) is False


def test_the_answer_key_reveals_the_true_case_and_candidate_behind_each_review_id():
    report, _ = _run_single([make_case(1)], [make_candidate("secret_candidate")], script=[valid_json_text()])
    review_id = report["human_review_queue"][0]["review_id"]
    assert report["human_review_answer_key"][review_id] == {"case_id": "case_001", "candidate_id": "secret_candidate"}
    # The queue entry itself never names the candidate or model.
    assert "secret_candidate" not in json.dumps(report["human_review_queue"][0])


def test_human_review_queue_uses_only_rep_zero():
    report, _ = _run_single(
        [make_case(1)],
        [make_candidate(max_attempts=1)],
        script=[valid_json_text("First"), valid_json_text("Second")],
        reps=2,
    )
    assert len(report["human_review_queue"]) == 1
    assert report["human_review_queue"][0]["generated_title"] == "First"


def test_build_human_review_queue_is_a_pure_function_of_its_arguments():
    cases = (FixtureCase("c1", "lamp", ("t",), ("f",), ("price",), "g"),)
    candidates = (CandidateConfig("k1", "phi4-mini", "v1", 0.2, 512, 3),)
    results = [
        {
            "case_id": "c1",
            "candidate_id": "k1",
            "rep": 0,
            "final_status": "generated",
            "title": "T",
            "description": "D",
        }
    ]
    queue1, key1 = build_human_review_queue(1, cases, candidates, results)
    queue2, key2 = build_human_review_queue(1, cases, candidates, results)
    assert queue1 == queue2
    assert key1 == key2


# --- real reviewer/researcher blinding separation ---------------------


def test_reviewer_packet_has_no_identity_or_technical_fields():
    report, _ = _run_single(
        [make_case(1, item_label="table lamp")],
        [make_candidate("secret_candidate_id", model_name="secret-model-name")],
        script=[valid_json_text("A Title", "A description long enough to pass the bound easily.")],
    )
    packet = build_reviewer_packet(report["artifact_id"], report["seed"], report["human_review_queue"])
    serialised = json.dumps(packet)

    assert "secret_candidate_id" not in serialised
    assert "secret-model-name" not in serialised
    for forbidden in REVIEWER_PACKET_FORBIDDEN_SUBSTRINGS:
        assert forbidden not in serialised, f"reviewer packet leaked a technical/identity field: {forbidden!r}"

    # Positive control: the packet DOES carry what a reviewer needs.
    assert "table lamp" in serialised
    assert "A Title" in serialised
    entry = packet["entries"][0]
    assert set(entry) == HUMAN_REVIEW_REQUIRED_FIELDS


def test_reviewer_packet_is_a_genuinely_separate_object_from_the_researcher_report():
    report, _ = _run_single([make_case(1)], [make_candidate()], script=[valid_json_text()])
    packet = build_reviewer_packet(report["artifact_id"], report["seed"], report["human_review_queue"])
    assert "results" not in packet
    assert "summary" not in packet
    assert "human_review_answer_key" not in packet
    assert "candidates" not in packet
    assert "bounds" not in packet


def test_the_researcher_artifact_retains_a_complete_one_to_one_answer_key():
    report, _ = _run_single(
        [make_case(1), make_case(2)],
        [make_candidate("a"), make_candidate("b")],
        script=[valid_json_text()] * 4,
    )
    queue = report["human_review_queue"]
    answer_key = report["human_review_answer_key"]
    review_ids = [entry["review_id"] for entry in queue]

    # Bijective: exactly one answer-key entry per queue entry, no
    # duplicates, no missing, no extras.
    assert sorted(answer_key) == sorted(review_ids)
    assert len(set(review_ids)) == len(review_ids)
    seen_pairs = {(v["case_id"], v["candidate_id"]) for v in answer_key.values()}
    expected_pairs = {(c, k) for c in ("case_001", "case_002") for k in ("a", "b")}
    assert seen_pairs == expected_pairs


def test_dry_run_writes_a_separate_reviewer_packet_next_to_the_main_artifact(tmp_path):
    # A distinctive candidate_id (and, since finding 1's correction, the
    # dry-run fake is fully candidate-neutral, so model_name is also
    # distinctive here) proves identity does not leak into the reviewer
    # packet, while the researcher artifact keeps it.
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1, item_label="table lamp")]))
    candidates_path = write_json(
        tmp_path / "candidates.json",
        candidate_file([make_candidate("very_secret_id", model_name="very-secret-model")]),
    )
    out = tmp_path / "report.json"

    rc = runner.main(
        ["dry-run", "--fixtures", str(fixtures_path), "--candidates", str(candidates_path), "--out", str(out)]
    )

    assert rc == 0
    reviewer_path = runner._reviewer_packet_path(out)
    assert reviewer_path != out
    assert reviewer_path.exists()

    main_report = json.loads(out.read_text(encoding="utf-8"))
    assert main_report["status"] == "complete"
    assert "very_secret_id" in json.dumps(main_report)  # researcher artifact keeps identity
    assert "very-secret-model" in json.dumps(main_report)

    reviewer_packet = json.loads(reviewer_path.read_text(encoding="utf-8"))
    reviewer_serialised = json.dumps(reviewer_packet)
    assert "very_secret_id" not in reviewer_serialised
    assert "very-secret-model" not in reviewer_serialised
    assert "table lamp" in reviewer_serialised
    assert "entries" in reviewer_packet
    assert "answer_key" not in reviewer_serialised

    # Two-artifact consistency: both files share the same opaque id.
    assert reviewer_packet["artifact_id"] == main_report["artifact_id"]
    assert reviewer_packet["status"] == "complete"


def test_dry_run_reviewer_packet_contains_none_of_the_configured_candidate_ids_or_model_names(tmp_path):
    """Real CLI-level regression for the corrected dry-run fake: the
    built-in stand-in caller must be completely candidate-neutral, never
    embedding candidate_id, model_name, prompt_version or temperature
    into its generated title/description, because that text flows
    unchanged into the human review queue and the reviewer packet. Uses
    TWO distinct candidates so a fake that merely omitted the FIRST
    candidate's identity by coincidence would still be caught."""
    candidates = [
        make_candidate("dryrun_candidate_alpha", model_name="dryrun-model-alpha"),
        make_candidate("dryrun_candidate_beta", model_name="dryrun-model-beta"),
    ]
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1, item_label="table lamp")]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file(candidates))
    out = tmp_path / "report.json"

    rc = runner.main(
        ["dry-run", "--fixtures", str(fixtures_path), "--candidates", str(candidates_path), "--out", str(out)]
    )

    assert rc == 0
    reviewer_serialised = runner._reviewer_packet_path(out).read_text(encoding="utf-8")
    main_serialised = out.read_text(encoding="utf-8")

    for candidate in candidates:
        assert candidate["candidate_id"] not in reviewer_serialised
        assert candidate["model_name"] not in reviewer_serialised
        # Positive control: the researcher artifact DOES retain both, so
        # the absence above is real blinding, not an accidentally empty file.
        assert candidate["candidate_id"] in main_serialised
        assert candidate["model_name"] in main_serialised


def test_the_incomplete_placeholder_reviewer_packet_is_written_before_the_first_model_call():
    order: list[str] = []

    def caller(candidate, prompt):
        order.append("model_call")
        return valid_json_text()

    def saver(packet):
        order.append(f"reviewer_packet:{packet['status']}:{len(packet['entries'])}")

    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))

    report = run_evaluation(
        fs,
        candidates,
        caller_fn=caller,
        models_available_fn=fake_available,
        clock_fn=fake_clock,
        save=None,
        save_reviewer_packet=saver,
    )

    assert report["status"] == "complete"
    assert order[0] == "reviewer_packet:incomplete:0"
    assert "model_call" in order
    assert order.index("reviewer_packet:incomplete:0") < order.index("model_call")
    assert order[-1].startswith("reviewer_packet:complete:")


def test_researcher_artifact_and_reviewer_packet_share_the_same_opaque_artifact_id():
    calls: list[dict] = []
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))

    report = run_evaluation(
        fs,
        candidates,
        caller_fn=ScriptedCaller([valid_json_text()]),
        models_available_fn=fake_available,
        clock_fn=fake_clock,
        save=None,
        save_reviewer_packet=calls.append,
    )

    assert isinstance(report["artifact_id"], str) and report["artifact_id"]
    assert calls[-1]["artifact_id"] == report["artifact_id"]
    # Every packet written for this run, including the initial
    # placeholder, carries the SAME id, never a per-write id.
    assert {packet["artifact_id"] for packet in calls} == {report["artifact_id"]}


def test_two_separate_runs_get_two_different_artifact_ids():
    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))

    report1 = run_evaluation(
        fs,
        candidates,
        caller_fn=ScriptedCaller([valid_json_text()]),
        models_available_fn=fake_available,
        clock_fn=fake_clock,
        save=None,
    )
    report2 = run_evaluation(
        fs,
        candidates,
        caller_fn=ScriptedCaller([valid_json_text()]),
        models_available_fn=fake_available,
        clock_fn=fake_clock,
        save=None,
    )

    assert report1["artifact_id"] != report2["artifact_id"]


def test_a_stale_complete_reviewer_packet_cannot_be_confused_with_a_new_runs_placeholder():
    """Simulates a real leftover file already on disk from an older,
    successful run: the very first thing a new run does is overwrite it
    with an honest incomplete/zero-entries placeholder carrying the NEW
    run's id, before any model is called."""
    disk = {
        "packet": {
            "schema_version": 1,
            "artifact_id": "stale-run-from-yesterday",
            "seed": 1,
            "status": "complete",
            "note": "old",
            "entries": [{"review_id": "REVIEW-001"}],
        }
    }

    def saver(packet):
        disk["packet"] = packet

    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))

    report = run_evaluation(
        fs,
        candidates,
        caller_fn=ScriptedCaller([valid_json_text()]),
        models_available_fn=fake_available,
        clock_fn=fake_clock,
        save=None,
        save_reviewer_packet=saver,
    )

    # By the time the run has finished, the on-disk packet is THIS run's
    # own complete packet, not the stale one: its id matches the
    # researcher report, never the leftover "stale-run-from-yesterday".
    assert disk["packet"]["artifact_id"] == report["artifact_id"]
    assert disk["packet"]["artifact_id"] != "stale-run-from-yesterday"
    assert disk["packet"]["status"] == "complete"


def test_if_the_initial_placeholder_write_fails_the_run_aborts_before_any_model_call():
    def failing_saver(packet):
        raise OSError("disk full")

    def caller(candidate, prompt):
        raise AssertionError("must never be called when the placeholder write fails")

    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))
    saved: list[dict] = []

    report = run_evaluation(
        fs,
        candidates,
        caller_fn=caller,
        models_available_fn=fake_available,
        clock_fn=fake_clock,
        save=saved.append,
        save_reviewer_packet=failing_saver,
    )

    assert report["status"] == "incomplete"
    assert "reviewer packet" in report["incomplete_reason"].lower()
    assert report["results"] == []
    assert saved[-1]["status"] == "incomplete"


def test_if_the_final_reviewer_packet_write_fails_the_researcher_artifact_stays_incomplete():
    def flaky_saver(packet):
        if packet["status"] == "incomplete":
            return  # the initial placeholder succeeds
        raise OSError("disk full writing the final packet")

    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))
    saved: list[dict] = []

    report = run_evaluation(
        fs,
        candidates,
        caller_fn=ScriptedCaller([valid_json_text()]),
        models_available_fn=fake_available,
        clock_fn=fake_clock,
        save=saved.append,
        save_reviewer_packet=flaky_saver,
    )

    assert report["status"] == "incomplete"
    assert "reviewer packet" in report["incomplete_reason"].lower()
    # The model call did happen (results exist in memory) but the
    # researcher artifact must never claim "complete" without its paired
    # reviewer packet having actually been written.
    assert len(report["results"]) == 1
    assert saved[-1]["status"] == "incomplete"


def test_a_non_oserror_writer_failure_is_not_swallowed_as_a_sanitised_incomplete_result():
    """Only OSError (the writer's realistic failure mode: disk full,
    permission denied, unwritable path) is treated as a sanitised
    incomplete-artifact outcome. A genuine programming defect inside an
    injected save_reviewer_packet must still propagate unchanged, the
    same known-vs-unexpected split the model-call boundary uses."""

    def buggy_saver(packet):
        raise AssertionError("a bug in the injected fake, not a disk failure")

    fs = parse_fixture_set(fixture_file([make_case(1)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))

    with pytest.raises(AssertionError):
        run_evaluation(
            fs,
            candidates,
            caller_fn=ScriptedCaller([valid_json_text()]),
            models_available_fn=fake_available,
            clock_fn=fake_clock,
            save=None,
            save_reviewer_packet=buggy_saver,
        )


def test_reviewer_packet_path_is_always_a_sibling_never_the_main_file():
    assert runner._reviewer_packet_path(Path("evaluation/results/report.json")) == Path(
        "evaluation/results/report.reviewer.json"
    )


def test_plan_output_labels_the_candidate_mapping_as_researcher_only_not_blinded(tmp_path, capsys):
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1)]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate("prod")]))

    rc = runner.main(["plan", "--fixtures", str(fixtures_path), "--candidates", str(candidates_path)])

    assert rc == 0
    out = capsys.readouterr().out
    # It's fine for `plan` to print the candidate mapping for the
    # researcher, but it must never describe THAT output as the blinded
    # reviewer view — it must be labelled researcher-only instead.
    assert "researcher-only" in out.lower()
    assert "blinded review order" not in out.lower()
    assert "candidate=prod" in out


# --- summary / aggregate metrics -------------------------------------------


def test_summary_counts_and_rates_for_a_mixed_outcome_set():
    report, _ = _run_single(
        [make_case(1), make_case(2)],
        [make_candidate(max_attempts=1)],
        script=[valid_json_text(), "not json"],
    )
    candidate_summary = report["summary"]["by_candidate"]["prod"]
    # rep0 and all_repetitions must agree exactly with reps=1 (rep 0 IS
    # every repetition), and both must be clearly separate, labelled
    # blocks rather than one silent "candidate-level" figure.
    for stats in (candidate_summary["rep0"], candidate_summary["all_repetitions"]):
        assert stats["unit_count"] == 2
        assert stats["generated_count"] == 1
        assert stats["unavailable_count"] == 1
        assert stats["json_valid_rate"] == 0.5
        assert stats["schema_valid_rate"] == 0.5
    assert candidate_summary["reps"] == 1


def test_stable_aggregate_metrics_across_two_identical_runs():
    def build_report():
        fake_clock.t = 0.0
        fs = parse_fixture_set(fixture_file([make_case(1), make_case(2)]))
        candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=2)]))
        caller = ScriptedCaller([valid_json_text(), valid_json_text()])
        return run_evaluation(
            fs, candidates, reps=1, caller_fn=caller, models_available_fn=fake_available, clock_fn=fake_clock
        )

    report_a = build_report()
    report_b = build_report()
    assert report_a["summary"] == report_b["summary"]


# --- no production setting mutation ----------------------------------------


def test_run_evaluation_never_mutates_get_settings_or_the_environment():
    before_settings = get_settings()
    before_env = dict(os.environ)

    _run_single([make_case(1)], [make_candidate()], script=[valid_json_text()])

    assert get_settings() is before_settings  # lru_cache identity, never cleared
    assert dict(os.environ) == before_env


# --- atomic writer (identical contract to compare_stt.py's own writer) -----


def test_a_successful_write_produces_valid_json_and_leaves_no_temporary(tmp_path):
    out = tmp_path / "nested" / "report.json"
    runner._writer(out)({"status": "complete", "results": []})
    assert json.loads(out.read_text(encoding="utf-8"))["status"] == "complete"
    assert list(tmp_path.rglob("*.tmp")) == []


def test_a_second_write_replaces_the_first_atomically(tmp_path):
    out = tmp_path / "report.json"
    save = runner._writer(out)
    save({"status": "incomplete", "results": []})
    save({"status": "complete", "results": [1, 2]})
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["status"] == "complete"
    assert saved["results"] == [1, 2]
    assert list(tmp_path.glob("*.tmp")) == []


def test_a_serialisation_failure_leaves_the_previous_artefact_untouched(tmp_path):
    out = tmp_path / "report.json"
    save = runner._writer(out)
    save({"status": "incomplete", "results": ["first"]})
    with pytest.raises(TypeError):
        save({"status": "complete", "results": {"a set"}})
    assert json.loads(out.read_text(encoding="utf-8")) == {"status": "incomplete", "results": ["first"]}
    assert list(tmp_path.glob("*.tmp")) == []


def test_a_failed_replace_preserves_the_destination_and_removes_the_temporary(tmp_path, monkeypatch):
    out = tmp_path / "report.json"
    save = runner._writer(out)
    save({"status": "incomplete", "results": ["first"]})

    def exploding_replace(src, dst):
        raise OSError("disk went away")

    monkeypatch.setattr(runner.os, "replace", exploding_replace)
    with pytest.raises(OSError):
        save({"status": "complete", "results": ["second"]})
    assert json.loads(out.read_text(encoding="utf-8"))["results"] == ["first"]
    assert list(tmp_path.glob("*.tmp")) == []


def test_a_failed_temporary_write_never_creates_a_partial_destination(tmp_path, monkeypatch):
    out = tmp_path / "report.json"

    def exploding_fsync(fd):
        raise OSError("write failed")

    monkeypatch.setattr(runner.os, "fsync", exploding_fsync)
    with pytest.raises(OSError):
        runner._writer(out)({"status": "complete"})
    assert not out.exists()
    assert list(tmp_path.glob("*.tmp")) == []


def test_the_temporary_file_is_a_sibling_of_the_destination(tmp_path, monkeypatch):
    out = tmp_path / "report.json"
    seen: list[Path] = []
    real_replace = runner.os.replace

    def watching_replace(src, dst):
        seen.append(Path(src))
        return real_replace(src, dst)

    monkeypatch.setattr(runner.os, "replace", watching_replace)
    runner._writer(out)({"status": "complete"})
    assert seen and seen[0].parent == out.parent


def test_the_run_writes_incrementally_via_the_injected_save_callback(tmp_path):
    out = tmp_path / "report.json"
    fs = parse_fixture_set(fixture_file([make_case(1), make_case(2)]))
    candidates = parse_candidate_set(candidate_file([make_candidate(max_attempts=1)]))
    caller = ScriptedCaller([valid_json_text(), valid_json_text()])

    saves: list[dict] = []

    def spy_save(report):
        saves.append(copy.deepcopy(report))
        runner._writer(out)(report)

    report = run_evaluation(
        fs, candidates, reps=1, caller_fn=caller, models_available_fn=fake_available, clock_fn=fake_clock, save=spy_save
    )
    assert report["status"] == "complete"
    assert len(saves) >= 3  # initial + preflight + at least one per-unit save
    assert saves[0]["status"] == "incomplete"  # the very first save, before any call


# --- status: complete only when every planned case finishes ---------------


def test_status_is_complete_only_when_every_case_produced_a_result():
    report, _ = _run_single(
        [make_case(1), make_case(2)],
        [make_candidate(max_attempts=1)],
        script=[valid_json_text(), valid_json_text()],
    )
    assert report["status"] == "complete"
    assert len(report["results"]) == 2


def test_status_is_incomplete_when_the_model_preflight_fails_and_no_results_exist():
    fs = parse_fixture_set(fixture_file([make_case(1), make_case(2)]))
    candidates = parse_candidate_set(candidate_file([make_candidate()]))
    report = run_evaluation(
        fs,
        candidates,
        reps=1,
        caller_fn=ScriptedCaller([]),
        models_available_fn=lambda required: ModelAvailability(available=frozenset(), resolved=()),
        clock_fn=fake_clock,
    )
    assert report["status"] == "incomplete"
    assert report["results"] == []


# --- prompt versioning / hashing recorded in every result ------------------


def test_every_result_row_records_prompt_version_hash_and_full_text():
    report, _ = _run_single([make_case(1)], [make_candidate(max_attempts=1)], script=[valid_json_text()])
    row = report["results"][0]
    assert row["prompt_version"] == PRODUCTION_PROMPT_VERSION
    assert row["prompt_sha256"] == hashlib.sha256(row["prompt_text"].encode("utf-8")).hexdigest()


def test_the_eval_prompt_candidate_records_a_different_prompt_text_and_hash_than_v1():
    report, _ = _run_single(
        [make_case(1)],
        [make_candidate("prod"), make_candidate("evalc", prompt_version=EVAL_PROMPT_VERSION)],
        script=[valid_json_text(), valid_json_text()],
    )
    prod_row = next(r for r in report["results"] if r["candidate_id"] == "prod")
    eval_row = next(r for r in report["results"] if r["candidate_id"] == "evalc")
    assert prod_row["prompt_text"] != eval_row["prompt_text"]
    assert prod_row["prompt_sha256"] != eval_row["prompt_sha256"]


# --- CLI safety: default invocation cannot infer ---------------------------


def test_validate_never_requires_a_model_and_reports_ok(tmp_path, capsys):
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1)]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate()]))

    rc = runner.main(["validate", "--fixtures", str(fixtures_path), "--candidates", str(candidates_path)])

    assert rc == 0
    out = capsys.readouterr().out
    assert "Fixtures OK" in out
    assert "Candidates OK" in out


def test_plan_never_requires_a_model_and_writes_no_artefact(tmp_path, capsys):
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1)]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate()]))

    rc = runner.main(["plan", "--fixtures", str(fixtures_path), "--candidates", str(candidates_path)])

    assert rc == 0
    assert set(tmp_path.glob("*.json")) == {fixtures_path, candidates_path}  # no new file
    out = capsys.readouterr().out
    assert "planned_calls_upper_bound" in out


def test_dry_run_writes_a_complete_artefact(tmp_path):
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1)]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate()]))
    out = tmp_path / "out.json"

    rc = runner.main(
        ["dry-run", "--fixtures", str(fixtures_path), "--candidates", str(candidates_path), "--out", str(out)]
    )

    assert rc == 0
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["status"] == "complete"
    assert len(saved["results"]) == 1


def test_run_without_the_execute_flag_refuses_and_never_writes_an_artefact(tmp_path, capsys):
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1)]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate()]))
    out = tmp_path / "out.json"

    rc = runner.main(["run", "--fixtures", str(fixtures_path), "--candidates", str(candidates_path), "--out", str(out)])

    assert rc == 2
    assert not out.exists()
    err = capsys.readouterr().err
    assert "--execute-real-models" in err


@pytest.mark.parametrize(
    "subcommand,needs_out",
    [("validate", False), ("plan", False), ("dry-run", True), ("run", True)],
)
def test_running_each_safe_subcommand_in_a_fresh_process_never_imports_ollama(tmp_path, subcommand, needs_out):
    """In-process sys.modules is NOT a reliable signal here: other test
    modules in the same pytest run legitimately `import ollama` for
    unrelated reasons (constructing ollama.ResponseError/RequestError
    instances in test_listing_llm.py), which would make an in-process
    check order-dependent and meaningless. A fresh subprocess has no such
    pollution, so it is the only reliable way to prove THIS invocation
    imported nothing. `run` here deliberately omits --execute-real-models:
    it must refuse, not import ollama.

    --out is always an ABSOLUTE path under tmp_path: the subprocess's cwd
    must stay the backend directory (so `evaluation.scripts...` resolves
    the same way pytest.ini's pythonpath=. makes it resolve), and a bare
    relative --out would otherwise write a stray file into the real
    backend directory.
    """
    import subprocess

    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1)]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate()]))
    argv = [subcommand, "--fixtures", str(fixtures_path), "--candidates", str(candidates_path)]
    if needs_out:
        argv += ["--out", str(tmp_path / "out.json")]

    script = (
        "import sys\n"
        "from evaluation.scripts.compare_listing_drafts import main\n"
        f"main({argv!r})\n"
        "assert 'ollama' not in sys.modules, 'ollama was imported'\n"
        "assert 'httpx' not in sys.modules, 'httpx was imported'\n"
        "print('OK')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=str(_BACKEND_DIR), capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "OK" in result.stdout
    assert not (_BACKEND_DIR / "out.json").exists()


@pytest.mark.parametrize("command", ["validate", "plan", "dry-run", "run"])
def test_candidates_argument_is_required_for_every_subcommand(command, tmp_path):
    fixtures_path = write_json(tmp_path / "fixtures.json", fixture_file([make_case(1)]))
    argv = [command, "--fixtures", str(fixtures_path)]
    if command in ("dry-run", "run"):
        argv += ["--out", str(tmp_path / "out.json")]
    with pytest.raises(SystemExit):
        runner.main(argv)


def test_main_reports_a_fixture_contract_error_without_a_traceback(tmp_path, capsys):
    bad_fixtures = write_json(tmp_path / "bad.json", fixture_file(cases=[]))
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate()]))

    rc = runner.main(["validate", "--fixtures", str(bad_fixtures), "--candidates", str(candidates_path)])

    assert rc == 2
    err = capsys.readouterr().err
    assert err.startswith("error:")


def test_default_fixtures_path_resolves_to_the_committed_corpus(tmp_path):
    candidates_path = write_json(tmp_path / "candidates.json", candidate_file([make_candidate()]))
    rc = runner.main(["validate", "--candidates", str(candidates_path)])
    assert rc == 0  # uses runner.DEFAULT_FIXTURES_PATH, the committed corpus


# --- import side effects -----------------------------------------------


def test_importing_the_module_never_imports_ollama_or_httpx():
    import subprocess

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, evaluation.scripts.compare_listing_drafts as m; "
            "assert 'ollama' not in sys.modules; assert 'httpx' not in sys.modules; print('OK')",
        ],
        cwd=str(_BACKEND_DIR),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout
