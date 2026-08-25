"""
Unit tests for app/models/whisper_stt.py.

No real model, no weights, no network. Both backends are exercised
through fake model objects injected into sys.modules, so the adapters,
the deterministic options and the caching are all tested without
whisper or faster-whisper ever being imported for real.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import types
from pathlib import Path

import pytest

from app.core.audio_decode import DecodedAudio
from app.models.whisper_stt import (
    FASTER_WHISPER_BACKEND,
    SUPPORTED_BACKENDS,
    SUPPORTED_MODEL_SIZES,
    WHISPER_BACKEND,
    TranscriberUnavailableError,
    TranscriptContractError,
    TranscriptionFailedError,
    TranscriptResult,
    _FASTER_WHISPER_OPTIONS,
    _transcribe_faster_whisper,
    _transcribe_whisper,
    _WHISPER_OPTIONS,
    load_model,
    resolve_model_name,
    split_model_name,
    transcribe,
    validate_model_size,
    validate_transcript_result,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _clear_model_cache():
    load_model.cache_clear()
    yield
    load_model.cache_clear()


def decoded(duration_s: float = 1.0):
    """A DecodedAudio carrying a recognisable sentinel waveform. Not a
    numpy array — nothing in this module inspects it, which is itself
    part of the contract: the waveform is passed straight through."""
    return DecodedAudio(waveform=["WAVEFORM-SENTINEL"], sample_rate=16000, duration_s=duration_s)


class FakeWhisperModel:
    """Shape of openai-whisper's Whisper: transcribe() -> dict."""

    def __init__(self, text: str = " hello there ") -> None:
        self.text = text
        self.calls: list[tuple] = []

    def transcribe(self, audio, **kwargs):
        self.calls.append((audio, kwargs))
        return {"text": self.text, "segments": [], "language": "en"}


class FakeSegment:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeFasterWhisperModel:
    """Shape of faster-whisper's WhisperModel: transcribe() -> (segments, info)."""

    def __init__(self, texts=(" hello", " there ")) -> None:
        self.texts = texts
        self.calls: list[tuple] = []

    def transcribe(self, audio, **kwargs):
        self.calls.append((audio, kwargs))
        return (iter([FakeSegment(t) for t in self.texts]), types.SimpleNamespace(language="en"))


# --- model names ----------------------------------------------------------


def test_resolve_and_split_round_trip():
    for backend in SUPPORTED_BACKENDS:
        name = resolve_model_name(backend, "base")
        assert split_model_name(name) == (backend, "base")


def test_faster_whisper_name_is_not_parsed_as_the_whisper_backend():
    """"faster-whisper-base" starts with neither "whisper-" nor a unique
    prefix unless the longest backend is matched first."""
    assert split_model_name("faster-whisper-base") == (FASTER_WHISPER_BACKEND, "base")
    assert split_model_name("whisper-base") == (WHISPER_BACKEND, "base")


@pytest.mark.parametrize(
    "bad",
    ["", "   ", "whisper", "whisper-", "gpt-4", "base", None, 7, "whisper-large", "whisper-tiny"],
)
def test_unrecognised_model_names_are_rejected(bad):
    with pytest.raises(TranscriberUnavailableError):
        split_model_name(bad)


@pytest.mark.parametrize("bad_backend", ["", "vosk", "Whisper", None])
def test_resolve_rejects_unsupported_backends(bad_backend):
    with pytest.raises(TranscriberUnavailableError):
        resolve_model_name(bad_backend, "base")


@pytest.mark.parametrize("bad_size", ["", "   ", None, 3])
def test_resolve_rejects_a_missing_model_size(bad_size):
    with pytest.raises(TranscriberUnavailableError):
        resolve_model_name(WHISPER_BACKEND, bad_size)


# --- model-size allowlist -------------------------------------------------
#
# Both loaders take the size as a string that doubles as a path or repo
# id, so an unconstrained value turns configuration into "load an
# arbitrary checkpoint". Every rejection below must happen before any
# cache lookup or model-library call.


def test_only_base_is_supported():
    assert SUPPORTED_MODEL_SIZES == ("base",)
    assert validate_model_size("base") == "base"


