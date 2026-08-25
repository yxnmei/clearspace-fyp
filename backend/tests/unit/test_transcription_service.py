"""
Unit tests for app/services/transcription_service.py.

Fakes only: the transcriber is injected, so no model is ever resolved or
loaded, and the single-flight guard is constructed per test rather than
inherited from whatever a previous test left behind.
"""

from __future__ import annotations

import io
import math
import struct
import threading
import wave

import pytest

from app.core.audio_decode import (
    AudioTooLongError,
    DecodedAudio,
    MalformedAudioError,
    UnsupportedAudioTypeError,
)
from app.services import transcription_service
from app.services.transcription_service import (
    SingleFlight,
    TranscriptionBusyError,
    get_single_flight,
    transcribe_audio,
)


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


def assert_slot_free(guard: SingleFlight) -> None:
    """The only correct way to observe a release: take the slot. There is
    deliberately no `in_use` predicate to consult — any answer it gave
    would be stale the moment it returned."""
    assert guard.try_acquire() is True, "slot was not released"
    guard.release()


class RecordingTranscriber:
    def __init__(self, result="RESULT", error: Exception | None = None) -> None:
        self.result = result
        self.error = error
        self.calls: list[tuple] = []

    def __call__(self, decoded, **kwargs):
        self.calls.append((decoded, kwargs))
        if self.error is not None:
            raise self.error
        return self.result


class RecordingLoader:
    """A zero-arg loader, the shape the service now takes. Counting the
    resolutions is what proves a rejected upload never reaches one."""

    def __init__(self, transcriber=None, error: Exception | None = None) -> None:
        self.transcriber = transcriber if transcriber is not None else RecordingTranscriber()
        self.error = error
        self.resolutions = 0

    def __call__(self):
        self.resolutions += 1
        if self.error is not None:
            raise self.error
        return self.transcriber


_UNSET = object()  # so `audio=None` stays a real test case, not "use the default"


def call(
    loader,
    *,
    audio=_UNSET,
    media_type="audio/wav",
    max_audio_seconds=60,
    guard=None,
    validate_result=None,
):
    return transcribe_audio(
        wav_bytes(0.3) if audio is _UNSET else audio,
        media_type,
        loader,
        model_name="whisper-base",
        max_audio_seconds=max_audio_seconds,
        guard=guard,
        validate_result=validate_result,
    )


# --- composition ----------------------------------------------------------


def test_decodes_then_transcribes_and_returns_the_result():
    transcriber = RecordingTranscriber(result="TRANSCRIPT")
    assert call(RecordingLoader(transcriber)) == "TRANSCRIPT"

    decoded, kwargs = transcriber.calls[0]
    assert isinstance(decoded, DecodedAudio)
    assert decoded.sample_rate == 16000
    assert decoded.waveform.ndim == 1
    assert kwargs["model_name"] == "whisper-base"


def test_configuration_is_forwarded_to_the_transcriber():
    transcriber = RecordingTranscriber()
    transcribe_audio(
        wav_bytes(0.2),
        "audio/wav",
        RecordingLoader(transcriber),
        model_name="faster-whisper-base",
        max_audio_seconds=60,
        compute_type="float32",
        local_files_only=False,
    )
    _decoded, kwargs = transcriber.calls[0]
    assert kwargs == {
        "model_name": "faster-whisper-base",
        "compute_type": "float32",
        "local_files_only": False,
    }


# --- validation happens first ---------------------------------------------


@pytest.mark.parametrize(
    "audio, media_type, max_seconds, expected",
    [
        (b"", "audio/wav", 60, MalformedAudioError),
        (b"not audio", "audio/wav", 60, MalformedAudioError),
        (None, "audio/wav", 60, MalformedAudioError),
        (b"x", "text/plain", 60, UnsupportedAudioTypeError),
    ],
)
def test_invalid_audio_is_rejected(audio, media_type, max_seconds, expected):
    loader = RecordingLoader()
    with pytest.raises(expected):
        call(loader, audio=audio, media_type=media_type, max_audio_seconds=max_seconds)
    assert loader.resolutions == 0


def test_over_long_audio_is_rejected():
    loader = RecordingLoader()
    with pytest.raises(AudioTooLongError):
        call(loader, audio=wav_bytes(3.0), max_audio_seconds=1)
    assert loader.resolutions == 0


@pytest.mark.parametrize(
    "audio, media_type",
    [
        (b"garbage", "audio/wav"),
        (b"", "audio/wav"),
        (wav_bytes(0.2), "text/plain"),
        (wav_bytes(0.2), "audio/webm"),  # real WAV, wrong declared container
    ],
)
def test_invalid_audio_never_resolves_the_transcriber(audio, media_type):
    """The loader is where a model module gets imported and a model
    loaded. A rejected upload must never reach it — not to pay the cost,
    and not to hold the slot while a valid request is turned away."""
    loader = RecordingLoader(
        transcriber=lambda *a, **k: pytest.fail("transcriber called for invalid audio")
    )
    with pytest.raises(Exception):
        call(loader, audio=audio, media_type=media_type)
    assert loader.resolutions == 0


def test_invalid_audio_leaves_the_slot_free():
    guard = SingleFlight()
    with pytest.raises(UnsupportedAudioTypeError):
        call(RecordingLoader(), media_type="text/plain", guard=guard)
    assert_slot_free(guard)


