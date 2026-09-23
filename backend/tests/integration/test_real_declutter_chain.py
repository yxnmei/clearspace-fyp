"""
Real-model integration test: the production Declutter chain at the
Python-function boundary, with no HTTP layer and no fakes.

    real CLIP (app.models.clip_scene.classify_scene)
      -> real Grounding DINO (app.models.grounding_dino.detect)
        -> production analyse_image()
          -> real phi4-mini via local Ollama (app.models.mistral_llm.classify_items)
            -> production run_declutter()

What is real here: every model wrapper, every loader, both services,
the configured settings, the local weights and the local Ollama model.
No `app.dependency_overrides`, no TestClient, no route, no fake
classifier/detector/LLM, no monkeypatching, no saved responses and no
fixture JSON standing in for model output.

What is asserted: contracts and invariants (schema validity, identity,
accounting, provenance), never a particular scene label, item label,
detection count, decision, reason wording or timing. `is_strictly_valid`
is NOT required: a complete result after mechanical repair or targeted
recovery is a legitimate production outcome (every documented real run
so far has been complete-but-not-strict).

Opt-in and prerequisites live in conftest.py (`real_model_prerequisites`).
Everything heavy is imported inside the test, after that fixture has
passed, so collecting this module in the ordinary suite imports nothing
beyond pytest and the standard library. Runs as ONE chain so each model
loads once (roughly 90-130 s on the current CPU-only machine).

Diagnostics on failure are count-level and name the stage; the image,
prompts, model responses, environment values and reasons are never
printed.
"""

from __future__ import annotations

import re
import time
from contextlib import contextmanager
from pathlib import Path

import pytest

ITEM_ID_PATTERN = re.compile(r"^item_\d{3,}$")


class ChainStageError(AssertionError):
    """Replaces an exception from one stage with the stage name and the
    exception TYPE only, so the failure report says where the chain broke
    without dumping model output. The original exception is deliberately
    NOT chained (`raise ... from None`): a wrapper's message can carry raw
    model text, prompts or labels, and pytest prints chained causes in
    full. Rerun the stage by hand when the message alone is not enough."""


@contextmanager
def _stage(name: str, timings: dict[str, float]):
    started = time.perf_counter()
    try:
        yield
    except pytest.skip.Exception:  # a prerequisite skip must stay a skip
        raise
    except Exception as exc:
        raise ChainStageError(f"stage {name!r} failed with {type(exc).__name__}") from None
    finally:
        timings[name] = time.perf_counter() - started


def _assert_analysis_contract(analysis, run_id: str, candidates: list[str]) -> None:
    from app.core.schemas import AnalysisResult, BoundingBox, DetectedItem

    assert isinstance(analysis, AnalysisResult)
    assert analysis.run_id == run_id

    # Scene: a configured candidate, a probability, a full score table.
    scene = analysis.scene
    assert scene.label.strip() and scene.label in candidates
    assert 0.0 <= scene.confidence <= 1.0
    assert set(scene.all_scores) == set(candidates)
    assert all(0.0 <= s <= 1.0 for s in scene.all_scores.values())

    # Items: at least one, canonical sequential ids, unique, spatially ordered.
    items = analysis.items
    assert len(items) >= 1, "real detection produced zero items"
    ids = [item.item_id for item in items]
    assert len(ids) == len(set(ids)), "duplicate item_id within one run"
    assert all(ITEM_ID_PATTERN.match(i) for i in ids)
    assert ids == [f"item_{n:03d}" for n in range(1, len(items) + 1)]
    sort_keys = [(item.box.y1, item.box.x1, item.source_detection_index) for item in items]
    assert sort_keys == sorted(sort_keys), "items are not in the documented spatial order"

    for item in items:
        assert isinstance(item, DetectedItem)
        box = item.box
        assert isinstance(box, BoundingBox)
        assert 0.0 <= box.x1 < box.x2 <= 1.0
        assert 0.0 <= box.y1 < box.y2 <= 1.0
        assert 0.0 <= item.confidence <= 1.0
        assert item.raw_phrase.strip() and item.clean_label.strip() and item.effective_label.strip()
        assert item.position.strip() and item.relative_size.strip()
        assert item.item_role in {"actionable", "contextual"}
        assert item.item_role_source in {"default", "heuristic", "user"}
        assert item.corrected_label is None and item.label_source == "detector"
        assert item.source_detection_index >= 0

    # Soft-failure path: only the one documented warning kind, never silent.
    assert all(w.kind == "malformed_detection" for w in analysis.warnings)

    stages = [t.stage for t in analysis.stage_timings]
    assert stages == ["validate_image", "classify_scene", "detect_objects", "postprocess_detections"]
    assert all(t.duration_ms >= 0.0 for t in analysis.stage_timings)

    # The API re-validates this exact payload on /confirm and /generate:
    # a real result must survive a JSON round trip through its own schema.
    AnalysisResult.model_validate(analysis.model_dump(mode="json"))