@pytest.mark.parametrize(
    "bad",
    [
        "tiny",
        "small",
        "medium",
        "large",
        "large-v3",
        "Base",
        "BASE",
        " base",
        "base ",
        " base ",
        "base\n",
        "",
        "   ",
        "../base",
        "../../etc/passwd",
        "..\\base",
        "/abs/path/model.pt",
        "C:/weights/model.pt",
        "C:\\weights\\model.pt",
        "~/.cache/whisper/base.pt",
        "base/../large",
        "openai/whisper-large-v3",
        "file:///weights/base.pt",
        "https://example.invalid/base.pt",
        None,
        7,
        True,
        False,
        b"base",
        [],
        {},
    ],
)
def test_every_other_model_size_is_rejected(bad):
    with pytest.raises(TranscriberUnavailableError, match="model size is not supported"):
        validate_model_size(bad)


@pytest.mark.parametrize("bad", ["large", "../base", "/abs/path.pt", " base "])
def test_a_bad_size_never_reaches_a_cache_lookup_or_a_loader(bad, monkeypatch):
    """Validation is outside the lru_cache and ahead of every import."""

    def _explode(*args, **kwargs):
        raise AssertionError("no cache lookup or model load for an invalid size")

    monkeypatch.setattr("app.models.whisper_stt._load_model_cached", _explode)
    monkeypatch.setattr("app.models.whisper_stt._whisper_weights_present", _explode)

    with pytest.raises(TranscriberUnavailableError):
        load_model(WHISPER_BACKEND, bad, "int8", True)
    with pytest.raises(TranscriberUnavailableError):
        resolve_model_name(WHISPER_BACKEND, bad)


def test_a_bad_backend_never_reaches_a_cache_lookup(monkeypatch):
    def _explode(*args, **kwargs):
        raise AssertionError("no cache lookup for an invalid backend")

    monkeypatch.setattr("app.models.whisper_stt._load_model_cached", _explode)
    with pytest.raises(TranscriberUnavailableError, match="backend is not supported"):
        load_model("vosk", "base", "int8", True)


# --- adapters share one waveform and use deterministic options ------------


def test_both_adapters_receive_the_same_waveform_object():
    """The whole point of the shared decode: a WER difference between
    backends must be a model difference, never a decoder difference."""
    audio = decoded()
    whisper_model = FakeWhisperModel()
    faster_model = FakeFasterWhisperModel()

    _transcribe_whisper(whisper_model, audio.waveform)
    _transcribe_faster_whisper(faster_model, audio.waveform)

    assert whisper_model.calls[0][0] is audio.waveform
    assert faster_model.calls[0][0] is audio.waveform


def test_whisper_adapter_sends_deterministic_english_options():
    model = FakeWhisperModel()
    _transcribe_whisper(model, ["w"])
    options = model.calls[0][1]

    assert options["language"] == "en"
    assert options["task"] == "transcribe"
    assert options["temperature"] == 0.0  # not the default fallback schedule
    assert options["condition_on_previous_text"] is False
    assert options["fp16"] is False  # torch here is CPU-only


def test_faster_whisper_adapter_sends_deterministic_english_options():
    model = FakeFasterWhisperModel()
    _transcribe_faster_whisper(model, ["w"])
    options = model.calls[0][1]

    assert options["language"] == "en"
    assert options["task"] == "transcribe"
    assert options["temperature"] == 0.0
    assert options["beam_size"] == 1  # library default is 5
    assert options["condition_on_previous_text"] is False


def test_option_sets_agree_on_every_shared_key():
    """Where both libraries expose the same knob, the comparison is only
    fair if the value matches."""
    shared = set(_WHISPER_OPTIONS) & set(_FASTER_WHISPER_OPTIONS)
    assert shared  # guard against the sets drifting apart entirely
    for key in shared:
        assert _WHISPER_OPTIONS[key] == _FASTER_WHISPER_OPTIONS[key]


def test_faster_whisper_segments_are_joined_in_order():
    model = FakeFasterWhisperModel(texts=(" one", " two", " three"))
    assert _transcribe_faster_whisper(model, ["w"]) == " one two three"


# --- malformed model output is a failure, never silence -------------------


class ReturningModel:
    def __init__(self, value) -> None:
        self.value = value

    def transcribe(self, audio, **kwargs):
        return self.value


