"""
Tests for evaluation/scripts/batch_eval.py's composition logic and its
lazy-import boundary.

Importing evaluation.scripts.batch_eval must never pull in torch, CLIP,
Grounding DINO, or ollama — those are only lazy-imported inside
_default_scene_classifier/_default_detector/_default_llm_classifier,
which only run when run_batch() is called WITHOUT injected fakes. Every
functional test below injects fakes explicitly and therefore never
touches those lazy-loading branches at all — real model *invocation* is
a separate, deliberately unverified runtime path in this environment,
which has no local Ollama or GPU.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from app.core.schemas import AiDecision, AnalysisResult, BoundingBox, DetectedItem, ItemValidity, SceneClassification
from app.services.declutter_service import DeclutterResult
from evaluation.scripts import batch_eval

_BACKEND_DIR = Path(__file__).resolve().parents[2]


def test_batch_eval_module_imports_cleanly():
    assert hasattr(batch_eval, "analyse_image")
    assert hasattr(batch_eval, "run_declutter")
    assert hasattr(batch_eval, "run_batch")
    assert hasattr(batch_eval, "_default_scene_classifier")
    assert hasattr(batch_eval, "_default_detector")
    assert hasattr(batch_eval, "_default_llm_classifier")


def test_importing_batch_eval_alone_does_not_load_heavy_model_stacks():
    # Subprocess, not an in-process sys.modules check: other test modules
    # in this same pytest run (test_mistral_llm.py, test_analysis_service
    # fixtures, etc.) may have already imported torch/ollama for unrelated
    # reasons, which would make an in-process check meaningless. A fresh
    # interpreter importing ONLY batch_eval is the real question here.
    code = (
        "import sys\n"
        "import evaluation.scripts.batch_eval\n"
        "heavy = {'torch', 'clip', 'app.models.grounding_dino', 'app.models.clip_scene', "
        "'app.models.mistral_llm', 'ollama'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr


def _fake_analysis(run_id: str) -> AnalysisResult:
    scene = SceneClassification(label="bedroom", confidence=0.9, all_scores={"bedroom": 0.9})
    item = DetectedItem(
        item_id="item_001",
        source_detection_index=0,
        raw_phrase="lamp",
        clean_label="lamp",
        box=BoundingBox(x1=0.1, y1=0.1, x2=0.3, y2=0.3),
        confidence=0.9,
        position="upper-left",
        relative_size="small",
    )
    return AnalysisResult(run_id=run_id, scene=scene, items=[item], warnings=[], stage_timings=[])


def _fake_declutter_result(run_id: str, decision: str) -> DeclutterResult:
    return DeclutterResult(
        run_id=run_id,
        expected_item_ids=["item_001"],
        ai_decisions=[AiDecision(item_id="item_001", decision=decision, reason="test")],
        unresolved_item_ids=[],
        item_validity={"item_001": ItemValidity.RAW_VALID},
        mapping_warnings=[],
        semantic_errors=[],
        recovery_failures=[],
        provenance_warnings=[],
        model_name="phi4-mini",
        prompt_version="v2",
        stage_timings=[],
    )


def _noop_scene_classifier(image_bytes):
    raise AssertionError("scene_classifier should never actually be called — analyse_image is faked")


def _noop_detector(image_bytes):
    raise AssertionError("detector should never actually be called — analyse_image is faked")


def _noop_llm_classifier(**kwargs):
    raise AssertionError("llm_classifier should never actually be called — run_declutter is faked")


def test_run_batch_composes_analyse_image_and_run_declutter(tmp_path, monkeypatch):
    image_path = tmp_path / "bedroom01.jpg"
    image_path.write_bytes(b"not a real image, just needs to exist")

    calls = {"analyse_image": 0, "run_declutter": 0}

    def fake_analyse_image(image_bytes, run_id, scene_classifier, detector):
        calls["analyse_image"] += 1
        # The exact injected callables reach analyse_image unmodified —
        # proves run_batch wires the caller's injected dependencies
        # through, not a reimplementation of its own.
        assert scene_classifier is _noop_scene_classifier
        assert detector is _noop_detector
        return _fake_analysis(run_id)

    def fake_run_declutter(analysis, user_context, llm_classifier, model_name=None):
        calls["run_declutter"] += 1
        assert llm_classifier is _noop_llm_classifier
        assert user_context is None
        return _fake_declutter_result(analysis.run_id, "keep")

    monkeypatch.setattr(batch_eval, "analyse_image", fake_analyse_image)
    monkeypatch.setattr(batch_eval, "run_declutter", fake_run_declutter)

    labels = [{"filename": "bedroom01.jpg", "room_type": "bedroom"}]
    report = batch_eval.run_batch(
        labels,
        tmp_path,
        scene_classifier=_noop_scene_classifier,
        detector=_noop_detector,
        llm_classifier=_noop_llm_classifier,
    )

    assert calls == {"analyse_image": 1, "run_declutter": 1}
    assert report["decision_distribution"] == {"keep": 1.0}
    assert report["per_image_results"][0]["result"]["expected_item_ids"] == ["item_001"]


def test_run_batch_model_name_reaches_run_declutter(tmp_path, monkeypatch):
    image_path = tmp_path / "bedroom01.jpg"
    image_path.write_bytes(b"placeholder")

    seen_model_names = []

    monkeypatch.setattr(batch_eval, "analyse_image", lambda image_bytes, run_id, sc, det: _fake_analysis(run_id))

    def fake_run_declutter(analysis, user_context, llm_classifier, model_name=None):
        seen_model_names.append(model_name)
        return _fake_declutter_result(analysis.run_id, "keep")

    monkeypatch.setattr(batch_eval, "run_declutter", fake_run_declutter)

    labels = [{"filename": "bedroom01.jpg", "room_type": "bedroom"}]
    batch_eval.run_batch(
        labels,
        tmp_path,
        model_name="qwen3:8b",
        scene_classifier=_noop_scene_classifier,
        detector=_noop_detector,
        llm_classifier=_noop_llm_classifier,
    )

    assert seen_model_names == ["qwen3:8b"]


def test_run_batch_records_error_per_image_without_aborting_the_batch(tmp_path, monkeypatch):
    good_path = tmp_path / "good.jpg"
    good_path.write_bytes(b"placeholder")
    # "missing.jpg" deliberately not created — exercises the pre-existing
    # missing-file branch, unrelated to the analyse_image/run_declutter swap.

    monkeypatch.setattr(batch_eval, "analyse_image", lambda image_bytes, run_id, sc, det: _fake_analysis(run_id))

    def fake_run_declutter(analysis, user_context, llm_classifier, model_name=None):
        raise RuntimeError("simulated total LLM outage")

    monkeypatch.setattr(batch_eval, "run_declutter", fake_run_declutter)

    labels = [
        {"filename": "good.jpg", "room_type": "bedroom"},
        {"filename": "missing.jpg", "room_type": "kitchen"},
    ]
    report = batch_eval.run_batch(
        labels,
        tmp_path,
        scene_classifier=_noop_scene_classifier,
        detector=_noop_detector,
        llm_classifier=_noop_llm_classifier,
    )

    assert len(report["per_image_results"]) == 2
    assert "RuntimeError" in report["per_image_results"][0]["error"]
    assert "not found" in report["per_image_results"][1]["error"]


def test_run_batch_with_empty_labels_never_resolves_real_defaults():
    # No injected fakes AND no images to process — must not trigger any
    # lazy real-model import at all (see run_batch's own `if labels:`
    # guard). Proves the resolution is lazy relative to genuine need, not
    # just relative to module import time. Real-default resolution itself
    # (the `labels` non-empty case) is intentionally not exercised by any
    # unit test; that runtime path remains deliberately unverified here.
    report = batch_eval.run_batch([], Path("."))
    assert report["n_images"] == 0
    assert report["per_image_results"] == []
