"""
Environment configuration and thresholds.

Single source of truth for anything that varies between dev/eval/demo —
Colab/ngrok URL, model names, detection confidence cutoffs. Nothing in
app/models or app/services should read os.environ directly; import Settings
from here instead, so eval scripts and the API always agree on config.
"""

from functools import lru_cache
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
    llm_model_name: str = "mistral"  # overridden per-run by eval scripts when comparing §2 candidates
    llm_temperature: float = 0.2
    llm_max_retries: int = 2  # for JSON-validity failures, see core/json_repair.py

    # --- speech-to-text ---
    whisper_model_size: str = "base"

    # --- image generation (remote Colab/ngrok service — see §5) ---
    image_gen_base_url: str = "https://REPLACE-ME.ngrok-free.app"  # reserved/static domain, not the rotating free kind
    image_gen_health_timeout_s: float = 3.0
    image_gen_request_timeout_s: float = 180.0
    image_gen_denoise_strength: float = 0.35

    # --- logging ---
    log_dir: str = "logs"
    log_level: str = "INFO"

    # --- CORS (dev frontend origin) ---
    frontend_origin: str = "http://localhost:5173"


@lru_cache
def get_settings() -> Settings:
    return Settings()
