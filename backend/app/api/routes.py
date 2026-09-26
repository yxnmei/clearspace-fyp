"""
HTTP layer only. Each handler is thin: parse the request, call one service
function, shape the response. Model loading, prompts and orchestration live
in app/services so evaluation scripts can call them without HTTP.

Endpoints:
  POST /upload             -> scene classification + detection (+ declutter LLM reasoning for declutter/both)
  POST /confirm            -> deterministic decision confirmation + confirmed Keep-item handoff
  POST /override           -> label correction; re-runs LLM reasoning for that one item
  POST /transcribe         -> speech-to-text transcript for user review before it affects context
  POST /generate           -> deterministic checklist (no LLM call) + focus areas + storage suggestions + Colab/ngrok image (Direct Reorganise)
  POST /generate/confirmed -> server-derived Keep selection + the same generation (Both)
  POST /listings           -> server-derived Sell eligibility + marketplace listing drafts
  POST /listings/{item_id}/regenerate -> regenerate one eligible listing draft
  GET  /image-gen/health   -> boolean availability, checked proactively by the UI

Every /upload path shares one analyse_image() call. "declutter" and "both"
add run_declutter(); "reorganise" and "both" add input_image_sha256 so a
later generation request can be checked for correlation with this
analysis (see reorganise_pipeline_service.py for what the hash proves).

Identity is item_id throughout; labels are display text and are never used
to join or match items. /generate/confirmed derives confirmed_keep_ids
server-side (run_both_generation -> confirm_declutter_result ->
run_reorganise_pipeline); the client never supplies a selection.

/confirm vs /override are deliberately separate: /confirm applies a
Keep/Sell/Donate/Discard override or exclusion by item_id,
deterministically, with no LLM call; /override is a label correction
("a storage box, not a book") that re-runs reasoning for that one item.
See DecisionOverride in app/core/schemas.py.

Base64 conversion of generated images happens only in this module, so the
service layer stays free of fastapi and transport encoding.

Lazy model loading: importing this module (or app.main) must never pull in
torch/CLIP/Grounding DINO/ollama/whisper or their wrapper modules. Heavy
models use a two-level dependency: Depends() resolves a cheap zero-arg
loader, and the handler calls it only on a path that needs the model. A
one-level Depends(loader) would not work, because FastAPI resolves every
declared dependency before the handler runs, even for paths that never use
it. Tests override the providers with fake loaders of the same shape.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import math
from typing import Callable, Literal, Protocol

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path, UploadFile
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from app.config import get_settings
from app.core.audio_decode import (
    AudioContainerMismatchError,
    AudioTooLongError,
    AudioValidationError,
    MalformedAudioError,
    UnsupportedAudioTypeError,
)
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
from app.services.both_service import (
    BothGenerationResult,
    BothPipelineInputError,
    EmptyConfirmedKeepError,
    run_both_generation,
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
from app.services.listing_service import (
    ListingEligibilityInputError,
    ListingGenerationResult,
    ListingItemNotEligibleError,
    LLMListingGenerator,
    SingleListingDraftResult,
    generate_listing_drafts,
    regenerate_one_listing_draft,
)
from app.services.reorganise_pipeline_service import (
    ImageGenerator,
    ImageUnavailableReason,
    ReorganisePipelineInputError,
    ReorganisePipelineResult,
    Sha256Hex,
    run_reorganise_pipeline,
)
from app.models.whisper_stt import (
    TranscriberUnavailableError,
    TranscriptContractError,
    TranscriptionFailedError,
    resolve_model_name,
    validate_transcript_result,
)
from app.core.reorganise_focus_areas import FocusArea
from app.core.reorganise_label_corrections import ReorganiseLabelCorrection
from app.core.reorganise_storage import StorageSuggestion
from app.core.reorganise_phases import TidyPlan
from app.core.listing_schemas import ListingItemDetails
from app.services.reorganise_actions_service import ReorganiseActionPlan
from app.services.transcription_service import (
    TranscriptionBusyError,
    transcribe_audio,
)

router = APIRouter()


# --- /upload (declutter path): response contract ---------------------------


class DeclutterUploadResponse(BaseModel):
    """path="declutter" response: the service results verbatim, never
    reshaped or merged by label. The frontend joins analysis.items to the
    declutter decisions by item_id itself.

    path is Literal["declutter"], not the request's wider union, so this
    class cannot be built for a Reorganise/Both result."""

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
    """path="reorganise" response: analysis only, no `declutter` field,
    because Direct Reorganise has no Keep/Sell/Donate/Discard triage.

    input_image_sha256 hashes the exact uploaded bytes. A later /generate
    resubmits this analysis and the same image, and run_reorganise_pipeline()
    checks the hash. It proves request correlation only, not
    authentication."""

    run_id: NonEmptyStr
    path: Literal["reorganise"]
    analysis: AnalysisResult
    input_image_sha256: Sha256Hex

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "ReorganiseUploadResponse":
        if self.run_id != self.analysis.run_id:
            raise ValueError("run_id must match analysis.run_id")
        return self


class BothUploadResponse(BaseModel):
    """path="both" response: the declutter triage result plus the same
    input_image_sha256 as path="reorganise". /generate/confirmed checks
    the resubmitted image against it (correlation only, as above)."""

    run_id: NonEmptyStr
    path: Literal["both"]
    analysis: AnalysisResult
    declutter: DeclutterResult
    input_image_sha256: Sha256Hex

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "BothUploadResponse":
        if self.run_id != self.analysis.run_id or self.run_id != self.declutter.run_id:
            raise ValueError("run_id must match both analysis.run_id and declutter.run_id")
        return self


# --- /upload (declutter path): lazy dependency providers -------------------

# Loader = zero-arg callable that does the real (heavy) import. Providers
# return the loader and never call it; see the module docstring.
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
    """Returns a loader, not the model (see module docstring)."""
    return _load_scene_classifier


def get_detector_provider() -> DetectorLoader:
    return _load_detector


def get_llm_classifier_provider() -> LLMClassifierLoader:
    return _load_llm_classifier


# --- /upload -----------------------------------------------------------


@router.post(
    "/upload", response_model=DeclutterUploadResponse | ReorganiseUploadResponse | BothUploadResponse
)
def upload(
    image: UploadFile = File(...),
    path: Literal["declutter", "reorganise", "both"] = Form(...),
    context: str | None = Form(None),
    scene_classifier_provider: SceneClassifierLoader = Depends(get_scene_classifier_provider),
    detector_provider: DetectorLoader = Depends(get_detector_provider),
    llm_classifier_provider: LLMClassifierLoader = Depends(get_llm_classifier_provider),
) -> DeclutterUploadResponse | ReorganiseUploadResponse | BothUploadResponse:
    """
    Plain `def` so Starlette runs the blocking CLIP/Grounding DINO/Ollama
    calls in its threadpool, off the event loop. An unknown `path` is a
    422 from the Literal annotation before this body runs.
    """
    image_bytes = image.file.read()
    run_id = new_run_id()

    # Real model imports happen here, only for requests that reach the body.
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

    # Only declutter and both reach here, so reorganise never loads the LLM.
    llm_classifier = llm_classifier_provider()
    try:
        declutter = run_declutter(analysis, user_context=context, llm_classifier=llm_classifier)
    except DeclutterReasoningError as exc:
        raise HTTPException(status_code=503, detail="LLM reasoning service unavailable") from exc

    if path == "both":
        input_image_sha256 = hashlib.sha256(image_bytes).hexdigest()
        return BothUploadResponse(
            run_id=run_id,
            path="both",
            analysis=analysis,
            declutter=declutter,
            input_image_sha256=input_image_sha256,
        )

    # Error policy for every handler here: typed failures map to fixed,
    # sanitised details; anything else is a programming error and is left
    # uncaught, so it becomes a 500 rather than a disguised success.
    return DeclutterUploadResponse(run_id=run_id, path="declutter", analysis=analysis, declutter=declutter)


# --- /confirm ------------------------------------------------------------


class ConfirmationRequest(BaseModel):
    """`declutter` is the round-tripped /upload DeclutterResult,
    revalidated here. is_complete is a computed field, so a client-sent
    "is_complete": true is ignored and cannot make an incomplete result
    confirmable."""

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
    """Deterministic and stateless with no model call, so `async def`."""
    try:
        return confirm_declutter_result(request.declutter, request.overrides)
    except IncompleteDeclutterError as exc:
        raise HTTPException(
            status_code=409, detail="all Declutter items must be resolved before confirmation"
        ) from exc
    except ConfirmationInputError as exc:
        raise HTTPException(status_code=422, detail="invalid decision overrides") from exc
    # Not a bare `except ValueError`: pydantic's ValidationError subclasses
    # it, so an internal invariant failure would be mislabelled as invalid
    # overrides. Anything else is a 500 (see upload()).


class OverrideRequest(BaseModel):
    """JSON body with the round-tripped analysis/declutter of the run
    being corrected (too large for form fields).

    The validator proves the two are a matched pair from one run, not just
    valid objects sharing a run_id: expected_item_ids must equal the
    actionable analysis ids in order, which any genuine prior response
    satisfies. A contextual item_id is rejected, not silently ignored."""

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

        # AnalysisResult already guarantees unique item_ids.
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
    """/upload's declutter shape minus `path`, so the client reuses its
    item_id join on the whole revalidated pair rather than a patch."""

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
    Plain `def` for the blocking Ollama call; reuses /upload's lazy
    llm_classifier provider.

    No status mapping: an unusable LLM answer is a normal 200 with the
    item marked STILL_INVALID (see reclassify_item). Bad request shapes
    are 422s from OverrideRequest; anything else is a 500.
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


# --- /transcribe ---------------------------------------------------------

# Voice is an optional way to supply user_context, never a command
# channel: this route only returns a transcript. The reviewed text reaches
# a model only when the user submits it as ordinary context.


class TranscribeResponse(BaseModel):
    """Strict wire shape: a malformed backend result (NaN, negative
    duration, blank model name) fails here and becomes a 503, never a 200.

    `transcript` is plain str, not NonEmptyStr: a silent recording is a
    legitimate empty transcript. `transcription_ms` is inference time
    excluding model load; `audio_duration_s` is decoded audio length.
    """

    model_config = ConfigDict(extra="forbid")

    transcript: str
    model_name: NonEmptyStr
    transcription_ms: float
    audio_duration_s: float

    @field_validator("transcription_ms", "audio_duration_s", mode="before")
    @classmethod
    def _real_finite_non_negative(cls, v: object) -> object:
        """Rejects bool before coercion; as an int subclass, `True` would
        otherwise become 1.0."""
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError("must be a real number")
        if not math.isfinite(v):
            raise ValueError("must be a finite number")
        if v < 0:
            raise ValueError("must not be negative")
        return v


Transcriber = Callable[..., object]
TranscriberLoader = Callable[[], Transcriber]


def _load_transcriber() -> Transcriber:
    """Called by the service only after the audio is validated and the
    single-flight slot is taken, so a rejected request loads nothing."""
    from app.models.whisper_stt import transcribe as _transcribe

    return _transcribe


def get_transcriber_provider() -> TranscriberLoader:
    """Returns a loader (see module docstring): whisper pulls in torch."""
    return _load_transcriber


@router.post("/transcribe", response_model=TranscribeResponse)
def transcribe(
    audio: UploadFile = File(...),
    transcriber_provider: TranscriberLoader = Depends(get_transcriber_provider),
) -> TranscribeResponse:
    """Plain `def` so decode and inference run in the threadpool. No
    detail string contains exception text, a file path, audio bytes, or
    the transcript.
    """
    settings = get_settings()
    max_bytes = settings.stt_max_upload_bytes

    # Read one byte past the limit: enough to reject an oversize upload
    # without buffering the whole body.
    audio_bytes = audio.file.read(max_bytes + 1)
    if len(audio_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail="audio upload is too large")

    # Only the typed misconfiguration is caught; a defect stays a 500.
    try:
        model_name = resolve_model_name(settings.stt_backend, settings.whisper_model_size)
    except TranscriberUnavailableError as exc:
        raise HTTPException(status_code=503, detail="transcription is unavailable") from exc

    # No `except Exception`: an unrelated ValueError/TypeError is a bug,
    # and "transcription is unavailable" would invite retries that can
    # never succeed. Third-party exceptions are normalised at the PyAV and
    # model-library boundaries instead.
    try:
        result = transcribe_audio(
            audio_bytes,
            audio.content_type,
            transcriber_provider,
            model_name=model_name,
            max_audio_seconds=settings.stt_max_audio_seconds,
            compute_type=settings.stt_compute_type,
            local_files_only=settings.stt_local_files_only,
            validate_result=validate_transcript_result,
        )
    except UnsupportedAudioTypeError as exc:
        raise HTTPException(status_code=415, detail="audio format is not supported") from exc
    except AudioContainerMismatchError as exc:
        raise HTTPException(
            status_code=415, detail="audio does not match its declared format"
        ) from exc
    except AudioTooLongError as exc:
        raise HTTPException(status_code=413, detail="audio is too long") from exc
    except MalformedAudioError as exc:
        raise HTTPException(status_code=400, detail="audio could not be read") from exc
    except AudioValidationError as exc:
        # Any future sibling of the four above still fails closed as a
        # client error rather than escaping as a 500.
        raise HTTPException(status_code=400, detail="audio could not be read") from exc
    except TranscriptionBusyError as exc:
        # Nothing was started and nothing is queued — the client may retry.
        raise HTTPException(
            status_code=503,
            detail="transcription is busy",
            headers={"Retry-After": "5"},
        ) from exc
    except TranscriberUnavailableError as exc:
        raise HTTPException(status_code=503, detail="transcription is unavailable") from exc
    except (TranscriptionFailedError, TranscriptContractError) as exc:
        # The model ran but produced nothing servable. Sanitised, and
        # distinct in the logs from a model that could not be loaded.
        raise HTTPException(status_code=503, detail="transcription is unavailable") from exc

    # The service already validated the result against the requested model
    # and the decoded audio; this is the wire-shape check.
    try:
        return TranscribeResponse(
            transcript=result.text,
            model_name=result.model_name,
            transcription_ms=result.transcription_ms,
            audio_duration_s=result.audio_duration_s,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=503, detail="transcription is unavailable") from exc


# --- /generate ------------------------------------------------------------

# No checklist-model dependency: both generation routes pass
# action_generator=None and get the deterministic checklist (provenance
# "deterministic_direct", zero model calls). The real phi4-mini checklist
# runs of 2026-09-17 (reorganise-actions-v1 and -v2) passed structural
# validation but failed human review; see backend/evaluation/README.md.
# The checklist model (app/models/reorganise_actions_llm.py) and the
# research zone planner (app/models/reorganise_llm.py) remain research
# code, reachable only by passing a generator explicitly; neither this
# module nor both_service.py resolves them.


def get_image_generator_provider() -> ImageGenerator:
    """One-level provider: image_gen_client loads no heavy model library,
    so there is nothing to defer. The seam exists for
    app.dependency_overrides in tests."""
    return _image_gen_generate


class GenerateRequest(BaseModel):
    """JSON body carrying the round-tripped /upload analysis
    (path="reorganise") and the image.

    `image` is base64 without a `data:` prefix; only its syntax is checked
    here. Content decoding and the input_image_sha256 match happen in
    run_reorganise_pipeline() so they also apply outside FastAPI.

    denoise_strength/controlnet_conditioning_scale/seed are not request
    fields: they are provisional generation-tuning values, so the route
    uses the client's configured defaults (evaluation can override them
    programmatically). extra="forbid" makes any such field a loud 422
    rather than silently ignored.

    label_corrections (keyed by item_id) is the only channel for a Direct
    Reorganise correction, so `analysis` must be unedited: an item already
    carrying corrected_label is rejected rather than trusted.
    /generate/confirmed has no such field."""

    model_config = ConfigDict(extra="forbid")

    run_id: NonEmptyStr
    analysis: AnalysisResult
    selected_item_ids: list[ItemId]
    label_corrections: list[ReorganiseLabelCorrection] = Field(default_factory=list)
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

        if any(item.corrected_label is not None for item in self.analysis.items):
            raise ValueError("analysis must be unedited; send label corrections in label_corrections")
        correction_ids = [correction.item_id for correction in self.label_corrections]
        if len(correction_ids) != len(set(correction_ids)):
            raise ValueError("label_corrections contains a duplicate item_id")
        unknown_corrections = [i for i in correction_ids if i not in analysis_ids]
        if unknown_corrections:
            raise ValueError(f"label_corrections not present in analysis.items: {unknown_corrections}")
        return self


class GeneratedImagePayload(BaseModel):
    """Browser-facing form of a validated GenerationResult, and the only
    place generated image bytes are base64-encoded. Keeps all generation
    metadata (provenance, model ids, both hashes, timing) auditable. Built
    only from the validated result, so it never exposes the ngrok URL, a
    raw exception or the remote response body.

    Constraints mirror GenerationResult's, so this contract cannot carry a
    value the client would reject. `seed` rejects bool before int
    coercion, since bool is an int subclass."""

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
    """ReorganisePipelineResult for the browser: raw generation bytes
    become a base64 `image`, and selected_item_ids is not echoed.
    `tidy_plan` is what the frontend renders; `action_plan` stays complete
    (provenance, attempts, model/prompt, issues) for auditability.
    `image_prompt` is the prompt actually sent to the image generator."""

    run_id: NonEmptyStr
    action_plan: ReorganiseActionPlan
    tidy_plan: TidyPlan
    focus_areas: list[FocusArea]
    storage_suggestions: list[StorageSuggestion]
    image_prompt: NonEmptyStr
    image_status: Literal["generated", "unavailable"]
    image: GeneratedImagePayload | None
    image_unavailable_reason: ImageUnavailableReason | None

    @model_validator(mode="after")
    def _check_run_id_matches_action_plan(self) -> "GenerateResponse":
        if self.run_id != self.action_plan.run_id:
            raise ValueError("run_id must match action_plan.run_id")
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
            action_plan=result.action_plan,
            tidy_plan=result.tidy_plan,
            focus_areas=result.focus_areas,
            storage_suggestions=result.storage_suggestions,
            image_prompt=result.image_prompt,
            image_status=result.image_status,
            image=GeneratedImagePayload.from_generation_result(result.generation)
            if result.generation is not None
            else None,
            image_unavailable_reason=result.image_unavailable_reason,
        )


@router.post("/generate", response_model=GenerateResponse)
def generate_reorganisation(
    request: GenerateRequest,
    image_generator: ImageGenerator = Depends(get_image_generator_provider),
) -> GenerateResponse:
    """
    Plain `def`: the image generator blocks on an HTTP call to Colab. The
    checklist is built in-process with no model call (see the /generate
    section comment). All validation and derivation happen in
    run_reorganise_pipeline().
    """
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
            action_generator=None,  # explicit production choice — deterministic_direct, no model call
            image_generator=image_generator,
            departing_decisions=None,
            label_corrections=request.label_corrections,
        )
    except ReorganisePipelineInputError as exc:
        raise HTTPException(status_code=422, detail="invalid reorganise generation request") from exc

    # Anything else, including an unexpected image-generation exception
    # the pipeline does not catch, is a 500 (see upload()).
    return GenerateResponse.from_pipeline_result(pipeline_result)


# --- /generate/confirmed (Both) -------------------------------------------


class ConfirmedGenerateRequest(BaseModel):
    """Carries confirmation's inputs (declutter + overrides), never its
    output: confirmed_keep_ids is always derived server-side by
    run_both_generation(). There is deliberately no selected_item_ids
    field, and extra="forbid" makes sending one a 422.

    Repeats GenerateRequest's base64 check and OverrideRequest's
    matched-pair check, and rejects override ids outside the actionable
    set early (the service would also reject them)."""

    model_config = ConfigDict(extra="forbid")

    run_id: NonEmptyStr
    analysis: AnalysisResult
    declutter: DeclutterResult
    overrides: list[DecisionOverride] = Field(default_factory=list)
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
    def _check_consistency(self) -> "ConfirmedGenerateRequest":
        if self.run_id != self.analysis.run_id or self.run_id != self.declutter.run_id:
            raise ValueError("run_id must match both analysis.run_id and declutter.run_id")

        # AnalysisResult already guarantees unique item_ids.
        actionable_ids = [item.item_id for item in self.analysis.items if item.item_role == "actionable"]
        if self.declutter.expected_item_ids != actionable_ids:
            raise ValueError(
                "declutter.expected_item_ids must exactly equal the actionable analysis item_ids, in "
                "order — analysis and declutter must be a matched pair from the same run"
            )

        actionable_id_set = set(actionable_ids)
        for i, override in enumerate(self.overrides):
            if override.item_id not in actionable_id_set:
                raise ValueError(
                    f"overrides[{i}].item_id {override.item_id!r} is not an expected (actionable) item"
                )

        return self


class ConfirmedGenerateResponse(GenerateResponse):
    """GenerateResponse plus the server-derived `confirmation`, so the
    frontend can show what was confirmed without a second request."""

    confirmation: ConfirmationResult

    @model_validator(mode="after")
    def _check_confirmation_run_id(self) -> "ConfirmedGenerateResponse":
        if self.run_id != self.confirmation.run_id:
            raise ValueError("run_id must match confirmation.run_id")
        return self

    @classmethod
    def from_both_result(cls, result: BothGenerationResult) -> "ConfirmedGenerateResponse":
        return cls(
            run_id=result.run_id,
            confirmation=result.confirmation,
            action_plan=result.pipeline.action_plan,
            tidy_plan=result.pipeline.tidy_plan,
            focus_areas=result.pipeline.focus_areas,
            storage_suggestions=result.pipeline.storage_suggestions,
            image_prompt=result.pipeline.image_prompt,
            image_status=result.pipeline.image_status,
            image=GeneratedImagePayload.from_generation_result(result.pipeline.generation)
            if result.pipeline.generation is not None
            else None,
            image_unavailable_reason=result.pipeline.image_unavailable_reason,
        )


@router.post("/generate/confirmed", response_model=ConfirmedGenerateResponse)
def generate_confirmed_reorganisation(
    request: ConfirmedGenerateRequest,
    image_generator: ImageGenerator = Depends(get_image_generator_provider),
) -> ConfirmedGenerateResponse:
    """
    Plain `def`, as for /generate. run_both_generation() passes
    action_generator=None, so Both gets the same deterministic checklist;
    an empty Keep set short-circuits before the pipeline or image
    generator runs.
    """
    image_bytes = base64.b64decode(request.image)  # syntax already validated by ConfirmedGenerateRequest

    try:
        result = run_both_generation(
            run_id=request.run_id,
            analysis=request.analysis,
            declutter=request.declutter,
            overrides=request.overrides,
            image_bytes=image_bytes,
            image_media_type=request.image_media_type,
            expected_input_image_sha256=request.input_image_sha256,
            user_context=request.user_context,
            image_generator=image_generator,
        )
    except IncompleteDeclutterError as exc:
        raise HTTPException(
            status_code=409, detail="all Declutter items must be resolved before confirmation"
        ) from exc
    except EmptyConfirmedKeepError as exc:
        raise HTTPException(
            status_code=409, detail="No items were confirmed as Keep, so there is nothing to include in a tidy plan."
        ) from exc
    except ConfirmationInputError as exc:
        raise HTTPException(status_code=422, detail="invalid decision overrides") from exc
    except BothPipelineInputError as exc:
        raise HTTPException(status_code=422, detail="invalid Both generation request") from exc
    except ReorganisePipelineInputError as exc:
        raise HTTPException(status_code=422, detail="invalid reorganise generation request") from exc

    # Anything else is a 500 (see upload()).
    return ConfirmedGenerateResponse.from_both_result(result)


# --- /image-gen/health -----------------------------------------------------


class HealthChecker(Protocol):
    def __call__(self) -> bool: ...


def get_health_checker_provider() -> HealthChecker:
    """Separate from get_image_generator_provider; /generate never calls
    it. The pipeline does not pre-check health itself because the
    client's generate() already does."""
    return _image_gen_check_health


class ImageGenHealthResponse(BaseModel):
    available: bool


@router.get("/image-gen/health", response_model=ImageGenHealthResponse)
def image_gen_health(
    health_checker: HealthChecker = Depends(get_health_checker_provider),
) -> ImageGenHealthResponse:
    """
    Proactive check the frontend makes before the user clicks Reorganise.
    Always 200: a 503 would conflate backend health (GET /health) with an
    unreachable external service. check_health() never raises or exposes
    the ngrok URL. The contract is boolean-only, so "offline" and
    "reachable but incompatible" both read as `available: false`.
    """
    return ImageGenHealthResponse(available=health_checker())


# --- /listings (marketplace listing drafts, V1) ---------------------------

# Two-level lazy loader (see module docstring): importing this module never
# loads app.models.listing_llm, which itself defers `ollama`. A
# zero-eligible request resolves the loader but makes no model call.
LLMListingGeneratorLoader = Callable[[], LLMListingGenerator]


def _load_listing_generator() -> LLMListingGenerator:
    from app.models.listing_llm import generate_listing_draft_once

    return generate_listing_draft_once


def get_listing_generator_provider() -> LLMListingGeneratorLoader:
    return _load_listing_generator


class ListingRequest(BaseModel):
    """extra="forbid": a client cannot send a confirmation, eligible Sell
    ids, image data, user context, a model choice or generated text. The
    eligible set and confirmation are derived server-side from
    (declutter, overrides); is_complete cannot be spoofed (see
    ConfirmationRequest).
    """

    model_config = ConfigDict(extra="forbid")

    run_id: NonEmptyStr
    analysis: AnalysisResult
    declutter: DeclutterResult
    overrides: list[DecisionOverride] = Field(default_factory=list)
    # Optional seller name/condition per item_id; never widens eligibility
    # or changes a decision.
    listing_details: list[ListingItemDetails] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "ListingRequest":
        if self.run_id != self.analysis.run_id or self.run_id != self.declutter.run_id:
            raise ValueError("run_id must match both analysis.run_id and declutter.run_id")
        return self


@router.post("/listings", response_model=ListingGenerationResult)
def create_listings(
    request: ListingRequest,
    listing_generator_provider: LLMListingGeneratorLoader = Depends(get_listing_generator_provider),
) -> ListingGenerationResult:
    """
    Plain `def`: listing calls block on Ollama. Some `unavailable` drafts
    is a normal 200; only malformed input is a 4xx. Signed source proof
    is deferred (see listing_service.py), so an internally consistent but
    fabricated bundle cannot be detected here.
    """
    listing_generator = listing_generator_provider()

    try:
        return generate_listing_drafts(
            run_id=request.run_id,
            analysis=request.analysis,
            declutter=request.declutter,
            overrides=request.overrides,
            listing_generator=listing_generator,
            listing_details=request.listing_details,
        )
    except IncompleteDeclutterError as exc:
        raise HTTPException(
            status_code=409, detail="all Declutter items must be resolved before listing"
        ) from exc
    except ConfirmationInputError as exc:
        raise HTTPException(status_code=422, detail="invalid decision overrides") from exc
    except ListingEligibilityInputError as exc:
        raise HTTPException(status_code=422, detail="invalid listing request") from exc
    # Anything else is a 500 (see upload()).


@router.post("/listings/{item_id}/regenerate", response_model=SingleListingDraftResult)
def regenerate_listing(
    request: ListingRequest,
    item_id: str = Path(..., min_length=1),
    listing_generator_provider: LLMListingGeneratorLoader = Depends(get_listing_generator_provider),
) -> SingleListingDraftResult:
    """
    Regenerates exactly one eligible Sell draft, named only by the
    {item_id} path segment; the body is the same ListingRequest. The
    service derives eligibility server-side and rejects a target that is
    not a confirmed, non-excluded Sell item before any model call.
    """
    listing_generator = listing_generator_provider()

    try:
        return regenerate_one_listing_draft(
            run_id=request.run_id,
            analysis=request.analysis,
            declutter=request.declutter,
            overrides=request.overrides,
            item_id=item_id,
            listing_generator=listing_generator,
            listing_details=request.listing_details,
        )
    except IncompleteDeclutterError as exc:
        raise HTTPException(
            status_code=409, detail="all Declutter items must be resolved before listing"
        ) from exc
    except ConfirmationInputError as exc:
        raise HTTPException(status_code=422, detail="invalid decision overrides") from exc
    except ListingItemNotEligibleError as exc:
        raise HTTPException(
            status_code=422,
            detail="item is not a confirmed Sell item eligible for a listing draft",
        ) from exc
    except ListingEligibilityInputError as exc:
        raise HTTPException(status_code=422, detail="invalid listing request") from exc
    # Anything else is a 500 (see upload()).
