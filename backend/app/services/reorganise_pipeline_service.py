"""
Orchestration for the Reorganise GENERATION boundary (R4) — selection
validation, image-correlation, R2 planning, and exactly one R3 image-
generation call, composed into one internal result. This is the pipeline
Direct Reorganise's /generate route calls, and the SAME pipeline Both
(R6) will call later — differing only in how selected_item_ids is
derived (client-supplied here; server-derived from
confirm_declutter_result()/confirmed_keep_ids() for Both), never a
second implementation.

Service/API boundary (binding, not a style preference): this module
returns raw internal domain data only — ReorganisePipelineResult holds a
real GenerationResult with real image_bytes, never a base64 string,
never an HTTP-facing DTO, and never imports fastapi. Only app/api/
routes.py may base64-encode image bytes for the browser or construct a
GenerateResponse — see that module's GeneratedImagePayload/
GenerateResponse. This keeps run_reorganise_pipeline() reachable from a
future evaluation script exactly like every other services/ function
(PROJECT_SPEC.md §4), not only from HTTP.

Health-check discipline (binding): this module NEVER injects or calls a
separate health-check callable. app/models/image_gen_client.generate()
already performs its own check_health() call internally before POSTing
(see that module's own docstring) — calling health twice per generation
would be redundant HTTP work and introduces a race where the first
health call succeeds and the second (or generate()'s own internal one)
fails. image_generator is called EXACTLY ONCE per
run_reorganise_pipeline() invocation. GET /image-gen/health (routes.py)
uses a completely separate injected health-check callable, never shared
with this module.

Image validation and hash correlation both happen HERE, before
plan_reorganisation() is ever called — never delegated to R3's generate()
(which only runs, if at all, well after planning) and never only checked
by the API-layer request schema (whose checks this module deliberately
duplicates, so this function stays safe to call directly, outside
FastAPI, with no schema validation having run at all).

Image-correlation hash — honest limitation, stated directly: comparing a
freshly-recomputed SHA-256 of the resubmitted image against the hash the
original /upload response reported detects accidental image/analysis
desynchronisation (a stale tab, the wrong file re-selected, a frontend
state bug). It is NOT cryptographic authentication — a client controlling
both the image and the claimed hash can always compute a matching hash
for altered data. Appropriate as a correlation invariant for this
project's actual scale (a single local user, no other party's data at
risk, no auth/session/database anywhere else in this codebase by
explicit design) — not a substitute for real authentication.
"""

from __future__ import annotations

import hashlib
import re
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, StringConstraints, TypeAdapter, ValidationError, model_validator

from app.core.image_validation import ImageValidationError, validate_image_bytes
from app.core.schemas import AnalysisResult, DetectedItem, NonEmptyStr
from app.models.image_gen_client import (
    GenerationResult,
    ImageGenRequestError,
    ImageGenResponseError,
    ImageGenServiceError,
    ImageGenTimeoutError,
    ImageGenUnavailableError,
)
from app.services.reorganise_service import ReorganisePlanner, ReorganisePlanningResult, plan_reorganisation

_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")

# Shared, validated hash-format type — the one home both this module (for
# its own independent format check) and app/api/routes.py's request/
# response schemas import from, rather than each defining their own copy.
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]

_RUN_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(NonEmptyStr)

ImageUnavailableReason = Literal[
    "service_unreachable", "timeout", "request_failed", "service_error", "invalid_response"
]


class ReorganisePipelineInputError(ValueError):
    """Malformed caller input to the Reorganise generation pipeline —
    empty/duplicate/unknown selected_item_ids, a run_id that doesn't
    match analysis.run_id, image bytes that fail
    app.core.image_validation.validate_image_bytes, or an
    input_image_sha256 that doesn't match the actually-supplied image
    bytes. Never raised for a planning or image-generation OUTCOME —
    those are represented in the returned ReorganisePipelineResult, never
    as an exception. Only for input that must never have reached
    plan_reorganisation() or the image generator at all. A ValueError
    subclass — same dual-catchability convention as
    app.core.confirmation.ConfirmationInputError /
    app.services.confirmation_service.IncompleteDeclutterError."""


