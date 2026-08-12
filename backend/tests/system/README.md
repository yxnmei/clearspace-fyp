# System tests — Validation

**"Are we building the right product?"** Black-box, through the actual
FastAPI app (`fastapi.testclient.TestClient`/`httpx` against the real
`app`) — POST an image to `/upload`, assert on the real HTTP response.

Two different things live in this directory, and it matters which one a
given test is:

**Hermetic HTTP/API vertical-slice tests** (e.g. `test_upload_declutter.py`)
— the normal case, run in every ordinary `pytest` invocation:
- Use `TestClient` against the real `app`.
- Exercise real routing, request parsing, response serialization, and the
  real production services (`app.services.analysis_service.analyse_image`,
  `app.services.declutter_service.run_declutter` run for real in the
  primary success test — not monkeypatched).
- Replace only the expensive model boundary — CLIP/Grounding DINO/Ollama
  — via FastAPI's documented `app.dependency_overrides` mechanism
  (`get_scene_classifier_provider`/`get_detector_provider`/
  `get_llm_classifier_provider` in `app/api/routes.py`), never a real
  model call.
- Are fast, deterministic, and require no local model weights or a
  running Ollama instance.
- **Are not real-model integration coverage.** They prove the route
  composes the real services correctly and maps errors correctly; they
  say nothing about whether the real CLIP/Grounding DINO/phi4-mini
  wrappers themselves produce good output. Don't describe a passing test
  here as evidence the real models work — see `tests/integration/
  README.md` for where that evidence (currently manual, not automated)
  lives.

**Full real-model end-to-end system tests** — concrete CLIP/Grounding
DINO/Ollama dependencies, no dependency overrides:
- Slow (real model inference) and environment-dependent (real weights,
  a running Ollama instance, gitignored test-image assets).
- Not part of the ordinary suite. Should be explicit/opt-in (e.g. a
  dedicated marker, run manually) or performed as a documented manual
  smoke test rather than an automated pytest test — see `DEVLOG.md`
  (local-only) for the 2026-08-11 example of the latter.
- **2026-08-11 manual run (first time the HTTP layer itself, not just
  the underlying service functions, was exercised with real models):**
  `TestClient` against the real `app.main.app`, no dependency overrides
  — `POST /upload` (`path=declutter`,
  `backend/data/test_images/bedroom02.jpg`) then `POST /confirm` with no
  overrides, using
  `C:\Users\yanme\anaconda3\envs\clearspace-fyp\python.exe` with Ollama
  running and `phi4-mini` pulled. Both HTTP requests returned **200**
  (`/confirm` is deterministic confirmation logic and does not invoke a
  model): `/upload` in ~81s (28/28 items resolved, `is_complete=True`,
  `is_strictly_valid=False`), `/confirm` in ~0.01s (28 confirmed
  decisions, 11 confirmed non-excluded Keep items). Full numbers in
  `DEVLOG.md` (local-only) under the same date; JSON responses were not
  committed anywhere, only this summary.
  - **Precondition, not yet fixed:** the current configuration resolves
    Grounding DINO's config/weight paths
    (`grounding_dino_config_path`/`grounding_dino_weights_path` in
    `app/config.py`, both relative strings under `weights/`) relative to
    the process working directory. Launching outside `backend/` causes
    detection startup failure (a real `503` was hit and confirmed this
    way before the run above succeeded). Run pytest, uvicorn, and any
    manual script like this one from `backend/` until that's fixed.

**Colab image-generation tests** (`/generate`, the Reorganise path) have
a **manual precondition that can never be automated the way
Declutter-path tests can**: the Colab notebook must be running and its
ngrok tunnel live. Document that requirement directly in each such
test's docstring, and mark it `@pytest.mark.requires_colab` so the rest
of the suite can run without a human going to start a notebook first.
