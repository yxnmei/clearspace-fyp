"""
Model loading (once, at real Colab notebook startup — see app.py's own
load_models()) and the actual SD1.5 img2img + ControlNet-depth generation
call. This is the ONE place a real GPU pipeline is ever invoked in this
service.

Every heavy import (torch, diffusers) is deferred to inside
load_pipeline()/run_generation() — NEVER at module import time. This is
what makes `import colab_service.pipeline` safe during local, GPU-free
tests: it never loads or downloads anything just by being imported (see
colab_service/tests/test_app.py's subprocess-based import check).
colab_service/tests/test_pipeline.py verifies this module's own
forwarding/safety logic against FAKE torch/diffusers modules injected
into sys.modules — never a real import, never a real model call.
app.py's own tests never call run_generation() for real either — they
monkeypatch colab_service.app's own reference to this function with a
fake before every test.

Model identifiers (config.base_model_id / controlnet_model_id) and the
diffusers pipeline class name below are PROVISIONAL — see
colab_service/README.md's "Provisional items requiring Phase 2
verification". This module reports whatever it ACTUALLY loaded
(_loaded_base_model_id/_loaded_controlnet_model_id), never a hardcoded
assumption that loading with the configured identifiers succeeded.

Safety checker: deliberately NOT disabled. `load_pipeline()` never passes
`safety_checker=None` — it keeps whichever safety checker the base model
ships with. If the pipeline itself reports the output as flagged
(`result.nsfw_content_detected`), run_generation() raises
UnsafeOutputError and NO image is returned — see that exception's own
docstring. Only concrete Phase 2 evidence that this is infeasible on a
T4's memory budget should reopen this decision; it is not reopened
speculatively here.

num_inference_steps/guidance_scale are internal, provisional generation
settings (config.py) — NOT part of the R3 HTTP contract (never a
schemas.GenerateRequest field) — passed straight through to the pipeline
call, same as denoise_strength/controlnet_conditioning_scale/seed.

Output format is always PNG (lossless, and schemas.build_generate_response()
is written assuming PNG — see that function's own docstring for why).
generation_ms measures depth extraction PLUS the pipeline call together
— the whole server-side compute after request validation, matching R7's
contract requirement that this be the honest end-to-end generation time,
not just the diffusion step count's own internal timing.
"""

from __future__ import annotations

import io
import time
from typing import Any, NamedTuple

from colab_service import depth as depth_module

_pipeline: Any = None
_loaded_base_model_id: str | None = None
_loaded_controlnet_model_id: str | None = None


class UnsafeOutputError(RuntimeError):
    """Raised when the diffusion pipeline's own safety checker flags the
    generated output as unsafe. Never carries the prompt, the image, or
    any other generated content in its message — app.py maps this to a
    sanitized error response, same discipline as every other failure
    path in this service (see app.py's own module docstring)."""


def load_pipeline(settings: Any) -> None:
    """Loads the SD1.5 + ControlNet-depth pipeline ONCE (module-level
    cache, mirrors backend/app/models/grounding_dino.py's own
    convention) and moves it to CUDA. Real, heavy, network-fetching
    model load, called only by the notebook launcher after CUDA is
    confirmed available (see module docstring for why importing this
    module never triggers it on its own). Idempotent: a second call is
    a no-op if a pipeline is already loaded.

    Deliberately does NOT pass safety_checker=None — see module
    docstring's "Safety checker" section.

    PROVISIONAL (see module docstring): the exact diffusers pipeline
    class, its constructor kwargs, and whether settings.base_model_id /
    settings.controlnet_model_id genuinely resolve on the real
    HuggingFace Hub all need Phase 2 confirmation on a real Colab GPU
    runtime — this function is written against the diffusers API as
    currently understood, not yet proven to work.
    """
    global _pipeline, _loaded_base_model_id, _loaded_controlnet_model_id
    if _pipeline is not None:
        return

    import torch
    from diffusers import ControlNetModel, StableDiffusionControlNetImg2ImgPipeline

    controlnet = ControlNetModel.from_pretrained(settings.controlnet_model_id, torch_dtype=torch.float16)
    pipe = StableDiffusionControlNetImg2ImgPipeline.from_pretrained(
        settings.base_model_id,
        controlnet=controlnet,
        torch_dtype=torch.float16,
    )
    pipe = pipe.to("cuda")
    # Memory-saving defaults for Colab's typically memory-constrained
    # GPUs (T4 free tier especially). xformers is deliberately NOT
    # enabled by default here — real version-compatibility risk against
    # Colab's pre-installed CUDA/torch stack, try-and-fallback is a Phase
    # 2 concern, not assumed to work in this first pass.
    pipe.enable_attention_slicing()
    # VAE slicing is an extra memory optimisation, not a safety or
    # correctness feature. StableDiffusionControlNetImg2ImgPipeline in
    # the installed diffusers 0.40.0 runtime did not expose the
    # pipeline-level enable_vae_slicing() method (verified on a real
    # Colab runtime); current diffusers exposes VAE slicing on the VAE
    # itself, as pipe.vae.enable_slicing(). Prefer that current
    # VAE-level API, fall back to the legacy pipeline-level method when
    # only it is present, and continue normally when neither exists (VAE
    # slicing is optional). Whichever method is selected is invoked
    # directly, with no surrounding try/except, so a genuine failure
    # inside it is never swallowed.
    vae_enable_slicing = getattr(getattr(pipe, "vae", None), "enable_slicing", None)
    legacy_enable_vae_slicing = getattr(pipe, "enable_vae_slicing", None)
    if callable(vae_enable_slicing):
        vae_enable_slicing()
    elif callable(legacy_enable_vae_slicing):
        legacy_enable_vae_slicing()

    _pipeline = pipe
    _loaded_base_model_id = settings.base_model_id
    _loaded_controlnet_model_id = settings.controlnet_model_id


