"""
Pure logic: convert successfully mapped LLM items (MappedLLMItem, from
core/id_mapping.map_item_numbers) into validated AiDecision objects.

This is the content-validation boundary that id_mapping.py deliberately
does not do — id_mapping resolves identity only (item_number -> item_id)
and leaves label/decision/reason as raw, unvalidated strings. This module
enforces the decision enum, requires a non-empty reason, and requires a
real item_id, by construction: it delegates to AiDecision's own field
types (Decision, NonEmptyStr) rather than re-implementing the same checks
a second time. Failures are collected and returned structured, not raised
per-item and not silently dropped — so a future caller (the LLM wrapper,
app/models/mistral_llm.py, not yet updated) doesn't have to remember to
instantiate AiDecision correctly by hand for every item.
"""

from __future__ import annotations

from pydantic import BaseModel, ValidationError, computed_field

from app.core.schemas import AiDecision, MappedLLMItem


class SemanticConversionError(BaseModel):
    """One MappedLLMItem that failed content validation — invalid decision
    value, missing/blank reason, or any other AiDecision field violation.
    `detail` carries pydantic's own validation error text; it isn't
    reparsed or summarised, so nothing about *why* it failed is lost."""

    item_number: int
    item_id: str
    detail: str


class SemanticConversionResult(BaseModel):
    ai_decisions: list[AiDecision]
    errors: list[SemanticConversionError]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_complete(self) -> bool:
        """True iff every MappedLLMItem passed in converted cleanly — no
        invalid decisions, no missing/blank reasons. Same purpose as
        ItemNumberMappingResult.is_complete: a caller can't accidentally
        treat a partially-converted batch as fully successful just
        because `ai_decisions` is non-empty."""
        return len(self.errors) == 0


def convert_mapped_items_to_ai_decisions(mapped_items: list[MappedLLMItem]) -> SemanticConversionResult:
    """
    For each mapped item, attempts to construct an AiDecision — which by
    itself enforces: `decision` must be one of keep/sell/donate/discard
    (Decision enum; None or any other string fails), `reason` must be a
    non-empty string after trimming (None, "", or "   " all fail), and
    `item_id` must be a real item_id (already guaranteed by MappedLLMItem,
    re-checked here for free since AiDecision uses the same ItemId type).
    Order of `ai_decisions`/`errors` follows the order of `mapped_items`.
    """
    ai_decisions: list[AiDecision] = []
    errors: list[SemanticConversionError] = []

    for item in mapped_items:
        try:
            ai_decisions.append(
                AiDecision(item_id=item.item_id, decision=item.decision, reason=item.reason)
            )
        except ValidationError as exc:
            errors.append(
                SemanticConversionError(
                    item_number=item.item_number,
                    item_id=item.item_id,
                    detail=str(exc),
                )
            )

    return SemanticConversionResult(ai_decisions=ai_decisions, errors=errors)
