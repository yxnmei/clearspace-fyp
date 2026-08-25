"""
Speech-to-text model boundary — two backends behind one signature.

Both adapters take the SAME decoded waveform (app.core.audio_decode's
DecodedAudio), so evaluation/scripts/compare_stt.py can put identical
audio through openai-whisper and faster-whisper and attribute any
difference to the model rather than to a decoder. openai-whisper does
NOT require a temporary file: whisper.transcribe's `audio` parameter
accepts str | ndarray | Tensor, and whisper.load_audio (the path-and-
ffmpeg entry point) is never called here.

Production defaults to openai-whisper — the only backend declared in
requirements.txt. faster-whisper stays reachable through its explicit
model name for the V3 comparison; it lives in requirements-eval.txt, so
this module treats a missing import as an ordinary unavailable-backend
condition rather than a crash.

Importing this module pulls in NO model library: whisper, faster_whisper,
torch, ctranslate2 and numpy are all imported lazily inside the loader.
That is what keeps app.api.routes' import graph free of the ML stack —
`import whisper` alone costs ~2s and drags in torch.

Transcript is surfaced to the user for review before it enters the
context field; that gate lives in the frontend, not here. This module
only transcribes.
"""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable

from app.core.audio_decode import DecodedAudio

WHISPER_BACKEND = "whisper"
FASTER_WHISPER_BACKEND = "faster-whisper"
SUPPORTED_BACKENDS: tuple[str, ...] = (WHISPER_BACKEND, FASTER_WHISPER_BACKEND)

# This project evaluates and ships exactly one size. The allowlist is not
# a style preference: both loaders take the size as a STRING that doubles
# as a path or repo id, so an unconstrained value turns configuration
# into "load an arbitrary checkpoint from anywhere". Validated before any
# cache lookup and long before any model-library call.
SUPPORTED_MODEL_SIZES: tuple[str, ...] = ("base",)


class TranscriberUnavailableError(RuntimeError):
    """The selected backend cannot run: its package is not installed, or
    its weights are absent while downloads are disabled. Distinct from
    TranscriptionFailedError — this one means nothing was attempted."""


class TranscriptionFailedError(RuntimeError):
    """The model was loaded and the call still failed, or returned
    something structurally wrong. The message is a fixed, bounded string;
    the underlying exception is preserved as the cause but never
    formatted into anything a caller can surface."""


class TranscriptContractError(RuntimeError):
    """A transcript result violates the contract — wrong type, blank or
    mismatched model name, a non-finite or negative number, a bool where
    a number belongs, or a duration that disagrees with the audio that
    was actually transcribed. Distinct from TranscriptionFailedError: the
    call returned, but what came back cannot be served."""


@dataclass(frozen=True)
class TranscriptResult:
    """Fields mirror the API response exactly, so the route shapes the
    response without renaming or recomputing anything.

    `transcription_ms` is INFERENCE wall-clock and deliberately excludes
    model load: the V3 comparison has to separate CTranslate2's and
    PyTorch's very different load behaviour from their throughput, and a
    single conflated number would make that impossible.
    """

    text: str
    model_name: str
    transcription_ms: float
    audio_duration_s: float


def validate_model_size(model_size: Any) -> str:
    """The size, or TranscriberUnavailableError.

    Exact match against the allowlist, with no stripping: " base " is a
    configuration mistake, not a value to silently repair. This is what
    stops an absolute path, a traversal sequence, or any other checkpoint
    identifier from ever reaching a loader.
    """
    if isinstance(model_size, bool) or not isinstance(model_size, str):
        raise TranscriberUnavailableError("speech-to-text model size is not supported")
    if model_size not in SUPPORTED_MODEL_SIZES:
        raise TranscriberUnavailableError("speech-to-text model size is not supported")
    return model_size


def resolve_model_name(backend: str, model_size: str) -> str:
    """"whisper" + "base" -> "whisper-base". The public identity of a
    configuration, and what compare_stt.py selects a backend by."""
    if backend not in SUPPORTED_BACKENDS:
        raise TranscriberUnavailableError("speech-to-text backend is not supported")
    validate_model_size(model_size)
    return f"{backend}-{model_size}"


def split_model_name(model_name: str) -> tuple[str, str]:
    """Inverse of resolve_model_name. Longest-backend-first so
    "faster-whisper-base" is never parsed as backend "whisper"."""
    if not isinstance(model_name, str) or not model_name.strip():
        raise TranscriberUnavailableError("speech-to-text model name is not valid")
    candidate = model_name.strip()
    for backend in sorted(SUPPORTED_BACKENDS, key=len, reverse=True):
        prefix = f"{backend}-"
        if candidate.startswith(prefix):
            return backend, validate_model_size(candidate[len(prefix) :])
    raise TranscriberUnavailableError("speech-to-text model name is not recognised")


