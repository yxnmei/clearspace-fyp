"""
Unit tests for app/config.py's validated settings.

Scope is deliberately narrow: the two Reorganise planner bounds added
when production stopped calling the planner. They are the only settings
in this file carrying custom validators, because they are the only ones
whose being wrong reintroduces the exact failure they exist to prevent —
an unbounded request.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings

_BACKEND_DIR = Path(__file__).resolve().parents[2]


def test_defaults_are_the_screened_bounds():
    settings = Settings()
    assert settings.reorganise_llm_timeout_s == 210.0
    assert settings.reorganise_llm_num_predict == 1536


# --- reorganise_llm_timeout_s -------------------------------------------


@pytest.mark.parametrize("good", [1, 0.5, 30.0, 210.0, 600])
def test_timeout_accepts_finite_positive_numbers(good):
    assert Settings(reorganise_llm_timeout_s=good).reorganise_llm_timeout_s == good


@pytest.mark.parametrize("bad", [0, 0.0, -1, -0.001])
def test_timeout_rejects_zero_or_negative(bad):
    """Zero or negative is not 'no timeout', it is a broken one."""
    with pytest.raises(ValidationError, match="greater than zero"):
        Settings(reorganise_llm_timeout_s=bad)


@pytest.mark.parametrize("bad", [float("inf"), float("-inf"), float("nan")])
def test_timeout_rejects_non_finite(bad):
    """An infinite timeout is exactly the unbounded behaviour this
    setting exists to prevent, so it cannot be spelled."""
    with pytest.raises(ValidationError, match="finite"):
        Settings(reorganise_llm_timeout_s=bad)


@pytest.mark.parametrize("bad", [True, False, None, "fast", "", "   ", [], {}])
def test_timeout_rejects_non_numbers_including_bool(bad):
    """bool is an int subclass — True would otherwise become a 1-second
    timeout. Blank and malformed strings are rejected too; a genuinely
    numeric string is accepted (see the env-var tests below)."""
    with pytest.raises(ValidationError):
        Settings(reorganise_llm_timeout_s=bad)


# --- reorganise_llm_num_predict -----------------------------------------


@pytest.mark.parametrize("good", [1, 512, 1536, 4096])
def test_num_predict_accepts_positive_integers(good):
    assert Settings(reorganise_llm_num_predict=good).reorganise_llm_num_predict == good


@pytest.mark.parametrize("bad", [0, -1, -1536])
def test_num_predict_rejects_zero_or_negative(bad):
    with pytest.raises(ValidationError, match="greater than zero"):
        Settings(reorganise_llm_num_predict=bad)


@pytest.mark.parametrize("bad", [True, False])
def test_num_predict_rejects_booleans(bad):
    """The important one: bool is an int subclass, so True would arrive
    as num_predict=1 and truncate every response to a single token —
    a silent, very confusing failure."""
    with pytest.raises(ValidationError, match="must be an integer"):
        Settings(reorganise_llm_num_predict=bad)


@pytest.mark.parametrize("bad", [1536.0, 1536.5, None, [], {}])
def test_num_predict_rejects_non_integers(bad):
    """A float is rejected even when whole-valued — 1536.0 in code is a
    type mistake, not a token budget."""
    with pytest.raises(ValidationError, match="must be an integer"):
        Settings(reorganise_llm_num_predict=bad)


@pytest.mark.parametrize("bad", ["1536.0", "1e3", "abc", "", "   ", "nan", "inf"])
def test_num_predict_rejects_non_whole_number_strings(bad):
    """"1536.0" must NOT be accepted as 1536 — a fractional token budget
    is a configuration mistake, not something to silently truncate."""
    with pytest.raises(ValidationError):
        Settings(reorganise_llm_num_predict=bad)


# --- scoping: Declutter is untouched -------------------------------------


def test_the_new_bounds_do_not_exist_as_declutter_settings():
    """These are Reorganise-scoped on purpose. app/models/mistral_llm.py
    also builds an ollama.Client with no timeout, but Declutter's LLM
    behaviour is evidence-backed and unchanged by this work — a shared
    setting would have silently altered it too."""
    settings = Settings()
    names = set(type(settings).model_fields)
    assert "reorganise_llm_timeout_s" in names
    assert "reorganise_llm_num_predict" in names
    # no Declutter-facing equivalents were introduced
    assert "llm_timeout_s" not in names
    assert "llm_num_predict" not in names


def test_declutter_llm_settings_keep_their_existing_values():
    settings = Settings()
    assert settings.llm_model_name == "phi4-mini"
    assert settings.llm_temperature == 0.2
    assert settings.llm_max_retries == 2
    assert settings.llm_max_items_per_call == 10


# --- environment-variable loading ----------------------------------------
#
# The path that actually matters in production: pydantic-settings hands
# every environment variable over as a STRING. An earlier version of
# these validators rejected str outright, which made the documented
# .env.example values a hard startup failure. `_env_file=None` keeps a
# developer's real local .env out of these tests.


@pytest.fixture
def env(monkeypatch):
    """Sets the two Reorganise env vars and returns a loader."""

    def _load(timeout: str | None = None, num_predict: str | None = None) -> Settings:
        monkeypatch.delenv("REORGANISE_LLM_TIMEOUT_S", raising=False)
        monkeypatch.delenv("REORGANISE_LLM_NUM_PREDICT", raising=False)
        if timeout is not None:
            monkeypatch.setenv("REORGANISE_LLM_TIMEOUT_S", timeout)
        if num_predict is not None:
            monkeypatch.setenv("REORGANISE_LLM_NUM_PREDICT", num_predict)
        return Settings(_env_file=None)

    return _load


def test_documented_env_example_values_load(env):
    """Exactly the values in backend/.env.example. If this fails, the
    documented configuration cannot start the app."""
    settings = env(timeout="210.0", num_predict="1536")
    assert settings.reorganise_llm_timeout_s == 210.0
    assert settings.reorganise_llm_num_predict == 1536


def test_env_absent_falls_back_to_defaults(env):
    settings = env()
    assert settings.reorganise_llm_timeout_s == 210.0
    assert settings.reorganise_llm_num_predict == 1536


@pytest.mark.parametrize("raw,expected", [("30", 30.0), ("30.5", 30.5), (" 45.0 ", 45.0), ("1e2", 100.0)])
def test_timeout_env_string_is_parsed(env, raw, expected):
    assert env(timeout=raw).reorganise_llm_timeout_s == expected


@pytest.mark.parametrize("raw", ["0", "0.0", "-1", "-0.5", "nan", "inf", "-inf", "abc", "", "   ", "true"])
def test_timeout_env_string_keeps_every_rejection(env, raw):
    """Parsing a string must not weaken any rule — "inf" and "nan" parse
    as floats, so the finiteness check is what stops them."""
    with pytest.raises(ValidationError):
        env(timeout=raw)


@pytest.mark.parametrize("raw,expected", [("1536", 1536), ("512", 512), (" 2048 ", 2048), ("+64", 64)])
def test_num_predict_env_string_is_parsed(env, raw, expected):
    assert env(num_predict=raw).reorganise_llm_num_predict == expected


@pytest.mark.parametrize("raw", ["1536.0", "1e3", "0", "-1", "nan", "inf", "abc", "", "   ", "true"])
def test_num_predict_env_string_keeps_every_rejection(env, raw):
    """"1536.0" is the important case: a whole-valued float STRING must
    not slip through as an integer."""
    with pytest.raises(ValidationError):
        env(num_predict=raw)


def test_env_booleans_are_rejected_as_strings_too(env):
    """`True` cannot reach Settings from the environment as a bool, but
    "true"/"True" must not be coerced into 1 either."""
    for raw in ("true", "True", "yes", "on"):
        with pytest.raises(ValidationError):
            env(num_predict=raw)
        with pytest.raises(ValidationError):
            env(timeout=raw)


# --- speech-to-text settings ---------------------------------------------
#
# These carry validators for the same reason the Reorganise bounds do:
# each one being wrong reintroduces a failure it exists to prevent. A
# non-positive byte or second limit rejects every upload; a blank
# compute type silently means "library default" rather than the
# configured one; and stt_local_files_only being anything but a real
# bool would let a user request start a model download.
#
# There is deliberately no transcription timeout to test — a timeout
# around a worker thread cannot stop CPU-bound inference, so one would
# promise a cancellation that never happens.


@pytest.fixture
def stt_env(monkeypatch):
    """Loads Settings with one STT env var set, ignoring any local .env."""

    def _load(**overrides: str) -> Settings:
        for name in (
            "STT_BACKEND",
            "STT_MAX_UPLOAD_BYTES",
            "STT_MAX_AUDIO_SECONDS",
            "STT_COMPUTE_TYPE",
            "STT_LOCAL_FILES_ONLY",
        ):
            monkeypatch.delenv(name, raising=False)
        for key, value in overrides.items():
            monkeypatch.setenv(key.upper(), value)
        return Settings(_env_file=None)

    return _load


def test_stt_defaults():
    settings = Settings(_env_file=None)
    assert settings.stt_backend == "faster-whisper"  # production backend
    assert settings.stt_max_upload_bytes == 10485760  # 10MB
    assert settings.stt_max_audio_seconds == 60
    assert settings.stt_compute_type == "int8"
    assert settings.stt_local_files_only is True


def test_documented_env_example_stt_values_load(stt_env):
    settings = stt_env(
        stt_backend="faster-whisper",
        stt_max_upload_bytes="10485760",
        stt_max_audio_seconds="60",
        stt_compute_type="int8",
        stt_local_files_only="true",
    )
    assert settings.stt_backend == "faster-whisper"
    assert settings.stt_max_upload_bytes == 10485760
    assert settings.stt_max_audio_seconds == 60
    assert settings.stt_compute_type == "int8"
    assert settings.stt_local_files_only is True


def test_no_transcription_timeout_setting_exists():
    """Guard against one being added: a thread timeout cannot terminate
    inference and must not be presented as hard cancellation."""
    names = set(Settings.model_fields)
    assert not [n for n in names if n.startswith("stt_") and "timeout" in n]


# --- stt_backend ----------------------------------------------------------


@pytest.mark.parametrize("good", ["whisper", "faster-whisper"])
def test_backend_accepts_both_supported_values(good):
    assert Settings(_env_file=None, stt_backend=good).stt_backend == good


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "   ",
        "Whisper",
        "vosk",
        "whisper ",
        "Faster-Whisper",
        "faster whisper",
        "faster-whisper-base",
        " faster-whisper",
        None,
        True,
        1,
        [],
    ],
)
def test_backend_rejects_anything_else(bad):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, stt_backend=bad)


# --- the production default, and the override that must survive it -------


def test_the_production_default_backend_is_faster_whisper(stt_env):
    """Chosen for load time on equal measured accuracy, never as an
    accuracy claim — see backend/evaluation/README.md."""
    assert stt_env().stt_backend == "faster-whisper"


def test_explicit_whisper_is_still_fully_supported(stt_env):
    """Promoting one backend must not strand the other."""
    assert stt_env(stt_backend="whisper").stt_backend == "whisper"


def test_switching_back_needs_only_the_one_env_var(stt_env):
    """Size, quantisation, bounds and the download lock are untouched by
    which backend is selected."""
    settings = stt_env(stt_backend="whisper")

    assert settings.whisper_model_size == "base"
    assert settings.stt_compute_type == "int8"
    assert settings.stt_local_files_only is True
    assert settings.stt_max_upload_bytes == 10485760
    assert settings.stt_max_audio_seconds == 60


def test_the_model_size_stays_pinned(stt_env):
    """The loaders take the size as a path or repo id, so a widened
    value would let configuration name an arbitrary checkpoint."""
    assert stt_env().whisper_model_size == "base"
    with pytest.raises(ValidationError):
        Settings(_env_file=None, whisper_model_size="small")


def test_the_download_lock_holds_for_either_backend(stt_env):
    """A production request must never be able to start a download."""
    assert stt_env().stt_local_files_only is True
    for value in (False, "false", "0", "no", 1, 0, None):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, stt_local_files_only=value)


def test_the_committed_env_example_matches_the_shipped_default():
    """.env.example is what a new install copies, so it must not
    document a different backend than the code defaults to."""
    example = (_BACKEND_DIR / ".env.example").read_text(encoding="utf-8")

    assert "STT_BACKEND=faster-whisper" in example
    assert "STT_BACKEND=whisper" not in example
    assert "WHISPER_MODEL_SIZE=base" in example
    assert "STT_LOCAL_FILES_ONLY=true" in example


def _requirement_lines(filename: str) -> list[str]:
    """Declared requirements only — comments and blanks dropped, so
    these assertions cannot be satisfied or broken by prose."""
    text = (_BACKEND_DIR / filename).read_text(encoding="utf-8")
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def test_both_backends_are_declared_as_runtime_dependencies():
    """Either backend can be the configured one, so a clean
    `pip install -r requirements.txt` must be able to serve both — an
    app whose default backend is missing raises "backend is not
    installed" on every call."""
    runtime = _requirement_lines("requirements.txt")
    evaluation = _requirement_lines("requirements-eval.txt")

    assert "faster-whisper==1.1.1" in runtime
    assert "openai-whisper==20240930" in runtime, "the override backend must stay installable"
    assert not [line for line in evaluation if line.startswith("faster-whisper")]


# --- stt_max_upload_bytes / stt_max_audio_seconds -------------------------


@pytest.mark.parametrize("field", ["stt_max_upload_bytes", "stt_max_audio_seconds"])
@pytest.mark.parametrize("good", [1, 60, 1024, 10485760])
def test_limits_accept_positive_whole_numbers(field, good):
    assert getattr(Settings(_env_file=None, **{field: good}), field) == good


@pytest.mark.parametrize("field", ["stt_max_upload_bytes", "stt_max_audio_seconds"])
@pytest.mark.parametrize("bad", [0, -1, -1024])
def test_limits_reject_zero_or_negative(field, bad):
    """A zero limit is not 'unlimited', it rejects every upload."""
    with pytest.raises(ValidationError, match="greater than zero"):
        Settings(_env_file=None, **{field: bad})


@pytest.mark.parametrize("field", ["stt_max_upload_bytes", "stt_max_audio_seconds"])
@pytest.mark.parametrize("bad", [True, False])
def test_limits_reject_bool(field, bad):
    """bool is an int subclass — True would become a 1-byte/1-second cap."""
    with pytest.raises(ValidationError, match="not bool"):
        Settings(_env_file=None, **{field: bad})


@pytest.mark.parametrize("field", ["stt_max_upload_bytes", "stt_max_audio_seconds"])
@pytest.mark.parametrize("bad", [60.0, 1.5, float("nan"), float("inf"), None, [], {}])
def test_limits_reject_non_integers(field, bad):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: bad})


@pytest.mark.parametrize("field", ["stt_max_upload_bytes", "stt_max_audio_seconds"])
@pytest.mark.parametrize("bad", ["", "   ", "60.0", "1e3", "abc", "nan", "inf", "true", "-5", "0"])
def test_limits_reject_bad_env_strings(field, bad):
    """pydantic-settings hands every env var over as a string, so the
    string forms must keep every rejection the typed ones have."""
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: bad})


@pytest.mark.parametrize("field", ["stt_max_upload_bytes", "stt_max_audio_seconds"])
def test_limits_parse_a_digit_env_string(field):
    assert getattr(Settings(_env_file=None, **{field: " 120 "}), field) == 120


# --- stt_compute_type -----------------------------------------------------


@pytest.mark.parametrize("good", ["int8", "float32", "int8_float16", " int8 "])
def test_compute_type_accepts_non_blank_strings(good):
    assert Settings(_env_file=None, stt_compute_type=good).stt_compute_type == good.strip()


@pytest.mark.parametrize("bad", ["", "   "])
def test_compute_type_rejects_blank(bad):
    """Blank silently means 'library default', not the configured value."""
    with pytest.raises(ValidationError, match="must not be blank"):
        Settings(_env_file=None, stt_compute_type=bad)


@pytest.mark.parametrize("bad", [None, True, False, 8, 1.0, [], {}])
def test_compute_type_rejects_non_strings(bad):
    with pytest.raises(ValidationError, match="must be a string"):
        Settings(_env_file=None, stt_compute_type=bad)


