"""
GPU-free tests for colab_service.pipeline — real torch/diffusers/
controlnet_aux are NEVER imported or installed for these tests. Fake
`torch`/`diffusers` modules are injected directly into sys.modules
before load_pipeline()/run_generation() run, so pipeline.py's own
deferred `import torch` / `from diffusers import ...` statements resolve
to the fakes below instead of attempting a real import — this is what
lets this file verify pipeline.py's own forwarding/safety logic without
the real packages present at all (see pipeline.py's own module
docstring for why every heavy import is deferred to inside these
functions in the first place).

colab_service.depth.extract_depth_map is monkeypatched directly rather
than faked via controlnet_aux — depth.py's own tests (implicitly, by
being exercised elsewhere) are not this file's concern; this file only
verifies what pipeline.py itself does with whatever depth map it gets
back.
"""

from __future__ import annotations

import sys
import types
from typing import NamedTuple

import pytest
from PIL import Image
from pydantic import ValidationError

import colab_service.depth as depth_module
import colab_service.pipeline as pipeline


class FakeSettings(NamedTuple):
    base_model_id: str = "fake-base-model"
    controlnet_model_id: str = "fake-controlnet-model"
    midas_model_id: str = "fake-midas-model"
    num_inference_steps: int = 30
    guidance_scale: float = 7.5


class FakeGenerator:
    """Matches torch.Generator's own chainable-manual_seed() shape."""

    def __init__(self, device: str | None = None) -> None:
        self.device = device
        self.seed: int | None = None

    def manual_seed(self, seed: int) -> "FakeGenerator":
        self.seed = seed
        return self


class FakePipelineOutput:
    def __init__(self, images: list, nsfw_content_detected: list[bool] | None = None) -> None:
        self.images = images
        self.nsfw_content_detected = nsfw_content_detected


class FakeControlNetModel:
    def __init__(self, model_id: str, torch_dtype: object) -> None:
        self.model_id = model_id
        self.torch_dtype = torch_dtype

    @classmethod
    def from_pretrained(cls, model_id: str, torch_dtype: object = None) -> "FakeControlNetModel":
        return cls(model_id, torch_dtype)


class FakeSDPipeline:
    """Records every call for assertion. `calls` is populated on the
    class returned by from_pretrained() (the actual constructed
    instance), never the class itself, so multiple independently-loaded
    fake pipelines never share call history."""

    def __init__(self, base_model_id: str, controlnet: FakeControlNetModel, **extra_kwargs) -> None:
        self.base_model_id = base_model_id
        self.controlnet = controlnet
        self.extra_kwargs = extra_kwargs
        self.to_calls: list[str] = []
        self.sliced: list[str] = []
        self.calls: list[dict] = []
        self._call_result: FakePipelineOutput | None = None
        self._call_exception: Exception | None = None

    def to(self, device: str) -> "FakeSDPipeline":
        self.to_calls.append(device)
        return self

    def enable_attention_slicing(self) -> None:
        self.sliced.append("attention")

    def enable_vae_slicing(self) -> None:
        self.sliced.append("vae")

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self._call_exception is not None:
            raise self._call_exception
        if self._call_result is not None:
            return self._call_result
        img = Image.new("RGB", (8, 8), color=(1, 2, 3))
        return FakePipelineOutput(images=[img], nsfw_content_detected=[False])


