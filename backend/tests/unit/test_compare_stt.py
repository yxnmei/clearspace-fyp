"""
Unit tests for evaluation/scripts/compare_stt.py — the V3 STT runner's
dataset contract, preflight, execution protocol and artefact.

No model is reachable. Audio is REAL: WAV fixtures are synthesised in
memory with the standard library's `wave` module and decoded by the
production decoder, so preflight is genuinely exercised; only the model
calls are faked, through the three injected callables. Artefacts are
written to pytest tmp_path, never to evaluation/results/.
"""

from __future__ import annotations

import io
import json
import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest

from app.core.audio_decode import TARGET_SAMPLE_RATE, DecodedAudio
from app.models.whisper_stt import (
    TranscriberUnavailableError,
    TranscriptionFailedError,
    TranscriptResult,
)
from evaluation.scripts import compare_stt as runner
from evaluation.scripts.compare_stt import (
    COMPARED_MODEL_NAMES,
    MAX_CLIPS,
    ClipFileMissingError,
    LabelContractError,
    PreflightError,
    backend_order,
    call_bounds,
    load_label_set,
    parse_label_set,
    preflight_decode,
    run_comparison,
)

_BACKEND_DIR = Path(__file__).resolve().parents[2]

WHISPER, FASTER = COMPARED_MODEL_NAMES


# --- fixtures -------------------------------------------------------------


