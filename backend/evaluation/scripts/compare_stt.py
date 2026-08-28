"""
Voice V3: whisper-base vs faster-whisper-base — bounded, evaluation-only.

Two backends, one model size, one decoded waveform per clip. Nothing
here imports a production route or changes a production default; a
passing backend is a CANDIDATE for a separately approved change, never
an automatic promotion.

WHY NOT THE HTTP PATH. POST /transcribe resolves its backend from
Settings, so one process can only ever exercise one of the two; and
transcription_service.transcribe_audio() decodes inside every call, so
the backends would receive two separate decodes. This runner therefore
calls app.core.audio_decode.decode_audio_bytes() and
app.models.whisper_stt.transcribe() directly — the layer both of those
modules' docstrings say exists for exactly this comparison. Every clip
is decoded ONCE, and the SAME DecodedAudio object is handed to both
backends and to every repetition, so a WER difference is attributable
to the model rather than to a decoder.

PREFLIGHT BEFORE ANY MODEL. The whole label file is validated, every
audio file is confirmed present, and every clip is decoded, before a
single model is loaded. A missing filename, a container that disagrees
with its declared media type, or an over-long clip aborts the run while
it is still free — never twenty minutes into inference, and never by
silently skipping the clip (which is what the previous version of this
script did).

COLD LOAD IS MEASURED ONCE, FOR BOTH BACKENDS, AFTER A SINGLE CACHE
CLEAR. app.models.whisper_stt.load_model shares one lru_cache across
backends, so clearing it a second time — between backend A's cold load
and backend B's — would EVICT backend A, and A's "warm" measured calls
would silently pay a reload. The cache is therefore cleared exactly once
before the cold-load phase, both backends are loaded cold in turn, and
it is never cleared again for the rest of the run. This is recorded in
the artefact as model_cache_cleared_once_before_cold_loads.

BOUNDED BY CALL COUNT, NOT BY TIME. There is no enforced timeout around
local inference (see transcription_service's own docstring on why a
timeout around CPU-bound work would be a lie), so this runner makes no
wall-clock claim. What it bounds and records is the number of
transcription calls it will make.

Usage (no inference and no download happen until one of these is run):
    python -m evaluation.scripts.compare_stt fetch --backend faster-whisper
    python -m evaluation.scripts.compare_stt run \
        --labels evaluation/labels/audio_labels.json \
        --audio-dir data/audio_clips --reps 3 --out evaluation/results/compare_stt.json
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

from app.core.audio_decode import (
    SUPPORTED_AUDIO_MEDIA_TYPES,
    TARGET_SAMPLE_RATE,
    AudioValidationError,
    DecodedAudio,
    decode_audio_bytes,
    normalise_media_type,
)
from app.models.whisper_stt import (
    FASTER_WHISPER_BACKEND,
    WHISPER_BACKEND,
    TranscriberUnavailableError,
    TranscriptContractError,
    TranscriptionFailedError,
)
from evaluation.metrics.stt_metrics import (
    RULE_DESCRIPTION,
    WordErrorCounts,
    corpus_wer,
    normalise_for_wer,
    word_error_counts,
)

# --- contract constants ---------------------------------------------------

SCHEMA_VERSION = 1

# Exactly the two configurations this milestone compares. Not a default
# that can be widened from the CLI: adding a model or a size would make
# the run a different experiment with different promotion arithmetic.
COMPARED_MODEL_NAMES: tuple[str, str] = ("whisper-base", "faster-whisper-base")

# ONLY faster-whisper. openai-whisper's base.pt is already cached from
# earlier work, so `fetch --backend whisper` would download nothing this
# project needs while being the one command in the repository able to
# reach the network. Narrowing it to the single genuinely-missing model
# keeps the approved download and the reachable download identical.
FETCHABLE_BACKENDS: tuple[str, ...] = (FASTER_WHISPER_BACKEND,)
MODEL_SIZE = "base"

MAX_CLIPS = 30
MIN_REPS = 1
MAX_REPS = 5
DEFAULT_REPS = 3
DEFAULT_COMPUTE_TYPE = "int8"

# Matches Settings.stt_max_audio_seconds. Stated here as this runner's
# own bound rather than imported from config: an evaluation script that
# silently tracked a production setting would change what it measured
# whenever that setting moved.
MAX_AUDIO_SECONDS = 60

REQUIRED_TOP_FIELDS = frozenset({"schema_version", "recorded_by", "consent", "clips"})

# Pinned to single values rather than validated as "some non-blank
# string". This is a self-recorded, single-speaker pilot, and both
# fields are copied verbatim into the result artefact — an open string
# field is an invitation to put a real name, a username or an email
# there and have it land in a file that gets shared. If the study ever
# stops being self-recorded, widening these is a deliberate edit with a
# consent story attached, not something a label file can do on its own.
REQUIRED_RECORDED_BY = "self"
REQUIRED_CONSENT = "self_recorded"
REQUIRED_CLIP_FIELDS = frozenset(
    {
        "clip_id",
        "filename",
        "media_type",
        "category",
        "reference_transcript",
        "wer_scored",
        "notes",
    }
)

# openai-whisper pads every input to a 30-second window; faster-whisper
# segments differently. A single real-time factor across mixed clip
# lengths would therefore compare two different things, so RTF is banded
# by duration and never reported as one number.
DURATION_BANDS: tuple[tuple[str, float, float], ...] = (
    ("short_lt_5s", 0.0, 5.0),
    ("mid_5_to_15s", 5.0, 15.0),
    ("long_gt_15s", 15.0, float("inf")),
)

# Packages whose versions matter for reproducing a measurement. Read
# through importlib.metadata, which reads installed distribution
# metadata and does NOT import the package — so recording torch's
# version here does not drag torch into this process.
REPRODUCIBILITY_PACKAGES: tuple[str, ...] = (
    "openai-whisper",
    "faster-whisper",
    "ctranslate2",
    "av",
    "numpy",
    "torch",
)

# Fixed reasons a clip's transcript cannot contribute to headline
# accuracy. Recorded verbatim so a reader can see WHY a clip is absent
# from the corpus figure rather than having to infer it.
WER_EXCLUDED_INCOMPLETE_REPS = "incomplete repetitions: at least one call failed"
WER_EXCLUDED_NON_DETERMINISTIC = "repetitions disagreed: no single transcript to score"
WER_EXCLUDED_NOT_SCORED = "clip is not wer_scored"

# Only the class name and a fixed sentence are ever recorded for a
# failure. A model or decoder exception's own text can quote a payload
# or a path; none of it reaches the artefact.
_FAILURE_MESSAGES: dict[str, str] = {
    "TranscriberUnavailableError": "backend unavailable or weights absent",
    "TranscriptionFailedError": "model ran and produced nothing servable",
    "TranscriptContractError": "result violated the transcript contract",
}


class LabelContractError(ValueError):
    """The label file violates the committed contract. Raised before any
    audio is read and long before any model is touched."""


class ClipFileMissingError(LabelContractError):
    """A labelled clip has no file. Its own type so 'you have not
    recorded this yet' is never confused with 'your schema is wrong'."""