def _install_fake_torch_and_diffusers(monkeypatch, *, sd_pipeline_instance: FakeSDPipeline | None = None):
    """Injects fake `torch` and `diffusers` modules into sys.modules —
    pipeline.py's own deferred imports resolve to these, never a real
    package. Returns the fake SD pipeline INSTANCE that
    load_pipeline()/from_pretrained() will produce and cache, so tests
    can pre-arm its __call__ behavior before load_pipeline() runs."""
    fake_torch = types.ModuleType("torch")
    fake_torch.float16 = "float16-marker"
    fake_torch.Generator = FakeGenerator

    fake_diffusers = types.ModuleType("diffusers")
    fake_diffusers.ControlNetModel = FakeControlNetModel

    instance_holder: dict[str, FakeSDPipeline] = {}

    class _FakeSDPipelineClass:
        @classmethod
        def from_pretrained(cls, base_model_id, controlnet=None, torch_dtype=None, **kwargs):
            # The safety checker must never be disabled -- a caller
            # passing safety_checker=None would silently remove the one
            # guard against returning a flagged/unsafe generated image.
            assert "safety_checker" not in kwargs, "safety_checker must never be passed (never disabled)"
            instance = sd_pipeline_instance or FakeSDPipeline(base_model_id, controlnet, **kwargs)
            instance_holder["instance"] = instance
            return instance

    fake_diffusers.StableDiffusionControlNetImg2ImgPipeline = _FakeSDPipelineClass

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "diffusers", fake_diffusers)

    return fake_torch, fake_diffusers, instance_holder


@pytest.fixture(autouse=True)
def _reset_pipeline_module_state():
    """pipeline.py caches _pipeline/_loaded_base_model_id/_loaded_controlnet_model_id
    at module level — every test starts from a clean, unloaded state."""
    pipeline._pipeline = None
    pipeline._loaded_base_model_id = None
    pipeline._loaded_controlnet_model_id = None
    yield
    pipeline._pipeline = None
    pipeline._loaded_base_model_id = None
    pipeline._loaded_controlnet_model_id = None


def _load_with_fake_pipeline(monkeypatch, *, sd_pipeline_instance: FakeSDPipeline | None = None) -> FakeSDPipeline:
    _install_fake_torch_and_diffusers(monkeypatch, sd_pipeline_instance=sd_pipeline_instance)
    pipeline.load_pipeline(FakeSettings())
    return pipeline._pipeline


def _fake_depth_map():
    return Image.new("RGB", (8, 8), color=(9, 9, 9))


# ---------------------------------------------------------------------------
# load_pipeline — safety checker never disabled, loaded once, reports actual identifiers
# ---------------------------------------------------------------------------


def test_load_pipeline_never_disables_the_safety_checker(monkeypatch):
    # The assertion inside _FakeSDPipelineClass.from_pretrained() itself
    # does the real check — this test just proves load_pipeline() runs
    # cleanly through it (would raise AssertionError otherwise).
    _load_with_fake_pipeline(monkeypatch)


def test_load_pipeline_sets_module_state(monkeypatch):
    settings = FakeSettings(base_model_id="real-base", controlnet_model_id="real-controlnet")
    _install_fake_torch_and_diffusers(monkeypatch)
    pipeline.load_pipeline(settings)
    assert pipeline._loaded_base_model_id == "real-base"
    assert pipeline._loaded_controlnet_model_id == "real-controlnet"
    assert pipeline._pipeline is not None


def test_load_pipeline_is_idempotent(monkeypatch):
    calls = {"from_pretrained": 0}
    fake_torch = types.ModuleType("torch")
    fake_torch.float16 = "float16-marker"
    fake_torch.Generator = FakeGenerator
    fake_diffusers = types.ModuleType("diffusers")
    fake_diffusers.ControlNetModel = FakeControlNetModel

    class _CountingFakeSDPipelineClass:
        @classmethod
        def from_pretrained(cls, base_model_id, controlnet=None, torch_dtype=None, **kwargs):
            calls["from_pretrained"] += 1
            return FakeSDPipeline(base_model_id, controlnet)

    fake_diffusers.StableDiffusionControlNetImg2ImgPipeline = _CountingFakeSDPipelineClass
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "diffusers", fake_diffusers)

    pipeline.load_pipeline(FakeSettings())
    pipeline.load_pipeline(FakeSettings())  # second call must be a no-op

    assert calls["from_pretrained"] == 1


