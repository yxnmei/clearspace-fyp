"""
HTTP layer only. Every handler here should be a thin wrapper: parse the
request, call one function in app/services, shape the response. No model
loading, no prompt construction, no orchestration logic — that all lives
in services/ so it's reachable from evaluation scripts too (§4).

Endpoints mirror the v1 design (§3 step 6), kept because it worked:
  POST /upload      -> scene classification + detection + (declutter) LLM classification
  POST /override     -> re-run LLM reasoning for one item after user edits its label
  POST /transcribe    -> Whisper transcript for user review before it affects context
  POST /generate        -> zone plan + product recs + image-gen via Colab/ngrok
  GET  /image-gen/health -> §5: surfaced proactively in the UI, not just on failure
"""

from fastapi import APIRouter, File, Form, UploadFile

from app.logging_utils import new_run_id
from app.services import declutter_service, reorganise_service

router = APIRouter()


@router.post("/upload")
async def upload(
    image: UploadFile = File(...),
    path: str = Form(...),  # "declutter" | "reorganise" | "both"
    context: str | None = Form(None),
):
    run_id = new_run_id()
    raise NotImplementedError(
        "Wire once app/models/grounding_dino.py, clip_scene.py, mistral_llm.py "
        "are implemented — see §3 step 5 build order."
    )


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
