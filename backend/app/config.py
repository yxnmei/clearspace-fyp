"""
Environment configuration and thresholds.

Single source of truth for anything that varies between dev/eval/demo.
Nothing in app/models or app/services reads os.environ directly, so eval
scripts and the API always agree on config.
"""

import math
from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Truthy env-var spellings for stt_local_files_only. Module level because a
# leading-underscore class attribute on a pydantic model becomes a
# ModelPrivateAttr rather than the frozenset.
_LOCAL_FILES_ONLY_TRUE_STRINGS = frozenset({"true", "1", "yes", "on"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- object detection ---
    grounding_dino_config_path: str = "weights/GroundingDINO_SwinT_OGC.py"
    grounding_dino_weights_path: str = "weights/groundingdino_swint_ogc.pth"
    detection_box_threshold: float = 0.35
    detection_text_threshold: float = 0.25
    # Passed through to the confidence-gated reasoning prompt rather than
    # discarded after detection.
    detection_low_confidence_cutoff: float = 0.45

    # --- scene classification ---
    clip_model_name: str = "ViT-B/32"

    # --- LLM reasoning ---
    ollama_host: str = "http://localhost:11434"
    llm_model_name: str = "phi4-mini"  # evidence-backed production default from the 2026-08-05 comparison
    llm_temperature: float = 0.2
    llm_max_retries: int = 2  # for JSON-validity failures, see core/json_repair.py
    # One N-item JSON array gets more fragile as N grows (one dropped key
    # breaks the whole response), so larger requests are chunked. Found on
    # a real 28-item set breaking mid-response even after retries.
    llm_max_items_per_call: int = 10

    # --- Reorganise research-path LLM bounds (not on the production request path) ---
    # Bounded because the ollama client's default timeout is None
    # (unbounded). Separate from Declutter so tuning them never changes it.
    # Planner: 210 s per call; a valid 28-item plan is ~475-791 tokens, so
    # 1536 gives ~1.7x headroom including markdown fences.
    reorganise_llm_timeout_s: float = 210.0
    reorganise_llm_num_predict: int = 1536
    # Action checklist: real runs took ~25 s; five actions are ~500 tokens.
    reorganise_actions_llm_timeout_s: float = 90.0
    reorganise_actions_llm_num_predict: int = 640

    # --- marketplace listing drafts ---
    # Per-call bounds so one stalled call (ollama's default timeout is None)
    # cannot hang a /listings request. A request with E eligible Sell items
    # makes at most E * listing_llm_max_attempts sequential calls.
    listing_llm_timeout_s: float = 60.0
    listing_llm_num_predict: int = 512
    listing_llm_max_attempts: int = 3
    # Mirrors Declutter's model/temperature for local convenience only: the
    # listing evaluation approved no winner, so these remain provisional,
    # separate knobs.
    listing_llm_model_name: str = "phi4-mini"
    listing_llm_temperature: float = 0.2

    # --- speech-to-text ---
    # Allowlisted Literal: the value is used as a path/repo id, so an open
    # string would let configuration name an arbitrary checkpoint.
    whisper_model_size: Literal["base"] = "base"
    # faster-whisper is the default for loading latency, NOT accuracy: both
    # backends measured identical accuracy (backend/evaluation/README.md).
    # openai-whisper remains supported; both are in requirements.txt.
    stt_backend: Literal["whisper", "faster-whisper"] = "faster-whisper"
    # The read is capped at this + 1 byte, so an oversized body is detected
    # without being held in memory in full.
    stt_max_upload_bytes: int = 10 * 1024 * 1024
    # Seconds of DECODED audio. Transcription deliberately has no timeout: a
    # timeout cannot stop CPU-bound inference, so these input bounds (bytes,
    # decoded seconds) are what bound the work.
    stt_max_audio_seconds: int = 60
    # faster-whisper only; int8 is the realistic CPU setting.
    stt_compute_type: str = "int8"
    # Pinned True by a validator, so production can never start a model
    # download mid-request. Only an explicit evaluation step can pass
    # local_files_only=False to the wrapper.
    stt_local_files_only: bool = True

    # --- image generation (remote Colab/ngrok service) ---
    image_gen_base_url: str = "https://REPLACE-ME.ngrok-free.app"  # reserved/static domain, not the rotating free kind
    image_gen_health_timeout_s: float = 3.0
    image_gen_request_timeout_s: float = 180.0
    image_gen_denoise_strength: float = 0.35
    # Standard baseline, not an evidence-backed optimum: real Colab testing
    # verified runtime compatibility, not acceptable output fidelity.
    image_gen_controlnet_conditioning_scale: float = 1.0
    # Fixed for reproducibility, not quality; overridable per generate() call.
    image_gen_seed: int = 42

    # --- logging ---
    log_dir: str = "logs"
    log_level: str = "INFO"

    # --- CORS (dev frontend origin) ---
    frontend_origin: str = "http://localhost:5173"

    @field_validator("reorganise_llm_timeout_s", mode="before")
    @classmethod
    def _check_reorganise_timeout(cls, v: object) -> object:
        """A real, finite, positive number. Numeric strings are parsed
        (env values arrive as strings); bool is rejected (an int subclass,
        so True would pass as a 1-second timeout); nan/inf are rejected
        because an infinite timeout is unbounded."""
        if isinstance(v, bool):
            raise ValueError("reorganise_llm_timeout_s must be a real number, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("reorganise_llm_timeout_s must not be blank")
            try:
                v = float(text)
            except ValueError as exc:
                raise ValueError(
                    f"reorganise_llm_timeout_s is not a valid number: {v!r}"
                ) from exc
        elif not isinstance(v, (int, float)):
            raise ValueError(
                f"reorganise_llm_timeout_s must be a real number, not {type(v).__name__}"
            )
        if not math.isfinite(v):
            raise ValueError("reorganise_llm_timeout_s must be finite — an infinite timeout is unbounded")
        if v <= 0:
            raise ValueError(f"reorganise_llm_timeout_s must be greater than zero, got {v!r}")
        return v

    @field_validator("reorganise_llm_num_predict", mode="before")
    @classmethod
    def _check_reorganise_num_predict(cls, v: object) -> object:
        """A positive whole number. Digit strings are parsed (env values
        arrive as strings); bool is rejected (True would pass as 1); floats
        are rejected rather than silently truncated."""
        if isinstance(v, bool):
            raise ValueError("reorganise_llm_num_predict must be an integer, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("reorganise_llm_num_predict must not be blank")
            try:
                v = int(text)  # rejects "1536.0", "1e3", "nan", "abc"
            except ValueError as exc:
                raise ValueError(
                    f"reorganise_llm_num_predict must be a whole number, got {v!r}"
                ) from exc
        elif not isinstance(v, int):
            raise ValueError(
                f"reorganise_llm_num_predict must be an integer, not {type(v).__name__}"
            )
        if v <= 0:
            raise ValueError(f"reorganise_llm_num_predict must be greater than zero, got {v!r}")
        return v

    @field_validator("reorganise_actions_llm_timeout_s", mode="before")
    @classmethod
    def _check_reorganise_actions_timeout(cls, v: object) -> object:
        """As _check_reorganise_timeout: finite positive number, env strings
        parsed, bool (an int subclass) and nan/inf rejected."""
        if isinstance(v, bool):
            raise ValueError("reorganise_actions_llm_timeout_s must be a real number, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("reorganise_actions_llm_timeout_s must not be blank")
            try:
                v = float(text)
            except ValueError as exc:
                raise ValueError(f"reorganise_actions_llm_timeout_s is not a valid number: {v!r}") from exc
        elif not isinstance(v, (int, float)):
            raise ValueError(f"reorganise_actions_llm_timeout_s must be a real number, not {type(v).__name__}")
        if not math.isfinite(v):
            raise ValueError("reorganise_actions_llm_timeout_s must be finite — an infinite timeout is unbounded")
        if v <= 0:
            raise ValueError(f"reorganise_actions_llm_timeout_s must be greater than zero, got {v!r}")
        return v

    @field_validator("reorganise_actions_llm_num_predict", mode="before")
    @classmethod
    def _check_reorganise_actions_num_predict(cls, v: object) -> object:
        """As _check_reorganise_num_predict: positive whole number, env
        strings parsed, bool (True would pass as 1) and float rejected."""
        if isinstance(v, bool):
            raise ValueError("reorganise_actions_llm_num_predict must be an integer, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("reorganise_actions_llm_num_predict must not be blank")
            try:
                v = int(text)
            except ValueError as exc:
                raise ValueError(f"reorganise_actions_llm_num_predict must be a whole number, got {v!r}") from exc
        elif not isinstance(v, int):
            raise ValueError(f"reorganise_actions_llm_num_predict must be an integer, not {type(v).__name__}")
        if v <= 0:
            raise ValueError(f"reorganise_actions_llm_num_predict must be greater than zero, got {v!r}")
        return v

    @field_validator("listing_llm_timeout_s", mode="before")
    @classmethod
    def _check_listing_timeout(cls, v: object) -> object:
        """As _check_reorganise_timeout: finite positive number, env strings
        parsed, bool (an int subclass) and nan/inf rejected."""
        if isinstance(v, bool):
            raise ValueError("listing_llm_timeout_s must be a real number, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("listing_llm_timeout_s must not be blank")
            try:
                v = float(text)
            except ValueError as exc:
                raise ValueError(f"listing_llm_timeout_s is not a valid number: {v!r}") from exc
        elif not isinstance(v, (int, float)):
            raise ValueError(f"listing_llm_timeout_s must be a real number, not {type(v).__name__}")
        if not math.isfinite(v):
            raise ValueError("listing_llm_timeout_s must be finite — an infinite timeout is unbounded")
        if v <= 0:
            raise ValueError(f"listing_llm_timeout_s must be greater than zero, got {v!r}")
        return v

    @field_validator("listing_llm_num_predict", mode="before")
    @classmethod
    def _check_listing_num_predict(cls, v: object) -> object:
        """As _check_reorganise_num_predict: positive whole number, env
        strings parsed, bool (True would pass as 1) and float rejected."""
        if isinstance(v, bool):
            raise ValueError("listing_llm_num_predict must be an integer, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("listing_llm_num_predict must not be blank")
            try:
                v = int(text)
            except ValueError as exc:
                raise ValueError(f"listing_llm_num_predict must be a whole number, got {v!r}") from exc
        elif not isinstance(v, int):
            raise ValueError(f"listing_llm_num_predict must be an integer, not {type(v).__name__}")
        if v <= 0:
            raise ValueError(f"listing_llm_num_predict must be greater than zero, got {v!r}")
        return v

    @field_validator("listing_llm_max_attempts", mode="before")
    @classmethod
    def _check_listing_max_attempts(cls, v: object) -> object:
        """A whole number in 1..5: at least one real attempt per item, and a
        bounded worst case per /listings request. bool (True would pass as
        1) and float rejected; env strings parsed."""
        if isinstance(v, bool):
            raise ValueError("listing_llm_max_attempts must be an integer, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("listing_llm_max_attempts must not be blank")
            try:
                v = int(text)
            except ValueError as exc:
                raise ValueError(f"listing_llm_max_attempts must be a whole number, got {v!r}") from exc
        elif not isinstance(v, int):
            raise ValueError(f"listing_llm_max_attempts must be an integer, not {type(v).__name__}")
        if not (1 <= v <= 5):
            raise ValueError(f"listing_llm_max_attempts must be between 1 and 5 inclusive, got {v!r}")
        return v

    @field_validator("listing_llm_model_name", mode="before")
    @classmethod
    def _check_listing_model_name(cls, v: object) -> object:
        """A non-blank string. Not an allowlist, since the model is
        provisional, but blank would silently fall through to the library
        default."""
        if isinstance(v, bool) or not isinstance(v, str):
            raise ValueError(f"listing_llm_model_name must be a string, not {type(v).__name__}")
        if not v.strip():
            raise ValueError("listing_llm_model_name must not be blank")
        return v.strip()

    @field_validator("listing_llm_temperature", mode="before")
    @classmethod
    def _check_listing_temperature(cls, v: object) -> object:
        """A finite number in [0.0, 2.0] (0.0 is greedy decoding). Env
        strings parsed; bool rejected (True would pass as 1.0); nan/inf
        rejected."""
        if isinstance(v, bool):
            raise ValueError("listing_llm_temperature must be a real number, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("listing_llm_temperature must not be blank")
            try:
                v = float(text)
            except ValueError as exc:
                raise ValueError(f"listing_llm_temperature is not a valid number: {v!r}") from exc
        elif not isinstance(v, (int, float)):
            raise ValueError(f"listing_llm_temperature must be a real number, not {type(v).__name__}")
        if not math.isfinite(v):
            raise ValueError("listing_llm_temperature must be finite")
        if not (0.0 <= v <= 2.0):
            raise ValueError(f"listing_llm_temperature must be between 0.0 and 2.0 inclusive, got {v!r}")
        return v

    @field_validator("stt_max_upload_bytes", "stt_max_audio_seconds", mode="before")
    @classmethod
    def _check_positive_whole_limit(cls, v: object) -> object:
        """A positive whole number. Env strings parsed; bool rejected (True
        would pass as a 1-byte/1-second limit); floats rejected, not rounded."""
        if isinstance(v, bool):
            raise ValueError("STT limits must be an integer, not bool")
        if isinstance(v, str):
            text = v.strip()
            if not text:
                raise ValueError("STT limits must not be blank")
            try:
                v = int(text)  # rejects "10.5", "1e3", "nan", "abc"
            except ValueError as exc:
                raise ValueError(f"STT limits must be a whole number, got {v!r}") from exc
        elif not isinstance(v, int):
            raise ValueError(f"STT limits must be an integer, not {type(v).__name__}")
        if v <= 0:
            raise ValueError(f"STT limits must be greater than zero, got {v!r}")
        return v

    @field_validator("stt_local_files_only", mode="before")
    @classmethod
    def _require_local_files_only(cls, v: object) -> object:
        """Only `True` or a recognised truthy string. Every int, even `1`, is
        rejected: env values arrive as strings and code passes a bool, so
        an int is only a stray numeric that could disable the download
        guard. bool is checked first because it subclasses int."""
        if isinstance(v, bool):
            if v:
                return True
            raise ValueError(
                "stt_local_files_only must be true — production must never download "
                "model weights during a request"
            )
        if isinstance(v, str):
            text = v.strip().lower()
            if text in _LOCAL_FILES_ONLY_TRUE_STRINGS:
                return True
            if text in {"false", "0", "no", "off"}:
                raise ValueError(
                    "stt_local_files_only must be true — production must never download "
                    "model weights during a request"
                )
            raise ValueError(f"stt_local_files_only must be a boolean, got {v!r}")
        raise ValueError(
            f"stt_local_files_only must be a boolean, not {type(v).__name__}"
        )

    @field_validator("stt_compute_type", mode="before")
    @classmethod
    def _check_compute_type(cls, v: object) -> object:
        """A non-blank string. Not an allowlist: CTranslate2's quantisation
        set is version-dependent. Blank would silently mean library default."""
        if isinstance(v, bool) or not isinstance(v, str):
            raise ValueError(
                f"stt_compute_type must be a string, not {type(v).__name__}"
            )
        if not v.strip():
            raise ValueError("stt_compute_type must not be blank")
        return v.strip()


@lru_cache
def get_settings() -> Settings:
    return Settings()
