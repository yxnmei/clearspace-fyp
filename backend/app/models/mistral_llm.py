"""
LLM reasoning: local Ollama models, wired up under this mistral_llm.py
filename from the first candidate tried (§2) — retained as-is, not
renamed, per this task's explicit scope boundary.

phi4-mini is the evidence-backed production default (app.config.Settings
.llm_model_name; PROJECT_SPEC.md §2, 2026-08-05 comparison) — chosen as
the least-bad of five candidates, not as conclusively superior. The other
four candidates from that comparison remain preserved below in
COMPARISON_MODELS, including mistral itself, so
evaluation/scripts/compare_llm_reasoning.py can keep re-running against
all five.

`model_name` is a parameter, not a hardcoded constant, specifically so
evaluation scripts can call this same function once per candidate in
COMPARISON_MODELS without duplicating the prompt-building or JSON-parsing
logic. One implementation, swappable model — not five near-identical
eval-only copies.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

import ollama

from app.config import get_settings
from app.core.json_repair import extract_json_detailed
from app.core.schemas import ItemValidity
from app.logging_utils import stage_timer

# §2 comparison set — kept here as the single source of truth for which
# model names the eval harness iterates over, so evaluation/scripts/
# imports this instead of re-listing the models inline.
COMPARISON_MODELS = ["mistral", "qwen3:8b", "gemma2:2b", "phi4-mini", "deepseek-r1:7b"]

# Frontier hosted models considered and rejected (§2) — infeasible for
# local CPU inference and conceptually mismatched with the local-privacy
# design. Not in COMPARISON_MODELS; don't add without revisiting that
# constraint explicitly.

CLASSIFICATION_PROMPT_VERSION = "v2"  # bump on any prompt-template change — versioned per §3 step 5


@dataclass
class LLMResult:
    raw_text: str
    parsed_json: dict | list | None
    is_valid_json: bool
    model_name: str
    prompt_version: str
    # item_number -> low-level parse/recovery provenance for that number,
    # as classify_items() itself observed it. Additive field (default
    # empty dict) — every existing construction site is classify_items()
    # itself, which now always populates one entry per expected item
    # number in the call; any other caller (fakes, older code) omitting
    # it gets a safe empty default, never a fabricated value.
    #
    # This is a HINT only, not authoritative: it reflects whether JSON
    # parsed cleanly/needed repair/needed classify_items()'s own missing-
    # item recovery — it says nothing about whether the item's *decision*
    # is actually a legal enum value or its *reason* non-blank, and it
    # says nothing about duplicate/unexpected item_numbers across the
    # whole response (classify_items() only sees one chunk at a time).
    # app.services.declutter_service.run_declutter() is what turns this
    # hint plus real identity/content validation into the authoritative
    # ItemValidity assigned to each item_id — it explicitly must NOT
    # treat a missing/unknown hint here as ItemValidity.RAW_VALID.
    item_provenance: dict[int, ItemValidity] = field(default_factory=dict)


def build_classification_prompt(
    detected_items: list[dict],  # [{"label": str, "confidence": float, "position_hint": str}, ...]
    scene_label: str,
    user_context: str | None,
    start_number: int = 1,
) -> str:
    """
    Confidence-gated: passes each item's detection confidence into the
    prompt rather than discarding it after detection (§3 step 5) — a
    low-confidence "cable" detection should be able to influence the
    LLM's willingness to assert e.g. "visibly broken" the way v1's
    confidence-blind prompt couldn't. `confidence` is optional per item
    (ground-truth eval items don't carry one); only items with a real,
    low confidence score get the caveat line.

    `position_hint` (optional, from core/box_descriptors.describe_box) is
    a coarse "large, upper-left" style string. Without it, several
    same-labelled detections (e.g. six "picture frame" boxes) are
    indistinguishable text to the model — it has no basis to judge them
    differently, and some models responded by inventing a non-schema
    collective decision like "keep one, donate others" instead (real-
    detection run, DEVLOG.md 2026-08-01). Each item also gets an explicit
    number, echoed back in the response, so duplicates can be told apart
    even though their label text is identical.

    Items whose label AND position_hint are both identical (e.g. four
    "picture frame"s all landing in the same coarse position bucket) still
    render as 100%-identical text even with numbering — found in practice
    to make weaker models silently drop one instead of treating it as
    separate (DEVLOG.md 2026-08-07). Those get an explicit "instance X of Y"
    tag so every line is textually unique, not just numerically distinct.

    `start_number` offsets the numbering — used when classify_items() splits
    a large detected_items list into smaller chunks (see llm_max_items_per_call),
    so item numbers stay unique across the whole image rather than each
    chunk restarting at 1.

    Prompt v2 (2026-08-08): added a standing decisiveness instruction,
    independent of `user_context`. `evaluation/scripts/compare_user_context.py`
    found that a "moderate" user_context string with no directional lean at
    all — just an explicit instruction to commit to a confident per-item
    call instead of defaulting to keep — beat both an "aggressive"
    (sell/discard-leaning) and a "conservative" (keep-leaning) framing on
    discard/donate agreement (DEVLOG.md 2026-08-08). That instruction is
    baked in here as a base-prompt line so every request benefits from it,
    including the common case where `user_context` is None, rather than
    requiring a user to type an equivalent framing themselves. Not yet
    re-verified against `compare_llm_reasoning.py`'s numbers — a
    system-prompt version of this instruction isn't guaranteed to
    reproduce the user_context-string version's effect exactly; treat as
    unconfirmed until re-run (see DEVLOG.md).
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
    """One LLM call for a single chunk (<= llm_max_items_per_call items), with
    the existing retry-on-invalid-JSON loop. Returns
    (raw_text, parsed, is_valid, was_repaired, attempts) — was_repaired is
    extract_json_detailed()'s verdict for whichever attempt ultimately
    succeeded (False if every attempt failed outright)."""
    prompt = build_classification_prompt(detected_items, scene_label, user_context, start_number=start_number)

    attempts_allowed = 1 + settings.llm_max_retries
    raw_text = ""
    parsed: dict | list | None = None
    is_valid = False
    was_repaired = False

    for attempt in range(attempts_allowed):
        # Deliberately NOT passing format="json": Ollama's JSON-mode grammar
        # constrains output to a single top-level object, which made every
        # tested model (except deepseek-r1) collapse a requested N-item array
        # into one object regardless of prompt wording — confirmed by testing
        # the same prompt with and without format="json" during §3 step 4.
        # extract_json_detailed()'s existing repair fallback handles any
        # stray prose.
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
    """
    model_name defaults to settings.llm_model_name (deliberately not
    restated as a literal model name here — see this module's docstring;
    that default is config.py's own single source of truth and would
    otherwise drift again) but accepts an override — this is the hook
    evaluation/scripts/compare_llm_reasoning.py uses to run the same call
    across COMPARISON_MODELS.

    Splits detected_items into chunks of at most llm_max_items_per_call —
    a single N-item JSON array gets more fragile as N grows (one dropped
    key breaks the whole response; found via a real 28-item detection set
    failing even after retries). Each chunk is its own LLM call with its
    own retry loop; results are merged back into one LLMResult so callers
    don't need to know chunking happened at all.

    Also verifies completeness per chunk: a response can be syntactically
    valid JSON, correctly shaped, and still silently missing an item — found
    in practice on real detections, where two same-label items sharing a
    coarse position bucket sometimes causes one to just vanish with no
    error (DEVLOG.md 2026-08-07). Any missing item_number — whether because
    it was dropped from an otherwise-valid chunk response, or because the
    whole chunk call failed validity outright (every item in it treated as
    "missing") — gets one targeted single-item recovery call (its own retry
    budget) rather than being silently dropped or forcing the whole chunk
    to be redone. A whole-chunk failure still marks the overall result
    is_valid_json=False even if every one of its items is later recovered
    individually — the original call needed rescuing, which is worth
    surfacing honestly rather than papering over (DEVLOG.md 2026-08-07).
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
    # item_number -> low-level provenance, populated for every expected
    # item_number across the whole call (every chunk plus every missing-
    # item recovery below) — see LLMResult.item_provenance's own
    # docstring for why this is a hint, not the authoritative validity.
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
                    # bool is an int subclass — excluded explicitly, same
                    # convention as core/id_mapping.map_item_numbers.
                    if isinstance(n, int) and not isinstance(n, bool) and n in expected_numbers:
                        returned_numbers.add(n)
                        item_provenance[n] = (
                            ItemValidity.MECHANICALLY_REPAIRED if was_repaired else ItemValidity.RAW_VALID
                        )
            else:
                # The whole chunk call failed validity — every item in it is
                # "missing" and gets its own recovery attempt below, same as
                # an item silently dropped from an otherwise-valid response.
                # Previously this branch gave up on the chunk entirely with
                # no recovery attempt at all (DEVLOG.md 2026-08-07).
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
