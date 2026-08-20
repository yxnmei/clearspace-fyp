"""
Unit tests for app/config.py's validated settings.

Scope is deliberately narrow: the two Reorganise planner bounds added
when production stopped calling the planner. They are the only settings
in this file carrying custom validators, because they are the only ones
whose being wrong reintroduces the exact failure they exist to prevent —
an unbounded request.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings


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
