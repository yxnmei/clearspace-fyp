"""
The Reorganise action checklist: a short, prioritised list of
{priority, title, instruction} steps, not a zone plan or item partition.

build_deterministic_checklist() is the production path (provenance
deterministic_direct). The model-output schema and
parse_and_validate_actions() serve the research path only.

No orchestration: whether and when a model is called belongs to the
service layer.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints, ValidationError, computed_field, model_validator

from app.core.reorganise_focus_areas import FOCUS_AREA_LABELS, group_items_by_area
from app.core.reorganise_storage import find_compatible_groups, format_label_list, shorten_for_display
from app.core.schemas import DetectedItem

MIN_ACTIONS = 1
MAX_ACTIONS = 5

# Research path: the action count a model answer must reach, by selection
# size. A shorter answer is rejected, never treated as partly usable.
SMALL_SELECTION_THRESHOLD = 3
SMALL_ACTION_RANGE = (1, 3)
NORMAL_ACTION_RANGE = (3, MAX_ACTIONS)


def expected_action_range(selected_item_count: int) -> tuple[int, int]:
    """(minimum, maximum) actions expected from the model for a selection
    of this size; the single source both the prompt and the acceptance
    check read."""
    if not isinstance(selected_item_count, int) or isinstance(selected_item_count, bool) or selected_item_count < 1:
        raise ValueError(f"selected_item_count must be a positive integer, got {selected_item_count!r}")
    return NORMAL_ACTION_RANGE if selected_item_count >= SMALL_SELECTION_THRESHOLD else SMALL_ACTION_RANGE
TITLE_MIN_LENGTH = 3
TITLE_MAX_LENGTH = 80
INSTRUCTION_MIN_LENGTH = 10
INSTRUCTION_MAX_LENGTH = 300

_MAX_DETAIL_LENGTH = 300
_TRUNCATION_SUFFIX = "...(truncated)"

_Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=TITLE_MIN_LENGTH, max_length=TITLE_MAX_LENGTH)]
_Instruction = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=INSTRUCTION_MIN_LENGTH, max_length=INSTRUCTION_MAX_LENGTH)
]
_BoundedDetail = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_MAX_DETAIL_LENGTH)]

# Shopping, retailers, links, money, and removing a selected item (every
# selected item is one the user chose to keep). A match rejects the whole
# model answer, never part of it.
_FORBIDDEN_CONTENT_RE = re.compile(
    r"(?:\b(?:buy|buys|buying|purchase|purchases|purchasing|shop|shopping|order online|"
    r"amazon|ikea|carousell|shopee|lazada|taobao|daiso|muji|price|prices|priced)\b"
    r"|https?://|www\.|[$£€])",
    re.IGNORECASE,
)
_REMOVAL_RE = re.compile(
    r"\b(?:discard|discarding|donate|donating|sell|selling|throw (?:it |them |this |these )?(?:away|out)|"
    r"get rid of|bin (?:it|them|this|these)|dispose of)\b",
    re.IGNORECASE,
)


def _bounded(text: str, limit: int = _MAX_DETAIL_LENGTH) -> str:
    if len(text) <= limit:
        return text
    keep = max(0, limit - len(_TRUNCATION_SUFFIX))
    return text[:keep] + _TRUNCATION_SUFFIX


class ReorganiseAction(BaseModel):
    """One checklist entry. extra="forbid" so a stray zone, coordinate or
    product field in model output is rejected rather than ignored."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    priority: Annotated[StrictInt, Field(ge=1, le=MAX_ACTIONS)]
    title: _Title
    instruction: _Instruction


class ReorganiseActionList(BaseModel):
    """The whole model response: {"actions": [...]}. Priorities must be
    exactly 1..n; list order is normalised rather than rejected, since a
    correctly numbered list in the wrong order is still usable."""

    model_config = ConfigDict(extra="forbid")

    actions: list[ReorganiseAction] = Field(min_length=MIN_ACTIONS, max_length=MAX_ACTIONS)

    @model_validator(mode="after")
    def _check_priorities_and_sort(self) -> "ReorganiseActionList":
        priorities = sorted(action.priority for action in self.actions)
        if priorities != list(range(1, len(self.actions) + 1)):
            raise ValueError(f"priorities must be exactly 1..{len(self.actions)} with no gaps or repeats, got {priorities}")
        self.actions = sorted(self.actions, key=lambda action: action.priority)
        return self


