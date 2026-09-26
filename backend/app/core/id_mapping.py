"""
Map an LLM response's item_number values onto this run's item_id values,
flagging missing, duplicated, malformed and unexpected numbers rather
than dropping, misattributing or picking a winner.

Identity only: item_id comes from the requested number, never from the
returned label, which is never used to match or dedupe. Decision/reason
content is validated separately by semantic_conversion.
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
    raw_items: parsed, untrusted LLM response elements. number_to_id: this
    call's expected numbers (for a chunked call, the chunk's own).

    A duplicated item_number maps NEITHER occurrence: there is no way to
    know which is correct. Like a missing one, it is absent from `mapped`
    and so eligible for recovery. Use ItemNumberMappingResult.is_complete
    so a partial mapping is never mistaken for a full one.
    """
    # First pass: bucket by requested item_number so duplicates are found
    # before anything is committed to `mapped`.
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
