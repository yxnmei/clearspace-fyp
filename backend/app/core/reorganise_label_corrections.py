"""
Pure logic: Direct Reorganise label corrections.

On Direct Reorganise's Select items screen the user may correct a detected
item's label ("cable", not "rope"). Unlike Declutter's /override, a
correction here reruns no model: it only changes the label the
deterministic derivations read (tidy plan, legacy checklist, storage
suggestions, image prompt), all of which already read
DetectedItem.effective_label.

A correction arrives as its own explicit, validated request field, never
as an edited analysis object. apply_label_corrections() returns a NEW
AnalysisResult whose corrected items carry `corrected_label`; the
caller's analysis is never mutated, and each item's clean_label /
raw_phrase stay exactly what the detector produced, so provenance
(label_source == "user", the original clean_label) is preserved.

Identity is item_id only. Two items sharing a label are corrected
independently; a correction never matches, merges or deduplicates by
label text.
"""

from __future__ import annotations

import unicodedata
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, StringConstraints, field_validator

from app.core.schemas import AnalysisResult, DetectedItem, ItemId

# The label is display text and prompt text (it reaches the image prompt
# line by line), so it is bounded and single-line.
MAX_CORRECTED_LABEL_LENGTH = 80

CorrectedLabel = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_CORRECTED_LABEL_LENGTH)
]


class LabelCorrectionError(ValueError):
    """Malformed corrections: not a list, a non-correction entry, a
    duplicate item_id, or an item_id not present in the analysis."""


class ReorganiseLabelCorrection(BaseModel):
    """One user label correction, keyed by item_id. The label is trimmed,
    1..MAX_CORRECTED_LABEL_LENGTH characters, and contains no control
    characters (so it cannot break the one-item-per-line image prompt)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    item_id: ItemId
    corrected_label: CorrectedLabel

    @field_validator("corrected_label")
    @classmethod
    def _reject_control_characters(cls, value: str) -> str:
        if any(unicodedata.category(char) == "Cc" for char in value):
            raise ValueError("corrected_label must not contain control characters")
        return value


def validate_label_corrections(analysis: AnalysisResult, corrections: Any) -> list[ReorganiseLabelCorrection]:
    """Rejects a non-list, a non-ReorganiseLabelCorrection entry, a
    duplicate item_id, or an item_id absent from analysis.items. Never
    silently drops or deduplicates anything."""
    if not isinstance(corrections, list):
        raise LabelCorrectionError(f"label_corrections must be a list, got {type(corrections).__name__}")
    for index, correction in enumerate(corrections):
        if not isinstance(correction, ReorganiseLabelCorrection):
            raise LabelCorrectionError(f"label_corrections[{index}] must be a ReorganiseLabelCorrection")

    ids = [correction.item_id for correction in corrections]
    if len(ids) != len(set(ids)):
        raise LabelCorrectionError("label_corrections contains a duplicate item_id")

    known = {item.item_id for item in analysis.items}
    unknown = sorted(set(ids) - known)
    if unknown:
        raise LabelCorrectionError(f"label_corrections references unknown item_id(s): {unknown}")
    return corrections


def apply_label_corrections(analysis: AnalysisResult, corrections: Any) -> AnalysisResult:
    """Returns a new AnalysisResult with each corrected item's
    corrected_label set; every other item, and item order, unchanged. The
    input analysis is not modified. An empty list returns an equal copy."""
    validated = validate_label_corrections(analysis, corrections)
    by_id = {correction.item_id: correction.corrected_label for correction in validated}

    items: list[DetectedItem] = []
    for item in analysis.items:
        if item.item_id in by_id:
            data = item.model_dump(exclude={"label_source", "effective_label"})
            data["corrected_label"] = by_id[item.item_id]
            items.append(DetectedItem.model_validate(data))
        else:
            items.append(item)
    return analysis.model_copy(update={"items": items})
