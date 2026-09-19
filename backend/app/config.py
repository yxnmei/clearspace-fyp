"""
Environment configuration and thresholds.

Single source of truth for anything that varies between dev/eval/demo —
Colab/ngrok URL, model names, detection confidence cutoffs. Nothing in
app/models or app/services should read os.environ directly; import Settings
from here instead, so eval scripts and the API always agree on config.
"""

import math
from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# The spellings a truthy stt_local_files_only may take. Deliberately
# narrow: only `True` itself and the four strings pydantic-settings could
# hand over from an environment variable. Module level, not a class
# attribute — a leading underscore inside a pydantic model becomes a
# ModelPrivateAttr rather than the frozenset.
_LOCAL_FILES_ONLY_TRUE_STRINGS = frozenset({"true", "1", "yes", "on"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- object detection ---
    grounding_dino_config_path: str = "weights/GroundingDINO_SwinT_OGC.py"
    grounding_dino_weights_path: str = "weights/groundingdino_swint_ogc.pth"
    detection_box_threshold: float = 0.35
    detection_text_threshold: float = 0.25
    # Passed through to the reasoning prompt rather than discarded after
    # detection — see §3 step 5, confidence-gating.
    detection_low_confidence_cutoff: float = 0.45

    # --- scene classification ---
    clip_model_name: str = "ViT-B/32"

    # --- LLM reasoning ---
    ollama_host: str = "http://localhost:11434"
    llm_model_name: str = "phi4-mini"  # evidence-backed production default — see PROJECT_SPEC.md §2, 2026-08-05 comparison
    llm_temperature: float = 0.2
    llm_max_retries: int = 2  # for JSON-validity failures, see core/json_repair.py
    # A single N-item JSON array gets more fragile as N grows — one dropped
    # key breaks the whole response. Chunk requests larger than this into
    # multiple calls instead (see mistral_llm.classify_items). Found via a
    # real 28-item detection set breaking mid-response even after retries.
    llm_max_items_per_call: int = 10

    # --- Reorganise planner bounds (RESEARCH PATH ONLY) ---
    # Scoped to app/models/reorganise_llm.py alone, deliberately NOT
    # shared with Declutter: app/models/mistral_llm.py also builds an
    # ollama.Client with no timeout, but Declutter's LLM behaviour is
    # evidence-backed and unchanged by this work, so hardening it is a
    # separate decision needing its own evidence. A shared setting here
    # would silently change Declutter too.
    #
    # Scope, precisely: these bound app/models/reorganise_llm.py and
    # nothing else. The evaluation harness
    # (evaluation/scripts/compare_reorganise_planning.py) does NOT read
    # them — it declares its own REQUEST_TIMEOUT_S/NUM_PREDICT constants
    # so an experiment's bounds stay fixed in the artefact regardless of
    # local .env. Production no longer calls the Reorganise planner at
    # all (see app/services/reorganise_service.py), so these bound the
    # retained research path only, never a live user request.
    #
    # 210s: the per-call bound the 2026-08-20 planner screen used, just
    # above its 180s interactive gate. The installed ollama client's own
    # default is None — no request timeout whatsoever — which is how a
    # real planning stage reached 1440.81s across two unbounded attempts.
    reorganise_llm_timeout_s: float = 210.0
    # 1536: measured, not guessed — a realistic valid 28-item plan
    # serializes to ~1901 chars compact / ~2374 pretty (~475-791 tokens);
    # 1536 leaves roughly 1.7x headroom over the worst realistic case
    # including markdown fences, while still stopping a runaway.
    reorganise_llm_num_predict: int = 1536

    # --- Reorganise action checklist bounds (RESEARCH PATH ONLY) ---
    # Scoped to app/models/reorganise_actions_llm.py's single chat() call
    # and nothing else. Production does NOT call the checklist model:
    # Direct Reorganise and Both build the deterministic checklist
    # directly (provenance "deterministic_direct"), because the two
    # authorised real phi4-mini runs (prompts reorganise-actions-v1 and
    # -v2) passed structural validation and failed human review; see
    # backend/evaluation/README.md. These bound the retained research
    # path only, never a live user request, and stay validated so a
    # future approved test cannot run unbounded. Deliberately their own
    # knobs, not the 210 s / 1536-token research-planner bounds above: a
    # 3-to-5-action checklist is a short structured response. The model
    # is llm_model_name (the configured phi4-mini); no second model is
    # named.
    #
    # 90s: generous for one short response on the CPU-only laptop this
    # project runs on (both real runs took about 25 s). The ollama
    # client's own default is None (unbounded).
    reorganise_actions_llm_timeout_s: float = 90.0
    # 640 tokens: five actions with an 80-character title and a
    # 300-character instruction each serialise to roughly 2,000
    # characters (~500 tokens); 640 leaves headroom while stopping a
    # runaway generation.
    reorganise_actions_llm_num_predict: int = 640

    # --- marketplace listing drafts (V1 generation bounds) ---
    # Scoped to app/models/listing_llm.py's single per-item chat() call
    # and app/services/listing_service.py's per-item retry budget, and
    # nothing else. Deliberately NOT shared with Declutter classification
    # or the Reorganise research planner: listing generation is a
    # distinct, still-provisional boundary whose model and prompt choice
    # stay unverified until a dedicated listing evaluation exists, so its
    # bounds must be tunable without touching either of those.
    #
    # 60s: a per-call ceiling for one short "title + description for one
    # item" response. The installed ollama client's own default request
    # timeout is None (unbounded) — this exists so one stalled call
    # cannot hang a /listings request indefinitely.
    listing_llm_timeout_s: float = 60.0
    # 512 tokens: a title plus a two/three-sentence description is well
    # under this; the cap only stops a runaway generation.
    listing_llm_num_predict: int = 512
    # Total attempts per eligible item — the first try plus up to two
    # retries. One /listings request with E eligible Sell items makes at
    # most E * listing_llm_max_attempts model calls, all sequential; a
    # request with zero eligible items makes none. Bounded to 1..5.
    listing_llm_max_attempts: int = 3
    # PROVISIONAL. The default deliberately mirrors Declutter's
    # llm_model_name / llm_temperature purely for local convenience while
    # listing generation has no evaluation — it is NOT evidence that the
    # Declutter classification model or a 0.2 temperature is right for
    # writing a marketplace listing. A listing evaluation must set these;
    # until then they are their own knobs so tuning one never disturbs
    # Declutter. Model name: a non-blank string. Temperature: a real,
    # finite number in [0.0, 2.0].
    listing_llm_model_name: str = "phi4-mini"
    listing_llm_temperature: float = 0.2

    # --- speech-to-text ---
    # Exactly "base": this is the only size the project evaluates or
    # ships, and the value is handed to loaders that treat it as a path
    # or repo id, so leaving it open would let configuration name an
    # arbitrary checkpoint. Literal rejects other sizes, absolute paths,
    # traversal sequences and whitespace-padded values alike.
    whisper_model_size: Literal["base"] = "base"
    # faster-whisper is the default because the two backends measured
    # IDENTICAL accuracy and it loads faster — NOT because it transcribes
    # better (see backend/evaluation/README.md for the figures). Do not
    # let that become an accuracy claim. "whisper" stays fully supported
    # and is one STT_BACKEND=whisper away; both ship in requirements.txt.
    # Literal, so an unrecognised or blank value is a startup failure
    # rather than a backend that silently resolves to nothing.
    stt_backend: Literal["whisper", "faster-whisper"] = "faster-whisper"
    # 10MB. Bounds what the route will read from one upload; the read is
    # capped at this + 1 byte so an oversized body is detected without
    # ever being held in memory in full.
    stt_max_upload_bytes: int = 10 * 1024 * 1024
    # 60s of DECODED audio. This, with the byte cap, is what bounds
    # transcription work — deliberately NOT a timeout: a timeout around a
    # worker thread cannot stop CPU-bound inference, so one would promise
    # a cancellation that does not happen. See
    # app/services/transcription_service.py's module docstring.
    stt_max_audio_seconds: int = 60
    # CTranslate2 quantisation for the faster-whisper backend only;
    # ignored by openai-whisper. int8 is the realistic CPU setting.
    stt_compute_type: str = "int8"
    # Weights must already be on disk. Pinned to True by a validator, not
    # merely defaulted: a false value in a .env would let a user request
    # start a multi-hundred-megabyte download mid-flight, on a machine
    # that may be offline, while holding the single transcription slot.
    # The wrapper still accepts local_files_only=False so an explicitly
    # approved evaluation/download step can fetch weights deliberately —
    # production simply cannot express it.
    stt_local_files_only: bool = True

    # --- image generation (remote Colab/ngrok service — see §5) ---
    image_gen_base_url: str = "https://REPLACE-ME.ngrok-free.app"  # reserved/static domain, not the rotating free kind
    image_gen_health_timeout_s: float = 3.0
    image_gen_request_timeout_s: float = 180.0
    image_gen_denoise_strength: float = 0.35
    # Provisional, standard baseline — NOT an evidence-backed optimum.
    # R7's real Colab testing must verify or revise this once a real
    # checkpoint/pipeline exists to test it against (see
    # app/models/image_gen_client.py's module docstring).
    image_gen_controlnet_conditioning_scale: float = 1.0
    # Fixed default seed so a default/demo/evaluation generation is
    # reproducible run to run — not a claim about output quality.
    # Overridable per generate() call.
    image_gen_seed: int = 42

    # --- logging ---
    log_dir: str = "logs"
    log_level: str = "INFO"

    # --- CORS (dev frontend origin) ---
    frontend_origin: str = "http://localhost:5173"

    @field_validator("reorganise_llm_timeout_s", mode="before")
    @classmethod
    def _check_reorganise_timeout(cls, v: object) -> object:
        """Must resolve to a real, finite, strictly-positive number.

        A numeric STRING is accepted and parsed, because that is how this
        value actually arrives in production: pydantic-settings hands
        every environment variable over as a string, so rejecting str
        outright made the documented .env value ("210.0") a hard startup
        failure. bool is still rejected (an int subclass — `True` would
        become a 1-second timeout), as are blank/malformed strings, and
        "nan"/"inf" are caught by the finiteness check after parsing: an
        infinite timeout is the very unboundedness this setting exists to
        prevent.
        """
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
        """Must resolve to a genuine positive WHOLE number.

        A digit string is accepted and parsed via int(), for the same
        environment-variable reason as the timeout above. int() is what
        keeps "1536.0" rejected — a fractional token budget is a
        configuration mistake, not something to silently truncate.
        bool is rejected explicitly (int subclass: `True` would arrive as
        num_predict=1 and cut every response to a single token), and so
        is a float, even a whole-valued one.
        """
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
        """Same discipline as _check_reorganise_timeout: a real, finite,
        strictly-positive number; numeric strings parsed (env vars arrive
        as strings), bool rejected, nan/inf rejected."""
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
        """A genuine positive WHOLE number. Same discipline as
        _check_reorganise_num_predict: digit string accepted, bool and
        float rejected."""
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
        """Must resolve to a real, finite, strictly-positive number. Same
        discipline and reasoning as _check_reorganise_timeout above — a
        numeric string is accepted (that is how pydantic-settings delivers
        an env var), bool is rejected (an int subclass), and nan/inf are
        rejected because an infinite timeout is the unboundedness this
        setting exists to prevent."""
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
        """A genuine positive WHOLE number. Same discipline as
        _check_reorganise_num_predict — digit string accepted, bool and
        float rejected."""
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
        """A whole number in 1..5. The lower bound guarantees at least one
        real attempt per eligible item; the upper bound keeps the
        worst-case model work for one /listings request bounded and
        predictable (E eligible items => at most E * this many calls).
        bool and float are rejected for the same reasons as the other
        whole-number limits above."""
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
        """A non-blank string. Not an allowlist — the model name is
        provisional and a listing evaluation may name any locally
        installed model — but a blank value would silently fall through
        to whatever the model library defaults to, so it is rejected.
        bool is rejected before the str check (it is not an int subclass
        issue here, but a non-string is still a config mistake)."""
        if isinstance(v, bool) or not isinstance(v, str):
            raise ValueError(f"listing_llm_model_name must be a string, not {type(v).__name__}")
        if not v.strip():
            raise ValueError("listing_llm_model_name must not be blank")
        return v.strip()

    @field_validator("listing_llm_temperature", mode="before")
    @classmethod
    def _check_listing_temperature(cls, v: object) -> object:
        """A real, finite number in [0.0, 2.0]. 0.0 is allowed (greedy
        decoding). Same discipline as the timeout validator above: a
        numeric string is parsed (that is how pydantic-settings delivers
        an env var), bool is rejected (an int subclass — True would
        become temperature 1.0), and nan/inf are rejected."""
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
        """Both STT limits must resolve to a genuine positive WHOLE number.

        Same discipline as reorganise_llm_num_predict above, and for the
        same reasons: a digit string is accepted because that is how
        pydantic-settings delivers an environment variable; bool is
        rejected explicitly (an int subclass — `True` would become a
        1-byte or 1-second limit that rejects everything); a float is
        rejected even when whole, since a fractional byte or second
        budget is a configuration mistake rather than something to round.
        """
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
        """Accepts ONLY boolean `True` or a recognised truthy string.

        Everything else is a startup failure, including every integer.
        `1` is rejected along with `0`: an int is not how this value is
        ever legitimately supplied — an env var arrives as a string and
        code should pass a bool — so accepting `1` would only widen the
        surface on which a stray numeric could disable the one protection
        stopping a user request from starting a model download. Rejecting
        the whole type is simpler to reason about than allowing half of
        it, and `bool` is checked first because it subclasses `int`.
        """
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
        """A non-blank string. Not an allowlist: CTranslate2 accepts a
        long and version-dependent set of quantisations, and hardcoding a
        subset here would reject valid ones on a future release. A blank
        value, though, silently means "library default" rather than the
        configured one, so it is rejected."""
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