class PreflightError(RuntimeError):
    """A clip exists but cannot be decoded. Aborts the run while it is
    still free — never mid-inference, and never by skipping the clip."""


# --- dataset contract -----------------------------------------------------


@dataclass(frozen=True)
class ClipLabel:
    clip_id: str
    filename: str
    media_type: str
    category: str
    reference_transcript: str
    wer_scored: bool
    notes: str


@dataclass(frozen=True)
class LabelSet:
    schema_version: int
    recorded_by: str
    consent: str
    clips: tuple[ClipLabel, ...]


@dataclass(frozen=True)
class PreparedClip:
    """A label plus its single decode. `decoded` is the object identity
    shared by both backends and every repetition."""

    label: ClipLabel
    decoded: DecodedAudio


def _require_str(value: Any, name: str, *, allow_blank: bool = False) -> str:
    if not isinstance(value, str):
        raise LabelContractError(f"{name} must be a string")
    if not allow_blank and not value.strip():
        raise LabelContractError(f"{name} must not be blank")
    return value


def _require_basename(value: Any, name: str) -> str:
    """A bare filename — never a path.

    A label file is committed and a reviewer reads it in a diff; a
    relative traversal or an absolute path there would both widen what
    the runner reads and leak a directory layout into the repository.
    """
    filename = _require_str(value, name)
    if filename != Path(filename).name:
        raise LabelContractError(f"{name} must be a bare filename, not a path")
    if filename in {".", ".."} or "/" in filename or "\\" in filename:
        raise LabelContractError(f"{name} must be a bare filename, not a path")
    return filename


def _parse_clip(raw: Any, index: int) -> ClipLabel:
    where = f"clips[{index}]"
    if not isinstance(raw, dict):
        raise LabelContractError(f"{where} must be an object")

    keys = set(raw)
    missing = REQUIRED_CLIP_FIELDS - keys
    if missing:
        raise LabelContractError(f"{where} is missing field(s): {sorted(missing)}")
    extra = keys - REQUIRED_CLIP_FIELDS
    if extra:
        # Rejected rather than ignored, for the same reason the API's
        # response models use extra="forbid": an unrecognised field means
        # the file and this loader disagree about the schema.
        raise LabelContractError(f"{where} has unexpected field(s): {sorted(extra)}")

    clip_id = _require_str(raw["clip_id"], f"{where}.clip_id")
    filename = _require_basename(raw["filename"], f"{where}.filename")

    media_type = _require_str(raw["media_type"], f"{where}.media_type")
    try:
        normalised_media_type = normalise_media_type(media_type)
    except AudioValidationError as exc:
        raise LabelContractError(f"{where}.media_type is not a usable media type") from exc
    if normalised_media_type not in SUPPORTED_AUDIO_MEDIA_TYPES:
        raise LabelContractError(f"{where}.media_type is not supported: {media_type!r}")

    category = _require_str(raw["category"], f"{where}.category")

    wer_scored = raw["wer_scored"]
    if not isinstance(wer_scored, bool):
        raise LabelContractError(f"{where}.wer_scored must be a boolean")

    reference_transcript = _require_str(
        raw["reference_transcript"], f"{where}.reference_transcript", allow_blank=True
    )
    if wer_scored and not normalise_for_wer(reference_transcript):
        # A scored clip with nothing to score against would divide by
        # zero, or — worse — be quietly rescued by a max(len, 1) guard
        # and reported as a rate. Silence clips set wer_scored=false.
        raise LabelContractError(
            f"{where}.reference_transcript must contain words when wer_scored is true"
        )

    notes = _require_str(raw["notes"], f"{where}.notes", allow_blank=True)

    return ClipLabel(
        clip_id=clip_id,
        filename=filename,
        media_type=normalised_media_type,
        category=category,
        reference_transcript=reference_transcript,
        wer_scored=wer_scored,
        notes=notes,
    )


