"""Pure, deterministic phased tidying advice for reviewed items.

Fixed method-level nouns ("a tray or a small box", "if the desk has
drawers") are advice, not claims that furniture exists in the photo.
Item-specific steps name only selected labels, or confirmed departing
labels in Both, and carry their item_ids. No photo position, detected item
as destination, brand, shop, price or link is introduced. Insufficient
evidence omits a step or whole phase; this module makes zero model calls.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.core.reorganise_storage import STORAGE_CATEGORY_RULES, format_label_list, shorten_for_display
from app.core.schemas import Decision, DetectedItem, ItemId

PhaseId = Literal["empty_clean", "sort", "zones", "cables", "maintain"]
PHASE_ORDER: tuple[PhaseId, ...] = ("empty_clean", "sort", "zones", "cables", "maintain")
PHASE_TITLES = {
    "empty_clean": "Empty and clean",
    "sort": "Sort",
    "zones": "Set up zones",
    "cables": "Cables",
    "maintain": "Keep it tidy",
}

_StepText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=300)]
_WORD_RE = re.compile(r"[a-z]+")
_KEYWORDS = {rule.rule_id: rule.keywords for rule in STORAGE_CATEGORY_RULES}
_DAILY_EXTRA = frozenset({"monitor", "laptop", "computer", "screen", "lamp"})
_DISHES = frozenset({"cup", "cups", "mug", "mugs", "plate", "plates", "bowl", "bowls", "bottle", "bottles", "glass"})
_FURNITURE = frozenset({"shelf", "desk", "table", "chair", "bed", "cabinet", "bookshelf"})
_SURFACES = frozenset({"desk", "table", "shelf", "cabinet", "counter", "dresser"})
_STATIONERY = frozenset({"pen", "pens", "pencil", "stationery", "marker", "scissors"})


class TidyStep(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    step_id: str
    text: _StepText
    item_ids: list[ItemId]

    @model_validator(mode="after")
    def _unique_ids(self) -> "TidyStep":
        if len(self.item_ids) != len(set(self.item_ids)):
            raise ValueError("item_ids contains duplicates")
        return self


class TidyPhase(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    phase_id: PhaseId
    title: str
    steps: list[TidyStep] = Field(min_length=1, max_length=6)

    @model_validator(mode="after")
    def _title_and_ids(self) -> "TidyPhase":
        if self.title != PHASE_TITLES[self.phase_id]:
            raise ValueError("phase title does not match phase_id")
        for index, step in enumerate(self.steps, 1):
            if step.step_id != f"{self.phase_id}-{index}":
                raise ValueError("step_id must follow phase order")
        return self


class TidyPlan(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    phases: list[TidyPhase] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def _ordered_unique_phases(self) -> "TidyPlan":
        order = [PHASE_ORDER.index(phase.phase_id) for phase in self.phases]
        if order != sorted(set(order)):
            raise ValueError("phases must be unique and in PHASE_ORDER")
        ids = [step.step_id for phase in self.phases for step in phase.steps]
        if len(ids) != len(set(ids)):
            raise ValueError("step_id must be unique across the plan")
        return self


def _room_type(scene_label: str) -> str:
    scene = scene_label.strip().lower()
    if scene == "home office desk":
        return "office"
    if scene in {"bedroom", "wardrobe / closet"}:
        return "bedroom"
    if scene in {"kitchen", "dining room"}:
        return "kitchen"
    return "generic"


def _evidence(items: list[DetectedItem], keywords: frozenset[str]) -> list[DetectedItem]:
    return [item for item in items if set(_WORD_RE.findall(item.effective_label.lower())) & keywords]


def _union(items: list[DetectedItem], *groups: list[DetectedItem]) -> list[DetectedItem]:
    ids = {item.item_id for group in groups for item in group}
    return [item for item in items if item.item_id in ids]


def _phrase(items: list[DetectedItem]) -> str:
    return format_label_list(items)


def build_tidy_plan(
    selected_items: list[DetectedItem],
    scene_label: str,
    departing: list[tuple[DetectedItem, Decision]] | None = None,
) -> TidyPlan:
    """Return a phased plan from trusted selections, without inference.

    A departing item is a confirmed, non-excluded Sell/Donate/Discard
    choice, never a Keep item. Labels only render prose; IDs own identity.
    """
    if not isinstance(selected_items, list) or not selected_items or any(not isinstance(x, DetectedItem) for x in selected_items):
        raise ValueError("selected_items must be a non-empty list of DetectedItem")
    if len({x.item_id for x in selected_items}) != len(selected_items):
        raise ValueError("selected_items contains duplicate item_id")
    if not isinstance(scene_label, str) or not scene_label.strip():
        raise ValueError("scene_label must be non-blank")
    if departing is not None and not isinstance(departing, list):
        raise ValueError("departing must be a list or None")
    departing = departing or []
    departed_ids: set[str] = set()
    for pair in departing:
        if not isinstance(pair, tuple) or len(pair) != 2 or not isinstance(pair[0], DetectedItem) or not isinstance(pair[1], Decision):
            raise ValueError("departing entries must be (DetectedItem, Decision) pairs")
        item, decision = pair
        if decision is Decision.KEEP or item.item_id in departed_ids or item.item_id in {x.item_id for x in selected_items}:
            raise ValueError("departing item must be unique, non-Keep and disjoint from selected")
        departed_ids.add(item.item_id)

    room = _room_type(scene_label)
    groups = {
        "cables": _evidence(selected_items, _KEYWORDS["tech_accessories"]),
        "papers": _evidence(selected_items, _KEYWORDS["books_and_papers"]),
        "daily_desk": _evidence(selected_items, _KEYWORDS["desktop_accessories"] | _DAILY_EXTRA),
        "dishes": _evidence(selected_items, _DISHES | (frozenset({"glasses"}) if room == "kitchen" else frozenset())),
        "clothing": _evidence(selected_items, _KEYWORDS["clothing_bags_shoes"]),
        "soft": _evidence(selected_items, _KEYWORDS["soft_furnishings"]),
        "display": _evidence(selected_items, _KEYWORDS["display_items"]),
    }
    groups["tray"] = [
        x for x in selected_items
        if x.relative_size.lower() == "small"
        and set(_WORD_RE.findall(x.effective_label.lower())) & (_KEYWORDS["jewellery_keys_glasses"] | _STATIONERY)
    ]
    surfaces = [
        x for x in selected_items
        if any(surface in x.effective_label.lower() for surface in _SURFACES)
    ]
    soft_ids = {x.item_id for x in groups["soft"]}
    counts = Counter(x.effective_label.strip() for x in selected_items)
    repeated = []
    for label, count in counts.items():
        if count < 2 or set(_WORD_RE.findall(label.lower())) & _FURNITURE:
            continue
        matches = [x for x in selected_items if x.effective_label.strip() == label]
        if any(x.relative_size.lower() == "large" or x.item_id in soft_ids for x in matches):
            continue
        repeated.append((label, matches))

    # A draft is (text, evidence, kind). Repeated and tray drafts are
    # dropped first for the cap, then other evidence-only drafts if a
    # Sort phase still overflows (three evidence steps plus three Both
    # decisions and the fixed step can make seven). Fixed and confirmed
    # departing-decision steps are never dropped.
    drafts: dict[PhaseId, list[tuple[str, list[DetectedItem], str]]] = {phase: [] for phase in PHASE_ORDER}

    def add(phase: PhaseId, text: str, items: list[DetectedItem] | None = None, kind: str | None = None) -> None:
        drafts[phase].append((text, items or [], kind or ("evidence" if items else "template")))

    if room == "office":
        add("empty_clean", "Clear everything off the desk surface.")
        add("empty_clean", "Wipe the desk surface and, if the desk has drawers, empty and wipe those too.")
        if groups["daily_desk"]: add("empty_clean", f"Clean the {_phrase(groups['daily_desk'])}.", groups["daily_desk"])
        add("sort", "Throw away obvious rubbish such as dried-out pens, old notes and wrappers.")
        if groups["papers"]: add("sort", f"File, shred or recycle the {_phrase(groups['papers'])}.", groups["papers"])
        if groups["dishes"]: add("sort", f"Move the {_phrase(groups['dishes'])} out of the workspace.", groups["dishes"])
        if groups["daily_desk"]: add("zones", f"Daily zone: keep the {_phrase(groups['daily_desk'])} within easy arm's reach.", groups["daily_desk"])
        weekly = _union(selected_items, groups["papers"], groups["display"])
        if weekly: add("zones", f"Weekly zone: keep the {_phrase(weekly)} nearby but out of the way, for example in a top drawer or along the desk edge.", weekly)
        storage = _union(selected_items, groups["cables"], groups["soft"])
        if storage: add("zones", f"Storage zone: put the {_phrase(storage)} in a bottom drawer or a closed box.", storage)
        maintain = ("Remove cups, plates and rubbish at the end of every day.", "Spend two minutes resetting the desk before leaving so tomorrow starts clean.")
        cable_end = "Route cables behind the desk or monitor stand so they are out of view."
    elif room == "bedroom":
        add("empty_clean", "Clear the bed, the bedside surfaces and the floor.")
        add("empty_clean", "Wipe the surfaces and, if there are drawers, empty and wipe those too.")
        add("sort", "Throw away obvious rubbish and anything broken.")
        if groups["clothing"]: add("sort", f"Put the {_phrase(groups['clothing'])} away or into the laundry.", groups["clothing"])
        if groups["papers"]: add("sort", f"File or recycle the {_phrase(groups['papers'])}.", groups["papers"])
        if groups["dishes"]: add("sort", f"Take the {_phrase(groups['dishes'])} out of the room.", groups["dishes"])
        if groups["soft"]: add("zones", f"Daily zone: keep the {_phrase(groups['soft'])} on or beside the bed.", groups["soft"])
        if groups["clothing"]: add("zones", f"Weekly zone: hang or fold the {_phrase(groups['clothing'])} and keep what you wear most at the front.", groups["clothing"])
        storage = _union(selected_items, groups["display"], groups["cables"])
        if storage: add("zones", f"Storage zone: put the {_phrase(storage)} in a closed box, a drawer or on a high shelf.", storage)
        maintain = ("Make the bed and clear the bedside surfaces each morning.", "Spend two minutes putting things back in their zone before bed.")
        cable_end = "Route cables behind the bedside table or desk so they are out of view."
    elif room == "kitchen":
        add("empty_clean", "Clear the counters and the table.")
        add("empty_clean", "Wipe the counters, the table and the front of the cupboards.")
        add("sort", "Throw away rubbish and anything past its best.")
        if groups["dishes"]: add("sort", f"Wash or put away the {_phrase(groups['dishes'])}.", groups["dishes"])
        if groups["papers"]: add("sort", f"Move the {_phrase(groups['papers'])} out of the kitchen.", groups["papers"])
        if groups["dishes"]: add("zones", f"Daily zone: keep the {_phrase(groups['dishes'])} you use every day within reach of the sink.", groups["dishes"])
        weekly = _union(selected_items, groups["papers"], groups["display"])
        if weekly: add("zones", f"Weekly zone: keep the {_phrase(weekly)} together on one shelf or in one drawer.", weekly)
        storage = _union(selected_items, groups["cables"], groups["soft"])
        if storage: add("zones", f"Storage zone: put the {_phrase(storage)} in a cupboard or a closed box.", storage)
        maintain = ("Wash up and clear the counters after every meal.", "Spend two minutes resetting the kitchen before bed.")
        cable_end = "Route cables behind the appliances so they are out of view."
    else:
        add("empty_clean", "Clear the main surfaces in the space.")
        add("empty_clean", "Wipe them down before putting anything back.")
        add("sort", "Throw away obvious rubbish and anything broken.")
        if groups["papers"]: add("sort", f"File or recycle the {_phrase(groups['papers'])}.", groups["papers"])
        if groups["dishes"]: add("sort", f"Take the {_phrase(groups['dishes'])} to the kitchen.", groups["dishes"])
        if groups["clothing"]: add("sort", f"Put the {_phrase(groups['clothing'])} away.", groups["clothing"])
        daily = _union(selected_items, groups["daily_desk"], groups["dishes"], groups["soft"])
        if daily: add("zones", f"Daily zone: keep the {_phrase(daily)} where you use them.", daily)
        weekly = _union(selected_items, groups["papers"], groups["display"], groups["clothing"])
        if weekly: add("zones", f"Weekly zone: keep the {_phrase(weekly)} together in one place.", weekly)
        if groups["cables"]: add("zones", f"Storage zone: put the {_phrase(groups['cables'])} in a closed box or drawer.", groups["cables"])
        maintain = ("Return items to their zone at the end of each day.", "Spend two minutes resetting the space before leaving it.")
        cable_end = "Route cables behind furniture so they are out of view."

    if surfaces:
        drafts["empty_clean"].insert(
            0, (f"Clear these surfaces first: {_phrase(surfaces)}. They are where loose items collect.", surfaces, "evidence")
        )

    for decision, prefix in ((Decision.SELL, "Set aside to sell"), (Decision.DONATE, "Set aside to donate"), (Decision.DISCARD, "Throw out or recycle")):
        items = [item for item, value in departing if value is decision]
        if items: add("sort", f"{prefix}: {_phrase(items)}.", items, "departing")

    for label, items in repeated[:3]:
        add("zones", f"You have {len(items)} {shorten_for_display(label)} items. Decide which one you use daily and store the rest.", items, "repeated")
    if len(groups["tray"]) >= 2:
        add("zones", f"Use a tray or a small box for the {_phrase(groups['tray'])}.", groups["tray"], "tray")

    if groups["cables"]:
        add("cables", f"Untangle the {_phrase(groups['cables'])}.", groups["cables"])
        add("cables", "Bundle loose cables with a strap, tie or clip.", groups["cables"])
        add("cables", cable_end, groups["cables"])
    for text in maintain:
        add("maintain", text)

    phases: list[TidyPhase] = []
    for phase_id in PHASE_ORDER:
        entries = drafts[phase_id]
        while len(entries) > 6:
            removable = next((i for i in range(len(entries) - 1, -1, -1) if entries[i][2] == "repeated"), None)
            if removable is None:
                removable = next((i for i in range(len(entries) - 1, -1, -1) if entries[i][2] == "tray"), None)
            if removable is None:
                removable = next((i for i in range(len(entries) - 1, -1, -1) if entries[i][2] == "evidence"), None)
            if removable is None:
                raise ValueError("non-optional template steps exceed phase cap")
            entries.pop(removable)
        if entries:
            phases.append(TidyPhase(phase_id=phase_id, title=PHASE_TITLES[phase_id], steps=[
                TidyStep(step_id=f"{phase_id}-{i}", text=text, item_ids=[item.item_id for item in items])
                for i, (text, items, _) in enumerate(entries, 1)
            ]))
    return TidyPlan(phases=phases)