# ---------------------------------------------------------------------------
# load_pipeline — VAE slicing: current pipe.vae.enable_slicing() API,
# legacy pipe.enable_vae_slicing() fallback, optional when neither exists
# ---------------------------------------------------------------------------


class _FakeVae:
    """Minimal VAE exposing the current diffusers VAE-level slicing API
    (pipe.vae.enable_slicing()). Records the call into a shared list so a
    test can assert exactly which slicing path load_pipeline() took."""

    def __init__(self, record: list, *, raises: bool = False) -> None:
        self._record = record
        self._raises = raises

    def enable_slicing(self) -> None:
        if self._raises:
            raise RuntimeError("vae.enable_slicing blew up for a real reason")
        self._record.append("vae.enable_slicing")


class _FakePipelineBase:
    """Shared shape: chainable to('cuda') plus recorded attention slicing."""

    def __init__(self) -> None:
        self.to_calls: list[str] = []
        self.sliced: list[str] = []

    def to(self, device: str) -> "_FakePipelineBase":
        self.to_calls.append(device)
        return self

    def enable_attention_slicing(self) -> None:
        self.sliced.append("attention")


class _FakePipelineCurrentVaeApi(_FakePipelineBase):
    """Current diffusers shape: VAE slicing lives on the VAE
    (pipe.vae.enable_slicing()). Also carries the legacy pipeline-level
    enable_vae_slicing() so a test can prove the current API is
    preferred over it."""

    def __init__(self, *, vae_raises: bool = False) -> None:
        super().__init__()
        self.vae = _FakeVae(self.sliced, raises=vae_raises)

    def enable_vae_slicing(self) -> None:
        self.sliced.append("legacy.enable_vae_slicing")


class _FakePipelineLegacyVaeApi(_FakePipelineBase):
    """No VAE-level enable_slicing(); only the legacy pipeline-level
    enable_vae_slicing()."""

    def __init__(self, *, raises: bool = False) -> None:
        super().__init__()
        self._raises = raises

    def enable_vae_slicing(self) -> None:
        if self._raises:
            raise RuntimeError("legacy enable_vae_slicing blew up for a real reason")
        self.sliced.append("legacy.enable_vae_slicing")


class _FakePipelineNoVaeSlicing(_FakePipelineBase):
    """A DEFENSIVE compatibility case: a pipeline exposing neither the
    current pipe.vae.enable_slicing() nor the legacy pipeline-level
    enable_vae_slicing(). This shape was NOT observed in the installed
    diffusers 0.40.0 runtime — there pipe.vae.enable_slicing() existed
    and worked, and only the pipeline-level enable_vae_slicing() was
    absent. It is covered so a future build missing both APIs still
    loads: VAE slicing is optional, so loading must still succeed with
    attention slicing enabled."""


def test_load_pipeline_prefers_the_current_vae_level_slicing_api(monkeypatch):
    # Current diffusers exposes VAE slicing as pipe.vae.enable_slicing();
    # it must be used, and the legacy pipeline-level method must NOT also
    # be called.
    fake = _FakePipelineCurrentVaeApi()
    _install_fake_torch_and_diffusers(monkeypatch, sd_pipeline_instance=fake)

    pipeline.load_pipeline(FakeSettings())

    assert pipeline._pipeline is fake
    assert fake.sliced == ["attention", "vae.enable_slicing"]


def test_load_pipeline_falls_back_to_legacy_enable_vae_slicing(monkeypatch):
    # When the current pipe.vae.enable_slicing() API is unavailable, the
    # legacy pipeline-level enable_vae_slicing() is used instead.
    fake = _FakePipelineLegacyVaeApi()
    _install_fake_torch_and_diffusers(monkeypatch, sd_pipeline_instance=fake)

    pipeline.load_pipeline(FakeSettings())

    assert pipeline._pipeline is fake
    assert fake.sliced == ["attention", "legacy.enable_vae_slicing"]