def parse_label_set(raw: Any) -> LabelSet:
    """Validate the whole file at once. Every rejection below happens
    before any audio byte is read."""
    if not isinstance(raw, dict):
        raise LabelContractError("label file must contain a JSON object")

    keys = set(raw)
    missing = REQUIRED_TOP_FIELDS - keys
    if missing:
        raise LabelContractError(f"label file is missing field(s): {sorted(missing)}")
    extra = keys - REQUIRED_TOP_FIELDS
    if extra:
        raise LabelContractError(f"label file has unexpected field(s): {sorted(extra)}")

    version = raw["schema_version"]
    if isinstance(version, bool) or not isinstance(version, int):
        raise LabelContractError("schema_version must be an integer")
    if version != SCHEMA_VERSION:
        raise LabelContractError(
            f"unsupported schema_version {version}; this runner reads {SCHEMA_VERSION}"
        )

    recorded_by = _require_str(raw["recorded_by"], "recorded_by")
    if recorded_by != REQUIRED_RECORDED_BY:
        raise LabelContractError(
            f"recorded_by must be exactly {REQUIRED_RECORDED_BY!r} for this self-recorded pilot"
        )
    consent = _require_str(raw["consent"], "consent")
    if consent != REQUIRED_CONSENT:
        raise LabelContractError(
            f"consent must be exactly {REQUIRED_CONSENT!r} for this self-recorded pilot"
        )

    clips_raw = raw["clips"]
    if not isinstance(clips_raw, list):
        raise LabelContractError("clips must be an array")
    if not clips_raw:
        raise LabelContractError("clips must not be empty")
    if len(clips_raw) > MAX_CLIPS:
        raise LabelContractError(f"clips must hold at most {MAX_CLIPS} entries, got {len(clips_raw)}")

    clips = tuple(_parse_clip(entry, i) for i, entry in enumerate(clips_raw))

    seen_ids: set[str] = set()
    seen_files: set[str] = set()
    for clip in clips:
        if clip.clip_id in seen_ids:
            raise LabelContractError(f"duplicate clip_id: {clip.clip_id!r}")
        seen_ids.add(clip.clip_id)
        # Identity is clip_id, but two labels pointing at one recording
        # would double-count that recording in the corpus totals.
        # Compared case-insensitively: this project runs on Windows,
        # where "Clip_001.wav" and "clip_001.wav" are the same file, so a
        # case-sensitive check would let one recording be scored twice.
        folded_filename = clip.filename.casefold()
        if folded_filename in seen_files:
            raise LabelContractError(f"duplicate filename: {clip.filename!r}")
        seen_files.add(folded_filename)

    return LabelSet(
        schema_version=version, recorded_by=recorded_by, consent=consent, clips=clips
    )


def load_label_set(path: Path) -> LabelSet:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise LabelContractError("label file does not exist") from exc
    except json.JSONDecodeError as exc:
        raise LabelContractError("label file is not valid JSON") from exc
    return parse_label_set(raw)


# --- preflight ------------------------------------------------------------


