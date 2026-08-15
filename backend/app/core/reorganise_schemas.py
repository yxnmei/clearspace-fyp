"""
Pure core domain schemas for the Reorganise plan — content only.

Deliberately excludes: PlanProvenance as a field (assigned later, by
app/services/reorganise_service.py — not yet implemented, R2 — never by
this module or by raw LLM output); model name/prompt version (service-
level identity, not plan content); bytes/base64/HTTP-transport fields
(those belong to app/api/schemas.py once route integration exists, R4).
This keeps the dependency direction intact: app/core must never import
app/services (DeclutterResult lives in app/services/declutter_service.py,
so anything that needs it — DirectReorganisePayload/BothReorganisePayload
— cannot live here either; that is R4's concern, not this module's).

Reuses ItemId/NonEmptyStr from app.core.schemas rather than redefining
them — one shared identity vocabulary, not a second one drifting
alongside it. item_id is the only identity ReorganiseZone ever carries;
nothing here reads or compares label text (see
reorganise_semantic_conversion.py's own docstring for where and why that
rule is enforced).
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, model_validator

from app.core.schemas import ItemId, NonEmptyStr

# Naming convention for a zone holding items that don't need to move —
# see reorganise_semantic_conversion.build_deterministic_fallback_plan(),
# which always uses exactly this zone. A real LLM-produced plan is free
# to use it too, but nothing here requires that; the zone's meaning comes
# entirely from its name and instruction text, not from special-cased
# schema behavior.
KEEP_IN_PLACE_ZONE_NAME = "Keep in place"


class PlanProvenance(str, Enum):
    """How a ReorganisePlan was actually produced — assigned by the
    service (app/services/reorganise_service.py, R2), never by this
    module, never accepted as part of raw LLM plan content, and never a
    field on ReorganisePlan itself (see that class's own docstring below).
    This is a shared vocabulary type only; placing it here (core) while
    only ever being assigned by service-level orchestration mirrors
    ItemValidity's own existing placement/assignment split in
    app/core/schemas.py + app/services/declutter_service.py exactly."""

    RAW_VALID = "raw_valid"
    MECHANICALLY_REPAIRED = "mechanically_repaired"
    RECOVERY_USED = "recovery_used"
    DETERMINISTIC_FALLBACK = "deterministic_fallback"


class ReorganiseZone(BaseModel):
    """One named grouping of selected items in the reorganisation plan.
    `item_ids` are the only identity carried here — this class never
    reads, stores, or compares label text.

    extra="forbid": this is LLM-facing content — a raw plan is validated
    directly against this shape (see parse_and_validate_plan()). Without
    this, pydantic's default behavior would silently ignore an
    unrecognised field, which is exactly how a stray "provenance" or
    similar metadata key in raw LLM output could slip through unnoticed
    instead of being rejected as malformed."""

    model_config = ConfigDict(extra="forbid")

    zone_name: NonEmptyStr
    item_ids: list[ItemId]
    instruction: NonEmptyStr

    @model_validator(mode="after")
    def _check_items(self) -> "ReorganiseZone":
        if not self.item_ids:
            raise ValueError(f"zone {self.zone_name!r} must contain at least one item_id")
        if len(self.item_ids) != len(set(self.item_ids)):
            raise ValueError(f"duplicate item_id within zone {self.zone_name!r}")
        return self


class ReorganisePlan(BaseModel):
    """Core plan CONTENT only — see module docstring for what is
    deliberately excluded (provenance, model identity, HTTP/bytes
    fields).

    Self-consistency (this class's own validator: no duplicate/blank zone
    names, no item_id repeated across zones) is a DIFFERENT, narrower
    check than authoritative selected-set completeness — this class has
    no way to know what the authoritative selected-item set even is, so
    it cannot and does not check "every selected item is accounted for."
    That check lives at the parse_and_validate_plan() boundary in
    reorganise_semantic_conversion.py, the only place that actually
    receives the authoritative set.

    extra="forbid": see ReorganiseZone's docstring — this is LLM-facing
    content; PlanProvenance/model identity/etc. must never be smuggled in
    as an unrecognised field rather than rejected outright."""

    model_config = ConfigDict(extra="forbid")

    zones: list[ReorganiseZone]
    image_prompt: NonEmptyStr
    negative_prompt: NonEmptyStr | None = None

    @model_validator(mode="after")
    def _check_self_consistency(self) -> "ReorganisePlan":
        if not self.zones:
            raise ValueError("plan must contain at least one zone")

        seen_names: set[str] = set()
        for zone in self.zones:
            normalized = zone.zone_name.strip().lower()
            if normalized in seen_names:
                raise ValueError(f"duplicate zone_name (case-insensitive): {zone.zone_name!r}")
            seen_names.add(normalized)

        all_item_ids = [item_id for zone in self.zones for item_id in zone.item_ids]
        if len(all_item_ids) != len(set(all_item_ids)):
            raise ValueError("an item_id appears in more than one zone")

        return self