# --- stt_local_files_only -------------------------------------------------


@pytest.mark.parametrize("raw", ["true", "True", "1", "yes", "on"])
def test_local_files_only_accepts_the_truthy_env_spellings(stt_env, raw):
    assert stt_env(stt_local_files_only=raw).stt_local_files_only is True


@pytest.mark.parametrize("raw", ["false", "False", "0", "no", "off"])
def test_a_false_local_files_only_env_value_fails_startup(stt_env, raw):
    """Production must never download weights during a request. A false
    value in a .env would let one start a multi-hundred-megabyte fetch
    mid-request, possibly offline, while holding the single slot — so it
    is a startup failure, not a supported configuration."""
    with pytest.raises(ValidationError, match="must be true"):
        stt_env(stt_local_files_only=raw)


def test_local_files_only_cannot_be_disabled_from_the_constructor_either():
    """The refusal must not be bypassable in code any more than in a
    .env file."""
    with pytest.raises(ValidationError, match="must be true"):
        Settings(_env_file=None, stt_local_files_only=False)


def test_only_real_true_is_accepted_as_a_boolean():
    assert Settings(_env_file=None, stt_local_files_only=True).stt_local_files_only is True


@pytest.mark.parametrize("bad", [0, 1, 2, -1, 100])
def test_local_files_only_rejects_every_integer(bad):
    """`1` is rejected alongside `0`. An int is never how this value is
    legitimately supplied — an env var arrives as a string and code
    should pass a bool — so accepting truthy ints would only widen the
    surface on which a stray numeric could switch off the one protection
    stopping a user request from starting a model download."""
    with pytest.raises(ValidationError, match="must be a boolean"):
        Settings(_env_file=None, stt_local_files_only=bad)


