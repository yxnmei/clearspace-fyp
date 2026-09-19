"""
Orchestration for the Both workflow's generation boundary (R6) — composes
app.services.confirmation_service.confirm_declutter_result() and
app.services.reorganise_pipeline_service.run_reorganise_pipeline() into
one call, deriving selected_item_ids ENTIRELY server-side from the
confirmed, non-excluded Keep decisions — never from client input. This is
the one place PROJECT_SPEC's Both-workflow requirement ("only confirmed,
non-excluded Keep items reach Reorganise, server-derived, never
client-supplied") is enforced:

    declutter + overrides
            |
    confirm_declutter_result()
            |
    confirmed_keep_ids
            |
    run_reorganise_pipeline()

Neither confirm_declutter_result()/confirmed_keep_ids() (app/core/
confirmation.py, app/services/confirmation_service.py) nor
run_reorganise_pipeline()/plan_reorganise_actions() (app/services/
reorganise_pipeline_service.py, app/services/reorganise_actions_service.py)
is modified or reimplemented anywhere in this module — this file only
sequences them.

No checklist model, and no Ollama, anywhere on this path: this module
passes action_generator=None to run_reorganise_pipeline(), which builds
the deterministic checklist directly and reports provenance
DETERMINISTIC_DIRECT with zero model calls, exactly as Direct Reorganise
does. There is no generator loader to resolve and no model module to
import. Both workflows therefore share one checklist, focus-area,
storage-suggestion and image-prompt implementation through
run_reorganise_pipeline(). See backend/evaluation/README.md for the two
real checklist-model runs that motivated this, and
app/services/reorganise_actions_service.py for the retained one-call
research path (reachable only by passing a generator explicitly).

An empty-Keep request still short-circuits before anything else runs:
plan_reorganise_actions is not called and image_generator is not called
— see run_both_generation's own docstring for the exact call-order
guarantee.

Service/API boundary (same discipline as reorganise_pipeline_service.py):
this module returns raw internal domain data only — BothGenerationResult
wraps a real ConfirmationResult and a real ReorganisePipelineResult,
never a browser-facing DTO — and never imports fastapi, so it stays
reachable from a future evaluation script exactly like every other
services/ function (PROJECT_SPEC.md §4).

Independent input validation (binding, matches reorganise_pipeline_service.py's
own stated philosophy): run_id/analysis/declutter consistency and the
declutter.expected_item_ids == actionable analysis ids check are both
re-verified HERE, not only trusted from whatever the API-layer request
schema already checked — so this function stays safe to call directly,
outside FastAPI, with no schema validation having run at all.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, model_validator

from app.core.schemas import AnalysisResult, DecisionOverride, NonEmptyStr
from app.services.confirmation_service import ConfirmationResult, confirm_declutter_result
from app.services.declutter_service import DeclutterResult
from app.services.reorganise_pipeline_service import (
    ImageGenerator,
    ReorganisePipelineInputError,
    ReorganisePipelineResult,
    run_reorganise_pipeline,
)
class BothPipelineInputError(ValueError):
    """Malformed caller input to run_both_generation() itself — a run_id
    that doesn't match analysis.run_id/declutter.run_id, or a
    declutter.expected_item_ids that doesn't exactly equal, in order, the
    actionable ids in analysis.items (i.e. analysis and declutter are not
    a genuine matched pair from the same run). Raised BEFORE
    confirm_declutter_result() is ever called. A ValueError subclass —
    same dual-catchability convention as
    app.services.reorganise_pipeline_service.ReorganisePipelineInputError
    / app.core.confirmation.ConfirmationInputError. Never raised for a
    confirmation or image-generation OUTCOME — see EmptyConfirmedKeepError
    and ReorganisePipelineInputError for those."""


class EmptyConfirmedKeepError(RuntimeError):
    """Raised when confirm_declutter_result() yields zero confirmed,
    non-excluded Keep items — nothing for Reorganise to plan around.

    Deliberately a RuntimeError subclass, NOT a ValueError subclass —
    mirrors app.services.confirmation_service.IncompleteDeclutterError's
    own reasoning exactly: this is an OUTCOME of otherwise-valid input (a
    legitimate confirmation where the user genuinely kept nothing), not
    malformed caller input, so it must never collide with a bare `except
    ValueError` written for BothPipelineInputError/ConfirmationInputError/
    ReorganisePipelineInputError. Raised AFTER confirm_declutter_result()
    succeeds but BEFORE the planner loader is ever called — see
    run_both_generation's own docstring."""


