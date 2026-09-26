"""Declutter reasoning through a configurable local Ollama model.

The filename is historical. The production default was the least-bad of five
candidates in the 2026-08-05 comparison, not a conclusive winner. ``model_name``
keeps evaluation on the same prompt and parsing path as production.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

import ollama

from app.config import get_settings
from app.core.json_repair import extract_json_detailed
from app.core.schemas import ItemValidity
from app.logging_utils import stage_timer

# Single comparison set shared with the evaluation harness.
COMPARISON_MODELS = ["mistral", "qwen3:8b", "gemma2:2b", "phi4-mini", "deepseek-r1:7b"]

# Hosted models conflict with the local CPU and privacy constraints.

CLASSIFICATION_PROMPT_VERSION = "v2"  # bump on any prompt-template change


@dataclass
class LLMResult:
    raw_text: str
    parsed_json: dict | list | None
    is_valid_json: bool
    model_name: str
    prompt_version: str
    # Parse/recovery provenance is only a hint. The service combines it with
    # identity and semantic validation before assigning ItemValidity.
    item_provenance: dict[int, ItemValidity] = field(default_factory=dict)


def build_classification_prompt(
    detected_items: list[dict],  # [{"label": str, "confidence": float, "position_hint": str}, ...]
    scene_label: str,
    user_context: str | None,
    start_number: int = 1,
) -> str:
    """
    Low-confidence detections receive a caveat; confidence remains optional for
    ground-truth evaluation items.

    Position hints and explicit numbers distinguish repeated labels. Without
    them, models produced collective non-schema decisions on 2026-08-01.

    Identical label/position pairs get "instance X of Y" after weaker models
    dropped duplicates in the 2026-08-07 run.

    ``start_number`` preserves unique numbering across chunks.

    The standing decisiveness instruction follows the 2026-08-08 context
    comparison, where neutral decisiveness beat directional framing. Its
    prompt-level effect has not been reverified against the model comparison.
    """
    settings = get_settings()
    lines = [
        "You are a decluttering assistant. For each detected item below, decide "
        'exactly one action — "keep", "sell", "donate", or "discard" — and give a '
        "short one-sentence reason. Make a clear, confident decision for each item "
        'on its own merits — do not default to "keep" out of caution or '
        "uncertainty; only choose it when it's genuinely the best call for that "
        "specific item. Judge each numbered item independently, even if another "
        "item shares the same label — use its size/position to tell them apart, "
        "and never merge multiple items into one collective decision.",
        "",
        f"Room type: {scene_label}",
    ]
    if user_context:
        lines.append(f"User's stated goal/context: {user_context}")
    lines.append("")
    lines.append("Detected items:")
    # The label is kept alone on its own line, deliberately — an earlier
    # version appended a low-confidence caveat directly after the quoted
    # label (e.g. '"pillow" (low-confidence...)'); several models (mistral,
    # phi4-mini) copied that parenthetical straight into the label field of
    # their JSON output, breaking it. Anything descriptive now goes on its
    # own following line instead, so there's no "text glued onto a quoted
    # string" pattern for a model to imitate.
    collision_keys = [(item["label"].strip().lower(), item.get("position_hint")) for item in detected_items]
    collision_counts = Counter(collision_keys)
    collision_seen: dict[tuple, int] = defaultdict(int)

    for i, item in enumerate(detected_items, start=start_number):
        lines.append(f'{i}. "{item["label"]}"')
        key = (item["label"].strip().lower(), item.get("position_hint"))
        is_colliding = collision_counts[key] > 1
        if is_colliding:
            collision_seen[key] += 1
        if item.get("position_hint"):
            hint_line = f"   (size/position: {item['position_hint']}"
            if is_colliding:
                hint_line += f" — instance {collision_seen[key]} of {collision_counts[key]}, a SEPARATE item"
            lines.append(hint_line + ")")
        elif is_colliding:
            lines.append(f"   (instance {collision_seen[key]} of {collision_counts[key]}, a SEPARATE item)")

    # Referenced by item number, not label text — with duplicate labels
    # (several "picture frame" entries), naming just the label string can't
    # say *which* instance is uncertain.
    low_confidence_numbers = [
        i
        for i, item in enumerate(detected_items, start=start_number)
        if item.get("confidence") is not None and item["confidence"] < settings.detection_low_confidence_cutoff
    ]
    if low_confidence_numbers:
        lines.append("")
        lines.append(
            "Note: these numbered detections had low confidence and may be "
            "mislabeled: " + ", ".join(f"#{n}" for n in low_confidence_numbers)
            + ". Still make a real decision for each of them — do not use "
            '"low-confidence" or anything other than keep/sell/donate/discard as '
            "the decision, and do not alter any item's label text in your response."
        )

    lines.append("")
    lines.append(
        f"Respond with a JSON array containing exactly {len(detected_items)} elements — "
        "one per item listed above, in the same order, no prose, no markdown fences. "
        'Each element: {"item_number": <int, matching the number above>, '
        '"label": <string, must match the item label above exactly>, '
        '"decision": "keep" | "sell" | "donate" | "discard", "reason": <short string>}.'
    )
    lines.append("")
    lines.append('Example, for two input items: 1. "lamp"  2. "old newspaper" (size/position: small, lower-left)')
    lines.append(
        '[{"item_number": 1, "label": "lamp", "decision": "keep", "reason": "still functional and in use"}, '
        '{"item_number": 2, "label": "old newspaper", "decision": "discard", "reason": "no longer needed"}]'
    )
    return "\n".join(lines)


def _classify_one_call(
    client: ollama.Client,
    resolved_model: str,
    settings,
    detected_items: list[dict],
    scene_label: str,
    user_context: str | None,
    start_number: int,
) -> tuple[str, dict | list | None, bool, bool, int]:
    """Call one chunk with bounded invalid-JSON retries and repair provenance."""
    prompt = build_classification_prompt(detected_items, scene_label, user_context, start_number=start_number)

    attempts_allowed = 1 + settings.llm_max_retries
    raw_text = ""
    parsed: dict | list | None = None
    is_valid = False
    was_repaired = False

    for attempt in range(attempts_allowed):
        # Do not pass format="json": its grammar collapsed requested arrays
        # into one object for all tested models except deepseek-r1. Repair
        # handles stray prose instead.
        response = client.chat(
            model=resolved_model,
            messages=[{"role": "user", "content": prompt}],
            options={"temperature": settings.llm_temperature},
        )
        raw_text = response["message"]["content"]
        extraction = extract_json_detailed(raw_text)
        parsed, is_valid, was_repaired = extraction.parsed, extraction.is_valid, extraction.was_repaired
        if is_valid and isinstance(parsed, list) and all(isinstance(x, dict) for x in parsed):
            break
        is_valid = False  # syntactically valid JSON but wrong shape still counts as a failed attempt here
        was_repaired = False

    return raw_text, parsed, is_valid, was_repaired, attempt + 1


def classify_items(
    run_id: str,
    detected_items: list[dict],
    scene_label: str,
    user_context: str | None,
    model_name: str | None = None,
) -> LLMResult:
    """Classify bounded chunks and recover each missing item once.

    Chunking avoids the failures seen with a 28-item response. Completeness is
    checked by item number because valid JSON still dropped repeated items on
    2026-08-07. Recovery does not hide an invalid original chunk.
    ``model_name`` supports evaluation through the production path.
    """
    settings = get_settings()
    resolved_model = model_name or settings.llm_model_name
    client = ollama.Client(host=settings.ollama_host)
    chunk_size = settings.llm_max_items_per_call

    chunks = [detected_items[i : i + chunk_size] for i in range(0, len(detected_items), chunk_size)] or [[]]

    raw_texts: list[str] = []
    merged_items: list = []
    all_chunks_valid = True
    total_attempts = 0
    recovered_item_count = 0
    still_missing_count = 0
    # Low-level provenance remains a hint until service validation.
    item_provenance: dict[int, ItemValidity] = {}

    with stage_timer(run_id, f"llm_classify::{resolved_model}") as t:
        start_number = 1
        for chunk in chunks:
            raw_text, parsed, is_valid, was_repaired, attempts = _classify_one_call(
                client, resolved_model, settings, chunk, scene_label, user_context, start_number
            )
            raw_texts.append(raw_text)
            total_attempts += attempts

            expected_numbers = set(range(start_number, start_number + len(chunk)))
            returned_numbers: set[int] = set()
            if is_valid:
                merged_items.extend(parsed)
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    n = item.get("item_number")
                    # bool is an int subclass and is not a valid item number.
                    if isinstance(n, int) and not isinstance(n, bool) and n in expected_numbers:
                        returned_numbers.add(n)
                        item_provenance[n] = (
                            ItemValidity.MECHANICALLY_REPAIRED if was_repaired else ItemValidity.RAW_VALID
                        )
            else:
                # Treat every item in an invalid chunk as missing for recovery.
                all_chunks_valid = False

            for missing_n in sorted(expected_numbers - returned_numbers):
                missing_item = detected_items[missing_n - 1]
                r_raw, r_parsed, r_valid, _r_repaired, r_attempts = _classify_one_call(
                    client, resolved_model, settings, [missing_item], scene_label, user_context, missing_n
                )
                raw_texts.append(r_raw)
                total_attempts += r_attempts
                if r_valid and r_parsed:
                    merged_items.extend(r_parsed)
                    recovered_item_count += 1
                    item_provenance[missing_n] = ItemValidity.RECOVERY_USED
                else:
                    still_missing_count += 1
                    all_chunks_valid = False  # a targeted retry still failing is worth surfacing, not hiding
                    item_provenance[missing_n] = ItemValidity.STILL_INVALID
            start_number += len(chunk)

        t.meta["n_chunks"] = len(chunks)
        t.meta["total_attempts"] = total_attempts
        t.meta["recovered_item_count"] = recovered_item_count
        t.meta["still_missing_count"] = still_missing_count
        t.meta["is_valid_json"] = all_chunks_valid

    return LLMResult(
        raw_text="\n---chunk---\n".join(raw_texts),
        parsed_json=merged_items if all_chunks_valid else (merged_items or None),
        is_valid_json=all_chunks_valid,
        model_name=resolved_model,
        prompt_version=CLASSIFICATION_PROMPT_VERSION,
        item_provenance=item_provenance,
    )
