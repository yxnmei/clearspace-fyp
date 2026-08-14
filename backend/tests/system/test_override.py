"""
System/API tests for POST /override — label correction + single-item
reclassification (app.services.declutter_service.reclassify_item).

JSON request bodies, like /confirm, not multipart (this route's original
stub used Form fields — see routes.py's OverrideRequest docstring for why
that shape was replaced). Fakes only at the llm_classifier boundary (same
two-level lazy-provider dependency /upload already uses) — never a real
Ollama call.
"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.routes import get_llm_classifier_provider
from app.core.schemas import ItemValidity
from app.main import app

_BACKEND_DIR = Path(__file__).resolve().parents[2]

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    yield
    app.dependency_overrides.clear()


@dataclass
class FakeLLMResult:
    """Matches app.services.declutter_service.LLMResultLike's shape."""

    raw_text: str
    parsed_json: object
    is_valid_json: bool
    model_name: str
    prompt_version: str
    item_provenance: dict = field(default_factory=dict)


class CallRecorder:
    def __init__(self, return_value=None, side_effect: Exception | None = None):
        self.calls: list[dict] = []
        self.return_value = return_value
        self.side_effect = side_effect

    def __call__(self, *args, **kwargs):
        self.calls.append({"args": args, "kwargs": kwargs})
        if self.side_effect is not None:
            raise self.side_effect
        return self.return_value


def _provider_override(loader):
    def _override():
        return loader

    return _override


def _detected_item_json(
    item_id: str,
    clean_label: str = "box",
    raw_phrase: str | None = None,
    box: dict | None = None,
    confidence: float = 0.9,
    position: str = "upper-left",
    relative_size: str = "small",
    role: str = "actionable",
    index: int = 0,
) -> dict:
    return {
        "item_id": item_id,
        "source_detection_index": index,
        "raw_phrase": raw_phrase or clean_label,
        "clean_label": clean_label,
        "box": box or {"x1": 0.1, "y1": 0.1, "x2": 0.3, "y2": 0.3},
        "confidence": confidence,
        "position": position,
        "relative_size": relative_size,
        "item_role": role,
        "item_role_source": "default",
    }


def _analysis_json(items: list[dict], run_id: str = "run1", scene_label: str = "bedroom") -> dict:
    return {
        "run_id": run_id,
        "scene": {"label": scene_label, "confidence": 0.9, "all_scores": {scene_label: 0.9}},
        "items": items,
        "warnings": [],
        "stage_timings": [],
    }


def _declutter_json(
    run_id: str = "run1",
    expected_item_ids: list[str] | None = None,
    ai_decisions: list[dict] | None = None,
    unresolved_item_ids: list[str] | None = None,
    item_validity: dict | None = None,
) -> dict:
    return {
        "run_id": run_id,
        "expected_item_ids": expected_item_ids or [],
        "ai_decisions": ai_decisions or [],
        "unresolved_item_ids": unresolved_item_ids or [],
        "item_validity": item_validity or {},
        "mapping_warnings": [],
        "semantic_errors": [],
        "recovery_failures": [],
        "provenance_warnings": [],
        "model_name": "phi4-mini",
        "prompt_version": "v2",
        "stage_timings": [],
    }


def _one_actionable_item_setup(item_id: str = "item_001", clean_label: str = "box", decision: str = "discard"):
    """One resolved, actionable item — the common "before" state most
    tests start from."""
    analysis = _analysis_json([_detected_item_json(item_id, clean_label=clean_label)])
    declutter = _declutter_json(
        expected_item_ids=[item_id],
        ai_decisions=[{"item_id": item_id, "decision": decision, "reason": "no apparent use"}],
        unresolved_item_ids=[],
        item_validity={item_id: "raw_valid"},
    )
    return analysis, declutter


def _override_body(analysis, declutter, item_id, corrected_label, run_id="run1", user_context=None) -> dict:
    return {
        "run_id": run_id,
        "analysis": analysis,
        "declutter": declutter,
        "item_id": item_id,
        "corrected_label": corrected_label,
        "user_context": user_context,
    }


# ---------------------------------------------------------------------------
# Success path
# ---------------------------------------------------------------------------