ActionValidationErrorKind = Literal["malformed_actions", "too_few_actions", "forbidden_content"]


class ActionValidationError(BaseModel):
    kind: ActionValidationErrorKind
    detail: _BoundedDetail


class ActionConversionResult(BaseModel):
    """Only two states are constructible: (actions present, errors empty)
    or (actions None, errors non-empty)."""

    actions: list[ReorganiseAction] | None
    errors: list[ActionValidationError]

    @model_validator(mode="after")
    def _check_consistency(self) -> "ActionConversionResult":
        if self.actions is not None and self.errors:
            raise ValueError("ActionConversionResult cannot have both actions and errors")
        if self.actions is None and not self.errors:
            raise ValueError("ActionConversionResult must have at least one error when actions is None")
        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_valid(self) -> bool:
        return self.actions is not None and not self.errors


def find_forbidden_content(text: str) -> str | None:
    """The first forbidden fragment in `text`, or None. Exposed so tests
    and the prompt builder share one definition of "forbidden"."""
    match = _FORBIDDEN_CONTENT_RE.search(text) or _REMOVAL_RE.search(text)
    return match.group(0) if match else None


def parse_and_validate_actions(raw: Any, *, min_actions: int = MIN_ACTIONS) -> ActionConversionResult:
    """
    Build a trusted checklist from `raw` (any parsed JSON value). Problems
    with `raw` are returned as structured errors; only ValidationError is
    caught, so an internal defect stays loud.

    `min_actions` is the selection-dependent floor (see
    expected_action_range). An out-of-range min_actions is a caller error
    and raises ValueError.
    """
    if not isinstance(min_actions, int) or isinstance(min_actions, bool) or not (MIN_ACTIONS <= min_actions <= MAX_ACTIONS):
        raise ValueError(f"min_actions must be an integer in {MIN_ACTIONS}..{MAX_ACTIONS}, got {min_actions!r}")

    try:
        action_list = ReorganiseActionList.model_validate(raw)
    except ValidationError as exc:
        return ActionConversionResult(
            actions=None,
            errors=[ActionValidationError(kind="malformed_actions", detail=_bounded(f"checklist did not match the required shape: {exc.error_count()} validation error(s)"))],
        )

    if len(action_list.actions) < min_actions:
        return ActionConversionResult(
            actions=None,
            errors=[
                ActionValidationError(
                    kind="too_few_actions",
                    detail=_bounded(f"checklist has {len(action_list.actions)} action(s); at least {min_actions} expected for this selection"),
                )
            ],
        )

    for action in action_list.actions:
        fragment = find_forbidden_content(f"{action.title} {action.instruction}")
        if fragment is not None:
            return ActionConversionResult(
                actions=None,
                errors=[
                    ActionValidationError(
                        kind="forbidden_content",
                        detail=_bounded(f"action {action.priority} contains forbidden content: {fragment!r}"),
                    )
                ],
            )

    return ActionConversionResult(actions=list(action_list.actions), errors=[])


# --- deterministic production checklist ----------------------------------
#
# Built only from detected data (coarse area, effective label, relative
# size). Never names a destination or container that is not a selected
# item, and never uses the user's free-text context (untrusted and
# unbounded). The title is a self-contained imperative; the instruction
# adds the count, reason or up to three labels, never repeating it.


def _validate_fallback_inputs(selected_items: Any, scene_label: Any) -> None:
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


def _area_phrase(area_id: str) -> str:
    return FOCUS_AREA_LABELS[area_id].lower()


def _area_location(area_id: str) -> str:
    """"on the left side", "in the centre", "in other areas"."""
    phrase = _area_phrase(area_id)
    if phrase.endswith("side"):
        return f"on the {phrase}"
    return f"in {phrase}" if area_id == "other" else f"in the {phrase}"


def _is_large(item: DetectedItem) -> bool:
    return item.relative_size.strip().lower() == "large"


def _label(item: DetectedItem) -> str:
    return shorten_for_display(item.effective_label.strip())


_MAX_NAMED_LABELS = 3


