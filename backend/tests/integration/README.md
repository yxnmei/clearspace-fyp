# Integration tests — Verification

**"Are we building the product right?"** Components combined, real models
loaded, no HTTP layer. Checked at the Python-function boundary rather
than through a test client: real detector, real classifier, real LLM
call, composed by the real production services.

This directory holds **one opt-in real-model integration test**. It is
never part of the ordinary fast suite; the environment gate below is
what keeps `pytest -q` fast and offline.

## What `test_real_declutter_chain.py` covers

One chain, run once per invocation so each model loads exactly once:

```
real CLIP (app.models.clip_scene.classify_scene)
  -> real Grounding DINO (app.models.grounding_dino.detect, local weights)
    -> production app.services.analysis_service.analyse_image()
      -> real phi4-mini via local Ollama (app.models.mistral_llm.classify_items)
        -> production app.services.declutter_service.run_declutter()
```

Everything in that chain is real: the model wrappers, the loaders the
`/upload` route injects (the test asserts it composes the very same
callables), both services, the configured settings, the local weights and
the locally installed Ollama model. There are no `dependency_overrides`,
no `TestClient`, no routes, no fake classifier/detector/LLM, no
monkeypatching, no saved responses and no fixture JSON standing in for
model output.

It asserts **contracts and invariants**, never specific AI output:

- analysis: a valid `AnalysisResult`; the scene label is one of the
  configured CLIP candidates with confidence in [0, 1]; at least one
  item; canonical sequential unique `item_id`s; every box normalised and
  non-degenerate; every item satisfies the production schema (including
  a JSON round trip); roles and role sources valid; documented stage
  order; only the documented soft-failure warning kind.
- declutter: `expected_item_ids` equals the actionable items in analysis
  order; `model_name` equals the configured production model and
  `prompt_version` the production prompt; every decision is
  Keep/Sell/Donate/Discard with a non-blank reason; no unknown or
  duplicate ids; validity, unresolved and decided sets partition the
  expected set exactly; `is_complete`/`is_strictly_valid` agree with
  their definitions; the result survives a JSON round trip; and every
  expected item received exactly one decision (`is_complete`).

It deliberately does **not** assert an exact scene label, detection
count, item labels, any particular decision, reason wording, timings, or
`is_strictly_valid`. A complete result after mechanical repair or
targeted recovery is a legitimate production outcome, and every
documented real run so far has been complete-but-not-strict.

If the run fails on `is_complete` with a small number of unresolved
items and no exception, treat it first as model nondeterminism (the
LLM produced an item the one bounded recovery attempt could not
rescue), rerun once, and report; do not weaken the invariant to get a
pass, and do not change production code without approval.

## What it deliberately does not cover

- **Not model-quality evaluation.** It proves the real components
  compose and honour their contracts on one image. Decision accuracy,
  scene accuracy and detection quality are measured by the harnesses
  under `evaluation/` (see `evaluation/README.md`).
- **Not user acceptance testing.** Human-judged evidence belongs to the
  later UAT phase (`tests/acceptance/README.md`).
- **Not the HTTP layer.** Routing, request parsing, error mapping and
  response serialisation are covered by `tests/system/`, which remain
  **fake-model API vertical slices**: real routes and services with the
  model boundary replaced through `app.dependency_overrides`. They are
  fast and hermetic and are not real-model evidence.
- **Not Colab image generation.** Reorganise/Both tidy-plan generation
  runs deterministically and is covered by the system tests; the remote
  Stable Diffusion + ControlNet step needs a human to start the Colab
  notebook and a live tunnel, so it stays a separate manual or
  `requires_colab` opt-in concern (`tests/system/test_placeholder.py`).
  This test never contacts Colab, ngrok or anything but the configured
  local Ollama endpoint.
- **Not voice.** Whisper is exercised by `tests/system/test_transcribe.py`
  with fakes and by the documented manual smoke tests.
- **Not generalisation.** One image, one machine, one configured model.

## Why it is opt-in

