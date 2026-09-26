"""Research-only Reorganise zone planning orchestration.

Production uses deterministic tidy plans elsewhere. The retained planner
makes at most two bounded attempts before a deterministic fallback; the
2026-08-20 screen found no candidate with a valid crowded-room plan.
Planner injection keeps this boundary independently testable, and timing is
returned in memory without log side effects.
"""

from __future__ import annotations

import time
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, Field, StringConstraints, TypeAdapter, ValidationError, computed_field, model_validator

from app.core.reorganise_schemas import PlanProvenance, ReorganisePlan
from app.core.reorganise_semantic_conversion import (
    PlanConversionError,
    build_deterministic_fallback_plan,
    parse_and_validate_plan,
)
from app.core.schemas import DetectedItem, NonEmptyStr, StageTiming

_MAX_ISSUE_DETAIL_LENGTH = 500  # matches semantic conversion's bounded-detail convention
_TRUNCATION_SUFFIX = "…(truncated)"

# Bounded, non-empty detail — schema-enforced (not just by _bounded()'s
# own truncation at construction sites), matching
# reorganise_semantic_conversion._BoundedDetail.
_BoundedIssueDetail = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_MAX_ISSUE_DETAIL_LENGTH)
]

_RUN_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(NonEmptyStr)


def _validate_run_id(run_id: Any) -> str:
    """Validate run_id through the shared NonEmptyStr contract."""
    try:
        return _RUN_ID_ADAPTER.validate_python(run_id)
    except ValidationError as exc:
        raise ValueError(f"run_id is not a valid non-empty string: {run_id!r} ({exc})") from exc


def _bounded(text: str, limit: int = _MAX_ISSUE_DETAIL_LENGTH) -> str:
    """Bound text to `limit`, including the truncation suffix."""
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(_TRUNCATION_SUFFIX))
    return text[:keep] + _TRUNCATION_SUFFIX


class ReorganiseLLMResultLike(Protocol):
    """Structural result contract for an injected research planner."""

    raw_text: str
    parsed_json: dict | list | None
    is_valid_json: bool
    was_repaired: bool
    model_name: str
    prompt_version: str


class ReorganisePlanner(Protocol):
    """Callable contract for one research planning attempt."""

    def __call__(
        self,
        run_id: str,
        selected_items: list[DetectedItem],
        scene_label: str,
        user_context: str | None,
        validation_feedback: list[str] | None = None,
        model_name: str | None = None,
    ) -> ReorganiseLLMResultLike: ...


PlanningIssueAttempt = Literal["initial", "recovery"]
PlanningIssueKind = Literal["call_failed", "invalid_json", "semantic_invalid"]


class PlanningIssue(BaseModel):
    """A bounded reason one planning attempt was not trusted."""

    attempt: PlanningIssueAttempt
    kind: PlanningIssueKind
    detail: _BoundedIssueDetail
    conversion_errors: list[PlanConversionError] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_consistency(self) -> "PlanningIssue":
        if self.kind == "semantic_invalid" and not self.conversion_errors:
            raise ValueError("semantic_invalid issues must carry at least one conversion error")
        if self.kind != "semantic_invalid" and self.conversion_errors:
            raise ValueError(f"{self.kind} issues must not carry conversion_errors")
        return self


class ReorganisePlanningResult(BaseModel):
    """A trusted plan with provenance, timing, and attempt issues.

    Validators keep attempt counts, issues, and model metadata consistent
    with direct, generated, recovered, or fallback provenance.
    """

    run_id: NonEmptyStr
    plan: ReorganisePlan
    provenance: PlanProvenance
    issues: list[PlanningIssue]
    # ge=0, not ge=1: DETERMINISTIC_DIRECT genuinely makes zero attempts.
    attempts: int = Field(ge=0, le=2)
    model_name: NonEmptyStr | None
    prompt_version: NonEmptyStr | None
    stage_timings: list[StageTiming]

    @model_validator(mode="after")
    def _check_invariants(self) -> "ReorganisePlanningResult":
        if len(self.stage_timings) != 1 or self.stage_timings[0].stage != "reorganise_plan":
            raise ValueError('stage_timings must contain exactly one timing with stage == "reorganise_plan"')

        metadata_both_present = self.model_name is not None and self.prompt_version is not None
        metadata_both_none = self.model_name is None and self.prompt_version is None
        if not (metadata_both_present or metadata_both_none):
            raise ValueError("model_name and prompt_version must either both be present or both be None")

        initial_issues = [i for i in self.issues if i.attempt == "initial"]
        recovery_issues = [i for i in self.issues if i.attempt == "recovery"]

        if self.provenance == PlanProvenance.DETERMINISTIC_DIRECT:
            # Checked FIRST and returned early: no planner ran, so every
            # LLM-shaped field must be empty. Anything else here would be
            # a fabricated record of a call that never happened.
            if self.attempts != 0:
                raise ValueError("DETERMINISTIC_DIRECT requires zero attempts")
            if self.issues:
                raise ValueError("DETERMINISTIC_DIRECT must have zero issues — no attempt was made to fail")
            if not metadata_both_none:
                raise ValueError(
                    "DETERMINISTIC_DIRECT requires model_name and prompt_version to both be None — "
                    "no model was called"
                )
            return self

        if self.provenance in (PlanProvenance.RAW_VALID, PlanProvenance.MECHANICALLY_REPAIRED):
            if self.attempts != 1:
                raise ValueError(f"{self.provenance.value} requires exactly one attempt")
            if self.issues:
                raise ValueError(f"{self.provenance.value} must have zero issues")
            if not metadata_both_present:
                raise ValueError(f"{self.provenance.value} requires non-empty model_name and prompt_version")

        elif self.provenance == PlanProvenance.RECOVERY_USED:
            if self.attempts != 2:
                raise ValueError("RECOVERY_USED requires exactly two attempts")
            if len(self.issues) != 1:
                raise ValueError("RECOVERY_USED requires exactly one issue")
            if len(initial_issues) != 1:
                raise ValueError("RECOVERY_USED's one issue must belong to the initial attempt")
            if recovery_issues:
                raise ValueError("RECOVERY_USED must not carry a recovery-attempt issue")
            if not metadata_both_present:
                raise ValueError("RECOVERY_USED requires non-empty model_name and prompt_version")

        else:  # DETERMINISTIC_FALLBACK
            if self.attempts != 2:
                raise ValueError("DETERMINISTIC_FALLBACK requires exactly two attempts")
            if len(self.issues) != 2:
                raise ValueError("DETERMINISTIC_FALLBACK requires exactly two issues")
            if not (self.issues[0].attempt == "initial" and self.issues[1].attempt == "recovery"):
                raise ValueError("DETERMINISTIC_FALLBACK issues must be ordered [initial, recovery]")
            if len(initial_issues) != 1 or len(recovery_issues) != 1:
                raise ValueError("DETERMINISTIC_FALLBACK requires exactly one issue per attempt")

            both_call_failed = all(issue.kind == "call_failed" for issue in self.issues)
            if metadata_both_none and not both_call_failed:
                raise ValueError(
                    "DETERMINISTIC_FALLBACK metadata may be None only when both attempts were call_failed"
                )

        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_strictly_valid(self) -> bool:
        return self.provenance == PlanProvenance.RAW_VALID and not self.issues


def _validate_planning_inputs(
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None,
) -> None:
    """Reject malformed caller input before any planning attempt."""
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


def _build_validation_feedback(issue: PlanningIssue) -> list[str]:
    if issue.kind == "call_failed":
        return ["The previous attempt failed to produce a response. Generate a complete, valid plan."]
    if issue.kind == "invalid_json":
        return ["The previous response was not a syntactically valid JSON object matching the required shape."]
    return [_bounded(err.detail) for err in issue.conversion_errors]  # semantic_invalid


def plan_reorganisation_direct(
    run_id: str,
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None,
) -> ReorganisePlanningResult:
    """Build a deterministic plan with zero attempts and truthful provenance.

    This public entry point applies the same input validation as the research
    path and never reports fallback failures for calls that did not occur.
    """
    run_id = _validate_run_id(run_id)
    _validate_planning_inputs(selected_items, scene_label, user_context)

    t0 = time.perf_counter()
    plan = build_deterministic_fallback_plan(selected_items, scene_label, user_context)

    return ReorganisePlanningResult(
        run_id=run_id,
        plan=plan,
        provenance=PlanProvenance.DETERMINISTIC_DIRECT,
        issues=[],
        attempts=0,
        model_name=None,
        prompt_version=None,
        # Genuinely measured, not a fabricated zero — this path is fast,
        # but the timing reported is the real elapsed build time.
        stage_timings=[StageTiming(stage="reorganise_plan", duration_ms=(time.perf_counter() - t0) * 1000)],
    )


def plan_reorganisation(
    run_id: str,
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None,
    llm_planner: ReorganisePlanner,
) -> ReorganisePlanningResult:
    """Make up to two research attempts, then return a deterministic fallback.

    Caller input is validated first. Only planner-call failures are converted
    into issues; unexpected conversion or construction defects propagate.
    """
    run_id = _validate_run_id(run_id)
    _validate_planning_inputs(selected_items, scene_label, user_context)
    selected_item_ids = [item.item_id for item in selected_items]

    t0 = time.perf_counter()

    def _stage_timings() -> list[StageTiming]:
        return [StageTiming(stage="reorganise_plan", duration_ms=(time.perf_counter() - t0) * 1000)]

    issues: list[PlanningIssue] = []

    # --- initial attempt ---------------------------------------------
    initial_result: ReorganiseLLMResultLike | None = None
    try:
        initial_result = llm_planner(
            run_id=run_id,
            selected_items=selected_items,
            scene_label=scene_label,
            user_context=user_context,
        )
    except Exception as exc:
        issues.append(
            PlanningIssue(
                attempt="initial",
                kind="call_failed",
                detail=_bounded(f"planner call raised {type(exc).__name__}: {exc}"),
            )
        )
    else:
        if not initial_result.is_valid_json:
            issues.append(
                PlanningIssue(
                    attempt="initial",
                    kind="invalid_json",
                    detail=_bounded("planner did not return syntactically valid JSON"),
                )
            )
        else:
            conversion = parse_and_validate_plan(initial_result.parsed_json, selected_item_ids)
            if conversion.is_valid:
                provenance = (
                    PlanProvenance.MECHANICALLY_REPAIRED
                    if initial_result.was_repaired
                    else PlanProvenance.RAW_VALID
                )
                return ReorganisePlanningResult(
                    run_id=run_id,
                    plan=conversion.plan,
                    provenance=provenance,
                    issues=[],
                    attempts=1,
                    model_name=initial_result.model_name,
                    prompt_version=initial_result.prompt_version,
                    stage_timings=_stage_timings(),
                )
            issues.append(
                PlanningIssue(
                    attempt="initial",
                    kind="semantic_invalid",
                    detail=_bounded("initial plan failed semantic validation"),
                    conversion_errors=conversion.errors,
                )
            )

    # --- one bounded recovery attempt ---------------------------------
    feedback = _build_validation_feedback(issues[-1])

    recovery_result: ReorganiseLLMResultLike | None = None
    try:
        recovery_result = llm_planner(
            run_id=run_id,
            selected_items=selected_items,
            scene_label=scene_label,
            user_context=user_context,
            validation_feedback=feedback,
        )
    except Exception as exc:
        issues.append(
            PlanningIssue(
                attempt="recovery",
                kind="call_failed",
                detail=_bounded(f"recovery planner call raised {type(exc).__name__}: {exc}"),
            )
        )
    else:
        if not recovery_result.is_valid_json:
            issues.append(
                PlanningIssue(
                    attempt="recovery",
                    kind="invalid_json",
                    detail=_bounded("recovery planner did not return syntactically valid JSON"),
                )
            )
        else:
            conversion = parse_and_validate_plan(recovery_result.parsed_json, selected_item_ids)
            if conversion.is_valid:
                # Recovery provenance records that a second attempt was needed;
                # the initial issue remains visible.
                return ReorganisePlanningResult(
                    run_id=run_id,
                    plan=conversion.plan,
                    provenance=PlanProvenance.RECOVERY_USED,
                    issues=issues,
                    attempts=2,
                    model_name=recovery_result.model_name,
                    prompt_version=recovery_result.prompt_version,
                    stage_timings=_stage_timings(),
                )
            issues.append(
                PlanningIssue(
                    attempt="recovery",
                    kind="semantic_invalid",
                    detail=_bounded("recovery plan failed semantic validation"),
                    conversion_errors=conversion.errors,
                )
            )

    # --- deterministic fallback — never a third planner call ----------
    fallback_plan = build_deterministic_fallback_plan(selected_items, scene_label, user_context)
    most_recent_result = recovery_result or initial_result  # "most recent wrapper result that exists"
    return ReorganisePlanningResult(
        run_id=run_id,
        plan=fallback_plan,
        provenance=PlanProvenance.DETERMINISTIC_FALLBACK,
        issues=issues,
        attempts=2,
        model_name=most_recent_result.model_name if most_recent_result else None,
        prompt_version=most_recent_result.prompt_version if most_recent_result else None,
        stage_timings=_stage_timings(),
    )
