"""
Domain schemas for the Declutter/Reorganise/Both pipeline: run identity,
detected items, AI decisions, user overrides, and confirmed decisions.

pydantic v2 (2.10.4, confirmed installed — see backend/requirements.txt)
models, not dataclasses: validation here is load-bearing, not decorative —
Brief 4.1 requires the pipeline to reject a malformed LLM response and an
invalid decision value rather than let either pass silently downstream.

Item identity: item_id is assigned once per detected instance, after
cleanup/dedup, and is never derived from label text — two same-labelled
instances (e.g. two "stuffed toy"s, a real case in
evaluation/labels/labels.json) must get distinct item_ids so overrides,
confirmation, and Reorganise selection can address them independently.
Uniqueness is the compound (run_id, item_id): the same item_id string is
valid in two different runs (e.g. re-uploading the same photo starts a
fresh run_id, not a resumed session — no server-side session store
exists, by design, so nothing needs cross-run uniqueness). RunContext
carries run_id; DetectedItem itself does not repeat it.

Not yet true, and not claimed as true here: no API route is implemented
(app/api/routes.py's handlers are all NotImplementedError). The future
workflow response contract — once built — MUST include RunContext/run_id
once per response; that is a requirement on that not-yet-designed
contract, not a description of current behaviour.

Decision override vs. label correction (kept deliberately separate, per
project decision): a DecisionOverride ("AI said Keep, user chose Donate")
is applied deterministically by confirm_decisions() with no model call. A
label correction ("this is a storage box, not a book") is a different
user action, handled by the existing /override route, and may justify
re-running the LLM — that route is out of scope for this module.

Deliberately NOT included yet (this session's task boundary): StageTiming,
Reorganise placement/zone schemas, and image-generation request/result
schemas — their actual shape depends on service contracts (including the
still-unconfirmed Colab depth-map question) that haven't been designed
yet. Adding them now would be guessing ahead of that design, not a shared
base anything here actually needs.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, computed_field, model_validator

# Shared string types, applied consistently rather than repeating the same
# Field(...) constraints on every model that needs them.
#
# NonEmptyStr: strips whitespace, then requires at least 1 character left —
# rejects "" and "   " alike ("non-empty trimmed strings", per this
# session's explicit requirement). Used for identifiers/text fields where
# an empty value would silently mean "no data" while looking present.
NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

# ItemId: the one shared item_id shape ("item_NNN", 3+ digits), applied to
# every schema that carries an item_id — DetectedItem, AiDecision,
# DecisionOverride, ConfirmedDecision, MappedLLMItem — so "what counts as
# a valid item_id" is defined once, not five times with room for one copy
# to drift.
ItemId = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^item_\d{3,}$")]


class RunContext(BaseModel):
    """One analysis session. Re-uploading the same image is a new session
    with a new run_id — there is no server-side session store (no DB, by
    design, see PROJECT_SPEC.md non-goals), so identity only needs to stay
    stable for the lifetime of one round-tripped session, not across runs.
    run_id rejects empty/whitespace-only values (NonEmptyStr)."""

    run_id: NonEmptyStr


class BoundingBox(BaseModel):
    """Normalized [0, 1] xyxy — resolution-independent, matches
    grounding_dino.RawDetection.box_xyxy. Validated here so a malformed or
    degenerate box can never silently reach position/size logic downstream.
    """

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
    """The 4-way decision enum. Deliberately NOT extended with a 5th
    `not_applicable` value yet — PROJECT_SPEC.md §1.1 documents that as a
    deliberately deferred design direction, reassessed only after
    Declutter, Reorganise, and Both all work end-to-end. Actionability
    (whether an item is even a real decluttering candidate) is represented
    separately, on DetectedItem.item_role, not folded into this enum."""

    KEEP = "keep"
    SELL = "sell"
    DONATE = "donate"
    DISCARD = "discard"


class DetectedItem(BaseModel):
    """One stable, user-facing detected instance.

    item_id: assigned once, after label cleanup, box validation, and
    dedup/NMS — a raw detection merged away during dedup never receives a
    user-facing item_id (see analyse_image, not yet implemented). Unique
    within one run_id, never derived from label text.

    Assignment order (documented now, implemented when analyse_image() is
    built — this schema doesn't assign IDs itself): top-to-bottom then
    left-to-right, sorted by (box.y1, box.x1), ties broken by
    source_detection_index. Chosen over raw, undocumented detector output
    order because it's deterministic, reproducible from the box data
    alone, and gives a predictable, explainable presentation order in the
    UI — preferred over sorting by confidence, which would reorder items
    on every rerun as confidences shift slightly.

    raw_phrase vs. clean_label: kept as two distinct fields, not
    collapsed into one, matching app/core/label_cleanup.clean_label()'s
    own CleanedLabel(primary, discarded_tokens, was_compound) shape.
    raw_phrase is Grounding DINO's original (possibly compound) output
    phrase, unedited; clean_label is label_cleanup's `primary` — the
    single cleaned label actually shown to the user and sent to the LLM.
    Keeping both means a bad clean_label can be traced back to exactly
    what the detector said, without re-running detection.

    position / relative_size: two separate fields, not one combined
    string — app/core/box_descriptors.py (a pre-existing file under
    separate, active revision this session deliberately does not edit)
    currently only exposes a single combined describe_box() -> "large,
    upper-left" string via two *private* helpers (_size_label,
    _position_label). These fields are typed as plain non-empty trimmed
    strings, not a Literal enum of box_descriptors' current value set,
    specifically because that file's exact vocabulary is still in flux
    and not owned by this module — hardcoding it here would go stale the
    moment that file changes. Wiring real values into these fields (and
    possibly exposing size/position separately from box_descriptors, a
    small addition to that file's public API) is deferred to the
    analyse_image() task, not resolved here.

    source_detection_index: the raw detector's pre-dedup output index —
    kept only for traceability/debugging (e.g. tying a duplicate-detection
    complaint back to the exact Grounding DINO output), never used as or
    substituted for identity.

    item_role / item_role_source: actionability is represented as a tag
    with provenance, not folded into Decision (see Decision docstring).
    Defaults to "actionable" with source "default" — this module
    implements no heuristic that sets this to "contextual"; the fields
    exist so a later, evaluated heuristic (or the user, during review) can
    set it without a schema change, with its provenance always recorded
    rather than silently overwritten. Nothing is hidden from the user
    based on this field — it's advisory metadata, not a filter.
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


def validate_unique_item_ids(items: list[DetectedItem]) -> None:
    """Raises ValueError if any two items in this collection share an
    item_id. Uniqueness is scoped to the list passed in (one run's items)
    — call this once per run's detected-item list, not globally; the same
    item_id is valid and expected to recur across different runs."""
    seen: set[str] = set()
    for item in items:
        if item.item_id in seen:
            raise ValueError(f"duplicate item_id within one run: {item.item_id!r}")
        seen.add(item.item_id)


class AiDecision(BaseModel):
    """The AI's per-item decision, before any user review. Produced by the
    (not-yet-implemented) LLM classification stage after item_number has
    already been mapped to item_id — see id_mapping.py."""

    item_id: ItemId
    decision: Decision
    reason: NonEmptyStr


class DecisionOverride(BaseModel):
    """One user correction to an AI *decision*, keyed by item_id — never
    by label. Distinct from a label correction (the existing /override
    route's job, which may justify re-running the LLM): confirm_decisions()
    applies this deterministically, with no model call, per explicit
    project decision — changing Keep to Donate is not grounds to re-ask
    the LLM anything.

    At least one of decision/excluded must be set — an override that
    changes nothing is not a valid override. user_reason is optional and
    never required — most overrides won't carry one."""

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
    """Final, explicit, user-confirmed state for one item — the output of
    confirm_decisions() (see core/confirmation.py).

    ai_decision / ai_reason: the AI's original output, always preserved
    verbatim, never overwritten — even when the user changes the decision,
    ai_reason still explains what the AI originally said and why, it is
    never relabelled as if it were the user's reasoning.

    confirmed_decision: the final decision after applying any override
    (equal to ai_decision when there was none, or none applied to this
    item).

    user_reason: optional — only present if the user's DecisionOverride
    supplied one. Never required, never fabricated.

    excluded: independent of decision — an excluded item still carries a
    real confirmed_decision, it's just left out of the Keep set
    Reorganise/Both see (confirmed_keep_ids). Setting excluded, on its
    own, is not a decision change.

    decision_changed: computed, never caller-supplied — always exactly
    (confirmed_decision != ai_decision), so a directly constructed or
    API-parsed ConfirmedDecision can never carry inconsistent change
    metadata (e.g. decision_changed=True on two identical decisions). An
    override that redundantly restates the AI's own decision (e.g. AI
    said keep, override also says keep) is NOT a decision change — this
    replaces the previous, ambiguous `overridden` field, which conflated
    "an override was supplied" with "the decision actually changed."
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
    """LLM output validity states — kept distinct per item, never averaged
    into one pass/fail boolean. Assignment logic lives in the LLM wrapper
    (app/models/mistral_llm.py, not yet updated — deferred to the task
    that wires it); this enum is the shared vocabulary it and its callers
    will use."""

    RAW_VALID = "raw_valid"
    MECHANICALLY_REPAIRED = "mechanically_repaired"
    RECOVERY_USED = "recovery_used"
    STILL_INVALID = "still_invalid"


class MappingWarningKind(str, Enum):
    """Four distinguishable ways an LLM response's item_number can fail to
    map cleanly onto this run's expected items — see
    app/core/id_mapping.map_item_numbers for exactly how each is decided.

    MISSING: an expected item_number never appeared in the response at all.
    DUPLICATE: an expected item_number appeared more than once — neither
      occurrence is trusted; ambiguous, not silently resolved by picking one.
    MALFORMED: the response element wasn't an object, or its item_number
      field was absent or not an integer — an identity couldn't even be read.
    UNEXPECTED: a well-formed integer item_number that isn't one this call
      requested (negative, zero, out of bounds, or belonging to a different
      chunk) — a real integer, just not a valid one for this call.
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
    """One LLM response element after item_number -> item_id mapping has
    succeeded unambiguously. label/decision/reason stay raw, unvalidated
    strings here (or None, if absent from the response) — validating
    `decision` against the Decision enum and requiring a non-empty reason
    happens in core/semantic_conversion.py, not here; this stage is only
    about identity, not content."""

    item_number: int
    item_id: ItemId
    label: str | None = None
    decision: str | None = None
    reason: str | None = None


class ItemNumberMappingResult(BaseModel):
    """mapped: every item_number this call resolved unambiguously to a
    real item_id — an item_number involved in a MISSING or DUPLICATE
    warning never appears here, under either name.
    warnings: every problem found, however many; never truncated."""

    mapped: list[MappedLLMItem]
    warnings: list[MappingWarning]

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_complete(self) -> bool:
        """True iff every item_number in the requested set resolved to
        exactly one mapped item — i.e. no MISSING and no DUPLICATE
        warnings. Stray MALFORMED/UNEXPECTED entries (garbage in the raw
        response not tied to any requested item_number) don't affect
        this — they're filtered out and still visible in `warnings`, but
        they don't prevent the requested set itself from being complete.
        Exists specifically so a caller can't accidentally treat a
        partial mapping (some items missing/duplicated) as fully
        successful just because `mapped` is non-empty. See
        is_strictly_valid for the stricter, zero-warnings-of-any-kind
        check."""
        fatal = {MappingWarningKind.MISSING, MappingWarningKind.DUPLICATE}
        return not any(w.kind in fatal for w in self.warnings)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_strictly_valid(self) -> bool:
        """True iff the raw response produced zero warnings of any kind —
        stricter than is_complete. A response can be is_complete (every
        requested item resolved) while carrying a stray MALFORMED or
        UNEXPECTED entry from garbage elsewhere in the response, in which
        case is_complete is True but is_strictly_valid is False. This is
        the distinction between "usable" (is_complete: safe to build
        AiDecisions from) and "the model's response was entirely clean"
        (is_strictly_valid) — a response can be usable without being
        clean."""
        return len(self.warnings) == 0
