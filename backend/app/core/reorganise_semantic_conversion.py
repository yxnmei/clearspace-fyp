"""
Convert a raw (parsed, untrusted) zone-plan object into a validated
ReorganisePlan checked against the authoritative selected-item set, and
build a deterministic fallback plan when that fails.

Research path only: the zone planner is not used in production, where the
deterministic checklist runs (provenance deterministic_direct).

Items are identified by item_id only, never by label: two items sharing a
label (e.g. two "picture frame"s) are always tracked independently.

No orchestration: retry and fallback decisions belong to the research
service; this module only judges one raw object and builds one
model-free plan.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints, TypeAdapter, ValidationError, computed_field, model_validator

from app.core.reorganise_schemas import KEEP_IN_PLACE_ZONE_NAME, ReorganisePlan, ReorganiseZone
from app.core.schemas import DetectedItem, ItemId

_MAX_DETAIL_LENGTH = 500
_TRUNCATION_SUFFIX = "…(truncated)"

# Enforced at the schema level too, so no caller can construct a
# PlanConversionError with an over-length detail.
_BoundedDetail = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_MAX_DETAIL_LENGTH)]

PlanConversionErrorKind = Literal["malformed_plan", "missing_selected_items", "unexpected_items"]

# The shared ItemId type, so there is no second id regex to drift.
_ITEM_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(ItemId)


def _bounded(text: str, limit: int = _MAX_DETAIL_LENGTH) -> str:
    """Truncate so the result, including the suffix, never exceeds `limit`."""
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(_TRUNCATION_SUFFIX))
    return text[:keep] + _TRUNCATION_SUFFIX


class PlanConversionError(BaseModel):
    """One structured reason a raw plan was not trusted. malformed_plan
    carries no item_ids (the object could not be read as a plan)."""

    kind: PlanConversionErrorKind
    detail: _BoundedDetail
    item_ids: list[ItemId] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_item_ids_consistency(self) -> "PlanConversionError":
        if len(self.item_ids) != len(set(self.item_ids)):
            raise ValueError("item_ids contains duplicates")
        if self.kind == "malformed_plan" and self.item_ids:
            raise ValueError("malformed_plan errors must not carry item_ids")
        if self.kind in ("missing_selected_items", "unexpected_items") and not self.item_ids:
            raise ValueError(f"{self.kind} errors must carry at least one item_id")
        return self


class PlanConversionResult(BaseModel):
    """Exactly one of: a plan with no errors, or no plan with errors."""

    plan: ReorganisePlan | None
    errors: list[PlanConversionError]

    @model_validator(mode="after")
    def _check_consistency(self) -> "PlanConversionResult":
        if self.plan is not None and self.errors:
            raise ValueError("PlanConversionResult cannot have both a plan and errors")
        if self.plan is None and not self.errors:
            raise ValueError("PlanConversionResult must have at least one error when plan is None")
        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_valid(self) -> bool:
        return self.plan is not None and not self.errors


def _validate_selected_item_ids(selected_item_ids: Any) -> set[str]:
    """selected_item_ids is caller input, not model output, so violations
    raise ValueError rather than being reported as malformed_plan (which
    would wrongly blame the model).

    Elements are validated before duplicate detection because hashing an
    unhashable element (a nested list or dict) would raise a raw TypeError.
    """
    if not isinstance(selected_item_ids, list):
        raise ValueError(f"selected_item_ids must be a list, got {type(selected_item_ids).__name__}")
    if not selected_item_ids:
        raise ValueError("selected_item_ids must be a non-empty list")

    normalized: list[str] = []
    for index, raw_id in enumerate(selected_item_ids):
        try:
            normalized.append(_ITEM_ID_ADAPTER.validate_python(raw_id))
        except ValidationError as exc:
            raise ValueError(f"selected_item_ids[{index}] is not a valid item_id: {raw_id!r} ({exc})") from exc

    if len(normalized) != len(set(normalized)):
        raise ValueError("selected_item_ids contains duplicates")

    return set(normalized)


def parse_and_validate_plan(raw: Any, selected_item_ids: list[ItemId]) -> PlanConversionResult:
    """
    Build a ReorganisePlan from `raw` (any parsed JSON value) and check it
    against `selected_item_ids`. Raises ValueError only for malformed
    selected_item_ids; every problem with `raw` is returned as a
    structured PlanConversionError.

    The union of zone item_ids must equal the selection exactly (set-based,
    order-independent). Missing and unexpected ids may both be reported;
    a plan is either fully trusted or rejected, never partially accepted.
    """
    selected = _validate_selected_item_ids(selected_item_ids)

    try:
        plan = ReorganisePlan.model_validate(raw)
    except ValidationError as exc:
        # Non-dict values also fail as ValidationError. Deliberately not a
        # broad `except Exception`: a programming defect must stay loud,
        # not be mislabelled as bad model output.
        return PlanConversionResult(
            plan=None,
            errors=[PlanConversionError(kind="malformed_plan", detail=_bounded(str(exc)))],
        )

    accounted = {item_id for zone in plan.zones for item_id in zone.item_ids}
    missing = sorted(selected - accounted)
    unexpected = sorted(accounted - selected)

    errors: list[PlanConversionError] = []
    if missing:
        errors.append(
            PlanConversionError(
                kind="missing_selected_items",
                detail=_bounded(f"plan omits {len(missing)} selected item(s): {missing}"),
                item_ids=missing,
            )
        )
    if unexpected:
        errors.append(
            PlanConversionError(
                kind="unexpected_items",
                detail=_bounded(f"plan references {len(unexpected)} unselected item(s): {unexpected}"),
                item_ids=unexpected,
            )
        )

    if errors:
        return PlanConversionResult(plan=None, errors=errors)

    return PlanConversionResult(plan=plan, errors=[])


def build_deterministic_fallback_plan(
    selected_items: list[DetectedItem],
    scene_label: str,
    user_context: str | None = None,
) -> ReorganisePlan:
    """
    Deterministic, model-free plan: every selected item in one keep-in-place
    zone. Assigning the fallback provenance is the caller's job.

    Takes DetectedItems rather than ids because the image prompt needs
    effective_label (honouring user corrections) and position/size.

    Invalid caller input raises ValueError, never AttributeError/TypeError.
    Whitespace-only user_context is treated as absent.
    """
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

    prompt_lines = [
        f"A tidy, well-organised {scene_label.strip()}.",
        "Preserve the room's structure, walls, windows, and furniture layout exactly.",
        "Keep every one of the following selected objects visibly present, only rearranged or straightened:",
    ]
    for item in selected_items:
        line = f"- {item.effective_label}"
        spatial_bits = [bit for bit in (item.relative_size, item.position) if bit]
        if spatial_bits:
            line += f" ({', '.join(spatial_bits)})"
        prompt_lines.append(line)

    if user_context and user_context.strip():
        prompt_lines.append(f"Additional context from the user: {user_context.strip()}")

    image_prompt = "\n".join(prompt_lines)

    instruction = (
        "These items should be preserved exactly as selected while the room's overall organisation "
        "is improved — nothing here should be removed, replaced, or left out."
    )

    zone = ReorganiseZone(zone_name=KEEP_IN_PLACE_ZONE_NAME, item_ids=ids, instruction=instruction)

    return ReorganisePlan(zones=[zone], image_prompt=image_prompt, negative_prompt=None)
