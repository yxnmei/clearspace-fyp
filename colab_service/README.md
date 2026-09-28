# ClearSpace Colab image-generation service

This directory contains the optional image-generation service behind
ClearSpace's **AI Visual Preview**. It runs Stable Diffusion 1.5 with depth
ControlNet and MiDaS on a Colab GPU, exposes a small FastAPI API, and is reached
by the ClearSpace backend through an ngrok tunnel.

The service has been verified end to end on a Colab T4 GPU: the models loaded,
the local and public health checks passed, generation completed, and the
frontend displayed the returned image. A bounded qualitative pilot found that
the whole-image pipeline does not reliably preserve individual items or place
them precisely. The preview is therefore **illustrative and optional**, not an
authoritative reorganisation plan. The Tidy Plan Checklist and Storage Ideas
remain available if image generation is unavailable or unsuitable.

## Architecture

The service is deployed independently from `backend/`:

```text
ClearSpace backend
  -> HTTPS request through ngrok
  -> Colab FastAPI service
  -> MiDaS depth extraction
  -> Stable Diffusion 1.5 + depth ControlNet
  -> generated preview image
```

Sending a photo for the AI Visual Preview crosses this remote-service boundary.
Other workflow processing remains local.

```text
colab_service/
  ClearSpace_Image_Gen.ipynb   Colab launcher
  app.py                       FastAPI endpoints and concurrency guard
  config.py                    Environment-backed service settings
  schemas.py                   Strict request and response schemas
  resolution.py                Deterministic resolution policy
  depth.py                     MiDaS depth extraction and alignment
  pipeline.py                  Model loading and generation
  requirements.txt             Colab-only dependencies
  tests/                       GPU-free service tests
```

The service deliberately does not import the main backend package, so it can be
cloned and launched independently in Colab. Its schemas mirror the contract in
`backend/app/models/image_gen_client.py`; the backend client is the authoritative
caller-side contract.

## API

### `GET /health`

The endpoint always returns HTTP 200. Once all models are ready, its compatible
success body is:

```json
{
  "status": "ok",
  "api_version": "v1",
  "service_version": "<non-blank>",
  "capabilities": { "depth_controlnet": true }
}
```

While models are loading it returns `{"status": "loading"}`. The backend treats
anything other than the complete success shape as unavailable.

### `POST /generate`

`schemas.py` defines the strict request and response fields. Extra fields are
rejected, image bytes must match the declared media type, and the response
includes hashes and generation provenance checked by the backend client.

Only one generation may run at a time. A concurrent request receives an
immediate HTTP 503 rather than being queued.

## Prerequisites

- A Colab runtime with a GPU attached. Select **Runtime > Change runtime type >
  GPU** before running the notebook.
- Sufficient Colab GPU quota. Free-tier availability varies.
- These three Colab secrets:

| Secret | Purpose |
|---|---|
| `GITHUB_TOKEN` | Clone the repository |
| `NGROK_AUTHTOKEN` | Authenticate ngrok |
| `NGROK_DOMAIN` | Bind the configured ngrok domain |

No secret values are stored in this repository.

## Running the service

### Colab Web