class ImageGenerator(Protocol):
    """Structural shape run_reorganise_pipeline() needs for image
    generation — matches app.models.image_gen_client.generate()'s real
    signature exactly. The real generate() satisfies this with zero
    adapter code. Deliberately NOT a health-check callable, and this
    Protocol carries no health-check method — see module docstring: the
    real implementation already performs its own health check
    internally; nothing here may call a second one."""

    def __call__(
        self,
        run_id: str,
        image_bytes: bytes,
        image_media_type: str,
        prompt: str,
        negative_prompt: str | None = None,
        denoise_strength: float | None = None,
        controlnet_conditioning_scale: float | None = None,
        seed: int | None = None,
    ) -> GenerationResult: ...


class ReorganisePipelineResult(BaseModel):
    """The complete, internal output of run_reorganise_pipeline() — raw
    domain data only, never a browser-facing DTO. `generation` (when
    present) holds real image_bytes; base64 conversion is routes.py's job
    alone (see module docstring). This class does not import fastapi and
    is safe to construct/consume entirely outside HTTP.

    Invariants (enforced below, not just documented):
      - run_id == planning.run_id always.
      - image_status == "generated" requires a real `generation`, whose
        own run_id matches this result's run_id, and forbids
        image_unavailable_reason.
      - image_status == "unavailable" forbids `generation` and requires
        image_unavailable_reason.
    A completed plan is ALWAYS present regardless of image_status — there
    is no "no plan at all" outcome from this class, matching
    ReorganisePlanningResult's own equivalent guarantee one layer down."""

    model_config = ConfigDict(frozen=True)

    run_id: NonEmptyStr
    planning: ReorganisePlanningResult
    image_status: Literal["generated", "unavailable"]
    generation: GenerationResult | None
    image_unavailable_reason: ImageUnavailableReason | None

    @model_validator(mode="after")
    def _check_run_id_matches_planning(self) -> "ReorganisePipelineResult":
        if self.run_id != self.planning.run_id:
            raise ValueError("run_id must match planning.run_id")
        return self

    @model_validator(mode="after")
    def _check_generation_consistency(self) -> "ReorganisePipelineResult":
        if self.image_status == "generated":
            if self.generation is None:
                raise ValueError("generated status requires a generation result")
            if self.generation.run_id != self.run_id:
                raise ValueError("generation.run_id must match run_id")
            if self.image_unavailable_reason is not None:
                raise ValueError("generated status must not carry an unavailable reason")
        else:
            if self.generation is not None:
                raise ValueError("unavailable status must not carry a generation result")
            if self.image_unavailable_reason is None:
                raise ValueError("unavailable status requires an unavailable reason")
        return self


def _validate_run_id(run_id: Any) -> str:
    try:
        return _RUN_ID_ADAPTER.validate_python(run_id)
    except ValidationError as exc:
        raise ReorganisePipelineInputError(f"run_id is not a valid non-empty string: {run_id!r}") from exc


def _validate_and_order_selection(analysis: AnalysisResult, selected_item_ids: Any) -> list[DetectedItem]:
    """Rejects an empty selection, a duplicate id, or an id not present in
    analysis.items — NEVER silently deduplicates or drops anything.
    Reorders only once every id is confirmed valid, into analysis.items'
    own deterministic spatial order (never the caller-supplied array
    order), for reproducible planning prompts."""
    if not isinstance(selected_item_ids, list):
        raise ReorganisePipelineInputError(
            f"selected_item_ids must be a list, got {type(selected_item_ids).__name__}"
        )
    if not selected_item_ids:
        raise ReorganisePipelineInputError("selected_item_ids must be a non-empty list")

    normalized: list[str] = []
    for index, raw_id in enumerate(selected_item_ids):
        if not isinstance(raw_id, str) or not raw_id.strip():
            raise ReorganisePipelineInputError(
                f"selected_item_ids[{index}] must be a non-empty string: {raw_id!r}"
            )
        normalized.append(raw_id.strip())

    if len(normalized) != len(set(normalized)):
        raise ReorganisePipelineInputError("selected_item_ids contains duplicates")

    analysis_ids = {item.item_id for item in analysis.items}
    unknown = sorted(set(normalized) - analysis_ids)
    if unknown:
        raise ReorganisePipelineInputError(f"selected_item_ids references unknown item_id(s): {unknown}")

    selected_set = set(normalized)
    return [item for item in analysis.items if item.item_id in selected_set]


def _check_image(image_bytes: Any, image_media_type: Any) -> None:
    try:
        validate_image_bytes(image_bytes, image_media_type)
    except ImageValidationError as exc:
        raise ReorganisePipelineInputError(f"invalid image data: {exc}") from exc


def _check_image_hash(image_bytes: bytes, expected_input_image_sha256: Any) -> None:
    if not isinstance(expected_input_image_sha256, str) or not _SHA256_HEX_RE.fullmatch(
        expected_input_image_sha256
    ):
        raise ReorganisePipelineInputError(
            f"input_image_sha256 is not a valid 64-character lowercase hex string: {expected_input_image_sha256!r}"
        )
    actual = hashlib.sha256(image_bytes).hexdigest()
    if actual != expected_input_image_sha256:
        raise ReorganisePipelineInputError(
            "input_image_sha256 does not match the supplied image bytes — the resubmitted image does not "
            "correlate with the analysis it was paired with"
        )


def _unavailable_result(
    run_id: str, planning: ReorganisePlanningResult, reason: ImageUnavailableReason
) -> ReorganisePipelineResult:
    return ReorganisePipelineResult(
        run_id=run_id,
        planning=planning,
        image_status="unavailable",
        generation=None,
        image_unavailable_reason=reason,
    )


def run_reorganise_pipeline(
    run_id: str,
    analysis: AnalysisResult,
    selected_item_ids: list[str],
    image_bytes: bytes,
    image_media_type: str,
    expected_input_image_sha256: str,
    user_context: str | None,
    llm_planner: ReorganisePlanner,
    image_generator: ImageGenerator,
) -> ReorganisePipelineResult:
    """
    Order of operations — every caller-input check below happens BEFORE
    plan_reorganisation() is ever called, so a malformed request never
    costs a Phi-4-mini call:

      1. run_id validated, and checked against analysis.run_id.
      2. selected_item_ids validated (non-empty, unique, all present in
         analysis.items) and reordered into analysis.items' own
         deterministic order — see _validate_and_order_selection.
      3. image_bytes validated against image_media_type (genuine Pillow
         decode, actual format matches the claim) — see
         app.core.image_validation.validate_image_bytes.
      4. expected_input_image_sha256 format-checked, then compared
         against the ACTUAL recomputed hash of image_bytes.

    Only once all four pass does plan_reorganisation() run (R2, unchanged
    — at most two Ollama calls internally, always returns a real,
    trusted plan). image_generator is then called EXACTLY ONCE — never a
    second time, and this function never calls a separate health-check
    callable at all (see module docstring). A typed ImageGenError
    subclass from that one call is caught and mapped to
    image_status="unavailable" with a specific reason, the completed plan
    always preserved. Any OTHER (unexpected) exception from
    image_generator propagates uncaught — it is a genuine failure this
    pipeline doesn't understand, not something to silently disguise as
    "image unavailable".

    Raises ReorganisePipelineInputError for any of the four caller-input
    checks above. Safe to call directly, outside FastAPI — every check
    here is independent of whatever a route's own request schema may
    already have validated.
    """
    run_id = _validate_run_id(run_id)
    if run_id != analysis.run_id:
        raise ReorganisePipelineInputError("run_id must match analysis.run_id")

    selected_items = _validate_and_order_selection(analysis, selected_item_ids)
    _check_image(image_bytes, image_media_type)
    _check_image_hash(image_bytes, expected_input_image_sha256)

    planning = plan_reorganisation(
        run_id=run_id,
        selected_items=selected_items,
        scene_label=analysis.scene.label,
        user_context=user_context,
        llm_planner=llm_planner,
    )

    try:
        generation = image_generator(
            run_id=run_id,
            image_bytes=image_bytes,
            image_media_type=image_media_type,
            prompt=planning.plan.image_prompt,
            negative_prompt=planning.plan.negative_prompt,
        )
    except ImageGenUnavailableError:
        return _unavailable_result(run_id, planning, "service_unreachable")
    except ImageGenTimeoutError:
        return _unavailable_result(run_id, planning, "timeout")
    except ImageGenRequestError:
        return _unavailable_result(run_id, planning, "request_failed")
    except ImageGenServiceError:
        return _unavailable_result(run_id, planning, "service_error")
    except ImageGenResponseError:
        return _unavailable_result(run_id, planning, "invalid_response")

    return ReorganisePipelineResult(
        run_id=run_id,
        planning=planning,
        image_status="generated",
        generation=generation,
        image_unavailable_reason=None,
    )
