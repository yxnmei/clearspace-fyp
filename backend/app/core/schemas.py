"""
Domain schemas for the Declutter/Reorganise/Both pipeline: run identity,
detected items, AI decisions, user overrides, and confirmed decisions.

pydantic models, not dataclasses: validation is load-bearing — the
pipeline must reject a malformed LLM response or an invalid decision value
rather than let either pass silently downstream.

Item identity: item_id is assigned once per detected instance and never
derived from label text, so two same-labelled instances (e.g. two
"stuffed toy"s) get distinct item_ids that overrides, confirmation and
Reorganise selection can address independently. Uniqueness is the
compound (run_id, item_id): re-uploading a photo starts a fresh run_id,
and there is no server-side session store, so nothing needs cross-run
uniqueness. API responses and their nested results carry matching run_id
values so shared run identity can be validated; DetectedItem does not
repeat run_id.

Decision override vs. label correction are separate actions: a
DecisionOverride ("AI said Keep, user chose Donate") is applied
deterministically by confirm_decisions() with no model call; a label
correction ("this is a storage box, not a book") goes through /override
and may re-run reasoning.
"""

from __future__ import annotations

import math
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, computed_field, model_validator

# Rejects "" and "   " alike: an empty value would silently mean "no data"
# while looking present.
NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

# The one item_id shape, defined once so no schema's copy can drift.
ItemId = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^item_\d{3,}$")]


class RunContext(BaseModel):
    """One analysis session; identity only needs to stay stable for one
    round-tripped session, not across runs."""

    run_id: NonEmptyStr


class BoundingBox(BaseModel):
    """Normalized [0, 1] xyxy, matching grounding_dino.RawDetection.box_xyxy.
    Validated so a degenerate box never reaches position/size logic."""

    x1: float = Field(ge=0.0, le=1.0)
    y1: float = Field(ge=0.0, le=1.0)
    x2: float = Field(ge=0.0, le=1.0)
    y2: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _check_ordering(self) -> "BoundingBox":
        if self.x2 <= self.x1 or self.y2 <= self.y1:
            raise ValueError(f"degenerate or inverted box: {self!r}")
        return self


class Decision(str, Enum):
    """The 4-way decision. Actionability (whether an item is a real
    decluttering candidate) lives on DetectedItem.item_role, not here."""

    KEEP = "keep"
    SELL = "sell"
    DONATE = "donate"
    DISCARD = "discard"


class DetectedItem(BaseModel):
    """One stable, user-facing detected instance.

    item_id: assigned once per surviving detection, unique within one
    run_id, never derived from label text. analyse_image() assigns ids
    top-to-bottom then left-to-right by (box.y1, box.x1), ties broken by
    source_detection_index: deterministic and reproducible from the boxes
    alone, unlike confidence order, which reshuffles on every rerun as
    confidences shift slightly.

    raw_phrase vs. clean_label: raw_phrase is Grounding DINO's unedited
    (possibly compound) phrase; clean_label is label_cleanup's `primary`.
    Kept separate for traceability, so a bad clean_label can be traced to
    what the detector said without re-running detection.

    position / relative_size: from box_descriptors.describe_box_parts();
    plain non-empty strings rather than a Literal duplicating that
    module's vocabulary.

    source_detection_index: traceability only, never used as identity.

    item_role / item_role_source: actionability as a tag with provenance,
    not a Decision value. Nothing currently sets "contextual"; the field
    is advisory metadata, never a filter that hides items.

    corrected_label / label_source / effective_label: a user label
    correction (POST /override). Only corrected_label is stored; the other
    two are computed so they can never contradict it. clean_label is never
    overwritten. Anything shown to the user or sent to the LLM must read
    effective_label, so a correction is never silently ignored.
    """

    item_id: ItemId
    source_detection_index: int = Field(ge=0)
    raw_phrase: NonEmptyStr
    clean_label: NonEmptyStr
    box: BoundingBox
    confidence: float = Field(ge=0.0, le=1.0)
    position: NonEmptyStr
    relative_size: NonEmptyStr
    item_role: Literal["actionable", "contextual"] = "actionable"
    item_role_source: Literal["default", "heuristic", "user"] = "default"
    corrected_label: NonEmptyStr | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def label_source(self) -> Literal["detector", "user"]:
        return "user" if self.corrected_label is not None else "detector"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def effective_label(self) -> str:
        return self.corrected_label if self.corrected_label is not None else self.clean_label


def validate_unique_item_ids(items: list[DetectedItem]) -> None:
    """Raise ValueError on a duplicate item_id within one run's items.
    Not global: the same item_id recurs across runs."""
    seen: set[str] = set()
    for item in items:
        if item.item_id in seen:
            raise ValueError(f"duplicate item_id within one run: {item.item_id!r}")
        seen.add(item.item_id)


class AiDecision(BaseModel):
    """The AI's per-item decision before user review, after item_number
    has been mapped to item_id (see id_mapping.py)."""

    item_id: ItemId
    decision: Decision
    reason: NonEmptyStr


class DecisionOverride(BaseModel):
    """One user correction to an AI *decision*, keyed by item_id, never by
    label. Applied deterministically with no model call: changing Keep to
    Donate is not grounds to re-ask the LLM. An override that sets neither
    decision nor excluded changes nothing and is rejected."""

    item_id: ItemId
    decision: Decision | None = None
    excluded: bool | None = None
    user_reason: NonEmptyStr | None = None

    @model_validator(mode="after")
    def _at_least_one_field_set(self) -> "DecisionOverride":
        if self.decision is None and self.excluded is None:
            raise ValueError("DecisionOverride must set at least one of decision/excluded")
        return self