@pytest.mark.parametrize(
    "returned",
    [
        None,
        "just a string",
        [],
        {"segments": []},              # no "text" key
        {"text": None},
        {"text": 42},
        {"text": ["a", "b"]},
        {"text": b"bytes"},
    ],
)
def test_malformed_whisper_output_is_a_typed_failure_not_empty_silence(returned):
    """Coercing this to "" would show the user an empty transcript and no
    hint that the model misbehaved — indistinguishable from a silent
    recording, which IS a legitimate result."""
    with pytest.raises(TranscriptionFailedError):
        _transcribe_whisper(ReturningModel(returned), ["w"])


def test_an_empty_whisper_text_is_still_valid_silence():
    assert _transcribe_whisper(ReturningModel({"text": ""}), ["w"]) == ""


class BadSegment:
    text = None


@pytest.mark.parametrize(
    "returned",
    [
        None,
        "not a tuple",
        ([FakeSegment("a")],),              # one-element tuple
        ([FakeSegment("a")], "info", "extra"),
        (object(), "info"),                 # segments not iterable
        ([BadSegment()], "info"),           # segment.text is not a string
        ([FakeSegment("a"), BadSegment()], "info"),
    ],
)
def test_malformed_faster_whisper_output_is_a_typed_failure(returned):
    with pytest.raises(TranscriptionFailedError):
        _transcribe_faster_whisper(ReturningModel(returned), ["w"])


def test_faster_whisper_with_no_segments_is_valid_silence():
    assert _transcribe_faster_whisper(ReturningModel(([], "info")), ["w"]) == ""


# --- lazy, cached loading -------------------------------------------------


def test_load_model_imports_whisper_lazily_and_caches(monkeypatch):
    loads = {"count": 0}

    def fake_load_model(size):
        loads["count"] += 1
        return FakeWhisperModel()

    fake_whisper = types.SimpleNamespace(load_model=fake_load_model)
    monkeypatch.setitem(sys.modules, "whisper", fake_whisper)
    monkeypatch.setattr("app.models.whisper_stt._whisper_weights_present", lambda size: True)

    first = load_model(WHISPER_BACKEND, "base", "int8", True)
    second = load_model(WHISPER_BACKEND, "base", "int8", True)

    assert first is second
    assert loads["count"] == 1


def test_model_cache_is_keyed_on_the_whole_configuration(monkeypatch):
    """The V3 comparison holds both backends in one process; a cache keyed
    only on the backend would evict one to load the other."""
    monkeypatch.setitem(
        sys.modules, "whisper", types.SimpleNamespace(load_model=lambda size: FakeWhisperModel())
    )
    monkeypatch.setitem(
        sys.modules,
        "faster_whisper",
        types.SimpleNamespace(WhisperModel=lambda *a, **k: FakeFasterWhisperModel()),
    )
    monkeypatch.setattr("app.models.whisper_stt._whisper_weights_present", lambda size: True)

    a = load_model(WHISPER_BACKEND, "base", "int8", True)
    b = load_model(FASTER_WHISPER_BACKEND, "base", "int8", True)
    c = load_model(WHISPER_BACKEND, "base", "int8", True)

    assert a is c
    assert a is not b


def test_faster_whisper_receives_cpu_and_the_configured_compute_type(monkeypatch):
    captured = {}

    def fake_ctor(size, **kwargs):
        captured["size"] = size
        captured.update(kwargs)
        return FakeFasterWhisperModel()

    monkeypatch.setitem(
        sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=fake_ctor)
    )

    load_model(FASTER_WHISPER_BACKEND, "base", "int8", True)

    assert captured["size"] == "base"
    assert captured["device"] == "cpu"
    assert captured["compute_type"] == "int8"
    assert captured["local_files_only"] is True


def test_local_files_only_reaches_faster_whisper_unchanged(monkeypatch):
    captured = {}
    monkeypatch.setitem(
        sys.modules,
        "faster_whisper",
        types.SimpleNamespace(
            WhisperModel=lambda size, **kw: captured.update(kw) or FakeFasterWhisperModel()
        ),
    )
    load_model(FASTER_WHISPER_BACKEND, "base", "float32", False)
    assert captured["local_files_only"] is False
    assert captured["compute_type"] == "float32"


