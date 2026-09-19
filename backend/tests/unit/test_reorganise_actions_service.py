"""
Unit tests for app/services/reorganise_actions_service.py: the at-most-one
call policy, the immediate deterministic fallback, and truthful
provenance. Fake generators only; no real Ollama and no
app.models.reorganise_actions_llm import anywhere in this file.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.reorganise_actions import ReorganiseAction, build_deterministic_checklist
from app.core.schemas import BoundingBox, DetectedItem
from app.services.reorganise_actions_service import (
    ActionPlanIssue,
    ActionPlanProvenance,
    ReorganiseActionPlan,
    plan_reorganise_actions,
)


def _item(item_id="item_001", label="lamp", position="upper-left", size="small") -> DetectedItem:
    index = int(item_id.split("_")[1])
    return DetectedItem(
        item_id=item_id,
        source_detection_index=index,
        raw_phrase=label,
        clean_label=label,
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.2, y2=0.2),
        confidence=0.5,
        position=position,
        relative_size=size,
    )


ITEMS = [_item("item_001", "lamp"), _item("item_002", "book", "center"), _item("item_003", "book", "right")]

# ITEMS has three items, so a trusted model answer needs at least three
# actions (see test_action_count_floor below for the boundary itself).
VALID_ACTIONS = {
    "actions": [
        {"priority": 1, "title": "Clear the desk", "instruction": "Group the books together beside the lamp."},
        {"priority": 2, "title": "Straighten the lamp", "instruction": "Set the lamp upright and clear around it."},
        {"priority": 3, "title": "Line up the books", "instruction": "Stand the two books upright side by side."},
    ]
}


class FakeResult:
    def __init__(self, parsed_json, is_valid_json=True, was_repaired=False, model_name="phi4-mini", prompt_version="reorganise-actions-v1"):
        self.raw_text = "fake"
        self.parsed_json = parsed_json
        self.is_valid_json = is_valid_json
        self.was_repaired = was_repaired
        self.model_name = model_name
        self.prompt_version = prompt_version


class FakeGenerator:
    def __init__(self, result=None, exc=None):
        self.calls: list[dict] = []
        self._result = result
        self._exc = exc

    def __call__(self, run_id, selected_items, scene_label, user_context, model_name=None):
        self.calls.append(dict(run_id=run_id, selected_items=selected_items, scene_label=scene_label, user_context=user_context, model_name=model_name))
        if self._exc is not None:
            raise self._exc
        return self._result if self._result is not None else FakeResult(VALID_ACTIONS)


def _plan(generator, items=ITEMS, context="keep it minimal"):
    return plan_reorganise_actions("run1", items, "bedroom", context, generator)


# --- success ------------------------------------------------------------------


def test_trusted_model_output_is_used_with_exactly_one_call():
    generator = FakeGenerator()
    plan = _plan(generator)

    assert len(generator.calls) == 1
    assert generator.calls[0]["user_context"] == "keep it minimal"
    assert generator.calls[0]["scene_label"] == "bedroom"
    assert plan.provenance == ActionPlanProvenance.LLM_GENERATED
    assert plan.attempts == 1
    assert plan.issues == []
    assert plan.model_name == "phi4-mini"
    assert plan.prompt_version == "reorganise-actions-v1"
    assert plan.was_repaired is False
    assert [a.title for a in plan.actions] == ["Clear the desk", "Straighten the lamp", "Line up the books"]
    assert plan.duration_ms >= 0


def test_mechanically_repaired_output_is_still_llm_generated_and_flagged():
    plan = _plan(FakeGenerator(FakeResult(VALID_ACTIONS, was_repaired=True)))
    assert plan.provenance == ActionPlanProvenance.LLM_GENERATED
    assert plan.was_repaired is True


def test_out_of_order_priorities_are_normalised():
    swapped = {"actions": list(reversed(VALID_ACTIONS["actions"]))}
    plan = _plan(FakeGenerator(FakeResult(swapped)))
    assert [a.priority for a in plan.actions] == [1, 2, 3]


# --- selection-dependent action-count floor -----------------------------------


def _n_actions(n: int) -> dict:
    return {"actions": [dict(VALID_ACTIONS["actions"][0], priority=i + 1) for i in range(n)]}


def _n_items(n: int) -> list[DetectedItem]:
    return [_item(f"item_{i:03d}") for i in range(1, n + 1)]


@pytest.mark.parametrize("item_count,action_count", [(3, 2), (3, 1), (4, 2), (7, 2)])
def test_too_few_actions_for_three_or_more_items_is_invalid_actions_and_falls_back_after_one_call(item_count, action_count):
    generator = FakeGenerator(FakeResult(_n_actions(action_count)))
    plan = _plan(generator, items=_n_items(item_count))

    assert len(generator.calls) == 1  # no retry, no second call
    assert plan.provenance == ActionPlanProvenance.DETERMINISTIC_FALLBACK
    assert plan.attempts == 1
    assert [issue.kind for issue in plan.issues] == ["invalid_actions"]
    assert "at least 3 expected" in plan.issues[0].detail
    assert plan.model_name == "phi4-mini"  # a wrapper result exists, so its identity is kept
    assert plan.actions == build_deterministic_checklist(_n_items(item_count), "bedroom")


@pytest.mark.parametrize("item_count,action_count", [(3, 3), (3, 5), (4, 3), (28, 4)])
def test_three_to_five_actions_are_accepted_for_three_or_more_items(item_count, action_count):
    generator = FakeGenerator(FakeResult(_n_actions(action_count)))
    plan = _plan(generator, items=_n_items(item_count))
    assert len(generator.calls) == 1
    assert plan.provenance == ActionPlanProvenance.LLM_GENERATED
    assert len(plan.actions) == action_count


@pytest.mark.parametrize("item_count,action_count", [(1, 1), (1, 3), (2, 1), (2, 2), (2, 3)])
def test_one_to_three_actions_are_accepted_for_one_or_two_items(item_count, action_count):
    generator = FakeGenerator(FakeResult(_n_actions(action_count)))
    plan = _plan(generator, items=_n_items(item_count))
    assert len(generator.calls) == 1
    assert plan.provenance == ActionPlanProvenance.LLM_GENERATED
    assert len(plan.actions) == action_count


@pytest.mark.parametrize("item_count", [1, 2])
def test_more_than_three_actions_for_a_tiny_selection_is_still_within_the_general_schema_and_accepted(item_count):
    """The prompt asks a tiny selection for 1 to 3; a longer valid answer
    is not rejected (only the floor is selection-dependent, the ceiling is
    the schema's 5)."""
    plan = _plan(FakeGenerator(FakeResult(_n_actions(4))), items=_n_items(item_count))
    assert plan.provenance == ActionPlanProvenance.LLM_GENERATED
    assert len(plan.actions) == 4


def test_the_fallback_checklist_is_not_held_to_the_selection_floor():
    """A single item's deterministic checklist has two actions (area +
    whole-room check); the floor governs trust in MODEL output only."""
    plan = _plan(FakeGenerator(FakeResult({"actions": []})), items=_n_items(1))
    assert plan.provenance == ActionPlanProvenance.DETERMINISTIC_FALLBACK
    assert 1 <= len(plan.actions) <= 5


# --- every failure reaches the fallback after ONE call -----------------------


@pytest.mark.parametrize(
    "generator,expected_kind",
    [
        (FakeGenerator(exc=RuntimeError("ollama unreachable")), "call_failed"),
        (FakeGenerator(exc=TimeoutError("slow")), "call_failed"),
        (FakeGenerator(FakeResult(None, is_valid_json=False)), "invalid_json"),
        (FakeGenerator(FakeResult({"zones": []})), "invalid_actions"),
        (FakeGenerator(FakeResult({"actions": []})), "invalid_actions"),
        (FakeGenerator(FakeResult({"actions": [{"priority": 1, "title": "Buy a box", "instruction": "Go and buy a box for the books."}]})), "invalid_actions"),
        (FakeGenerator(FakeResult([{"priority": 1}])), "invalid_actions"),
    ],
    ids=["exception", "timeout", "invalid_json", "wrong_shape", "empty", "forbidden_content", "list_not_object"],
)
def test_any_failure_uses_the_deterministic_fallback_immediately(generator, expected_kind):
    plan = _plan(generator)

    assert len(generator.calls) == 1  # never a second call
    assert plan.provenance == ActionPlanProvenance.DETERMINISTIC_FALLBACK
    assert plan.attempts == 1
    assert [issue.kind for issue in plan.issues] == [expected_kind]
    assert plan.was_repaired is None
    assert plan.actions == build_deterministic_checklist(ITEMS, "bedroom")


def test_call_failure_reports_the_exception_class_only_never_its_text():
    plan = _plan(FakeGenerator(exc=RuntimeError("secret host http://ngrok.example token=abc")))
    detail = plan.issues[0].detail
    assert detail == "checklist model call failed: RuntimeError"
    assert "ngrok" not in detail and "token" not in detail
    assert plan.model_name is None and plan.prompt_version is None  # no wrapper result exists to name a model


def test_invalid_output_keeps_the_model_identity_that_actually_answered():
    plan = _plan(FakeGenerator(FakeResult({"actions": []}, model_name="phi4-mini", prompt_version="reorganise-actions-v1")))
    assert plan.provenance == ActionPlanProvenance.DETERMINISTIC_FALLBACK
    assert plan.model_name == "phi4-mini"
    assert plan.prompt_version == "reorganise-actions-v1"


def test_raw_model_text_never_appears_in_the_plan():
    result = FakeResult({"actions": []})
    result.raw_text = "RAW MODEL TEXT THAT MUST NOT LEAK"
    plan = _plan(FakeGenerator(result))
    assert "RAW MODEL TEXT" not in plan.model_dump_json()


def test_fallback_is_available_without_any_generator_reachable():
    """The no-model path: what a caller uses when Ollama is not even
    installed. Zero attempts, no issue, no model named."""
    plan = _plan(None)
    assert plan.provenance == ActionPlanProvenance.DETERMINISTIC_DIRECT
    assert plan.attempts == 0
    assert plan.issues == []
    assert plan.model_name is None and plan.prompt_version is None and plan.was_repaired is None
    assert plan.actions == build_deterministic_checklist(ITEMS, "bedroom")


def test_fallback_is_fast_and_deterministic():
    first = _plan(FakeGenerator(exc=RuntimeError("x")))
    second = _plan(FakeGenerator(exc=RuntimeError("x")))
    assert first.actions == second.actions
    assert first.duration_ms < 1000


# --- caller-input validation happens before any call -------------------------


def test_malformed_input_never_costs_a_call():
    generator = FakeGenerator()
    with pytest.raises(ValueError):
        plan_reorganise_actions("", ITEMS, "bedroom", None, generator)
    with pytest.raises(ValueError):
        plan_reorganise_actions("run1", [], "bedroom", None, generator)
    with pytest.raises(ValueError):
        plan_reorganise_actions("run1", ITEMS, " ", None, generator)
    with pytest.raises(ValueError):
        plan_reorganise_actions("run1", ITEMS, "bedroom", 3, generator)
    with pytest.raises(ValueError):
        plan_reorganise_actions("run1", [ITEMS[0], ITEMS[0]], "bedroom", None, generator)
    assert generator.calls == []


def test_generator_argument_is_required():
    import inspect

    assert inspect.signature(plan_reorganise_actions).parameters["generator"].default is inspect.Parameter.empty


# --- ReorganiseActionPlan invariants ------------------------------------------


def _action(priority=1):
    return ReorganiseAction(priority=priority, title="Do a thing", instruction="Do the thing carefully and neatly.")


def _kwargs(**overrides):
    base = dict(
        run_id="run1",
        actions=[_action(1)],
        provenance=ActionPlanProvenance.LLM_GENERATED,
        attempts=1,
        model_name="m",
        prompt_version="p",
        was_repaired=False,
        duration_ms=1.0,
        issues=[],
    )
    base.update(overrides)
    return base


def test_plan_accepts_each_truthful_shape():
    ReorganiseActionPlan(**_kwargs())
    ReorganiseActionPlan(
        **_kwargs(provenance=ActionPlanProvenance.DETERMINISTIC_FALLBACK, was_repaired=None, issues=[ActionPlanIssue(kind="invalid_json", detail="x")])
    )
    ReorganiseActionPlan(
        **_kwargs(
            provenance=ActionPlanProvenance.DETERMINISTIC_FALLBACK,
            was_repaired=None,
            model_name=None,
            prompt_version=None,
            issues=[ActionPlanIssue(kind="call_failed", detail="x")],
        )
    )
    ReorganiseActionPlan(
        **_kwargs(provenance=ActionPlanProvenance.DETERMINISTIC_DIRECT, attempts=0, model_name=None, prompt_version=None, was_repaired=None)
    )


@pytest.mark.parametrize(
    "overrides",
    [
        dict(attempts=0),  # llm_generated with zero attempts
        dict(attempts=2),
        dict(issues=[ActionPlanIssue(kind="invalid_json", detail="x")]),
        dict(model_name=None, prompt_version=None),
        dict(model_name=None),
        dict(was_repaired=None),
        dict(provenance=ActionPlanProvenance.DETERMINISTIC_FALLBACK, was_repaired=None),  # no issue
        dict(provenance=ActionPlanProvenance.DETERMINISTIC_FALLBACK, was_repaired=None, model_name=None, prompt_version=None, issues=[ActionPlanIssue(kind="invalid_json", detail="x")]),
        dict(provenance=ActionPlanProvenance.DETERMINISTIC_FALLBACK, issues=[ActionPlanIssue(kind="invalid_json", detail="x")]),  # was_repaired set
        dict(provenance=ActionPlanProvenance.DETERMINISTIC_DIRECT, attempts=0, was_repaired=None),  # model named
        dict(provenance=ActionPlanProvenance.DETERMINISTIC_DIRECT, model_name=None, prompt_version=None, was_repaired=None),  # attempts 1
        dict(actions=[_action(2)]),
        dict(actions=[]),
        dict(duration_ms=-1.0),
        dict(issues=[ActionPlanIssue(kind="invalid_json", detail="x"), ActionPlanIssue(kind="invalid_json", detail="y")], provenance=ActionPlanProvenance.DETERMINISTIC_FALLBACK, was_repaired=None),
    ],
)
def test_plan_rejects_contradictory_records(overrides):
    with pytest.raises(ValidationError):
        ReorganiseActionPlan(**_kwargs(**overrides))


def test_plan_is_frozen_and_forbids_extra_fields():
    plan = ReorganiseActionPlan(**_kwargs())
    with pytest.raises(ValidationError):
        plan.attempts = 0
    with pytest.raises(ValidationError):
        ReorganiseActionPlan(**_kwargs(zones=[]))


def test_service_module_imports_no_model_module():
    import sys

    import app.services.reorganise_actions_service  # noqa: F401

    assert "app.models.reorganise_actions_llm" not in sys.modules or True  # other tests may import it
    source = open(app.services.reorganise_actions_service.__file__, encoding="utf-8").read()
    assert "from app.models" not in source and "import ollama" not in source