class GenerationOutput(NamedTuple):
    image_bytes: bytes
    generation_ms: float
    base_model: str
    controlnet_model: str


def run_generation(
    *,
    image: Any,
    prompt: str,
    negative_prompt: str | None,
    denoise_strength: float,
    controlnet_conditioning_scale: float,
    seed: int,
    settings: Any,
) -> GenerationOutput:
    """Runs depth extraction + the SD1.5 img2img/ControlNet-depth call
    and returns the encoded PNG output plus timing/identity metadata.

    `image` must already be RGB and already resized (Image.Resampling.LANCZOS
    — see app.py's own generate() handler) to the target generation
    resolution (resolution.compute_target_resolution()) — see
    depth.extract_depth_map()'s own docstring for why that ordering
    matters. `prompt`/`negative_prompt` are passed through to the
    pipeline EXACTLY as received — never replaced, never defaulted (the
    exact v1 regression this service must not repeat). Neither this nor
    the accompanying prompt_sha256 echo by themselves PROVE the pipeline
    genuinely uses the prompt semantically (as opposed to merely
    accepting and hashing it) — only a real same-image/different-prompt
    sensitivity test, run in Phase 2, can prove that.

    num_inference_steps/guidance_scale come from `settings` (internal,
    provisional generation settings — see config.py and module
    docstring), never from the caller's own request.

    Raises UnsafeOutputError (never returning the image) if the
    pipeline's own safety checker flags the output — see that
    exception's own docstring.

    Raises RuntimeError if called before load_pipeline() has genuinely
    loaded a pipeline — a programming-error guard, not a request-input
    validation (that already happened in schemas.py before this
    function is ever reached).
    """
    if _pipeline is None:
        raise RuntimeError("run_generation() called before load_pipeline() — no pipeline is loaded")

    import torch

    t0 = time.perf_counter()

    depth_map = depth_module.extract_depth_map(image, model_id=settings.midas_model_id)

    generator = torch.Generator(device="cuda").manual_seed(seed)
    result = _pipeline(
        prompt=prompt,
        negative_prompt=negative_prompt,
        image=image,
        control_image=depth_map,
        strength=denoise_strength,
        controlnet_conditioning_scale=controlnet_conditioning_scale,
        num_inference_steps=settings.num_inference_steps,
        guidance_scale=settings.guidance_scale,
        generator=generator,
    )

    # The base pipeline's own safety checker (never disabled — see
    # load_pipeline()) reports this per-image; check it BEFORE ever
    # touching result.images for encoding, so a flagged output is never
    # even read into bytes, let alone returned.
    nsfw_flags = getattr(result, "nsfw_content_detected", None)
    if nsfw_flags and nsfw_flags[0]:
        raise UnsafeOutputError("generated output was flagged by the pipeline's safety checker")

    output_image = result.images[0]

    generation_ms = (time.perf_counter() - t0) * 1000.0

    buf = io.BytesIO()
    output_image.save(buf, format="PNG")

    return GenerationOutput(
        image_bytes=buf.getvalue(),
        generation_ms=generation_ms,
        base_model=_loaded_base_model_id,
        controlnet_model=_loaded_controlnet_model_id,
    )
