"""
System/API tests for the application-level RequestValidationError handler
in app/main.py.

Defect being pinned: FastAPI's default handler serialises exc.errors()
unchanged, and pydantic attaches the offending `input` to every error.
For a body-level model validator (run_id mismatch, unknown override id,
...) that `input` is the ENTIRE request — base64 image, user context,
every id — and model-validator `msg` strings quote submitted ids. The
frontend request helper embeds the response body in its thrown Error,
and pages render it in an alert, so a 215 kB request could come back as
a 213 kB alert containing the user's own upload.

These tests drive the real app through TestClient with fake model
boundaries (same conventions as the other tests/system modules). They
assert on what the handler must NEVER return, on a bounded size that is
independent of the request, and that the service-level sanitised errors
and the success contracts are untouched.
"""

from __future__ import annotations

import base64
import json
import logging
import os

import pytest
from fastapi.testclient import TestClient

from app.main import VALIDATION_FAILED_DETAIL, app
from .test_generate_confirmed import PNG_BYTES, _confirmed_generate_body, _do_both_upload

client = TestClient(app)

ROUTES_WITH_JSON_BODY = ["/confirm", "/generate", "/generate/confirmed", "/listings", "/override", "/listings/item_001/regenerate"]

# Unmistakable, unique values that must never come back in any 422.
SENTINEL_RUN_ID = "SENTINEL-RUN-ID-7f3a9c"
SENTINEL_ITEM_ID = "SENTINEL-ITEM-ID-b81d2e"
SENTINEL_CONTEXT = "SENTINEL-USER-CONTEXT-c4e6f0 the user typed this and it is private"
SENTINEL_IMAGE_BYTES = b"SENTINEL-IMAGE-PAYLOAD-5d0e1a" + os.urandom(64)
SENTINEL_IMAGE_B64 = base64.b64encode(SENTINEL_IMAGE_BYTES).decode("ascii")
SENTINELS = (SENTINEL_RUN_ID, SENTINEL_ITEM_ID, SENTINEL_CONTEXT, SENTINEL_IMAGE_B64, SENTINEL_IMAGE_B64[:40])

# Any 422 body is a fixed detail plus at most 20 short {type, location}
# entries: comfortably under this even in the worst case.
MAX_422_BYTES = 2048


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    yield
    app.dependency_overrides.clear()


def _walk_keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _walk_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_keys(child)


def _assert_sanitised_422(response, *, forbidden: tuple[str, ...] = ()):
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/json")
    assert len(response.content) < MAX_422_BYTES
    body = response.json()  # must be valid JSON
    assert body["detail"] == VALIDATION_FAILED_DETAIL
    assert set(body) == {"detail", "errors"}
    assert isinstance(body["errors"], list) and body["errors"]
    for entry in body["errors"]:
        assert set(entry) == {"type", "location"}
        assert isinstance(entry["type"], str) and entry["type"]
        assert entry["location"] in {"body", "query", "path", "header", "cookie", "request"}
    keys = set(_walk_keys(body))
    assert "input" not in keys
    assert "ctx" not in keys
    assert "msg" not in keys
    assert "loc" not in keys
    assert "url" not in keys
    for sentinel in forbidden:
        assert sentinel not in response.text
        assert sentinel not in json.dumps(body)
    return body


def _complete_declutter(run_id: str, items: list[tuple[str, str]]) -> dict:
    return {
        "run_id": run_id,
        "expected_item_ids": [iid for iid, _ in items],
        "ai_decisions": [{"item_id": iid, "decision": dec, "reason": "still useful"} for iid, dec in items],
        "unresolved_item_ids": [],
        "item_validity": {iid: "raw_valid" for iid, _ in items},
        "mapping_warnings": [],
        "semantic_errors": [],
        "recovery_failures": [],
        "provenance_warnings": [],
        "model_name": "phi4-mini",
        "prompt_version": "v2",
        "stage_timings": [],
    }


def _both_upload():
    return _do_both_upload(
        [
            {"item_number": 1, "label": "lamp", "decision": "keep", "reason": "useful"},
            {"item_number": 2, "label": "book", "decision": "sell", "decision_reason": "not needed", "reason": "not needed"},
        ]
    )


# ---------------------------------------------------------------------------
# 1 + 4. A body-level (model-validator) 422 carries no `input`, is valid JSON
#        with the stable detail
# ---------------------------------------------------------------------------


