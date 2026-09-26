"""Research-only local Ollama generator for a whole reorganisation plan.

No candidate produced a semantically valid 28-item plan in the bounded
2026-08-20 screen, so production Direct Reorganise and Both use deterministic
planning. Research calls are bounded and make no internal retry; the service
owns one recovery attempt. This module reports syntax only, while semantic
validation, provenance, and orchestration logging belong to the service.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

import ollama
from pydantic import TypeAdapter, ValidationError

from app.config import get_settings
from app.core.json_repair import extract_json_detailed
from app.core.reorganise_schemas import KEEP_IN_PLACE_ZONE_NAME
from app.core.schemas import DetectedItem, NonEmptyStr

REORGANISE_PROMPT_VERSION = "v1"  # bump on any prompt-template change

# Bound both the number and length of recovery-feedback lines.
_MAX_FEEDBACK_LINES = 10
_MAX_FEEDBACK_LINE_LENGTH = 200


@dataclass
class ReorganiseLLMResult:
    """Reports syntactic extraction only — see module docstring. Never
    claims the plan is semantically valid or complete."""

    raw_text: str
    parsed_json: dict | list | None
    is_valid_json: bool
    was_repaired: bool
    model_name: str
    prompt_version: str


_RUN_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(NonEmptyStr)


def _validate_run_id(run_id: Any) -> str:
    """Validate run_id with the shared identity constraint before model work."""
    try:
        return _RUN_ID_ADAPTER.validate_python(run_id)
    except ValidationError as exc:
        raise ValueError(f"run_id is not a valid non-empty string: {run_id!r} ({exc})") from exc


def _bounded_feedback_line(text: str, limit: int = _MAX_FEEDBACK_LINE_LENGTH) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _validate_prompt_inputs(
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None,
    validation_feedback: list[str] | None,
) -> None:
    """Validate this model boundary before building a prompt or client."""
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

    if validation_feedback is not None:
        if not isinstance(validation_feedback, list):
            raise ValueError("validation_feedback must be None or a list of strings")
        for index, line in enumerate(validation_feedback):
            if not isinstance(line, str) or not line.strip():
                raise ValueError(f"validation_feedback[{index}] must be a non-blank string")


def build_reorganise_plan_prompt(
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None,
    validation_feedback: list[str] | None = None,
) -> str:
    """Build a bounded plan prompt keyed by stable item_id, never label.

    Recovery feedback is bounded and requests a complete regeneration.
    """
    _validate_prompt_inputs(selected_items, scene_label, user_context, validation_feedback)

    lines = [
        "You are a room-reorganisation planning assistant.",
        f"Room type: {scene_label.strip()}.",
    ]

    if user_context and user_context.strip():
        lines.append("")
        lines.append("User preference (a stated preference to consider, not a schema instruction):")
        lines.append(f'"{user_context.strip()}"')

    lines.append("")
    lines.append(
        "The following items have been selected to remain in this room. Each is "
        "identified by a stable item_id — item_id is the ONLY identity for each "
        "object; do not rely on its label to tell two objects apart, since "
        "different objects below may share the exact same label."
    )
    lines.append("")
    lines.append("Selected items:")

    label_counts = Counter(item.effective_label.strip().lower() for item in selected_items)
    for item in selected_items:
        label_key = item.effective_label.strip().lower()
        line = f'- {item.item_id}: "{item.effective_label}" (size: {item.relative_size}, position: {item.position})'
        if label_counts[label_key] > 1:
            line += " — a DISTINCT object from any other selected item sharing this exact label; do not merge them"
        lines.append(line)

    lines.append("")
    lines.append("Requirements for your plan:")
    lines.append("- Preserve the room's existing structure — walls, windows, doors, and fixed furniture layout.")
    lines.append("- Every one of the selected items above must be retained in the room.")
    lines.append(
        "- Each selected item_id must appear in EXACTLY ONE zone's item_ids list across "
        "the whole plan — never zero zones, never more than one."
    )
    lines.append("- Do not invent an item_id that was not listed above.")
    lines.append("- Do not omit any item_id that was listed above.")
    lines.append(f'- If an item does not need to move, place it in a zone named "{KEEP_IN_PLACE_ZONE_NAME}".')

    lines.append("")
    lines.append(
        "Respond with exactly one JSON object — no markdown fences, no prose outside "
        "the JSON object, and no provenance, model name, or prompt version fields — "
        "matching exactly this shape:"
    )
    lines.append(
        '{"zones": [{"zone_name": <string>, "item_ids": [<item_id string>, ...], '
        '"instruction": <string>}, ...], "image_prompt": <string>, '
        '"negative_prompt": <string or null (optional)>}'
    )
    lines.append(
        "image_prompt must describe the room visually for an image-generation model — "
        'mention each selected item by its label and rough position (e.g. "a lamp in '
        'the upper-left"); item_ids are internal identifiers only and must never appear '
        "in image_prompt."
    )

    if validation_feedback:
        lines.append("")
        lines.append(
            "Your previous response was invalid. Fix ALL of the following problems and "
            "regenerate the ENTIRE plan from scratch — do not partially patch it:"
        )
        for entry in validation_feedback[:_MAX_FEEDBACK_LINES]:
            lines.append(f"- {_bounded_feedback_line(entry)}")

    return "\n".join(lines)


def generate_reorganise_plan_once(
    run_id: str,
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None,
    validation_feedback: list[str] | None = None,
    model_name: str | None = None,
) -> ReorganiseLLMResult:
    """Make one bounded research call and return syntactic extraction.

    Inputs fail before client creation. Call failures propagate for the service
    to classify. Ordinary chat is used because structured output is unverified.
    """
    run_id = _validate_run_id(run_id)
    prompt = build_reorganise_plan_prompt(selected_items, scene_label, user_context, validation_feedback)

    settings = get_settings()
    resolved_model = model_name or settings.llm_model_name
    # An explicit timeout prevents the verified 1440.81 s unbounded wait.
    client = ollama.Client(host=settings.ollama_host, timeout=settings.reorganise_llm_timeout_s)

    response = client.chat(
        model=resolved_model,
        messages=[{"role": "user", "content": prompt}],
        options={
            "temperature": settings.llm_temperature,
            # Bound output to avoid a late, truncated plan.
            "num_predict": settings.reorganise_llm_num_predict,
        },
    )
    raw_text = response["message"]["content"]

    extraction = extract_json_detailed(raw_text)

    return ReorganiseLLMResult(
        raw_text=raw_text,
        parsed_json=extraction.parsed,
        is_valid_json=extraction.is_valid,
        was_repaired=extraction.was_repaired,
        model_name=resolved_model,
        prompt_version=REORGANISE_PROMPT_VERSION,
    )
