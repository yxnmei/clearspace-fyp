"""
Pure logic: deterministic "Areas to focus on" for a Reorganise result.

An area is a coarse horizontal band of the photo (left / centre / right),
derived ENTIRELY from the `position` descriptor the detector stage already
attached to every item (app/core/box_descriptors.py: "upper-left",
"center", "lower-right", ...). Nothing here is inferred, measured or
generated: an area is the set of selected items whose position falls in
that band, ordered by how many selected items it holds. It says where the
selected items are concentrated in the photo — NOT how cluttered, messy
or important that part of the room is, and it is not a floor plan.

Bounds: at most MAX_FOCUS_AREAS areas are returned, highest count first,
ties broken by the fixed left / centre / right / other order so the
output is fully deterministic for the same input. Every returned area
holds at least one item and every item_id appears in at most one area.

Identity discipline: `item_ids` carries item_id only. Labels never enter
this module at all.
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
    """The uncapped grouping behind derive_focus_areas(): every area that
    holds at least one item, sorted by item count descending then by the
    fixed area order. Items keep their input order within an area. The
    deterministic checklist fallback (app.core.reorganise_actions) uses
    this directly so its "busiest area" is the same one the summary
    shows first."""
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
    Pure and deterministic. Raises ValueError (never AttributeError or
    TypeError) for an empty or non-list selection, a non-DetectedItem
    entry, or a duplicate item_id.

    Returns between one and MAX_FOCUS_AREAS areas, highest selected-item
    count first. A selection whose items all share one band yields one
    area; that is the truthful answer, not a defect.
    """
    grouped = group_items_by_area(selected_items)
    return [
        FocusArea(area_id=area_id, label=FOCUS_AREA_LABELS[area_id], item_ids=[item.item_id for item in items])
        for area_id, items in grouped[:MAX_FOCUS_AREAS]
    ]
