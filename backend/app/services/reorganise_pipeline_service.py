"""
Orchestration for the Reorganise generation boundary: selection
validation, image-correlation, the action checklist, the deterministic
focus areas and storage suggestions, and exactly one remote image-generation
call, composed into one internal result. This is the pipeline Direct
Reorganise's /generate route calls, and the SAME pipeline Both calls,
differing only in how selected_item_ids is derived (client-supplied
here; server-derived from confirm_declutter_result()/confirmed_keep_ids()
for Both), never a second implementation.

What a result contains, and where each part comes from:
  action_plan         app.services.reorganise_actions_service. In
                      production the deterministic checklist, zero model
                      calls (provenance deterministic_direct); the
                      at-most-one-call model path is research-only.
                      Truthful provenance either way.
  tidy_plan           app.core.reorganise_phases: deterministic phases
                      built from selected items and any confirmed,
                      non-excluded departing decisions.
  focus_areas         app.core.reorganise_focus_areas: deterministic,
                      from the detected `position` descriptors only.
  storage_suggestions app.core.reorganise_storage: deterministic, from
                      the selected labels and sizes only, at most three.
  image_prompt        app.core.reorganise_image_prompt: deterministic,
                      from the room type, selected items and user
                      context. The checklist model never writes it.
  generation          the single image_generator call, or an unavailable
                      reason. The checklist, focus areas and suggestions
                      are always present regardless of image_status.

Service/API boundary (binding, not a style preference): this module
returns raw internal domain data only: ReorganisePipelineResult holds a
real GenerationResult with real image_bytes, never a base64 string,
never an HTTP-facing DTO, and never imports fastapi. Only app/api/
routes.py may base64-encode image bytes for the browser or construct a
GenerateResponse. This keeps run_reorganise_pipeline() reachable from an
evaluation script exactly like every other services/ function, not only
from HTTP.

Health-check discipline (binding): this module NEVER injects or calls a
separate health-check callable. app/models/image_gen_client.generate()
already performs its own check_health() call internally before POSTing;
calling health twice per generation would be redundant HTTP work and a
race. image_generator is called EXACTLY ONCE per run_reorganise_pipeline()
invocation. GET /image-gen/health (routes.py) uses a completely separate
injected health-check callable, never shared with this module.

Image validation and hash correlation both happen HERE, before any model
is called: never delegated to the image-generation client and never only checked by
the API-layer request schema (whose checks this module deliberately
duplicates, so this function stays safe to call directly, outside
FastAPI, with no schema validation having run at all).

Image-correlation hash, honest limitation, stated directly: comparing a
freshly-recomputed SHA-256 of the resubmitted image against the hash the
original /upload response reported detects accidental image/analysis
desynchronisation (a stale tab, the wrong file re-selected, a frontend
state bug). It is NOT cryptographic authentication: a client controlling
both the image and the claimed hash can always compute a matching hash
for altered data. Appropriate as a correlation invariant for this
project's actual scale (a single local user, no auth/session/database
anywhere else in this codebase by explicit design), not a substitute for
real authentication.
"""

from __future__ import annotations

import hashlib
import re
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, ValidationError, model_validator

from app.core.image_validation import ImageValidationError, validate_image_bytes
from app.core.reorganise_focus_areas import MAX_FOCUS_AREAS, FocusArea, derive_focus_areas
from app.core.reorganise_image_prompt import build_reorganise_image_prompt
from app.core.reorganise_label_corrections import (
    LabelCorrectionError,
    ReorganiseLabelCorrection,
    apply_label_corrections,
)
from app.core.reorganise_storage import MAX_STORAGE_SUGGESTIONS, StorageSuggestion, derive_storage_suggestions
from app.core.reorganise_phases import TidyPlan, build_tidy_plan
from app.core.schemas import AnalysisResult, ConfirmedDecision, Decision, DetectedItem, ItemId, NonEmptyStr
from app.models.image_gen_client import (
    GenerationResult,
    ImageGenRequestError,
    ImageGenResponseError,
    ImageGenServiceError,
    ImageGenTimeoutError,
    ImageGenUnavailableError,
)
from app.services.reorganise_actions_service import (
    ReorganiseActionGenerator,
    ReorganiseActionPlan,
    plan_reorganise_actions,
)

_SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")

# Shared, validated hash-format type: the one home both this module (for
# its own independent format check) and app/api/routes.py's request/
# response schemas import from, rather than each defining their own copy.
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]

_RUN_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(NonEmptyStr)

ImageUnavailableReason = Literal[
    "service_unreachable", "timeout", "request_failed", "service_error", "invalid_response"
]


class ReorganisePipelineInputError(ValueError):
    """Malformed caller input to the Reorganise generation pipeline:
    empty/duplicate/unknown selected_item_ids, malformed/duplicate/unknown
    label_corrections, a run_id that doesn't match analysis.run_id, image
    bytes that fail
    app.core.image_validation.validate_image_bytes, or an
    input_image_sha256 that doesn't match the actually-supplied image
    bytes. Never raised for a checklist or image-generation OUTCOME;
    those are represented in the returned ReorganisePipelineResult, never
    as an exception. A ValueError subclass, same dual-catchability
    convention as app.core.confirmation.ConfirmationInputError."""


class ImageGenerator(Protocol):
    """Structural shape run_reorganise_pipeline() needs for image
    generation; matches app.models.image_gen_client.generate()'s real
    signature exactly. Deliberately NOT a health-check callable, and this
    Protocol carries no health-check method (see module docstring)."""

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
    """The complete, internal output of run_reorganise_pipeline(): raw
    domain data only, never a browser-facing DTO. `generation` (when
    present) holds real image_bytes; base64 conversion is routes.py's job
    alone. Safe to construct/consume entirely outside HTTP.

    `selected_item_ids` is the server-ordered selection this result was
    built for (for Both, the confirmed Keep set); it is what the identity
    checks below join against and is not itself echoed by the API.

    Invariants (enforced below, not just documented):
      - run_id == action_plan.run_id always.
      - focus_areas: at most MAX_FOCUS_AREAS, every item_id selected, no
        item_id in two areas, counts non-increasing.
      - storage_suggestions: at most MAX_STORAGE_SUGGESTIONS, unique
        names, every related_item_id selected.
      - image_status == "generated" requires a real `generation` whose
        run_id matches, and forbids image_unavailable_reason.
      - image_status == "unavailable" forbids `generation` and requires
        image_unavailable_reason.
    The legacy action checklist, phased tidy plan, focus areas and storage
    suggestions are ALWAYS present regardless of image_status."""

    model_config = ConfigDict(frozen=True)

    run_id: NonEmptyStr
    selected_item_ids: list[ItemId] = Field(min_length=1)
    departing_item_ids: list[ItemId] = Field(default_factory=list)
    action_plan: ReorganiseActionPlan
    tidy_plan: TidyPlan
    focus_areas: list[FocusArea] = Field(min_length=1, max_length=MAX_FOCUS_AREAS)
    storage_suggestions: list[StorageSuggestion] = Field(max_length=MAX_STORAGE_SUGGESTIONS)
    image_prompt: NonEmptyStr
    image_status: Literal["generated", "unavailable"]
    generation: GenerationResult | None
    image_unavailable_reason: ImageUnavailableReason | None

    @model_validator(mode="after")
    def _check_identity(self) -> "ReorganisePipelineResult":
        if self.run_id != self.action_plan.run_id:
            raise ValueError("run_id must match action_plan.run_id")
        selected = set(self.selected_item_ids)
        if len(selected) != len(self.selected_item_ids):
            raise ValueError("selected_item_ids contains duplicates")
        departing = set(self.departing_item_ids)
        if len(departing) != len(self.departing_item_ids):
            raise ValueError("departing_item_ids contains duplicates")
        if selected & departing:
            raise ValueError("selected and departing item_ids must be disjoint")
        for phase in self.tidy_plan.phases:
            for step in phase.steps:
                if set(step.item_ids) - (selected | departing):
                    raise ValueError("tidy step references an item_id outside selected or departing")

        seen: set[str] = set()
        counts = [len(area.item_ids) for area in self.focus_areas]
        if counts != sorted(counts, reverse=True):
            raise ValueError("focus_areas must be ordered by item count, highest first")
        for area in self.focus_areas:
            for item_id in area.item_ids:
                if item_id not in selected:
                    raise ValueError(f"focus area {area.area_id!r} references unselected item_id {item_id!r}")
                if item_id in seen:
                    raise ValueError(f"item_id {item_id!r} appears in more than one focus area")
                seen.add(item_id)

        names = [suggestion.name.strip().lower() for suggestion in self.storage_suggestions]
        if len(names) != len(set(names)):
            raise ValueError("storage suggestion names must be unique")
        for suggestion in self.storage_suggestions:
            unknown = sorted(set(suggestion.related_item_ids) - selected)
            if unknown:
                raise ValueError(f"storage suggestion {suggestion.name!r} references unselected item_id(s): {unknown}")
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
    analysis.items; NEVER silently deduplicates or drops anything.
    Reorders only once every id is confirmed valid, into analysis.items'
    own deterministic spatial order (never the caller-supplied array
    order), for reproducible prompts."""
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
            "input_image_sha256 does not match the supplied image bytes; the resubmitted image does not "
            "correlate with the analysis it was paired with"
        )


def run_reorganise_pipeline(
    run_id: str,
    analysis: AnalysisResult,
    selected_item_ids: list[str],
    image_bytes: bytes,
    image_media_type: str,
    expected_input_image_sha256: str,
    user_context: str | None,
    action_generator: ReorganiseActionGenerator | None,
    image_generator: ImageGenerator,
    departing_decisions: list[ConfirmedDecision] | None = None,
    label_corrections: list[ReorganiseLabelCorrection] | None = None,
) -> ReorganisePipelineResult:
    """
    `action_generator` is REQUIRED and has no default; every caller must
    say which checklist path it wants, in writing:

      None        -> the deterministic checklist is built immediately, no
                     model is called, no model module is imported,
                     provenance DETERMINISTIC_DIRECT. This is what BOTH
                     production routes pass.
      a generator -> plan_reorganise_actions(): at most ONE checklist-
                     model call, then the deterministic checklist.
                     RESEARCH ONLY: both real phi4-mini checklist runs
                     failed human review (backend/evaluation/README.md),
                     so no production caller passes one. Used by unit
                     tests and any future separately approved test.

    Order of operations: every caller-input check below happens BEFORE
    any model is called, so a malformed request never costs a call:

      1. run_id validated, and checked against analysis.run_id.
         label_corrections (Direct Reorganise only; Both never passes
         them) validated and applied to a COPY of the analysis, so every
         derivation below reads the corrected effective_label.
      2. selected_item_ids validated (non-empty, unique, all present in
         analysis.items) and reordered into analysis.items' own order.
      3. image_bytes validated against image_media_type (genuine Pillow
         decode, actual format matches the claim).
      4. expected_input_image_sha256 format-checked, then compared
         against the ACTUAL recomputed hash of image_bytes.

    Only once all four pass do the deterministic derivations (focus
    areas, storage suggestions, image prompt) and the checklist run.
    image_generator is then called EXACTLY ONCE. A typed ImageGenError
    subclass from that one call is caught and mapped to
    image_status="unavailable" with a specific reason, everything else
    preserved. Any OTHER (unexpected) exception from image_generator
    propagates uncaught.

    Raises ReorganisePipelineInputError for any of the caller-input
    checks above. Safe to call directly, outside FastAPI.
    """
    run_id = _validate_run_id(run_id)
    if run_id != analysis.run_id:
        raise ReorganisePipelineInputError("run_id must match analysis.run_id")

    if label_corrections is not None:
        try:
            analysis = apply_label_corrections(analysis, label_corrections)
        except LabelCorrectionError as exc:
            raise ReorganisePipelineInputError(f"invalid label corrections: {exc}") from exc

    selected_items = _validate_and_order_selection(analysis, selected_item_ids)
    _check_image(image_bytes, image_media_type)
    _check_image_hash(image_bytes, expected_input_image_sha256)

    departing: list[tuple[DetectedItem, Decision]] = []
    if departing_decisions is not None:
        if not isinstance(departing_decisions, list) or any(not isinstance(x, ConfirmedDecision) for x in departing_decisions):
            raise ReorganisePipelineInputError("departing_decisions must be confirmed decisions")
        by_id = {item.item_id: item for item in analysis.items}
        selected_ids = {item.item_id for item in selected_items}
        seen_departing: set[str] = set()
        for decision in departing_decisions:
            if decision.excluded or decision.confirmed_decision is Decision.KEEP:
                continue
            if decision.item_id not in by_id or decision.item_id in selected_ids or decision.item_id in seen_departing:
                raise ReorganisePipelineInputError("departing decision has unknown, selected or duplicate item_id")
            seen_departing.add(decision.item_id)
            departing.append((by_id[decision.item_id], decision.confirmed_decision))

    scene_label = analysis.scene.label
    ordered_ids = [item.item_id for item in selected_items]

    focus_areas = derive_focus_areas(selected_items)
    storage_suggestions = derive_storage_suggestions(selected_items)
    image_prompt = build_reorganise_image_prompt(selected_items, scene_label, user_context)
    tidy_plan = build_tidy_plan(selected_items, scene_label, departing)

    action_plan = plan_reorganise_actions(
        run_id=run_id,
        selected_items=selected_items,
        scene_label=scene_label,
        user_context=user_context,
        generator=action_generator,
    )

    def _result(**generation_fields: Any) -> ReorganisePipelineResult:
        return ReorganisePipelineResult(
            run_id=run_id,
            selected_item_ids=ordered_ids,
            departing_item_ids=[item.item_id for item, _ in departing],
            action_plan=action_plan,
            tidy_plan=tidy_plan,
            focus_areas=focus_areas,
            storage_suggestions=storage_suggestions,
            image_prompt=image_prompt,
            **generation_fields,
        )

    try:
        generation = image_generator(
            run_id=run_id,
            image_bytes=image_bytes,
            image_media_type=image_media_type,
            prompt=image_prompt,
            negative_prompt=None,
        )
    except ImageGenUnavailableError:
        return _result(image_status="unavailable", generation=None, image_unavailable_reason="service_unreachable")
    except ImageGenTimeoutError:
        return _result(image_status="unavailable", generation=None, image_unavailable_reason="timeout")
    except ImageGenRequestError:
        return _result(image_status="unavailable", generation=None, image_unavailable_reason="request_failed")
    except ImageGenServiceError:
        return _result(image_status="unavailable", generation=None, image_unavailable_reason="service_error")
    except ImageGenResponseError:
        return _result(image_status="unavailable", generation=None, image_unavailable_reason="invalid_response")

    return _result(image_status="generated", generation=generation, image_unavailable_reason=None)
