"""
Transcription orchestration: decode, then transcribe, under a
single-flight guard.

Composes app.core.audio_decode and a caller-supplied transcriber. Like
every other service here it never imports fastapi and never imports a
model module directly, so it stays callable from an evaluation script
without going through HTTP (PROJECT_SPEC.md §4).

WHY THERE IS NO TIMEOUT. A timeout around a worker thread does not stop
CPU-bound inference: `wait_for` abandons the waiter, the thread runs to
completion anyway, the CPU stays busy, and the client is told "timeout"
while the work continues invisibly. Under repeated requests those
abandoned calls accumulate until the machine is saturated. Only a
killable process boundary gives real cancellation, and that costs a
model reload per worker plus ~0.5-1GB RSS each — not justified until
measured latency says otherwise.

What bounds the work instead is honest and cheap:
  1. The INPUT is bounded — max upload bytes at the route, max decoded
     seconds in the decoder. Bounded input, bounded work.
  2. At most ONE inference runs at a time. Acquisition is
     non-blocking: a concurrent caller is told "busy" immediately rather
     than joining a queue that could grow without limit. No waiting
     queue means nothing to accumulate.

Neither mechanism claims to cancel anything, and nothing here is named
as though it does.
"""

from __future__ import annotations

import threading
from typing import Any, Callable

from app.core.audio_decode import DecodedAudio, decode_audio_bytes

# A transcriber takes the decoded waveform plus the model name and
# returns something shaped like whisper_stt.TranscriptResult. A LOADER is
# a zero-arg callable returning one — the same convention the route's
# model-boundary dependencies already use.
#
# Taking the loader rather than a resolved transcriber is what lets the
# resolution happen at the right moment: after validation, so a malformed
# upload never imports a model module, and after the slot is held, so the
# resolution cannot race a concurrent request.
#
# Typed structurally (like analysis_service's Protocols) so this module
# needs no import of app.models.whisper_stt and a test fake shares no
# import with the real model stack.
Transcriber = Callable[..., Any]
TranscriberLoader = Callable[[], Transcriber]


class TranscriptionBusyError(RuntimeError):
    """Another transcription is already running. The caller should retry
    shortly; nothing was started and nothing was queued."""


class SingleFlight:
    """One-slot, non-blocking guard.

    Deliberately just try_acquire/release. There is no `in_use`
    predicate: any answer it gave would be stale the instant it returned,
    and a caller tempted to branch on it would have written a race. The
    only correct way to learn whether the slot is free is to try to take
    it. Tests verify a release the same way — by acquiring again.
    """

    def __init__(self) -> None:
        self._semaphore = threading.Semaphore(1)

    def try_acquire(self) -> bool:
        return self._semaphore.acquire(blocking=False)

    def release(self) -> None:
        self._semaphore.release()


# Process-local, and STABLE for the process lifetime: there is no reset
# hook, because a production module must not expose a mutation point that
# exists only for tests — and a test that swapped it could hide a real
# leak in the code under test. Isolation comes from passing a fresh
# SingleFlight through the `guard` parameter instead.
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
    """Decode and transcribe one upload, in a deliberate order:

      1. decode and validate the audio;
      2. acquire the single-flight slot;
      3. resolve the transcriber (this is where a model module is
         imported and a model loaded);
      4. invoke it;
      5. release the slot in `finally`.

    Steps 1 and 3 are in that order on purpose. A malformed upload must
    not import a model module or pay a model load merely to be rejected,
    and it must not hold the slot while a valid concurrent request is
    turned away. Resolution sits inside the slot so a load cannot happen
    twice concurrently.

    Raises AudioValidationError subclasses for bad input,
    TranscriptionBusyError when a transcription is already running, and
    whatever typed error the loader or transcriber raises.
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
            # Applied here rather than only at the HTTP edge, so a fake or
            # a backend that returns something unusable is caught for
            # every caller, and so the check can compare against the audio
            # that was ACTUALLY decoded.
            return validate_result(
                result,
                expected_model_name=model_name,
                expected_duration_s=decoded.duration_s,
            )
        return result
    finally:
        # Released on success, on a loader failure, on a model failure and
        # on an unexpected exception alike — a slot leaked here would
        # wedge the endpoint for the lifetime of the process.
        active_guard.release()