@pytest.mark.parametrize("bad", [1.0, 0.0, 1.5, float("nan")])
def test_local_files_only_rejects_floats(bad):
    with pytest.raises(ValidationError, match="must be a boolean"):
        Settings(_env_file=None, stt_local_files_only=bad)


@pytest.mark.parametrize("bad", [None, [], {}, (), set(), b"true", object()])
def test_local_files_only_rejects_containers_and_other_types(bad):
    with pytest.raises(ValidationError, match="must be a boolean"):
        Settings(_env_file=None, stt_local_files_only=bad)


@pytest.mark.parametrize("bad", ["maybe", "", "   ", "TRUE!", "y", "t", "enabled", "2"])
def test_local_files_only_rejects_unrecognised_strings(bad):
    with pytest.raises(ValidationError, match="must be a boolean"):
        Settings(_env_file=None, stt_local_files_only=bad)


@pytest.mark.parametrize("raw", ["TRUE", "  True  ", "YES", "On", "1"])
def test_truthy_strings_are_accepted_case_insensitively_and_trimmed(raw):
    """These are the spellings pydantic-settings can hand over from a
    real environment variable."""
    assert Settings(_env_file=None, stt_local_files_only=raw).stt_local_files_only is True


def test_the_wrapper_still_accepts_local_files_only_false():
    """Settings cannot express it, but the model wrapper must still
    support it — that is how an explicitly approved evaluation step
    downloads weights on purpose, outside any user request."""
    import inspect

    from app.models.whisper_stt import load_model

    assert inspect.signature(load_model).parameters["local_files_only"].default is True


# --- whisper_model_size ---------------------------------------------------


def test_model_size_defaults_to_base():
    assert Settings(_env_file=None).whisper_model_size == "base"


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
        "",
        "   ",
        "../base",
        "../../etc/passwd",
        "/abs/path/model.pt",
        "C:/weights/model.pt",
        "~/.cache/whisper/base.pt",
        "base/../large",
        "openai/whisper-large-v3",
        "https://example.invalid/base.pt",
        None,
        7,
        True,
        [],
    ],
)
def test_model_size_rejects_everything_but_base(bad):
    """The value is handed to loaders that treat it as a path or repo id,
    so leaving it open would let configuration name an arbitrary
    checkpoint."""
    with pytest.raises(ValidationError):
        Settings(_env_file=None, whisper_model_size=bad)