def wav_bytes(seconds: float = 1.0, rate: int = TARGET_SAMPLE_RATE) -> bytes:
    """A real mono WAV container holding a 440Hz tone. stdlib only."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        frames = bytearray()
        for i in range(int(rate * seconds)):
            frames += struct.pack("<h", int(3000 * math.sin(2 * math.pi * 440 * i / rate)))
        writer.writeframes(bytes(frames))
    return buf.getvalue()


def clip(index: int = 1, **overrides) -> dict:
    entry = {
        "clip_id": f"clip_{index:03d}",
        "filename": f"clip_{index:03d}.wav",
        "media_type": "audio/wav",
        "category": "context_typical",
        "reference_transcript": "keep the desk by the window",
        "wer_scored": True,
        "notes": "",
    }
    entry.update(overrides)
    return entry


_UNSET = object()


def label_file(clips=_UNSET, **overrides) -> dict:
    """`clips=None` is passed through deliberately — the rejection tests
    need to hand the loader a genuine null, not fall back to a default."""
    payload = {
        "schema_version": 1,
        "recorded_by": "self",
        "consent": "self_recorded",
        "clips": [clip(1)] if clips is _UNSET else clips,
    }
    payload.update(overrides)
    return payload


def write_dataset(tmp_path: Path, clips: list[dict], *, seconds: float = 1.0, **overrides):
    """Label file on disk plus a real WAV for every clip."""
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir(exist_ok=True)
    for entry in clips:
        (audio_dir / entry["filename"]).write_bytes(wav_bytes(seconds))
    labels_path = tmp_path / "audio_labels.json"
    labels_path.write_text(json.dumps(label_file(clips, **overrides)), encoding="utf-8")
    return labels_path, audio_dir


class FakeModels:
    """Stands in for load_model / transcribe / cache_clear together, and
    records exactly what the protocol did."""

    def __init__(self, texts: dict[str, list[str]] | None = None, fail_on=None):
        self.texts = texts or {}
        self.fail_on = fail_on or {}
        self.cache_clears = 0
        self.loads: list[tuple] = []
        self.calls: list[dict] = []
        self._counters: dict[tuple[str, str], int] = {}

    def cache_clear(self) -> None:
        self.cache_clears += 1

    def load_model(self, backend, size, compute_type, local_files_only):
        self.loads.append((backend, size, compute_type, local_files_only))
        return object()

    def transcribe(self, audio, *, model_name, compute_type, local_files_only):
        self.calls.append(
            {
                "audio": audio,
                "audio_id": id(audio),
                "model_name": model_name,
                "compute_type": compute_type,
                "local_files_only": local_files_only,
            }
        )
        key = (model_name, getattr(audio, "_clip_id", ""))
        index = self._counters.get(key, 0)
        self._counters[key] = index + 1

        failure = self.fail_on.get(model_name)
        if failure is not None and len(self.calls) >= failure:
            raise TranscriptionFailedError("transcription failed")

        scripted = self.texts.get(model_name)
        text = scripted[min(index, len(scripted) - 1)] if scripted else "keep the desk by the window"
        return TranscriptResult(
            text=text,
            model_name=model_name,
            transcription_ms=1.5,
            audio_duration_s=audio.duration_s,
        )

    def measured_calls(self) -> list[dict]:
        """Everything after the two warm-up calls."""
        return self.calls[len(COMPARED_MODEL_NAMES) :]


class ScriptedModels:
    """Per-backend call scripts, so one clip's repetitions can succeed,
    fail or diverge independently.

    Each script is consumed in order for that backend: entry 0 is the
    warm-up call, entries 1.. are the measured repetitions. An Exception
    instance is raised instead of returned.
    """

    def __init__(self, scripts: dict[str, list], load_errors: dict[str, BaseException] | None = None):
        self.scripts = scripts
        self.load_errors = load_errors or {}
        self.cache_clears = 0
        self.loads: list[tuple] = []
        self.calls: list[dict] = []
        self._index: dict[str, int] = {}

    def cache_clear(self) -> None:
        self.cache_clears += 1

    def load_model(self, backend, size, compute_type, local_files_only):
        self.loads.append((backend, size, compute_type, local_files_only))
        error = self.load_errors.get(backend)
        if error is not None:
            raise error
        return object()

    def transcribe(self, audio, *, model_name, compute_type, local_files_only):
        self.calls.append({"model_name": model_name, "audio_id": id(audio)})
        index = self._index.get(model_name, 0)
        self._index[model_name] = index + 1
        script = self.scripts[model_name]
        entry = script[index] if index < len(script) else script[-1]
        if isinstance(entry, BaseException):
            raise entry
        return TranscriptResult(
            text=entry,
            model_name=model_name,
            transcription_ms=1.5,
            audio_duration_s=audio.duration_s,
        )


def one_clip(tmp_path):
    """A single scored clip, decoded, ready to run."""
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    return preflight_decode(labels, audio_dir), labels


def run(prepared, labels, models, *, reps=1, save=None, compute_type="int8"):
    return run_comparison(
        prepared,
        reps=reps,
        compute_type=compute_type,
        transcribe_fn=models.transcribe,
        load_model_fn=models.load_model,
        cache_clear_fn=models.cache_clear,
        labels=labels,
        save=save,
    )


# --- schema rejection matrix ----------------------------------------------


def test_a_valid_label_file_parses():
    parsed = parse_label_set(label_file())
    assert parsed.schema_version == 1
    assert parsed.recorded_by == "self"
    assert parsed.consent == "self_recorded"
    assert len(parsed.clips) == 1
    assert parsed.clips[0].clip_id == "clip_001"


@pytest.mark.parametrize("raw", [None, [], "text", 3, True])
def test_a_non_object_label_file_is_rejected(raw):
    with pytest.raises(LabelContractError, match="JSON object"):
        parse_label_set(raw)


@pytest.mark.parametrize("field", ["schema_version", "recorded_by", "consent", "clips"])
def test_a_missing_top_level_field_is_rejected(field):
    payload = label_file()
    del payload[field]
    with pytest.raises(LabelContractError, match="missing field"):
        parse_label_set(payload)


def test_an_unexpected_top_level_field_is_rejected_not_ignored():
    with pytest.raises(LabelContractError, match="unexpected field"):
        parse_label_set(label_file(speaker_age=31))


@pytest.mark.parametrize("version", [0, 2, 99, -1])
def test_an_unknown_schema_version_is_rejected(version):
    with pytest.raises(LabelContractError, match="unsupported schema_version"):
        parse_label_set(label_file(schema_version=version))


@pytest.mark.parametrize("version", ["1", 1.0, True, None])
def test_a_non_integer_schema_version_is_rejected(version):
    with pytest.raises(LabelContractError, match="schema_version must be an integer"):
        parse_label_set(label_file(schema_version=version))


@pytest.mark.parametrize("field", ["recorded_by", "consent"])
@pytest.mark.parametrize("value", ["", "   ", None, 5])
def test_blank_or_wrongly_typed_provenance_fields_are_rejected(field, value):
    with pytest.raises(LabelContractError):
        parse_label_set(label_file(**{field: value}))


@pytest.mark.parametrize("clips", [None, {}, "clip", 4])
def test_clips_must_be_an_array(clips):
    with pytest.raises(LabelContractError, match="clips must be an array"):
        parse_label_set(label_file(clips=clips))


def test_an_empty_clip_list_is_rejected():
    with pytest.raises(LabelContractError, match="must not be empty"):
        parse_label_set(label_file(clips=[]))


def test_more_than_thirty_clips_is_rejected():
    clips = [clip(i) for i in range(1, MAX_CLIPS + 2)]
    with pytest.raises(LabelContractError, match=f"at most {MAX_CLIPS}"):
        parse_label_set(label_file(clips))


def test_exactly_thirty_clips_is_allowed():
    parsed = parse_label_set(label_file([clip(i) for i in range(1, MAX_CLIPS + 1)]))
    assert len(parsed.clips) == MAX_CLIPS


@pytest.mark.parametrize(
    "field",
    ["clip_id", "filename", "media_type", "category", "reference_transcript", "wer_scored", "notes"],
)
def test_a_missing_clip_field_is_rejected(field):
    entry = clip(1)
    del entry[field]
    with pytest.raises(LabelContractError, match="missing field"):
        parse_label_set(label_file([entry]))


def test_an_unexpected_clip_field_is_rejected():
    with pytest.raises(LabelContractError, match="unexpected field"):
        parse_label_set(label_file([clip(1, speaker="me")]))


def test_a_duplicate_clip_id_is_rejected():
    clips = [clip(1), clip(2, clip_id="clip_001")]
    with pytest.raises(LabelContractError, match="duplicate clip_id"):
        parse_label_set(label_file(clips))


def test_a_duplicate_filename_is_rejected_so_one_recording_is_not_counted_twice():
    clips = [clip(1), clip(2, filename="clip_001.wav")]
    with pytest.raises(LabelContractError, match="duplicate filename"):
        parse_label_set(label_file(clips))


@pytest.mark.parametrize(
    "filename",
    [
        "sub/clip.wav",
        "sub\\clip.wav",
        "../clip.wav",
        "/abs/clip.wav",
        "C:/abs/clip.wav",
        ".",
        "..",
    ],
)
def test_a_path_instead_of_a_bare_filename_is_rejected(filename):
    with pytest.raises(LabelContractError, match="bare filename"):
        parse_label_set(label_file([clip(1, filename=filename)]))


@pytest.mark.parametrize("media_type", ["audio/flac", "video/mp4", "text/plain", "", "   ", None, 7])
def test_an_unsupported_media_type_is_rejected(media_type):
    with pytest.raises(LabelContractError):
        parse_label_set(label_file([clip(1, media_type=media_type)]))


def test_a_media_type_with_codec_parameters_is_normalised():
    parsed = parse_label_set(label_file([clip(1, media_type="audio/webm;codecs=opus")]))
    assert parsed.clips[0].media_type == "audio/webm"


@pytest.mark.parametrize("value", ["true", 1, 0, None])
def test_a_non_boolean_wer_scored_is_rejected(value):
    with pytest.raises(LabelContractError, match="wer_scored must be a boolean"):
        parse_label_set(label_file([clip(1, wer_scored=value)]))


@pytest.mark.parametrize("reference", ["", "   ", "...", "!?"])
def test_a_scored_clip_with_no_reference_words_is_rejected(reference):
    """WER is errors over reference words; a zero denominator has no
    rate. Silence clips set wer_scored=false instead."""
    with pytest.raises(LabelContractError, match="must contain words"):
        parse_label_set(label_file([clip(1, reference_transcript=reference)]))


def test_an_unscored_silence_clip_may_have_an_empty_reference():
    parsed = parse_label_set(
        label_file([clip(1, reference_transcript="", wer_scored=False, category="silence")])
    )
    assert parsed.clips[0].wer_scored is False


def test_notes_may_be_empty_but_must_be_present_and_a_string():
    assert parse_label_set(label_file([clip(1, notes="")])).clips[0].notes == ""
    with pytest.raises(LabelContractError):
        parse_label_set(label_file([clip(1, notes=None)]))


def test_load_label_set_reports_a_missing_file_and_bad_json_as_contract_errors(tmp_path):
    with pytest.raises(LabelContractError, match="does not exist"):
        load_label_set(tmp_path / "nope.json")

    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    with pytest.raises(LabelContractError, match="not valid JSON"):
        load_label_set(broken)


def test_the_committed_example_file_satisfies_the_schema():
    path = _BACKEND_DIR / "evaluation" / "labels" / "audio_labels.example.json"
    parsed = load_label_set(path)
    assert parsed.schema_version == runner.SCHEMA_VERSION
    assert any(not c.wer_scored for c in parsed.clips), "the template should show a silence clip"


# --- preflight ------------------------------------------------------------


def test_preflight_decodes_real_audio_once_per_clip(tmp_path):
    clips = [clip(1), clip(2)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)

    decoded_calls = []

    def counting_decode(audio_bytes, media_type, *, max_seconds):
        decoded_calls.append(media_type)
        from app.core.audio_decode import decode_audio_bytes

        return decode_audio_bytes(audio_bytes, media_type, max_seconds=max_seconds)

    prepared = preflight_decode(labels, audio_dir, decode_fn=counting_decode)

    assert len(prepared) == 2
    assert len(decoded_calls) == 2, "exactly one decode per clip"
    assert all(isinstance(p.decoded, DecodedAudio) for p in prepared)
    assert prepared[0].decoded.sample_rate == TARGET_SAMPLE_RATE


def test_a_missing_audio_file_fails_loudly_and_is_never_skipped(tmp_path):
    clips = [clip(1), clip(2)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    (audio_dir / "clip_002.wav").unlink()
    labels = load_label_set(labels_path)

    with pytest.raises(ClipFileMissingError, match="clip_002.wav"):
        preflight_decode(labels, audio_dir)


def test_every_missing_file_is_reported_at_once(tmp_path):
    clips = [clip(1), clip(2), clip(3)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    (audio_dir / "clip_001.wav").unlink()
    (audio_dir / "clip_003.wav").unlink()
    labels = load_label_set(labels_path)

    with pytest.raises(ClipFileMissingError) as excinfo:
        preflight_decode(labels, audio_dir)
    assert "clip_001.wav" in str(excinfo.value) and "clip_003.wav" in str(excinfo.value)


def test_a_missing_file_aborts_before_any_model_call(tmp_path):
    """The whole point of preflight: a dataset mistake costs nothing."""
    clips = [clip(1)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    (audio_dir / "clip_001.wav").unlink()
    labels = load_label_set(labels_path)
    models = FakeModels()

    with pytest.raises(ClipFileMissingError):
        prepared = preflight_decode(labels, audio_dir)
        run(prepared, labels, models)

    assert models.loads == []
    assert models.calls == []
    assert models.cache_clears == 0


def test_a_container_that_disagrees_with_its_declared_type_aborts_preflight(tmp_path):
    clips = [clip(1, filename="clip_001.webm", media_type="audio/webm")]
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    (audio_dir / "clip_001.webm").write_bytes(wav_bytes())  # WAV bytes, webm claim
    labels_path = tmp_path / "labels.json"
    labels_path.write_text(json.dumps(label_file(clips)), encoding="utf-8")
    labels = load_label_set(labels_path)

    with pytest.raises(PreflightError, match="clip_001"):
        preflight_decode(labels, audio_dir)


def test_an_over_long_clip_aborts_preflight(tmp_path):
    clips = [clip(1)]
    labels_path, audio_dir = write_dataset(tmp_path, clips, seconds=2.0)
    labels = load_label_set(labels_path)

    with pytest.raises(PreflightError, match="clip_001"):
        preflight_decode(labels, audio_dir, max_seconds=1)


def test_a_preflight_error_names_the_clip_but_leaks_no_decoder_text(tmp_path):
    clips = [clip(1)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    (audio_dir / "clip_001.wav").write_bytes(b"not audio at all")
    labels = load_label_set(labels_path)

    with pytest.raises(PreflightError) as excinfo:
        preflight_decode(labels, audio_dir)
    message = str(excinfo.value)
    assert "clip_001" in message
    assert str(tmp_path) not in message


# --- execution protocol ---------------------------------------------------


def test_call_bounds_for_twelve_clips_and_three_reps():
    bounds = call_bounds(12, 3)
    assert bounds["measured_inference_calls"] == 72
    assert bounds["warmup_calls"] == 2
    assert bounds["max_total_transcription_calls"] == 74


def test_call_bounds_makes_no_wall_clock_claim():
    note = call_bounds(12, 3)["_note"].lower()
    assert "call-count bounded only" in note
    assert "no wall-clock bound" in note


def test_backend_order_is_counterbalanced():
    firsts = [backend_order(c, r)[0] for c in range(12) for r in range(3)]
    assert firsts.count(WHISPER) == firsts.count(FASTER) == 18


def test_backend_order_always_contains_both_backends_once():
    for c in range(4):
        for r in range(3):
            assert sorted(backend_order(c, r)) == sorted(COMPARED_MODEL_NAMES)


def test_the_run_records_the_counterbalanced_order_it_used(tmp_path):
    clips = [clip(1), clip(2)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    report = run(prepared, labels, models, reps=2)

    counts = report["summary"]["backend_first_counts"]
    assert counts[WHISPER] == counts[FASTER] == 2
    assert report["clips"][0]["backend_order_per_rep"] == [
        [WHISPER, FASTER],
        [FASTER, WHISPER],
    ]


def test_exact_call_accounting_for_twelve_clips_and_three_reps(tmp_path):
    clips = [clip(i) for i in range(1, 13)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    report = run(prepared, labels, models, reps=3)

    assert len(models.calls) == 74
    assert len(models.measured_calls()) == 72
    assert report["bounds"]["measured_inference_calls"] == 72
    assert report["bounds"]["warmup_calls"] == 2
    assert report["bounds"]["max_total_transcription_calls"] == 74


def test_the_cache_is_cleared_exactly_once_before_two_cold_loads(tmp_path):
    """Clearing again between backends would evict the first one, and
    its 'warm' measured calls would silently pay a reload."""
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    report = run(prepared, labels, models)

    assert models.cache_clears == 1
    assert len(models.loads) == 2
    assert set(report["cold_load"]) == set(COMPARED_MODEL_NAMES)
    assert all(v["cold_load_ms"] >= 0 for v in report["cold_load"].values())
    assert report["model_cache_cleared_once_before_cold_loads"] is True


def test_cold_loads_always_request_local_files_only(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    run(prepared, labels, models)

    assert all(load[3] is True for load in models.loads)


def test_one_discarded_warmup_call_per_backend(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    report = run(prepared, labels, models, reps=1)

    assert [c["model_name"] for c in models.calls[:2]] == list(COMPARED_MODEL_NAMES)
    assert set(report["warmup"]["calls"]) == set(COMPARED_MODEL_NAMES)
    assert all(v["discarded"] is True for v in report["warmup"]["calls"].values())


def test_warmup_transcripts_never_appear_in_a_clip_row(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    # First scripted text is the warm-up; measured calls get the second.
    models = FakeModels(
        texts={
            WHISPER: ["WARMUP TEXT", "keep the desk by the window"],
            FASTER: ["WARMUP TEXT", "keep the desk by the window"],
        }
    )

    report = run(prepared, labels, models, reps=1)

    for model_name in COMPARED_MODEL_NAMES:
        assert "WARMUP TEXT" not in report["clips"][0]["backends"][model_name]["transcripts"]


def test_every_call_receives_the_same_decoded_object_identity(tmp_path):
    """The guarantee the whole comparison rests on: a WER difference is
    a model difference, not a decoder difference."""
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    run(prepared, labels, models, reps=3)

    expected = id(prepared[0].decoded)
    assert {c["audio_id"] for c in models.calls} == {expected}


def test_each_clip_keeps_its_own_decode_across_backends_and_reps(tmp_path):
    clips = [clip(1), clip(2)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    run(prepared, labels, models, reps=2)

    measured_ids = [c["audio_id"] for c in models.measured_calls()]
    first, second = id(prepared[0].decoded), id(prepared[1].decoded)
    assert measured_ids[:4] == [first] * 4
    assert measured_ids[4:] == [second] * 4


def test_measured_calls_always_pass_local_files_only_true(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    run(prepared, labels, models, reps=2)

    assert all(c["local_files_only"] is True for c in models.calls)


def test_compute_type_reaches_every_call_and_the_metadata(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    report = run(prepared, labels, models, compute_type="float32")

    assert report["reproducibility"]["compute_type"] == "float32"
    assert all(c["compute_type"] == "float32" for c in models.calls)
    assert all(load[2] == "float32" for load in models.loads)


@pytest.mark.parametrize("reps", [0, 6, -1, 2.5, True, "3"])
def test_reps_outside_one_to_five_is_rejected(tmp_path, reps):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    with pytest.raises(ValueError, match="reps must be"):
        run(prepared, labels, FakeModels(), reps=reps)


# --- determinism, silence, accuracy ---------------------------------------


def test_identical_transcripts_across_reps_are_reported_as_deterministic(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    report = run(prepared, labels, FakeModels(), reps=3)

    for model_name in COMPARED_MODEL_NAMES:
        entry = report["clips"][0]["backends"][model_name]
        assert entry["deterministic_across_reps"] is True
        assert len(entry["transcripts"]) == 3
        assert report["summary"]["backends"][model_name]["all_transcripts_deterministic"] is True


def test_a_divergence_across_reps_is_recorded_not_averaged_away(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    # index 0 is the warm-up; the three measured calls diverge.
    models = FakeModels(
        texts={
            WHISPER: ["warm", "keep the desk", "keep the desk", "keep the chair"],
            FASTER: ["warm", "keep the desk"],
        }
    )

    report = run(prepared, labels, models, reps=3)

    entry = report["clips"][0]["backends"][WHISPER]
    assert entry["deterministic_across_reps"] is False
    assert len(entry["distinct_transcripts"]) == 2
    assert report["summary"]["backends"][WHISPER]["non_deterministic_clip_ids"] == ["clip_001"]
    assert report["summary"]["backends"][FASTER]["non_deterministic_clip_ids"] == []


def test_a_silence_clip_is_excluded_from_wer_and_scored_for_hallucination(tmp_path):
    clips = [
        clip(1),
        clip(2, category="silence", reference_transcript="", wer_scored=False),
    ]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels(
        texts={
            WHISPER: ["warm", "keep the desk by the window", "thank you for watching"],
            FASTER: ["warm", "keep the desk by the window", ""],
        }
    )

    report = run(prepared, labels, models, reps=1)

    silence_row = report["clips"][1]
    assert silence_row["wer_scored"] is False
    assert silence_row["backends"][WHISPER]["wer"] is None
    assert silence_row["backends"][WHISPER]["hallucinated"] is True
    assert silence_row["backends"][FASTER]["hallucinated"] is False

    summary = report["summary"]["backends"]
    assert summary[WHISPER]["silence"]["hallucinated_clip_ids"] == ["clip_002"]
    assert summary[FASTER]["silence"]["hallucinated_clip_ids"] == []
    # The silence clip contributes no reference words to either corpus.
    assert summary[WHISPER]["accuracy"]["clip_count"] == 1


def test_a_punctuation_only_output_on_silence_is_not_a_hallucination(tmp_path):
    clips = [clip(1, category="silence", reference_transcript="", wer_scored=False)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels(texts={WHISPER: ["warm", "..."], FASTER: ["warm", "..."]})

    report = run(prepared, labels, models, reps=1)

    assert report["clips"][0]["backends"][WHISPER]["hallucinated"] is False


def test_wer_counts_and_corpus_totals_reach_the_summary(tmp_path):
    clips = [clip(1, reference_transcript="keep the desk by the window")]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels(
        texts={
            WHISPER: ["warm", "Keep the desk by the window."],
            FASTER: ["warm", "keep the chair by the window"],
        }
    )

    report = run(prepared, labels, models, reps=1)

    perfect = report["clips"][0]["backends"][WHISPER]["wer"]
    assert perfect["errors"] == 0 and perfect["reference_words"] == 6

    wrong = report["clips"][0]["backends"][FASTER]["wer"]
    assert wrong["substitutions"] == 1

    assert report["summary"]["backends"][WHISPER]["accuracy"]["corpus_wer"] == 0.0
    assert report["summary"]["backends"][FASTER]["accuracy"]["corpus_wer"] == pytest.approx(
        1 / 6, abs=1e-6
    )


def test_latency_statistics_and_rtf_are_recorded(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    report = run(prepared, labels, FakeModels(), reps=3)

    latency = report["clips"][0]["backends"][WHISPER]["latency"]
    assert latency["count"] == 3
    assert latency["median_ms"] == pytest.approx(1.5)
    assert latency["min_ms"] == latency["max_ms"] == pytest.approx(1.5)
    assert report["clips"][0]["backends"][WHISPER]["real_time_factor"] == pytest.approx(
        0.0015, abs=1e-6
    )


def test_duration_bands_are_summarised(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)], seconds=1.0)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    report = run(prepared, labels, FakeModels())

    assert report["clips"][0]["duration_band"] == "short_lt_5s"
    bands = report["summary"]["backends"][WHISPER]["duration_bands"]
    assert bands["short_lt_5s"]["clip_count"] == 1
    assert bands["mid_5_to_15s"]["clip_count"] == 0
    assert bands["mid_5_to_15s"]["median_latency_ms"] is None


# --- artefact honesty -----------------------------------------------------


def test_the_artefact_says_incomplete_before_any_inference(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    snapshots: list[dict] = []

    run(prepared, labels, FakeModels(), save=lambda r: snapshots.append(json.loads(json.dumps(r))))

    assert snapshots[0]["status"] == "incomplete"
    assert snapshots[0]["clips"] == []
    assert snapshots[-1]["status"] == "complete"
    assert snapshots[-1]["incomplete_reason"] is None


def test_the_artefact_is_saved_after_every_clip(tmp_path):
    clips = [clip(1), clip(2), clip(3)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    counts: list[int] = []

    run(prepared, labels, FakeModels(), save=lambda r: counts.append(len(r["clips"])))

    assert counts[0] == 0
    assert 1 in counts and 2 in counts and 3 in counts
    assert counts == sorted(counts)


def test_an_exception_mid_run_leaves_a_parseable_incomplete_artefact(tmp_path):
    clips = [clip(1), clip(2)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    out = tmp_path / "out" / "report.json"

    class Exploding(FakeModels):
        def transcribe(self, audio, **kwargs):
            if len(self.calls) >= 4:  # 2 warm-ups + 2 measured, then die
                raise RuntimeError("machine caught fire")
            return super().transcribe(audio, **kwargs)

    with pytest.raises(RuntimeError):
        run(prepared, labels, Exploding(), reps=1, save=runner._writer(out))

    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["status"] == "incomplete"
    assert saved["incomplete_reason"] == "run has not finished"
    assert len(saved["clips"]) == 1


def test_a_typed_transcription_failure_is_recorded_and_blocks_completion(tmp_path):
    clips = [clip(1), clip(2)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels(fail_on={WHISPER: 5, FASTER: 5})

    report = run(prepared, labels, models, reps=1)

    assert report["errors"], "a failure must be recorded, not swallowed"
    assert report["status"] == "incomplete"
    assert "transcription call(s) failed" in report["incomplete_reason"]
    assert report["summary"]["error_count"] == len(report["errors"])


def test_a_recorded_failure_carries_a_type_and_a_fixed_message_only(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    class Unavailable(FakeModels):
        def transcribe(self, audio, **kwargs):
            if len(self.calls) >= 2:
                self.calls.append({"model_name": kwargs["model_name"]})
                raise TranscriberUnavailableError("weights are at C:/Users/secret/model.bin")
            return super().transcribe(audio, **kwargs)

    report = run(prepared, labels, Unavailable(), reps=1)

    record = report["errors"][0]
    assert record["error_type"] == "TranscriberUnavailableError"
    assert record["detail"] == "backend unavailable or weights absent"
    assert "secret" not in json.dumps(report)


def test_a_clip_whose_calls_all_failed_reports_null_rather_than_zero(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels(fail_on={WHISPER: 3, FASTER: 3})

    report = run(prepared, labels, models, reps=1)

    entry = report["clips"][0]["backends"][WHISPER]
    assert entry["successful_calls"] == 0
    assert entry["latency"]["median_ms"] is None
    assert entry["real_time_factor"] is None
    assert entry["deterministic_across_reps"] is None
    assert entry["wer"] is None


def test_the_manual_review_block_is_present_and_entirely_null(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    report = run(prepared, labels, FakeModels())

    block = report["manual_review"]
    scored = {k: v for k, v in block.items() if not k.startswith("_")}
    assert scored and all(v is None for v in scored.values())
    assert "NOT ACCEPTANCE" in block["_instructions"]


def test_the_summary_says_measurement_is_not_promotion(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    report = run(prepared, labels, FakeModels())

    note = report["summary"]["_note"].lower()
    assert "not acceptance" in note
    assert "candidate" in note
    assert "never modifies a production default" in note


# --- reproducibility and privacy -----------------------------------------


def test_reproducibility_metadata_records_the_measured_configuration(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    meta = run(prepared, labels, FakeModels(), reps=2)["reproducibility"]

    assert meta["model_names"] == list(COMPARED_MODEL_NAMES)
    assert meta["model_size"] == "base"
    assert meta["compute_type"] == "int8"
    assert meta["local_files_only"] is True
    assert meta["sample_rate"] == TARGET_SAMPLE_RATE
    assert meta["reps"] == 2
    assert "NFKC" in meta["wer_rule"]


def test_reproducibility_metadata_records_package_versions(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    packages = run(prepared, labels, FakeModels())["reproducibility"]["packages"]

    for name in ("openai-whisper", "faster-whisper", "ctranslate2", "av", "numpy", "torch"):
        assert name in packages


def test_reading_package_versions_does_not_import_the_model_stack():
    code = (
        "import sys\n"
        "from evaluation.scripts.compare_stt import _package_versions\n"
        "_package_versions()\n"
        "heavy = {'whisper', 'faster_whisper', 'torch', 'ctranslate2'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_platform_metadata_is_sanitised(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    platform_meta = run(prepared, labels, FakeModels())["reproducibility"]["platform"]

    assert set(platform_meta) == {"system", "release", "machine", "python_version"}
    # No hostname: platform.node() is deliberately absent.
    import platform as platform_module

    assert platform_module.node() not in json.dumps(platform_meta)


def test_the_artefact_contains_no_absolute_path_home_directory_or_environment_value(tmp_path):
    clips = [clip(1), clip(2, category="silence", reference_transcript="", wer_scored=False)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    serialised = json.dumps(run(prepared, labels, FakeModels(), reps=2))

    assert str(tmp_path) not in serialised
    assert str(audio_dir) not in serialised
    assert str(Path.home()) not in serialised
    assert Path.home().name not in serialised
    for key in ("PATH", "USERNAME", "USERPROFILE", "HOME"):
        import os

        value = os.environ.get(key)
        if value:
            assert value not in serialised


def test_clip_rows_record_a_bare_filename_only(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    report = run(prepared, labels, FakeModels())

    assert report["clips"][0]["filename"] == "clip_001.wav"
    assert "/" not in report["clips"][0]["filename"]


def test_importing_the_runner_loads_no_model_library():
    code = (
        "import sys\n"
        "import evaluation.scripts.compare_stt\n"
        "heavy = {'whisper', 'faster_whisper', 'torch', 'ctranslate2'}\n"
        "loaded = heavy & set(sys.modules)\n"
        "assert not loaded, sorted(loaded)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(_BACKEND_DIR)
    )
    assert result.returncode == 0, result.stdout + result.stderr


# --- fetch ----------------------------------------------------------------


def test_fetch_is_the_only_caller_that_disables_local_files_only():
    calls: list[tuple] = []

    runner.fetch_weights(
        "faster-whisper", load_model_fn=lambda *args: calls.append(args) or object()
    )

    assert calls == [("faster-whisper", "base", "int8", False)]


def test_fetch_rejects_the_whisper_backend_before_reaching_the_loader():
    """openai-whisper's base.pt is already cached, so nothing about this
    comparison needs it downloaded. Narrowing fetch to the one genuinely
    missing model keeps the approved download and the reachable download
    identical."""
    calls: list[tuple] = []

    with pytest.raises(ValueError, match="backend must be one of"):
        runner.fetch_weights("whisper", load_model_fn=lambda *args: calls.append(args))

    assert calls == []


def test_faster_whisper_is_the_only_fetchable_backend():
    assert runner.FETCHABLE_BACKENDS == ("faster-whisper",)


@pytest.mark.parametrize("backend", ["not-a-backend", "faster-whisper-base", "", None])
def test_fetch_rejects_an_unknown_backend_without_calling_the_loader(backend):
    calls: list[tuple] = []
    with pytest.raises(ValueError, match="backend must be one of"):
        runner.fetch_weights(backend, load_model_fn=lambda *args: calls.append(args))
    assert calls == []


def test_a_measured_run_never_requests_a_download(tmp_path):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = FakeModels()

    run(prepared, labels, models, reps=2)

    assert all(load[3] is True for load in models.loads)
    assert all(c["local_files_only"] is True for c in models.calls)


# --- CLI ------------------------------------------------------------------


def test_the_cli_exposes_exactly_run_and_fetch():
    parser = runner.build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])
    assert parser.parse_args(["run", "--out", "r.json"]).command == "run"
    assert parser.parse_args(["fetch", "--backend", "faster-whisper"]).command == "fetch"


def test_the_cli_defaults_to_three_reps_and_int8():
    args = runner.build_parser().parse_args(["run", "--out", "r.json"])
    assert args.reps == 3
    assert args.compute_type == "int8"


@pytest.mark.parametrize("reps", ["0", "6", "-1"])
def test_the_cli_rejects_reps_outside_the_allowed_range(reps):
    with pytest.raises(SystemExit):
        runner.build_parser().parse_args(["run", "--out", "r.json", "--reps", reps])


@pytest.mark.parametrize("backend", ["whisper", "whisper-small", "faster-whisper-base"])
def test_the_cli_rejects_any_backend_but_faster_whisper(backend):
    with pytest.raises(SystemExit):
        runner.build_parser().parse_args(["fetch", "--backend", backend])


def test_main_reports_a_dataset_error_without_a_traceback(tmp_path, capsys):
    exit_code = runner.main(
        ["run", "--labels", str(tmp_path / "missing.json"), "--out", str(tmp_path / "out.json")]
    )

    assert exit_code == 2
    assert "label file does not exist" in capsys.readouterr().err
    assert not (tmp_path / "out.json").exists()


# --- correction 1: atomic artefact writes ---------------------------------


def test_a_successful_write_produces_valid_json_and_leaves_no_temporary(tmp_path):
    out = tmp_path / "nested" / "report.json"

    runner._writer(out)({"status": "complete", "clips": []})

    assert json.loads(out.read_text(encoding="utf-8"))["status"] == "complete"
    assert list(tmp_path.rglob("*.tmp")) == []


def test_a_second_write_replaces_the_first_atomically(tmp_path):
    out = tmp_path / "report.json"
    save = runner._writer(out)

    save({"status": "incomplete", "clips": []})
    save({"status": "complete", "clips": [1, 2]})

    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["status"] == "complete"
    assert saved["clips"] == [1, 2]
    assert list(tmp_path.glob("*.tmp")) == []


def test_a_serialisation_failure_leaves_the_previous_artefact_untouched(tmp_path):
    """Serialising BEFORE opening anything is the point: an
    unserialisable report must not truncate the last good result."""
    out = tmp_path / "report.json"
    save = runner._writer(out)
    save({"status": "incomplete", "clips": ["first"]})

    with pytest.raises(TypeError):
        save({"status": "complete", "clips": {"a set"}})

    assert json.loads(out.read_text(encoding="utf-8")) == {
        "status": "incomplete",
        "clips": ["first"],
    }
    assert list(tmp_path.glob("*.tmp")) == []


def test_a_failed_replace_preserves_the_destination_and_removes_the_temporary(tmp_path, monkeypatch):
    out = tmp_path / "report.json"
    save = runner._writer(out)
    save({"status": "incomplete", "clips": ["first"]})

    def exploding_replace(src, dst):
        raise OSError("disk went away")

    monkeypatch.setattr(runner.os, "replace", exploding_replace)

    with pytest.raises(OSError):
        save({"status": "complete", "clips": ["second"]})

    assert json.loads(out.read_text(encoding="utf-8"))["clips"] == ["first"]
    assert list(tmp_path.glob("*.tmp")) == []


def test_a_failed_temporary_write_never_creates_a_partial_destination(tmp_path, monkeypatch):
    out = tmp_path / "report.json"
    save = runner._writer(out)

    def exploding_fsync(fd):
        raise OSError("write failed")

    monkeypatch.setattr(runner.os, "fsync", exploding_fsync)

    with pytest.raises(OSError):
        save({"status": "complete", "clips": []})

    assert not out.exists(), "a failed write must not leave a partial destination"
    assert list(tmp_path.glob("*.tmp")) == []


def test_the_temporary_file_is_a_sibling_so_the_replace_is_same_filesystem(tmp_path, monkeypatch):
    out = tmp_path / "report.json"
    seen: list[Path] = []

    real_replace = runner.os.replace

    def watching_replace(src, dst):
        seen.append(Path(src))
        return real_replace(src, dst)

    monkeypatch.setattr(runner.os, "replace", watching_replace)
    runner._writer(out)({"status": "complete"})

    assert seen and seen[0].parent == out.parent


def test_an_atomically_written_artefact_contains_no_absolute_path(tmp_path):
    prepared, labels = one_clip(tmp_path)
    out = tmp_path / "report.json"

    run(prepared, labels, FakeModels(), reps=2, save=runner._writer(out))

    serialised = out.read_text(encoding="utf-8")
    assert str(tmp_path) not in serialised
    assert str(Path.home()) not in serialised
    assert json.loads(serialised)["status"] == "complete"


# --- correction 3: honest determinism and WER -----------------------------


def test_one_success_out_of_three_is_not_called_deterministic(tmp_path):
    """One surviving transcript is one distinct transcript. Reporting
    that as determinism would state the strongest claim from the weakest
    evidence."""
    prepared, labels = one_clip(tmp_path)
    failure = TranscriptionFailedError("transcription failed")
    models = ScriptedModels(
        {
            WHISPER: ["warm", "keep the desk by the window", failure, failure],
            FASTER: ["warm", "keep the desk by the window"],
        }
    )

    report = run(prepared, labels, models, reps=3)

    entry = report["clips"][0]["backends"][WHISPER]
    assert entry["successful_calls"] == 1
    assert entry["expected_calls"] == 3
    assert entry["complete_repetitions"] is False
    assert entry["deterministic_across_reps"] is None
    assert entry["wer"] is None
    assert entry["wer_excluded_reason"] == runner.WER_EXCLUDED_INCOMPLETE_REPS
    assert entry["transcripts"] == ["keep the desk by the window"]


def test_two_identical_successes_out_of_three_are_still_incomplete_evidence(tmp_path):
    prepared, labels = one_clip(tmp_path)
    failure = TranscriptionFailedError("transcription failed")
    models = ScriptedModels(
        {
            WHISPER: ["warm", "keep the desk", "keep the desk", failure],
            FASTER: ["warm", "keep the desk"],
        }
    )

    report = run(prepared, labels, models, reps=3)

    entry = report["clips"][0]["backends"][WHISPER]
    assert entry["successful_calls"] == 2
    assert entry["deterministic_across_reps"] is None
    assert entry["wer"] is None
    assert entry["wer_excluded_reason"] == runner.WER_EXCLUDED_INCOMPLETE_REPS
    assert len(entry["transcripts"]) == 2, "every transcript is preserved"


def test_three_divergent_successes_are_false_and_score_nothing(tmp_path):
    prepared, labels = one_clip(tmp_path)
    models = ScriptedModels(
        {
            WHISPER: ["warm", "keep the desk", "keep the chair", "keep the shelf"],
            FASTER: ["warm", "keep the desk by the window"],
        }
    )

    report = run(prepared, labels, models, reps=3)

    entry = report["clips"][0]["backends"][WHISPER]
    assert entry["successful_calls"] == 3
    assert entry["complete_repetitions"] is True
    assert entry["deterministic_across_reps"] is False
    assert entry["wer"] is None
    assert entry["wer_excluded_reason"] == runner.WER_EXCLUDED_NON_DETERMINISTIC
    # transcripts[0] is never quietly scored: call order is
    # counterbalanced, so picking it would be an arbitrary winner.
    assert len(entry["transcripts"]) == 3


def test_complete_deterministic_repetitions_are_scored(tmp_path):
    prepared, labels = one_clip(tmp_path)
    models = ScriptedModels(
        {
            WHISPER: ["warm", "keep the desk by the window"],
            FASTER: ["warm", "keep the desk by the window"],
        }
    )

    report = run(prepared, labels, models, reps=3)

    entry = report["clips"][0]["backends"][WHISPER]
    assert entry["successful_calls"] == 3
    assert entry["deterministic_across_reps"] is True
    assert entry["wer"]["errors"] == 0
    assert entry["wer_excluded_reason"] is None
    assert report["summary"]["backends"][WHISPER]["accuracy"]["complete"] is True
    assert report["summary"]["backends"][WHISPER]["accuracy"]["corpus_wer"] == 0.0


def test_headline_accuracy_is_withheld_when_a_scored_clip_is_excluded(tmp_path):
    """Averaging over only the clips that succeeded measures the easy
    subset and presents it as the corpus."""
    clips = [clip(1), clip(2)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)
    models = ScriptedModels(
        {
            # 1 warm-up, then clip 1's two reps (agreeing) and clip 2's
            # two reps (disagreeing).
            WHISPER: [
                "warm",
                "keep the desk by the window",
                "keep the desk by the window",
                "one transcript",
                "a different transcript",
            ],
            FASTER: ["warm", "keep the desk by the window"],
        }
    )

    report = run(prepared, labels, models, reps=2)

    accuracy = report["summary"]["backends"][WHISPER]["accuracy"]
    assert accuracy["complete"] is False
    assert accuracy["corpus_wer"] is None
    assert accuracy["mean_per_clip_wer"] is None
    assert accuracy["partial_corpus_wer_over_scored_clips_only"] is not None
    assert [e["clip_id"] for e in accuracy["excluded_clips"]] == ["clip_002"]
    assert accuracy["excluded_clips"][0]["reason"] == runner.WER_EXCLUDED_NON_DETERMINISTIC
    assert "INCOMPLETE" in accuracy["_note"]


def test_all_transcripts_deterministic_is_false_when_evidence_is_incomplete(tmp_path):
    prepared, labels = one_clip(tmp_path)
    failure = TranscriptionFailedError("transcription failed")
    models = ScriptedModels(
        {
            WHISPER: ["warm", "keep the desk", failure, failure],
            FASTER: ["warm", "keep the desk by the window"],
        }
    )

    report = run(prepared, labels, models, reps=3)

    whisper_summary = report["summary"]["backends"][WHISPER]
    assert whisper_summary["all_transcripts_deterministic"] is False
    assert whisper_summary["incomplete_evidence_clip_ids"] == ["clip_001"]
    assert whisper_summary["non_deterministic_clip_ids"] == []
    assert report["summary"]["backends"][FASTER]["all_transcripts_deterministic"] is True


def test_a_silence_clip_carries_its_own_fixed_exclusion_reason(tmp_path):
    clips = [clip(1, category="silence", reference_transcript="", wer_scored=False)]
    labels_path, audio_dir = write_dataset(tmp_path, clips)
    labels = load_label_set(labels_path)
    prepared = preflight_decode(labels, audio_dir)

    report = run(prepared, labels, FakeModels(), reps=1)

    entry = report["clips"][0]["backends"][WHISPER]
    assert entry["wer_excluded_reason"] == runner.WER_EXCLUDED_NOT_SCORED
    # A silence clip is not a scored clip, so it never makes accuracy incomplete.
    assert report["summary"]["backends"][WHISPER]["accuracy"]["complete"] is True


# --- correction 4: startup, warm-up and exit honesty ----------------------


@pytest.mark.parametrize("failing_backend", ["whisper", "faster-whisper"])
def test_a_cold_load_failure_leaves_a_parseable_incomplete_artefact(tmp_path, failing_backend):
    prepared, labels = one_clip(tmp_path)
    out = tmp_path / "report.json"
    models = ScriptedModels(
        {WHISPER: ["warm", "text"], FASTER: ["warm", "text"]},
        load_errors={failing_backend: TranscriberUnavailableError("weights at C:/Users/me/x.bin")},
    )

    report = run(prepared, labels, models, save=runner._writer(out))

    assert report["status"] == "incomplete"
    assert report["incomplete_reason"].startswith("cold_load failed for")
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["status"] == "incomplete"
    assert saved["errors"][0]["error_type"] == "TranscriberUnavailableError"
    assert "C:/Users" not in out.read_text(encoding="utf-8")
    assert models.calls == [], "no transcription is attempted after a load failure"


def test_a_second_backend_load_failure_still_records_the_first_cold_load(tmp_path):
    """Saving per backend rather than once after both is what keeps the
    first measurement as evidence of how far the run got."""
    prepared, labels = one_clip(tmp_path)
    out = tmp_path / "report.json"
    models = ScriptedModels(
        {WHISPER: ["warm", "text"], FASTER: ["warm", "text"]},
        load_errors={"faster-whisper": TranscriberUnavailableError("nope")},
    )

    run(prepared, labels, models, save=runner._writer(out))

    saved = json.loads(out.read_text(encoding="utf-8"))
    assert WHISPER in saved["cold_load"]
    assert FASTER not in saved["cold_load"]
    assert saved["status"] == "incomplete"


@pytest.mark.parametrize("failing_index", [0, 1])
def test_a_warmup_failure_leaves_a_parseable_incomplete_artefact(tmp_path, failing_index):
    prepared, labels = one_clip(tmp_path)
    out = tmp_path / "report.json"
    failing_model = COMPARED_MODEL_NAMES[failing_index]
    scripts = {WHISPER: ["warm", "text"], FASTER: ["warm", "text"]}
    scripts[failing_model] = [TranscriptionFailedError("boom")]
    models = ScriptedModels(scripts)

    report = run(prepared, labels, models, save=runner._writer(out))

    assert report["status"] == "incomplete"
    assert report["incomplete_reason"] == f"warmup failed for {failing_model}"
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["clips"] == []
    assert len(saved["cold_load"]) == 2, "both cold loads still happened and were recorded"
    assert saved["errors"][0]["error_type"] == "TranscriptionFailedError"


def test_a_first_backend_warmup_failure_stops_before_the_second(tmp_path):
    prepared, labels = one_clip(tmp_path)
    models = ScriptedModels(
        {WHISPER: [TranscriptionFailedError("boom")], FASTER: ["warm", "text"]}
    )

    run(prepared, labels, models)

    assert [c["model_name"] for c in models.calls] == [WHISPER]


def test_a_second_backend_warmup_failure_records_the_first_warmup(tmp_path):
    prepared, labels = one_clip(tmp_path)
    out = tmp_path / "report.json"
    models = ScriptedModels(
        {WHISPER: ["warm", "text"], FASTER: [TranscriptionFailedError("boom")]}
    )

    run(prepared, labels, models, save=runner._writer(out))

    saved = json.loads(out.read_text(encoding="utf-8"))
    assert WHISPER in saved["warmup"]["calls"]
    assert FASTER not in saved["warmup"]["calls"]


def test_an_untyped_defect_during_startup_still_surfaces_as_itself(tmp_path):
    """A programming bug must not be disguised as a model failure the
    user is told to retry."""
    prepared, labels = one_clip(tmp_path)
    models = ScriptedModels(
        {WHISPER: [AssertionError("a real defect")], FASTER: ["warm", "text"]}
    )

    with pytest.raises(AssertionError, match="a real defect"):
        run(prepared, labels, models)


def install_fake_backend(monkeypatch, models):
    monkeypatch.setattr(runner, "_default_transcribe_fn", lambda: models.transcribe)
    monkeypatch.setattr(runner, "_default_load_model_fn", lambda: models.load_model)
    monkeypatch.setattr(runner, "_default_cache_clear_fn", lambda: models.cache_clear)


def test_the_cli_exits_zero_and_says_so_on_a_clean_run(tmp_path, monkeypatch, capsys):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    out = tmp_path / "report.json"
    install_fake_backend(monkeypatch, FakeModels())

    code = runner.main(
        ["run", "--labels", str(labels_path), "--audio-dir", str(audio_dir), "--reps", "1", "--out", str(out)]
    )

    assert code == 0
    captured = capsys.readouterr()
    assert "Wrote report to" in captured.out
    assert json.loads(out.read_text(encoding="utf-8"))["status"] == "complete"


def test_the_cli_exits_non_zero_and_prints_no_success_line_on_an_incomplete_run(
    tmp_path, monkeypatch, capsys
):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    out = tmp_path / "report.json"
    models = ScriptedModels(
        {WHISPER: ["warm", "text"], FASTER: ["warm", "text"]},
        load_errors={"faster-whisper": TranscriberUnavailableError("nope")},
    )
    install_fake_backend(monkeypatch, models)

    code = runner.main(
        ["run", "--labels", str(labels_path), "--audio-dir", str(audio_dir), "--reps", "1", "--out", str(out)]
    )

    assert code == 1
    captured = capsys.readouterr()
    assert "Wrote report to" not in captured.out
    assert "incomplete run written to" in captured.err
    assert json.loads(out.read_text(encoding="utf-8"))["status"] == "incomplete"


def test_the_cli_exits_non_zero_when_measured_calls_failed(tmp_path, monkeypatch, capsys):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    out = tmp_path / "report.json"
    models = ScriptedModels(
        {
            WHISPER: ["warm", TranscriptionFailedError("boom")],
            FASTER: ["warm", "keep the desk by the window"],
        }
    )
    install_fake_backend(monkeypatch, models)

    code = runner.main(
        ["run", "--labels", str(labels_path), "--audio-dir", str(audio_dir), "--reps", "1", "--out", str(out)]
    )

    assert code == 1
    assert "transcription call(s) failed" in capsys.readouterr().err


# --- correction 5: privacy-constrained metadata ---------------------------


@pytest.mark.parametrize(
    "recorded_by", ["Yan Mei", "yanme", "self ", "Self", "participant_1", "me"]
)
def test_recorded_by_must_be_exactly_self(recorded_by):
    """An open string field is where a real name ends up, and it is
    copied verbatim into the artefact."""
    with pytest.raises(LabelContractError, match="recorded_by must be exactly"):
        parse_label_set(label_file(recorded_by=recorded_by))


@pytest.mark.parametrize("consent", ["yes", "granted", "self recorded", "Self_recorded", "n/a"])
def test_consent_must_be_exactly_self_recorded(consent):
    with pytest.raises(LabelContractError, match="consent must be exactly"):
        parse_label_set(label_file(consent=consent))


def test_pinned_provenance_is_rejected_before_any_audio_is_read(tmp_path):
    clips = [clip(1)]
    labels_path, audio_dir = write_dataset(tmp_path, clips, recorded_by="Yan Mei")

    with pytest.raises(LabelContractError, match="recorded_by"):
        load_label_set(labels_path)

    assert (audio_dir / "clip_001.wav").exists(), "the audio was never even opened"


def test_a_duplicate_filename_is_detected_case_insensitively():
    """Windows treats Clip_001.wav and clip_001.wav as one file, so a
    case-sensitive check would let one recording be scored twice."""
    clips = [clip(1), clip(2, filename="CLIP_001.wav")]
    with pytest.raises(LabelContractError, match="duplicate filename"):
        parse_label_set(label_file(clips))


def test_distinct_filenames_differing_by_more_than_case_are_allowed():
    parsed = parse_label_set(label_file([clip(1), clip(2)]))
    assert len(parsed.clips) == 2


def test_an_unreadable_clip_becomes_a_bounded_preflight_error(tmp_path, monkeypatch):
    labels_path, audio_dir = write_dataset(tmp_path, [clip(1)])
    labels = load_label_set(labels_path)

    def exploding_read(self):
        raise PermissionError(f"access denied: {self}")

    monkeypatch.setattr(Path, "read_bytes", exploding_read)

    with pytest.raises(PreflightError) as excinfo:
        preflight_decode(labels, audio_dir)

    message = str(excinfo.value)
    assert "clip_001" in message
    assert "PermissionError" in message
    assert str(tmp_path) not in message
    assert "access denied" not in message


def test_the_artefact_records_only_the_pinned_provenance_values(tmp_path):
    prepared, labels = one_clip(tmp_path)

    dataset = run(prepared, labels, FakeModels())["dataset"]

    assert dataset["recorded_by"] == "self"
    assert dataset["consent"] == "self_recorded"