1. Open `ClearSpace_Image_Gen.ipynb` at
   [Google Colab](https://colab.research.google.com) using **File > Open
   notebook > GitHub**.
2. Open the Secrets panel using the key icon, add the three secrets above, and
   enable **Notebook access** for each.
3. Attach a GPU runtime and select **Runtime > Run all**.
4. Wait for model loading and both health checks to complete. The final startup
   cell prints the public ngrok URL only after the service is ready.
5. Set `IMAGE_GEN_BASE_URL` in `backend/.env` to the printed URL, then restart
   the backend.

### VS Code Colab extension

Open the same notebook, connect to a Colab GPU runtime, and run the cells from
top to bottom. If `google.colab.userdata` is unavailable, the notebook requests
missing secrets using masked prompts.

### Repository bootstrap

Every Colab session starts from an empty VM. The notebook clones
`https://github.com/yxnmei/clearspace-fyp.git` into
`/content/clearspace-fyp`. It refuses to reuse or replace an existing checkout;
restart the runtime for a clean run if that directory already exists.

For a private repository, the GitHub token is supplied to the clone process
through temporary process-local Git configuration. It is not embedded in the
remote URL or command arguments, and the token-bearing variables are cleared
after the clone attempt. The ngrok credentials are not passed to the Git
subprocess.

## Security and cleanup

The ngrok endpoint has **no application-level authentication**. Its unlisted URL
is not a strong security boundary. Use the service only while actively testing,
keep the URL private, and stop it immediately afterwards.

The service does not return raw tracebacks or include prompts, images, base64
payloads, tokens, or credential-bearing URLs in HTTP error messages. Internal
details remain in the private notebook output.

Closing a browser or editor tab does not necessarily stop the Colab runtime or
ngrok tunnel. When testing is complete:

1. Run the notebook's cleanup cell after uncommenting
   `ngrok.disconnect(tunnel.public_url)` and `ngrok.kill()`.
2. Terminate the runtime:
   - Colab Web: **Runtime > Manage sessions > Terminate**.
   - VS Code Colab extension: run **Colab: Remove Server** from the Command
     Palette.

## Configuration

The verified configuration uses:

- `stable-diffusion-v1-5/stable-diffusion-v1-5`;
- `lllyasviel/sd-controlnet-depth`;
- `lllyasviel/Annotators` through `controlnet_aux.MidasDetector`;
- a 512 x 512 pixel budget;
- 30 inference steps and guidance scale 7.5;
- attention slicing and VAE slicing when supported;
- the pipeline's safety checker retained;
- no `xformers` dependency by default.

The backend's default request settings are `denoise_strength=0.35` and
`controlnet_conditioning_scale=1.0`. These are implementation defaults, not
quality-optimal values established by the pilot.

`resolution.py` selects multiple-of-eight dimensions within the pixel budget
while minimising aspect-ratio deviation. It does not crop or rotate the image.
Rounding can introduce a small non-uniform rescale, so exact aspect-ratio
preservation is not claimed.

The dependencies in `requirements.txt` remain unpinned because the complete
resolved package set from the verified Colab run was not recorded. The working
run used `diffusers` 0.40.0, but that alone is not a reproducible environment
specification. Future Colab dependency changes may therefore require
compatibility testing.

## Verified evidence and limitations

During the initial real Colab run, MiDaS returned a depth map whose dimensions
did not match the resized generation image, causing ControlNet to reject the
request. `extract_depth_map()` now aligns the depth map to the image using one
bilinear resize when their sizes differ. The corrected implementation passed
the service tests and was subsequently verified through the real frontend.

The separate quality pilot used one room image and a small set of parameter
settings. It was qualitative, not a benchmark:

- The backend defaults largely preserved the room but produced little visible
  reorganisation.
- Higher denoising produced more visible change but also hallucinated or
  distorted furniture, openings, decorations, text, and other objects.
- Shorter prompts did not remove the problem, so prompt length was not the sole
  cause.

This evidence supports treating the preview as illustrative. The current input
contains neither object masks nor target-position geometry, so the pipeline
cannot guarantee item preservation or precise relocation. Masked editing and
target-position planning would require a separate evaluated architecture; they
are not implemented behaviour.

Generation completed within the backend's 180-second timeout in the verified
run, but one run does not establish a general latency bound. Safety-checker
false positives, broader prompt sensitivity, other Colab GPU types, and
general output fidelity were not measured.

If generation fails, ClearSpace returns the completed text outputs with
`image_status="unavailable"`. The optional image does not block workflow
completion.

## Tests

From the repository root:

```bash
python -m pytest colab_service/tests -q
```

The tests use fakes and require no GPU, model weights, or network connection.
They verify validation, API contracts, concurrency, resolution logic, depth-map
alignment, and sanitised error handling. They do not establish that models load
in a current Colab environment or that generated images are useful. Those are
separate runtime and qualitative questions.

## Troubleshooting

- **No GPU available:** change the Colab runtime type or retry when quota is
  available.
- **Existing checkout:** restart the runtime; the notebook deliberately refuses
  to reuse `/content/clearspace-fyp`.
- **Clone failure:** check `GITHUB_TOKEN` and repository access.
- **Tunnel failure:** check `NGROK_AUTHTOKEN` and `NGROK_DOMAIN`.
- **Backend reports the preview unavailable:** confirm the notebook is still
  running, `/health` returns the complete compatible success body, and
  `IMAGE_GEN_BASE_URL` matches the current tunnel URL.
- **Session ends during generation:** restart the runtime and launch the service
  again; Colab sessions and tunnel URLs are temporary.
