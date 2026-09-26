"""Shared Declutter orchestration for API and evaluation callers.

An injected classifier produces decisions for actionable items. A failed main
call is fatal; malformed or untrusted per-item output receives one bounded
recovery attempt, and unresolved item_ids remain explicit rather than being
dropped. Wrapper provenance is evidence, not authoritative validity.
"""

from __future__ import annotations

import time
from typing import Literal, Protocol

from pydantic import BaseModel, computed_field, model_validator

from app.core.id_mapping import map_item_numbers
from app.core.schemas import (
    AiDecision,
    AnalysisResult,
    DetectedItem,
    ItemId,
    ItemValidity,
    MappingWarning,
    NonEmptyStr,
    StageTiming,
)
from app.core.semantic_conversion import SemanticConversionError, convert_mapped_items_to_ai_decisions


class LLMResultLike(Protocol):
    """Structural classifier-result contract used by this service."""

    parsed_json: dict | list | None
    item_provenance: dict[int, ItemValidity]
    raw_text: str
    is_valid_json: bool
    model_name: str
    prompt_version: str


class LLMClassifier(Protocol):
    """Callable contract for Declutter classification."""

    def __call__(
        self,
        run_id: str,
        detected_items: list[dict],
        scene_label: str,
        user_context: str | None,
        model_name: str | None = None,
    ) -> LLMResultLike: ...


class DeclutterReasoningError(RuntimeError):
    """The main bulk classification call failed."""


class ProvenanceWarning(BaseModel):
    """An item whose wrapper provenance was insufficient to trust directly."""

    item_id: ItemId
    item_number: int
    detail: NonEmptyStr


class RecoveryFailure(BaseModel):
    """A bounded, sanitised record of an unsuccessful item recovery."""

    item_id: ItemId
    stage: Literal["call", "mapping", "semantic"]
    exception_type: str | None = None
    detail: NonEmptyStr


class DeclutterResult(BaseModel):
    """Validated decisions and diagnostics for every expected item_id.

    Decisions preserve expected-item order. Missing decisions remain explicit
    in unresolved_item_ids and item_validity. Strict validity additionally
    requires raw-valid output with no warnings, repairs, or recovery failures.
    """

    run_id: NonEmptyStr
    expected_item_ids: list[ItemId]
    ai_decisions: list[AiDecision]
    unresolved_item_ids: list[ItemId]
    item_validity: dict[ItemId, ItemValidity]
    mapping_warnings: list[MappingWarning]
    semantic_errors: list[SemanticConversionError]
    recovery_failures: list[RecoveryFailure]
    provenance_warnings: list[ProvenanceWarning]
    # None only when expected_item_ids is empty (llm_classifier never
    # called — see run_declutter) — never a fabricated model/prompt
    # identity for a call that didn't happen.
    model_name: str | None
    prompt_version: str | None
    stage_timings: list[StageTiming]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_complete(self) -> bool:
        return len(self.unresolved_item_ids) == 0

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_strictly_valid(self) -> bool:
        return (
            self.is_complete
            and all(v == ItemValidity.RAW_VALID for v in self.item_validity.values())
            and not self.mapping_warnings
            and not self.semantic_errors
            and not self.recovery_failures
            and not self.provenance_warnings
        )

    @model_validator(mode="after")
    def _check_internal_consistency(self) -> "DeclutterResult":
        """DeclutterResult is a contract other code (eventually routes,
        the Both-workflow composition, evaluation scripts) will consume
        directly — this validator makes contradictory direct construction
        impossible, not just something run_declutter() happens to avoid
        by construction. Every rule below is already an invariant
        run_declutter() maintains; this is what makes it enforced, not
        merely documented."""
        expected = self.expected_item_ids
        expected_set = set(expected)
        if len(expected) != len(expected_set):
            raise ValueError("expected_item_ids contains duplicates")

        if set(self.item_validity.keys()) != expected_set:
            raise ValueError("item_validity keys must exactly equal expected_item_ids")

        decision_ids = [ai.item_id for ai in self.ai_decisions]
        decision_id_set = set(decision_ids)
        if len(decision_ids) != len(decision_id_set):
            raise ValueError("ai_decisions contains duplicate item_ids")

        unknown_decision_ids = decision_id_set - expected_set
        if unknown_decision_ids:
            raise ValueError(
                f"ai_decisions reference item_ids outside expected_item_ids: {sorted(unknown_decision_ids)}"
            )

        if len(self.unresolved_item_ids) != len(set(self.unresolved_item_ids)):
            raise ValueError("unresolved_item_ids contains duplicates")

        still_invalid_ids = {
            item_id for item_id in expected if self.item_validity.get(item_id) == ItemValidity.STILL_INVALID
        }
        if set(self.unresolved_item_ids) != still_invalid_ids:
            raise ValueError(
                "unresolved_item_ids must exactly equal the expected item_ids with ItemValidity.STILL_INVALID"
            )

        for item_id in expected:
            is_still_invalid = item_id in still_invalid_ids
            has_decision = item_id in decision_id_set
            if is_still_invalid and has_decision:
                raise ValueError(f"STILL_INVALID item {item_id!r} must not have an AiDecision")
            if not is_still_invalid and not has_decision:
                raise ValueError(f"non-STILL_INVALID item {item_id!r} must have exactly one AiDecision")

        expected_order_filtered = [item_id for item_id in expected if item_id in decision_id_set]
        if decision_ids != expected_order_filtered:
            raise ValueError(
                "ai_decisions must follow expected_item_ids order, with unresolved (STILL_INVALID) items omitted"
            )

        return self


