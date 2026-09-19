"""
Pure logic for the Reorganise ACTION CHECKLIST: the strict content schema
the checklist model must satisfy, the conversion of a raw (already-JSON-
parsed, not-yet-trusted) object into trusted actions, and the fully
deterministic fallback checklist used when no trusted model output exists.

A checklist is a short, prioritised list of things to do, not a plan of
zones, coordinates or item assignments. Nothing here partitions items,
requires every item to be mentioned, or asks anything of the model beyond
{priority, title, instruction} triples. The model is never asked for an
image prompt (see app.core.reorganise_image_prompt) or a storage product
(see app.core.reorganise_storage).

No orchestration here: whether a model is called at all, how many times
(at most once), and when the fallback is used is
app/services/reorganise_actions_service.py's job. This module only ever
answers "is this one raw object, on its own, a valid checklist" and "here
is a deterministic checklist built directly from detected data."
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

# The action count the prompt asks the model for, and the count a model
# response must reach to be trusted: selections of fewer than
# SMALL_SELECTION_THRESHOLD items may answer with 1 to 3 actions; anything
# larger must answer with 3 to 5. A shorter answer is not "partly usable",
# it is rejected as invalid_actions and the deterministic fallback is used
# instead (still bounded by the general MIN_ACTIONS..MAX_ACTIONS schema).
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

# Content the prompt forbids and validation refuses regardless: shopping,
# retailers, links, money, and removing or disposing of a selected item
# (every selected item is something the user chose to keep). A match is
# an `forbidden_content` rejection, which the service turns into the
# deterministic fallback, never a partially accepted checklist.
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
    """One checklist entry. extra="forbid": this is model-facing content,
    validated directly against this shape, so a stray zone / coordinate /
    product / image field is rejected as malformed rather than ignored.
    priority is a StrictInt so "1" (a string) is never coerced."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    priority: Annotated[StrictInt, Field(ge=1, le=MAX_ACTIONS)]
    title: _Title
    instruction: _Instruction


