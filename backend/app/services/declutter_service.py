"""
Orchestration for the Declutter path: scene classification -> detection ->
confidence-gated LLM classification -> (for Sell items) listing draft.

This module is the shared implementation called by both app/api/routes.py
(HTTP) and evaluation/scripts/*.py (batch eval, no HTTP layer) — see §4's
"evaluation scripts call the same services/ functions" principle. Never
duplicate this logic inside a route handler or an eval script directly.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.logging_utils import stage_timer


@dataclass
class DetectedItem:
    label: str
    box: tuple[float, float, float, float]
    confidence: float


@dataclass
class ClassifiedItem:
    item: DetectedItem
    decision: str  # "keep" | "sell" | "donate" | "discard"
    reason: str
    listing: dict | None = None  # populated only when decision == "sell"


def run_declutter(run_id: str, image_bytes: bytes, user_context: str | None) -> dict:
    """
    Full Declutter pipeline for one image. Returns a dict matching the
    /upload response contract (scene, items, listings).

    Deliberately not implemented yet — per §3 build order, this gets
    written in step 5, *after* the model comparisons in step 4 have
    picked the actual detector/LLM to call here. Wiring this before that
    evidence exists is the exact ordering mistake §3/§9 call out.
    """
    with stage_timer(run_id, "declutter_pipeline"):
        raise NotImplementedError(
            "Depends on app/models/{grounding_dino,clip_scene,mistral_llm}.py "
            "and the §2 model comparisons being run first."
        )


def reclassify_item(run_id: str, item_id: str, new_label: str) -> ClassifiedItem:
    """Re-run LLM reasoning for a single item after user override (/override)."""
    raise NotImplementedError
