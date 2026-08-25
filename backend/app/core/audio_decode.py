"""
Pure audio validation and decoding for POST /transcribe.

One decode, shared by both speech-to-text backends. The upload becomes a
mono float32 waveform at 16 kHz exactly once, and that same array is
handed to whichever model is selected — so a WER difference measured by
evaluation/scripts/compare_stt.py is a MODEL difference, not a decoder
difference. Letting openai-whisper decode via the ffmpeg CLI while
faster-whisper decodes via PyAV would confound the one comparison this
feature exists to make.

Audio is NEVER written to disk. Both model APIs accept an in-memory
waveform (whisper.transcribe's `audio` is str | ndarray | Tensor, and
WhisperModel.transcribe's is str | BinaryIO | ndarray), so no temporary
file is involved on either path.

This module imports no model library. PyAV and numpy are imported LAZILY
inside the decode call, so importing this module — or app.api.routes —
pulls in neither. PyAV is imported directly and never through
faster_whisper.audio: faster-whisper lives in requirements-eval.txt and
must not become runtime infrastructure.

Error messages are fixed, bounded strings. No decoder text, no file
path, and no fragment of the payload ever reaches a message a caller
could surface.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Any

# Base media types accepted from a browser recording or a file upload.
# Chrome's MediaRecorder emits audio/webm, Firefox audio/ogg, Safari
# audio/mp4; the rest cover ordinary file uploads. Parameters such as
# ";codecs=opus" are stripped before this set is consulted.
SUPPORTED_AUDIO_MEDIA_TYPES: frozenset[str] = frozenset(
    {
        "audio/webm",
        "audio/ogg",
        "audio/wav",
        "audio/x-wav",
        "audio/wave",
        "audio/mpeg",
        "audio/mp3",
        "audio/mp4",
        "audio/m4a",
        "audio/x-m4a",
    }
)

# Declared base type -> the demuxer names PyAV may legitimately report
# for it. A declared type that decodes as something else is rejected:
# without this, "audio/webm" carrying WAV bytes passes the allowlist and
# the mismatch is only ever discovered by whatever consumes the result.
#
# The values are FFmpeg demuxer names, which are comma-joined families
# ("matroska,webm"), so agreement is checked by token intersection. WebM
# and Matroska share one demuxer and cannot be told apart by name, so
# audio/webm accepts both tokens.
CONTAINER_FAMILIES: dict[str, frozenset[str]] = {
    "audio/wav": frozenset({"wav"}),
    "audio/x-wav": frozenset({"wav"}),
    "audio/wave": frozenset({"wav"}),
    "audio/webm": frozenset({"webm", "matroska"}),
    "audio/ogg": frozenset({"ogg"}),
    "audio/mpeg": frozenset({"mp3"}),
    "audio/mp3": frozenset({"mp3"}),
    "audio/mp4": frozenset({"mp4", "m4a", "mov", "3gp", "3g2", "mj2"}),
    "audio/m4a": frozenset({"mp4", "m4a", "mov", "3gp", "3g2", "mj2"}),
    "audio/x-m4a": frozenset({"mp4", "m4a", "mov", "3gp", "3g2", "mj2"}),
}

# Whisper and faster-whisper both expect 16 kHz mono float32.
TARGET_SAMPLE_RATE = 16000


class AudioValidationError(ValueError):
    """Base for every rejection here. A ValueError subclass for the same
    reason ImageValidationError is one — existing `except ValueError`
    callers keep working regardless of which module raises."""


class UnsupportedAudioTypeError(AudioValidationError):
    """Declared media type is missing, blank, or not in the allowlist."""


class MalformedAudioError(AudioValidationError):
    """Bytes are empty, undecodable, carry no audio stream, or decode to
    no samples at all."""


class AudioContainerMismatchError(AudioValidationError):
    """The bytes decode as a real container, but not the family the
    declared media type promised — e.g. WAV bytes sent as audio/webm.
    Its own type, so a mismatch is never reported as generic corruption
    and never as an unsupported type."""


class AudioTooLongError(AudioValidationError):
    """Decoded audio exceeds the allowed duration.

    Raised from the DECODED sample count, never from container metadata:
    a header can claim any duration it likes, and one that understates
    its length would walk straight past a metadata-only check.
    """


@dataclass(frozen=True)
class DecodedAudio:
    """Immutable decode result. `waveform` is a 1-D float32 numpy array of
    mono samples at `sample_rate`; its annotation is Any so this module
    needs no numpy import to be imported itself."""

    waveform: Any
    sample_rate: int
    duration_s: float


def normalise_media_type(raw_media_type: Any) -> str:
    """"audio/webm;codecs=opus" -> "audio/webm".

    Browsers append codec parameters to a recorded blob's Content-Type,
    so a naive equality check against the allowlist rejects every real
    Chrome recording. Comparing the base type is the fix; the parameters
    carry nothing this validation needs.
    """
    if not isinstance(raw_media_type, str):
        raise UnsupportedAudioTypeError("audio media type is missing")
    base = raw_media_type.split(";", 1)[0].strip().lower()
    if not base:
        raise UnsupportedAudioTypeError("audio media type is missing")
    return base


def validate_media_type(raw_media_type: Any) -> str:
    """The normalised base type, or UnsupportedAudioTypeError."""
    base = normalise_media_type(raw_media_type)
    if base not in SUPPORTED_AUDIO_MEDIA_TYPES:
        raise UnsupportedAudioTypeError("audio media type is not supported")
    return base


def check_container_matches_media_type(container_format_name: Any, base_media_type: str) -> None:
    """Raise AudioContainerMismatchError unless the demuxer PyAV chose
    belongs to the family the declared type promised.

    `container_format_name` is a PyAV/FFmpeg internal string and is used
    ONLY for this comparison — it never appears in a message, because
    that would leak decoder detail to a caller.
    """
    allowed = CONTAINER_FAMILIES.get(base_media_type)
    if allowed is None:  # pragma: no cover - allowlist and map kept in step by a test
        raise UnsupportedAudioTypeError("audio media type is not supported")
    if not isinstance(container_format_name, str):
        raise AudioContainerMismatchError("audio does not match its declared format")
    detected = {t.strip().lower() for t in container_format_name.split(",") if t.strip()}
    if not (detected & allowed):
        raise AudioContainerMismatchError("audio does not match its declared format")


def decode_audio_bytes(audio_bytes: Any, media_type: Any, *, max_seconds: int) -> DecodedAudio:
    """Validate, then decode ONCE to mono float32 at TARGET_SAMPLE_RATE.

    Decoding stops as soon as the sample budget is exceeded — the frame
    loop breaks rather than decoding a long file to completion and
    measuring afterwards, so an oversized upload costs a bounded amount
    of work instead of however long its full decode takes.

    Raises UnsupportedAudioTypeError, MalformedAudioError or
    AudioTooLongError, never a decoder exception, and never writes to
    disk.
    """
    if not isinstance(audio_bytes, bytes) or not audio_bytes:
        raise MalformedAudioError("audio payload is empty")
    if not isinstance(max_seconds, int) or isinstance(max_seconds, bool) or max_seconds <= 0:
        raise ValueError("max_seconds must be a positive integer")

    base_media_type = validate_media_type(media_type)

    # Lazy, and deliberately not `from faster_whisper.audio import
    # decode_audio` — that package is evaluation-only.
    import av
    import numpy as np

    max_samples = max_seconds * TARGET_SAMPLE_RATE
    chunks: list[Any] = []
    total_samples = 0
    too_long = False

    try:
        with av.open(io.BytesIO(audio_bytes)) as container:
            # Cross-checked before decoding: a declared type that does
            # not match the real container is rejected on the header,
            # never after a full decode.
            check_container_matches_media_type(
                getattr(container.format, "name", None), base_media_type
            )

            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise MalformedAudioError("no audio stream found")

            resampler = av.audio.resampler.AudioResampler(
                format="flt", layout="mono", rate=TARGET_SAMPLE_RATE
            )

            for frame in container.decode(stream):
                for resampled in resampler.resample(frame):
                    samples = resampled.to_ndarray().reshape(-1)
                    chunks.append(samples)
                    total_samples += samples.shape[0]
                if total_samples > max_samples:
                    too_long = True
                    break

            if not too_long:
                # Flush whatever the resampler is still holding.
                for resampled in resampler.resample(None):
                    samples = resampled.to_ndarray().reshape(-1)
                    chunks.append(samples)
                    total_samples += samples.shape[0]
                if total_samples > max_samples:
                    too_long = True
    except AudioValidationError:
        raise
    except Exception as exc:  # noqa: BLE001 - every decoder failure becomes one bounded message
        # A decoder's own text can quote the payload or a path, so it
        # never reaches the caller. The cause is kept for local debugging.
        raise MalformedAudioError("audio could not be decoded") from exc

    if too_long:
        raise AudioTooLongError("audio is longer than the allowed duration")
    if total_samples == 0:
        raise MalformedAudioError("audio contains no samples")

    waveform = np.concatenate(chunks).astype(np.float32, copy=False)
    return DecodedAudio(
        waveform=waveform,
        sample_rate=TARGET_SAMPLE_RATE,
        duration_s=round(waveform.shape[0] / TARGET_SAMPLE_RATE, 3),
    )
