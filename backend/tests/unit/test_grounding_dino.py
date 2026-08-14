"""
Unit tests for app/models/grounding_dino.py — path resolution
(`_resolve_backend_path`) and the thin wrapper logic in `load_model()`/
`detect()` around the upstream `groundingdino` library.

Safe to import `app.models.grounding_dino` directly: only torch/numpy/PIL
are imported at module scope there (see test_analysis_service.py's own
note on why it avoids that for its Protocol-based fakes) — the
`groundingdino` package itself is lazily imported inside functions, and is
installed in this environment (used for real elsewhere), so importing its
submodules here to monkeypatch specific functions costs nothing.

No test loads model weights, runs Grounding DINO inference, or touches the
network: `groundingdino.util.inference.load_model`/`predict` are replaced
with fakes at the point `load_model()`/`detect()` import them; the real
`groundingdino.util.box_ops.box_cxcywh_to_xyxy` is used as-is (pure tensor
arithmetic, no weights, no I/O) to prove the conversion itself is correct.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import torch

from app.config import get_settings
from app.models import grounding_dino
from app.models.grounding_dino import _resolve_backend_path


@pytest.fixture(autouse=True)
def _reset_model_cache():
    """Every test starts and ends with an empty module-level cache, so a
    fake "loaded model" from one test can never leak into the next."""
    original = grounding_dino._model_cache
    grounding_dino._model_cache = None
    yield
    grounding_dino._model_cache = original


# --- path resolution ---------------------------------------------------


def test_relative_config_path_resolves_beneath_backend_root():
    resolved = _resolve_backend_path("weights/GroundingDINO_SwinT_OGC.py")

    assert resolved.is_absolute()
    assert resolved == grounding_dino._BACKEND_ROOT / "weights" / "GroundingDINO_SwinT_OGC.py"


def test_relative_weights_path_resolves_beneath_backend_root():
    resolved = _resolve_backend_path("weights/groundingdino_swint_ogc.pth")

    assert resolved.is_absolute()
    assert resolved == grounding_dino._BACKEND_ROOT / "weights" / "groundingdino_swint_ogc.pth"


@pytest.mark.parametrize("cwd_kind", ["backend_dir", "repo_root", "tmp_dir"])
def test_resolution_is_identical_regardless_of_process_cwd(monkeypatch, tmp_path, cwd_kind):
    backend_root = grounding_dino._BACKEND_ROOT
    cwd_by_kind = {
        "backend_dir": backend_root,
        "repo_root": backend_root.parent,
        "tmp_dir": tmp_path,
    }
    monkeypatch.chdir(cwd_by_kind[cwd_kind])

    resolved = _resolve_backend_path("weights/groundingdino_swint_ogc.pth")

    # Same result no matter what the process CWD is — the whole point of
    # resolving against this file's own location instead of os.getcwd().
    assert resolved == backend_root / "weights" / "groundingdino_swint_ogc.pth"


def test_absolute_configured_path_remains_absolute_and_unchanged(tmp_path):
    absolute = tmp_path / "somewhere" / "custom_weights.pth"

    resolved = _resolve_backend_path(str(absolute))

    assert resolved.is_absolute()
    assert resolved == absolute


def test_missing_files_raise_file_not_found_with_resolved_absolute_paths(monkeypatch):
    settings = get_settings().model_copy(
        update={
            "grounding_dino_config_path": "weights/does_not_exist.py",
            "grounding_dino_weights_path": "weights/does_not_exist.pth",
        }
    )
    monkeypatch.setattr(grounding_dino, "get_settings", lambda: settings)

    with pytest.raises(FileNotFoundError) as exc_info:
        grounding_dino.load_model()

    message = str(exc_info.value)
    expected_config = grounding_dino._BACKEND_ROOT / "weights" / "does_not_exist.py"
    expected_weights = grounding_dino._BACKEND_ROOT / "weights" / "does_not_exist.pth"
    assert str(expected_config) in message
    assert str(expected_weights) in message


# --- load_model() --------------------------------------------------------


def test_load_model_passes_resolved_paths_and_cpu_device_to_upstream_loader(monkeypatch):
    calls = []

    def fake_load_model(config_path, weights_path, device):
        calls.append({"config_path": config_path, "weights_path": weights_path, "device": device})
        return "fake-model-object"

    monkeypatch.setattr("groundingdino.util.inference.load_model", fake_load_model)

    result = grounding_dino.load_model()

    assert result == "fake-model-object"
    assert len(calls) == 1
    settings = get_settings()
    expected_config = str(_resolve_backend_path(settings.grounding_dino_config_path))
    expected_weights = str(_resolve_backend_path(settings.grounding_dino_weights_path))
    assert calls[0] == {"config_path": expected_config, "weights_path": expected_weights, "device": "cpu"}


def test_load_model_returns_cached_model_without_invoking_upstream_loader_again(monkeypatch):
    grounding_dino._model_cache = "already-loaded-model"

    def fail_if_called(*args, **kwargs):
        raise AssertionError("upstream load_model() must not be called when a cached model exists")

    monkeypatch.setattr("groundingdino.util.inference.load_model", fail_if_called)

    result = grounding_dino.load_model()

    assert result == "already-loaded-model"


# --- detect() --------------------------------------------------------


def _fake_image_bytes_loader(monkeypatch):
    """detect()'s own image preprocessing (_load_image_from_bytes) is not
    under test here — stub it so detect() tests focus purely on the
    prompt/threshold/device wiring and the box-conversion/pass-through
    logic, without depending on real image bytes or torchvision transforms."""
    sentinel_array = object()
    sentinel_tensor = object()
    monkeypatch.setattr(
        grounding_dino,
        "_load_image_from_bytes",
        lambda image_bytes: (sentinel_array, sentinel_tensor),
    )
    return sentinel_tensor


def test_detect_passes_prompt_thresholds_and_cpu_device_to_upstream_predict(monkeypatch):
    grounding_dino._model_cache = "fake-model-object"
    sentinel_tensor = _fake_image_bytes_loader(monkeypatch)
    calls = []

    def fake_predict(model, image, caption, box_threshold, text_threshold, device):
        calls.append(
            {
                "model": model,
                "image": image,
                "caption": caption,
                "box_threshold": box_threshold,
                "text_threshold": text_threshold,
                "device": device,
            }
        )
        return torch.empty((0, 4)), torch.empty((0,)), []

    monkeypatch.setattr("groundingdino.util.inference.predict", fake_predict)

    grounding_dino.detect(b"irrelevant-bytes", prompt="chair . lamp")

    assert len(calls) == 1
    settings = get_settings()
    assert calls[0] == {
        "model": "fake-model-object",
        "image": sentinel_tensor,
        "caption": "chair . lamp",
        "box_threshold": settings.detection_box_threshold,
        "text_threshold": settings.detection_text_threshold,
        "device": "cpu",
    }


def test_detect_converts_cxcywh_boxes_and_passes_through_labels_and_confidence(monkeypatch):
    grounding_dino._model_cache = "fake-model-object"
    _fake_image_bytes_loader(monkeypatch)

    # cx=0.5, cy=0.5, w=0.2, h=0.4 -> xyxy (0.4, 0.3, 0.6, 0.7)
    # cx=0.3, cy=0.6, w=0.1, h=0.2 -> xyxy (0.25, 0.5, 0.35, 0.7)
    boxes_cxcywh = torch.tensor([[0.5, 0.5, 0.2, 0.4], [0.3, 0.6, 0.1, 0.2]])
    logits = torch.tensor([0.91, 0.42])
    phrases = ["chair", "lamp"]

    def fake_predict(model, image, caption, box_threshold, text_threshold, device):
        return boxes_cxcywh, logits, phrases

    monkeypatch.setattr("groundingdino.util.inference.predict", fake_predict)

    result = grounding_dino.detect(b"irrelevant-bytes")

    assert len(result) == 2
    assert [item.label for item in result] == ["chair", "lamp"]
    assert [item.confidence for item in result] == pytest.approx([0.91, 0.42])
    assert result[0].box_xyxy == pytest.approx((0.4, 0.3, 0.6, 0.7))
    assert result[1].box_xyxy == pytest.approx((0.25, 0.5, 0.35, 0.7))


def test_detect_returns_empty_list_for_empty_model_output(monkeypatch):
    grounding_dino._model_cache = "fake-model-object"
    _fake_image_bytes_loader(monkeypatch)

    def fake_predict(model, image, caption, box_threshold, text_threshold, device):
        return torch.empty((0, 4)), torch.empty((0,)), []

    monkeypatch.setattr("groundingdino.util.inference.predict", fake_predict)

    result = grounding_dino.detect(b"irrelevant-bytes")

    assert result == []
