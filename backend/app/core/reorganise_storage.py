"""
Pure logic: deterministic, evidence-bound generic storage and organisation
ideas for a Reorganise result.

Deliberately modest. Every suggestion is derived only from the selected
DetectedItems (effective_label, relative_size). No model call, no web
search, no retailer API, no database, no persistence, no prices, brands,
links, stock claims, local-availability claims or marketplace integration
of any kind. The output is a generic idea ("Compartment tray") plus one
sentence saying what it would do for the detected items that motivated
it: a mechanism or ongoing home, not a second wording of the checklist's
"group these together".

Rules, and why they are narrow:

  - Each rule is ONE compatible category (technology accessories; desktop
    accessories; toys and games; books and papers; clothing, bags and
    shoes; soft furnishings; framed pictures and other display items;
    jewellery, keys, watches and glasses). Categories are never merged:
    two cups and a charger are not "small loose items" and never become
    one suggestion, because a single container for unrelated things is
    not useful advice. Tableware, bottles and furniture match no rule.
  - A rule fires only when at least MIN_EVIDENCE_ITEMS selected items
    match its keyword set by whole-word label match AND fall within the
    rule's own size set (relative_size is real detector-derived data,
    never inferred here). One matching item is not evidence that storage
    is needed. Sizes are category-specific: a compartment tray is for
    small things only, a hanging organiser or a soft-furnishing basket
    can truthfully take a large coat or blanket, bookends cannot take a
    large item.
  - Sharing a part of the photo is NOT evidence. Nothing here reads
    position, and no rule fires because several arbitrary objects happen
    to sit together.
  - Insufficient evidence means FEWER suggestions, never an invented one.
    Zero is a valid, common result.
  - A detected box, bin or shelf is never treated as an available
    destination: no rule names another selected item as the place to put
    things, and no idea is presented as furniture the room already has.
  - At most MAX_STORAGE_SUGGESTIONS are returned, ordered by evidence
    count (descending) then by fixed rule order, so the output is fully
    deterministic for the same inputs.

Identity discipline: `related_item_ids` carries item_id only. Labels
appear in `reason` as display text and are never used to identify, match
or deduplicate anything.

The deterministic checklist (app.core.reorganise_actions) shares
find_compatible_groups() so "compatible group" means one thing in both
places, but reads it with the defaults: only CHECKLIST_GROUP_RULES (the
categories whose group_noun reads as a sensible "Group <noun>" step) and
only CHECKLIST_GROUP_SIZES (small and medium, the eligibility the
checklist has always had). The storage-only categories (desktop
accessories, soft furnishings, display items) and the per-rule size sets
(a large coat is hanging-organiser evidence) apply to storage ideas only;
neither adds or widens a checklist step.
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
_MAX_REASON_LABELS = 3

_NAME_MAX_LENGTH = 80
_REASON_MAX_LENGTH = 300

# Display fragments are bounded BEFORE a reason is assembled, because a
# corrected_label is an unbounded NonEmptyStr: two long corrected labels
# ending in "book" would otherwise push a reason past _REASON_MAX_LENGTH
# and make StorageSuggestion raise, aborting the whole pipeline before
# image generation. Arithmetic bound on the longest reason: template
# (<110) + at most _MAX_REASON_LABELS fragments of (30 + "all 9999 " +
# " items") + separators + "and the other <group noun (<45)>" < 300.
# _bound_reason() below is a last-resort guard that can only truncate the
# tail of the sentence.
_MAX_LABEL_FRAGMENT_LENGTH = 30
_TRUNCATION_SUFFIX = "..."

# The detector's relative_size vocabulary is small / medium / large.
_SMALL = frozenset({"small"})
_SMALLER_SIZES = frozenset({"small", "medium"})
_ANY_SIZE = frozenset({"small", "medium", "large"})

_SuggestionName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_NAME_MAX_LENGTH)]
_SuggestionReason = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=_REASON_MAX_LENGTH)
]

_WORD_RE = re.compile(r"[a-z]+")


class StorageCategoryRule(BaseModel):
    """One narrow compatible category. `group_noun` is the plain-language
    name of the group used in reasons and in the deterministic checklist
    fallback ("technology accessories"); `sizes` is the set of
    relative_size values an item must have to count as evidence for THIS
    rule; `reason_template` receives {items}, a grounded phrase built
    only from the matched items' labels (see _items_phrase)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    rule_id: str
    keywords: frozenset[str]
    sizes: frozenset[str]
    name: str
    group_noun: str
    reason_template: str


