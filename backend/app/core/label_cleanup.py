"""
Turn Grounding DINO's raw, possibly compound labels into clean item
labels.

Plain first-token extraction loses information ("book notebook magazine
document" becomes just "book") and splits real multi-word items, so known
multi-word labels are checked first and the discarded tokens are always
returned for callers to keep as detail text.
"""

from __future__ import annotations

from dataclasses import dataclass

# Known multi-word items that must NOT be split — checked before any
# first-token fallback. Extend as real compound-label cases are found
# in evaluation runs; don't guess ahead of the data.
KNOWN_MULTIWORD_LABELS = {
    "picture frame",
    "remote control",
    "trash can",
    "storage basket",
    "power strip",
    "desk fan",
    "phone charger",
}


@dataclass
class CleanedLabel:
    primary: str
    discarded_tokens: list[str]
    was_compound: bool


def clean_label(raw_label: str) -> CleanedLabel:
    normalized = raw_label.strip().lower()

    for known in KNOWN_MULTIWORD_LABELS:
        if known in normalized:
            remainder = normalized.replace(known, "", 1).split()
            return CleanedLabel(primary=known, discarded_tokens=remainder, was_compound=bool(remainder))

    tokens = normalized.split()
    if len(tokens) <= 1:
        return CleanedLabel(primary=normalized, discarded_tokens=[], was_compound=False)

    return CleanedLabel(primary=tokens[0], discarded_tokens=tokens[1:], was_compound=True)