def test_body_level_422_contains_no_input_key_anywhere():
    upload_body = _both_upload()
    # run_id mismatch fails ConfirmedGenerateRequest's own model validator
    # (loc == ["body"]) — the exact case whose default `input` was the
    # whole request in the integration baseline.
    body = _confirmed_generate_body(upload_body, PNG_BYTES, run_id=SENTINEL_RUN_ID)

    response = client.post("/generate/confirmed", json=body)

    parsed = _assert_sanitised_422(response, forbidden=(SENTINEL_RUN_ID,))
    assert {"type": "value_error", "location": "body"} in parsed["errors"]


# ---------------------------------------------------------------------------
# 2 + 10. Sentinels in image / context / run id / item id never come back,
#         in the JSON, in the raw text, or in the handler's log line
# ---------------------------------------------------------------------------


def test_sentinel_values_never_appear_in_a_422_or_its_log(caplog):
    upload_body = _both_upload()
    body = _confirmed_generate_body(
        upload_body,
        PNG_BYTES,
        run_id=SENTINEL_RUN_ID,
        image=SENTINEL_IMAGE_B64,
        user_context=SENTINEL_CONTEXT,
        # an unknown override id: the model validator's msg quotes it
        overrides=[{"item_id": SENTINEL_ITEM_ID, "decision": "keep"}],
    )

    with caplog.at_level(logging.DEBUG):
        response = client.post("/generate/confirmed", json=body)

    _assert_sanitised_422(response, forbidden=SENTINELS)
    for record in caplog.records:
        rendered = record.getMessage()
        for sentinel in SENTINELS:
            assert sentinel not in rendered
    handler_lines = [r for r in caplog.records if r.name == "app.main"]
    assert len(handler_lines) == 1
    assert "/generate/confirmed" in handler_lines[0].getMessage()


def test_sentinels_never_appear_for_field_level_errors_either():
    # "missing" errors attach the CONTAINING object as `input` — for a
    # missing top-level field that is again the whole request body.
    body = {
        "run_id": SENTINEL_RUN_ID,
        "selected_item_ids": [SENTINEL_ITEM_ID],
        "image": SENTINEL_IMAGE_B64,
        "image_media_type": "image/png",
        "user_context": SENTINEL_CONTEXT,
        # "analysis" and "input_image_sha256" deliberately absent
    }

    response = client.post("/generate", json=body)

    parsed = _assert_sanitised_422(response, forbidden=SENTINELS)
    assert {"type": "missing", "location": "body"} in parsed["errors"]


# ---------------------------------------------------------------------------
# 3 + 8. Response size is small and independent of the request size
# ---------------------------------------------------------------------------


def test_large_request_produces_a_small_response_independent_of_body_size():
    upload_body = _both_upload()
    small = _confirmed_generate_body(upload_body, PNG_BYTES, run_id=SENTINEL_RUN_ID)
    big_image = base64.b64encode(SENTINEL_IMAGE_BYTES + os.urandom(400_000)).decode("ascii")
    large = _confirmed_generate_body(upload_body, PNG_BYTES, run_id=SENTINEL_RUN_ID, image=big_image)
    assert len(json.dumps(large)) > 500_000

    small_response = client.post("/generate/confirmed", json=small)
    large_response = client.post("/generate/confirmed", json=large)

    _assert_sanitised_422(small_response, forbidden=(SENTINEL_RUN_ID,))
    _assert_sanitised_422(large_response, forbidden=(SENTINEL_RUN_ID, big_image[:40]))
    assert len(large_response.content) < MAX_422_BYTES
    assert large_response.content == small_response.content


# ---------------------------------------------------------------------------
# 5 + 6. Missing fields and malformed shapes still 422, consistently across
#        the affected routes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("route", ROUTES_WITH_JSON_BODY)
def test_empty_object_is_a_sanitised_422_on_every_json_route(route):
    parsed = _assert_sanitised_422(client.post(route, json={}))
    assert {"type": "missing", "location": "body"} in parsed["errors"]


@pytest.mark.parametrize("route", ROUTES_WITH_JSON_BODY)
def test_invalid_json_is_a_sanitised_422_on_every_json_route(route):
    response = client.post(route, content=b"{not json", headers={"Content-Type": "application/json"})
    parsed = _assert_sanitised_422(response, forbidden=("not json",))
    assert {"type": "json_invalid", "location": "body"} in parsed["errors"]