# Keywords are matched as whole lowercase words inside the effective
# label, so "bookshelf" matches nothing here (deliberately: it is
# furniture, not a book) and "keyboard" is not "keys". Each rule's reason
# template receives {items}, which already carries its own article
# ("both toy items", "the keyboard and mouse").
STORAGE_CATEGORY_RULES: tuple[StorageCategoryRule, ...] = (
    StorageCategoryRule(
        rule_id="tech_accessories",
        keywords=frozenset(
            {
                "cable", "cables", "cord", "cords", "charger", "chargers", "adapter", "adapters",
                "headphone", "headphones", "earphone", "earphones", "earbuds", "remote", "remotes",
                "controller", "controllers", "gamepad", "powerbank", "dongle",
            }
        ),
        sizes=_SMALLER_SIZES,
        name="Cable and accessory organiser",
        group_noun="technology accessories",
        reason_template="Keep {items} untangled and in one place between uses.",
    ),
    StorageCategoryRule(
        rule_id="desktop_accessories",
        keywords=frozenset(
            {"keyboard", "keyboards", "mouse", "mice", "trackpad", "stylus", "headset", "webcam", "mousepad"}
        ),
        sizes=_SMALLER_SIZES,
        name="Desktop accessory organiser",
        group_noun="desktop accessories",
        reason_template="Keep {items} together between uses so they are always at hand.",
    ),
    StorageCategoryRule(
        rule_id="toys_and_games",
        keywords=frozenset(
            {
                "toy", "toys", "game", "games", "figurine", "figurines", "doll", "dolls", "puzzle",
                "puzzles", "lego", "plushie", "plushies", "teddy",
            }
        ),
        sizes=_SMALLER_SIZES,
        name="Toy container",
        group_noun="toys and games",
        reason_template="Give {items} one easy place to return to after use.",
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
        sizes=_SMALLER_SIZES,
        name="Bookends or a paper tray",
        group_noun="books and papers",
        reason_template="Stand {items} upright in one spot so they stay visible instead of piling up.",
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
        sizes=_ANY_SIZE,
        name="Hooks or a hanging organiser",
        group_noun="clothing, bags and shoes",
        reason_template="Give {items} a fixed hanging spot so they stay off the floor and furniture.",
    ),
    StorageCategoryRule(
        rule_id="soft_furnishings",
        keywords=frozenset(
            {
                "pillow", "pillows", "cushion", "cushions", "blanket", "blankets", "throw", "throws",
                "duvet", "duvets", "quilt", "quilts", "comforter", "comforters", "bedding",
            }
        ),
        sizes=_ANY_SIZE,
        name="Soft-furnishing basket or storage bag",
        group_noun="soft furnishings",
        reason_template="Keep {items} together in one place when they are not in use.",
    ),
    StorageCategoryRule(
        rule_id="display_items",
        keywords=frozenset(
            {
                "frame", "frames", "painting", "paintings", "poster", "posters", "artwork", "print",
                "prints", "canvas", "photo", "photos", "photograph", "photographs",
            }
        ),
        sizes=_SMALLER_SIZES,
        name="Dedicated display area",
        group_noun="display items",
        reason_template="Use one deliberate display area for {items} instead of scattering them.",
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
        sizes=_SMALL,
        name="Compartment tray",
        group_noun="jewellery, keys, watches and glasses",
        reason_template="Give {items} a fixed compartment each so they stop going missing.",
    ),
)

# The categories the deterministic checklist may turn into a "Group
# <noun>" step, and the only sizes that count as checklist evidence.
# Storage-only categories are deliberately absent and the per-rule size
# sets are deliberately NOT used, so the checklist keeps exactly the shape
# and eligibility it had before storage grew; see the module docstring.
CHECKLIST_GROUP_RULES: tuple[StorageCategoryRule, ...] = tuple(
    rule
    for rule in STORAGE_CATEGORY_RULES
    if rule.rule_id in {"tech_accessories", "toys_and_games", "books_and_papers", "clothing_bags_shoes", "jewellery_keys_glasses"}
)
CHECKLIST_GROUP_SIZES: frozenset[str] = _SMALLER_SIZES


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


