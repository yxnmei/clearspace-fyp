"""Two speech-to-text backends over the same decoded waveform.

Production defaults to faster-whisper for measured loading latency, not
accuracy. Model libraries load lazily so unrelated routes avoid the ML stack.
The transcript is reviewed in the frontend before becoming user context.
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

# The loader accepts paths or repository ids, so allowlist the evaluated size.
SUPPORTED_MODEL_SIZES: tuple[str, ...] = ("base",)


class TranscriberUnavailableError(RuntimeError):
    """The selected backend or local weights are unavailable."""


class TranscriptionFailedError(RuntimeError):
    """Inference failed with a fixed message and preserved internal cause."""


class TranscriptContractError(RuntimeError):
    """A returned transcript cannot be served under the response contract."""


@dataclass(frozen=True)
class TranscriptResult:
    """Transcript data with inference time excluding model loading."""

    text: str
    model_name: str
    transcription_ms: float
    audio_duration_s: float


def validate_model_size(model_size: Any) -> str:
    """Require an exact allowlisted size before any loader sees the value."""
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
    """Check the cache because this backend lacks a local-only switch."""
    root = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
    return os.path.isfile(os.path.join(root, f"{model_size}.pt"))


def load_model(
    backend: str,
    model_size: str,
    compute_type: str = "int8",
    local_files_only: bool = True,
) -> Any:
    """Validate before cache lookup, then load one model per configuration.

    Production settings pin ``local_files_only`` true; false is reserved for
    an explicitly approved evaluation download.
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
    """Cache the full configuration and import model libraries lazily."""
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
            # Use the same bounded unavailable error for either backend.
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


# Expose cache controls through the public loader.
load_model.cache_clear = _load_model_cached.cache_clear  # type: ignore[attr-defined]
load_model.cache_info = _load_model_cached.cache_info  # type: ignore[attr-defined]


# Pin deterministic English decoding because backend defaults use different
# sampling policies. Disable fp16 for the CPU-only runtime.
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
    """Treat malformed output as failure rather than silence."""
    result = model.transcribe(waveform, **_WHISPER_OPTIONS)
    if not isinstance(result, dict) or "text" not in result:
        raise TranscriptionFailedError("transcription failed")
    text = result["text"]
    if not isinstance(text, str):
        raise TranscriptionFailedError("transcription failed")
    return text


def _transcribe_faster_whisper(model: Any, waveform: Any) -> str:
    """Join text segments and reject malformed output."""
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
    """Accept finite non-negative numbers but not bool, an int subclass."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and value >= 0


def validate_transcript_result(
    result: Any,
    *,
    expected_model_name: str,
    expected_duration_s: float,
) -> TranscriptResult:
    """Validate model identity, timing, and correlation to decoded audio."""
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
    """Transcribe decoded audio with an explicit evaluation-compatible model.

    A blank transcript represents valid silence.
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
        # Preserve the existing bounded typed failure.
        raise
    except Exception as exc:  # noqa: BLE001 - third-party boundary, one bounded message
        # Do not expose third-party decoder details.
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
