"""Decode and transcribe bounded audio under a non-blocking single-flight guard.

There is no thread timeout because it would abandon the waiter without
stopping CPU inference. Upload and decoded-duration limits bound the work,
while the one-slot guard rejects concurrent requests instead of queuing them.
The transcriber is injected so this service stays independent of HTTP and
model modules.
"""

from __future__ import annotations

import threading
from typing import Any, Callable

from app.core.audio_decode import DecodedAudio, decode_audio_bytes

# Resolve the injected transcriber only after validation and slot acquisition,
# preventing rejected input or concurrent requests from loading a model.
Transcriber = Callable[..., Any]
TranscriberLoader = Callable[[], Transcriber]


class TranscriptionBusyError(RuntimeError):
    """Another transcription is running; nothing was queued."""


class SingleFlight:
    """One-slot guard with no racy read-only availability check."""

    def __init__(self) -> None:
        self._semaphore = threading.Semaphore(1)

    def try_acquire(self) -> bool:
        return self._semaphore.acquire(blocking=False)

    def release(self) -> None:
        self._semaphore.release()


# Tests inject a fresh guard; the process-level production guard is never reset.
_default_guard = SingleFlight()


def get_single_flight() -> SingleFlight:
    return _default_guard


def transcribe_audio(
    audio_bytes: bytes,
    media_type: Any,
    transcriber_loader: TranscriberLoader,
    *,
    model_name: str,
    max_audio_seconds: int,
    compute_type: str = "int8",
    local_files_only: bool = True,
    guard: SingleFlight | None = None,
    validate_result: Callable[..., Any] | None = None,
) -> Any:
    """Decode first, then acquire the slot, resolve the model, and transcribe.

    Invalid audio never loads a model or occupies the slot. Resolution occurs
    inside the slot so concurrent requests cannot load twice. The slot is
    always released in `finally`.
    """
    decoded: DecodedAudio = decode_audio_bytes(
        audio_bytes, media_type, max_seconds=max_audio_seconds
    )

    active_guard = guard if guard is not None else get_single_flight()
    if not active_guard.try_acquire():
        raise TranscriptionBusyError("a transcription is already running")
    try:
        transcriber = transcriber_loader()
        result = transcriber(
            decoded,
            model_name=model_name,
            compute_type=compute_type,
            local_files_only=local_files_only,
        )
        if validate_result is not None:
            # Validate against the audio actually decoded for every caller.
            return validate_result(
                result,
                expected_model_name=model_name,
                expected_duration_s=decoded.duration_s,
            )
        return result
    finally:
        # A leaked slot would wedge transcription for the process lifetime.
        active_guard.release()
