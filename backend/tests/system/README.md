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
  - **Precondition at the time of this run, fixed 2026-08-14:** the
    configuration then resolved Grounding DINO's config/weight paths
    (`grounding_dino_config_path`/`grounding_dino_weights_path` in
    `app/config.py`, both relative strings under `weights/`) relative to
    the process working directory. Launching outside `backend/` caused
    detection startup failure (a real `503` was hit and confirmed this
    way before the run above succeeded). `app/models/grounding_dino.py`
    now resolves relative configured paths against `backend/` itself
    (the module file's own location, via `_resolve_backend_path()`), not
    `os.getcwd()` — see `tests/unit/test_grounding_dino.py`. Still
    launch pytest/uvicorn from `backend/` as a general convention, but it
    is no longer a hard requirement for Grounding DINO to resolve its
    weights correctly.
- **2026-08-14 manual run — real browser label-correction smoke test:**
  `POST /upload` -> `POST /override` -> `POST /confirm`, driven through a
  real Chrome browser (Playwright) against real `uvicorn` + `npm run dev`,
  no dependency overrides, no fake model services. Image:
  `backend/data/test_images/bedroom02.jpg`. `/upload` -> **200** (~131s,
  28/28 items resolved). A correction on `item_002` (`jewelry` ->
  `necklace`) via `/override` -> **200** (~8.3s) — only `phi4-mini` reran;
  CLIP/Grounding DINO did not (confirmed via backend log call counts);
  `item_id`/`box`/`raw_phrase`/`clean_label` byte-identical before/after,
  only the label-correction fields changed, all other 27 items untouched.
  `/confirm` -> **200** (~45ms), corrected label shown correctly in the
  confirmation summary, `item_002` in `confirmed_keep_ids`. Source tree
  stayed clean throughout. **Limitation:** the fresh post-correction AI
  decision happened to also be Keep, matching the preserved human Keep
  override, so this run alone doesn't distinguish which Keep value drove
  the outcome — that specific case (override differs from a fresh AI
  decision) is covered by automated fake-backed tests, not this real-model
  run. Full numbers in `DEVLOG.md` (local-only) under the same date. One
  real-model smoke test, not a full user study or acceptance test.
- **2026-08-17 manual run — real browser Direct Reorganise smoke test:**
  `POST /upload` (`path=reorganise`) -> `POST /generate`, driven through a
  real Chrome browser (Playwright) against real `uvicorn` + `npm run dev`,
  no dependency overrides, no fake model services. Colab deliberately not
  started, so this run also exercises the offline-fallback path. Image:
  `backend/data/test_images/bedroom02.jpg`. `/upload` -> **200** (scene
  `bedroom`, 0.9604 confidence, 28 detections, all actionable, duplicate
  labels rendered as independent `item_id`-keyed rows). 27 of 28 items
  selected; `/generate` -> **200** (~115s). **Both phi4-mini planning
  attempts produced a case-insensitive duplicate `zone_name` and were
  correctly rejected by R1's validator, falling through to
  `provenance="deterministic_fallback"`** — real evidence the
  two-attempt-then-fallback safety net works against a genuine LLM
  failure mode, not just in tests. Resulting plan: exact accounting (27
  planned == 27 selected). `image_status="unavailable"`,
  `image_unavailable_reason="service_unreachable"` as expected with Colab
  offline. UI (path selector, selection screen, result screen with
  collapsed disclosures and honest unavailable-preview messaging)
  confirmed via screenshots. Exactly 4 backend requests total (2x health,
  1x upload, 1x generate); zero `/confirm`/`/override` calls. No
  application defects found. Full numbers in `DEVLOG.md` (local-only)
  under the same date.
- **2026-08-18 manual run — real browser Both-workflow smoke test:**
  `POST /upload` (`path=both`) -> `POST /override` -> `POST /confirm` ->
  `POST /generate/confirmed`, driven through a real Chrome browser
  (Playwright) against real `uvicorn` + `npm run dev`, no dependency
  overrides, no fake model services, Colab deliberately offline. Image:
  `backend/data/test_images/bedroom02.jpg`. `/upload` -> **200** (~96.4s,
  28/28 resolved). A correction on `item_002` (`jewelry` -> `necklace`,
  re-verified visually beforehand) via `/override` -> **200** (~7.1s) —
  the correction's label and fresh reasoning were still present in the
  `/generate/confirmed` request body sent later, proving it propagated
  rather than being lost. One live decision override (`item_020`, Keep
  -> Sell) and one live exclusion (`item_025`, Keep, excluded), both
  chosen from the real response. `/confirm` -> **200** (~55ms), server
  re-derived exactly 21 confirmed Keep IDs, correctly omitting both
  edited items. `/generate/confirmed` -> **200** (~71.2s) — the request
  body contained exactly `{analysis, declutter, image, image_media_type,
  input_image_sha256, overrides, run_id, user_context}`, **no
  `selected_item_ids`/`confirmed_keep_ids`/confirmation result** anywhere
  in what the client sent. Response `confirmation.confirmed_keep_ids`
  matched the prior `/confirm` result exactly; **the plan contained
  exactly those 21 IDs, zero missing/extra**. **Both real phi4-mini
  planning attempts failed semantic validation** (a different concrete
  failure than the 2026-08-17 run's) and were correctly rejected,
  falling through to `provenance="deterministic_fallback"` — a second
  real-model confirmation the two-attempt-then-fallback safety net
  generalizes across distinct failure modes. With Colab offline, the
  complete 21-item plan remained visible alongside an honest
  unavailable-image state (zero `<img>` elements rendered). Start-over
  reset cleanly. No application defects found. **Verifies orchestration
  and failure handling — server-derived selection, request/response
  contracts, and the validation-and-fallback safety net — not the
  semantic validity of a successful (non-fallback) Phi-generated plan,
  and not real image generation** (Colab has never been started in this
  project's history). Full numbers in `DEVLOG.md` (local-only) under the
  same date.

- **2026-08-29 manual run — real browser voice smoke test, first run
  with `faster-whisper` as the production default:** backend started
  with `STT_BACKEND=faster-whisper`; `clip_001.m4a` (5.995 s) chosen
  through the voice audio-file control in the upload form. The
  faster-whisper logger reported `Processing audio with duration
  00:05.995`, which is what establishes *which backend* served the
  request — no DevTools capture of the response body was taken, so
  `model_name` is not independently evidenced here. Exactly one observed
  `POST /transcribe`, HTTP 200. The selected filename displayed
  correctly while the request ran; typed context stayed unchanged; the
  transcript appeared in the review panel only, and entered the context
  textarea **only** after an explicit `Replace context` click, after
  which the filename reset to `No audio file selected`. No room photo
  was selected and room analysis stayed disabled throughout, so no
  CLIP/Grounding DINO/Ollama/Colab work ran. **Verifies integration of
  the promoted default and the review-before-apply gate on one clip, one
  speaker, one browser journey — it is not an STT accuracy result.** The
  12-clip comparison in `backend/evaluation/README.md` remains the
  accuracy evidence. An earlier attempt on the same day reached the same
  backend successfully but was **not** accepted: it exposed a
  filename-display defect (the control read "No file chosen" immediately
  after selection, because the file input is cleared to preserve
  same-file retry). That was fixed and the run above is the passing
  rerun.

**Colab image-generation tests** (`/generate`, the Reorganise path) have
a **manual precondition that can never be automated the way
Declutter-path tests can**: the Colab notebook must be running and its
ngrok tunnel live. Document that requirement directly in each such
test's docstring, and mark it `@pytest.mark.requires_colab` so the rest
of the suite can run without a human going to start a notebook first.