def test_model_size_rejects_a_path_from_the_environment(monkeypatch):
    monkeypatch.setenv("WHISPER_MODEL_SIZE", "/weights/anything.pt")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


# --- listing generation bounds (V1) -----------------------------------


def test_listing_bounds_defaults():
    settings = Settings()
    assert settings.listing_llm_timeout_s == 60.0
    assert settings.listing_llm_num_predict == 512
    assert settings.listing_llm_max_attempts == 3
    # provisional convenience defaults — mirror Declutter's values, but
    # are their own knobs (see config.py's comment / this milestone).
    assert settings.listing_llm_model_name == "phi4-mini"
    assert settings.listing_llm_temperature == 0.2


@pytest.mark.parametrize("good", ["phi4-mini", "qwen3:8b", "  spaced-name  "])
def test_listing_model_name_accepts_non_blank_strings_trimmed(good):
    assert Settings(listing_llm_model_name=good).listing_llm_model_name == good.strip()


@pytest.mark.parametrize("bad", ["", "   ", None, 7, True, []])
def test_listing_model_name_rejects_blank_or_non_string(bad):
    with pytest.raises(ValidationError):
        Settings(listing_llm_model_name=bad)


@pytest.mark.parametrize("good", [0, 0.0, 0.2, 1, 2.0, "0.7"])
def test_listing_temperature_accepts_finite_zero_to_two(good):
    assert Settings(listing_llm_temperature=good).listing_llm_temperature == float(good)


@pytest.mark.parametrize(
    "bad", [-0.1, 2.1, float("inf"), float("nan"), True, False, None, "", "warm", []]
)
def test_listing_temperature_rejects_out_of_range_or_non_number(bad):
    with pytest.raises(ValidationError):
        Settings(listing_llm_temperature=bad)


@pytest.mark.parametrize("good", [1, 5.0, 60.0, 600])
def test_listing_timeout_accepts_finite_positive(good):
    assert Settings(listing_llm_timeout_s=good).listing_llm_timeout_s == good


@pytest.mark.parametrize("bad", [0, -1, float("inf"), float("nan"), True, False, None, "", "slow", []])
def test_listing_timeout_rejects_bad_values(bad):
    with pytest.raises(ValidationError):
        Settings(listing_llm_timeout_s=bad)


@pytest.mark.parametrize("bad", [0, -1, True, False, 512.0, "512.0", "abc", "", None])
def test_listing_num_predict_rejects_bad_values(bad):
    with pytest.raises(ValidationError):
        Settings(listing_llm_num_predict=bad)


@pytest.mark.parametrize("good", [1, 2, 3, 5, "4"])
def test_listing_max_attempts_accepts_1_to_5(good):
    assert Settings(listing_llm_max_attempts=good).listing_llm_max_attempts == int(good)


@pytest.mark.parametrize("bad", [0, 6, 100, -1, True, False, 3.0, "3.0", "", None])
def test_listing_max_attempts_rejects_out_of_range_or_non_integer(bad):
    with pytest.raises(ValidationError):
        Settings(listing_llm_max_attempts=bad)


def test_listing_bounds_are_their_own_settings_not_shared_with_declutter_or_reorganise():
    names = set(Settings.model_fields)
    assert {
        "listing_llm_timeout_s",
        "listing_llm_num_predict",
        "listing_llm_max_attempts",
        "listing_llm_model_name",
        "listing_llm_temperature",
    } <= names
    # not folded onto the Declutter or Reorganise knobs
    assert "llm_timeout_s" not in names


def test_listing_model_and_temperature_are_independent_of_declutter():
    """Changing the Declutter knobs must not move the listing ones."""
    settings = Settings(llm_model_name="declutter-model", llm_temperature=1.5)
    assert settings.listing_llm_model_name == "phi4-mini"
    assert settings.listing_llm_temperature == 0.2
