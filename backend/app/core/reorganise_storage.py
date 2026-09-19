"""
Pure logic: deterministic, evidence-bound generic storage suggestions for
a Reorganise result.

Deliberately modest. Every suggestion is derived only from the selected
DetectedItems (effective_label, relative_size). No model call, no web
search, no retailer API, no database, no persistence, no prices, brands,
links, stock claims, local-availability claims or marketplace integration
of any kind. The output is a generic suggestion type ("Compartment tray")
plus a reason naming the detected items that motivated it.

Rules, and why they are narrow:

  - Each rule is ONE compatible category (technology accessories; toys and
    games; books and papers; clothing, bags and shoes; jewellery, keys,
    watches and glasses). Categories are never merged: two cups and a
    charger are not "small loose items" and never become one suggestion,
    because a single container for unrelated things is not useful advice.
  - A rule fires only when at least MIN_EVIDENCE_ITEMS selected items
    match its keyword set by whole-word label match AND are small or
    medium (relative_size is real detector-derived data, never inferred
    here). One matching item is not evidence that storage is needed; a
    large item is not tray or hook material.
  - Sharing a part of the photo is NOT evidence. Nothing here reads
    position, and no rule fires because several arbitrary objects happen
    to sit together.
  - Insufficient evidence means FEWER suggestions, never an invented one.
    Zero is a valid, common result.
  - At most MAX_STORAGE_SUGGESTIONS are returned, ordered by evidence
    count (descending) then by fixed rule order, so the output is fully
    deterministic for the same inputs.

Identity discipline: `related_item_ids` carries item_id only. Labels
appear in `reason` as display text and are never used to identify, match
or deduplicate anything.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.core.schemas import DetectedItem, ItemId

MAX_STORAGE_SUGGESTIONS = 3
MIN_EVIDENCE_ITEMS = 2
_MAX_LISTED_LABELS = 4

_NAME_MAX_LENGTH = 80
_REASON_MAX_LENGTH = 300

# Display fragments are bounded BEFORE a reason is assembled, because a
# corrected_label is an unbounded NonEmptyStr: two long corrected labels
# ending in "book" would otherwise push a reason past _REASON_MAX_LENGTH
# and make StorageSuggestion raise, aborting the whole pipeline before
# image generation. Arithmetic bound on the longest reason: template
# (<120) + count (<=4 digits) + labels (4 x (30 + 5 for " x999") + 3
# separators of 2 + ", and 9999 more") < 300. _bound_reason() below is a
# last-resort guard that can only truncate the tail of the label list,
# never the count.
_MAX_LABEL_FRAGMENT_LENGTH = 30
_TRUNCATION_SUFFIX = "..."

# Sizes a "small items" suggestion may truthfully be made about. The
# detector's relative_size vocabulary is small / medium / large.
_SMALLER_SIZES = frozenset({"small", "medium"})

_SuggestionName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_NAME_MAX_LENGTH)]
_SuggestionReason = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_REASON_MAX_LENGTH)
]

_WORD_RE = re.compile(r"[a-z]+")


class StorageCategoryRule(BaseModel):
    """One narrow compatible category. `group_noun` is the plain-language
    name of the group used in reasons and in the deterministic checklist
    fallback ("technology accessories")."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    rule_id: str
    keywords: frozenset[str]
    name: str
    group_noun: str
    reason_template: str


# Keywords are matched as whole lowercase words inside the effective
# label, so "picture frame" matches nothing here (deliberately: a frame is
# decor, not a storage problem) while "coffee cup" would match "cup" if
# cups were a category (they are not: mixed tableware has no single
# compatible container). Each rule's reason template receives {count} and
# {labels}.
STORAGE_CATEGORY_RULES: tuple[StorageCategoryRule, ...] = (
    StorageCategoryRule(
        rule_id="tech_accessories",
        keywords=frozenset(
            {
                "cable", "cables", "cord", "cords", "charger", "chargers", "adapter", "adapters",
                "headphone", "headphones", "earphone", "earphones", "earbuds", "remote", "remotes",
                "controller", "controllers", "gamepad", "mouse", "mice", "powerbank", "dongle",
            }
        ),
        name="Cable or technology-accessory organiser",
        group_noun="technology accessories",
        reason_template="Keeps {count} technology accessories ({labels}) untangled and in one place.",
    ),
    StorageCategoryRule(
        rule_id="toys_and_games",
        keywords=frozenset(
            {
                "toy", "toys", "game", "games", "figurine", "figurines", "doll", "dolls", "puzzle",
                "puzzles", "lego", "plushie", "plushies", "teddy",
            }
        ),
        name="Toy or small-item container",
        group_noun="toys and games",
        reason_template="Gives {count} toys or games ({labels}) one container to return to after use.",
    ),
    StorageCategoryRule(
        rule_id="books_and_papers",
        keywords=frozenset(
            {
                "book", "books", "notebook", "notebooks", "magazine", "magazines", "document",
                "documents", "paper", "papers", "folder", "folders", "binder", "binders", "comic",
                "comics", "manual", "manuals", "journal", "journals",
            }
        ),
        name="Bookends or a compact shelf",
        group_noun="books and papers",
        reason_template="Stands {count} books or papers ({labels}) upright so they stay visible instead of piling up.",
    ),
    StorageCategoryRule(
        rule_id="clothing_bags_shoes",
        keywords=frozenset(
            {
                "clothes", "clothing", "shirt", "shirts", "jacket", "jackets", "coat", "coats", "hoodie",
                "hoodies", "sweater", "sweaters", "jeans", "trousers", "dress", "dresses", "bag", "bags",
                "backpack", "backpacks", "handbag", "handbags", "tote", "shoe", "shoes", "sneakers",
                "boots", "sandals", "slippers", "hat", "hats", "cap", "caps", "scarf", "scarves", "belt", "belts",
            }
        ),
        name="Hooks or a hanging organiser",
        group_noun="clothing, bags and shoes",
        reason_template="Lifts {count} clothing, bag or shoe items ({labels}) off the floor and furniture.",
    ),
    StorageCategoryRule(
        rule_id="jewellery_keys_glasses",
        keywords=frozenset(
            {
                "jewelry", "jewellery", "necklace", "necklaces", "bracelet", "bracelets", "earring",
                "earrings", "key", "keys", "keychain", "watch", "watches", "glasses", "sunglasses",
                "spectacles", "eyeglasses",
            }
        ),
        name="Compartment tray",
        group_noun="jewellery, keys, watches and glasses",
        reason_template="Gives {count} small personal items ({labels}) a fixed compartment each so they stop going missing.",
    ),
)