def _whisper_weights_present(model_size: str) -> bool:
    """openai-whisper has no `local_files_only` switch — load_model()
    downloads silently when the checkpoint is missing. With downloads
    disabled we check the cache ourselves and refuse, rather than let a
    user request start a 145MB fetch mid-flight."""
    root = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
    return os.path.isfile(os.path.join(root, f"{model_size}.pt"))


def load_model(
    backend: str,
    model_size: str,
    compute_type: str = "int8",
    local_files_only: bool = True,
) -> Any:
    """Validate, then load (and cache) one model per configuration.

    Validation sits deliberately OUTSIDE the cache: an unsupported
    backend or size must be refused before a cache lookup is keyed on it,
    and long before any model library sees the value.

    `local_files_only=False` is accepted here and only here — it exists
    for an explicitly approved evaluation/download step. Production
    cannot reach it: Settings rejects a false STT_LOCAL_FILES_ONLY, so
    /transcribe always passes True.
    """
    if backend not in SUPPORTED_BACKENDS:
        raise TranscriberUnavailableError("speech-to-text backend is not supported")
    validate_model_size(model_size)
    return _load_model_cached(backend, model_size, compute_type, local_files_only)


@lru_cache(maxsize=4)
def _load_model_cached(
    backend: str,
    model_size: str,
    compute_type: str,
    local_files_only: bool,
) -> Any:
    """Cached on the full configuration, not just the backend, so the V3
    comparison can hold both models in one process without either
    evicting the other, and so a second request never pays the load
    again. Every model-library import happens inside this function.
    """
    if backend == WHISPER_BACKEND:
        if local_files_only and not _whisper_weights_present(model_size):
            raise TranscriberUnavailableError("speech-to-text weights are not available locally")
        try:
            import whisper
        except ImportError as exc:
            raise TranscriberUnavailableError("speech-to-text backend is not installed") from exc
        try:
            return whisper.load_model(model_size)
        except Exception as exc:  # noqa: BLE001 - one bounded unavailable message
            raise TranscriberUnavailableError("speech-to-text model could not be loaded") from exc

    if backend == FASTER_WHISPER_BACKEND:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            # Expected in a runtime-only install: faster-whisper is
            # declared in requirements-eval.txt, not requirements.txt.
            raise TranscriberUnavailableError("speech-to-text backend is not installed") from exc
        try:
            return WhisperModel(
                model_size,
                device="cpu",
                compute_type=compute_type,
                local_files_only=local_files_only,
            )
        except Exception as exc:  # noqa: BLE001 - one bounded unavailable message
            raise TranscriberUnavailableError("speech-to-text model could not be loaded") from exc

    # Unreachable through load_model(), which validates the backend first.
    raise TranscriberUnavailableError("speech-to-text backend is not supported")


# Callers manage the cache through the public entry point; the cache
# itself lives on the inner function.
load_model.cache_clear = _load_model_cached.cache_clear  # type: ignore[attr-defined]
load_model.cache_info = _load_model_cached.cache_info  # type: ignore[attr-defined]


# Deterministic, English-only, greedy. Stated explicitly rather than left
# to library defaults: openai-whisper's default temperature is a
# fallback SCHEDULE ((0.0, 0.2, ... 1.0)) and faster-whisper's default
# beam_size is 5, so two runs of "the same" comparison would otherwise
# differ in sampling policy between backends and between library
# versions. fp16 is off because this machine's torch is CPU-only.
_WHISPER_OPTIONS: dict[str, Any] = {
    "language": "en",
    "task": "transcribe",
    "temperature": 0.0,
    "condition_on_previous_text": False,
    "fp16": False,
}

_FASTER_WHISPER_OPTIONS: dict[str, Any] = {
    "language": "en",
    "task": "transcribe",
    "temperature": 0.0,
    "beam_size": 1,
    "condition_on_previous_text": False,
}


def _transcribe_whisper(model: Any, waveform: Any) -> str:
    """openai-whisper returns a dict carrying a string "text".

    A non-dict, a missing key or a non-string value is a structural
    FAILURE, not silence. Coercing it to "" would present a broken model
    as a user who said nothing, and the user would be shown an empty
    transcript with no sign that anything went wrong.
    """
    result = model.transcribe(waveform, **_WHISPER_OPTIONS)
    if not isinstance(result, dict) or "text" not in result:
        raise TranscriptionFailedError("transcription failed")
    text = result["text"]
    if not isinstance(text, str):
        raise TranscriptionFailedError("transcription failed")
    return text


def _transcribe_faster_whisper(model: Any, waveform: Any) -> str:
    """faster-whisper returns (segments, info), each segment carrying a
    string `text`. Same rule as above: a malformed segment is a failure,
    never silently dropped."""
    result = model.transcribe(waveform, **_FASTER_WHISPER_OPTIONS)
    if not isinstance(result, tuple) or len(result) != 2:
        raise TranscriptionFailedError("transcription failed")
    segments, _info = result
    try:
        segment_list = list(segments)
    except TypeError as exc:
        raise TranscriptionFailedError("transcription failed") from exc

    parts: list[str] = []
    for segment in segment_list:
        text = getattr(segment, "text", None)
        if not isinstance(text, str):
            raise TranscriptionFailedError("transcription failed")
        parts.append(text)
    return "".join(parts)


_ADAPTERS: dict[str, Callable[[Any, Any], str]] = {
    WHISPER_BACKEND: _transcribe_whisper,
    FASTER_WHISPER_BACKEND: _transcribe_faster_whisper,
}


def _valid_number(value: Any) -> bool:
    """A real, finite, non-negative number. bool is rejected explicitly:
    it is an int subclass, so `True` would otherwise pass as 1.0 and a
    broken backend would report a one-millisecond transcription."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and value >= 0


def validate_transcript_result(
    result: Any,
    *,
    expected_model_name: str,
    expected_duration_s: float,
) -> TranscriptResult:
    """Enforce the transcript contract at the SOURCE, not only at the HTTP
    edge.

    The route is not the only caller — compare_stt.py will drive this
    directly — so a result that cannot be served must be rejected here,
    where every caller benefits. Checking the model name and the audio
    duration against what was actually requested and decoded also catches
    a whole class of wiring mistakes: a backend that quietly answered for
    a different model, or a result stitched to the wrong audio.
    """
    if not isinstance(result, TranscriptResult):
        raise TranscriptContractError("transcript result is not valid")
    if not isinstance(result.text, str):
        raise TranscriptContractError("transcript result is not valid")
    if not isinstance(result.model_name, str) or not result.model_name.strip():
        raise TranscriptContractError("transcript result is not valid")
    if result.model_name != expected_model_name:
        raise TranscriptContractError("transcript result is not valid")
    if not _valid_number(result.transcription_ms):
        raise TranscriptContractError("transcript result is not valid")
    if not _valid_number(result.audio_duration_s):
        raise TranscriptContractError("transcript result is not valid")
    if not math.isclose(result.audio_duration_s, expected_duration_s, rel_tol=0, abs_tol=1e-6):
        raise TranscriptContractError("transcript result is not valid")
    return result


def transcribe(
    audio: DecodedAudio,
    *,
    model_name: str,
    compute_type: str = "int8",
    local_files_only: bool = True,
) -> TranscriptResult:
    """Transcribe an already-decoded waveform.

    `model_name` is explicit rather than read from settings here, for the
    same reason mistral_llm.classify_items takes one: compare_stt.py runs
    this twice over identical audio, once per backend, without a second
    near-duplicate implementation.

    A blank transcript is a legitimate result — silence is not an error —
    and is returned as "" rather than raised.
    """
    if not isinstance(audio, DecodedAudio):
        raise TranscriptionFailedError("decoded audio was not provided")

    backend, model_size = split_model_name(model_name)
    model = load_model(backend, model_size, compute_type, local_files_only)
    adapter = _ADAPTERS[backend]

    started = time.perf_counter()
    try:
        text = adapter(model, audio.waveform)
    except TranscriptionFailedError:
        # Already the bounded, typed failure — re-raise rather than
        # wrapping it in itself.
        raise
    except Exception as exc:  # noqa: BLE001 - third-party boundary, one bounded message
        # Whisper's own exceptions can echo decoder internals; only this
        # fixed string is ever visible to a caller.
        raise TranscriptionFailedError("transcription failed") from exc
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)

    result = TranscriptResult(
        text=text.strip(),
        model_name=model_name,
        transcription_ms=elapsed_ms,
        audio_duration_s=audio.duration_s,
    )
    return validate_transcript_result(
        result, expected_model_name=model_name, expected_duration_s=audio.duration_s
    )