def preflight_decode(
    labels: LabelSet,
    audio_dir: Path,
    *,
    max_seconds: int = MAX_AUDIO_SECONDS,
    decode_fn: Callable[..., DecodedAudio] = decode_audio_bytes,
) -> tuple[PreparedClip, ...]:
    """Confirm every file exists, then decode every clip exactly once.

    Existence is checked for ALL clips before any decoding starts, so a
    half-recorded dataset is reported as a list of what is missing
    rather than one file at a time across several aborted runs.
    """
    missing = [clip.filename for clip in labels.clips if not (audio_dir / clip.filename).is_file()]
    if missing:
        raise ClipFileMissingError(f"audio file(s) not found in the audio directory: {sorted(missing)}")

    prepared: list[PreparedClip] = []
    for clip in labels.clips:
        try:
            audio_bytes = (audio_dir / clip.filename).read_bytes()
        except OSError as exc:
            # An OSError's str() carries the full path it failed on. Only
            # the clip_id is propagated, so a permission or device error
            # cannot write a home directory into a traceback a reader
            # later pastes somewhere.
            raise PreflightError(
                f"clip {clip.clip_id} could not be read ({type(exc).__name__})"
            ) from exc
        try:
            decoded = decode_fn(audio_bytes, clip.media_type, max_seconds=max_seconds)
        except AudioValidationError as exc:
            # The decoder's messages are already fixed bounded strings,
            # but only the class name is propagated so this stays true
            # even if a future decoder message is not.
            raise PreflightError(
                f"clip {clip.clip_id} could not be decoded ({type(exc).__name__})"
            ) from exc
        prepared.append(PreparedClip(label=clip, decoded=decoded))
    return tuple(prepared)


# --- execution protocol ---------------------------------------------------


def backend_order(clip_index: int, rep_index: int) -> tuple[str, str]:
    """Which model runs first for this (clip, repetition).

    Counterbalanced by the parity of clip_index + rep_index. Running one
    backend first every time would hand it a consistently colder or
    warmer machine than the other, and the whole latency comparison
    would carry that bias. Alternating leaves each backend first for
    half the pairs whenever clip_count x reps is even.
    """
    if (clip_index + rep_index) % 2 == 0:
        return COMPARED_MODEL_NAMES
    return (COMPARED_MODEL_NAMES[1], COMPARED_MODEL_NAMES[0])


def call_bounds(clip_count: int, reps: int) -> dict:
    """Call-count bounds, recorded before anything runs.

    Deliberately NOT a wall-clock bound: local inference has no enforced
    timeout (a timeout around CPU-bound work cannot stop it), so a time
    limit here would be a claim this runner cannot keep.
    """
    measured = clip_count * len(COMPARED_MODEL_NAMES) * reps
    warmup = len(COMPARED_MODEL_NAMES)
    return {
        "clip_count": clip_count,
        "backend_count": len(COMPARED_MODEL_NAMES),
        "reps": reps,
        "measured_inference_calls": measured,
        "warmup_calls": warmup,
        "max_total_transcription_calls": measured + warmup,
        "_note": (
            "Call-count bounded only. No wall-clock bound is claimed: local inference has no "
            "enforced timeout."
        ),
    }


def _band_for(duration_s: float) -> str:
    for name, low, high in DURATION_BANDS:
        if low <= duration_s < high:
            return name
    return DURATION_BANDS[-1][0]


def _package_versions() -> dict:
    """Installed versions WITHOUT importing the packages —
    importlib.metadata reads distribution metadata from disk."""
    from importlib import metadata

    versions: dict[str, str | None] = {}
    for name in REPRODUCIBILITY_PACKAGES:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name] = None
    return versions


def _sanitised_platform() -> dict:
    """Enough to reproduce a measurement, and nothing that identifies a
    machine or a person: no hostname (platform.node()), no username, no
    home directory, no environment value."""
    return {
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
    }


def manual_review_block() -> dict:
    """Unscored fields for a human reviewer. Never computed, never
    defaulted to a value — an invented usefulness judgement would be
    worse than none."""
    return {
        "_instructions": (
            "Scored manually by a human reviewer. This harness never computes these. "
            "PASSING THE AUTOMATIC MEASUREMENTS IS NOT ACCEPTANCE."
        ),
        "transcripts_usable_as_context": None,
        "errors_are_tolerable_for_review": None,
        "no_disqualifying_hallucination": None,
        "latency_acceptable_interactively": None,
        "recommended_action": None,
    }


def _failure_record(model_name: str, clip_id: str, rep: int, exc: BaseException) -> dict:
    name = type(exc).__name__
    return {
        "clip_id": clip_id,
        "model_name": model_name,
        "rep": rep,
        "error_type": name,
        "detail": _FAILURE_MESSAGES.get(name, "transcription call failed"),
    }


def _stats(values: Sequence[float]) -> dict:
    if not values:
        return {"median_ms": None, "min_ms": None, "max_ms": None, "count": 0}
    return {
        "median_ms": round(statistics.median(values), 3),
        "min_ms": round(min(values), 3),
        "max_ms": round(max(values), 3),
        "count": len(values),
    }


