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
  POST /generate        -> zone plan + product recs + image-gen via Colab/ngrok
  GET  /image-gen/health -> §5: surfaced proactively in the UI, not just on failure

/upload's declutter path is the first real vertical slice: it composes
the existing, already-tested app.services.analysis_service.analyse_image()
and app.services.declutter_service.run_declutter() directly — no
label-cleanup/prompt/mapping/semantic/recovery logic is reimplemented
here, only HTTP parsing, dependency resolution, and error-type -> status-
code translation.

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

from typing import Callable, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, model_validator

from app.core.confirmation import ConfirmationInputError
from app.core.schemas import AnalysisResult, DecisionOverride, NonEmptyStr
from app.logging_utils import new_run_id
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
    run_declutter,
)

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
    "declutter" | "reorganise" | "both" the request accepts — this is
    the only value this endpoint can currently return a 200 for (the
    other two are 501s, never a constructed response body), and typing
    it narrowly means a caller can't accidentally construct one claiming
    to represent a Reorganise/Both result that doesn't exist yet."""

    run_id: NonEmptyStr
    path: Literal["declutter"]
    analysis: AnalysisResult
    declutter: DeclutterResult

    @model_validator(mode="after")
    def _check_run_id_consistency(self) -> "DeclutterUploadResponse":
        if self.run_id != self.analysis.run_id or self.run_id != self.declutter.run_id:
            raise ValueError("run_id must match both analysis.run_id and declutter.run_id")
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


@router.post("/upload", response_model=DeclutterUploadResponse)
def upload(
    image: UploadFile = File(...),
    path: Literal["declutter", "reorganise", "both"] = Form(...),
    context: str | None = Form(None),
    scene_classifier_provider: SceneClassifierLoader = Depends(get_scene_classifier_provider),
    detector_provider: DetectorLoader = Depends(get_detector_provider),
    llm_classifier_provider: LLMClassifierLoader = Depends(get_llm_classifier_provider),
) -> DeclutterUploadResponse:
    """
    Synchronous handler, deliberately: FastAPI/Starlette runs a plain
    `def` path operation in its threadpool executor automatically, which
    is what keeps the blocking CLIP/Grounding DINO/Ollama calls off the
    async event loop without any manual thread management here.

    An unrecognized `path` value never reaches this body at all — the
    Literal[...] annotation above makes it a request-validation failure
    (automatic 422) before FastAPI calls this function.
    """
    if path == "reorganise":
        raise HTTPException(status_code=501, detail="the Reorganise path is not implemented yet")
    if path == "both":
        raise HTTPException(
            status_code=501, detail="the Both (confirmed-Keep handoff) path is not implemented yet"
        )

    # path == "declutter" from here on — the only remaining possibility.
    image_bytes = image.file.read()
    run_id = new_run_id()

    # The real (possibly heavy) import happens here, only for a genuine
    # declutter request — never for reorganise/both/invalid-path ones.
    scene_classifier = scene_classifier_provider()
    detector = detector_provider()
    llm_classifier = llm_classifier_provider()

    try:
        analysis = analyse_image(image_bytes, run_id, scene_classifier, detector)
    except InvalidImageError as exc:
        raise HTTPException(status_code=400, detail="invalid or unreadable image data") from exc
    except SceneClassificationError as exc:
        raise HTTPException(status_code=503, detail="scene classification service unavailable") from exc
    except DetectionError as exc:
        raise HTTPException(status_code=503, detail="object detection service unavailable") from exc

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


@router.post("/override")
async def override(item_id: str = Form(...), new_label: str = Form(...), run_id: str = Form(...)):
    raise NotImplementedError("Depends on declutter_service.reclassify_item")


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    raise NotImplementedError("Depends on app/models/whisper_stt.py")


@router.post("/generate")
async def generate(
    image: UploadFile = File(...),
    kept_item_labels: list[str] = Form(...),
    run_id: str = Form(...),
):
    raise NotImplementedError("Depends on reorganise_service + app/models/image_gen_client.py")


@router.get("/image-gen/health")
async def image_gen_health():
    """
    §5: a lightweight pre-flight check the frontend calls up front (before
    the user ever clicks Reorganise), not just something wrapped in a
    try/except around the real generation call. Must fail fast — a dead
    ngrok tunnel should not hang until a long request timeout.
    """
    raise NotImplementedError("Depends on app/models/image_gen_client.py:check_health")