def _label_counts(items: list[DetectedItem]) -> tuple[list[str], Counter[str]]:
    """Distinct effective labels in first-seen order, with their counts.
    Counts are taken on the FULL label so a long corrected label can
    never inflate or hide a count."""
    counts: Counter[str] = Counter()
    order: list[str] = []
    for item in items:
        label = item.effective_label.strip()
        if label not in counts:
            order.append(label)
        counts[label] += 1
    return order, counts


def format_label_list(items: list[DetectedItem], max_labels: int = _MAX_LISTED_LABELS) -> str:
    """"cup x2, bottle, toy" in first-seen order, capped at `max_labels`
    distinct labels plus an honest "and N more"."""
    order, counts = _label_counts(items)
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


def _items_phrase(items: list[DetectedItem], group_noun: str) -> str:
    """The grounded noun phrase a reason is built around, with its own
    article. One distinct label: "both toy items" / "all 6 toy items"
    (the real count, stated once, no plural guessed for an arbitrary or
    user-corrected label). Several: "the keyboard and mouse", a repeated
    label rendered as "6 picture frame items", at most
    _MAX_REASON_LABELS named and the rest folded into "the other <group
    noun>" with no second count. Never a parenthesised inventory."""
    order, counts = _label_counts(items)
    if len(order) == 1:
        label = shorten_for_display(order[0])
        count = counts[order[0]]
        return f"both {label} items" if count == 2 else f"all {count} {label} items"
    parts = []
    for label in order[:_MAX_REASON_LABELS]:
        fragment = shorten_for_display(label)
        parts.append(f"{counts[label]} {fragment} items" if counts[label] > 1 else fragment)
    if len(order) > _MAX_REASON_LABELS:
        parts.append(f"the other {group_noun}")
    return "the " + ", ".join(parts[:-1]) + " and " + parts[-1]


def _bound_reason(reason: str) -> str:
    """Last-resort guard so a reason can never exceed the schema limit.
    The fragment bounds above make this unreachable for the templates in
    this module; it exists so the pipeline is safe even if a template
    grows."""
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


def find_compatible_groups(
    selected_items: list[DetectedItem],
    rules: tuple[StorageCategoryRule, ...] = CHECKLIST_GROUP_RULES,
    sizes: frozenset[str] | None = CHECKLIST_GROUP_SIZES,
) -> list[tuple[StorageCategoryRule, list[DetectedItem]]]:
    """Every rule in `rules` with enough evidence, paired with the
    matching items (label keyword match AND an eligible size) in input
    order. Sorted by evidence count (descending) then rule order.

    `sizes` is the eligibility applied to EVERY rule; None means "each
    rule's own size set". The defaults (CHECKLIST_GROUP_RULES,
    CHECKLIST_GROUP_SIZES) are what the deterministic checklist reads, so
    a large coat or bag never becomes a checklist group;
    derive_storage_suggestions passes every storage rule with sizes=None
    so the same coat is hanging-organiser evidence. Raises ValueError for
    malformed input."""
    _validate_selected_items(selected_items)

    groups: list[tuple[int, int, StorageCategoryRule, list[DetectedItem]]] = []
    for rule_index, rule in enumerate(rules):
        eligible = rule.sizes if sizes is None else sizes
        matched = [
            item
            for item in selected_items
            if _label_words(item.effective_label) & rule.keywords and _size_of(item) in eligible
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

    Returns between zero and MAX_STORAGE_SUGGESTIONS suggestions, each a
    generic idea plus one sentence grounded in the matched labels.
    """
    suggestions: list[StorageSuggestion] = []
    for rule, matched in find_compatible_groups(selected_items, STORAGE_CATEGORY_RULES, sizes=None)[:MAX_STORAGE_SUGGESTIONS]:
        reason = _bound_reason(rule.reason_template.format(items=_items_phrase(matched, rule.group_noun)))
        suggestions.append(
            StorageSuggestion(name=rule.name, reason=reason, related_item_ids=[item.item_id for item in matched])
        )
    return suggestions