def test_successful_correction_returns_200_with_truthful_validity():
    analysis, declutter = _one_actionable_item_setup(decision="discard")
    reclass_result = FakeLLMResult(
        raw_text="fake",
        parsed_json=[{"item_number": 1, "label": "hoodie", "decision": "sell", "reason": "still wearable"}],
        is_valid_json=True,
        model_name="phi4-mini",
        prompt_version="v2",
        item_provenance={1: ItemValidity.MECHANICALLY_REPAIRED},
    )
    llm_fn = CallRecorder(return_value=reclass_result)
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post("/override", json=_override_body(analysis, declutter, "item_001", "hoodie"))

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == "run1"

    corrected_item = body["analysis"]["items"][0]
    assert corrected_item["item_id"] == "item_001"
    assert corrected_item["clean_label"] == "box"  # never overwritten
    assert corrected_item["corrected_label"] == "hoodie"
    assert corrected_item["label_source"] == "user"
    assert corrected_item["effective_label"] == "hoodie"
    assert corrected_item["box"] == {"x1": 0.1, "y1": 0.1, "x2": 0.3, "y2": 0.3}  # unchanged

    assert body["declutter"]["item_validity"]["item_001"] == "mechanically_repaired"  # truthful, not hardcoded
    assert body["declutter"]["ai_decisions"] == [{"item_id": "item_001", "decision": "sell", "reason": "still wearable"}]
    assert body["declutter"]["is_complete"] is True

    assert llm_fn.calls[0]["kwargs"]["detected_items"] == [
        {"label": "hoodie", "confidence": 0.9, "position_hint": "small, upper-left"}
    ]
    assert llm_fn.calls[0]["kwargs"]["scene_label"] == "bedroom"