class ReorganiseActionList(BaseModel):
    """The whole model response: {"actions": [...]} and nothing else.
    Priorities must be exactly 1..n (each once); order in the raw list is
    normalised to priority order rather than rejected, since a complete,
    correctly numbered list in the wrong order is still a usable
    checklist."""

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
    Attempts to construct a trusted checklist from `raw` (already-parsed
    JSON: a dict, or garbage). Every problem with `raw` is returned as a
    structured error, never raised and never a raw traceback. Only the
    expected data-validation failure (pydantic's ValidationError) is
    caught; an unexpected internal exception stays loud.

    `min_actions` is the selection-dependent floor a MODEL answer must
    reach (see expected_action_range); a syntactically valid answer with
    fewer actions is reported as `too_few_actions`, never partially
    accepted. It defaults to the schema minimum so callers validating a
    checklist without a selection context (tests, tooling) still work.
    Raises ValueError for a min_actions outside MIN_ACTIONS..MAX_ACTIONS,
    a caller error rather than a model one.
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


# --- deterministic fallback checklist ------------------------------------
#
# Built only from real detected data: the coarse area each selected item
# sits in (its `position`), its effective label and its relative size.
# Never names a destination, container, piece of furniture or storage
# object that is not itself a selected item, and never uses the user's
# free-text context (unbounded, untrusted, and not needed to be useful).


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


def _area_instruction(area_id: str, items: list[DetectedItem], *, first: bool) -> str:
    phrase = _area_phrase(area_id)
    count = len(items)
    large = [item for item in items if item.relative_size.strip().lower() == "large"]
    smaller = [item for item in items if item not in large]
    mixed_sizes = bool(large and smaller)
    # When an area mixes large and smaller items the body names every
    # item, so the opening skips the list; this keeps the whole sentence
    # well inside INSTRUCTION_MAX_LENGTH for realistic labels (the display
    # caps below bound the pathological long-corrected-label case).
    listed = "" if mixed_sizes else f" ({format_label_list(items, max_labels=3)})"
    if first:
        opening = f"The {phrase} of your photo holds {count} of your selected item{'s' if count != 1 else ''}{listed}."
    else:
        opening = f"Next, the {phrase} of your photo{listed}."
    if mixed_sizes:
        # Size is used ONLY to say which items are not worth moving. The
        # smaller items are never arranged "around" or "on" the large one:
        # sharing a part of the photo does not make a chair and a bowl
        # belong with a shelf, and nothing here knows the large item is a
        # usable surface.
        anchor = format_label_list(large, max_labels=2)
        verb = "it is" if len(large) == 1 else "they are"
        body = (
            f" Leave the {anchor} where {verb}. Straighten the {format_label_list(smaller, max_labels=3)} "
            "and clear loose items from the space around each one."
        )
    elif count == 1:
        body = " Straighten it and clear loose items from the space immediately around it."
    else:
        body = " Straighten each one and clear loose items from the space around them."
    return opening + body


def _make_action(priority: int, title: str, instruction: str) -> ReorganiseAction:
    return ReorganiseAction(
        priority=priority,
        title=shorten_for_display(title, TITLE_MAX_LENGTH),
        instruction=shorten_for_display(instruction, INSTRUCTION_MAX_LENGTH),
    )


def build_deterministic_checklist(selected_items: list[DetectedItem], scene_label: str) -> list[ReorganiseAction]:
    """
    Pure and fully deterministic given the same inputs: no model, no
    randomness, no wall-clock dependence. Raises ValueError (never
    AttributeError/TypeError) on invalid caller input.

    Shape, in priority order and capped at MAX_ACTIONS:
      1. the busiest area (most selected items), first;
      2. one action per repeated label (two or more items sharing an
         effective label) and per compatible category group not already
         covered by a repeated label, so the user is told which things
         belong together;
      3. the remaining areas, busiest first;
      4. a closing whole-room check naming the room type.
    Every sentence names only detected labels and coarse photo areas.
    """
    _validate_fallback_inputs(selected_items, scene_label)

    grouped = group_items_by_area(selected_items)
    drafts: list[tuple[str, str]] = []

    first_area_id, first_items = grouped[0]
    drafts.append(
        (f"Start with the {_area_phrase(first_area_id)}", _area_instruction(first_area_id, first_items, first=True))
    )

    # Repeated labels, first-seen order.
    by_label: dict[str, list[DetectedItem]] = {}
    for item in selected_items:
        by_label.setdefault(item.effective_label.strip(), []).append(item)
    covered_ids: set[str] = set()
    for label, items in by_label.items():
        if len(items) < 2:
            continue
        areas = sorted({_area_phrase(area_id) for area_id, area_items in grouped for item in area_items if item in items})
        if len(areas) > 1:
            where = f"across the {' and '.join(areas)}"
        else:  # "on the left side", but "in the centre" / "in other areas"
            where = f"on the {areas[0]}" if areas[0].endswith("side") else f"in the {areas[0]}".replace("in the other", "in other")
        display = shorten_for_display(label)
        drafts.append(
            (
                f"Group the {display} items together",
                f"You selected {len(items)} items labelled '{display}', currently {where}. Bring them together "
                "so they sit as one group instead of being scattered.",
            )
        )
        covered_ids.update(item.item_id for item in items)

    # Compatible category groups not already covered by a repeated label.
    for rule, items in find_compatible_groups(selected_items):
        if all(item.item_id in covered_ids for item in items):
            continue
        drafts.append(
            (
                f"Keep the {rule.group_noun} together",
                f"The {format_label_list(items)} are compatible {rule.group_noun}. Keep them in one spot so they "
                "are easy to find and put back.",
            )
        )
        covered_ids.update(item.item_id for item in items)

    for area_id, items in grouped[1:]:
        drafts.append((f"Tidy the {_area_phrase(area_id)}", _area_instruction(area_id, items, first=False)))

    drafts.append(
        (
            "Check the whole room",
            f"Look over the {shorten_for_display(scene_label.strip(), 40)} once more and make sure each selected "
            "item has a visible, settled place before you finish.",
        )
    )

    return [_make_action(index + 1, title, instruction) for index, (title, instruction) in enumerate(drafts[:MAX_ACTIONS])]
