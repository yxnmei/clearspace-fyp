"""
Deterministic coarse photo areas (left / centre / right) for a Reorganise
result, derived entirely from each item's detector `position` descriptor.

An area says where selected items are concentrated in the photo, NOT how
cluttered or important that part of the room is; it is not a floor plan.
At most MAX_FOCUS_AREAS, highest count first, ties in fixed area order.

`item_ids` carries item_id only; labels never enter this module.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.schemas import DetectedItem, ItemId, NonEmptyStr

MAX_FOCUS_AREAS = 3

FocusAreaId = Literal["left", "centre", "right", "other"]

# Fixed display labels and the tie-break order. "other" only ever appears
# for a position descriptor outside box_descriptors' known vocabulary; it
# is kept rather than dropped so no selected item silently disappears
# from the summary.
FOCUS_AREA_LABELS: dict[str, str] = {
    "left": "Left side",
    "centre": "Centre",
    "right": "Right side",
    "other": "Other areas",
}
_AREA_ORDER: tuple[str, ...] = ("left", "centre", "right", "other")


class FocusArea(BaseModel):
    """One coarse area of the photo and the selected items detected in
    it. Frozen and extra="forbid": no coordinate, severity, score or
    generated text can be attached."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    area_id: FocusAreaId
    label: NonEmptyStr
    item_ids: list[ItemId] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_unique_ids(self) -> "FocusArea":
        if len(self.item_ids) != len(set(self.item_ids)):
            raise ValueError("item_ids contains duplicates")
        return self


def area_id_for_position(position: str) -> FocusAreaId:
    """Maps a detector position descriptor to its horizontal band. Word-
    based so "upper-left", "left" and "lower-left" all land on "left";
    "upper-center", "center" and "lower-center" on "centre". Anything
    without a recognised horizontal word is "other"."""
    words = set(position.lower().replace("-", " ").replace("_", " ").split())
    if "left" in words:
        return "left"
    if "right" in words:
        return "right"
    if "center" in words or "centre" in words:
        return "centre"
    return "other"


def _validate_selected_items(selected_items: Any) -> None:
    if not isinstance(selected_items, list) or not selected_items:
        raise ValueError("selected_items must be a non-empty list")
    for index, item in enumerate(selected_items):
        if not isinstance(item, DetectedItem):
            raise ValueError(f"selected_items[{index}] must be a DetectedItem, got {type(item).__name__}")
    ids = [item.item_id for item in selected_items]
    if len(ids) != len(set(ids)):
        raise ValueError("selected_items contains a duplicate item_id")


def group_items_by_area(selected_items: list[DetectedItem]) -> list[tuple[FocusAreaId, list[DetectedItem]]]:
    """The uncapped grouping behind derive_focus_areas(), items in input
    order within an area. The deterministic checklist uses it directly so
    its "busiest area" matches."""
    _validate_selected_items(selected_items)

    by_area: dict[str, list[DetectedItem]] = {}
    for item in selected_items:
        by_area.setdefault(area_id_for_position(item.position), []).append(item)

    return sorted(
        by_area.items(),
        key=lambda entry: (-len(entry[1]), _AREA_ORDER.index(entry[0])),
    )


def derive_focus_areas(selected_items: list[DetectedItem]) -> list[FocusArea]:
    """
    One to MAX_FOCUS_AREAS areas. Raises ValueError (never
    AttributeError/TypeError) for malformed input. A selection all in one
    band yields one area; that is truthful, not a defect.
    """
    grouped = group_items_by_area(selected_items)
    return [
        FocusArea(area_id=area_id, label=FOCUS_AREA_LABELS[area_id], item_ids=[item.item_id for item in items])
        for area_id, items in grouped[:MAX_FOCUS_AREAS]
    ]