class BothGenerationResult(BaseModel):
    """The complete, internal output of run_both_generation() — raw
    domain data only, never a browser-facing DTO (see module docstring).
    Wraps a real ConfirmationResult (the server-derived confirmation
    outcome) and a real ReorganisePipelineResult (planning + optional
    generation) side by side, both keyed to the same run_id."""

    model_config = ConfigDict(frozen=True)

    run_id: NonEmptyStr
    confirmation: ConfirmationResult
    pipeline: ReorganisePipelineResult

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "BothGenerationResult":
        if self.run_id != self.confirmation.run_id or self.run_id != self.pipeline.run_id:
            raise ValueError("run_id must match both confirmation.run_id and pipeline.run_id")
        return self


def _check_matched_pair(run_id: str, analysis: AnalysisResult, declutter: DeclutterResult) -> None:
    """Mirrors app/api/routes.py's OverrideRequest._check_consistency
    exactly (duplicated, not imported — routes.py's request models are an
    HTTP-layer concern; this is the same rule enforced independently at
    the service boundary, per this module's own docstring)."""
    if run_id != analysis.run_id or run_id != declutter.run_id:
        raise BothPipelineInputError("run_id must match both analysis.run_id and declutter.run_id")

    actionable_ids = [item.item_id for item in analysis.items if item.item_role == "actionable"]
    if declutter.expected_item_ids != actionable_ids:
        raise BothPipelineInputError(
            "declutter.expected_item_ids must exactly equal the actionable analysis item_ids, in "
            "order — analysis and declutter must be a matched pair from the same run"
        )


def run_both_generation(
    run_id: str,
    analysis: AnalysisResult,
    declutter: DeclutterResult,
    overrides: list[DecisionOverride],
    image_bytes: bytes,
    image_media_type: str,
    expected_input_image_sha256: str,
    user_context: str | None,
    image_generator: ImageGenerator,
) -> BothGenerationResult:
    """
    Order of operations:

      1. run_id/analysis/declutter validated as a genuine matched pair
         (BothPipelineInputError) — see _check_matched_pair. Happens
         before confirm_declutter_result() is ever called.
      2. confirm_declutter_result(declutter, overrides) — reused verbatim
         from confirmation_service.py. Raises IncompleteDeclutterError
         (declutter.is_complete is False) or ConfirmationInputError
         (malformed overrides — a duplicate or an override referencing an
         unknown item_id) exactly as /confirm's own caller would see.
      3. If confirmation.confirmed_keep_ids is empty -> EmptyConfirmedKeepError,
         raised HERE. plan_reorganise_actions() is NOT called and
         image_generator is NOT called.
      4. Only now is run_reorganise_pipeline() called, with
         selected_item_ids=confirmation.confirmed_keep_ids — the ONLY
         source of selection this function ever uses — and with
         action_generator=None, the explicit production choice: the
         deterministic checklist is built directly, no model is called,
         and provenance is DETERMINISTIC_DIRECT. image_bytes/
         image_media_type/expected_input_image_sha256 are (re)validated
         inside run_reorganise_pipeline() itself (its own existing
         ReorganisePipelineInputError checks, unchanged, reused verbatim).

    Raises BothPipelineInputError / IncompleteDeclutterError /
    ConfirmationInputError / EmptyConfirmedKeepError / (propagated from
    run_reorganise_pipeline) ReorganisePipelineInputError. Safe to call
    directly, outside FastAPI, with no schema validation having run.
    """
    _check_matched_pair(run_id, analysis, declutter)

    confirmation = confirm_declutter_result(declutter, overrides)

    if not confirmation.confirmed_keep_ids:
        raise EmptyConfirmedKeepError(
            "no items were confirmed as Keep — nothing for Reorganise to plan around"
        )

    pipeline: ReorganisePipelineResult = run_reorganise_pipeline(
        run_id=run_id,
        analysis=analysis,
        selected_item_ids=confirmation.confirmed_keep_ids,
        image_bytes=image_bytes,
        image_media_type=image_media_type,
        expected_input_image_sha256=expected_input_image_sha256,
        user_context=user_context,
        action_generator=None,  # explicit production choice — see this function's docstring
        image_generator=image_generator,
    )

    return BothGenerationResult(run_id=run_id, confirmation=confirmation, pipeline=pipeline)
