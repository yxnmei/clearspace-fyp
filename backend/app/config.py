"""
Environment configuration and thresholds.

Single source of truth for anything that varies between dev/eval/demo —
Colab/ngrok URL, model names, detection confidence cutoffs. Nothing in
app/models or app/services should read os.environ directly; import Settings
from here instead, so eval scripts and the API always agree on config.
"""

import math
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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

    # --- speech-to-text ---
    whisper_model_size: str = "base"

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
