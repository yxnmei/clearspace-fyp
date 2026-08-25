"""
Unit tests for app/core/audio_decode.py.

Real decoding, no model and no network: WAV fixtures are synthesised in
memory with the standard library's `wave` module, so PyAV decodes
genuine audio bytes without any file ever touching disk and without a
recording fixture needing to be committed.
"""

from __future__ import annotations

import io
import math
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import pytest

from app.core.audio_decode import (
    CONTAINER_FAMILIES,
    SUPPORTED_AUDIO_MEDIA_TYPES,
    TARGET_SAMPLE_RATE,
    AudioContainerMismatchError,
    AudioTooLongError,
    AudioValidationError,
    DecodedAudio,
    MalformedAudioError,
    UnsupportedAudioTypeError,
    check_container_matches_media_type,
    decode_audio_bytes,
    normalise_media_type,
    validate_media_type,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]


def wav_bytes(seconds: float = 0.5, rate: int = TARGET_SAMPLE_RATE, channels: int = 1) -> bytes:
    """A real WAV container holding a 440Hz tone. stdlib only."""
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


def encoded_bytes(container_format: str, codec: str, seconds: float = 0.3) -> bytes:
    """A GENUINE container, encoded in memory by PyAV.

    Real Ogg/WebM/MP3/MP4 bytes are what the container cross-check has to
    be tested against — a WAV renamed in a Content-Type header proves
    nothing about whether the check accepts legitimate browser output.
    """
    import av
    import numpy as np

    buf = io.BytesIO()
    with av.open(buf, "w", format=container_format) as out:
        stream = out.add_stream(codec, rate=48000)
        frames = int(seconds * 48000 / 1024)
        for _ in range(max(frames, 1)):
            frame = av.AudioFrame.from_ndarray(
                np.zeros((1, 1024), dtype="float32"), format="fltp", layout="mono"
            )
            frame.sample_rate = 48000
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return buf.getvalue()


# --- media type normalisation --------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("audio/webm", "audio/webm"),
        ("audio/webm;codecs=opus", "audio/webm"),
        ("audio/webm; codecs=opus", "audio/webm"),
        ("AUDIO/WEBM;CODECS=OPUS", "audio/webm"),
        ("  audio/ogg ; codecs=opus  ", "audio/ogg"),
        ("audio/mp4;codecs=mp4a.40.2", "audio/mp4"),
    ],
)
def test_media_type_parameters_are_stripped(raw, expected):
    """Chrome sends 'audio/webm;codecs=opus'. A naive equality check
    against the allowlist rejects every real browser recording."""
    assert normalise_media_type(raw) == expected


@pytest.mark.parametrize("accepted", sorted(SUPPORTED_AUDIO_MEDIA_TYPES))
def test_every_allowlisted_type_is_accepted(accepted):
    assert validate_media_type(accepted) == accepted


@pytest.mark.parametrize(
    "rejected",
    ["text/plain", "image/png", "application/octet-stream", "audio", "audio/aiff", "video/webm"],
)
def test_unsupported_types_are_rejected(rejected):
    with pytest.raises(UnsupportedAudioTypeError, match="not supported"):
        validate_media_type(rejected)


@pytest.mark.parametrize("missing", [None, "", "   ", ";codecs=opus", 42, b"audio/wav", []])
def test_missing_or_non_string_media_type_is_rejected(missing):
    with pytest.raises(UnsupportedAudioTypeError, match="missing"):
        validate_media_type(missing)


# --- declared type vs actual container ------------------------------------


def test_every_supported_type_has_a_container_family():
    """The allowlist and the family map must not drift apart: a type
    accepted by one and unknown to the other would either be rejected as
    a mismatch it cannot fail, or waved through unchecked."""
    assert set(CONTAINER_FAMILIES) == set(SUPPORTED_AUDIO_MEDIA_TYPES)


@pytest.mark.parametrize(
    "declared, container_format, codec",
    [
        ("audio/wav", "wav", "pcm_s16le"),
        ("audio/x-wav", "wav", "pcm_s16le"),
        ("audio/wave", "wav", "pcm_s16le"),
        ("audio/ogg", "ogg", "libopus"),
        ("audio/webm", "webm", "libopus"),
        ("audio/mpeg", "mp3", "libmp3lame"),
        ("audio/mp3", "mp3", "libmp3lame"),
        ("audio/mp4", "ipod", "aac"),
        ("audio/m4a", "ipod", "aac"),
        ("audio/x-m4a", "ipod", "aac"),
    ],
)
def test_genuine_containers_are_accepted_for_their_declared_type(
    declared, container_format, codec
):
    decoded = decode_audio_bytes(
        encoded_bytes(container_format, codec), declared, max_seconds=60
    )
    assert decoded.sample_rate == TARGET_SAMPLE_RATE
    assert decoded.waveform.ndim == 1


@pytest.mark.parametrize(
    "declared, container_format, codec",
    [
        ("audio/webm", "wav", "pcm_s16le"),
        ("audio/ogg", "wav", "pcm_s16le"),
        ("audio/mpeg", "wav", "pcm_s16le"),
        ("audio/mp4", "ogg", "libopus"),
        ("audio/wav", "ogg", "libopus"),
        ("audio/wav", "webm", "libopus"),
        ("audio/ogg", "mp3", "libmp3lame"),
    ],
)
def test_a_container_that_contradicts_its_declared_type_is_rejected(
    declared, container_format, codec
):
    """WAV bytes announced as audio/webm decode perfectly well — only the
    cross-check catches the disagreement."""
    with pytest.raises(AudioContainerMismatchError) as excinfo:
        decode_audio_bytes(encoded_bytes(container_format, codec), declared, max_seconds=60)
    assert str(excinfo.value) == "audio does not match its declared format"


def test_codec_parameters_do_not_defeat_the_container_check():
    """The declared type is normalised first, so a browser's
    ";codecs=opus" is matched on its base type, both ways."""
    webm = encoded_bytes("webm", "libopus")
    assert decode_audio_bytes(webm, "audio/webm;codecs=opus", max_seconds=60).duration_s > 0

    with pytest.raises(AudioContainerMismatchError):
        decode_audio_bytes(wav_bytes(0.2), "audio/webm;codecs=opus", max_seconds=60)


def test_matroska_is_accepted_for_webm():
    """WebM and Matroska share one demuxer name and cannot be told apart,
    so audio/webm must accept both tokens."""
    assert decode_audio_bytes(
        encoded_bytes("matroska", "libopus"), "audio/webm", max_seconds=60
    ).waveform.ndim == 1


def test_container_mismatch_message_never_exposes_the_decoder_format():
    with pytest.raises(AudioContainerMismatchError) as excinfo:
        check_container_matches_media_type("matroska,webm", "audio/wav")
    message = str(excinfo.value)
    assert "matroska" not in message
    assert "webm" not in message


@pytest.mark.parametrize("weird", [None, 42, b"wav", ""])
def test_an_unreadable_container_name_is_a_mismatch_not_a_crash(weird):
    with pytest.raises(AudioContainerMismatchError):
        check_container_matches_media_type(weird, "audio/wav")


# --- payload validation ---------------------------------------------------


@pytest.mark.parametrize("empty", [b"", None, "audio", 0, []])
def test_empty_or_non_bytes_payload_is_rejected(empty):
    with pytest.raises(MalformedAudioError, match="empty"):
        decode_audio_bytes(empty, "audio/wav", max_seconds=60)


def test_malformed_payload_is_rejected_without_decoder_text():
    """The decoder's own message can quote the payload or a path, so the
    caller must only ever see the fixed string."""
    with pytest.raises(MalformedAudioError) as excinfo:
        decode_audio_bytes(b"this is definitely not audio", "audio/wav", max_seconds=60)
    assert str(excinfo.value) == "audio could not be decoded"


def test_truncated_container_is_rejected():
    truncated = wav_bytes(0.5)[:20]
    with pytest.raises(MalformedAudioError):
        decode_audio_bytes(truncated, "audio/wav", max_seconds=60)


def test_streamless_container_is_rejected():
    """A structurally valid WAV header declaring zero frames carries no
    decodable audio."""
    with pytest.raises(MalformedAudioError):
        decode_audio_bytes(wav_bytes(0.0), "audio/wav", max_seconds=60)


def test_media_type_is_validated_before_the_payload_is_decoded():
    """An unsupported type must not be reported as malformed audio."""
    with pytest.raises(UnsupportedAudioTypeError):
        decode_audio_bytes(wav_bytes(0.2), "text/plain", max_seconds=60)


@pytest.mark.parametrize("bad", [0, -1, 1.5, True, False, "60", None])
def test_max_seconds_must_be_a_positive_integer(bad):
    with pytest.raises(ValueError, match="positive integer"):
        decode_audio_bytes(wav_bytes(0.2), "audio/wav", max_seconds=bad)


# --- decoding -------------------------------------------------------------


def test_decodes_to_mono_float32_at_16k():
    decoded = decode_audio_bytes(wav_bytes(0.5), "audio/wav", max_seconds=60)

    assert isinstance(decoded, DecodedAudio)
    assert decoded.sample_rate == TARGET_SAMPLE_RATE == 16000
    assert decoded.waveform.dtype.name == "float32"
    assert decoded.waveform.ndim == 1  # mono, not (channels, samples)
    assert decoded.waveform.shape[0] == 8000
    assert decoded.duration_s == pytest.approx(0.5, abs=0.01)


def test_stereo_at_a_different_rate_is_resampled_and_downmixed():
    """Both models need 16kHz mono; a 44.1kHz stereo upload is ordinary."""
    decoded = decode_audio_bytes(
        wav_bytes(0.25, rate=44100, channels=2), "audio/wav", max_seconds=60
    )

    assert decoded.sample_rate == TARGET_SAMPLE_RATE
    assert decoded.waveform.ndim == 1
    assert decoded.duration_s == pytest.approx(0.25, abs=0.02)


def test_decoded_result_is_immutable():
    decoded = decode_audio_bytes(wav_bytes(0.2), "audio/wav", max_seconds=60)
    with pytest.raises(Exception):
        decoded.duration_s = 99.0  # frozen dataclass


def test_duration_is_derived_from_decoded_samples():
    decoded = decode_audio_bytes(wav_bytes(1.0), "audio/wav", max_seconds=60)
    assert decoded.duration_s == pytest.approx(decoded.waveform.shape[0] / 16000, abs=1e-6)


# --- duration budget ------------------------------------------------------


def test_audio_longer_than_the_budget_is_rejected():
    with pytest.raises(AudioTooLongError, match="longer than the allowed duration"):
        decode_audio_bytes(wav_bytes(3.0), "audio/wav", max_seconds=1)


def test_audio_exactly_at_the_budget_is_accepted():
    decoded = decode_audio_bytes(wav_bytes(1.0), "audio/wav", max_seconds=1)
    assert decoded.duration_s == pytest.approx(1.0, abs=0.01)


def test_duration_comes_from_decoded_samples_not_from_container_metadata():
    """A container header can disagree with what actually decodes.

    This WAV physically holds 3s of samples, but its RIFF sizes are
    rewritten to declare 320 bytes of data. PyAV honours the declared
    chunk and yields 160 samples, so the honest answer is 0.01s — and
    that is what must be reported, because the duration is computed from
    the samples that came out of the decoder rather than from anything
    the file claims about itself. A metadata-derived duration would
    report 3s here, and a metadata-derived BUDGET check could be talked
    out of rejecting a genuinely over-long upload the same way.
    """
    doctored = bytearray(wav_bytes(3.0, rate=16000))
    doctored[4:8] = struct.pack("<I", 36 + 320)
    data_index = doctored.find(b"data")
    doctored[data_index + 4 : data_index + 8] = struct.pack("<I", 320)

    decoded = decode_audio_bytes(bytes(doctored), "audio/wav", max_seconds=1)

    assert decoded.waveform.shape[0] == 160
    assert decoded.duration_s == pytest.approx(160 / 16000, abs=1e-6)
    assert decoded.duration_s == pytest.approx(decoded.waveform.shape[0] / 16000, abs=1e-6)


def test_over_long_audio_is_rejected_on_sample_count_alone():
    """The budget check reads the running decoded-sample total; no
    stream.duration or container.duration is consulted anywhere."""
    source = Path("app/core/audio_decode.py").read_text(encoding="utf-8")
    assert "stream.duration" not in source
    assert "container.duration" not in source

    with pytest.raises(AudioTooLongError):
        decode_audio_bytes(wav_bytes(2.0), "audio/wav", max_seconds=1)


def test_decoding_stops_once_the_sample_budget_is_exceeded(monkeypatch):
    """An oversized upload must cost a bounded amount of decode work, not
    a full decode followed by a measurement."""
    import av

    frames_decoded = {"count": 0}
    real_open = av.open

    class CountingContainer:
        def __init__(self, inner):
            self._inner = inner

        def __enter__(self):
            self._inner.__enter__()
            return self

        def __exit__(self, *exc):
            return self._inner.__exit__(*exc)

        @property
        def streams(self):
            return self._inner.streams

        @property
        def format(self):
            return self._inner.format

        def decode(self, stream):
            for frame in self._inner.decode(stream):
                frames_decoded["count"] += 1
                yield frame

    monkeypatch.setattr(av, "open", lambda *a, **k: CountingContainer(real_open(*a, **k)))

    long_audio = wav_bytes(10.0)
    with pytest.raises(AudioTooLongError):
        decode_audio_bytes(long_audio, "audio/wav", max_seconds=1)
    stopped_early = frames_decoded["count"]

    frames_decoded["count"] = 0
    decode_audio_bytes(long_audio, "audio/wav", max_seconds=60)
    full_decode = frames_decoded["count"]

    assert stopped_early < full_decode


# --- disk and import boundaries -------------------------------------------


def test_decoding_never_creates_a_temporary_file(monkeypatch):
    """openai-whisper CAN take a path, but this pipeline never writes one.
    Every tempfile entry point is made to explode, so using one would
    fail this test rather than quietly leave audio on disk."""

    def _explode(*args, **kwargs):
        raise AssertionError("audio must never be written to disk")

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", _explode)
    monkeypatch.setattr(tempfile, "TemporaryFile", _explode)
    monkeypatch.setattr(tempfile, "mkstemp", _explode)

    decoded = decode_audio_bytes(wav_bytes(0.3), "audio/wav", max_seconds=60)
    assert decoded.waveform.shape[0] > 0


def test_importing_audio_decode_loads_no_model_stack():
    """Fresh interpreter: this module must not drag in the ML stack, and
    must not import PyAV or numpy until a decode actually happens."""
    code = (
        "import sys\n"
        "import app.core.audio_decode\n"
        "heavy = {'whisper', 'faster_whisper', 'torch', 'ctranslate2', 'av', 'numpy'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr
