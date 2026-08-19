"""
GPU-free tests for colab_service.depth.extract_depth_map() — no
controlnet_aux, no torch, no real MiDaS model anywhere in this file. A
fake detector (returning a fake depth-map object, never a real
PIL.Image.Image) is monkeypatched in, so load_depth_detector()'s own
real import path is never exercised here.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image

import colab_service.depth as depth


class FakeDepthMap:
    """Stands in for MidasDetector's own output. Records exactly how
    .resize() was called, if at all, rather than performing a real
    resize -- keeps these tests independent of Pillow's own resize
    behavior/version."""

    def __init__(self, size: tuple[int, int]) -> None:
        self.size = size
        self.resize_calls: list[tuple] = []

    def resize(self, size, resample=None):
        self.resize_calls.append((size, resample))
        return FakeDepthMap(size)


class RecordingFakeDetector:
    def __init__(self, result: FakeDepthMap) -> None:
        self.result = result
        self.calls: list[Image.Image] = []

    def __call__(self, image: Image.Image) -> FakeDepthMap:
        self.calls.append(image)
        return self.result


def _install_fake_detector(monkeypatch, result: FakeDepthMap) -> RecordingFakeDetector:
    fake = RecordingFakeDetector(result)
    monkeypatch.setattr(depth, "load_depth_detector", lambda model_id: fake)
    return fake


def test_mismatched_size_is_resized_to_the_image_size(monkeypatch):
    input_image = Image.new("RGB", (584, 440))
    fake_depth_map = FakeDepthMap((704, 512))
    _install_fake_detector(monkeypatch, fake_depth_map)

    result = depth.extract_depth_map(input_image, model_id="fake-midas")

    assert result.size == (584, 440)


def test_resize_uses_bilinear_resampling(monkeypatch):
    input_image = Image.new("RGB", (584, 440))
    fake_depth_map = FakeDepthMap((704, 512))
    _install_fake_detector(monkeypatch, fake_depth_map)

    depth.extract_depth_map(input_image, model_id="fake-midas")

    assert fake_depth_map.resize_calls == [((584, 440), Image.Resampling.BILINEAR)]


def test_matching_size_is_returned_by_identity_without_resize(monkeypatch):
    input_image = Image.new("RGB", (584, 440))
    fake_depth_map = FakeDepthMap((584, 440))
    _install_fake_detector(monkeypatch, fake_depth_map)

    result = depth.extract_depth_map(input_image, model_id="fake-midas")

    assert result is fake_depth_map
    assert fake_depth_map.resize_calls == []


def test_input_image_reaches_the_detector_unchanged(monkeypatch):
    input_image = Image.new("RGB", (584, 440), color=(7, 8, 9))
    fake_depth_map = FakeDepthMap((584, 440))
    fake = _install_fake_detector(monkeypatch, fake_depth_map)

    depth.extract_depth_map(input_image, model_id="fake-midas")

    assert len(fake.calls) == 1
    assert fake.calls[0] is input_image


def test_model_id_reaches_load_depth_detector_unchanged(monkeypatch):
    input_image = Image.new("RGB", (584, 440))
    fake_depth_map = FakeDepthMap((584, 440))
    fake = RecordingFakeDetector(fake_depth_map)

    received_model_ids: list[str] = []

    def _fake_loader(model_id: str):
        received_model_ids.append(model_id)
        return fake

    monkeypatch.setattr(depth, "load_depth_detector", _fake_loader)

    depth.extract_depth_map(input_image, model_id="real-midas-model-id")

    assert received_model_ids == ["real-midas-model-id"]


def test_importing_depth_does_not_load_controlnet_aux_or_torch():
    repo_root = Path(__file__).resolve().parents[2]
    code = (
        "import sys\n"
        "import colab_service.depth\n"
        "heavy = {'torch', 'controlnet_aux'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(repo_root))
    assert result.returncode == 0, result.stdout + result.stderr