def run_comparison(
    prepared: Sequence[PreparedClip],
    *,
    reps: int = DEFAULT_REPS,
    compute_type: str = DEFAULT_COMPUTE_TYPE,
    transcribe_fn: Callable[..., Any],
    load_model_fn: Callable[..., Any],
    cache_clear_fn: Callable[[], None],
    labels: LabelSet,
    save: Callable[[dict], None] | None = None,
) -> dict:
    """Cold-load both backends, warm each once, then run the measured
    matrix with counterbalanced backend order.

    Every model interaction arrives through the three injected callables,
    so a test can drive the whole protocol without a model library.
    """
    if not prepared:
        raise ValueError("no prepared clips to run")
    if not isinstance(reps, int) or isinstance(reps, bool) or not (MIN_REPS <= reps <= MAX_REPS):
        raise ValueError(f"reps must be an integer in [{MIN_REPS}, {MAX_REPS}]")

    bounds = call_bounds(len(prepared), reps)
    report: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "harness_version": "v3",
        "status": "incomplete",
        "incomplete_reason": "run has not finished",
        "compared_model_names": list(COMPARED_MODEL_NAMES),
        "reproducibility": {
            "model_names": list(COMPARED_MODEL_NAMES),
            "model_size": MODEL_SIZE,
            "compute_type": compute_type,
            "local_files_only": True,
            "sample_rate": TARGET_SAMPLE_RATE,
            "reps": reps,
            "max_audio_seconds": MAX_AUDIO_SECONDS,
            "wer_rule": RULE_DESCRIPTION,
            "packages": _package_versions(),
            "platform": _sanitised_platform(),
            "_note": (
                "local_files_only is True for every measured call: a missing model fails the run "
                "rather than starting a download mid-measurement."
            ),
        },
        "dataset": {
            "schema_version": labels.schema_version,
            "recorded_by": labels.recorded_by,
            "consent": labels.consent,
            "clip_count": len(prepared),
            "scored_clip_count": sum(1 for p in prepared if p.label.wer_scored),
            "silence_clip_count": sum(1 for p in prepared if not p.label.wer_scored),
            "total_audio_s": round(sum(p.decoded.duration_s for p in prepared), 3),
        },
        "bounds": bounds,
        "cold_load": {},
        "model_cache_cleared_once_before_cold_loads": True,
        "clips": [],
        "errors": [],
        "summary": {},
        "manual_review": manual_review_block(),
    }

    def _save() -> None:
        if save is not None:
            save(report)

    _save()

    def _abort(stage: str, model_name: str, exc: BaseException) -> dict:
        """Record a typed startup failure and stop, leaving a parseable
        artefact that says what stopped it.

        Only the exception CLASS reaches the artefact — a model
        library's own text can name a checkpoint path. Untyped
        exceptions are deliberately not routed here: a programming
        defect must surface as itself, not be dressed up as a model
        failure the user is invited to retry.
        """
        report["errors"].append(_failure_record(model_name, f"<{stage}>", -1, exc))
        report["status"] = "incomplete"
        report["incomplete_reason"] = f"{stage} failed for {model_name}"
        _refresh_summary(report, order_first_counts, reps)
        _save()
        return report

    order_first_counts = {name: 0 for name in COMPARED_MODEL_NAMES}

    # --- cold load: one clear for BOTH backends -------------------------
    # Clearing again between them would evict the first backend and make
    # its measured calls silently pay a reload. See the module docstring.
    cache_clear_fn()
    for model_name in COMPARED_MODEL_NAMES:
        backend = _backend_of(model_name)
        started = time.perf_counter()
        try:
            load_model_fn(backend, MODEL_SIZE, compute_type, True)
        except _TYPED_MODEL_ERRORS as exc:
            return _abort("cold_load", model_name, exc)
        report["cold_load"][model_name] = {
            "cold_load_ms": round((time.perf_counter() - started) * 1000, 3),
            "measured_after_single_cache_clear": True,
        }
        # Saved per backend, not once after both: a second-backend
        # failure must still leave the first backend's measurement on
        # disk as evidence of how far the run got.
        _save()

    # --- warm-up: one discarded call per backend ------------------------
    warm_clip = prepared[0]
    warmup: dict[str, Any] = {}
    report["warmup"] = {
        "calls": warmup,
        "_note": "Discarded. Excluded from every latency statistic and every transcript.",
    }
    for model_name in COMPARED_MODEL_NAMES:
        started = time.perf_counter()
        try:
            transcribe_fn(
                warm_clip.decoded,
                model_name=model_name,
                compute_type=compute_type,
                local_files_only=True,
            )
        except _TYPED_MODEL_ERRORS as exc:
            return _abort("warmup", model_name, exc)
        warmup[model_name] = {
            "clip_id": warm_clip.label.clip_id,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
            "discarded": True,
        }
        _save()

    # --- measured matrix ------------------------------------------------
    for clip_index, item in enumerate(prepared):
        label = item.label
        per_backend: dict[str, dict[str, Any]] = {
            name: {"latencies_ms": [], "transcripts": []} for name in COMPARED_MODEL_NAMES
        }

        for rep_index in range(reps):
            order = backend_order(clip_index, rep_index)
            order_first_counts[order[0]] += 1
            for model_name in order:
                try:
                    result = transcribe_fn(
                        item.decoded,
                        model_name=model_name,
                        compute_type=compute_type,
                        local_files_only=True,
                    )
                except _TYPED_MODEL_ERRORS as exc:
                    report["errors"].append(
                        _failure_record(model_name, label.clip_id, rep_index, exc)
                    )
                    continue
                per_backend[model_name]["latencies_ms"].append(float(result.transcription_ms))
                per_backend[model_name]["transcripts"].append(result.text)

        report["clips"].append(
            _clip_row(item, per_backend, clip_index=clip_index, reps=reps)
        )
        _refresh_summary(report, order_first_counts, reps)
        _save()

    error_count = len(report["errors"])
    if error_count == 0:
        report["status"] = "complete"
        report["incomplete_reason"] = None
    else:
        # "complete" means the whole run succeeded. A run that recorded
        # transcription failures is finished but not clean, and saying
        # otherwise would let a partial result be read as a full one.
        report["status"] = "incomplete"
        report["incomplete_reason"] = f"{error_count} transcription call(s) failed"
    _refresh_summary(report, order_first_counts, reps)
    _save()
    return report


# The typed model failures this runner is willing to record and
# continue past. Anything else is a programming defect and propagates.
_TYPED_MODEL_ERRORS = (
    TranscriberUnavailableError,
    TranscriptionFailedError,
    TranscriptContractError,
)


def _backend_of(model_name: str) -> str:
    return WHISPER_BACKEND if model_name == "whisper-base" else FASTER_WHISPER_BACKEND


def _clip_row(
    item: PreparedClip,
    per_backend: dict[str, dict[str, Any]],
    *,
    clip_index: int,
    reps: int,
) -> dict:
    label = item.label
    duration_s = item.decoded.duration_s
    row: dict[str, Any] = {
        "clip_id": label.clip_id,
        # Basename only — never the path it was read from.
        "filename": label.filename,
        "category": label.category,
        "media_type": label.media_type,
        "wer_scored": label.wer_scored,
        "audio_duration_s": duration_s,
        "duration_band": _band_for(duration_s),
        "reference_transcript": label.reference_transcript,
        "backends": {},
        "backend_order_per_rep": [list(backend_order(clip_index, r)) for r in range(reps)],
    }

    for model_name in COMPARED_MODEL_NAMES:
        transcripts = per_backend[model_name]["transcripts"]
        latencies = per_backend[model_name]["latencies_ms"]
        distinct = sorted(set(transcripts))
        complete = len(transcripts) == reps

        # Determinism needs COMPLETE evidence. One surviving result out
        # of three is one distinct transcript, and calling that
        # "deterministic" would report the strongest possible claim from
        # the weakest possible evidence — two of the three observations
        # that would have tested it never happened. Missing calls are
        # null, not true.
        if not complete:
            deterministic: bool | None = None
        else:
            deterministic = len(distinct) <= 1

        entry: dict[str, Any] = {
            "transcripts": list(transcripts),
            "successful_calls": len(transcripts),
            "expected_calls": reps,
            "complete_repetitions": complete,
            "latency": _stats(latencies),
            # Both backends are greedy at temperature 0, so repetitions
            # test determinism rather than sample noise. A divergence is
            # recorded, never averaged away.
            "deterministic_across_reps": deterministic,
            "distinct_transcripts": distinct,
        }
        median_ms = entry["latency"]["median_ms"]
        entry["real_time_factor"] = (
            round((median_ms / 1000.0) / duration_s, 6)
            if median_ms is not None and duration_s > 0
            else None
        )

        if label.wer_scored:
            # Only a complete, agreeing set of repetitions yields one
            # transcript that legitimately represents this backend on
            # this clip. Scoring transcripts[0] when the repetitions
            # disagreed would pick a winner by call order — and since
            # order is counterbalanced, that choice would be arbitrary in
            # a way that still moved the headline number. Every
            # transcript stays in the artefact either way.
            if not complete:
                entry["wer"] = None
                entry["wer_excluded_reason"] = WER_EXCLUDED_INCOMPLETE_REPS
            elif deterministic is not True:
                entry["wer"] = None
                entry["wer_excluded_reason"] = WER_EXCLUDED_NON_DETERMINISTIC
            else:
                counts = word_error_counts(label.reference_transcript, transcripts[0])
                entry["wer"] = counts.as_dict()
                entry["wer_excluded_reason"] = None
        else:
            entry["wer_excluded_reason"] = WER_EXCLUDED_NOT_SCORED
            # A silence clip has nothing to score against. What matters
            # is whether the backend invented words — a real Whisper
            # failure mode, and one that matters here because this text
            # is shown to the user as context.
            entry["wer"] = None
            entry["hallucinated"] = (
                any(bool(normalise_for_wer(t)) for t in transcripts) if transcripts else None
            )
        row["backends"][model_name] = entry

    return row


def _scored_counts(report: dict, model_name: str) -> list[WordErrorCounts]:
    counts: list[WordErrorCounts] = []
    for row in report["clips"]:
        if not row["wer_scored"]:
            continue
        wer = row["backends"][model_name]["wer"]
        if wer is None:
            continue
        counts.append(
            WordErrorCounts(
                substitutions=wer["substitutions"],
                deletions=wer["deletions"],
                insertions=wer["insertions"],
                hits=wer["hits"],
                reference_words=wer["reference_words"],
            )
        )
    return counts


