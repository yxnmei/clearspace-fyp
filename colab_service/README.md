# ClearSpace Colab image-generation service (R7)

**Honest status, stated directly — verified evidence only:** on a real
Colab T4 GPU, models loaded and both local and public `/health` reported
ready. The original `POST /generate` HTTP attempt returned a real
**500** — MiDaS produced a 704×512 depth map for a 584×440 generation
image, and ControlNet rejected the tensor-dimension mismatch. The
permanent fix (`depth.py`, bilinear alignment) passed 205 local,
model-free tests **and has since been verified end to end through the
real frontend**: with that permanent function active (no temporary
monkeypatch), local and public `/health` passed and the browser rendered
a generated result. The runtime, the R3 HTTP contract, the orchestration
and frontend delivery therefore all work.

**What does not work is the output quality.** A bounded qualitative
pilot found the underlying whole-image SD1.5 + depth-ControlNet
architecture's results unacceptable — see "Real Phase 2 evidence" below.
Treat this pipeline as runtime-proven, quality-rejected. See "Provisional
items requiring Phase 2 verification" for what else remains unconfirmed.

## Architecture

A separate, independently-deployed FastAPI service, cloned into a Colab
GPU runtime and reached by the backend over an ngrok tunnel — never
imported by, or imported from, `backend/`. `backend/app/models/image_gen_client.py`
is the authoritative contract; every file in this directory mirrors it
deliberately (not by importing it — this service has zero dependency on
the backend package, by design, so it stays clonable and runnable on its
own).

```
colab_service/
  ClearSpace_Image_Gen.ipynb   launcher notebook — see "Running it" below
  app.py                        FastAPI: GET /health, POST /generate
  config.py                     settings, read from environment variables only
  schemas.py                    request/response contract (mirrors image_gen_client.py)
  resolution.py                 pure resolution policy (Option A — see below)
  depth.py                      MiDaS depth extraction (controlnet_aux)
  pipeline.py                   model loading + the real SD1.5/ControlNet call
  requirements.txt              Colab-runtime dependencies — provisional, see below
  tests/                        local, GPU-free tests (this Phase's own verification)
```

### Endpoints

**`GET /health`** — always 200. Returns the exact body
`app.models.image_gen_client.check_health()` requires, **only** once
every model has genuinely finished loading:
```json
{"status": "ok", "api_version": "v1", "service_version": "<non-blank>", "capabilities": {"depth_controlnet": true}}
```
Before that, `{"status": "loading"}` — any body other than the exact
success shape above is already treated as "unavailable" by the existing
backend client, so this distinction is for a human operator's benefit
only, not required by the contract.

**`POST /generate`** — see `schemas.py` for the exact field-by-field
contract (mirrors `image_gen_client.py` exactly: 9 request fields, 14
response fields, no more, no fewer). Single-generation concurrency: a
second request while one is already running gets an **immediate 503**,
never queued (see "Concurrency" below).

## Private-repository bootstrap

Colab starts from an empty VM every session — nothing here exists until
the notebook clones it. `ClearSpace_Image_Gen.ipynb`:
1. Reads `GITHUB_TOKEN`, `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` (see "Secrets"
   below) — each is rejected outright if blank/whitespace-only
   (`_get_secret()` raises rather than silently proceeding with an empty
   value).
2. **Refuses to run if `/content/clearspace-fyp` already exists** —
   fails with a clear message instructing you to restart the Colab
   runtime (for a guaranteed-clean checkout) or to deliberately remove
   the directory yourself first. It never silently reuses a possibly
   stale checkout and never deletes anything automatically. `GITHUB_TOKEN`
   is cleared from notebook memory before the cell exits on this path
   too — the same clearing described in step 3 below applies here, not
   just after an actual clone attempt.