def _to_llm_item(item: DetectedItem) -> dict:
    """Build classifier input from the reviewed effective label and box."""
    return {
        "label": item.effective_label,
        "confidence": item.confidence,
        "position_hint": f"{item.relative_size}, {item.position}",
    }


def _targeted_recovery(
    item: DetectedItem,
    scene_label: str,
    user_context: str | None,
    run_id: str,
    llm_classifier: LLMClassifier,
    model_name: str | None,
) -> tuple[AiDecision | None, list[MappingWarning], list[SemanticConversionError], RecoveryFailure | None]:
    """Attempt one-item recovery and map its local number back to item_id."""
    try:
        result = llm_classifier(
            run_id=run_id,
            detected_items=[_to_llm_item(item)],
            scene_label=scene_label,
            user_context=user_context,
            model_name=model_name,
        )
    except Exception as exc:
        detail = f"targeted recovery call raised {type(exc).__name__}: {exc}"[:500]
        return None, [], [], RecoveryFailure(
            item_id=item.item_id, stage="call", exception_type=type(exc).__name__, detail=detail
        )

    mapping = map_item_numbers(
        result.parsed_json if isinstance(result.parsed_json, list) else [], {1: item.item_id}
    )
    if not mapping.mapped:
        detail = "; ".join(w.detail for w in mapping.warnings) or "no usable item_number=1 entry in recovery response"
        return None, mapping.warnings, [], RecoveryFailure(
            item_id=item.item_id, stage="mapping", exception_type=None, detail=detail[:500]
        )

    semantic = convert_mapped_items_to_ai_decisions(mapping.mapped)
    if not semantic.ai_decisions:
        detail = "; ".join(e.detail for e in semantic.errors) or "recovery response failed decision/reason validation"
        return None, mapping.warnings, semantic.errors, RecoveryFailure(
            item_id=item.item_id, stage="semantic", exception_type=None, detail=detail[:500]
        )

    return semantic.ai_decisions[0], mapping.warnings, semantic.errors, None


def run_declutter(
    analysis: AnalysisResult,
    user_context: str | None,
    llm_classifier: LLMClassifier,
    model_name: str | None = None,
) -> DeclutterResult:
    """Classify actionable items, with at most one targeted recovery each.

    ``model_name`` also supports evaluation through the production path.
    With no actionable items, the classifier is not called.
    """
    t0 = time.perf_counter()

    # item_role filtering only — no new actionability heuristic here (see
    # module docstring). Order matches AnalysisResult.items' own
    # documented deterministic spatial ordering.
    expected_items = [item for item in analysis.items if item.item_role == "actionable"]
    number_to_id: dict[int, str] = {n: item.item_id for n, item in enumerate(expected_items, start=1)}
    items_by_number: dict[int, DetectedItem] = {n: item for n, item in enumerate(expected_items, start=1)}

    if not expected_items:
        stage_timings = [
            StageTiming(stage="declutter_llm_classify", duration_ms=(time.perf_counter() - t0) * 1000)
        ]
        return DeclutterResult(
            run_id=analysis.run_id,
            expected_item_ids=[],
            ai_decisions=[],
            unresolved_item_ids=[],
            item_validity={},
            mapping_warnings=[],
            semantic_errors=[],
            recovery_failures=[],
            provenance_warnings=[],
            model_name=None,
            prompt_version=None,
            stage_timings=stage_timings,
        )

    llm_items = [_to_llm_item(item) for item in expected_items]

    try:
        llm_result = llm_classifier(
            run_id=analysis.run_id,
            detected_items=llm_items,
            scene_label=analysis.scene.label,
            user_context=user_context,
            model_name=model_name,
        )
    except Exception as exc:
        raise DeclutterReasoningError(
            f"llm_classifier raised {type(exc).__name__} on the main classification call: {exc}"
        ) from exc

    raw_items = llm_result.parsed_json if isinstance(llm_result.parsed_json, list) else []
    mapping = map_item_numbers(raw_items, number_to_id)
    semantic = convert_mapped_items_to_ai_decisions(mapping.mapped)

    ai_decisions_by_id: dict[str, AiDecision] = {ai.item_id: ai for ai in semantic.ai_decisions}
    item_validity: dict[str, ItemValidity] = {}
    provenance_warnings: list[ProvenanceWarning] = []
    recovery_failures: list[RecoveryFailure] = []
    all_mapping_warnings: list[MappingWarning] = list(mapping.warnings)
    all_semantic_errors: list[SemanticConversionError] = list(semantic.errors)

    trusted_hints = (ItemValidity.RAW_VALID, ItemValidity.MECHANICALLY_REPAIRED, ItemValidity.RECOVERY_USED)

    for n in sorted(number_to_id):
        item_id = number_to_id[n]
        decision = ai_decisions_by_id.get(item_id)
        trusted_validity: ItemValidity | None = None

        if decision is not None:
            hint = llm_result.item_provenance.get(n)
            if hint in trusted_hints:
                trusted_validity = hint
            else:
                # Mapping and semantic validity do not replace trusted provenance.
                provenance_warnings.append(
                    ProvenanceWarning(
                        item_id=item_id,
                        item_number=n,
                        detail=(
                            f"item_number {n} mapped and validated cleanly but carried no trustworthy "
                            f"provenance from the LLM wrapper ({hint!r}); not trusted as raw-valid, "
                            "routed through targeted recovery instead"
                        ),
                    )
                )

        if trusted_validity is not None:
            item_validity[item_id] = trusted_validity
            continue

        recovered, r_warnings, r_errors, r_failure = _targeted_recovery(
            items_by_number[n], analysis.scene.label, user_context, analysis.run_id, llm_classifier, model_name
        )
        all_mapping_warnings.extend(r_warnings)
        all_semantic_errors.extend(r_errors)

        if recovered is not None:
            ai_decisions_by_id[item_id] = recovered
            item_validity[item_id] = ItemValidity.RECOVERY_USED
        else:
            ai_decisions_by_id.pop(item_id, None)  # discard any untrusted first-pass draft
            item_validity[item_id] = ItemValidity.STILL_INVALID
            if r_failure is not None:
                recovery_failures.append(r_failure)

    ordered_item_ids = [number_to_id[n] for n in sorted(number_to_id)]
    final_ai_decisions = [ai_decisions_by_id[item_id] for item_id in ordered_item_ids if item_id in ai_decisions_by_id]
    if len(final_ai_decisions) != len({d.item_id for d in final_ai_decisions}):
        raise AssertionError("internal invariant violated: duplicate item_id in final ai_decisions")

    unresolved_item_ids = [
        item_id for item_id in ordered_item_ids if item_validity[item_id] == ItemValidity.STILL_INVALID
    ]

    stage_timings = [StageTiming(stage="declutter_llm_classify", duration_ms=(time.perf_counter() - t0) * 1000)]

    return DeclutterResult(
        run_id=analysis.run_id,
        expected_item_ids=ordered_item_ids,
        ai_decisions=final_ai_decisions,
        unresolved_item_ids=unresolved_item_ids,
        item_validity=item_validity,
        mapping_warnings=all_mapping_warnings,
        semantic_errors=all_semantic_errors,
        recovery_failures=recovery_failures,
        provenance_warnings=provenance_warnings,
        model_name=llm_result.model_name,
        prompt_version=llm_result.prompt_version,
        stage_timings=stage_timings,
    )


class ReclassifyItemResult(BaseModel):
    """A revalidated analysis/declutter pair after one label correction."""

    analysis: AnalysisResult
    declutter: DeclutterResult


def reclassify_item(
    analysis: AnalysisResult,
    declutter: DeclutterResult,
    item_id: str,
    corrected_label: str,
    user_context: str | None,
    llm_classifier: LLMClassifier,
    model_name: str | None = None,
) -> ReclassifyItemResult:
    """Reclassify one corrected label while preserving item identity and box.

    Other items remain unchanged. The standalone call keeps its own validity
    rather than being labelled as recovery. Its local item number is excluded
    from the original run's number-keyed diagnostics.
    """
    try:
        item_index = next(i for i, it in enumerate(analysis.items) if it.item_id == item_id)
    except StopIteration:
        # Override validation normally makes this an internal invariant.
        raise AssertionError(f"internal invariant violated: item_id {item_id!r} not found in analysis.items") from None

    original_item = analysis.items[item_index]
    corrected_item = DetectedItem(
        item_id=original_item.item_id,
        source_detection_index=original_item.source_detection_index,
        raw_phrase=original_item.raw_phrase,
        clean_label=original_item.clean_label,
        box=original_item.box,
        confidence=original_item.confidence,
        position=original_item.position,
        relative_size=original_item.relative_size,
        item_role=original_item.item_role,
        item_role_source=original_item.item_role_source,
        corrected_label=corrected_label,
    )

    decision: AiDecision | None = None
    validity = ItemValidity.STILL_INVALID
    failure: RecoveryFailure | None = None
    provenance_warning: ProvenanceWarning | None = None

    try:
        result = llm_classifier(
            run_id=analysis.run_id,
            detected_items=[_to_llm_item(corrected_item)],
            scene_label=analysis.scene.label,
            user_context=user_context,
            model_name=model_name,
        )
    except Exception as exc:
        detail = f"reclassification call raised {type(exc).__name__}: {exc}"[:500]
        failure = RecoveryFailure(item_id=item_id, stage="call", exception_type=type(exc).__name__, detail=detail)
    else:
        mapping = map_item_numbers(
            result.parsed_json if isinstance(result.parsed_json, list) else [], {1: item_id}
        )
        if not mapping.mapped:
            detail = (
                "; ".join(w.detail for w in mapping.warnings)
                or "no usable item_number=1 entry in the reclassification response"
            )
            failure = RecoveryFailure(item_id=item_id, stage="mapping", detail=detail[:500])
        else:
            semantic = convert_mapped_items_to_ai_decisions(mapping.mapped)
            if not semantic.ai_decisions:
                detail = (
                    "; ".join(e.detail for e in semantic.errors)
                    or "reclassification response failed decision/reason validation"
                )
                failure = RecoveryFailure(item_id=item_id, stage="semantic", detail=detail[:500])
            else:
                candidate = semantic.ai_decisions[0]
                hint = result.item_provenance.get(1)
                trusted_hints = (ItemValidity.RAW_VALID, ItemValidity.MECHANICALLY_REPAIRED, ItemValidity.RECOVERY_USED)
                if hint in trusted_hints:
                    decision = candidate
                    validity = hint
                else:
                    # Mapping and semantic validity do not replace trusted provenance.
                    provenance_warning = ProvenanceWarning(
                        item_id=item_id,
                        item_number=1,
                        detail=(
                            "reclassification mapped and validated cleanly but carried no trustworthy "
                            f"provenance from the LLM wrapper ({hint!r}); not trusted"
                        ),
                    )

    new_items = list(analysis.items)
    new_items[item_index] = corrected_item
    new_analysis = AnalysisResult(
        run_id=analysis.run_id,
        scene=analysis.scene,
        items=new_items,
        warnings=analysis.warnings,
        stage_timings=analysis.stage_timings,
    )

    ai_decisions_by_id = {ai.item_id: ai for ai in declutter.ai_decisions}
    if decision is not None:
        ai_decisions_by_id[item_id] = decision
    else:
        ai_decisions_by_id.pop(item_id, None)

    new_item_validity = dict(declutter.item_validity)
    new_item_validity[item_id] = validity

    new_unresolved_item_ids = [
        i for i in declutter.expected_item_ids if new_item_validity.get(i) == ItemValidity.STILL_INVALID
    ]
    new_ai_decisions = [
        ai_decisions_by_id[i] for i in declutter.expected_item_ids if i in ai_decisions_by_id
    ]

    new_recovery_failures = [f for f in declutter.recovery_failures if f.item_id != item_id]
    if failure is not None:
        new_recovery_failures.append(failure)

    new_provenance_warnings = [w for w in declutter.provenance_warnings if w.item_id != item_id]
    if provenance_warning is not None:
        new_provenance_warnings.append(provenance_warning)

    new_declutter = DeclutterResult(
        run_id=declutter.run_id,
        expected_item_ids=declutter.expected_item_ids,
        ai_decisions=new_ai_decisions,
        unresolved_item_ids=new_unresolved_item_ids,
        item_validity=new_item_validity,
        mapping_warnings=declutter.mapping_warnings,
        semantic_errors=declutter.semantic_errors,
        recovery_failures=new_recovery_failures,
        provenance_warnings=new_provenance_warnings,
        model_name=declutter.model_name,
        prompt_version=declutter.prompt_version,
        stage_timings=declutter.stage_timings,
    )

    return ReclassifyItemResult(analysis=new_analysis, declutter=new_declutter)