class StorageSuggestion(BaseModel):
    """One generic storage suggestion tied to real evidence. Frozen and
    extra="forbid": there is no field for a price, brand, URL, stock
    status or retailer, and none can be smuggled in."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: _SuggestionName
    reason: _SuggestionReason
    related_item_ids: list[ItemId] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_unique_ids(self) -> "StorageSuggestion":
        if len(self.related_item_ids) != len(set(self.related_item_ids)):
            raise ValueError("related_item_ids contains duplicates")
        return self


def _label_words(label: str) -> set[str]:
    return set(_WORD_RE.findall(label.lower()))


def shorten_for_display(text: str, limit: int = _MAX_LABEL_FRAGMENT_LENGTH) -> str:
    """Deterministic display truncation; the result never exceeds `limit`
    including the suffix. Display only: counts and ids are never derived
    from a shortened fragment."""
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - len(_TRUNCATION_SUFFIX))] + _TRUNCATION_SUFFIX


def format_label_list(items: list[DetectedItem], max_labels: int = _MAX_LISTED_LABELS) -> str:
    """"cup x2, bottle, toy" in first-seen order, capped at `max_labels`
    distinct labels plus an honest "and N more". Counts are taken on the
    FULL label, then each label is shortened for display, so a long
    corrected label can never inflate or hide a count."""
    counts: Counter[str] = Counter()
    order: list[str] = []
    for item in items:
        label = item.effective_label.strip()
        if label not in counts:
            order.append(label)
        counts[label] += 1
    parts = []
    for label in order[:max_labels]:
        fragment = shorten_for_display(label)
        parts.append(f"{fragment} x{counts[label]}" if counts[label] > 1 else fragment)
    remaining = len(order) - max_labels
    if remaining > 0:
        parts.append(f"{remaining} more")
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def _bound_reason(reason: str) -> str:
    """Last-resort guard so a reason can never exceed the schema limit.
    The fragment bounds above make this unreachable for the templates in
    this module; it exists so the pipeline is safe even if a template
    grows. The count sits at the start of every template, so only the
    tail of the label list can ever be cut."""
    return shorten_for_display(reason, _REASON_MAX_LENGTH)


def _size_of(item: DetectedItem) -> str:
    return item.relative_size.strip().lower()


def _validate_selected_items(selected_items: Any) -> None:
    if not isinstance(selected_items, list) or not selected_items:
        raise ValueError("selected_items must be a non-empty list")
    for index, item in enumerate(selected_items):
        if not isinstance(item, DetectedItem):
            raise ValueError(f"selected_items[{index}] must be a DetectedItem, got {type(item).__name__}")
    ids = [item.item_id for item in selected_items]
    if len(ids) != len(set(ids)):
        raise ValueError("selected_items contains a duplicate item_id")


def find_compatible_groups(selected_items: list[DetectedItem]) -> list[tuple[StorageCategoryRule, list[DetectedItem]]]:
    """Every category rule with enough evidence, paired with the matching
    small/medium items in input order. Sorted by evidence count
    (descending) then rule order. Shared with the deterministic checklist
    fallback so "compatible group" means exactly one thing in both
    places. Raises ValueError for malformed input."""
    _validate_selected_items(selected_items)

    groups: list[tuple[int, int, StorageCategoryRule, list[DetectedItem]]] = []
    for rule_index, rule in enumerate(STORAGE_CATEGORY_RULES):
        matched = [
            item
            for item in selected_items
            if _label_words(item.effective_label) & rule.keywords and _size_of(item) in _SMALLER_SIZES
        ]
        if len(matched) < MIN_EVIDENCE_ITEMS:
            continue
        groups.append((-len(matched), rule_index, rule, matched))

    groups.sort(key=lambda entry: (entry[0], entry[1]))
    return [(rule, matched) for _, _, rule, matched in groups]


def derive_storage_suggestions(selected_items: list[DetectedItem]) -> list[StorageSuggestion]:
    """
    Pure and deterministic. Raises ValueError (never AttributeError or
    TypeError) for malformed caller input: an empty or non-list
    selection, a non-DetectedItem entry, or a duplicate item_id.

    Returns between zero and MAX_STORAGE_SUGGESTIONS suggestions.
    """
    suggestions: list[StorageSuggestion] = []
    for rule, matched in find_compatible_groups(selected_items)[:MAX_STORAGE_SUGGESTIONS]:
        reason = _bound_reason(rule.reason_template.format(count=len(matched), labels=format_label_list(matched)))
        suggestions.append(
            StorageSuggestion(name=rule.name, reason=reason, related_item_ids=[item.item_id for item in matched])
        )
    return suggestions