# --- unavailable backends -------------------------------------------------


def test_missing_whisper_weights_refuse_rather_than_download(monkeypatch):
    """openai-whisper has no local_files_only switch — load_model() would
    silently fetch ~145MB. A user request must never trigger that."""
    monkeypatch.setattr("app.models.whisper_stt._whisper_weights_present", lambda size: False)

    with pytest.raises(TranscriberUnavailableError, match="not available locally"):
        load_model(WHISPER_BACKEND, "base", "int8", True)


def test_weights_check_is_skipped_when_downloads_are_permitted(monkeypatch):
    monkeypatch.setattr("app.models.whisper_stt._whisper_weights_present", lambda size: False)
    monkeypatch.setitem(
        sys.modules, "whisper", types.SimpleNamespace(load_model=lambda size: FakeWhisperModel())
    )
    assert load_model(WHISPER_BACKEND, "base", "int8", False) is not None


def test_uninstalled_backend_is_an_unavailable_error(monkeypatch):
    """faster-whisper is declared in requirements-eval.txt, so a
    runtime-only install genuinely will not have it."""
    monkeypatch.setitem(sys.modules, "faster_whisper", None)

    with pytest.raises(TranscriberUnavailableError, match="not installed"):
        load_model(FASTER_WHISPER_BACKEND, "base", "int8", True)


def test_a_failing_loader_becomes_a_bounded_unavailable_error(monkeypatch):
    def explode(size):
        raise RuntimeError("C:/secret/path/base.pt is corrupt")

    monkeypatch.setitem(sys.modules, "whisper", types.SimpleNamespace(load_model=explode))
    monkeypatch.setattr("app.models.whisper_stt._whisper_weights_present", lambda size: True)

    with pytest.raises(TranscriberUnavailableError) as excinfo:
        load_model(WHISPER_BACKEND, "base", "int8", True)
    assert "secret" not in str(excinfo.value)
    assert str(excinfo.value) == "speech-to-text model could not be loaded"


def test_unsupported_backend_is_rejected_by_the_loader():
    with pytest.raises(TranscriberUnavailableError, match="not supported"):
        load_model("vosk", "base", "int8", True)


# --- transcribe() ---------------------------------------------------------


def test_transcribe_returns_the_api_shaped_result(monkeypatch):
    monkeypatch.setattr(
        "app.models.whisper_stt.load_model", lambda *a, **k: FakeWhisperModel(" hello there ")
    )
    result = transcribe(decoded(duration_s=2.5), model_name="whisper-base")

    assert isinstance(result, TranscriptResult)
    assert result.text == "hello there"  # stripped
    assert result.model_name == "whisper-base"
    assert result.audio_duration_s == 2.5
    assert isinstance(result.transcription_ms, float)
    assert result.transcription_ms >= 0


def test_transcript_result_fields_match_the_api_contract_exactly():
    fields = set(TranscriptResult.__dataclass_fields__)
    assert fields == {"text", "model_name", "transcription_ms", "audio_duration_s"}


# --- transcript result contract -------------------------------------------


def result(**overrides):
    base = {
        "text": "hello",
        "model_name": "whisper-base",
        "transcription_ms": 12.5,
        "audio_duration_s": 2.0,
    }
    base.update(overrides)
    return TranscriptResult(**base)


def check(res, model_name="whisper-base", duration=2.0):
    return validate_transcript_result(
        res, expected_model_name=model_name, expected_duration_s=duration
    )


def test_a_well_formed_result_passes():
    res = result()
    assert check(res) is res


@pytest.mark.parametrize("not_a_result", [None, "text", {"text": "x"}, object(), 42])
def test_a_non_result_object_is_a_contract_error(not_a_result):
    with pytest.raises(TranscriptContractError):
        check(not_a_result)


@pytest.mark.parametrize("bad_text", [None, 42, b"bytes", ["a"]])
def test_non_string_text_is_a_contract_error(bad_text):
    with pytest.raises(TranscriptContractError):
        check(result(text=bad_text))


def test_empty_text_is_allowed():
    assert check(result(text="")).text == ""


