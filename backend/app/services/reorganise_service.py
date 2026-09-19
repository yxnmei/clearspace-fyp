"""
Orchestration for the Reorganise PLANNING boundary (R2 — image generation
is R4's job, once app/models/image_gen_client.py's real generate() and
the route layer exist; nothing here touches images, HTTP, or Colab).

This file previously held label-based `run_reorganise()`/
`score_generation_fidelity()` stubs (raising NotImplementedError, keyed
by `kept_item_labels: list[str]`) — stale, unimplemented, and
contradicting the corrected item_id-only architecture. Removed here,
confirmed via `rg -n "run_reorganise|score_generation_fidelity"` to have
had zero callers anywhere in the repository before deletion.

RESEARCH-ONLY SINCE 2026-09-13. Neither entry point below is on the
production request path any more: Direct Reorganise and Both now produce
an AI-generated prioritised action checklist plus deterministic focus
areas and storage suggestions (app/services/reorganise_actions_service.py,
app/core/reorganise_focus_areas.py, app/core/reorganise_storage.py), not a
zone plan. This module, its schemas and its prompt are retained unchanged
for evaluation/scripts/compare_reorganise_planning.py and its tests. The
paragraphs below describe the arrangement as it stood while this module
still served production and are kept as history.

TWO entry points, and PRODUCTION USED THE FIRST:

  plan_reorganisation_direct() — the former production path. Builds the
  deterministic plan immediately, calls no planner, imports no ollama,
  and reports provenance DETERMINISTIC_DIRECT with zero attempts.

  plan_reorganisation() — the LLM state machine, RETAINED FOR RESEARCH
  and reachable only by passing a planner explicitly. One initial
  planning attempt; if it doesn't produce a trusted plan (call failure,
  invalid JSON, or a semantically invalid plan per
  app.core.reorganise_semantic_conversion.parse_and_validate_plan),
  exactly one targeted recovery attempt with bounded feedback; if that
  also fails, the deterministic fallback — never a third planner call.
  See its own docstring for the full state machine.

Why production stopped calling an LLM here: the 2026-08-20 bounded
planner screen (backend/evaluation/README.md) found no candidate model
able to produce a semantically valid plan for a crowded 28-item room, so
the two attempts before the fallback bought latency and nothing else.
Nothing about the LLM path is deleted — it stays exercised by unit tests
and by evaluation/scripts/compare_reorganise_planning.py.

Dependency injection, not a direct import of app.models.reorganise_llm:
llm_planner is typed as a Protocol (ReorganisePlanner, below), matching
app.services.declutter_service's own SceneClassifier/ObjectDetector/
LLMClassifier pattern exactly. This module never imports
app.models.reorganise_llm or ollama at all — the real
generate_reorganise_plan_once() already satisfies this Protocol
structurally, so production wiring (R4) passes it in directly with zero
adapter code, and this module's own tests stay free of ollama's
dependency surface entirely.

No stage_timer here, deliberately — stage_timer (app/logging_utils.py)
writes to logs/runs.jsonl on every call, which R2's unit tests (fake-
planner-backed, no real request) must never do. StageTiming is built
directly from time.perf_counter() and returned in-memory only; a future
caller (R4's route layer) decides whether/how to log it.
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

_MAX_ISSUE_DETAIL_LENGTH = 500  # matches R1's own bounded-detail convention
_TRUNCATION_SUFFIX = "…(truncated)"

# Bounded, non-empty detail — schema-enforced (not just by _bounded()'s
# own truncation at construction sites), same discipline as R1's own
# reorganise_semantic_conversion._BoundedDetail.
_BoundedIssueDetail = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_MAX_ISSUE_DETAIL_LENGTH)
]

_RUN_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(NonEmptyStr)


def _validate_run_id(run_id: Any) -> str:
    """Validates/normalizes run_id through the SAME shared NonEmptyStr
    type app.core.schemas already defines — no second, hand-written
    run-id rule to drift out of sync with it. Raises ValueError before
    the injected planner is ever called (see plan_reorganisation)."""
    try:
        return _RUN_ID_ADAPTER.validate_python(run_id)
    except ValidationError as exc:
        raise ValueError(f"run_id is not a valid non-empty string: {run_id!r} ({exc})") from exc


def _bounded(text: str, limit: int = _MAX_ISSUE_DETAIL_LENGTH) -> str:
    """Returned length never exceeds `limit`, including the suffix —
    same fixed convention as reorganise_semantic_conversion._bounded."""
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(_TRUNCATION_SUFFIX))
    return text[:keep] + _TRUNCATION_SUFFIX


class ReorganiseLLMResultLike(Protocol):
    """Structural shape of app.models.reorganise_llm.ReorganiseLLMResult
    — the exact fields this module reads, without importing that
    dataclass (and therefore never importing ollama) at runtime."""

    raw_text: str
    parsed_json: dict | list | None
    is_valid_json: bool
    was_repaired: bool
    model_name: str
    prompt_version: str


class ReorganisePlanner(Protocol):
    """Structural shape plan_reorganisation() needs from a planning call
    — matches app.models.reorganise_llm.generate_reorganise_plan_once's
    real signature exactly. Real generate_reorganise_plan_once satisfies
    this with zero adapter code."""

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
    """One structured, bounded reason a single attempt didn't produce a
    trusted plan directly. `conversion_errors` (R1's own structured
    PlanConversionError list) is populated only for semantic_invalid —
    call_failed/invalid_json have no structured conversion errors to
    report, and are rejected if given any (enforced below, not merely
    documented)."""

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
    """The output of plan_reorganisation() — always carries a real,
    trusted ReorganisePlan (even in the DETERMINISTIC_FALLBACK case;
    there is no "no plan at all" outcome from this function), plus the
    authoritative provenance and every issue encountered along the way.

    Invariants (enforced below, not just documented — a caller cannot
    directly construct a contradictory result):
      - Exactly one stage timing, with stage == "reorganise_plan" —
        always, regardless of provenance. This result represents exactly
        this one planning boundary; a future caller (R4) may wrap it with
        broader generation timings without mutating what this field means.
      - model_name/prompt_version are either both present (non-blank) or
        both None — never one without the other, and never fabricated:
        they always come from a wrapper result (never from raw plan JSON,
        which carries no such fields at all per ReorganisePlan's own
        extra="forbid" schema).
      - RAW_VALID / MECHANICALLY_REPAIRED: exactly one attempt, zero
        issues, non-blank model_name/prompt_version. Mechanical repair is
        represented entirely by provenance — it is not itself a "planning
        issue".
      - RECOVERY_USED: exactly two attempts, exactly ONE issue, and that
        issue belongs to the initial attempt (a successful recovery
        cannot simultaneously carry a recovery-attempt issue); non-blank
        model_name/prompt_version.
      - DETERMINISTIC_FALLBACK: exactly two attempts, exactly TWO issues,
        ordered [initial, recovery] (exactly one per attempt). Metadata
        may be None only when BOTH issues are `call_failed` (neither call
        ever returned a wrapper result to source metadata from);
        otherwise both fields must be present.
      - DETERMINISTIC_DIRECT: ZERO attempts, ZERO issues, and metadata
        BOTH None. No planner was called, so there is no attempt to
        count, no failure to report, and no model/prompt identity to
        name — asserting any of those would be fabricating evidence of
        an LLM call that never happened.
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
    """Fails fast on malformed caller input, before ANY planner call is
    made — deliberately checked here too (not only relied upon inside
    build_deterministic_fallback_plan, which only runs at the fallback
    step) so a bad caller input never costs even one real LLM call."""
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
    """
    The PRODUCTION planning path: build the deterministic plan directly,
    with no planner argument, no Ollama call, and no ollama import.

    Why this exists rather than calling plan_reorganisation() and letting
    it fall back: the fallback path reports provenance
    DETERMINISTIC_FALLBACK, attempts=2 and two `issues` describing two
    planner attempts that failed. Reaching the same plan without ever
    calling a planner and then reporting that would be fabricating
    evidence. This function reports DETERMINISTIC_DIRECT / attempts=0 /
    no issues / no model metadata instead — the truthful record of what
    actually happened.

    The policy behind it: the 2026-08-20 bounded planner screen found no
    candidate model able to produce a semantically valid plan for the
    crowded 28-item fixture (see backend/evaluation/README.md), so
    spending two planner calls before falling back bought nothing but
    latency. plan_reorganisation() below is retained unchanged and stays
    reachable for research by passing a planner explicitly.

    Same caller-input validation as plan_reorganisation(), deliberately
    duplicated rather than skipped — this is a public entry point, and a
    malformed selection must fail the same way on both paths.
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
    """
    Raises ValueError for an invalid run_id (validated/normalized through
    the same shared NonEmptyStr semantics as every other identity in this
    codebase — see _validate_run_id) or for other malformed caller input
    (see _validate_planning_inputs) — both BEFORE `llm_planner` is ever
    called. The normalized run_id is used consistently for every
    `llm_planner(...)` call and the returned result.

    Exception handling is deliberately narrow: only `llm_planner(...)`
    itself is wrapped in try/except. Everything downstream of a
    successful call (parse_and_validate_plan, PlanningIssue/
    ReorganisePlanningResult construction) is NOT — an unexpected
    internal exception there is a genuine programming defect and must
    propagate loudly, never be mislabeled as "the LLM's fault".
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
                # Provenance is always RECOVERY_USED on a successful
                # recovery, even if this response itself needed mechanical
                # repair — the notable fact is that a second attempt was
                # required at all, not the flavor of that second attempt's
                # own syntactic cleanliness. The initial issue is preserved
                # in `issues` for transparency, not discarded.
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
