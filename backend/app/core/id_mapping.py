"""
Pure logic: map an LLM response's item_number values onto this run's
item_id values, and flag every way that mapping can fail — missing,
duplicated, malformed, or unexpected item numbers — rather than silently
dropping, misattributing, or arbitrarily picking-a-winner for an item. No
model calls here; app/models/mistral_llm.py passes parsed responses into
this function.

Deliberately decision-content-agnostic: this stage only resolves identity
(item_number -> item_id). Whether the returned `decision` string is one of
the four legal values, and whether `reason` is non-empty, is a separate
concern — see core/semantic_conversion.py, which turns a successfully
mapped item into a validated AiDecision. Not duplicated here.
"""

from __future__ import annotations

from collections import defaultdict

from app.core.schemas import (
    ItemNumberMappingResult,
    MappedLLMItem,
    MappingWarning,
    MappingWarningKind,
)


def map_item_numbers(raw_items: list[dict], number_to_id: dict[int, str]) -> ItemNumberMappingResult:
    """
    raw_items: freshly-parsed LLM response elements (e.g. from
    json_repair.extract_json) — not yet trusted to have the right shape.
    number_to_id: this call's expected {item_number: item_id} mapping —
    for a chunked LLM call (see mistral_llm.classify_items), this is the
    chunk's own expected numbers, not necessarily the whole image's.

    Duplicate item_numbers are treated as invalid, not resolved by "first
    occurrence wins": if an expected item_number appears more than once,
    NEITHER occurrence is exposed in `mapped` — there's no way to know
    which one is correct, and silently preferring one would hide a real
    model failure. The item_number is reported as DUPLICATE and is
    implicitly eligible for recovery (it's absent from `mapped`, exactly
    like a MISSING item — a caller can compute the recovery set as
    `set(number_to_id) - {m.item_number for m in result.mapped}`).

    See ItemNumberMappingResult.is_complete for the single boolean that
    tells a caller whether every requested item_number was safely
    resolved, so a partial mapping can never be mistaken for a full one.
    """
    # First pass: bucket every raw element that names a real, requested
    # item_number, so duplicates can be detected before anything is
    # committed to `mapped`. Anything that can't even be read as a
    # requested item_number is flagged immediately and never bucketed.
    candidates: dict[int, list[dict]] = defaultdict(list)
    warnings: list[MappingWarning] = []

    for raw in raw_items:
        if not isinstance(raw, dict):
            warnings.append(
                MappingWarning(
                    kind=MappingWarningKind.MALFORMED,
                    item_number=None,
                    detail=f"response element is not an object: {raw!r}",
                )
            )
            continue

        n = raw.get("item_number")
        if not isinstance(n, int) or isinstance(n, bool):
            warnings.append(
                MappingWarning(
                    kind=MappingWarningKind.MALFORMED,
                    item_number=None,
                    detail=f"missing or non-integer item_number: {n!r}",
                )
            )
            continue

        if n not in number_to_id:
            warnings.append(
                MappingWarning(
                    kind=MappingWarningKind.UNEXPECTED,
                    item_number=n,
                    detail=f"item_number {n} was not requested in this call",
                )
            )
            continue

        candidates[n].append(raw)

    # Second pass: an item_number with exactly one candidate maps cleanly;
    # more than one is unresolvable ambiguity, not a pick-one situation.
    mapped: list[MappedLLMItem] = []
    duplicated_numbers: set[int] = set()

    for n, entries in candidates.items():
        if len(entries) > 1:
            duplicated_numbers.add(n)
            warnings.append(
                MappingWarning(
                    kind=MappingWarningKind.DUPLICATE,
                    item_number=n,
                    detail=(
                        f"item_number {n} appeared {len(entries)} times; "
                        "none mapped, eligible for recovery"
                    ),
                )
            )
            continue

        raw = entries[0]
        mapped.append(
            MappedLLMItem(
                item_number=n,
                item_id=number_to_id[n],
                label=raw.get("label"),
                decision=raw.get("decision"),
                reason=raw.get("reason"),
            )
        )

    resolved_numbers = {m.item_number for m in mapped}
    for missing_n in sorted(set(number_to_id) - resolved_numbers - duplicated_numbers):
        warnings.append(
            MappingWarning(
                kind=MappingWarningKind.MISSING,
                item_number=missing_n,
                detail=f"expected item_number {missing_n} was not present in the response",
            )
        )

    mapped.sort(key=lambda m: m.item_number)
    return ItemNumberMappingResult(mapped=mapped, warnings=warnings)
