"""Lazy-loaded SD1.5 img2img and ControlNet-depth generation.

Heavy dependencies load only on explicit startup. Loaded model identifiers are
reported from runtime state. The base safety checker remains enabled; flagged
output is never returned. Prompt sensitivity is still untested. Output is PNG,
and generation timing includes depth extraction plus diffusion.
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
    """Safety-check failure that carries no prompt or generated content."""


def load_pipeline(settings: Any) -> None:
    """Load the verified CUDA pipeline once while retaining its safety checker."""
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
    # Use memory-saving defaults; xformers compatibility remains untested.
    pipe.enable_attention_slicing()
    # diffusers 0.40.0 lacked the pipeline-level VAE method in the verified
    # runtime. Prefer the VAE API, support the legacy API, and do not hide errors.
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
    """Generate a depth-conditioned PNG from a pre-sized RGB image.

    Prompts are forwarded exactly, but hashes do not prove semantic use;
    same-image/different-prompt sensitivity remains untested. Internal quality
    settings are not caller-controlled, and flagged output is never returned.
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

    # Check the retained safety result before reading image bytes.
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