@pytest.mark.parametrize("bad_name", ["", "   ", None, 42])
def test_blank_or_non_string_model_name_is_a_contract_error(bad_name):
    with pytest.raises(TranscriptContractError):
        check(result(model_name=bad_name))


def test_a_model_name_that_is_not_the_requested_one_is_a_contract_error():
    """Catches a backend that quietly answered for a different model —
    which would silently invalidate any comparison built on the field."""
    with pytest.raises(TranscriptContractError):
        check(result(model_name="faster-whisper-base"), model_name="whisper-base")


@pytest.mark.parametrize("field", ["transcription_ms", "audio_duration_s"])
@pytest.mark.parametrize(
    "bad", [True, False, float("nan"), float("inf"), float("-inf"), -0.001, -1, None, "12", []]
)
def test_bad_numeric_fields_are_contract_errors(field, bad):
    """bool is called out explicitly: as an int subclass it would
    otherwise sail through as 1.0 or 0.0."""
    with pytest.raises(TranscriptContractError):
        check(result(**{field: bad}), duration=2.0 if field != "audio_duration_s" else bad)


@pytest.mark.parametrize("good", [0, 0.0, 1, 12.5])
def test_zero_and_positive_numbers_are_accepted(good):
    assert check(result(transcription_ms=good)).transcription_ms == good


def test_a_duration_that_disagrees_with_the_decoded_audio_is_a_contract_error():
    """Catches a result stitched to the wrong audio."""
    with pytest.raises(TranscriptContractError):
        check(result(audio_duration_s=2.0), duration=5.0)


def test_a_duration_matching_within_floating_point_tolerance_is_accepted():
    assert check(result(audio_duration_s=2.0), duration=2.0 + 1e-9) is not None


def test_blank_transcript_is_returned_not_raised(monkeypatch):
    monkeypatch.setattr("app.models.whisper_stt.load_model", lambda *a, **k: FakeWhisperModel(""))
    assert transcribe(decoded(), model_name="whisper-base").text == ""


def test_transcribe_routes_to_the_faster_whisper_adapter(monkeypatch):
    fake = FakeFasterWhisperModel(texts=(" a", " b"))
    monkeypatch.setattr("app.models.whisper_stt.load_model", lambda *a, **k: fake)

    result = transcribe(decoded(), model_name="faster-whisper-base")

    assert result.text == "a b"
    assert result.model_name == "faster-whisper-base"
    assert fake.calls  # the faster-whisper adapter, not whisper's


def test_transcription_failure_is_bounded(monkeypatch):
    class Exploding:
        def transcribe(self, audio, **kwargs):
            raise RuntimeError("internal detail C:/tmp/audio.wav")

    monkeypatch.setattr("app.models.whisper_stt.load_model", lambda *a, **k: Exploding())

    with pytest.raises(TranscriptionFailedError) as excinfo:
        transcribe(decoded(), model_name="whisper-base")
    assert str(excinfo.value) == "transcription failed"
    assert "tmp" not in str(excinfo.value)


def test_transcribe_requires_decoded_audio():
    with pytest.raises(TranscriptionFailedError):
        transcribe(b"raw bytes", model_name="whisper-base")


def test_transcribe_never_writes_a_temporary_file(monkeypatch):
    def _explode(*args, **kwargs):
        raise AssertionError("audio must never be written to disk")

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", _explode)
    monkeypatch.setattr(tempfile, "mkstemp", _explode)
    monkeypatch.setattr(
        "app.models.whisper_stt.load_model", lambda *a, **k: FakeWhisperModel("ok")
    )

    assert transcribe(decoded(), model_name="whisper-base").text == "ok"


def test_module_never_calls_whisper_load_audio():
    """load_audio is the path-and-ffmpeg entry point. Using it would mean
    a temp file and a second decoder — both deliberately avoided."""
    source = Path("app/models/whisper_stt.py").read_text(encoding="utf-8")
    # The docstring names it to explain why it is avoided; what must not
    # exist is a CALL to it.
    assert "load_audio(" not in source


# --- import boundary ------------------------------------------------------


def test_importing_whisper_stt_loads_no_model_stack():
    code = (
        "import sys\n"
        "import app.models.whisper_stt\n"
        "heavy = {'whisper', 'faster_whisper', 'torch', 'ctranslate2', 'av', 'numpy'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr
