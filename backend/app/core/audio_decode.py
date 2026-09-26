"""
Audio validation and decoding for POST /transcribe.

The upload is decoded once to a 16 kHz mono float32 waveform and the same
array goes to whichever speech backend is selected, so a measured WER
difference is a model difference, not a decoder difference. Audio is
never written to disk; both backends accept an in-memory waveform.

PyAV and numpy are imported lazily inside the decode call, so importing
this module (or the routes) loads neither. PyAV is imported directly,
never via faster_whisper.audio, so decoding is independent of either
backend.

Error messages are fixed strings: no decoder text, path or payload
fragment reaches a caller.
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

# Declared base type -> demuxer names PyAV may report for it, so
# "audio/webm" carrying WAV bytes is rejected. FFmpeg demuxer names are
# comma-joined families ("matroska,webm"), so agreement is checked by
# token intersection; WebM and Matroska share one demuxer, so audio/webm
# accepts both.
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
    """Base for every rejection here; a ValueError subclass so existing
    `except ValueError` callers keep working."""


class UnsupportedAudioTypeError(AudioValidationError):
    """Declared media type is missing, blank, or not in the allowlist."""


class MalformedAudioError(AudioValidationError):
    """Bytes are empty, undecodable, carry no audio stream, or decode to
    no samples at all."""


class AudioContainerMismatchError(AudioValidationError):
    """A real container, but not the family the declared type promised
    (e.g. WAV bytes sent as audio/webm). Distinct from corruption and
    from an unsupported type."""


class AudioTooLongError(AudioValidationError):
    """Decoded audio exceeds the allowed duration. Judged from the
    decoded sample count, never container metadata, which a header can
    understate."""


@dataclass(frozen=True)
class DecodedAudio:
    """`waveform` is a 1-D float32 numpy array, annotated Any so importing
    this module needs no numpy."""

    waveform: Any
    sample_rate: int
    duration_s: float


def normalise_media_type(raw_media_type: Any) -> str:
    """"audio/webm;codecs=opus" -> "audio/webm". Browsers append codec
    parameters, so exact matching would reject every Chrome recording."""
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
    """Raise AudioContainerMismatchError unless PyAV's demuxer belongs to
    the declared type's family. The format name never appears in a
    message, so no decoder detail leaks."""
    allowed = CONTAINER_FAMILIES.get(base_media_type)
    if allowed is None:  # pragma: no cover - allowlist and map kept in step by a test
        raise UnsupportedAudioTypeError("audio media type is not supported")
    if not isinstance(container_format_name, str):
        raise AudioContainerMismatchError("audio does not match its declared format")
    detected = {t.strip().lower() for t in container_format_name.split(",") if t.strip()}
    if not (detected & allowed):
        raise AudioContainerMismatchError("audio does not match its declared format")


def decode_audio_bytes(audio_bytes: Any, media_type: Any, *, max_seconds: int) -> DecodedAudio:
    """Validate, then decode once to mono float32 at TARGET_SAMPLE_RATE.

    The budget is enforced on the running decoded sample count and the
    frame loop stops as soon as it is exceeded, so oversized audio costs
    bounded work. Invalid audio raises an AudioValidationError subclass,
    never a decoder exception; an invalid max_seconds is a caller error
    (ValueError).
    """
    if not isinstance(audio_bytes, bytes) or not audio_bytes:
        raise MalformedAudioError("audio payload is empty")
    if not isinstance(max_seconds, int) or isinstance(max_seconds, bool) or max_seconds <= 0:
        raise ValueError("max_seconds must be a positive integer")

    base_media_type = validate_media_type(media_type)

    # Lazy, and deliberately not faster_whisper.audio (see module docstring).
    import av
    import numpy as np

    max_samples = max_seconds * TARGET_SAMPLE_RATE
    chunks: list[Any] = []
    total_samples = 0
    too_long = False

    try:
        with av.open(io.BytesIO(audio_bytes)) as container:
            # Rejected on the header, before any decoding.
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
