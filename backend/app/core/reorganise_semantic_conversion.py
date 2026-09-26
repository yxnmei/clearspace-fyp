"""
Pure logic: convert a raw (already-JSON-parsed, not-yet-trusted) plan
object into a validated ReorganisePlan, checked against the authoritative
selected-item set — and build a fully deterministic fallback plan when
that conversion isn't possible.

Never identifies items by label anywhere in this module: both
parse_and_validate_plan()'s accounting and build_deterministic_fallback_
plan()'s zone construction work entirely from item_id. Two DetectedItems
that happen to share a label (e.g. two "picture frame"s) are always
tracked independently by their distinct item_ids — the same discipline
already established for detection/decision identity elsewhere in this
codebase (id_mapping.py, instance_matching.py).

No orchestration here: this module does not decide whether to retry an
LLM call or when to fall back — app/services/reorganise_service.py calls
parse_and_validate_plan() once per attempt and
build_deterministic_fallback_plan() only after every attempt it's willing
to make has failed. This module only ever answers "is this one raw
object, on its own, a valid, complete plan" and "here is a deterministic
plan built directly from data, no model involved."
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints, TypeAdapter, ValidationError, computed_field, model_validator

from app.core.reorganise_schemas import KEEP_IN_PLACE_ZONE_NAME, ReorganisePlan, ReorganiseZone
from app.core.schemas import DetectedItem, ItemId

_MAX_DETAIL_LENGTH = 500  # bounded, matching this codebase's existing detail-truncation convention
_TRUNCATION_SUFFIX = "…(truncated)"

# Bounded, non-empty detail string — NonEmptyStr plus an explicit
# max_length, enforced at the schema level (not just by _bounded()'s own
# truncation) so a PlanConversionError can never be constructed with an
# over-length detail regardless of caller.
_BoundedDetail = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_MAX_DETAIL_LENGTH)]

PlanConversionErrorKind = Literal["malformed_plan", "missing_selected_items", "unexpected_items"]

# Validates a single item_id through the SAME shared ItemId type
# DetectedItem/AiDecision/etc. already use — no second, hand-written
# regex to drift out of sync with it. Reused (module-level, built once)
# rather than constructing a fresh TypeAdapter per call.
_ITEM_ID_ADAPTER: TypeAdapter[str] = TypeAdapter(ItemId)


def _bounded(text: str, limit: int = _MAX_DETAIL_LENGTH) -> str:
    """Returned length never exceeds `limit`, INCLUDING the truncation
    suffix — the previous version appended the suffix after slicing to
    `limit`, which could exceed it by the suffix's own length."""
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(_TRUNCATION_SUFFIX))
    return text[:keep] + _TRUNCATION_SUFFIX


class PlanConversionError(BaseModel):
    """One structured reason a raw plan was not trusted. `item_ids` is
    populated for missing_selected_items/unexpected_items (the specific
    ids involved); must be empty for malformed_plan, which has no
    specific ids to report — the raw object couldn't even be read as a
    plan. Both rules (and no-duplicates) are enforced below, not merely
    documented, so a caller can never construct a self-contradictory
    error."""

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
    """Only two states are constructible: (plan present, errors empty) —
    valid — or (plan None, errors non-empty) — invalid. `is_valid` stays
    a computed convenience, but it is backed by this enforced invariant,
    not merely interpreting whatever contradictory data happened to be
    passed in."""

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
    """selected_item_ids is authoritative SERVICE input, not model
    output — a caller/programmer contract, not something an LLM response
    could ever influence. Violations here are ValueErrors, never disguised
    as a PlanConversionResult/malformed_plan (that would misleadingly
    suggest the LLM's output was at fault).

    Order matters: the outer shape (list, non-empty) is checked first,
    THEN every element is validated/normalized through the shared ItemId
    type, and only once every element is confirmed to be a real string
    does duplicate detection (which hashes each element) run. Checking
    duplicates before per-element validation was the original bug here —
    an unhashable element (e.g. a nested list or dict) reached `set(...)`
    before ever being checked, raising a raw TypeError instead of a clear
    ValueError identifying selected_item_ids as the problem.
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
    Attempts to construct a ReorganisePlan from `raw` (already-parsed
    JSON — a dict, or garbage: a list/str/number/None/anything else) and
    checks it against `selected_item_ids`. Raises ValueError only for
    malformed selected_item_ids (a caller error); every problem with
    `raw` itself is returned as a structured PlanConversionError, never
    raised, and never a raw traceback.

    Exact accounting: the union of every zone's item_ids must equal
    selected_item_ids exactly — an id missing from that union is
    `missing_selected_items`; an id present that wasn't selected is
    `unexpected_items`. Both may be reported together. Neither is
    silently tolerated or partially accepted — either the plan is fully
    trusted (`is_valid`) or `plan` is None and every problem is listed.
    Source ordering of `raw`'s zones/items never affects this — the
    accounting is set-based, not order-based.
    """
    selected = _validate_selected_item_ids(selected_item_ids)

    try:
        plan = ReorganisePlan.model_validate(raw)
    except ValidationError as exc:
        # The one expected data-validation failure mode for malformed raw
        # LLM output — dict-shaped-but-wrong, or not dict-shaped at all
        # (a list/str/number/None all fail pydantic's own model-shape
        # check with a ValidationError, never a bare TypeError/AttributeError;
        # see test_raw_list_string_number_none_fail_cleanly_without_raw_exceptions).
        # Deliberately NOT a broad `except Exception` — an unexpected
        # INTERNAL exception (a genuine programming defect) must stay
        # loud, not be silently mislabeled as "bad LLM output".
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
    Pure and fully deterministic given the same inputs — no LLM call, no
    randomness, no wall-clock/run_id dependence. Intended for
    app/services/reorganise_service.py to call only after both the
    raw planning call and one bounded recovery attempt fail
    parse_and_validate_plan() — this function has no opinion about
    PlanProvenance at all (it never sets or references it); assigning
    PlanProvenance.DETERMINISTIC_FALLBACK is the service's job, not
    this function's.

    Takes full DetectedItem objects, not bare ids: an image-generation
    prompt needs effective_label (respecting any user label correction —
    see DetectedItem.effective_label's own docstring) and spatial context
    (position/relative_size), neither of which a bare item_id carries.

    Raises ValueError — never AttributeError/TypeError — on invalid
    caller input: selected_items not a non-empty list, an element that
    isn't a DetectedItem, a duplicate item_id among them, a non-string or
    blank scene_label, or a user_context that's neither None nor a
    string. Every field access and `.strip()` call below happens only
    after these checks pass, so a malformed caller input can never reach
    them. This function does NOT silently tolerate bad input; only a
    genuinely valid selection produces a plan.

    Whitespace-only user_context (e.g. "   ") is valid input — it is
    deliberately treated the same as an absent (None) context, never
    surfaced in the prompt; see the check below and
    test_fallback_whitespace_only_user_context_is_treated_as_absent.
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
