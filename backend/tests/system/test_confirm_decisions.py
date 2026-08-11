"""
System/API tests for POST /confirm. JSON request bodies (no multipart —
no file upload is involved), constructed directly as dicts matching
DeclutterResult/AiDecision/DecisionOverride's real field names, so
pydantic's own request-body validation runs for real, exactly as a
frontend round-tripping /upload's response would trigger it.

No fakes are needed here beyond the request payloads themselves —
confirmation is pure, deterministic, model-free logic; there is nothing
to fake at the model-callable boundary the way /upload needs.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import routes as routes_module
from app.main import app

_BACKEND_DIR = Path(__file__).resolve().parents[2]

client = TestClient(app)


def _decision(item_id: str, decision: str, reason: str = "still useful") -> dict:
    return {"item_id": item_id, "decision": decision, "reason": reason}


def _declutter_json(
    run_id="run1",
    expected_item_ids=None,
    ai_decisions=None,
    unresolved_item_ids=None,
    item_validity=None,
    extra=None,
) -> dict:
    body = {
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
    if extra:
        body.update(extra)
    return body


def _complete_declutter_json(items: list[tuple[str, str]], run_id: str = "run1") -> dict:
    """items: [(item_id, decision), ...] — all resolved, raw_valid."""
    return _declutter_json(
        run_id=run_id,
        expected_item_ids=[iid for iid, _ in items],
        ai_decisions=[_decision(iid, dec) for iid, dec in items],
        unresolved_item_ids=[],
        item_validity={iid: "raw_valid" for iid, _ in items},
    )


def test_confirm_without_overrides_returns_200_and_preserves_decisions():
    declutter = _complete_declutter_json([("item_001", "keep"), ("item_002", "donate")])
    response = client.post("/confirm", json={"run_id": "run1", "declutter": declutter, "overrides": []})

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == "run1"
    assert [d["confirmed_decision"] for d in body["confirmed_decisions"]] == ["keep", "donate"]
    assert [d["ai_decision"] for d in body["confirmed_decisions"]] == ["keep", "donate"]


def test_decision_override_changes_response_and_keep_set():
    declutter = _complete_declutter_json([("item_001", "keep")])
    response = client.post(
        "/confirm",
        json={
            "run_id": "run1",
            "declutter": declutter,
            "overrides": [{"item_id": "item_001", "decision": "donate"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["confirmed_decisions"][0]["confirmed_decision"] == "donate"
    assert body["confirmed_decisions"][0]["ai_decision"] == "keep"  # original never overwritten
    assert body["confirmed_keep_ids"] == []


def test_excluded_keep_does_not_enter_the_keep_set():
    declutter = _complete_declutter_json([("item_001", "keep"), ("item_002", "keep")])
    response = client.post(
        "/confirm",
        json={
            "run_id": "run1",
            "declutter": declutter,
            "overrides": [{"item_id": "item_002", "excluded": True}],
        },
    )

    assert response.status_code == 200
    assert response.json()["confirmed_keep_ids"] == ["item_001"]


def test_same_label_context_items_remain_independent_by_item_id():
    # DeclutterResult/AiDecision carry no label field at all at this
    # layer — this proves two distinct expected items (as would arise
    # from two duplicate-labelled detections upstream) resolve and
    # override entirely independently, keyed only by item_id.
    declutter = _complete_declutter_json([("item_004", "keep"), ("item_006", "keep")])
    response = client.post(
        "/confirm",
        json={
            "run_id": "run1",
            "declutter": declutter,
            "overrides": [{"item_id": "item_004", "decision": "discard"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    by_id = {d["item_id"]: d["confirmed_decision"] for d in body["confirmed_decisions"]}
    assert by_id == {"item_004": "discard", "item_006": "keep"}
    assert body["confirmed_keep_ids"] == ["item_006"]


def test_run_id_mismatch_between_request_and_declutter_returns_422():
    declutter = _complete_declutter_json([("item_001", "keep")], run_id="run1")
    response = client.post("/confirm", json={"run_id": "a_different_run", "declutter": declutter, "overrides": []})
    assert response.status_code == 422


def test_invalid_decision_enum_in_override_returns_422():
    declutter = _complete_declutter_json([("item_001", "keep")])
    response = client.post(
        "/confirm",
        json={
            "run_id": "run1",
            "declutter": declutter,
            "overrides": [{"item_id": "item_001", "decision": "maybe-later"}],
        },
    )
    assert response.status_code == 422


def test_malformed_item_id_returns_422():
    declutter = _complete_declutter_json([("item_001", "keep")])
    declutter["expected_item_ids"] = ["not-a-valid-id"]
    declutter["ai_decisions"][0]["item_id"] = "not-a-valid-id"
    declutter["item_validity"] = {"not-a-valid-id": "raw_valid"}
    response = client.post("/confirm", json={"run_id": "run1", "declutter": declutter, "overrides": []})
    assert response.status_code == 422


def test_duplicate_override_ids_return_sanitized_422():
    declutter = _complete_declutter_json([("item_001", "keep")])
    response = client.post(
        "/confirm",
        json={
            "run_id": "run1",
            "declutter": declutter,
            "overrides": [
                {"item_id": "item_001", "decision": "donate"},
                {"item_id": "item_001", "excluded": True},
            ],
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "invalid decision overrides"


def test_unknown_override_item_id_returns_sanitized_422():
    declutter = _complete_declutter_json([("item_001", "keep")])
    response = client.post(
        "/confirm",
        json={
            "run_id": "run1",
            "declutter": declutter,
            "overrides": [{"item_id": "item_999", "decision": "keep"}],
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "invalid decision overrides"


def test_incomplete_declutter_result_returns_sanitized_409():
    declutter = _declutter_json(
        expected_item_ids=["item_001"],
        ai_decisions=[],
        unresolved_item_ids=["item_001"],
        item_validity={"item_001": "still_invalid"},
    )
    response = client.post("/confirm", json={"run_id": "run1", "declutter": declutter, "overrides": []})
    assert response.status_code == 409
    assert response.json()["detail"] == "all Declutter items must be resolved before confirmation"
    assert "traceback" not in response.text.lower()


def test_client_supplied_is_complete_true_cannot_make_an_incomplete_result_pass():
    # is_complete is a computed field on DeclutterResult — recomputed
    # from unresolved_item_ids, never accepted as constructor input. A
    # forged "is_complete": true in the raw JSON must be silently
    # ignored, not trusted.
    declutter = _declutter_json(
        expected_item_ids=["item_001"],
        ai_decisions=[],
        unresolved_item_ids=["item_001"],
        item_validity={"item_001": "still_invalid"},
        extra={"is_complete": True, "is_strictly_valid": True},
    )
    response = client.post("/confirm", json={"run_id": "run1", "declutter": declutter, "overrides": []})
    assert response.status_code == 409


def test_response_includes_computed_decision_changed_and_excluded_counts():
    declutter = _complete_declutter_json([("item_001", "keep"), ("item_002", "keep")])
    response = client.post(
        "/confirm",
        json={
            "run_id": "run1",
            "declutter": declutter,
            "overrides": [
                {"item_id": "item_001", "decision": "donate"},
                {"item_id": "item_002", "excluded": True},
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["decision_changed_count"] == 1
    assert body["excluded_count"] == 1


def test_confirm_endpoint_triggers_no_heavy_model_import():
    code = (
        "import sys\n"
        "from fastapi.testclient import TestClient\n"
        "from app.main import app\n"
        "client = TestClient(app)\n"
        "declutter = {\n"
        "    'run_id': 'run1', 'expected_item_ids': ['item_001'],\n"
        "    'ai_decisions': [{'item_id': 'item_001', 'decision': 'keep', 'reason': 'x'}],\n"
        "    'unresolved_item_ids': [], 'item_validity': {'item_001': 'raw_valid'},\n"
        "    'mapping_warnings': [], 'semantic_errors': [], 'recovery_failures': [], 'provenance_warnings': [],\n"
        "    'model_name': 'phi4-mini', 'prompt_version': 'v2', 'stage_timings': [],\n"
        "}\n"
        "response = client.post('/confirm', json={'run_id': 'run1', 'declutter': declutter, 'overrides': []})\n"
        "assert response.status_code == 200, response.text\n"
        "heavy = {'torch', 'clip', 'ollama', 'app.models.clip_scene', "
        "'app.models.grounding_dino', 'app.models.mistral_llm'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR))
    assert result.returncode == 0, result.stdout + result.stderr


def test_health_endpoint_still_works_alongside_confirm():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_unexpected_valueerror_from_service_is_not_mislabeled_as_invalid_overrides(monkeypatch):
    # A pydantic ValidationError (or any other plain ValueError, not the
    # typed ConfirmationInputError) escaping confirm_declutter_result()
    # must become a normal 500 — never disguised as the sanitized
    # "invalid decision overrides" 422, and never leaking the exception
    # message. Uses its own isolated TestClient (raise_server_exceptions
    # =False is required to observe the 500 response instead of the
    # exception propagating into this test process) so the module-level
    # `client` used by every other test in this file is never affected —
    # monkeypatch's automatic teardown restores the real
    # confirm_declutter_result after this test regardless.
    def _raise_internal_error(declutter, overrides):
        raise ValueError("simulated internal invariant failure")

    monkeypatch.setattr(routes_module, "confirm_declutter_result", _raise_internal_error)
    isolated_client = TestClient(app, raise_server_exceptions=False)

    declutter = _complete_declutter_json([("item_001", "keep")])
    response = isolated_client.post("/confirm", json={"run_id": "run1", "declutter": declutter, "overrides": []})

    assert response.status_code == 500
    assert "simulated internal invariant failure" not in response.text
    assert "invalid decision overrides" not in response.text
