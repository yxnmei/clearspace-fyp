"""
Orchestration for the Declutter path: takes an already-committed
AnalysisResult (see app/services/analysis_service.py) and an injected LLM
classifier, and produces a DeclutterResult — one validated AiDecision per
expected actionable item, plus everything needed to audit how each one
got there.

This module is the shared implementation called by both app/api/routes.py
(HTTP, not yet wired) and evaluation/scripts/batch_eval.py (batch eval,
no HTTP layer) — see PROJECT_SPEC.md §4's "evaluation scripts call the
same services/ functions" principle. Never duplicate this logic inside a
route handler or an eval script directly.

Dependency injection, not a direct import of app.models.mistral_llm:
llm_classifier is typed as a Protocol (LLMClassifier, below) returning
another Protocol (LLMResultLike, below) — matching
app.services.analysis_service's SceneClassifier/ObjectDetector pattern.
This module does not import app.models.mistral_llm (and therefore never
imports ollama) at all: real app.models.mistral_llm.classify_items and
its real LLMResult already satisfy these Protocols structurally (same
call signature, same fields), so production wiring passes them in
directly with zero adapter code, and both this module's own import and
every test stay free of ollama/mistral_llm's heavier dependency surface.

Failure policy (stated before implementation, same discipline as
analysis_service.py):
  - llm_classifier raising on the MAIN bulk call -> DeclutterReasoningError,
    fatal, no partial DeclutterResult. This is the "total outage" case —
    the classifier itself is unusable, not a problem with one item.
  - llm_classifier raising during a targeted single-item recovery call ->
    caught locally, recorded as a RecoveryFailure, that one item ends
    STILL_INVALID; the rest of the batch proceeds. Not promoted to
    DeclutterReasoningError: recovery only ever runs after the main call
    already succeeded, so one recovery call failing is evidence about
    that one item, not about the service being down.
  - A response item with a bad identity (missing/duplicate/malformed
    item_number), an invalid decision enum value, or a blank reason ->
    not silently dropped and not guessed at; exactly one bounded targeted
    recovery call is attempted for that expected item, per the same
    per-item recovery mechanism above. Still invalid after that -> the
    item is STILL_INVALID and absent from ai_decisions, but always
    present in expected_item_ids/item_validity/unresolved_item_ids — a
    caller can never mistake "we don't have a decision for this item"
    for "this item doesn't exist."
  - A resolved decision whose LLM-wrapper provenance is missing or
    unrecognised is deliberately NOT trusted as raw-valid (see
    ProvenanceWarning below) — it's routed through the same one targeted
    recovery attempt as a genuinely-unresolved item, per explicit project
    decision: successful JSON parsing is necessary but not sufficient for
    ItemValidity.RAW_VALID.

No NMS/actionability heuristic implemented here: item_role filtering uses
whatever app/services/analysis_service.py already assigned (currently
always "actionable", by default — see DetectedItem.item_role_source) —
this module adds no new heuristic and does not implement the deferred
`not_applicable` decision value (PROJECT_SPEC.md §1.1).
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
    """Structural shape of an LLM classification result — the exact
    fields this module reads from app.models.mistral_llm.LLMResult,
    without importing that dataclass (and therefore never importing
    ollama) at runtime. Real LLMResult satisfies this structurally with
    zero adapter code; a fake test double only needs these six
    attributes, nothing else."""

    parsed_json: dict | list | None
    item_provenance: dict[int, ItemValidity]
    raw_text: str
    is_valid_json: bool
    model_name: str
    prompt_version: str


class LLMClassifier(Protocol):
    """Structural shape run_declutter() needs from an LLM classification
    call — matches app.models.mistral_llm.classify_items's real signature
    exactly, without importing that module's heavier dependency surface
    (ollama) into anything that only needs the Protocol for typing. Real
    classify_items satisfies this with zero adapter code."""

    def __call__(
        self,
        run_id: str,
        detected_items: list[dict],
        scene_label: str,
        user_context: str | None,
        model_name: str | None = None,
    ) -> LLMResultLike: ...


class DeclutterReasoningError(RuntimeError):
    """The injected llm_classifier raised on the main bulk classification
    call. Fatal — see module docstring's failure policy. Distinguishable
    by type from any per-item RecoveryFailure recorded inside a
    (structurally complete, non-exceptional) DeclutterResult."""


class ProvenanceWarning(BaseModel):
    """One item that mapped and validated cleanly on the main pass, but
    whose LLM-wrapper provenance (LLMResult.item_provenance) was missing
    or not one of the three trusted values (raw_valid/mechanically_repaired
    /recovery_used) — so it was NOT trusted as-is and was instead routed
    through the same one targeted recovery attempt as a genuinely
    unresolved item. Recorded so this conservative choice is visible,
    not silent."""

    item_id: ItemId
    item_number: int
    detail: NonEmptyStr


class RecoveryFailure(BaseModel):
    """One targeted service-level recovery call that did not produce a
    usable decision. Visible in DeclutterResult rather than silently
    swallowed — see module docstring's failure policy. `detail` is a
    short, safe description (exception type name + message, or a mapping/
    semantic-validation summary) — never a raw traceback or other
    server-internal payload; kept bounded in length defensively."""

    item_id: ItemId
    stage: Literal["call", "mapping", "semantic"]
    exception_type: str | None = None
    detail: NonEmptyStr


class DeclutterResult(BaseModel):
    """The output of run_declutter() for one AnalysisResult.

    expected_item_ids: every actionable item this call was responsible
    for deciding, in AnalysisResult's own deterministic order — the
    contract surface a caller checks completeness against.

    ai_decisions: exactly one AiDecision per item_id that ended up
    RAW_VALID / MECHANICALLY_REPAIRED / RECOVERY_USED, in
    expected_item_ids order (never recovery-call order) — never more than
    one per item_id, by construction (see run_declutter).

    unresolved_item_ids: the subset of expected_item_ids with no valid
    decision after the one allowed recovery attempt (STILL_INVALID).

    item_validity: every expected item_id's final ItemValidity —
    authoritative, assigned only after identity mapping, duplicate/
    unexpected checks, decision-enum validation, and non-empty-reason
    validation (see module docstring); never a bare pass-through of the
    LLM wrapper's own provenance hint.

    mapping_warnings / semantic_errors: aggregated from the main pass AND
    every targeted recovery call — nothing is dropped just because it
    happened during recovery rather than the main call.

    recovery_failures: visible detail for every targeted recovery call
    that did not resolve its item (see RecoveryFailure).

    is_complete: every expected item has exactly one valid decision.
    is_strictly_valid: is_complete AND every expected item's ItemValidity
    is RAW_VALID (never MECHANICALLY_REPAIRED or RECOVERY_USED) AND the
    whole run produced zero warnings/errors/failures of any kind (no
    mapping warnings, no semantic errors, no recovery failures, no
    provenance warnings). A result can be complete-after-recovery, or
    complete-after-repair, without being strictly valid — MECHANICALLY_
    REPAIRED and RECOVERY_USED both mean the model's raw output needed
    help, which is exactly what "strictly valid" is meant to rule out;
    that distinction matters for evaluation (a model that needed rescuing
    on every item is not equivalent to one that needed no help at all).
    An empty expected_item_ids (no actionable items at all) is vacuously
    both complete and strictly valid."""

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
    """clean_label/confidence/position_hint — the exact shape
    classify_items()/build_classification_prompt() expect. position_hint
    reuses box_descriptors.describe_box()'s own "<relative_size>,
    <position>" joining convention, so a caller of classify_items()
    directly (e.g. the eval scripts) and this path render identically."""
    return {
        "label": item.clean_label,
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
    """One bounded, single-item targeted recovery call for one expected
    item. Never called more than once per item by run_declutter (no
    recursion, no second attempt) — classify_items()'s own internal
    retry-on-invalid-JSON loop still applies inside this one call, that's
    existing bounded robustness in the injected classifier, not a second
    recovery layer.

    Sends only this one DetectedItem, so classify_items() will number it
    item_number=1 locally, regardless of its original position in the
    full image — remapped explicitly back to item.item_id via a
    single-entry {1: item.item_id} table, never assumed.
    """
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
    """
    Full Declutter classification pass for one already-committed
    AnalysisResult. model_name is passed straight through to every
    llm_classifier call (main pass and every targeted recovery) —
    production leaves it None (resolves to config.llm_model_name /
    phi4-mini inside classify_items); evaluation scripts can pin a
    specific candidate while still calling this exact same function
    (PROJECT_SPEC.md §4's "one implementation, not two that drift").

    Zero actionable items -> llm_classifier is never called at all; a
    trivially complete, empty DeclutterResult is returned directly (see
    the early-return below).
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
                # Successful mapping + semantic validation is necessary
                # but NOT sufficient for RAW_VALID — an untrusted/missing
                # provenance hint means the wrapper never vouched for
                # this item_number at all; treated conservatively as
                # unresolved, never silently upgraded. See module
                # docstring's failure policy.
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


def reclassify_item(run_id: str, item_id: str, new_label: str):
    """Re-run LLM reasoning for a single item after user override (/override).

    Deliberately separate from run_declutter()'s targeted recovery: this
    is a label CORRECTION ("this is a storage box, not a book"), a
    different user action from a DecisionOverride, per
    app/core/schemas.py's DecisionOverride docstring. Not implemented in
    this pass — out of scope (route work is excluded from this task)."""
    raise NotImplementedError