def test_the_loader_is_resolved_only_after_the_slot_is_held():
    """Resolution inside the slot means two concurrent requests can never
    trigger two simultaneous model loads."""
    order: list[str] = []
    guard = SingleFlight()

    class OrderingGuard(SingleFlight):
        def try_acquire(self):
            acquired = super().try_acquire()
            order.append("acquire")
            return acquired

        def release(self):
            order.append("release")
            super().release()

    def loader():
        order.append("resolve")
        return lambda decoded, **kwargs: order.append("invoke") or "OK"

    transcribe_audio(
        wav_bytes(0.2),
        "audio/wav",
        loader,
        model_name="whisper-base",
        max_audio_seconds=60,
        guard=OrderingGuard(),
    )
    assert order == ["acquire", "resolve", "invoke", "release"]


# --- single flight --------------------------------------------------------


def test_slot_is_released_after_a_successful_call():
    guard = SingleFlight()
    call(RecordingLoader(), guard=guard)
    assert_slot_free(guard)


def test_slot_is_released_after_a_transcriber_failure():
    """Released in `finally`: a leaked slot would wedge the endpoint for
    the life of the process."""
    guard = SingleFlight()
    with pytest.raises(RuntimeError, match="model exploded"):
        call(RecordingLoader(RecordingTranscriber(error=RuntimeError("model exploded"))), guard=guard)
    assert_slot_free(guard)


def test_slot_is_released_when_the_LOADER_itself_fails():
    """Resolution happens inside the slot, so a failing loader is exactly
    the case a naive `finally` placement would leak."""
    guard = SingleFlight()
    with pytest.raises(RuntimeError, match="cannot load"):
        call(RecordingLoader(error=RuntimeError("cannot load")), guard=guard)
    assert_slot_free(guard)


def test_slot_is_released_after_a_result_validation_failure():
    guard = SingleFlight()

    def rejecting_validator(result, **kwargs):
        raise RuntimeError("contract violated")

    with pytest.raises(RuntimeError, match="contract violated"):
        call(RecordingLoader(), guard=guard, validate_result=rejecting_validator)
    assert_slot_free(guard)


def test_slot_is_released_after_an_unexpected_exception():
    guard = SingleFlight()
    with pytest.raises(KeyboardInterrupt):
        call(RecordingLoader(RecordingTranscriber(error=KeyboardInterrupt())), guard=guard)
    assert_slot_free(guard)


def test_a_second_concurrent_call_is_refused_immediately():
    """Non-blocking by design: the caller is told busy rather than joining
    a queue that could grow without bound."""
    guard = SingleFlight()
    assert guard.try_acquire() is True
    try:
        with pytest.raises(TranscriptionBusyError, match="already running"):
            call(RecordingLoader(), guard=guard)
    finally:
        guard.release()


def test_busy_refusal_resolves_nothing_and_calls_nothing():
    guard = SingleFlight()
    loader = RecordingLoader()
    assert guard.try_acquire() is True
    try:
        with pytest.raises(TranscriptionBusyError):
            call(loader, guard=guard)
    finally:
        guard.release()
    assert loader.resolutions == 0
    assert loader.transcriber.calls == []


def test_the_slot_is_reusable_after_a_refusal():
    guard = SingleFlight()
    assert guard.try_acquire() is True
    with pytest.raises(TranscriptionBusyError):
        call(RecordingLoader(), guard=guard)
    guard.release()
    assert call(RecordingLoader(RecordingTranscriber(result="OK")), guard=guard) == "OK"


def test_only_one_of_two_real_threads_gets_through():
    guard = SingleFlight()
    started = threading.Event()
    release = threading.Event()
    outcomes: list[str] = []

    def slow_transcriber(decoded, **kwargs):
        started.set()
        release.wait(timeout=5)
        return "FIRST"

    def first():
        try:
            outcomes.append(call(lambda: slow_transcriber, guard=guard))
        except Exception as exc:  # pragma: no cover - failure path
            outcomes.append(type(exc).__name__)

    def second():
        started.wait(timeout=5)
        try:
            outcomes.append(
                call(RecordingLoader(RecordingTranscriber(result="SECOND")), guard=guard)
            )
        except TranscriptionBusyError:
            outcomes.append("BUSY")

    t1, t2 = threading.Thread(target=first), threading.Thread(target=second)
    t1.start()
    t2.start()
    t2.join(timeout=5)
    release.set()
    t1.join(timeout=5)

    assert "BUSY" in outcomes
    assert "FIRST" in outcomes
    assert "SECOND" not in outcomes
    assert_slot_free(guard)


# --- the process-local default guard --------------------------------------


def test_the_default_guard_is_used_when_none_is_supplied():
    default = get_single_flight()
    assert default.try_acquire() is True
    try:
        with pytest.raises(TranscriptionBusyError):
            call(RecordingLoader())
    finally:
        default.release()


def test_the_default_guard_is_stable_for_the_process():
    """No reset hook exists: a production module must not expose a
    mutation point that only tests use, and swapping it could mask a real
    slot leak in the code under test. Isolation comes from passing a
    fresh SingleFlight instead."""
    assert get_single_flight() is get_single_flight()
    assert not hasattr(transcription_service, "reset_single_flight")


def test_single_flight_exposes_no_observational_predicate():
    """`in_use` could only ever return a stale answer, and any caller
    branching on it would have written a race."""
    assert not hasattr(SingleFlight, "in_use")


def test_a_guard_can_be_taken_and_released_repeatedly():
    guard = SingleFlight()
    for _ in range(3):
        assert guard.try_acquire() is True
        assert guard.try_acquire() is False  # single slot
        guard.release()
    assert_slot_free(guard)
