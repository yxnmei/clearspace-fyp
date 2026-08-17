"""
HTTP layer only. Every handler here should be a thin wrapper: parse the
request, call one function in app/services, shape the response. No model
loading, no prompt construction, no orchestration logic — that all lives
in services/ so it's reachable from evaluation scripts too (§4).

Endpoints mirror the v1 design (§3 step 6), kept because it worked:
  POST /upload           -> scene classification + detection + (declutter) LLM classification
  POST /confirm           -> deterministic user decision confirmation + confirmed Keep-item handoff
  POST /override     -> re-run LLM reasoning for one item after user edits its label
  POST /transcribe    -> Whisper transcript for user review before it affects context
  POST /generate        -> R2 zone plan + R3 image-gen via Colab/ngrok (Direct Reorganise, R4)
  GET  /image-gen/health -> §5: surfaced proactively in the UI, not just on failure

/upload's declutter path is the first real vertical slice: it composes
the existing, already-tested app.services.analysis_service.analyse_image()
and app.services.declutter_service.run_declutter() directly — no
label-cleanup/prompt/mapping/semantic/recovery logic is reimplemented
here, only HTTP parsing, dependency resolution, and error-type -> status-
code translation.

/upload's reorganise path (R4) composes the SAME analyse_image() — never
a second implementation — but never calls run_declutter() or the LLM-
classifier loader at all: Direct Reorganise skips Keep/Sell/Donate/
Discard triage entirely, letting the user select items to preserve
directly from the detection result. It additionally returns
input_image_sha256 (sha256 of the exact uploaded bytes) so a later
/generate request can be checked for correlation against the analysis it
claims to belong to — see ReorganiseUploadResponse and
app/services/reorganise_pipeline_service.py's own module docstring for
what that hash mechanism does and does not prove.

/generate (R4) is a thin route wrapper around
app.services.reorganise_pipeline_service.run_reorganise_pipeline() — all
selection/image/hash validation, R2 planning, and the single R3 image-
generation call happen there, never reimplemented here. This route's own
job is exactly three things: (1) parse/validate the JSON request shape,
(2) resolve the two model-boundary dependencies (the reorganise LLM
planner via a lazy two-level loader, the image generator via a
lightweight one-level provider — see their own docstrings below for why
they differ), (3) convert the pipeline's raw GenerationResult.image_bytes
to base64 for the browser. Base64 conversion happens ONLY here — the
service layer never imports base64 for this purpose and never touches
fastapi at all, so it stays reachable from a future evaluation script
exactly like every other services/ function (PROJECT_SPEC.md §4).

/confirm vs /override — deliberately two different endpoints, not one:
/confirm applies a user's Keep/Sell/Donate/Discard decision override (or
exclusion), keyed by item_id, entirely deterministically — it never calls
an LLM. /override is a *label correction* ("this is a storage box, not a
book"), which may justify re-running the LLM's reasoning for that one
item — see app/core/schemas.py's DecisionOverride docstring for the full
distinction. /override remains unimplemented in this task; only /confirm
is real.

Lazy model loading: importing this module (or app.main, which imports
it) must never import torch/CLIP/Grounding DINO/ollama or their concrete
wrapper modules (app.models.clip_scene/grounding_dino/mistral_llm). Those
three are obtained through a two-level FastAPI dependency: Depends()
resolves a cheap *loader* (a zero-arg closure that does the real import),
never the resolved callable itself — a plain one-level Depends(loader)
would still trigger the import for every request FastAPI resolves
dependencies for, including reorganise/both/invalid-path ones, since
FastAPI resolves every declared Depends() before the handler body runs
regardless of what the handler does with it afterward. The handler below
only calls the loader (triggering the real import) inside the
`path == "declutter"` branch. Tests override the *provider* dependencies
with the same two-level shape (a fake loader), never the model callables
directly, so the override behaves identically to production.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import math
from typing import Callable, Literal, Protocol

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.confirmation import ConfirmationInputError
from app.core.schemas import AnalysisResult, DecisionOverride, ItemId, NonEmptyStr
from app.logging_utils import new_run_id
from app.models.image_gen_client import IMAGE_GEN_API_VERSION, GenerationResult
from app.models.image_gen_client import check_health as _image_gen_check_health
from app.models.image_gen_client import generate as _image_gen_generate
from app.services.analysis_service import (
    DetectionError,
    InvalidImageError,
    ObjectDetector,
    SceneClassificationError,
    SceneClassifier,
    analyse_image,
)
from app.services.confirmation_service import (
    ConfirmationResult,
    IncompleteDeclutterError,
    confirm_declutter_result,
)
from app.services.declutter_service import (
    DeclutterReasoningError,
    DeclutterResult,
    LLMClassifier,
    reclassify_item,
    run_declutter,
)
from app.services.reorganise_pipeline_service import (
    ImageGenerator,
    ImageUnavailableReason,
    ReorganisePipelineInputError,
    ReorganisePipelineResult,
    Sha256Hex,
    run_reorganise_pipeline,
)
from app.services.reorganise_service import ReorganisePlanner, ReorganisePlanningResult

router = APIRouter()


# --- /upload (declutter path): response contract ---------------------------


class DeclutterUploadResponse(BaseModel):
    """The nested, non-reshaped response contract for path="declutter":
    the existing, already-validated AnalysisResult/DeclutterResult
    service outputs, verbatim — item_id is never renamed to id, and
    detections/decisions are never merged by label. The frontend joins
    analysis.items and declutter.ai_decisions/item_validity by item_id
    itself; that join does not happen here.

    path is deliberately Literal["declutter"], not the broader
    "declutter" | "reorganise" | "both" the request accepts — typing it
    narrowly means a caller can't accidentally construct one claiming to
    represent a Reorganise/Both result. path="both" is still a 501 (R6,
    not built yet); path="reorganise" returns a 200, but with the
    differently-shaped ReorganiseUploadResponse below, never this class."""

    run_id: NonEmptyStr
    path: Literal["declutter"]
    analysis: AnalysisResult
    declutter: DeclutterResult

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "DeclutterUploadResponse":
        if self.run_id != self.analysis.run_id or self.run_id != self.declutter.run_id:
            raise ValueError("run_id must match both analysis.run_id and declutter.run_id")
        return self


class ReorganiseUploadResponse(BaseModel):
    """The response contract for path="reorganise" (R4) — shared
    analysis only, deliberately no `declutter` field at all: Direct
    Reorganise never runs Keep/Sell/Donate/Discard triage. Mirrors
    DeclutterUploadResponse's run_id-consistency discipline.

    input_image_sha256 is computed server-side from the exact uploaded
    bytes (see the upload() handler) — a later /generate request must
    resubmit both this analysis and the same image, and is checked for
    correlation against this hash by
    app.services.reorganise_pipeline_service.run_reorganise_pipeline().
    See that module's own docstring for the honest limits of what this
    hash mechanism proves (correlation, not authentication)."""

    run_id: NonEmptyStr
    path: Literal["reorganise"]
    analysis: AnalysisResult
    input_image_sha256: Sha256Hex

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "ReorganiseUploadResponse":
        if self.run_id != self.analysis.run_id:
            raise ValueError("run_id must match analysis.run_id")
        return self


# --- /upload (declutter path): lazy dependency providers -------------------

# Loader = a zero-arg callable that performs the real (possibly heavy)
# import and returns the concrete model callable. The FastAPI dependency
# below returns the loader itself, never calls it — see module docstring.
SceneClassifierLoader = Callable[[], SceneClassifier]
DetectorLoader = Callable[[], ObjectDetector]
LLMClassifierLoader = Callable[[], LLMClassifier]


def _load_scene_classifier() -> SceneClassifier:
    from app.models.clip_scene import classify_scene

    return classify_scene


def _load_detector() -> ObjectDetector:
    from app.models.grounding_dino import detect

    return detect


def _load_llm_classifier() -> LLMClassifier:
    from app.models.mistral_llm import classify_items

    return classify_items


def get_scene_classifier_provider() -> SceneClassifierLoader:
    """FastAPI dependency. Cheap for every /upload request regardless of
    `path` — see module docstring for why this returns a loader instead
    of the resolved classify_scene callable."""
    return _load_scene_classifier


def get_detector_provider() -> DetectorLoader:
    return _load_detector


def get_llm_classifier_provider() -> LLMClassifierLoader:
    return _load_llm_classifier


# --- /upload -----------------------------------------------------------


@router.post("/upload", response_model=DeclutterUploadResponse | ReorganiseUploadResponse)
def upload(
    image: UploadFile = File(...),
    path: Literal["declutter", "reorganise", "both"] = Form(...),
    context: str | None = Form(None),
    scene_classifier_provider: SceneClassifierLoader = Depends(get_scene_classifier_provider),
    detector_provider: DetectorLoader = Depends(get_detector_provider),
    llm_classifier_provider: LLMClassifierLoader = Depends(get_llm_classifier_provider),
) -> DeclutterUploadResponse | ReorganiseUploadResponse:
    """
    Synchronous handler, deliberately: FastAPI/Starlette runs a plain
    `def` path operation in its threadpool executor automatically, which
    is what keeps the blocking CLIP/Grounding DINO/Ollama calls off the
    async event loop without any manual thread management here.

    An unrecognized `path` value never reaches this body at all — the
    Literal[...] annotation above makes it a request-validation failure
    (automatic 422) before FastAPI calls this function.

    path == "reorganise" (R4) shares analyse_image() with declutter —
    same scene_classifier/detector loaders, same real service call — but
    never resolves or calls the llm_classifier loader at all; Direct
    Reorganise has no use for Declutter's Keep/Sell/Donate/Discard
    reasoning. path == "both" remains a 501 (R6, not built yet).
    """
    if path == "both":
        raise HTTPException(
            status_code=501, detail="the Both (confirmed-Keep handoff) path is not implemented yet"
        )

    # path == "declutter" or "reorganise" from here on.
    image_bytes = image.file.read()
    run_id = new_run_id()

    # The real (possibly heavy) import happens here, only for a genuine
    # declutter/reorganise request — never for both/invalid-path ones.
    scene_classifier = scene_classifier_provider()
    detector = detector_provider()

    try:
        analysis = analyse_image(image_bytes, run_id, scene_classifier, detector)
    except InvalidImageError as exc:
        raise HTTPException(status_code=400, detail="invalid or unreadable image data") from exc
    except SceneClassificationError as exc:
        raise HTTPException(status_code=503, detail="scene classification service unavailable") from exc
    except DetectionError as exc:
        raise HTTPException(status_code=503, detail="object detection service unavailable") from exc

    if path == "reorganise":
        input_image_sha256 = hashlib.sha256(image_bytes).hexdigest()
        return ReorganiseUploadResponse(
            run_id=run_id, path="reorganise", analysis=analysis, input_image_sha256=input_image_sha256
        )

    # path == "declutter" from here on — the only remaining possibility.
    # The real (possibly heavy) LLM-classifier import happens here, only
    # for a genuine declutter request — never for a reorganise one.
    llm_classifier = llm_classifier_provider()
    try:
        declutter = run_declutter(analysis, user_context=context, llm_classifier=llm_classifier)
    except DeclutterReasoningError as exc:
        raise HTTPException(status_code=503, detail="LLM reasoning service unavailable") from exc

    # Any other exception (a genuine programming error, not one of the
    # typed failure modes above) is deliberately left uncaught here —
    # it becomes FastAPI's default 500, not a disguised success.
    return DeclutterUploadResponse(run_id=run_id, path="declutter", analysis=analysis, declutter=declutter)


# --- /confirm ------------------------------------------------------------


class ConfirmationRequest(BaseModel):
    """Request body for POST /confirm — JSON, not multipart (no file
    upload is involved). `declutter` is the frontend's round-tripped
    DeclutterResult from /upload's response — pydantic reconstructs and
    revalidates it here, including DeclutterResult's own is_complete
    computed field: a client-supplied "is_complete": true in the raw JSON
    is simply ignored (computed fields are never constructor input), so
    it can never make an actually-incomplete result look complete to
    confirm_declutter_result() below."""

    run_id: NonEmptyStr
    declutter: DeclutterResult
    overrides: list[DecisionOverride] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "ConfirmationRequest":
        if self.run_id != self.declutter.run_id:
            raise ValueError("run_id must match declutter.run_id")
        return self


@router.post("/confirm", response_model=ConfirmationResult)
async def confirm(request: ConfirmationRequest) -> ConfirmationResult:
    """
    Deterministic and stateless — no model dependency providers here
    (unlike /upload): confirmation never calls a model, so an ordinary
    `async def` handler is appropriate (nothing here blocks the event
    loop, unlike /upload's real CLIP/Grounding DINO/Ollama calls).
    """
    try:
        return confirm_declutter_result(request.declutter, request.overrides)
    except IncompleteDeclutterError as exc:
        raise HTTPException(
            status_code=409, detail="all Declutter items must be resolved before confirmation"
        ) from exc
    except ConfirmationInputError as exc:
        raise HTTPException(status_code=422, detail="invalid decision overrides") from exc
    # Deliberately NOT a bare `except ValueError` — pydantic's own
    # ValidationError is a ValueError subclass, so that would risk
    # mislabeling an internal ConfirmationResult invariant failure (a
    # genuine programming error) as "invalid decision overrides". Any
    # exception other than the two typed ones above is deliberately left
    # uncaught — FastAPI's default 500, not a disguised success, per
    # this codebase's existing failure-policy convention (see /upload
    # above).


class OverrideRequest(BaseModel):
    """Request body for POST /override — JSON, like /confirm, not
    multipart (replaces this route's original multipart-form stub shape:
    analysis/declutter are large nested objects, impractical as form
    fields, and every other object-carrying endpoint here already uses
    JSON). `analysis`/`declutter` are the frontend's round-tripped
    objects from the run being corrected — pydantic reconstructs and
    revalidates both here, same discipline as ConfirmationRequest.

    The cross-object check below is what actually proves analysis and
    declutter are a genuine matched pair from the same run (not just two
    independently-valid objects that happen to share a run_id): it
    requires declutter.expected_item_ids to equal, in order, the
    actionable ids in analysis.items — exactly what run_declutter() (and
    reclassify_item() below) already guarantee production-side, so a
    real prior response always satisfies this; only a hand-crafted or
    corrupted client payload could fail it, and it should.

    corrected_label is a validated non-empty string (NonEmptyStr) before
    this class's own validator even runs. item_id must be one of
    declutter's actionable items — resolved or already-unresolved are
    both valid; a contextual item_id (not in expected_item_ids at all)
    is rejected here, not silently accepted and ignored."""

    run_id: NonEmptyStr
    analysis: AnalysisResult
    declutter: DeclutterResult
    item_id: ItemId
    corrected_label: NonEmptyStr
    user_context: str | None = None

    @model_validator(mode="after")
    def _check_consistency(self) -> "OverrideRequest":
        if self.run_id != self.analysis.run_id or self.run_id != self.declutter.run_id:
            raise ValueError("run_id must match both analysis.run_id and declutter.run_id")

        # AnalysisResult's own model_validator already guarantees unique
        # item_ids within analysis.items — not re-checked here.
        actionable_ids = [item.item_id for item in self.analysis.items if item.item_role == "actionable"]
        if self.declutter.expected_item_ids != actionable_ids:
            raise ValueError(
                "declutter.expected_item_ids must exactly equal the actionable analysis item_ids, in "
                "order — analysis and declutter must be a matched pair from the same run"
            )

        if self.item_id not in actionable_ids:
            raise ValueError(f"item_id {self.item_id!r} is not an expected (actionable) item")

        return self


class OverrideResponse(BaseModel):
    """Mirrors DeclutterUploadResponse's shape (run_id/analysis/declutter)
    deliberately, minus `path` — a client can reuse the exact same
    analysis.items + declutter.ai_decisions/item_validity join logic it
    already has for /upload, since both responses round-trip the whole,
    freshly-validated pair rather than a delta/patch."""

    run_id: NonEmptyStr
    analysis: AnalysisResult
    declutter: DeclutterResult

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "OverrideResponse":
        if self.run_id != self.analysis.run_id or self.run_id != self.declutter.run_id:
            raise ValueError("run_id must match both analysis.run_id and declutter.run_id")
        return self


@router.post("/override", response_model=OverrideResponse)
def override(
    request: OverrideRequest,
    llm_classifier_provider: LLMClassifierLoader = Depends(get_llm_classifier_provider),
) -> OverrideResponse:
    """
    Synchronous handler, deliberately — same reasoning as /upload: a real
    reclassification call blocks on Ollama, so a plain `def` keeps that
    off the event loop via FastAPI's threadpool, no manual thread
    management needed. Reuses /upload's existing lazy llm_classifier
    dependency (no separate loader) — the real import happens only for a
    genuine request, never merely by importing this module.

    No custom exception-to-status-code mapping here, unlike /confirm:
    reclassify_item() never raises for an ordinary "the LLM didn't
    produce something usable" outcome — that is represented as a normal,
    successful 200 response with the item left/marked STILL_INVALID (see
    reclassify_item's own docstring). Request-shape violations (bad
    item_id, run_id mismatch, empty corrected_label, mismatched analysis/
    declutter) become automatic 422s via OverrideRequest's own
    validation, before this body ever runs. Any other exception is
    deliberately left uncaught — FastAPI's default 500, not a disguised
    success, matching this codebase's existing convention.
    """
    llm_classifier = llm_classifier_provider()
    result = reclassify_item(
        analysis=request.analysis,
        declutter=request.declutter,
        item_id=request.item_id,
        corrected_label=request.corrected_label,
        user_context=request.user_context,
        llm_classifier=llm_classifier,
    )
    return OverrideResponse(run_id=request.run_id, analysis=result.analysis, declutter=result.declutter)


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    raise NotImplementedError("Depends on app/models/whisper_stt.py")


# --- /generate (R4) -------------------------------------------------------

# Loader = a zero-arg callable that performs the real ollama import and
# returns the concrete planner callable. Mirrors get_llm_classifier_provider
# above exactly — the real import happens only inside generate_reorganisation's
# body, never merely by importing this module or app.main.
ReorganisePlannerLoader = Callable[[], ReorganisePlanner]


def _load_reorganise_planner() -> ReorganisePlanner:
    from app.models.reorganise_llm import generate_reorganise_plan_once

    return generate_reorganise_plan_once


def get_reorganise_planner_provider() -> ReorganisePlannerLoader:
    """FastAPI dependency — see _load_reorganise_planner and the module
    docstring's lazy-loading explanation for get_scene_classifier_provider
    et al."""
    return _load_reorganise_planner


def get_image_generator_provider() -> ImageGenerator:
    """FastAPI dependency resolving DIRECTLY to the real generate()
    callable — a ONE-level provider, unlike get_reorganise_planner_provider
    above. app.models.image_gen_client imports no heavy model library (no
    torch/clip/ollama/groundingdino — see that module's own
    test_module_does_not_import_model_libraries), so there is no
    import-cost reason to defer it behind a loader. This seam exists
    purely so tests can override it via app.dependency_overrides, exactly
    like every other provider here — never by monkeypatching a directly-
    imported module-level name."""
    return _image_gen_generate


class GenerateRequest(BaseModel):
    """Request body for POST /generate (R4) — JSON, not multipart:
    alongside the raw image this carries the large, already-validated
    AnalysisResult round-tripped from /upload (path="reorganise"), the
    same discipline OverrideRequest/ConfirmationRequest already
    established above for large nested objects.

    `image` is base64, no `data:` URL prefix — validated here for base64
    SYNTAX only (decodable, non-empty). Genuine image-content validation
    (real PNG/JPEG decode, format-matches-claim) and the
    input_image_sha256 MATCH check both happen inside
    run_reorganise_pipeline() itself, not here, since that also has to
    work when the pipeline is called directly, outside FastAPI (see
    app/services/reorganise_pipeline_service.py).

    denoise_strength/controlnet_conditioning_scale/seed are deliberately
    NOT fields here — R4 always uses R3's configured defaults; these are
    provisional generation-tuning values, not an ordinary user decision.
    R3's generate() already supports overriding them programmatically
    (for R7/evaluation use) without a public request field.

    extra="forbid": a client submitting denoise_strength/seed/any other
    unrecognised field must get a loud 422, never a silent 200 that lets
    them wrongly believe an unsupported field affected generation —
    pydantic's default (extra="ignore") would otherwise accept and
    silently drop it."""

    model_config = ConfigDict(extra="forbid")

    run_id: NonEmptyStr
    analysis: AnalysisResult
    selected_item_ids: list[ItemId]
    image: NonEmptyStr
    image_media_type: Literal["image/png", "image/jpeg"]
    input_image_sha256: Sha256Hex
    user_context: str | None = None

    @field_validator("image")
    @classmethod
    def _check_base64_syntax(cls, v: str) -> str:
        try:
            decoded = base64.b64decode(v, validate=True)
        except binascii.Error as exc:
            raise ValueError("image is not valid base64") from exc
        if not decoded:
            raise ValueError("image must decode to non-empty bytes")
        return v

    @model_validator(mode="after")
    def _check_consistency(self) -> "GenerateRequest":
        if self.run_id != self.analysis.run_id:
            raise ValueError("run_id must match analysis.run_id")
        if len(self.selected_item_ids) != len(set(self.selected_item_ids)):
            raise ValueError("selected_item_ids contains duplicates")
        if not self.selected_item_ids:
            raise ValueError("selected_item_ids must be non-empty")
        analysis_ids = {item.item_id for item in self.analysis.items}
        unknown = [i for i in self.selected_item_ids if i not in analysis_ids]
        if unknown:
            raise ValueError(f"selected_item_ids not present in analysis.items: {unknown}")
        return self


class GeneratedImagePayload(BaseModel):
    """API-facing, browser-consumable shape of a validated GenerationResult
    (R3) — the ONLY place in this codebase that base64-encodes generated
    image bytes for transport (see this module's own docstring). Preserves
    every validated R3 metadata field so it stays visible/auditable —
    provenance, model identifiers, both correlation hashes, and timing —
    never just the image itself. Never exposes the ngrok URL, a raw
    exception, or the raw remote response body — every field here is
    read from the already-validated GenerationResult, never raw HTTP.

    Field constraints deliberately MIRROR GenerationResult's own (R3) —
    this API contract must never be able to directly represent a value
    R3 itself would reject. api_version is pinned to the exact code-level
    constant (not any non-empty string); both hashes reuse the shared
    Sha256Hex format; denoise_strength/controlnet_conditioning_scale/
    generation_ms are range- and finiteness-checked; seed is rejected if
    it's a bool (checked mode="before", ahead of pydantic's own int
    coercion — Python's bool is an int subclass, so this must run before
    range validation to catch it at all) and range-checked otherwise;
    image is checked as genuine, non-empty, strict base64."""

    image: NonEmptyStr
    image_media_type: Literal["image/png", "image/jpeg"]
    api_version: Literal[IMAGE_GEN_API_VERSION]
    depth_map_used: Literal[True]
    denoise_strength: float = Field(ge=0.0, le=1.0)
    controlnet_conditioning_scale: float = Field(gt=0.0, le=2.0)
    seed: int = Field(ge=0, le=2**32 - 1)
    base_model: NonEmptyStr
    controlnet_model: NonEmptyStr
    service_version: NonEmptyStr
    generation_ms: float = Field(ge=0.0)
    prompt_sha256: Sha256Hex
    input_image_sha256: Sha256Hex

    @field_validator("seed", mode="before")
    @classmethod
    def _check_seed_not_bool(cls, v: object) -> object:
        if isinstance(v, bool):
            raise ValueError("seed must not be a boolean")
        return v

    @field_validator("generation_ms")
    @classmethod
    def _check_generation_ms_finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("generation_ms must be finite")
        return v

    @field_validator("image")
    @classmethod
    def _check_valid_base64(cls, v: str) -> str:
        try:
            decoded = base64.b64decode(v, validate=True)
        except binascii.Error as exc:
            raise ValueError("image is not valid base64") from exc
        if not decoded:
            raise ValueError("image must decode to non-empty bytes")
        return v

    @classmethod
    def from_generation_result(cls, generation: GenerationResult) -> "GeneratedImagePayload":
        return cls(
            image=base64.b64encode(generation.image_bytes).decode("ascii"),
            image_media_type=generation.image_media_type,
            api_version=generation.api_version,
            depth_map_used=generation.depth_map_used,
            denoise_strength=generation.denoise_strength,
            controlnet_conditioning_scale=generation.controlnet_conditioning_scale,
            seed=generation.seed,
            base_model=generation.base_model,
            controlnet_model=generation.controlnet_model,
            service_version=generation.service_version,
            generation_ms=generation.generation_ms,
            prompt_sha256=generation.prompt_sha256,
            input_image_sha256=generation.input_image_sha256,
        )


class GenerateResponse(BaseModel):
    """API-facing /generate response — mirrors the internal
    ReorganisePipelineResult (app/services/reorganise_pipeline_service.py)
    field-for-field except that `generation` (raw bytes) becomes `image`
    (base64), the browser-consumable shape. `planning` is the COMPLETE,
    unmodified ReorganisePlanningResult — attempts/provenance/issues/
    model_name/prompt_version/stage_timings all remain visible, never
    dropped to just the plan itself."""

    run_id: NonEmptyStr
    planning: ReorganisePlanningResult
    image_status: Literal["generated", "unavailable"]
    image: GeneratedImagePayload | None
    image_unavailable_reason: ImageUnavailableReason | None

    @model_validator(mode="after")
    def _check_run_id_matches_planning(self) -> "GenerateResponse":
        if self.run_id != self.planning.run_id:
            raise ValueError("run_id must match planning.run_id")
        return self

    @model_validator(mode="after")
    def _check_image_consistency(self) -> "GenerateResponse":
        if self.image_status == "generated":
            if self.image is None or self.image_unavailable_reason is not None:
                raise ValueError("generated status requires image and no unavailable_reason")
        else:
            if self.image is not None or self.image_unavailable_reason is None:
                raise ValueError("unavailable status requires no image and a reason")
        return self

    @classmethod
    def from_pipeline_result(cls, result: ReorganisePipelineResult) -> "GenerateResponse":
        return cls(
            run_id=result.run_id,
            planning=result.planning,
            image_status=result.image_status,
            image=GeneratedImagePayload.from_generation_result(result.generation)
            if result.generation is not None
            else None,
            image_unavailable_reason=result.image_unavailable_reason,
        )


@router.post("/generate", response_model=GenerateResponse)
def generate_reorganisation(
    request: GenerateRequest,
    reorganise_planner_provider: ReorganisePlannerLoader = Depends(get_reorganise_planner_provider),
    image_generator: ImageGenerator = Depends(get_image_generator_provider),
) -> GenerateResponse:
    """
    Synchronous handler, deliberately — same reasoning as /upload/
    /override: plan_reorganisation() blocks on Ollama and image_generator
    blocks on a real HTTP POST to Colab; FastAPI's threadpool keeps both
    off the event loop with no manual thread management here.

    All selection/image/hash validation, R2 planning, and the single R3
    image-generation call happen inside run_reorganise_pipeline() (see
    app/services/reorganise_pipeline_service.py) — this handler's only
    job is request parsing, dependency resolution, base64<->bytes
    conversion, and error-type -> status-code translation, matching this
    module's existing thin-handler convention.
    """
    llm_planner = reorganise_planner_provider()
    image_bytes = base64.b64decode(request.image)  # syntax already validated by GenerateRequest

    try:
        pipeline_result = run_reorganise_pipeline(
            run_id=request.run_id,
            analysis=request.analysis,
            selected_item_ids=request.selected_item_ids,
            image_bytes=image_bytes,
            image_media_type=request.image_media_type,
            expected_input_image_sha256=request.input_image_sha256,
            user_context=request.user_context,
            llm_planner=llm_planner,
            image_generator=image_generator,
        )
    except ReorganisePipelineInputError as exc:
        raise HTTPException(status_code=422, detail="invalid reorganise generation request") from exc

    # Any other exception (a genuine programming error, or an unexpected
    # image-generation exception the pipeline deliberately does not
    # catch — see that module's own docstring) is left uncaught here —
    # FastAPI's default 500, not a disguised success.
    return GenerateResponse.from_pipeline_result(pipeline_result)


# --- /image-gen/health (R4) ------------------------------------------------


class HealthChecker(Protocol):
    def __call__(self) -> bool: ...


def get_health_checker_provider() -> HealthChecker:
    """A SEPARATE provider from get_image_generator_provider above — this
    route must never share a callable with /generate's image_generator,
    and /generate must never call this provider either. See
    app/services/reorganise_pipeline_service.py's own docstring for why
    the pipeline never performs its own health pre-check: R3's generate()
    already does that internally."""
    return _image_gen_check_health


class ImageGenHealthResponse(BaseModel):
    available: bool


@router.get("/image-gen/health", response_model=ImageGenHealthResponse)
def image_gen_health(
    health_checker: HealthChecker = Depends(get_health_checker_provider),
) -> ImageGenHealthResponse:
    """
    §5: a lightweight pre-flight check the frontend calls up front (before
    the user ever clicks Reorganise), not just something wrapped in a
    try/except around the real generation call. Always 200 — a 503 here
    would conflate "the ClearSpace backend itself is unhealthy" (what
    GET /health in app/main.py represents) with "an external dependency
    is unreachable/incompatible," a different failure domain. Never
    surfaces the ngrok URL or a raw exception — check_health() itself
    already never raises (see app/models/image_gen_client.py). Cannot
    currently distinguish "offline" from "reachable but contract-
    incompatible" — both collapse to `available: false`, a known,
    documented limitation of R3's boolean-only health contract, not a
    defect introduced here.
    """
    return ImageGenHealthResponse(available=health_checker())
