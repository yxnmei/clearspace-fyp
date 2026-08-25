"""
System/API tests for POST /transcribe.

Fakes at the model boundary only: the real transcriber is replaced
through the get_transcriber_provider dependency seam via
app.dependency_overrides — never by monkeypatching a module-level name.
Audio is genuine (stdlib-synthesised WAV) and is really decoded, so the
route, the validation layer and the single-flight guard are all
exercised for real; only the model is fake.

No model, no weights, no socket, no download.
"""

from __future__ import annotations

import io
import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.routes import get_transcriber_provider
from app.config import Settings
from app.main import app
from app.models.whisper_stt import (
    TranscriberUnavailableError,
    TranscriptionFailedError,
    TranscriptResult,
)
from app.services import transcription_service
from app.api import routes as routes_module

_BACKEND_DIR = Path(__file__).resolve().parents[2]

client = TestClient(app)

# A second client that returns the 500 instead of re-raising, so a
# genuine programming defect can be asserted as a 500 rather than as a
# sanitized "service unavailable".
raw_client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _clean_state():
    yield
    app.dependency_overrides.clear()
    # The default guard is process-stable by design (no reset hook), so
    # any test that takes it must give it back. Prove that here rather
    # than papering over a leak with a fresh instance.
    guard = transcription_service.get_single_flight()
    assert guard.try_acquire() is True, "a test leaked the transcription slot"
    guard.release()


def wav_bytes(seconds: float = 0.5, rate: int = 16000, channels: int = 1) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        frames = bytearray()
        for i in range(int(rate * seconds)):
            value = int(3000 * math.sin(2 * math.pi * 440 * i / rate))
            frames += struct.pack("<" + "h" * channels, *([value] * channels))
        writer.writeframes(bytes(frames))
    return buf.getvalue()


def override_transcriber(fake):
    """Replace the LOADER behind the dependency seam. The route hands the
    loader to the service, which resolves it only after validation."""
    app.dependency_overrides[get_transcriber_provider] = lambda: (lambda: fake)


def fake_result(text="hello there", model_name="whisper-base", ms=12.5, duration=None):
    """By default the fake echoes the duration of the audio it was
    actually given, because the service now checks that a result belongs
    to the audio it was produced from. `duration` forces a mismatch."""

    def _transcribe(decoded, **kwargs):
        return TranscriptResult(
            text=text,
            model_name=model_name,
            transcription_ms=ms,
            audio_duration_s=decoded.duration_s if duration is None else duration,
        )

    return _transcribe


def post(audio=None, content_type="audio/wav", filename="clip.wav"):
    payload = wav_bytes(0.5) if audio is None else audio
    return client.post(
        "/transcribe", files={"audio": (filename, io.BytesIO(payload), content_type)}
    )


# --- success --------------------------------------------------------------


def test_success_returns_the_exact_contract():
    override_transcriber(fake_result())
    response = post()

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "transcript": "hello there",
        "model_name": "whisper-base",
        "transcription_ms": 12.5,
        "audio_duration_s": 0.5,
    }
    assert "truncated" not in body  # rejected, never truncated


def test_blank_transcript_is_a_success_not_an_error():
    """Silence is a legitimate recording, not a server failure."""
    override_transcriber(fake_result(text=""))
    response = post()

    assert response.status_code == 200
    assert response.json()["transcript"] == ""


def test_the_route_receives_genuinely_decoded_audio():
    seen = {}

    def _transcribe(decoded, **kwargs):
        seen["sample_rate"] = decoded.sample_rate
        seen["ndim"] = decoded.waveform.ndim
        seen["dtype"] = decoded.waveform.dtype.name
        seen["model_name"] = kwargs["model_name"]
        return TranscriptResult("ok", "whisper-base", 1.0, decoded.duration_s)

    override_transcriber(_transcribe)
    assert post(audio=wav_bytes(0.75, rate=44100, channels=2)).status_code == 200
    assert seen == {
        "sample_rate": 16000,
        "ndim": 1,
        "dtype": "float32",
        "model_name": "whisper-base",
    }


def test_browser_content_type_with_codec_parameters_is_accepted():
    """A parameterised Content-Type must not be what rejects an upload."""
    override_transcriber(fake_result())
    response = client.post(
        "/transcribe",
        files={"audio": ("clip.wav", io.BytesIO(wav_bytes(0.3)), "audio/wav;codecs=1")},
    )
    assert response.status_code == 200


def test_a_container_that_contradicts_its_declared_type_is_415():
    """Real WAV bytes announced as audio/webm. Both are supported types
    and the bytes decode fine — only the cross-check catches it."""
    override_transcriber(fake_result())
    response = post(content_type="audio/webm")

    assert response.status_code == 415
    assert response.json()["detail"] == "audio does not match its declared format"