class ConfirmedDecision(BaseModel):
    """Final user-confirmed state for one item (core/confirmation.py).

    ai_decision / ai_reason: the AI's original output, preserved verbatim
    and never relabelled as the user's reasoning.

    excluded: independent of decision. An excluded item keeps a real
    confirmed_decision but is left out of confirmed_keep_ids; excluding
    alone is not a decision change.

    decision_changed: computed, so a constructed or API-parsed instance
    can never carry inconsistent change metadata. An override restating
    the AI's own decision is not a change.
    """

    item_id: ItemId
    ai_decision: Decision
    confirmed_decision: Decision
    ai_reason: NonEmptyStr
    user_reason: NonEmptyStr | None = None
    excluded: bool = False

    @computed_field  # type: ignore[prop-decorator]
    @property
    def decision_changed(self) -> bool:
        return self.confirmed_decision != self.ai_decision


class ItemValidity(str, Enum):
    """Per-item LLM output validity, multi-valued rather than a pass/fail
    bool so repaired and recovered output stay distinguishable from raw
    valid output. Assigned in app/models/mistral_llm.py."""

    RAW_VALID = "raw_valid"
    MECHANICALLY_REPAIRED = "mechanically_repaired"
    RECOVERY_USED = "recovery_used"
    STILL_INVALID = "still_invalid"


class MappingWarningKind(str, Enum):
    """Ways an LLM item_number can fail to map onto the expected items
    (decided in app/core/id_mapping.map_item_numbers).

    MISSING: an expected item_number never appeared.
    DUPLICATE: appeared more than once; neither occurrence is trusted.
    MALFORMED: not an object, or item_number absent or not an integer.
    UNEXPECTED: an integer this call did not request (out of bounds or
      belonging to another chunk).
    """

    MISSING = "missing"
    DUPLICATE = "duplicate"
    MALFORMED = "malformed"
    UNEXPECTED = "unexpected"


class MappingWarning(BaseModel):
    kind: MappingWarningKind
    item_number: int | None = None
    detail: str


class MappedLLMItem(BaseModel):
    """One LLM response element after unambiguous item_number -> item_id
    mapping. Content stays raw here; core/semantic_conversion.py validates
    it. This stage is about identity only."""

    item_number: int
    item_id: ItemId
    label: str | None = None
    decision: str | None = None
    reason: str | None = None


class ItemNumberMappingResult(BaseModel):
    """mapped: only unambiguous resolutions; an item_number with a MISSING
    or DUPLICATE warning never appears here. warnings: never truncated."""

    mapped: list[MappedLLMItem]
    warnings: list[MappingWarning]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_complete(self) -> bool:
        """True iff there are no MISSING or DUPLICATE warnings, i.e. the
        mapping is usable. Stray MALFORMED/UNEXPECTED entries do not affect
        it. Exists so a partial mapping is never mistaken for success just
        because `mapped` is non-empty."""
        fatal = {MappingWarningKind.MISSING, MappingWarningKind.DUPLICATE}
        return not any(w.kind in fatal for w in self.warnings)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_strictly_valid(self) -> bool:
        """True iff there are zero warnings of any kind: the response was
        entirely clean, not merely usable (is_complete)."""
        return len(self.warnings) == 0


class SceneClassification(BaseModel):
    """CLIP classify_scene() output, same shape as its return dict.
    all_scores keeps every candidate, not just top-1, for evaluation of the
    confidence distribution."""

    label: NonEmptyStr
    confidence: float = Field(ge=0.0, le=1.0)
    all_scores: dict[str, float]

    @model_validator(mode="after")
    def _check_scores_consistent(self) -> "SceneClassification":
        if not self.all_scores:
            raise ValueError("all_scores must not be empty")
        for name, score in self.all_scores.items():
            if not name.strip():
                raise ValueError(f"all_scores contains a blank candidate name: {name!r}")
            if not math.isfinite(score):
                raise ValueError(f"all_scores[{name!r}] is not finite: {score!r}")
            if not (0.0 <= score <= 1.0):
                raise ValueError(f"all_scores[{name!r}] out of [0, 1] range: {score!r}")
        if self.label not in self.all_scores:
            raise ValueError(f"label {self.label!r} is not a key in all_scores")
        # isclose, not ==: the two values may have been rounded independently
        # (e.g. serialization). The sum-to-1 property is softmax's job upstream.
        if not math.isclose(self.confidence, self.all_scores[self.label], rel_tol=1e-6, abs_tol=1e-9):
            raise ValueError(
                f"confidence {self.confidence!r} is inconsistent with "
                f"all_scores[{self.label!r}]={self.all_scores[self.label]!r}"
            )
        return self


class AnalysisWarning(BaseModel):
    """One non-fatal analyse_image() problem: a detection that failed
    validation was skipped and the rest of the analysis proceeded."""

    kind: Literal["malformed_detection"]
    source_detection_index: int | None = None
    detail: str


class StageTiming(BaseModel):
    stage: NonEmptyStr
    duration_ms: float = Field(ge=0.0)


class AnalysisResult(BaseModel):
    """The shared analyse_image() output that Declutter, Reorganise and
    Both consume; excludes decisions and anything downstream.

    item_id uniqueness is enforced by the model itself, not only by
    analyse_image(), because this is also rebuilt from client payloads
    (e.g. /confirm), a path analyse_image() is never on."""

    run_id: NonEmptyStr
    scene: SceneClassification
    items: list[DetectedItem]
    warnings: list[AnalysisWarning]
    stage_timings: list[StageTiming]

    @model_validator(mode="after")
    def _check_unique_item_ids(self) -> "AnalysisResult":
        validate_unique_item_ids(self.items)
        return self
