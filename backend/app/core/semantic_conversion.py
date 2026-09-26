"""
Convert mapped LLM items into validated AiDecision objects: the content
boundary after id_mapping's identity-only step. Validation is delegated
to AiDecision's own field types; failures are collected, never raised
per item or silently dropped.

Identity is the item_id already resolved by id_mapping; the returned
label is never used to identify an item.
"""

from __future__ import annotations

from pydantic import BaseModel, ValidationError, computed_field

from app.core.schemas import AiDecision, MappedLLMItem


class SemanticConversionError(BaseModel):
    """One item that failed AiDecision validation; `detail` is pydantic's
    unmodified error text."""

    item_number: int
    item_id: str
    detail: str


class SemanticConversionResult(BaseModel):
    ai_decisions: list[AiDecision]
    errors: list[SemanticConversionError]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_complete(self) -> bool:
        """True iff every item converted, so a partial batch is never
        mistaken for success just because `ai_decisions` is non-empty."""
        return len(self.errors) == 0


def convert_mapped_items_to_ai_decisions(mapped_items: list[MappedLLMItem]) -> SemanticConversionResult:
    """Build an AiDecision per mapped item (enforcing the decision enum
    and a non-blank reason), preserving input order."""
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