def test_load_pipeline_without_any_vae_slicing_api_still_loads(monkeypatch):
    # DEFENSIVE case, not the observed diffusers 0.40.0 shape: a pipeline
    # exposing neither pipe.vae.enable_slicing() nor
    # pipe.enable_vae_slicing(). (In the verified 0.40.0 runtime
    # pipe.vae.enable_slicing() existed and worked; only the
    # pipeline-level method was absent.) Loading must still succeed with
    # attention slicing enabled.
    fake = _FakePipelineNoVaeSlicing()
    _install_fake_torch_and_diffusers(monkeypatch, sd_pipeline_instance=fake)

    pipeline.load_pipeline(FakeSettings())  # must not raise

    assert pipeline._pipeline is fake
    assert fake.to_calls == ["cuda"]
    assert fake.sliced == ["attention"]
    assert not hasattr(fake, "vae")
    assert not hasattr(fake, "enable_vae_slicing")


def test_load_pipeline_does_not_swallow_a_failing_current_vae_slicing_call(monkeypatch):
    # The SELECTED API (here the preferred pipe.vae.enable_slicing()) is
    # invoked directly: a genuine error inside it must propagate, and no
    # partially initialised pipeline may be cached as loaded.
    fake = _FakePipelineCurrentVaeApi(vae_raises=True)
    _install_fake_torch_and_diffusers(monkeypatch, sd_pipeline_instance=fake)

    with pytest.raises(RuntimeError, match="vae.enable_slicing blew up"):
        pipeline.load_pipeline(FakeSettings())

    assert pipeline._pipeline is None


def test_load_pipeline_does_not_swallow_a_failing_legacy_vae_slicing_call(monkeypatch):
    # Same rule for the fallback path: a legacy enable_vae_slicing() that
    # exists but raises must propagate, leaving no cached pipeline.
    fake = _FakePipelineLegacyVaeApi(raises=True)
    _install_fake_torch_and_diffusers(monkeypatch, sd_pipeline_instance=fake)

    with pytest.raises(RuntimeError, match="legacy enable_vae_slicing blew up"):
        pipeline.load_pipeline(FakeSettings())

    assert pipeline._pipeline is None


# ---------------------------------------------------------------------------
# run_generation — exact forwarding
# ---------------------------------------------------------------------------


def test_run_generation_forwards_exact_prompt_negative_prompt(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "load_depth_detector", lambda model_id: object())
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    pipeline.run_generation(
        image=Image.new("RGB", (8, 8)),
        prompt="a cosy bedroom",
        negative_prompt="blurry, dark",
        denoise_strength=0.4,
        controlnet_conditioning_scale=1.3,
        seed=7,
        settings=FakeSettings(),
    )

    assert len(fake_pipeline_instance.calls) == 1
    call = fake_pipeline_instance.calls[0]
    assert call["prompt"] == "a cosy bedroom"
    assert call["negative_prompt"] == "blurry, dark"