def _name_some(items: list[DetectedItem], *, tail: str) -> str:
    """"lamp", "lamp and chair", "lamp, chair and plant", or, past
    _MAX_NAMED_LABELS, "lamp, chair, plant and <tail>": a bounded, real
    label list with no count for what is left unnamed."""
    names = [_label(item) for item in items[:_MAX_NAMED_LABELS]]
    if len(items) > _MAX_NAMED_LABELS:
        names.append(tail)
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def _cleanup_action(area_id: str, items: list[DetectedItem]) -> tuple[str, str]:
    """The single cleanup step for the busiest area of uncovered items.

    Size only marks which large item is not worth moving. Sharing a
    coarse area does not prove smaller items sit on or beside it (a chair
    and a bowl do not belong with a shelf), so the wording keeps to
    "in the area"."""
    large = [item for item in items if _is_large(item)]
    smaller = [item for item in items if not _is_large(item)]

    if len(items) == 1:
        (only,) = items
        if _is_large(only):
            return (
                f"Clear the space around the {_label(only)}",
                "Leave it in place and clear the immediate space around it.",
            )
        return (f"Straighten the {_label(only)}", "Set it neatly in place and clear the immediate space around it.")

    if large:
        anchors = format_label_list(large, max_labels=2)
        if smaller:
            return (
                f"Tidy the {_area_phrase(area_id)} without moving the {_label(large[0])}",
                f"Leave the {anchors} in place, then straighten the {_name_some(smaller, tail='the other loose items')} "
                "in the area.",
            )
        pronoun = "it" if len(large) == 1 else "them"
        return (
            f"Clear the space around the {_label(large[0])}",
            f"Leave the {anchors} in place and clear the immediate space around {pronoun}.",
        )

    return (
        f"Tidy loose items {_area_location(area_id)}",
        f"Straighten the {_name_some(items, tail='the other loose items')}, then clear the surrounding space.",
    )


def _make_action(priority: int, title: str, instruction: str) -> ReorganiseAction:
    return ReorganiseAction(
        priority=priority,
        title=shorten_for_display(title, TITLE_MAX_LENGTH),
        instruction=shorten_for_display(instruction, INSTRUCTION_MAX_LENGTH),
    )


def build_deterministic_checklist(selected_items: list[DetectedItem], scene_label: str) -> list[ReorganiseAction]:
    """
    Production checklist: deterministic, no model. Raises ValueError
    (never AttributeError/TypeError) on invalid caller input.

    Priority order, capped at MAX_ACTIONS:
      1. one action per repeated effective label, first-seen order;
      2. one per compatible category group not already covered;
      3. at most one cleanup action for the busiest area of uncovered
         items;
      4. a closing whole-space check, only while there is capacity.
    """
    _validate_fallback_inputs(selected_items, scene_label)

    drafts: list[tuple[str, str]] = []
    covered_ids: set[str] = set()

    # 1. "the <label> items" avoids guessing a plural for a possibly
    # user-corrected label.
    by_label: dict[str, list[DetectedItem]] = {}
    for item in selected_items:
        by_label.setdefault(item.effective_label.strip(), []).append(item)
    for label, items in by_label.items():
        if len(items) < 2:
            continue
        display = shorten_for_display(label)
        quantity = "both" if len(items) == 2 else f"all {len(items)}"
        drafts.append(
            (f"Group the {display} items", f"Keep {quantity} together so they are easier to find and put back.")
        )
        covered_ids.update(item.item_id for item in items)

    # 2. Compatible category groups.
    for rule, items in find_compatible_groups(selected_items):
        if all(item.item_id in covered_ids for item in items):
            continue
        drafts.append(
            (f"Group {rule.group_noun}", "Keep these related items together so they are easy to find and put back.")
        )
        covered_ids.update(item.item_id for item in items)

    # 3. One cleanup step for the busiest area of what is left.
    remaining = [item for item in selected_items if item.item_id not in covered_ids]
    if remaining:
        area_id, area_items = group_items_by_area(remaining)[0]
        drafts.append(_cleanup_action(area_id, area_items))

    # 4. The closing check, only if it fits. Says "the space" rather than
    # the classified room type so a garage or balcony reads naturally.
    drafts.append(
        (
            "Do a final space check",
            "Review the space once more and make sure every selected item has a clear place.",
        )
    )

    return [_make_action(index + 1, title, instruction) for index, (title, instruction) in enumerate(drafts[:MAX_ACTIONS])]