def test_the_container_mismatch_detail_exposes_no_decoder_strings():
    override_transcriber(fake_result())
    body = post(content_type="audio/webm").text
    assert "matroska" not in body
    assert "wav" not in body.lower().replace("clip.wav", "")


# --- error mapping --------------------------------------------------------


def test_unsupported_media_type_is_415():
    override_transcriber(fake_result())
    response = post(content_type="text/plain")

    assert response.status_code == 415
    assert response.json()["detail"] == "audio format is not supported"


def test_malformed_audio_is_400():
    override_transcriber(fake_result())
    response = post(audio=b"this is not audio at all")

    assert response.status_code == 400
    assert response.json()["detail"] == "audio could not be read"


def test_empty_upload_is_400():
    override_transcriber(fake_result())
    assert post(audio=b"").status_code == 400


def test_oversized_upload_is_413_before_any_decode(monkeypatch):
    """Rejected on the bounded read, so the decoder never runs."""
    monkeypatch.setattr(
        routes_module, "get_settings", lambda: Settings(stt_max_upload_bytes=128)
    )

    def _explode(*args, **kwargs):
        raise AssertionError("must not decode an oversized upload")

    monkeypatch.setattr(routes_module, "transcribe_audio", _explode)
    override_transcriber(fake_result())

    response = post(audio=wav_bytes(1.0))
    assert response.status_code == 413
    assert response.json()["detail"] == "audio upload is too large"


def test_upload_exactly_at_the_byte_limit_is_accepted(monkeypatch):
    payload = wav_bytes(0.2)
    monkeypatch.setattr(
        routes_module, "get_settings", lambda: Settings(stt_max_upload_bytes=len(payload))
    )
    override_transcriber(fake_result())

    assert post(audio=payload).status_code == 200


def test_over_long_audio_is_413(monkeypatch):
    monkeypatch.setattr(routes_module, "get_settings", lambda: Settings(stt_max_audio_seconds=1))
    override_transcriber(fake_result())

    response = post(audio=wav_bytes(3.0))
    assert response.status_code == 413
    assert response.json()["detail"] == "audio is too long"


def test_busy_is_503_with_retry_after():
    guard = transcription_service.get_single_flight()
    override_transcriber(fake_result())
    assert guard.try_acquire() is True
    try:
        response = post()
    finally:
        guard.release()

    assert response.status_code == 503
    assert response.json()["detail"] == "transcription is busy"
    assert response.headers["Retry-After"] == "5"


def test_unavailable_model_is_503():
    def _unavailable(decoded, **kwargs):
        raise TranscriberUnavailableError("speech-to-text weights are not available locally")

    override_transcriber(_unavailable)
    response = post()

    assert response.status_code == 503
    assert response.json()["detail"] == "transcription is unavailable"


def test_bounded_transcription_failure_is_503():
    def _failed(decoded, **kwargs):
        raise TranscriptionFailedError("transcription failed")

    override_transcriber(_failed)
    assert post().status_code == 503


def test_a_malformed_model_result_cannot_escape_as_a_200():
    """A backend returning NaN, a negative duration or a blank model name
    must not reach the browser inside a 200."""

    class Bogus:
        text = "hello"
        model_name = "   "
        transcription_ms = float("nan")
        audio_duration_s = -1.0

    override_transcriber(lambda decoded, **kwargs: Bogus())
    response = post()

    assert response.status_code == 503
    assert response.json()["detail"] == "transcription is unavailable"


def test_a_result_missing_fields_cannot_escape_as_a_200():
    override_transcriber(lambda decoded, **kwargs: object())
    assert post().status_code == 503


@pytest.mark.parametrize(
    "field, value",
    [
        ("transcription_ms", True),          # bool: an int subclass, would pass as 1.0
        ("transcription_ms", float("nan")),
        ("transcription_ms", float("inf")),
        ("transcription_ms", -1.0),
        ("audio_duration_s", True),
        ("audio_duration_s", float("nan")),
        ("audio_duration_s", -0.5),
    ],
)
def test_bool_and_non_finite_result_numbers_are_rejected(field, value):
    def _transcribe(decoded, **kwargs):
        values = {
            "text": "hi",
            "model_name": "whisper-base",
            "transcription_ms": 1.0,
            "audio_duration_s": decoded.duration_s,
        }
        values[field] = value
        return TranscriptResult(**values)

    override_transcriber(_transcribe)
    assert post().status_code == 503


def test_a_result_for_a_different_model_is_rejected():
    """A backend that quietly answered for another model would silently
    invalidate anything built on the model_name field."""
    override_transcriber(fake_result(model_name="faster-whisper-base"))
    assert post().status_code == 503


def test_a_result_whose_duration_disagrees_with_the_audio_is_rejected():
    """Catches a result stitched to the wrong audio."""
    override_transcriber(fake_result(duration=99.0))
    assert post().status_code == 503


