"""
Pure logic: the deterministic image-generation prompt for a Reorganise
visual preview.

Built directly from the room type (scene label), the selected items'
effective labels / sizes / positions, and the reviewed user context. No
model writes or edits this prompt: the checklist model
(app/models/reorganise_actions_llm.py) is never asked for an image
prompt, so the visual and the checklist can share the user's stated goal
without the visual claiming to follow each checklist action. item_ids
never appear in the prompt; labels are display text for the image model.

This is the same prompt shape the earlier deterministic plan built
(app.core.reorganise_semantic_conversion.build_deterministic_fallback_plan,
now research-only), extracted so the production pipeline no longer
depends on the zone-plan structure at all.
"""

from __future__ import annotations

from typing import Any

from app.core.schemas import DetectedItem


def _validate(selected_items: Any, scene_label: Any, user_context: Any) -> None:
    if not isinstance(selected_items, list) or not selected_items:
        raise ValueError("selected_items must be a non-empty list")
    for index, item in enumerate(selected_items):
        if not isinstance(item, DetectedItem):
            raise ValueError(f"selected_items[{index}] must be a DetectedItem, got {type(item).__name__}")
    ids = [item.item_id for item in selected_items]
    if len(ids) != len(set(ids)):
        raise ValueError("selected_items contains a duplicate item_id")
    if not isinstance(scene_label, str) or not scene_label.strip():
        raise ValueError("scene_label must be a non-blank string")
    if user_context is not None and not isinstance(user_context, str):
        raise ValueError("user_context must be None or a string")


def build_reorganise_image_prompt(
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None = None,
) -> str:
    """
    Pure and fully deterministic given the same inputs. Raises ValueError
    (never AttributeError/TypeError) on invalid caller input. Whitespace-
    only user_context is treated the same as None and never surfaced.
    """
    _validate(selected_items, scene_label, user_context)

    lines = [
        f"A tidy, well-organised {scene_label.strip()}.",
        "Preserve the room's structure, walls, windows, and furniture layout exactly.",
        "Keep every one of the following selected objects visibly present, only rearranged or straightened:",
    ]
    for item in selected_items:
        line = f"- {item.effective_label}"
        spatial_bits = [bit for bit in (item.relative_size, item.position) if bit]
        if spatial_bits:
            line += f" ({', '.join(spatial_bits)})"
        lines.append(line)

    if user_context and user_context.strip():
        lines.append(f"Additional context from the user: {user_context.strip()}")

    return "\n".join(lines)
