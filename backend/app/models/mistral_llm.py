"""
LLM reasoning: Mistral 7B via Ollama (chosen, §2 — local, privacy-preserving,
structured JSON output; not yet compared against alternatives — marked
"run early this time").

`model_name` is a parameter, not a hardcoded constant, specifically so
evaluation/scripts/compare_llm_reasoning.py can call this same function
once per candidate in §2's comparison set (qwen3:8b, gemma2:2b, phi4-mini,
deepseek-r1:7b) without duplicating the prompt-building or JSON-parsing
logic. One implementation, swappable model — not four near-identical
eval-only copies.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.config import get_settings

# §2 comparison set — kept here as the single source of truth for which
# model names the eval harness iterates over, so evaluation/scripts/
# imports this instead of re-listing the models inline.
COMPARISON_MODELS = ["mistral", "qwen3:8b", "gemma2:2b", "phi4-mini", "deepseek-r1:7b"]

# Frontier hosted models considered and rejected (§2) — infeasible for
# local CPU inference and conceptually mismatched with the local-privacy
# design. Not in COMPARISON_MODELS; don't add without revisiting that
# constraint explicitly.

CLASSIFICATION_PROMPT_VERSION = "v1"  # bump on any prompt-template change — versioned per §3 step 5


@dataclass
class LLMResult:
    raw_text: str
    parsed_json: dict | list | None
    is_valid_json: bool
    model_name: str
    prompt_version: str


def build_classification_prompt(
    detected_items: list[dict],  # [{"label": str, "confidence": float}, ...]
    scene_label: str,
    user_context: str | None,
) -> str:
    """
    Confidence-gated: passes each item's detection confidence into the
    prompt rather than discarding it after detection (§3 step 5) — a
    low-confidence "cable" detection should be able to influence the
    LLM's willingness to assert e.g. "visibly broken" the way v1's
    confidence-blind prompt couldn't.

    Not implemented yet — depends on the §2 LLM comparison to know which
    model's prompt-following quirks need designing around.
    """
    raise NotImplementedError


def classify_items(
    run_id: str,
    detected_items: list[dict],
    scene_label: str,
    user_context: str | None,
    model_name: str | None = None,
) -> LLMResult:
    """
    model_name defaults to config.llm_model_name (mistral) but accepts an
    override — this is the hook evaluation/scripts/compare_llm_reasoning.py
    uses to run the same call across COMPARISON_MODELS.
    """
    settings = get_settings()
    resolved_model = model_name or settings.llm_model_name
    raise NotImplementedError(f"Call Ollama ({resolved_model}) via app.config.ollama_host")