# --- unrelated failures must NOT be dressed up as service outages ---------


@pytest.mark.parametrize(
    "boom",
    [
        ValueError("a plain programming defect"),
        AssertionError("an invariant broke"),
        TypeError("wrong argument"),
        KeyError("missing"),
    ],
)
def test_an_unrelated_exception_is_not_reported_as_an_expected_503(boom):
    """Reporting a bug as "transcription is unavailable" tells the user to
    retry a fault that retrying can never clear, and hides the defect. It
    must surface as a 500."""

    def _boom(decoded, **kwargs):
        raise boom

    override_transcriber(_boom)
    response = raw_client.post(
        "/transcribe", files={"audio": ("clip.wav", io.BytesIO(wav_bytes(0.3)), "audio/wav")}
    )

    assert response.status_code == 500
    assert "transcription is unavailable" not in response.text


def test_an_unrelated_loader_exception_is_not_reported_as_an_expected_503():
    def _provider():
        def _loader():
            raise ValueError("loader defect")

        return _loader

    app.dependency_overrides[get_transcriber_provider] = _provider
    response = raw_client.post(
        "/transcribe", files={"audio": ("clip.wav", io.BytesIO(wav_bytes(0.3)), "audio/wav")}
    )
    assert response.status_code == 500


def test_the_slot_is_released_after_an_unrelated_exception():
    """Even an unexpected defect must not wedge the endpoint."""

    def _boom(decoded, **kwargs):
        raise ValueError("defect")

    override_transcriber(_boom)
    raw_client.post(
        "/transcribe", files={"audio": ("clip.wav", io.BytesIO(wav_bytes(0.3)), "audio/wav")}
    )

    override_transcriber(fake_result())
    assert post().status_code == 200


def test_no_error_detail_leaks_internals():
    def _leaky(decoded, **kwargs):
        raise TranscriberUnavailableError("C:/Users/secret/.cache/whisper/base.pt missing")

    override_transcriber(_leaky)
    body = post().text

    assert "secret" not in body
    assert "base.pt" not in body
    assert "Users" not in body


def test_missing_audio_field_is_422():
    override_transcriber(fake_result())
    assert client.post("/transcribe", data={}).status_code == 422


# --- the dependency seam and the import boundary --------------------------


def test_the_transcriber_is_resolved_through_the_dependency_seam():
    """Overriding get_transcriber_provider must be sufficient — if the
    route reached the real loader anyway, this would attempt a model
    load."""
    calls = {"count": 0}

    def _transcribe(decoded, **kwargs):
        calls["count"] += 1
        return TranscriptResult("via seam", "whisper-base", 1.0, 0.5)

    override_transcriber(_transcribe)
    assert post().json()["transcript"] == "via seam"
    assert calls["count"] == 1


def test_the_loader_is_not_called_until_a_request_arrives():
    """get_transcriber_provider returns a LOADER; resolving the dependency
    must not itself import or load a model."""
    resolved = {"count": 0}

    def _provider():
        def _loader():
            resolved["count"] += 1
            return fake_result()

        return _loader

    app.dependency_overrides[get_transcriber_provider] = _provider
    assert resolved["count"] == 0
    post()
    assert resolved["count"] == 1


@pytest.mark.parametrize(
    "audio, content_type",
    [
        (b"garbage", "audio/wav"),
        (b"", "audio/wav"),
        (None, "text/plain"),
        (None, "audio/webm"),  # real WAV under a contradicting declared type
    ],
)
def test_a_rejected_upload_never_resolves_the_transcriber(audio, content_type):
    """The loader is where a model module is imported and a model loaded.
    A request that is going to be rejected must never reach it."""
    resolved = {"count": 0}

    def _provider():
        def _loader():
            resolved["count"] += 1
            return fake_result()

        return _loader

    app.dependency_overrides[get_transcriber_provider] = _provider
    response = post(audio=audio, content_type=content_type)

    assert response.status_code in {400, 415}
    assert resolved["count"] == 0


def test_a_failing_loader_is_a_503_and_leaves_the_slot_free():
    def _provider():
        def _loader():
            raise TranscriberUnavailableError("weights are not available locally")

        return _loader

    app.dependency_overrides[get_transcriber_provider] = _provider
    assert post().status_code == 503

    # The slot must be reusable straight away.
    override_transcriber(fake_result())
    assert post().status_code == 200


def test_importing_routes_loads_no_speech_model_stack():
    """A fresh interpreter importing the API must not pull in whisper,
    faster-whisper, torch, CTranslate2 or PyAV."""
    code = (
        "import sys\n"
        "import app.api.routes\n"
        "heavy = {'whisper', 'faster_whisper', 'torch', 'ctranslate2', 'av'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr
