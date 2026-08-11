# Integration tests — Verification

**"Are we building the product right?"** Components combined, real models
loaded, no HTTP layer. Example (per §6): does Grounding DINO's output
actually feed correctly into the classification prompt — real detector,
real LLM call, checked at the Python-function boundary rather than
through `requests`.

This directory is currently empty of automated tests, deliberately — not
because the model implementations don't exist (they do: `app/models/
clip_scene.py`, `grounding_dino.py`, `mistral_llm.py` are all real and
working) but because no automated real-model integration test has been
written yet.

**Real evidence exists, just not as an automated test here.** One manual
production integration smoke test ran successfully on 2026-08-11: real
CLIP → real Grounding DINO → real phi4-mini (via Ollama), driven through
the actual production `app.services.analysis_service.analyse_image()` and
`app.services.declutter_service.run_declutter()` — no fakes anywhere in
that chain. See `DEVLOG.md` (local-only, gitignored — see that file's
own entry for the full result) for the recorded numbers. Fake-backed
HTTP tests under `tests/system/` (e.g. `test_upload_declutter.py`) are
**not** a substitute for this — they prove routing/composition, not that
the real models actually work, and must not be described as real-model
integration coverage.

Not automated yet because: a real run costs ~2 minutes of CPU time (CLIP
+ Grounding DINO + phi4-mini), needs local model weights and a running
Ollama instance as preconditions, and depends on gitignored test-image
assets (`data/test_images/`) — none of that belongs in the ordinary fast
suite. Don't backfill this directory with mocked-out versions just to
have something here; a green integration suite that never touched a real
model is worse than an honestly-empty directory, because it hides
exactly the risk this test type exists to catch.

When a real automated integration test is written here, mark it with
`@pytest.mark.integration` so `pytest -m "not integration"` skips it for
the fast unit-only loop, and CI (if added) can run it separately with a
longer budget — it should stay explicit/opt-in, not part of the default
`pytest` run.