def test_run_generation_forwards_seed_strength_scale_steps_guidance(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    settings = FakeSettings(num_inference_steps=42, guidance_scale=9.0)
    pipeline.run_generation(
        image=Image.new("RGB", (8, 8)),
        prompt="a bedroom",
        negative_prompt=None,
        denoise_strength=0.55,
        controlnet_conditioning_scale=1.75,
        seed=123,
        settings=settings,
    )

    call = fake_pipeline_instance.calls[0]
    assert call["strength"] == 0.55
    assert call["controlnet_conditioning_scale"] == 1.75
    assert call["num_inference_steps"] == 42
    assert call["guidance_scale"] == 9.0
    assert call["generator"].seed == 123


def test_run_generation_forwards_the_image_and_depth_map(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    depth_map = _fake_depth_map()
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: depth_map)

    input_image = Image.new("RGB", (16, 16), color=(5, 6, 7))
    pipeline.run_generation(
        image=input_image,
        prompt="a bedroom",
        negative_prompt=None,
        denoise_strength=0.4,
        controlnet_conditioning_scale=1.0,
        seed=1,
        settings=FakeSettings(),
    )

    call = fake_pipeline_instance.calls[0]
    assert call["image"] is input_image
    assert call["control_image"] is depth_map


def test_run_generation_never_replaces_prompt_with_a_default(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    pipeline.run_generation(
        image=Image.new("RGB", (8, 8)),
        prompt="this exact prompt must reach the pipeline unchanged",
        negative_prompt=None,
        denoise_strength=0.4,
        controlnet_conditioning_scale=1.0,
        seed=1,
        settings=FakeSettings(),
    )

    assert fake_pipeline_instance.calls[0]["prompt"] == "this exact prompt must reach the pipeline unchanged"


# ---------------------------------------------------------------------------
# run_generation — unsafe output
# ---------------------------------------------------------------------------


def test_run_generation_rejects_unsafe_output(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    fake_pipeline_instance._call_result = FakePipelineOutput(
        images=[Image.new("RGB", (8, 8))], nsfw_content_detected=[True]
    )
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    with pytest.raises(pipeline.UnsafeOutputError):
        pipeline.run_generation(
            image=Image.new("RGB", (8, 8)),
            prompt="a prompt that must never appear in the error",
            negative_prompt=None,
            denoise_strength=0.4,
            controlnet_conditioning_scale=1.0,
            seed=1,
            settings=FakeSettings(),
        )


def test_unsafe_output_error_never_contains_the_prompt(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    fake_pipeline_instance._call_result = FakePipelineOutput(
        images=[Image.new("RGB", (8, 8))], nsfw_content_detected=[True]
    )
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    secret_prompt = "a prompt that must never leak into any error message"
    with pytest.raises(pipeline.UnsafeOutputError) as exc_info:
        pipeline.run_generation(
            image=Image.new("RGB", (8, 8)),
            prompt=secret_prompt,
            negative_prompt=None,
            denoise_strength=0.4,
            controlnet_conditioning_scale=1.0,
            seed=1,
            settings=FakeSettings(),
        )
    assert secret_prompt not in str(exc_info.value)


def test_run_generation_valid_output_is_not_flagged(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    fake_pipeline_instance._call_result = FakePipelineOutput(
        images=[Image.new("RGB", (8, 8))], nsfw_content_detected=[False]
    )
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    result = pipeline.run_generation(
        image=Image.new("RGB", (8, 8)),
        prompt="a safe prompt",
        negative_prompt=None,
        denoise_strength=0.4,
        controlnet_conditioning_scale=1.0,
        seed=1,
        settings=FakeSettings(),
    )
    assert result.image_bytes


def test_run_generation_tolerates_a_missing_nsfw_attribute(monkeypatch):
    # Some pipeline configurations may not set nsfw_content_detected at
    # all (e.g. no safety checker configured on the loaded checkpoint) —
    # must not crash, must not treat missing as unsafe.
    fake_pipeline_instance = FakeSDPipeline("base", None)
    fake_pipeline_instance._call_result = FakePipelineOutput(images=[Image.new("RGB", (8, 8))], nsfw_content_detected=None)
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    result = pipeline.run_generation(
        image=Image.new("RGB", (8, 8)),
        prompt="a safe prompt",
        negative_prompt=None,
        denoise_strength=0.4,
        controlnet_conditioning_scale=1.0,
        seed=1,
        settings=FakeSettings(),
    )
    assert result.image_bytes


# ---------------------------------------------------------------------------
# run_generation — output becomes PNG, identity/timing metadata
# ---------------------------------------------------------------------------


def test_run_generation_output_is_valid_png(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    import io

    result = pipeline.run_generation(
        image=Image.new("RGB", (8, 8)),
        prompt="a bedroom",
        negative_prompt=None,
        denoise_strength=0.4,
        controlnet_conditioning_scale=1.0,
        seed=1,
        settings=FakeSettings(),
    )

    decoded = Image.open(io.BytesIO(result.image_bytes))
    assert decoded.format == "PNG"


def test_run_generation_reports_actual_loaded_model_identifiers(monkeypatch):
    settings = FakeSettings(base_model_id="loaded-base", controlnet_model_id="loaded-controlnet")
    fake_pipeline_instance = FakeSDPipeline("base", None)
    _install_fake_torch_and_diffusers(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    pipeline.load_pipeline(settings)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    result = pipeline.run_generation(
        image=Image.new("RGB", (8, 8)),
        prompt="a bedroom",
        negative_prompt=None,
        denoise_strength=0.4,
        controlnet_conditioning_scale=1.0,
        seed=1,
        settings=settings,
    )

    assert result.base_model == "loaded-base"
    assert result.controlnet_model == "loaded-controlnet"


def test_run_generation_reports_nonnegative_timing(monkeypatch):
    fake_pipeline_instance = FakeSDPipeline("base", None)
    _load_with_fake_pipeline(monkeypatch, sd_pipeline_instance=fake_pipeline_instance)
    monkeypatch.setattr(depth_module, "extract_depth_map", lambda image, model_id: _fake_depth_map())

    result = pipeline.run_generation(
        image=Image.new("RGB", (8, 8)),
        prompt="a bedroom",
        negative_prompt=None,
        denoise_strength=0.4,
        controlnet_conditioning_scale=1.0,
        seed=1,
        settings=FakeSettings(),
    )
    assert result.generation_ms >= 0.0


def test_run_generation_raises_before_load_pipeline():
    with pytest.raises(RuntimeError):
        pipeline.run_generation(
            image=Image.new("RGB", (8, 8)),
            prompt="a bedroom",
            negative_prompt=None,
            denoise_strength=0.4,
            controlnet_conditioning_scale=1.0,
            seed=1,
            settings=FakeSettings(),
        )


# ---------------------------------------------------------------------------
# Import safety — no real torch/diffusers/controlnet_aux import or model call
# ---------------------------------------------------------------------------


def test_importing_pipeline_does_not_load_torch_or_diffusers():
    import subprocess
    import sys as _sys
    from pathlib import Path

    repo_root = Path(__file__).resolve().parents[2]
    code = (
        "import sys\n"
        "import colab_service.pipeline\n"
        "heavy = {'torch', 'diffusers', 'controlnet_aux'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
        "assert colab_service.pipeline._pipeline is None\n"
    )
    result = subprocess.run([_sys.executable, "-c", code], capture_output=True, text=True, cwd=str(repo_root))
    assert result.returncode == 0, result.stdout + result.stderr


# ---------------------------------------------------------------------------
# config.py — num_inference_steps / guidance_scale validation
# ---------------------------------------------------------------------------


def test_config_accepts_default_generation_settings():
    from colab_service.config import Settings

    settings = Settings()
    assert settings.num_inference_steps == 30
    assert settings.guidance_scale == 7.5


@pytest.mark.parametrize("bad_steps", [0, -1, 151])
def test_config_rejects_out_of_range_num_inference_steps(bad_steps):
    from colab_service.config import Settings

    with pytest.raises(ValidationError):
        Settings(num_inference_steps=bad_steps)


@pytest.mark.parametrize("bad_scale", [0.0, -1.0, 30.1])
def test_config_rejects_out_of_range_guidance_scale(bad_scale):
    from colab_service.config import Settings

    with pytest.raises(ValidationError):
        Settings(guidance_scale=bad_scale)


def test_generation_settings_are_not_part_of_the_response_contract():
    # Internal service settings only -- never an R3 HTTP-contract field.
    from colab_service.schemas import RESPONSE_KEYS

    assert "num_inference_steps" not in RESPONSE_KEYS
    assert "guidance_scale" not in RESPONSE_KEYS
