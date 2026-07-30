"""
Speech-to-text: Whisper base (chosen, §2 — accurate on short context
phrases; not yet compared against faster-whisper — marked "run early
this time", see requirements-eval.txt and
evaluation/scripts/compare_stt.py).

Transcript is surfaced to the user for review before it enters the
context field (per report §2.6 lineage) — that review step lives in the
frontend/service layer, not here; this module only transcribes.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.config import get_settings


@dataclass
class TranscriptResult:
    text: str
    model_name: str
    duration_ms: float


def load_model():
    settings = get_settings()
    raise NotImplementedError(f"Load whisper '{settings.whisper_model_size}'")


def transcribe(audio_bytes: bytes, model_name: str = "whisper-base") -> TranscriptResult:
    """
    model_name is accepted (not hardcoded) for the same reason as
    mistral_llm.classify_items — evaluation/scripts/compare_stt.py calls
    this once for whisper-base and once for faster-whisper without a
    second near-duplicate implementation.
    """
    raise NotImplementedError