def test_scene_and_user_context_pass_through_unchanged():
    analysis, declutter = _one_actionable_item_setup()
    analysis["scene"]["label"] = "kitchen"
    analysis["scene"]["all_scores"] = {"kitchen": 0.9}
    llm_fn = CallRecorder(
        return_value=FakeLLMResult(
            raw_text="fake",
            parsed_json=[{"item_number": 1, "label": "hoodie", "decision": "sell", "reason": "x"}],
            is_valid_json=True,
            model_name="phi4-mini",
            prompt_version="v2",
            item_provenance={1: ItemValidity.RAW_VALID},
        )
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post(
        "/override", json=_override_body(analysis, declutter, "item_001", "hoodie", user_context="downsizing")
    )

    assert response.status_code == 200
    assert llm_fn.calls[0]["kwargs"]["scene_label"] == "kitchen"
    assert llm_fn.calls[0]["kwargs"]["user_context"] == "downsizing"
    assert len(llm_fn.calls) == 1  # only the target item, no cascade


def test_resolving_a_previously_unresolved_item():
    analysis = _analysis_json([_detected_item_json("item_001", clean_label="thing")])
    declutter = _declutter_json(
        expected_item_ids=["item_001"],
        ai_decisions=[],
        unresolved_item_ids=["item_001"],
        item_validity={"item_001": "still_invalid"},
    )
    llm_fn = CallRecorder(
        return_value=FakeLLMResult(
            raw_text="fake",
            parsed_json=[{"item_number": 1, "label": "hoodie", "decision": "donate", "reason": "x"}],
            is_valid_json=True,
            model_name="phi4-mini",
            prompt_version="v2",
            item_provenance={1: ItemValidity.RAW_VALID},
        )
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post("/override", json=_override_body(analysis, declutter, "item_001", "hoodie"))

    assert response.status_code == 200
    body = response.json()
    assert body["declutter"]["is_complete"] is True
    assert body["declutter"]["unresolved_item_ids"] == []


# ---------------------------------------------------------------------------
# Failure path — never fabricated, never an error status
# ---------------------------------------------------------------------------


def test_classifier_exception_returns_200_with_still_invalid_and_preserved_correction():
    analysis, declutter = _one_actionable_item_setup()
    llm_fn = CallRecorder(side_effect=RuntimeError("ollama unreachable"))
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post("/override", json=_override_body(analysis, declutter, "item_001", "hoodie"))

    assert response.status_code == 200  # a failed reclassification is a normal outcome, not an error
    body = response.json()
    assert body["declutter"]["item_validity"]["item_001"] == "still_invalid"
    assert "item_001" in body["declutter"]["unresolved_item_ids"]
    assert "item_001" not in {d["item_id"] for d in body["declutter"]["ai_decisions"]}

    # the user's correction attempt itself is still preserved:
    corrected_item = body["analysis"]["items"][0]
    assert corrected_item["corrected_label"] == "hoodie"
    assert corrected_item["label_source"] == "user"

    failures = [f for f in body["declutter"]["recovery_failures"] if f["item_id"] == "item_001"]
    assert len(failures) == 1
    assert failures[0]["stage"] == "call"


def test_untrusted_provenance_is_not_fabricated_into_a_decision():
    analysis, declutter = _one_actionable_item_setup()
    llm_fn = CallRecorder(
        return_value=FakeLLMResult(
            raw_text="fake",
            parsed_json=[{"item_number": 1, "label": "hoodie", "decision": "sell", "reason": "x"}],
            is_valid_json=True,
            model_name="phi4-mini",
            prompt_version="v2",
            item_provenance={},  # no trustworthy hint despite a well-formed response
        )
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post("/override", json=_override_body(analysis, declutter, "item_001", "hoodie"))

    assert response.status_code == 200
    body = response.json()
    assert body["declutter"]["item_validity"]["item_001"] == "still_invalid"
    assert "item_001" not in {d["item_id"] for d in body["declutter"]["ai_decisions"]}
    assert any(w["item_id"] == "item_001" for w in body["declutter"]["provenance_warnings"])


# ---------------------------------------------------------------------------
# Request validation — automatic 422s via OverrideRequest's own validator
# ---------------------------------------------------------------------------


def test_run_id_mismatch_returns_422():
    analysis, declutter = _one_actionable_item_setup()
    response = client.post(
        "/override", json=_override_body(analysis, declutter, "item_001", "hoodie", run_id="a-different-run")
    )
    assert response.status_code == 422


def test_correcting_a_contextual_item_is_rejected():
    analysis = _analysis_json(
        [
            _detected_item_json("item_001", clean_label="box", role="actionable"),
            _detected_item_json("item_002", clean_label="wall", role="contextual", index=1),
        ]
    )
    declutter = _declutter_json(
        expected_item_ids=["item_001"],  # item_002 correctly excluded (contextual)
        ai_decisions=[{"item_id": "item_001", "decision": "discard", "reason": "x"}],
        unresolved_item_ids=[],
        item_validity={"item_001": "raw_valid"},
    )
    response = client.post("/override", json=_override_body(analysis, declutter, "item_002", "picture"))
    assert response.status_code == 422


def test_empty_corrected_label_returns_422():
    analysis, declutter = _one_actionable_item_setup()
    response = client.post("/override", json=_override_body(analysis, declutter, "item_001", "   "))
    assert response.status_code == 422


def test_expected_item_ids_not_matching_actionable_analysis_items_returns_422():
    # A mismatched pair — declutter claims a different expected set than
    # analysis.items' actual actionable ids. Must be rejected, not
    # silently trusted as a genuine matched run.
    analysis, declutter = _one_actionable_item_setup(item_id="item_001")
    declutter["expected_item_ids"] = ["item_999"]
    declutter["item_validity"] = {"item_999": "raw_valid"}
    declutter["ai_decisions"] = [{"item_id": "item_999", "decision": "keep", "reason": "x"}]
    response = client.post("/override", json=_override_body(analysis, declutter, "item_999", "hoodie"))
    assert response.status_code == 422


def test_duplicate_item_ids_in_analysis_are_rejected():
    # Inherited "for free" from AnalysisResult's own model_validator —
    # exercised here to prove OverrideRequest doesn't bypass it.
    analysis = _analysis_json(
        [
            _detected_item_json("item_001", clean_label="box"),
            _detected_item_json("item_001", clean_label="lamp", index=1),  # duplicate item_id
        ]
    )
    declutter = _declutter_json(
        expected_item_ids=["item_001"],
        ai_decisions=[{"item_id": "item_001", "decision": "discard", "reason": "x"}],
        unresolved_item_ids=[],
        item_validity={"item_001": "raw_valid"},
    )
    response = client.post("/override", json=_override_body(analysis, declutter, "item_001", "hoodie"))
    assert response.status_code == 422


def test_unknown_item_id_returns_422():
    analysis, declutter = _one_actionable_item_setup()
    response = client.post("/override", json=_override_body(analysis, declutter, "item_999", "hoodie"))
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Other items untouched, no unrelated changes
# ---------------------------------------------------------------------------


def test_other_items_are_completely_unaffected():
    analysis = _analysis_json(
        [
            _detected_item_json("item_001", clean_label="box"),
            _detected_item_json("item_002", clean_label="lamp", index=1),
        ]
    )
    declutter = _declutter_json(
        expected_item_ids=["item_001", "item_002"],
        ai_decisions=[
            {"item_id": "item_001", "decision": "discard", "reason": "x"},
            {"item_id": "item_002", "decision": "keep", "reason": "y"},
        ],
        unresolved_item_ids=[],
        item_validity={"item_001": "raw_valid", "item_002": "raw_valid"},
    )
    llm_fn = CallRecorder(
        return_value=FakeLLMResult(
            raw_text="fake",
            parsed_json=[{"item_number": 1, "label": "hoodie", "decision": "sell", "reason": "x"}],
            is_valid_json=True,
            model_name="phi4-mini",
            prompt_version="v2",
            item_provenance={1: ItemValidity.RAW_VALID},
        )
    )
    app.dependency_overrides[get_llm_classifier_provider] = _provider_override(lambda: llm_fn)

    response = client.post("/override", json=_override_body(analysis, declutter, "item_001", "hoodie"))

    assert response.status_code == 200
    body = response.json()
    item_002 = next(i for i in body["analysis"]["items"] if i["item_id"] == "item_002")
    assert item_002["clean_label"] == "lamp"
    assert item_002["corrected_label"] is None
    assert item_002["label_source"] == "detector"
    decisions_by_id = {d["item_id"]: d["decision"] for d in body["declutter"]["ai_decisions"]}
    assert decisions_by_id == {"item_001": "sell", "item_002": "keep"}


# ---------------------------------------------------------------------------
# Lazy dependency injection
# ---------------------------------------------------------------------------


def test_override_with_a_fake_provider_never_loads_the_real_llm_stack():
    # Must run in an isolated subprocess, not an in-process sys.modules
    # check: other test files in the same pytest session legitimately
    # import ollama/mistral_llm elsewhere (e.g. test_mistral_llm.py), so
    # an in-process check here would be contaminated by whatever ran
    # earlier in the session — exactly the reason
    # test_importing_routes_and_main_does_not_load_heavy_model_stacks
    # (below) already uses a subprocess too.
    code = (
        "import sys, types\n"
        "from fastapi.testclient import TestClient\n"
        "from app.api.routes import get_llm_classifier_provider\n"
        "from app.main import app\n"
        "fake_result = types.SimpleNamespace(\n"
        "    parsed_json=[{'item_number': 1, 'label': 'hoodie', 'decision': 'sell', 'reason': 'x'}],\n"
        "    item_provenance={1: 'raw_valid'},\n"
        ")\n"
        "app.dependency_overrides[get_llm_classifier_provider] = lambda: (lambda **kw: fake_result)\n"
        "client = TestClient(app)\n"
        "analysis = {\n"
        "    'run_id': 'run1',\n"
        "    'scene': {'label': 'bedroom', 'confidence': 0.9, 'all_scores': {'bedroom': 0.9}},\n"
        "    'items': [{\n"
        "        'item_id': 'item_001', 'source_detection_index': 0, 'raw_phrase': 'box',\n"
        "        'clean_label': 'box', 'box': {'x1': 0.1, 'y1': 0.1, 'x2': 0.3, 'y2': 0.3},\n"
        "        'confidence': 0.9, 'position': 'upper-left', 'relative_size': 'small',\n"
        "        'item_role': 'actionable', 'item_role_source': 'default',\n"
        "    }],\n"
        "    'warnings': [], 'stage_timings': [],\n"
        "}\n"
        "declutter = {\n"
        "    'run_id': 'run1', 'expected_item_ids': ['item_001'],\n"
        "    'ai_decisions': [{'item_id': 'item_001', 'decision': 'discard', 'reason': 'x'}],\n"
        "    'unresolved_item_ids': [], 'item_validity': {'item_001': 'raw_valid'},\n"
        "    'mapping_warnings': [], 'semantic_errors': [], 'recovery_failures': [], 'provenance_warnings': [],\n"
        "    'model_name': 'phi4-mini', 'prompt_version': 'v2', 'stage_timings': [],\n"
        "}\n"
        "response = client.post('/override', json={\n"
        "    'run_id': 'run1', 'analysis': analysis, 'declutter': declutter,\n"
        "    'item_id': 'item_001', 'corrected_label': 'hoodie', 'user_context': None,\n"
        "})\n"
        "assert response.status_code == 200, response.text\n"
        "heavy = {'ollama', 'app.models.mistral_llm'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR))
    assert result.returncode == 0, result.stdout + result.stderr


def test_importing_routes_and_main_does_not_load_heavy_model_stacks():
    code = (
        "import sys\n"
        "import app.main\n"
        "heavy = {'torch', 'clip', 'ollama', 'app.models.clip_scene', "
        "'app.models.grounding_dino', 'app.models.mistral_llm'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR))
    assert result.returncode == 0, result.stdout + result.stderr


def test_health_endpoint_still_works_alongside_override():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
