"""
System-level tests for colab_service.app's FastAPI service — fakes only,
no GPU, no network, no model, no ngrok call anywhere in this file.
colab_service.app._run_generation is monkeypatched with a fake before
every test that reaches /generate; the real colab_service.pipeline.run_generation
is never executed here (see app.py's own docstring for why that
substitution point exists).
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import colab_service.app as app_module
from colab_service.app import app

client = TestClient(
    app,
    # Starlette's ServerErrorMiddleware sends the response through a
    # registered Exception handler AND THEN re-raises the original
    # exception (for interactive debugging convenience) — TestClient's
    # own default (raise_server_exceptions=True) turns that re-raise
    # into a raised Python exception at the test call site, hiding the
    # actual sanitized response app.py's own handler produced. False
    # here is what makes response.status_code/response.json() reflect
    # what a real client over HTTP would actually receive.
    raise_server_exceptions=False,
)

NOTEBOOK_PATH = Path(__file__).resolve().parents[1] / "ClearSpace_Image_Gen.ipynb"


def _png_bytes(color=(10, 20, 30), size=(8, 8)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="PNG")
    return buf.getvalue()


PNG_BYTES = _png_bytes()
PNG_B64 = base64.b64encode(PNG_BYTES).decode("ascii")


class FakeGenerationResult:
    def __init__(
        self,
        image_bytes: bytes,
        generation_ms: float = 42.0,
        base_model: str = "fake-base",
        controlnet_model: str = "fake-controlnet",
    ) -> None:
        self.image_bytes = image_bytes
        self.generation_ms = generation_ms
        self.base_model = base_model
        self.controlnet_model = controlnet_model


class FakeGenerationRecorder:
    """Matches colab_service.pipeline.run_generation's own keyword-only
    signature. Records every call for assertion; never touches a real
    pipeline, torch, or GPU."""

    def __init__(self, result: FakeGenerationResult | None = None, exception: Exception | None = None) -> None:
        self.calls: list[dict] = []
        self._result = result
        self._exception = exception

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if self._exception is not None:
            raise self._exception
        if self._result is not None:
            return self._result
        return FakeGenerationResult(_png_bytes(color=(99, 99, 99)))


@pytest.fixture(autouse=True)
def _reset_state():
    """Every test starts from a clean, deterministic state — never
    inherits readiness, lock, or generation-fake state from a previous
    test."""
    app_module._state.ready = False
    app_module._state.base_model_id = None
    app_module._state.controlnet_model_id = None
    app_module._run_generation = app_module.pipeline.run_generation
    if app_module._generation_lock.locked():
        app_module._generation_lock.release()
    yield
    app_module._state.ready = False
    if app_module._generation_lock.locked():
        app_module._generation_lock.release()


def _mark_ready() -> None:
    app_module._state.ready = True
    app_module._state.base_model_id = "fake-base"
    app_module._state.controlnet_model_id = "fake-controlnet"


def _valid_body(**overrides) -> dict:
    body = dict(
        api_version="v1",
        run_id="run1",
        prompt="a tidy bedroom",
        negative_prompt=None,
        image=PNG_B64,
        image_media_type="image/png",
        denoise_strength=0.35,
        controlnet_conditioning_scale=1.0,
        seed=42,
    )
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


def test_health_unready_never_reports_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] != "ok"


def test_health_ready_exact_success_body():
    _mark_ready()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "api_version": "v1",
        "service_version": app_module.config.get_settings().service_version,
        "capabilities": {"depth_controlnet": True},
    }


# ---------------------------------------------------------------------------
# POST /generate — not ready
# ---------------------------------------------------------------------------


def test_generate_returns_503_when_not_ready():
    response = client.post("/generate", json=_valid_body())
    assert response.status_code == 503
    assert "error" in response.json()


def test_generate_not_ready_never_calls_the_generation_function():
    fake = FakeGenerationRecorder()
    app_module._run_generation = fake
    client.post("/generate", json=_valid_body())
    assert fake.calls == []


# ---------------------------------------------------------------------------
# POST /generate — success, exact response shape
# ---------------------------------------------------------------------------


def test_generate_success_exact_14_fields():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()

    response = client.post("/generate", json=_valid_body())

    assert response.status_code == 200
    body = response.json()
    assert set(body.keys()) == set(app_module.schemas.RESPONSE_KEYS)
    assert len(body) == 14


def test_generate_response_media_type_is_png_and_genuinely_decodes():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()

    response = client.post("/generate", json=_valid_body())
    body = response.json()

    assert body["image_media_type"] == "image/png"
    decoded = base64.b64decode(body["image"])
    img = Image.open(io.BytesIO(decoded))
    assert img.format == "PNG"


def test_generate_depth_map_used_always_true():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()
    response = client.post("/generate", json=_valid_body())
    assert response.json()["depth_map_used"] is True


def test_generate_api_version_is_v1():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()
    response = client.post("/generate", json=_valid_body())
    assert response.json()["api_version"] == "v1"


# ---------------------------------------------------------------------------
# POST /generate — argument forwarding to the (fake) pipeline
# ---------------------------------------------------------------------------


def test_generate_forwards_exact_prompt_negative_prompt_seed_strength_scale():
    _mark_ready()
    fake = FakeGenerationRecorder()
    app_module._run_generation = fake

    client.post(
        "/generate",
        json=_valid_body(
            prompt="a cosy bedroom",
            negative_prompt="blurry, dark",
            seed=7,
            denoise_strength=0.5,
            controlnet_conditioning_scale=1.5,
        ),
    )

    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["prompt"] == "a cosy bedroom"
    assert call["negative_prompt"] == "blurry, dark"
    assert call["seed"] == 7
    assert call["denoise_strength"] == 0.5
    assert call["controlnet_conditioning_scale"] == 1.5


def test_generate_forwards_a_real_rgb_image_derived_from_the_request():
    _mark_ready()
    fake = FakeGenerationRecorder()
    app_module._run_generation = fake

    client.post("/generate", json=_valid_body())

    assert len(fake.calls) == 1
    forwarded_image = fake.calls[0]["image"]
    assert forwarded_image.mode == "RGB"


def test_generate_negative_prompt_none_is_forwarded_as_none():
    _mark_ready()
    fake = FakeGenerationRecorder()
    app_module._run_generation = fake

    client.post("/generate", json=_valid_body(negative_prompt=None))

    assert fake.calls[0]["negative_prompt"] is None


def test_generate_forwards_settings():
    _mark_ready()
    fake = FakeGenerationRecorder()
    app_module._run_generation = fake

    client.post("/generate", json=_valid_body())

    assert fake.calls[0]["settings"] is app_module.config.get_settings()


# ---------------------------------------------------------------------------
# POST /generate — correct hashes and echoed values
# ---------------------------------------------------------------------------


def test_generate_correct_hashes():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()

    response = client.post("/generate", json=_valid_body(prompt="a tidy bedroom"))
    body = response.json()

    assert body["prompt_sha256"] == hashlib.sha256("a tidy bedroom".encode("utf-8")).hexdigest()
    assert body["input_image_sha256"] == hashlib.sha256(PNG_BYTES).hexdigest()


def test_generate_prompt_hash_uses_the_normalized_trimmed_prompt():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()

    response = client.post("/generate", json=_valid_body(prompt="  a tidy bedroom  "))
    body = response.json()

    # the request's own validator trims outer whitespace -- the hash
    # must reflect the NORMALIZED value, not the raw wire value
    assert body["prompt_sha256"] == hashlib.sha256("a tidy bedroom".encode("utf-8")).hexdigest()


def test_generate_echoes_exact_run_id_seed_strength_scale():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()

    response = client.post(
        "/generate",
        json=_valid_body(run_id="run-xyz", seed=99, denoise_strength=0.6, controlnet_conditioning_scale=1.2),
    )
    body = response.json()

    assert body["run_id"] == "run-xyz"
    assert body["seed"] == 99
    assert body["denoise_strength"] == 0.6
    assert body["controlnet_conditioning_scale"] == 1.2


def test_generate_echoes_actual_loaded_model_identifiers_not_configured_defaults():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder(
        result=FakeGenerationResult(PNG_BYTES, base_model="real-base-actually-loaded", controlnet_model="real-controlnet-actually-loaded")
    )

    response = client.post("/generate", json=_valid_body())
    body = response.json()

    assert body["base_model"] == "real-base-actually-loaded"
    assert body["controlnet_model"] == "real-controlnet-actually-loaded"


def test_generate_uses_service_version_from_settings():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()
    response = client.post("/generate", json=_valid_body())
    assert response.json()["service_version"] == app_module.config.get_settings().service_version


def test_generate_ms_reflects_the_fake_pipelines_reported_timing():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder(result=FakeGenerationResult(PNG_BYTES, generation_ms=1234.5))
    response = client.post("/generate", json=_valid_body())
    assert response.json()["generation_ms"] == 1234.5


# ---------------------------------------------------------------------------
# POST /generate — concurrency
# ---------------------------------------------------------------------------


def test_generate_returns_503_immediately_when_lock_already_held():
    _mark_ready()
    app_module._generation_lock.acquire()  # simulate another generation already in flight
    try:
        response = client.post("/generate", json=_valid_body())
        assert response.status_code == 503
        assert response.json() == {"error": "busy"}
    finally:
        app_module._generation_lock.release()


def test_generate_busy_lock_never_calls_the_generation_function():
    _mark_ready()
    fake = FakeGenerationRecorder()
    app_module._run_generation = fake
    app_module._generation_lock.acquire()
    try:
        client.post("/generate", json=_valid_body())
    finally:
        app_module._generation_lock.release()
    assert fake.calls == []


def test_generate_releases_lock_after_success():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()
    client.post("/generate", json=_valid_body())
    assert not app_module._generation_lock.locked()


def test_generate_releases_lock_after_pipeline_failure():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder(exception=RuntimeError("fake pipeline failure"))
    client.post("/generate", json=_valid_body())
    assert not app_module._generation_lock.locked()


def test_generate_allows_a_new_request_after_the_lock_is_released():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder()
    first = client.post("/generate", json=_valid_body())
    second = client.post("/generate", json=_valid_body())
    assert first.status_code == 200
    assert second.status_code == 200


def test_generate_returns_sanitized_422_when_output_is_flagged_unsafe():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder(
        exception=app_module.pipeline.UnsafeOutputError("generated output was flagged")
    )
    response = client.post("/generate", json=_valid_body(prompt="a prompt that must never leak"))
    assert response.status_code == 422
    assert response.json() == {"error": "generated output failed safety check"}
    assert "a prompt that must never leak" not in response.text


def test_generate_releases_lock_after_unsafe_output():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder(exception=app_module.pipeline.UnsafeOutputError("flagged"))
    client.post("/generate", json=_valid_body())
    assert not app_module._generation_lock.locked()


# ---------------------------------------------------------------------------
# Sanitized failures
# ---------------------------------------------------------------------------


def test_unhandled_pipeline_exception_returns_sanitized_500():
    _mark_ready()
    app_module._run_generation = FakeGenerationRecorder(
        exception=RuntimeError("some real internal detail that must never leak")
    )
    response = client.post("/generate", json=_valid_body())
    assert response.status_code == 500
    assert response.json() == {"error": "internal error"}
    assert "real internal detail" not in response.text
    assert "RuntimeError" not in response.text
    assert "Traceback" not in response.text


def test_validation_error_never_echoes_the_bad_image_value():
    huge_bad_image = "not-valid-base64!!!" * 50
    response = client.post("/generate", json=_valid_body(image=huge_bad_image))
    assert response.status_code == 422
    assert huge_bad_image not in response.text


def test_validation_error_never_echoes_the_prompt_value():
    response = client.post("/generate", json=_valid_body(prompt="a secret prompt value that must not leak", image="not-valid-base64!!!"))
    assert response.status_code == 422
    assert "a secret prompt value" not in response.text


def test_validation_error_reports_field_names_only():
    response = client.post("/generate", json=_valid_body(prompt="   ", image=PNG_B64))
    assert response.status_code == 422
    body = response.json()
    assert set(body.keys()) == {"error", "fields"}
    assert "prompt" in body["fields"]


def test_validation_error_never_echoes_a_malformed_extra_field_value():
    body = _valid_body()
    body["some_unexpected_field"] = "a value that must never be echoed back"
    response = client.post("/generate", json=body)
    assert response.status_code == 422
    assert "a value that must never be echoed back" not in response.text


# ---------------------------------------------------------------------------
# Import safety — no model loading / heavyweight imports at import time
# ---------------------------------------------------------------------------


def test_importing_app_does_not_load_torch_diffusers_or_controlnet_aux():
    repo_root = Path(__file__).resolve().parents[2]
    code = (
        "import sys\n"
        "import colab_service.app\n"
        "heavy = {'torch', 'diffusers', 'controlnet_aux'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(repo_root))
    assert result.returncode == 0, result.stdout + result.stderr


def test_importing_app_does_not_set_ready_or_touch_state():
    repo_root = Path(__file__).resolve().parents[2]
    code = "import colab_service.app as app_module\nassert app_module._state.ready is False\n"
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(repo_root))
    assert result.returncode == 0, result.stdout + result.stderr


# ---------------------------------------------------------------------------
# Notebook — valid JSON, no secret values
# ---------------------------------------------------------------------------


def _load_notebook() -> dict:
    assert NOTEBOOK_PATH.exists(), f"expected {NOTEBOOK_PATH} to exist"
    return json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))


def _notebook_rendered_text() -> str:
    """Joins every cell's source lines into one plain-text string, one
    cell's content at a time. Deliberately NOT the raw on-disk JSON text
    (NOTEBOOK_PATH.read_text()) — JSON escapes embedded double-quotes
    (Python code containing "..." becomes \\"...\\" on disk) and a
    markdown paragraph line-wrapped across multiple source-array entries
    reads as separate JSON strings — both defeat a naive raw-file
    substring search even though the ACTUAL rendered content (what
    Jupyter, or a person reading the notebook, sees) is exactly right.
    This reconstructs that actual rendered content instead."""
    notebook = _load_notebook()
    return "\n".join("".join(cell["source"]) for cell in notebook["cells"])


def test_notebook_parses_as_valid_json():
    notebook = _load_notebook()
    assert notebook["nbformat"] == 4
    assert len(notebook["cells"]) > 0
    for cell in notebook["cells"]:
        assert cell["cell_type"] in ("markdown", "code")


def test_notebook_contains_no_real_secret_values():
    text = _notebook_rendered_text()
    # Only secret NAMES belong in the notebook, never a real value —
    # these are common real-world token/credential shapes that must
    # never appear literally in committed source.
    forbidden_patterns = [
        "ghp_",  # a real GitHub personal access token prefix
        "github_pat_",
        "sk-",  # a common API-key prefix convention
        "eyJhbGciOi",  # a base64-encoded JWT header ({"alg":...)
    ]
    for pattern in forbidden_patterns:
        assert pattern not in text, f"notebook must never contain a real secret-shaped value: {pattern!r}"


def test_notebook_only_reads_secrets_never_hardcodes_them():
    text = _notebook_rendered_text()
    assert "userdata.get(" in text  # reads from Colab Secrets
    assert "getpass" in text  # falls back to masked interactive entry
    assert "GITHUB_TOKEN" in text
    assert "NGROK_AUTHTOKEN" in text
    assert "NGROK_DOMAIN" in text


def test_notebook_authenticates_clone_via_process_local_git_config_not_the_url():
    text = _notebook_rendered_text()
    # The credential must be passed via process-local git config scoped
    # to the clone subprocess's own environment -- never embedded in the
    # clone URL itself, never a global os.environ assignment, never a
    # persisted .git/config file.
    assert "GIT_CONFIG_COUNT" in text
    assert "GIT_CONFIG_KEY_0" in text and "http.extraHeader" in text
    assert "GIT_CONFIG_VALUE_0" in text and "Authorization: Basic" in text
    assert "env=clone_env" in text
    # The clone URL itself must be the clean, credential-free one -- the
    # token is never interpolated into it (an f-string like
    # f"https://{GITHUB_TOKEN}@..." must not appear anywhere).
    assert "@github.com" not in text
    assert '"git", "clone", REPO_URL' in text


def test_notebook_refuses_to_reuse_an_existing_checkout():
    text = _notebook_rendered_text()
    assert "REPO_DIR.exists()" in text
    assert "never reuses a" in text  # the explicit refusal message
    assert "never deletes" in text  # never auto-deletes an existing checkout


def test_notebook_discards_the_clone_environment_and_token_afterward():
    text = _notebook_rendered_text()
    assert "del clone_env" in text
    assert "del credential" in text
    assert "GITHUB_TOKEN = None" in text


def test_notebook_polls_health_instead_of_a_fixed_sleep():
    text = _notebook_rendered_text()
    assert "_poll_local_health" in text
    assert "time.sleep(3)" not in text  # the old fixed-wait must be gone
    assert "attempts" in text and "RequestException" in text


def test_notebook_documents_that_closing_the_tab_is_not_enough_cleanup():
    text = _notebook_rendered_text()
    assert "NOT sufficient" in text or "not sufficient" in text.lower()
    assert "Colab: Remove Server" in text
    assert "ngrok.disconnect" in text and "ngrok.kill" in text


# ---------------------------------------------------------------------------
# Notebook — startup-hardening regression tests
# ---------------------------------------------------------------------------


def test_notebook_rejects_blank_secrets():
    """_get_secret() must reject an empty/whitespace-only value from
    EITHER the userdata.get() path or the getpass.getpass() fallback,
    never silently proceed with a blank secret."""
    text = _notebook_rendered_text()
    assert "value.strip()" in text
    assert "a real, non-blank secret value is required" in text


def test_notebook_clears_github_token_on_every_exit_path():
    """The finally: that clears GITHUB_TOKEN must be OUTSIDE (wrap) the
    REPO_DIR.exists() check itself, not just the later clone attempt --
    so a stale-directory failure (which raises before any clone is
    attempted) still reaches it. Checked positionally: an outer `try:`
    must open before the exists-check, and `GITHUB_TOKEN = None` must
    appear only after it."""
    text = _notebook_rendered_text()
    assert "Cleared on EVERY exit path from this cell" in text
    exists_idx = text.index("REPO_DIR.exists()")
    outer_try_idx = text.rindex("try:", 0, exists_idx)
    clear_idx = text.index("GITHUB_TOKEN = None")
    assert outer_try_idx < exists_idx < clear_idx


def test_notebook_excludes_ngrok_secrets_from_clone_subprocess_env():
    """clone_env must be a FILTERED copy of os.environ (excluding
    NGROK_AUTHTOKEN/NGROK_DOMAIN, which are already plain env vars by
    that point), never the raw dict(os.environ) -- the clone subprocess
    has no reason to see the ngrok secrets at all."""
    text = _notebook_rendered_text()
    assert "dict(os.environ)" not in text
    assert 'NGROK_AUTHTOKEN", "NGROK_DOMAIN"' in text


def test_notebook_health_poll_requires_the_full_compatible_body_not_any_200():
    """_poll_local_health() must keep retrying through a legitimate
    {"status": "loading"} 200 (or any other incomplete/incompatible
    body), not return on the first successful HTTP response -- mirrors
    app.models.image_gen_client.check_health()'s exact criteria."""
    text = _notebook_rendered_text()
    assert "_is_compatible_health_body" in text
    assert 'data.get("status") != "ok"' in text
    assert 'data.get("api_version") != app_module.schemas.API_VERSION' in text
    assert 'capabilities.get("depth_controlnet") is not True' in text


def test_notebook_polls_health_before_opening_ngrok_tunnel():
    """The public ngrok URL must never be exposed before the local
    service has been confirmed genuinely ready -- _poll_local_health()
    must be called before ngrok.connect(), not after."""
    text = _notebook_rendered_text()
    poll_idx = text.index("local_health = _poll_local_health()")
    connect_idx = text.index("ngrok.connect(")
    assert poll_idx < connect_idx


def test_notebook_health_poll_requires_2xx_status_as_its_own_gate():
    """A non-2xx response (e.g. a 503 with an incidentally "ok"-shaped
    JSON body) must not be accepted just because the body happens to
    parse -- the status-code check must be a distinct gate, checked
    before the body is even parsed as JSON."""
    text = _notebook_rendered_text()
    assert "200 <= response.status_code < 300" in text


def test_notebook_health_poll_never_stores_the_raw_response_in_last_state():
    """When a health body fails _is_compatible_health_body, last_state
    must be set to a fixed, bounded description -- never the raw parsed
    `data` dict itself (which could otherwise flow, unbounded and
    unsanitized, into the eventual RuntimeError's f-string on
    exhaustion)."""
    text = _notebook_rendered_text()
    assert 'last_state = "incompatible health response"' in text
    assert "last_state = data" not in text


# ---------------------------------------------------------------------------
# Notebook — clone authentication: HTTP Basic, not Bearer
# ---------------------------------------------------------------------------


def test_notebook_constructs_http_basic_credential_from_username_and_token():
    text = _notebook_rendered_text()
    assert 'GITHUB_USERNAME = "yxnmei"' in text
    assert "base64.b64encode" in text
    assert 'f"{GITHUB_USERNAME}:{GITHUB_TOKEN}"' in text
    assert '.decode("ascii")' in text
    assert 'f"Authorization: Basic {credential}"' in text


def test_notebook_never_sends_bearer_authorization_for_the_clone():
    text = _notebook_rendered_text()
    assert "Authorization: Bearer" not in text


def test_notebook_never_places_credentials_in_the_git_command_argv():
    text = _notebook_rendered_text()
    assert '["git", "clone", REPO_URL, str(REPO_DIR)]' in text


def test_notebook_clears_the_encoded_credential_on_every_clone_exit_path():
    text = _notebook_rendered_text()
    del_clone_env_idx = text.index("del clone_env")
    del_credential_idx = text.index("del credential")
    finally_idx = text.rindex("finally:", 0, min(del_clone_env_idx, del_credential_idx) + 1)
    assert finally_idx < del_clone_env_idx
    assert finally_idx < del_credential_idx
