"""
Orchestration for the Reorganise path: zone-plan generation (Mistral) +
image-to-image regeneration via the remote Colab/ngrok service (§5).

Same rule as declutter_service.py: this is the one implementation shared
by the API and evaluation/scripts — including the fidelity-scoring eval
in §3 step 7 (re-detect on the generated image, report what fraction of
requested Keep items are still detectable).
"""

from __future__ import annotations

from app.logging_utils import stage_timer


def run_reorganise(run_id: str, image_bytes: bytes, kept_item_labels: list[str]) -> dict:
    """
    Zone plan + product recommendations + generated image. Calls out to
    app/models/image_gen_client.py for the Colab/ngrok round trip — that
    client is responsible for the §5 health-check-before-generate pattern,
    not this function.
    """
    with stage_timer(run_id, "reorganise_pipeline"):
        raise NotImplementedError(
            "Depends on app/models/mistral_llm.py and app/models/image_gen_client.py"
        )


def score_generation_fidelity(run_id: str, generated_image_bytes: bytes, kept_item_labels: list[str]) -> float:
    """
    §3 step 7: re-run the object detector on the generated image and
    return the fraction of `kept_item_labels` still detected. This is
    what turns "does it look okay" into a number reported alongside every
    generation, not a one-off script run before a deadline.
    """
    with stage_timer(run_id, "fidelity_score"):
        raise NotImplementedError("Depends on app/models/grounding_dino.py")
