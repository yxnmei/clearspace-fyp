"""Compose confirmation and generation for the Both workflow.

Only server-derived, confirmed, non-excluded Keep item_ids reach the
generation pipeline; clients never supply that selection. The service
revalidates the analysis/declutter pair, uses the deterministic checklist,
and returns domain data without HTTP concerns.
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
    """The run, analysis, and declutter inputs are not a matched pair."""


class EmptyConfirmedKeepError(RuntimeError):
    """A valid confirmation produced no Keep items to organise.

    A RuntimeError, not a ValueError: it is an outcome of valid input, so
    an `except ValueError` written for malformed input must never catch it."""


class BothGenerationResult(BaseModel):
    """Server-derived confirmation and generation results for one run."""

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
    """Enforce the matched-pair rule independently at the service boundary."""
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
    """Confirm choices, reject an empty Keep set, then run generation.

    Selection comes only from confirmation.confirmed_keep_ids. Validation
    and the empty-set check occur before the generation pipeline, which
    receives the confirmed decisions and the no-model checklist policy.
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
        departing_decisions=confirmation.confirmed_decisions,
    )

    return BothGenerationResult(run_id=run_id, confirmation=confirmation, pipeline=pipeline)
