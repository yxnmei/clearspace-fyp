"""
Pure logic: turns Grounding DINO's raw (possibly compound) labels into
clean item labels. No model loading here — this is exactly the kind of
function tests/unit/ should cover in milliseconds.

Replaces v1's naive first-token extraction: "book notebook magazine
document" was reduced to just "book",
discarding real information. This version is vocabulary-aware — it
checks the compound phrase against a known multi-word item list before
falling back to first-token, and always returns the *discarded* tokens
too so callers can decide whether to keep them (e.g. show "book" as the
primary label but keep "notebook, magazine, document" as detail text).
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