A real run costs roughly **90-130 seconds** of CPU time on the current
machine (CLIP + Grounding DINO + several phi4-mini generations), needs
local model weights, a cached CLIP checkpoint, a running Ollama
instance with the configured model pulled, and a gitignored local image.
None of that belongs in the ordinary suite, and `@pytest.mark.integration`
alone is not a safety mechanism: `pytest.ini` registers the marker but
does not deselect it, so a plain `pytest -q` collects and runs this
directory. The environment gate is what protects the default run.

Do not backfill this directory with mocked-out tests just to have more
here. A green integration suite that never touched a real model hides
exactly the risk this test type exists to catch.

## Prerequisites (all local, nothing is downloaded, pulled or installed)

| Prerequisite | Where the gate looks |
|---|---|
| Grounding DINO config + weights | `GROUNDING_DINO_CONFIG_PATH` / `GROUNDING_DINO_WEIGHTS_PATH`, relative to `backend/` (default `weights/`) |
| CLIP checkpoint already cached | `~/.cache/clip/<CLIP_MODEL_NAME with / as ->.pt` (default `ViT-B-32.pt`), or a file path in `CLIP_MODEL_NAME` |
| Ollama running on a **local** host | `OLLAMA_HOST` (default `http://localhost:11434`); a non-local host is never contacted |
| Configured model installed | `LLM_MODEL_NAME` (default `phi4-mini`) listed by `GET /api/tags`, `:latest` accepted |
| Integration image | `CLEARSPACE_INTEGRATION_IMAGE`, else `backend/data/test_images/bedroom02.jpg` (gitignored local asset) |

The gate in `conftest.py` checks these **in order** and stops at the
first failure with a precise `pytest.skip` reason. Nothing heavy is
imported before the opt-in variable is verified; Ollama is contacted
only after its host has been confirmed local, with exactly one
`GET /api/tags`. A missing prerequisite is a skip, never a pass, and the
gate never substitutes another image, model or host.

## Environment variables

| Variable | Meaning |
|---|---|
| `CLEARSPACE_REAL_MODELS` | Must be exactly `1` to run. Anything else skips before any model import. |
| `CLEARSPACE_INTEGRATION_IMAGE` | Optional absolute path to a local photo. Empty or unset uses the default image above. |

Skip reasons name the variable or file at fault but never echo the
variable's value.

## Running

Always from `backend/`, always with the project interpreter (the
commands below assume it is the active `python`).

PowerShell:

```powershell
cd backend
$env:CLEARSPACE_REAL_MODELS = "1"
$env:CLEARSPACE_INTEGRATION_IMAGE = "C:\path\to\test-image.jpg"
python -m pytest tests/integration -m integration -q -rs
Remove-Item Env:CLEARSPACE_REAL_MODELS
Remove-Item Env:CLEARSPACE_INTEGRATION_IMAGE
```

POSIX shells (bash, Git Bash):

```bash
cd backend
CLEARSPACE_REAL_MODELS=1 CLEARSPACE_INTEGRATION_IMAGE=/path/to/test-image.jpg \
  python -m pytest tests/integration -m integration -q -rs
```

Omit `CLEARSPACE_INTEGRATION_IMAGE` to use the default local image.
`-rs` prints the skip reason when a prerequisite is missing. The real
run appends its usual stage records to the gitignored `logs/runs.jsonl`
exactly as production does; the test itself writes nothing into the
repository and prints only counts.

Explicit fast suite, excluding both opt-in markers by selection as well
as by gate:

```
python -m pytest -m "not integration and not requires_colab" -q
```

Default suite:

```
python -m pytest -q
```

With the opt-in variable absent the default suite still collects this
directory, imports nothing heavier than pytest and the standard library
from it, contacts nothing, loads no weights, and reports the one test as
**skipped** with the opt-in reason. The ordinary suite does not use real
models anywhere.

## Status of real-model evidence

- Automated, repeatable, opt-in: this one test (the Declutter chain).
- Manual, documented: the service-level and HTTP-level runs of
  2026-08-11, the browser smoke tests of 2026-08-14/17/18/29 and the
  live HTTP pass of 2026-09-22 (`tests/system/README.md`, `DEVLOG.md`,
  local-only).

This test is integration evidence that the production composition works
against the real models on one image. It is not a model-quality
evaluation and it is not user acceptance testing.