@pytest.mark.parametrize("route", ROUTES_WITH_JSON_BODY)
def test_wrong_shape_with_sentinels_is_a_sanitised_422_on_every_json_route(route):
    body = {
        "run_id": SENTINEL_RUN_ID,
        "analysis": SENTINEL_CONTEXT,  # wrong type, and a value that must not echo
        "declutter": [SENTINEL_ITEM_ID],
        "overrides": SENTINEL_IMAGE_B64,
        "image": SENTINEL_IMAGE_B64,
        "user_context": SENTINEL_CONTEXT,
    }
    _assert_sanitised_422(client.post(route, json=body), forbidden=SENTINELS)


def test_confirm_run_id_mismatch_is_a_sanitised_422():
    declutter = _complete_declutter("run1", [("item_001", "keep")])
    response = client.post("/confirm", json={"run_id": SENTINEL_RUN_ID, "declutter": declutter, "overrides": []})
    parsed = _assert_sanitised_422(response, forbidden=(SENTINEL_RUN_ID,))
    assert parsed["errors"] == [{"type": "value_error", "location": "body"}]


def test_forbidden_extra_field_name_is_not_echoed():
    upload_body = _both_upload()
    body = _confirmed_generate_body(upload_body, PNG_BYTES)
    body["SENTINEL_EXTRA_FIELD_9a1b"] = [SENTINEL_ITEM_ID]
    response = client.post("/generate/confirmed", json=body)
    parsed = _assert_sanitised_422(response, forbidden=("SENTINEL_EXTRA_FIELD_9a1b", SENTINEL_ITEM_ID))
    assert {"type": "extra_forbidden", "location": "body"} in parsed["errors"]


def test_multipart_form_validation_uses_the_same_handler():
    response = client.post(
        "/upload",
        files={"image": ("SENTINEL-FILENAME-e2d1.png", PNG_BYTES, "image/png")},
        data={"path": "SENTINEL-PATH-VALUE-0c7b"},
    )
    parsed = _assert_sanitised_422(response, forbidden=("SENTINEL-FILENAME-e2d1", "SENTINEL-PATH-VALUE-0c7b"))
    assert {"type": "literal_error", "location": "body"} in parsed["errors"]


def test_error_kinds_are_deduplicated_sorted_and_bounded():
    # Two missing fields + one wrong type collapse to sorted unique kinds.
    response = client.post("/confirm", json={"overrides": "not-a-list"})
    parsed = _assert_sanitised_422(response, forbidden=("not-a-list",))
    kinds = [(e["type"], e["location"]) for e in parsed["errors"]]
    assert kinds == sorted(set(kinds))
    assert len(kinds) <= 20
    assert ("missing", "body") in kinds


# ---------------------------------------------------------------------------
# 7. Service-level sanitised errors are unchanged (never RequestValidationError)
# ---------------------------------------------------------------------------


def test_service_level_422_detail_is_unchanged():
    declutter = _complete_declutter("run1", [("item_001", "keep")])
    response = client.post(
        "/confirm",
        json={"run_id": "run1", "declutter": declutter, "overrides": [{"item_id": "item_999", "decision": "sell"}]},
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid decision overrides"}


def test_service_level_409_details_are_unchanged():
    declutter = _complete_declutter("run1", [("item_001", "keep")])
    declutter["ai_decisions"] = []
    declutter["item_validity"] = {"item_001": "still_invalid"}
    declutter["unresolved_item_ids"] = ["item_001"]
    response = client.post("/confirm", json={"run_id": "run1", "declutter": declutter, "overrides": []})
    assert response.status_code == 409
    assert response.json() == {"detail": "all Declutter items must be resolved before confirmation"}


def test_empty_keep_409_uses_the_corrected_tidy_plan_sentence():
    upload_body = _do_both_upload(
        [{"item_number": 1, "label": "lamp", "decision": "sell", "reason": "not needed"}]
    )
    response = client.post("/generate/confirmed", json=_confirmed_generate_body(upload_body, PNG_BYTES))
    assert response.status_code == 409
    assert response.json() == {"detail": "No items were confirmed as Keep, so there is nothing to include in a tidy plan."}
    assert "—" not in response.text


# ---------------------------------------------------------------------------
# 8. Successful requests and their contracts are untouched
# ---------------------------------------------------------------------------


def test_successful_confirm_contract_is_unchanged():
    declutter = _complete_declutter("run1", [("item_001", "keep"), ("item_002", "sell")])
    response = client.post("/confirm", json={"run_id": "run1", "declutter": declutter, "overrides": []})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"run_id", "confirmed_decisions", "confirmed_keep_ids", "decision_changed_count", "excluded_count"}
    assert body["confirmed_keep_ids"] == ["item_001"]
    assert "errors" not in body


def test_health_and_unknown_route_are_unchanged():
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/nope").status_code == 404