def _refresh_summary(report: dict, order_first_counts: dict[str, int], reps: int) -> None:
    summary: dict[str, Any] = {
        "clips_completed": len(report["clips"]),
        "reps": reps,
        "error_count": len(report["errors"]),
        "backend_first_counts": dict(order_first_counts),
        "backends": {},
        "_note": (
            "Automatic measurement is not acceptance. This is a small single-speaker pilot; a "
            "backend that measures well is a CANDIDATE for a separately approved production "
            "change, and this harness never modifies a production default. "
            "mean_per_clip_wer is length-biased and is never the result."
        ),
    }

    for model_name in COMPARED_MODEL_NAMES:
        counts = _scored_counts(report, model_name)
        bands: dict[str, dict[str, Any]] = {}
        for band_name, _low, _high in DURATION_BANDS:
            band_rows = [r for r in report["clips"] if r["duration_band"] == band_name]
            latencies = [
                r["backends"][model_name]["latency"]["median_ms"]
                for r in band_rows
                if r["backends"][model_name]["latency"]["median_ms"] is not None
            ]
            rtfs = [
                r["backends"][model_name]["real_time_factor"]
                for r in band_rows
                if r["backends"][model_name]["real_time_factor"] is not None
            ]
            bands[band_name] = {
                "clip_count": len(band_rows),
                "median_latency_ms": round(statistics.median(latencies), 3) if latencies else None,
                "median_real_time_factor": round(statistics.median(rtfs), 6) if rtfs else None,
            }

        silence_rows = [r for r in report["clips"] if not r["wer_scored"]]
        non_deterministic = [
            r["clip_id"]
            for r in report["clips"]
            if r["backends"][model_name]["deterministic_across_reps"] is False
        ]
        # A clip whose repetitions were never completed proves nothing
        # about determinism either way, so it is listed separately and
        # still blocks the "all deterministic" claim below.
        incomplete_evidence = [
            r["clip_id"]
            for r in report["clips"]
            if r["backends"][model_name]["deterministic_across_reps"] is None
        ]

        scored_rows = [r for r in report["clips"] if r["wer_scored"]]
        excluded = [
            {
                "clip_id": r["clip_id"],
                "reason": r["backends"][model_name]["wer_excluded_reason"],
            }
            for r in scored_rows
            if r["backends"][model_name]["wer"] is None
        ]
        accuracy = corpus_wer(counts)
        # A corpus WER computed over only the clips that happened to
        # succeed is a measurement of the easy subset presented as a
        # measurement of the corpus. When any scored clip is missing, the
        # headline rates are withheld and the partial aggregate is kept
        # beside them, explicitly labelled.
        if excluded:
            accuracy = {
                **accuracy,
                "complete": False,
                "corpus_wer": None,
                "mean_per_clip_wer": None,
                "partial_corpus_wer_over_scored_clips_only": accuracy["corpus_wer"],
                "excluded_clips": excluded,
                "scored_clip_count_expected": len(scored_rows),
                "_note": (
                    "INCOMPLETE. Headline rates are withheld because at least one scored clip "
                    "produced no usable transcript; the partial figure covers only the clips that "
                    "did, and is not comparable across backends."
                ),
            }
        else:
            accuracy = {**accuracy, "complete": True, "excluded_clips": []}

        summary["backends"][model_name] = {
            "accuracy": accuracy,
            "duration_bands": bands,
            "non_deterministic_clip_ids": non_deterministic,
            "incomplete_evidence_clip_ids": incomplete_evidence,
            # True only on complete, agreeing evidence for every clip: a
            # failed call means the question was not answered, not that
            # the answer was yes.
            "all_transcripts_deterministic": (
                bool(report["clips"]) and not non_deterministic and not incomplete_evidence
            ),
            "silence": {
                "clip_count": len(silence_rows),
                "hallucinated_clip_ids": [
                    r["clip_id"]
                    for r in silence_rows
                    if r["backends"][model_name].get("hallucinated") is True
                ],
                "_note": "Excluded from WER. Any invented text on a silence clip is disqualifying.",
            },
            "failed_calls": sum(
                1 for e in report["errors"] if e["model_name"] == model_name
            ),
        }

    report["summary"] = summary