3. Otherwise clones the plain, credential-free URL
   `https://github.com/yxnmei/clearspace-fyp.git` directly — the token is
   **never embedded in the URL, and never passed as a git command
   argument**. Authentication happens instead via process-local git
   configuration (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0=http.extraHeader`/
   `GIT_CONFIG_VALUE_0=Authorization: Basic base64(username:token)`)
   passed only in the environment of that one `subprocess.run(...)`
   call — GitHub HTTPS git uses the personal access token as the HTTP
   Basic password. The environment is a **filtered** copy of
   `os.environ` that deliberately excludes `NGROK_AUTHTOKEN`/
   `NGROK_DOMAIN` (already plain env vars by this point, with no reason
   to be visible to the git subprocess), never the notebook's own global
   `os.environ` unfiltered, never a `.git/config` file, never argv.
   Because the token is never in the URL to begin with, the cloned
   `origin` remote is clean from the very first command — **no
   post-clone URL rewrite is needed or performed.** Subprocess output is
   captured, never printed raw; any failure becomes one fixed, sanitized
   message. The temporary token-bearing environment dict, the
   base64-encoded credential, and the `GITHUB_TOKEN` variable itself are
   all discarded immediately after the clone attempt, success or
   failure.
4. Adds the cloned repository root to `sys.path`, so `colab_service` and
   its siblings become importable exactly as they are in this repo —
   no separate packaging step.
5. Installs `colab_service/requirements.txt`.

If your fork/remote is public, the authentication step still runs the
same way — a public repo simply doesn't need it to succeed — so nothing
behaves differently based on visibility.

## Secrets

Three secrets, **names only** — no values live in this repository, this
README, or any commit, ever:

| Secret name | Used for |
|---|---|
| `GITHUB_TOKEN` | Cloning the (possibly private) repository |
| `NGROK_AUTHTOKEN` | Authenticating the ngrok tunnel |
| `NGROK_DOMAIN` | The reserved/static ngrok domain to bind the tunnel to |

### Colab Web
Open the notebook at [colab.research.google.com](https://colab.research.google.com),
click the key icon in the left sidebar ("Secrets"), add each of the three
names above with your own real value, and toggle "Notebook access" on
for each. The notebook reads them via `google.colab.userdata.get(...)`.

### VS Code Colab extension
`google.colab.userdata.get()` is not always available through the VS
Code Colab extension. The notebook detects this automatically (a failed
or empty `userdata.get()` call) and falls back to a masked, interactive
prompt (`getpass.getpass()`) for whichever secret wasn't available —
typed input is never echoed to the cell output, never logged, never
written to a file. You'll be prompted once per session.

Either path ends the same way, but not identically for all three:
`NGROK_AUTHTOKEN`/`NGROK_DOMAIN` become **plain environment variables**
(`os.environ[...]`) before any committed `colab_service/*.py` module
ever runs. `GITHUB_TOKEN` deliberately never does — it stays only as
the notebook-local `GITHUB_TOKEN` variable, used once by the clone cell,
then cleared to `None` before that cell exits on every path (success,
a failed clone, or a stale-checkout refusal). **No file under
`colab_service/` other than the notebook itself ever imports
`google.colab` — this is deliberate**, so every other module stays
importable and testable on a plain machine with no Colab runtime at all
(see `tests/`).

## GPU/runtime prerequisites

- A Colab runtime with a GPU attached (`Runtime > Change runtime type >
  GPU`, or an equivalent local/VS-Code-Colab GPU session). The notebook's
  very first executable cell asserts `torch.cuda.is_available()` and
  stops with a clear message if not — no point installing multi-GB
  packages otherwise.
- A Colab account with sufficient GPU quota/availability (free-tier GPU
  availability is genuinely unpredictable — see "Troubleshooting").

## Provisional items requiring Phase 2 verification

Nothing below has been confirmed against a real Colab GPU runtime yet,
except where a specific real-run finding is noted:

- **Model identifiers** (`config.py`): `stable-diffusion-v1-5/stable-diffusion-v1-5`
  (base), `lllyasviel/sd-controlnet-depth` (ControlNet), `lllyasviel/Annotators`
  (MiDaS via `controlnet_aux.MidasDetector`). `pipeline.py` reports
  whichever identifiers it actually loaded, not these defaults blindly —
  but whether these defaults resolve and load cleanly at all is unverified.
- **The diffusers pipeline class** (`StableDiffusionControlNetImg2ImgPipeline`)
  and its exact constructor/call kwargs, against whatever `diffusers`
  version Phase 2 actually installs.
- **`controlnet_aux.MidasDetector`'s output format** genuinely matching
  what the `sd-controlnet-depth` checkpoint expects — the documented
  fallback if this proves wrong is `transformers.DPTForDepthEstimation`
  + `Intel/dpt-hybrid-midas` (more manual normalization work, not
  implemented here). **Real Phase 2 finding, confirmed on a real Colab
  GPU run (`bedroom02.jpg`, target generation resolution 584×440):**
  models loaded and health succeeded, but the original `POST /generate`
  HTTP attempt returned a real **500** — MidasDetector's own output was
  704×512, not pixel-aligned with the 584×440 input, and ControlNet
  rejected the mismatch as a tensor-dimension error (width 73 vs 88). The
  permanent fix — `extract_depth_map()` now resizes the depth map to the
  image's own size (bilinear, exactly once, only when the sizes differ)
  before returning it — passed 205 local, model-free tests **and was then
  verified end to end through the real frontend with that permanent
  function active (no monkeypatch): health passed and a generated result
  rendered in the browser.** The compatibility failure is resolved.
  Separately, the underlying architecture's output quality was assessed
  and found unacceptable — see "Real Phase 2 evidence" below.
- **Every dependency version** in `requirements.txt` — deliberately
  unpinned; Phase 2 must pin real, tested versions once something has
  actually installed and run successfully.
- **`xformers`** is not enabled by default (real compatibility risk
  against Colab's pre-installed CUDA/torch) — a Phase 2 decision, not
  assumed to work.
- **The 512×512-pixel resolution budget** and the memory-saving settings
  (`enable_attention_slicing`/`enable_vae_slicing`) — tuned against
  whatever VRAM headroom Phase 2 actually measures, not assumed correct
  now. `StableDiffusionControlNetImg2ImgPipeline` in the installed
  `diffusers` 0.40.0 runtime did not expose `enable_vae_slicing()`
  (verified on a real Colab runtime), so `load_pipeline()` now calls it
  only when the installed `diffusers` provides it and continues normally
  otherwise — a compatibility guard, not a version pin; attention
  slicing and the retained safety checker are unchanged.
- **`num_inference_steps` (30) and `guidance_scale` (7.5)**
  (`config.py`) — standard SD1.5 starting points, not yet evidence-backed
  for this specific checkpoint/ControlNet combination. Internal service
  settings only — never part of the R3 HTTP contract, never accepted
  from or echoed to a caller. Phase 2 must revise based on measured
  output quality and real generation runtime.
- **The base pipeline's own (retained, not disabled) safety checker's
  real behavior** on genuine room-photo generations — whether it ever
  false-flags ordinary content, and the real latency/VRAM cost of
  running it, are both unmeasured. `safety_checker=None` is not used;
  see pipeline.py's own docstring for why, and only concrete Phase 2 T4
  memory evidence should reopen that decision.
- **Generation timing** against the backend's 180s client timeout
  (`image_gen_request_timeout_s`) — expected to be comfortably
  sufficient based on typical SD1.5/T4 timings, but not yet measured for
  real.

## Real Phase 2 evidence (2026-08-19) — evidence boundary, quality pilot, and next steps

**Verified evidence only, stated precisely:**
- Models loaded; both local and public `/health` reported ready.
- The original `POST /generate` HTTP attempt returned a real 500 —
  MiDaS produced 704×512 for a 584×440 generation image (see the
  MidasDetector bullet above).
- The permanent `depth.py` fix passed 205 local, model-free tests.
- **The post-fix journey was then verified end to end through the real
  frontend**, with the permanent `extract_depth_map()` active and no
  temporary monkeypatch: local and public `/health` passed and the
  browser rendered a generated result. The R3 HTTP contract, the
  orchestration and frontend delivery are therefore confirmed working —
  the compatibility failure is closed.

**Separately: a bounded qualitative pilot**, `bedroom02.jpg` (one image,
a handful of parameter points — not a benchmark, no quantitative metric
computed, no experimental images committed), **found the underlying
architecture's output quality unacceptable. That the pipeline now runs
correctly end to end says nothing about whether what it produces is
usable, and it is not:**
- Baseline (`denoise_strength=0.35`, `controlnet_conditioning_scale=1.0`
  — the current `.env` defaults): preserved the room but produced
  negligible visible reorganisation.
- `denoise_strength=0.70` (ControlNet scales `0.50`/`0.65`/`0.80`):
  visibly more change, but hallucinated windows, furniture, lamps,
  decorations/text, and distorted objects never present in the original
  photo.
- `denoise_strength=0.60`/`controlnet_conditioning_scale=0.80`: also
  judged unacceptable.
- Prompt length was ruled out as the *sole* explanation, not entirely:
  compact prompts were verified at 67/77 (positive) and 43/77 (negative)
  tokens against SD1.5's own CLIP tokenizer, and outputs were still
  unacceptable at that prompt length — other, unexamined factors have
  not been excluded.

**Conclusion:** whole-image SD1.5 + depth ControlNet, as configured, is
not adequate for "meaningfully rearrange objects while inventing
nothing." Further prompt/parameter tuning on this same architecture is
not justified by this evidence. Masked inpainting is under
**consideration as an enabling component** for a future architecture —
**not already selected as the replacement**: on its own it cannot
relocate a retained object without target-position geometry, which does
not exist anywhere in this project's planning output today. Reorganise's
actual scope — "tidy/declutter in place" versus "physically move
furniture" — is a real, undecided product question this finding raises,
not one this document resolves.

### Phase 3a — enabling feasibility experiment (not yet run)

Before any contract change is designed, a small, bounded experiment must
directly test, inside Colab, with manually reviewed fixture data:
mask creation from existing Grounding DINO boxes; explicit compositing
of generated content back onto the *original* image so the final output
is **pixel-identical outside the finalized mask** (including any
feathering/dilation boundary — that boundary is folded into the
evaluation mask, not a free pass); exact preservation outside that
finalized mask; plausible local removal/tidying *inside* a mask; real T4
runtime under the existing 180s backend timeout.

Explicit, distinct operations to test — **not a single "inpaint at
strength 1.0 and call it preservation":**
- **preserve** — pixels outside any mask, untouched by construction;
- **remove** — declutter an item out of its own masked region;
- **locally tidy** — regenerate content within an item's existing
  footprint;
- **move** — deliberately **deferred to Phase 3b**; requires target
  geometry that does not exist yet.

Two predetermined, different seeds only if repeat testing is judged
necessary — repeating the same seed is not a robustness test.

**Phase 3a pass criteria (all six, falsifiable):**
1. Exact zero pixel difference outside the finalized composite mask.
2. No new architectural openings or unrelated furniture anywhere in the
   output.
3. The intended local edit is visibly plausible and useful.
4. Completion within 180 seconds on the tested Colab GPU.
5. Any failure of preservation (#1) is immediately disqualifying,
   regardless of #2/#3.
6. At most one predefined retune permitted; no open-ended parameter
   search.

### Phase 3b — full Reorganise (only if Phase 3a passes)

Investigate target-position planning and relocation/compositing.
Requires both source AND target geometry — target geometry does not
exist anywhere in this project's planning output (`ReorganisePlan`/
`ReorganiseZone`) today, and remains unsolved; not answered here.

### Fallback

**InstructPix2Pix (or any similarly unmasked instruction-editing model)
is explicitly not recommended as a production fallback** — it has no
structural preservation guarantee, the same failure class already
rejected above. The honest fallback that already exists and is already
implemented is the completed text plan with `image_status="unavailable"`
(visual preview unavailable) — a real, working, already-tested outcome,
not a new build.

### Future contract implications (not designed yet)

A future v2 contract would likely require, **at minimum** (this list is
not claimed sufficient on its own, and no schema is finalized here):
`item_id`; effective label; normalized source box; an explicit operation
(`preserve`/`remove`/`locally_tidy`/`move`); target geometry for `move`,
once/if Phase 3b makes it available. No v2 schema is designed or
implemented until Phase 3a's evidence justifies it.

## Resolution policy (Option A)

`resolution.py`'s `compute_target_resolution()` is pure, deterministic,
and GPU-independent — see its own docstring and `tests/test_resolution.py`.
Given the original image's width/height and a pixel budget (512×512 by
default, near SD1.5's own training-resolution sweet spot), it searches
the nearby multiple-of-8 candidate dimensions (a hard SD/VAE requirement)
and picks whichever pair's aspect ratio is closest to the original.

**This does not achieve exact aspect-ratio preservation, and does not
claim zero stretching** — rounding to a multiple of 8 introduces a
small, real, bounded deviation (typically well under 5% for realistic
room photos, reported honestly as `ratio_deviation` rather than hidden),
and resizing the image to that slightly-off-ratio target size (`app.py`,
via `Image.Resampling.LANCZOS`) means the horizontal and vertical scale
factors are not quite equal — a genuine small, bounded, non-uniform
rescale, not a distortion-free operation. What it never does: crop
content, or flip the image into a different orientation. The
alternative, exact-preservation approach (pad to a multiple-of-8 canvas,
generate, then unpad) was considered and deferred — it fully preserves
the ratio but adds real complexity (tracking pad offsets end-to-end,
padding the depth map identically) and a minor, worth-flagging risk that
a hard pad-boundary edge can subtly influence generation near the
border. Revisit if real testing shows the small snap-to-grid deviation
actually matters.

## Security — read before running

**The ngrok tunnel has no application-level authentication.** Its only
protection is that the URL isn't published — that is weak, temporary
protection, appropriate **only while you are actively, personally
testing**. Do not leave the notebook (and therefore the tunnel) running
unattended. Stop it when you're done (see "Cleanup" below).

This service never logs or returns prompts, images, base64 payloads,
tokens, or credential-bearing URLs in any response, and never returns a
raw traceback — see `app.py`'s own sanitized exception handlers and
`tests/test_app.py`'s coverage of this. The real detail of any internal
error is only ever printed to the notebook's own cell output (visible
only to you, in your own session), never sent over HTTP.

## Running it

### Colab Web
Open `ClearSpace_Image_Gen.ipynb` directly at
[colab.research.google.com](https://colab.research.google.com) (File >
Open notebook > GitHub, paste this repo's URL), set the three Secrets
(see above), then Runtime > Run all.

### VS Code Colab extension
Open the same notebook file through the extension, connect to a GPU
runtime, and run cells top to bottom — you'll be prompted (masked input)
for any secret the extension doesn't expose via `userdata`.

### Expected manual procedure (Phase 2)
1. Run all cells; the CUDA check fails fast if no GPU is attached.
2. Wait for the model-loading cell to finish (real download + GPU load
   — timing not yet measured for real; expect several minutes on first
   run for a fresh weights download).
3. The server-start cell starts uvicorn in a background thread, then
   **polls the local `/health` endpoint with a bounded number of short,
   sanitized retries** (never a fixed fire-and-hope wait) until it
   returns the full compatible `"ok"` body — a `{"status": "loading"}`
   response, or any other non-2xx/incomplete body, does not count, and
   polling continues through it until the poll budget is exhausted.
   **Only once that succeeds does the cell open the ngrok tunnel** and
   print the public URL alongside that `/health` body, nothing else —
   the public URL is never exposed for a service that isn't genuinely
   ready. A polling failure/timeout raises a clear, sanitized error
   rather than silently printing a URL for a service that isn't
   actually up yet.
4. Point the backend's own `.env` (`IMAGE_GEN_BASE_URL`) at that printed
   URL to test end to end.

## Cleanup and troubleshooting

**Closing the browser tab (or disconnecting the VS Code Colab extension)
is NOT sufficient cleanup on its own** — the Colab runtime, the uvicorn
server, and the ngrok tunnel can all keep running in the background
after the tab/connection closes. Always do this explicitly when you're
done testing:

1. **Stop the tunnel** — run the cleanup cell at the end of the notebook
   (commented out by default so `Run all` doesn't kill the service the
   moment it starts): uncomment and run `ngrok.disconnect(tunnel.public_url)`
   then `ngrok.kill()`.
2. **Terminate the Colab runtime itself**:
   - **Colab Web**: `Runtime > Manage sessions > Terminate`.
   - **VS Code Colab extension**: use the extension's own **"Colab:
     Remove Server"** command (Command Palette) — this is the
     extension-specific equivalent of terminating the runtime; closing
     the editor tab alone does not do this.

The server thread is a daemon thread and dies once the runtime is
genuinely terminated either way — but until you've done step 2, the
runtime (and therefore the exposed, unauthenticated tunnel) may still be
live even if no tab is open.

**Common failure points**: free-tier GPU unavailability (no client-side
fix — try again later or use Colab Pro); a dependency failing to
install/import cleanly in the real Colab environment (this is exactly
why local tests can't catch everything — see "What local tests do and
don't prove" below); ngrok auth/domain misconfiguration; Colab's
idle-disconnect ending a session mid-test.

## What local tests do and don't prove

`colab_service/tests/` (run via `python -m pytest colab_service/tests`
from the repo root) verify the contract, validation, concurrency, and
error-sanitization logic entirely with fakes — **no GPU, no model, no
network call, anywhere in that test suite.** They prove the HTTP layer
and request/response contract are correct. They cannot prove, and do not
claim to prove: that the configured model identifiers actually load,
that MiDaS's output is genuinely compatible with the ControlNet
checkpoint, that a real image comes out the other end, or that the
`prompt`/`negative_prompt` are genuinely used by the diffusion pipeline
(as opposed to just hashed-and-echoed correctly) — only real Colab
inference (Phase 2) can prove those.