def _assert_declutter_contract(declutter, analysis, expected_model: str, expected_prompt_version: str) -> None:
    from app.core.schemas import Decision, ItemValidity
    from app.services.declutter_service import DeclutterResult

    assert isinstance(declutter, DeclutterResult)
    assert declutter.run_id == analysis.run_id

    # Expected ids: exactly the actionable items, in analysis order.
    actionable_ids = [item.item_id for item in analysis.items if item.item_role == "actionable"]
    assert declutter.expected_item_ids == actionable_ids
    expected_set = set(actionable_ids)
    assert len(expected_set) >= 1, "no actionable items, so the LLM was never exercised"

    # Provenance: the real configured production model and prompt, not a substitute.
    assert declutter.model_name == expected_model
    assert declutter.prompt_version == expected_prompt_version

    # Decisions: one per expected item, enum-valued, non-blank reasons, no strangers.
    decision_ids = [ai.item_id for ai in declutter.ai_decisions]
    assert len(decision_ids) == len(set(decision_ids)), "duplicate item_id in ai_decisions"
    assert set(decision_ids) <= expected_set, "ai_decisions reference unknown item_ids"
    assert decision_ids == [i for i in actionable_ids if i in set(decision_ids)], "ai_decisions out of order"
    for ai in declutter.ai_decisions:
        assert isinstance(ai.decision, Decision)
        assert ai.decision in {Decision.KEEP, Decision.SELL, Decision.DONATE, Decision.DISCARD}
        assert isinstance(ai.reason, str) and ai.reason.strip()

    # Accounting: validity covers every expected id; decided + unresolved partition it.
    assert set(declutter.item_validity) == expected_set
    assert all(isinstance(v, ItemValidity) for v in declutter.item_validity.values())
    still_invalid = {i for i, v in declutter.item_validity.items() if v == ItemValidity.STILL_INVALID}
    assert set(declutter.unresolved_item_ids) == still_invalid
    assert set(decision_ids).isdisjoint(declutter.unresolved_item_ids)
    assert set(decision_ids) | set(declutter.unresolved_item_ids) == expected_set
    assert declutter.is_complete == (len(declutter.unresolved_item_ids) == 0)
    recomputed_strict = (
        declutter.is_complete
        and all(v == ItemValidity.RAW_VALID for v in declutter.item_validity.values())
        and not declutter.mapping_warnings
        and not declutter.semantic_errors
        and not declutter.recovery_failures
        and not declutter.provenance_warnings
    )
    assert declutter.is_strictly_valid == recomputed_strict

    # The chain's purpose: the recovery plumbing yields exactly one decision
    # per expected item against a real model. A STILL_INVALID item is a
    # legitimate contract state, but it means the real chain did not
    # complete on this image; report it as model nondeterminism, not as a
    # defect, before weakening anything (see README).
    assert declutter.is_complete, (
        f"{len(declutter.unresolved_item_ids)} of {len(actionable_ids)} expected items unresolved "
        f"after recovery ({len(declutter.recovery_failures)} recovery failures recorded)"
    )
    assert len(declutter.ai_decisions) == len(actionable_ids)

    assert [t.stage for t in declutter.stage_timings] == ["declutter_llm_classify"]
    assert all(t.duration_ms >= 0.0 for t in declutter.stage_timings)

    DeclutterResult.model_validate(declutter.model_dump(mode="json"))


@pytest.mark.integration
def test_real_declutter_chain_end_to_end(real_model_prerequisites):
    prereq = real_model_prerequisites
    timings: dict[str, float] = {}

    with _stage("import_real_stack", timings):
        from app.api.routes import _load_detector, _load_llm_classifier, _load_scene_classifier
        from app.models.clip_scene import ROOM_TYPE_CANDIDATES, classify_scene
        from app.models.grounding_dino import _resolve_backend_path, detect
        from app.models.mistral_llm import CLASSIFICATION_PROMPT_VERSION, classify_items
        from app.logging_utils import new_run_id
        from app.services.analysis_service import analyse_image
        from app.services.declutter_service import run_declutter

    # The exact callables production injects through the /upload loaders
    # are the ones this test composes by hand: same functions, no HTTP.
    assert _load_scene_classifier() is classify_scene
    assert _load_detector() is detect
    assert _load_llm_classifier() is classify_items

    # The gate resolved the weight paths without importing torch; confirm
    # it agrees with the production resolver now that the import is paid.
    from app.config import get_settings

    settings = get_settings()
    assert _resolve_backend_path(settings.grounding_dino_config_path) == prereq.grounding_dino_config_path
    assert _resolve_backend_path(settings.grounding_dino_weights_path) == prereq.grounding_dino_weights_path
    assert settings.llm_model_name == prereq.llm_model_name

    image_bytes = Path(prereq.image_path).read_bytes()
    assert image_bytes, "integration image is empty"
    run_id = new_run_id()

    with _stage("analyse_image", timings):
        analysis = analyse_image(image_bytes, run_id, classify_scene, detect)
    _assert_analysis_contract(analysis, run_id, list(ROOM_TYPE_CANDIDATES))

    with _stage("run_declutter", timings):
        declutter = run_declutter(analysis, user_context=None, llm_classifier=classify_items)
    _assert_declutter_contract(declutter, analysis, prereq.llm_model_name, CLASSIFICATION_PROMPT_VERSION)

    # Count-level summary only (visible with -s or on failure): no labels,
    # decisions, reasons, prompts, responses or paths.
    validity_counts = {
        validity.value: sum(1 for v in declutter.item_validity.values() if v == validity)
        for validity in type(next(iter(declutter.item_validity.values())))
    }
    print(
        "real declutter chain:"
        f" items={len(analysis.items)}"
        f" actionable={len(declutter.expected_item_ids)}"
        f" decisions={len(declutter.ai_decisions)}"
        f" unresolved={len(declutter.unresolved_item_ids)}"
        f" analysis_warnings={len(analysis.warnings)}"
        f" mapping_warnings={len(declutter.mapping_warnings)}"
        f" semantic_errors={len(declutter.semantic_errors)}"
        f" recovery_failures={len(declutter.recovery_failures)}"
        f" provenance_warnings={len(declutter.provenance_warnings)}"
        f" validity={validity_counts}"
        f" is_complete={declutter.is_complete}"
        f" is_strictly_valid={declutter.is_strictly_valid}"
        f" timings_s={{{', '.join(f'{k}={v:.1f}' for k, v in timings.items())}}}"
    )