def _writer(out_path: Path) -> Callable[[dict], None]:
    """Incremental save after every step, so an interrupted run still
    leaves a parseable artefact that honestly says it is incomplete.

    ATOMIC, because the previous version was not. Writing straight to
    the destination truncates it first, so an interruption during the
    write leaves a half-written file — which contradicts the very claim
    this harness makes about interrupted runs staying readable, and does
    so precisely when the artefact matters most. The report is therefore
    serialised in full FIRST (a serialisation failure never touches the
    destination at all), written to a sibling temporary file, flushed to
    the OS, and only then moved into place with os.replace, which is
    atomic within a directory on both POSIX and Windows. The temporary
    file is a sibling rather than a system temp file so the replace is
    always same-filesystem; a leftover temporary is removed on failure.
    """

    def _save(report: dict) -> None:
        # Serialise before touching the filesystem: an unserialisable
        # report must leave the last good artefact exactly as it was.
        payload = json.dumps(report, indent=2)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = out_path.with_name(out_path.name + ".tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, out_path)
        except BaseException:
            # Including KeyboardInterrupt: a Ctrl-C mid-write must not
            # leave a stray .tmp beside a valid artefact.
            try:
                tmp_path.unlink()
            except OSError:
                pass
            raise

    return _save


# --- CLI ------------------------------------------------------------------


def _default_transcribe_fn() -> Callable[..., Any]:
    from app.models.whisper_stt import transcribe

    return transcribe


def _default_load_model_fn() -> Callable[..., Any]:
    from app.models.whisper_stt import load_model

    return load_model


def _default_cache_clear_fn() -> Callable[[], None]:
    from app.models.whisper_stt import load_model

    return load_model.cache_clear  # type: ignore[attr-defined]


def fetch_weights(
    backend: str,
    *,
    compute_type: str = DEFAULT_COMPUTE_TYPE,
    load_model_fn: Callable[..., Any] | None = None,
) -> None:
    """The ONLY place local_files_only=False is ever used, and only for
    faster-whisper.

    Downloading weights is a separate, explicitly approved step, kept
    apart from `run` on purpose: a measured run that could fetch a model
    mid-flight would attribute a download to inference latency, and
    could start a multi-hundred-megabyte transfer without anyone having
    agreed to it. `run` always passes True.

    Scope is exactly one model — Systran/faster-whisper-base, the only
    weight this comparison is missing. openai-whisper is not fetchable
    here at all.
    """
    if backend not in FETCHABLE_BACKENDS:
        # Checked before the loader is resolved, let alone called: the
        # rejection must not be able to reach a code path that could
        # download something.
        raise ValueError(f"backend must be one of {list(FETCHABLE_BACKENDS)}")
    loader = load_model_fn if load_model_fn is not None else _default_load_model_fn()
    loader(backend, MODEL_SIZE, compute_type, False)
    print(f"{backend}-{MODEL_SIZE} weights are present.")


def _run_command(args: argparse.Namespace) -> int:
    labels = load_label_set(args.labels)
    prepared = preflight_decode(labels, args.audio_dir)
    print(
        f"Preflight OK: {len(prepared)} clip(s) decoded, "
        f"{round(sum(p.decoded.duration_s for p in prepared), 1)}s of audio. "
        f"Bounds: {call_bounds(len(prepared), args.reps)['max_total_transcription_calls']} "
        "transcription call(s) at most."
    )
    report = run_comparison(
        prepared,
        reps=args.reps,
        compute_type=args.compute_type,
        transcribe_fn=_default_transcribe_fn(),
        load_model_fn=_default_load_model_fn(),
        cache_clear_fn=_default_cache_clear_fn(),
        labels=labels,
        save=_writer(args.out),
    )

    # An incomplete run is reported as one, on stderr, with a non-zero
    # exit. Printing "Wrote report" either way would let a run that
    # failed to load a model scroll past looking like a success, and
    # would make the harness unusable from any script that checks status.
    if report["status"] != "complete":
        print(
            f"incomplete run written to {args.out}: {report['incomplete_reason']}",
            file=sys.stderr,
        )
        return 1
    print(f"Wrote report to {args.out}")
    return 0


def _reps_arg(value: str) -> int:
    parsed = int(value)
    if not (MIN_REPS <= parsed <= MAX_REPS):
        raise argparse.ArgumentTypeError(f"--reps must be in [{MIN_REPS}, {MAX_REPS}]")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run", help="Measured comparison (never downloads)")
    run_parser.add_argument(
        "--labels", type=Path, default=Path("evaluation/labels/audio_labels.json")
    )
    run_parser.add_argument("--audio-dir", type=Path, default=Path("data/audio_clips"))
    run_parser.add_argument("--reps", type=_reps_arg, default=DEFAULT_REPS)
    run_parser.add_argument("--compute-type", type=str, default=DEFAULT_COMPUTE_TYPE)
    run_parser.add_argument("--out", type=Path, required=True, help="Result JSON")

    fetch_parser = sub.add_parser(
        "fetch", help="Download weights for one backend (explicitly approved step)"
    )
    fetch_parser.add_argument("--backend", choices=FETCHABLE_BACKENDS, required=True)
    fetch_parser.add_argument("--compute-type", type=str, default=DEFAULT_COMPUTE_TYPE)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "fetch":
            fetch_weights(args.backend, compute_type=args.compute_type)
            return 0
        return _run_command(args)
    except (LabelContractError, PreflightError) as exc:
        # Bounded, actionable, and nothing from a decoder or a model.
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
