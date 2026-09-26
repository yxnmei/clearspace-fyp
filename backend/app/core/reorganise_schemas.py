"""
Content schemas for the zone-based Reorganise plan.

ReorganisePlan/ReorganiseZone are the research path only; production uses
the deterministic checklist (provenance deterministic_direct).
PlanProvenance is shared vocabulary for both.

Provenance, model identity and transport fields are deliberately not plan
content. app/core never imports app/services, so payloads that need
DeclutterResult live in the services layer. item_id is the only identity
a zone carries; label text is never compared.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, model_validator

from app.core.schemas import ItemId, NonEmptyStr

# Zone name used by the deterministic fallback plan; a naming convention,
# not special-cased schema behaviour.
KEEP_IN_PLACE_ZONE_NAME = "Keep in place"


class PlanProvenance(str, Enum):
    """How a plan was produced. Assigned by the service layer, never
    accepted from model output and never a field on ReorganisePlan."""

    RAW_VALID = "raw_valid"
    MECHANICALLY_REPAIRED = "mechanically_repaired"
    RECOVERY_USED = "recovery_used"
    DETERMINISTIC_FALLBACK = "deterministic_fallback"
    # Production: no model call at all, by policy. Distinct from
    # DETERMINISTIC_FALLBACK, which means planner attempts ran and were
    # rejected. The 2026-08-20 planner screen found no model able to
    # produce a valid 28-item plan (backend/evaluation/README.md).
    DETERMINISTIC_DIRECT = "deterministic_direct"


class ReorganiseZone(BaseModel):
    """One named grouping of selected items, identified by item_id only.

    extra="forbid": raw model output is validated directly against this
    shape, so a stray key such as "provenance" is rejected rather than
    silently ignored."""

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
    """Plan content only (extra="forbid", as for ReorganiseZone).

    Validates self-consistency only. Completeness against the selected
    set is checked by parse_and_validate_plan(), the only place that
    receives that set."""

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
