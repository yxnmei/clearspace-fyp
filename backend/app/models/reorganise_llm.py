"""
LLM reasoning: Reorganise plan generation via local Ollama.

RESEARCH PATH — NOT ON THE PRODUCTION REQUEST PATH. Since the 2026-08-20
bounded planner screen (backend/evaluation/README.md) found no candidate
model able to produce a semantically valid plan for a crowded 28-item
room, Direct Reorganise and Both both build the deterministic plan
directly (provenance "deterministic_direct") and never call this module.
Nothing here is deleted: it remains fully wired for unit tests and for
evaluation/scripts/compare_reorganise_planning.py, and
the research planning service still accepts this generator explicitly.
Every call it does make is bounded by an explicit client timeout and
num_predict — see generate_reorganise_plan_once().

Model name resolved from config — this module is model-name-agnostic,
never hardcoding one.

Deliberately a NEW, dedicated module — not added to mistral_llm.py.
That module's own docstring already flags its filename as an inherited
historical misnomer, kept as-is only because renaming it was out of
scope for the task that documented the decision. Reorganise planning is
also structurally different from Declutter's per-item classification
(one JSON object describing a whole plan, never chunked across multiple
calls) — bolting a second, differently-shaped responsibility onto that
file would compound the naming confusion rather than leave room to fix
it later. See PROJECT_SPEC.md/DEVLOG.md's R2 design note.

Exactly one Ollama call per invocation, deliberately: this module has NO
internal retry loop and does not read settings.llm_max_retries. The one
bounded recovery attempt is entirely app/services/reorganise_service.py's
job (its own documented orchestration policy) — combining this module's
own retry with the service's recovery attempt would multiply slow,
CPU-bound Ollama calls unpredictably.

This module reports SYNTACTIC extraction only, via the same
core/json_repair.extract_json_detailed() parser Declutter already uses.
It has no opinion about whether a plan is semantically complete or valid
(that's app.core.reorganise_semantic_conversion.parse_and_validate_plan's
job) and never assigns PlanProvenance (that's the service's job, using
is_valid_json/was_repaired as inputs among several, not as the final
verdict).

No stage_timer, no log write anywhere in this module — logging orchestration-
level attempts (including which one ultimately produced the result) is the
service's job; a low-level wrapper logging its own single call would double
up with that once the service exists.
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

# Recovery-prompt feedback is bounded on two axes: how many lines get
# pasted in, and how long each one may be — never an unlimited raw
# previous response or an unbounded structured-error list.
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
    """Validates/normalizes run_id through the SAME shared NonEmptyStr
    type app.core.schemas already defines (strip_whitespace=True,
    min_length=1) — no second, hand-written run-id rule to drift out of
    sync with it. Raises ValueError (this module's uniform caller-input
    exception type, not pydantic's own ValidationError) before any
    prompt text or Ollama client is built."""
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
    """Fails fast with a clear ValueError — never AttributeError/TypeError
    — before any prompt text or Ollama client is built. Mirrors
    app.core.reorganise_semantic_conversion.build_deterministic_fallback_plan's
    own caller-input discipline (deliberately re-checked here, not
    imported, since that function's checks are private to that module and
    this is a distinct boundary)."""
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
    """
    Pure. Raises ValueError on invalid caller input (see
    _validate_prompt_inputs) before building any text.

    Identity discipline: every selected item is presented by its stable
    item_id first, with an explicit instruction that item_id — never
    label — is what ties a zone assignment back to a real object; two
    items sharing a label get an explicit "DISTINCT object" callout so
    the model can't merge them.

    When `validation_feedback` is given (the service's recovery attempt),
    the previous-response's problems are stated plainly and bounded (see
    _MAX_FEEDBACK_LINES/_MAX_FEEDBACK_LINE_LENGTH) — never an unlimited
    raw previous response — with an explicit instruction to regenerate
    the whole plan, not patch it.
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
    """
    Exactly one ollama.Client.chat() call. `run_id` is validated first
    (see _validate_run_id — the same shared NonEmptyStr semantics as
    every other identity in this codebase) purely to fail fast, before
    any prompt text or Ollama client is built; it is accepted for
    signature symmetry with mistral_llm.classify_items and for possible
    future logging by a caller — this function itself never logs (see
    module docstring) and has no other internal use for it.

    Raises ValueError for an invalid run_id, or whatever
    build_reorganise_plan_prompt() raises for other invalid caller input
    — both BEFORE any Ollama client is constructed — and propagates any
    exception from the Ollama call itself unmodified — this module has no
    retry loop and no exception handling around the call;
    app/services/reorganise_service.py is responsible for catching and
    classifying a raised exception as a `call_failed` issue.

    Uses the ordinary client.chat() pattern already verified by
    Declutter (app.models.mistral_llm) — not Ollama's JSON-mode grammar
    (which Declutter's own comparison already found collapses a
    requested array into a single object) and not any newer structured-
    output feature, since neither the installed ollama version nor
    phi4-mini's behavior with one has been verified against real
    inference in this repository.
    """
    run_id = _validate_run_id(run_id)
    prompt = build_reorganise_plan_prompt(selected_items, scene_label, user_context, validation_feedback)

    settings = get_settings()
    resolved_model = model_name or settings.llm_model_name
    # Explicit request timeout: the installed ollama client's own default
    # is None — no timeout at all — which is how a real planning stage
    # reached 1440.81s. Reorganise-scoped setting; Declutter's own client
    # (app/models/mistral_llm.py) is deliberately untouched.
    client = ollama.Client(host=settings.ollama_host, timeout=settings.reorganise_llm_timeout_s)

    response = client.chat(
        model=resolved_model,
        messages=[{"role": "user", "content": prompt}],
        options={
            "temperature": settings.llm_temperature,
            # Without this the model may generate until the context window
            # is exhausted, which produces a truncated, unparseable plan
            # after a very long wait. See config.py for how 1536 was derived.
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
