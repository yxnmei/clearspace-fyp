"""Build a Reorganise checklist directly or through one research model call.

Production uses the deterministic no-model path. Two structurally valid
2026-09-17 model runs failed human review, so the injected one-call path is
research-only and falls back immediately on any expected failure. Provenance
records whether output was generated, fell back, or was built directly.
"""

from __future__ import annotations

import time
from enum import Enum
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, ValidationError, model_validator

from app.core.reorganise_actions import (
    MAX_ACTIONS,
    MIN_ACTIONS,
    ReorganiseAction,
    build_deterministic_checklist,
    expected_action_range,
    parse_and_validate_actions,
)
from app.core.schemas import DetectedItem, NonEmptyStr

_MAX_ISSUE_DETAIL_LENGTH = 300
_TRUNCATION_SUFFIX = "...(truncated)"

_BoundedIssueDetail = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_MAX_ISSUE_DETAIL_LENGTH)
]

_RUN_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(NonEmptyStr)


def _validate_run_id(run_id: Any) -> str:
    try:
        return _RUN_ID_ADAPTER.validate_python(run_id)
    except ValidationError as exc:
        raise ValueError(f"run_id is not a valid non-empty string: {run_id!r} ({exc})") from exc


def _bounded(text: str, limit: int = _MAX_ISSUE_DETAIL_LENGTH) -> str:
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(_TRUNCATION_SUFFIX))
    return text[:keep] + _TRUNCATION_SUFFIX


class ActionPlanProvenance(str, Enum):
    LLM_GENERATED = "llm_generated"
    DETERMINISTIC_FALLBACK = "deterministic_fallback"
    DETERMINISTIC_DIRECT = "deterministic_direct"


ActionPlanIssueKind = Literal["call_failed", "invalid_json", "invalid_actions"]


class ActionPlanIssue(BaseModel):
    """A bounded reason the research attempt was not trusted."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: ActionPlanIssueKind
    detail: _BoundedIssueDetail


class ReorganiseActionsLLMResultLike(Protocol):
    """Structural result contract for the injected checklist generator."""

    raw_text: str
    parsed_json: dict | list | None
    is_valid_json: bool
    was_repaired: bool
    model_name: str
    prompt_version: str


class ReorganiseActionGenerator(Protocol):
    """Callable contract for one research checklist attempt."""

    def __call__(
        self,
        run_id: str,
        selected_items: list[DetectedItem],
        scene_label: str,
        user_context: str | None,
        model_name: str | None = None,
    ) -> ReorganiseActionsLLMResultLike: ...


class ReorganiseActionPlan(BaseModel):
    """A bounded checklist with provenance consistent with its attempts."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    run_id: NonEmptyStr
    actions: list[ReorganiseAction] = Field(min_length=MIN_ACTIONS, max_length=MAX_ACTIONS)
    provenance: ActionPlanProvenance
    attempts: int = Field(ge=0, le=1)
    model_name: NonEmptyStr | None
    prompt_version: NonEmptyStr | None
    # Genuine bool only for a trusted model checklist (did json_repair
    # have to fix the response); None whenever the actions are not the
    # model's.
    was_repaired: bool | None
    duration_ms: float = Field(ge=0)
    issues: list[ActionPlanIssue] = Field(max_length=1)

    @model_validator(mode="after")
    def _check_invariants(self) -> "ReorganiseActionPlan":
        priorities = [action.priority for action in self.actions]
        if priorities != list(range(1, len(self.actions) + 1)):
            raise ValueError(f"actions must be ordered with priorities exactly 1..{len(self.actions)}, got {priorities}")

        both_present = self.model_name is not None and self.prompt_version is not None
        both_none = self.model_name is None and self.prompt_version is None
        if not (both_present or both_none):
            raise ValueError("model_name and prompt_version must either both be present or both be None")

        if self.provenance == ActionPlanProvenance.DETERMINISTIC_DIRECT:
            if self.attempts != 0:
                raise ValueError("DETERMINISTIC_DIRECT requires zero attempts")
            if self.issues:
                raise ValueError("DETERMINISTIC_DIRECT must have zero issues")
            if not both_none:
                raise ValueError("DETERMINISTIC_DIRECT requires model_name and prompt_version to both be None")
            if self.was_repaired is not None:
                raise ValueError("DETERMINISTIC_DIRECT requires was_repaired to be None")
            return self

        if self.attempts != 1:
            raise ValueError(f"{self.provenance.value} requires exactly one attempt")

        if self.provenance == ActionPlanProvenance.LLM_GENERATED:
            if self.issues:
                raise ValueError("LLM_GENERATED must have zero issues")
            if not both_present:
                raise ValueError("LLM_GENERATED requires non-empty model_name and prompt_version")
            if not isinstance(self.was_repaired, bool):
                raise ValueError("LLM_GENERATED requires a genuine boolean was_repaired")
        else:  # DETERMINISTIC_FALLBACK
            if len(self.issues) != 1:
                raise ValueError("DETERMINISTIC_FALLBACK requires exactly one issue")
            if self.was_repaired is not None:
                raise ValueError("DETERMINISTIC_FALLBACK requires was_repaired to be None")
            if both_none and self.issues[0].kind != "call_failed":
                raise ValueError("DETERMINISTIC_FALLBACK metadata may be None only when the call itself failed")
        return self


def _validate_inputs(selected_items: Any, scene_label: Any, user_context: Any) -> None:
    if not isinstance(selected_items, list) or not selected_items:
        raise ValueError("selected_items must be a non-empty list")
    for index, item in enumerate(selected_items):
        if not isinstance(item, DetectedItem):
            raise ValueError(f"selected_items[{index}] must be a DetectedItem, got {type(item).__name__}")
    ids = [item.item_id for item in selected_items]
    if len(ids) != len(set(ids)):
        raise ValueError("selected_items contains a duplicate item_id")
    if not isinstance(scene_label, str) or not scene_label.strip():
        raise ValueError("scene_label must be a non-blank string")
    if user_context is not None and not isinstance(user_context, str):
        raise ValueError("user_context must be None or a string")


def plan_reorganise_actions(
    run_id: str,
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None,
    generator: ReorganiseActionGenerator | None,
) -> ReorganiseActionPlan:
    """Validate inputs, then build directly or make one research attempt."""
    run_id = _validate_run_id(run_id)
    _validate_inputs(selected_items, scene_label, user_context)

    t0 = time.perf_counter()

    def _elapsed_ms() -> float:
        return (time.perf_counter() - t0) * 1000

    if generator is None:
        actions = build_deterministic_checklist(selected_items, scene_label)
        return ReorganiseActionPlan(
            run_id=run_id,
            actions=actions,
            provenance=ActionPlanProvenance.DETERMINISTIC_DIRECT,
            attempts=0,
            model_name=None,
            prompt_version=None,
            was_repaired=None,
            duration_ms=_elapsed_ms(),
            issues=[],
        )

    issue: ActionPlanIssue
    result: ReorganiseActionsLLMResultLike | None = None
    try:
        result = generator(
            run_id=run_id,
            selected_items=selected_items,
            scene_label=scene_label,
            user_context=user_context,
        )
    except Exception as exc:  # the ONE place a model failure is caught
        issue = ActionPlanIssue(kind="call_failed", detail=_bounded(f"checklist model call failed: {type(exc).__name__}"))
    else:
        if not result.is_valid_json:
            issue = ActionPlanIssue(kind="invalid_json", detail="checklist model did not return syntactically valid JSON")
        else:
            # The action floor depends on selection size; rejection never retries.
            min_actions, _ = expected_action_range(len(selected_items))
            conversion = parse_and_validate_actions(result.parsed_json, min_actions=min_actions)
            if conversion.is_valid:
                return ReorganiseActionPlan(
                    run_id=run_id,
                    actions=conversion.actions,
                    provenance=ActionPlanProvenance.LLM_GENERATED,
                    attempts=1,
                    model_name=result.model_name,
                    prompt_version=result.prompt_version,
                    was_repaired=bool(result.was_repaired),
                    duration_ms=_elapsed_ms(),
                    issues=[],
                )
            issue = ActionPlanIssue(kind="invalid_actions", detail=_bounded(conversion.errors[0].detail))

    actions = build_deterministic_checklist(selected_items, scene_label)
    return ReorganiseActionPlan(
        run_id=run_id,
        actions=actions,
        provenance=ActionPlanProvenance.DETERMINISTIC_FALLBACK,
        attempts=1,
        model_name=result.model_name if result is not None else None,
        prompt_version=result.prompt_version if result is not None else None,
        was_repaired=None,
        duration_ms=_elapsed_ms(),
        issues=[issue],
    )
